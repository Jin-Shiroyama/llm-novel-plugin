import {
  safeReadFile,
  safeReadJson,
  safeWriteFile,
  backupPreviousDraft,
  getConfigPath,
  indentStyleOf,
  seriousnessOf,
} from "../core/utils.js"
import type { NovelConfig } from "../core/utils.js"
import {
  checkTypography,
  fixTypography,
  formatFixSummary,
  formatFixChanges,
  countByRule,
  formatIssue,
  TYPOGRAPHY_RULE_LABELS,
} from "../core/typography.js"
import type { TypographyIssue, TypographyRule, TypographyFixChange, GlossaryCheck } from "../core/typography.js"
import { formatChapterRanges } from "../core/records.js"
import {
  listManuscriptFiles,
  describeExtraSections,
  sectionFromArgs,
  sectionLabel,
  sectionFileName,
  sameSection,
  compareSections,
  sectionCallArgs,
} from "../core/sections.js"
import type { ManuscriptSection, SectionKind } from "../core/sections.js"
import { readGlossaryCheck } from "../core/glossary.js"
import {
  checkProse,
  summarizeProse,
  formatProseIssue,
  PROSE_RULE_LABELS,
  findCrossChapterRepeats,
  formatCrossChapterRepeat,
  CROSS_CHAPTER_WINDOW,
} from "../core/prose.js"
import type { ProseIssue, CheckProseOptions, CrossChapterRepeat } from "../core/prose.js"
import { DEFAULTS } from "../core/constants.js"
import type { IndentStyle, ChapterUnit } from "../core/constants.js"
import type { ToolRuntimeContext } from "./types.js"

export interface CheckArgs {
  section?: SectionKind
  chapterNumber?: number
  interludeIndex?: number
  maxIssues?: number
  /** true のとき、機械的に安全に直せる表記を自動修正して上書き保存する（旧稿は .novel/drafts/ に退避） */
  fix?: boolean
}

export const DEFAULT_MAX_ISSUES = 30

export async function novelCheckExecute(args: CheckArgs, ctx: ToolRuntimeContext): Promise<string> {
  const dir = ctx.projectDir
  const max = args.maxIssues ?? DEFAULT_MAX_ISSUES
  const applyFix = args.fix === true
  let target: ManuscriptSection | null = null
  if (args.section !== undefined || args.chapterNumber !== undefined || args.interludeIndex !== undefined) {
    const resolved = sectionFromArgs(args)
    if ("error" in resolved) return `❌ ${resolved.error}。`
    target = resolved.section
  }
  const config = await safeReadJson<NovelConfig>(getConfigPath(dir))
  const unit = config?.chapterUnit ?? DEFAULTS.chapterUnit
  const allFiles = await listManuscriptFiles(dir)
  const files = allFiles.filter(
    (f) => target === null || sameSection(f.section, target),
  )
  if (files.length === 0) {
    return target === null
      ? `❌ 本文がまだありません（.novel/chapters/chapter-NNN.md）。`
      : `❌ ${sectionLabel(target, unit)}の本文が見つかりません（.novel/chapters/${sectionFileName(target)}）。`
  }

  const indent = indentStyleOf(config)
  const proseOpts: CheckProseOptions = { seriousness: seriousnessOf(config) }
  const glossary = await readGlossaryCheck(dir)
  const results: Array<{ section: ManuscriptSection; text: string; issues: TypographyIssue[]; prose: ProseIssue[] }> = []
  const unreadable: ManuscriptSection[] = []
  const fixedCounts = new Map<TypographyRule, number>()
  const fixedChanges: TypographyFixChange[] = []
  let fixedFiles = 0
  const unconverged: string[] = []

  for (const f of files) {
    const raw = await safeReadFile(f.path)
    if (raw === null) {
      unreadable.push(f.section)
      continue
    }
    let text = raw
    if (applyFix) {
      const fixed = fixTypography(raw, { indent })
      if (fixed.unconvergedLines.length) unconverged.push(`${sectionLabel(f.section, unit)}（${fixed.unconvergedLines.join("、")}行）`)
      if (fixed.unconvergedLines.length === 0 && fixed.totalFixes > 0 && fixed.text !== raw) {
        await backupPreviousDraft(dir, sectionFileName(f.section), raw)
        await safeWriteFile(f.path, fixed.text)
        text = fixed.text
        fixedFiles++
        for (const item of fixed.fixes) {
          fixedCounts.set(item.rule, (fixedCounts.get(item.rule) ?? 0) + item.count)
        }
        fixedChanges.push(...fixed.changes)
      }
    }
    results.push({
      section: f.section,
      text,
      issues: checkTypography(text, { indent, glossary }),
      prose: checkProse(text, proseOpts),
    })
  }

  const unreadableNote = unreadable.length > 0
    ? `⚠️ 読み込めず点検できなかった${unit}: ${formatSections(unreadable, unit)}（ファイルの権限や中身を確かめてください）\n`
    : ""
  if (results.length === 0) {
    return `❌ 点検できる本文がありません。\n${unreadableNote}`
  }

  let crossRepeats: CrossChapterRepeat[] = []
  if (target !== null && results.length === 1) {
    const priorFiles = allFiles
      .filter((f) => compareSections(f.section, target) < 0)
      .slice(-(CROSS_CHAPTER_WINDOW - 1))
    const windowChapters: Array<{ label: string; text: string }> = []
    for (const f of priorFiles) {
      const content = await safeReadFile(f.path)
      if (content !== null) windowChapters.push({ label: sectionLabel(f.section, unit), text: content })
    }
    windowChapters.push({ label: sectionLabel(results[0].section, unit), text: results[0].text })
    crossRepeats = findCrossChapterRepeats(windowChapters, { targetIndex: windowChapters.length - 1 })
  } else if (target === null && results.length > 1) {
    crossRepeats = findCrossChapterRepeats(
      results.map((r) => ({ label: sectionLabel(r.section, unit), text: r.text })),
    )
  }

  const totalFixed = [...fixedCounts.values()].reduce((a, b) => a + b, 0)
  const fixedList = [...fixedCounts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count)
  const failureNote = unconverged.length
    ? `❌ 自動整形が収束せず、上書きしていない本文: ${unconverged.join("、")}。元の本文を点検しています（下の点検結果をもとに該当行を手動で整えてください）。\n`
    : ""
  const fixNote = failureNote + (!applyFix
    ? ""
    : totalFixed > 0
      ? `✨ 表記を自動修正しました（${totalFixed}件／${fixedFiles}ファイル: ${formatFixSummary(fixedList)}。旧稿は .novel/drafts/ に残しました）\n${formatFixChanges(fixedChanges)}`
      : unconverged.length ? "" : `ℹ️ 自動修正できる表記箇所はありませんでした\n`)

  const all = results.flatMap((r) => r.issues)
  const scope = target === null ? describeScope(results.map((r) => r.section), unit) : sectionLabel(target, unit)
  const proseReport = formatProseReport(results, crossRepeats, scope, max, unit)
  if (all.length === 0) {
    const head = unreadable.length > 0
      ? `${fixNote}⚠️ 表記の点検（${scope}）: 点検できた本文には、規約から外れた箇所はありません。\n${unreadableNote}`
      : `${fixNote}✅ 表記の点検（${scope}）: 規約から外れた箇所はありません。`
    return proseReport ? `${head.replace(/\n$/, "")}\n\n${proseReport}` : head
  }

  const errors = all.filter((i) => i.severity === "error").length
  let report = `${fixNote}📝 表記の点検（${scope}）: ❌ 規約違反 ${errors}件 / ⚠️ 確認 ${all.length - errors}件\n`
  report += unreadableNote
  report += `（規約の正本は novel-writing skill。用語の表記は .novel/glossary.md。行と字の位置はファイルのもの。□ は全角スペース）\n\n`

  report += `## 規則ごとの件数\n`
  for (const { rule, severity, count } of countByRule(all)) {
    report += `- ${severity === "error" ? "❌" : "⚠️"} ${TYPOGRAPHY_RULE_LABELS[rule]}: ${count}件\n`
  }

  for (const { section, issues } of results) {
    if (issues.length === 0) continue
    report += `\n## ${sectionLabel(section, unit)}（${issues.length}件）\n`
    for (const issue of issues.slice(0, max)) report += `${formatIssue(issue)}\n`
    if (issues.length > max) {
      report += `…ほか${issues.length - max}件（maxIssues を上げるか、${unit}を指定して見てください）\n`
    }
  }
  return proseReport ? `${report}\n${proseReport}` : report
}

function formatProseReport(
  results: Array<{ section: ManuscriptSection; prose: ProseIssue[] }>,
  crossRepeats: CrossChapterRepeat[],
  scope: string,
  max: number,
  unit: ChapterUnit,
): string {
  const all = results.flatMap((r) => r.prose)
  const totalCount = all.length + crossRepeats.length
  if (totalCount === 0) return ""
  let report = `✍️ 文章の点検（${scope}）: ⚠️ 確認 ${totalCount}件\n`
  report += `（novel-writing skill の反AI・教訓まとめ・話末の定型締め・話またぎ重複チェック。地の文だけを見ます。文体見本やトーンに合う表現は残してかまいません。\n`
  report += ` ⚠️ 0件を目的に機械的な言い換えをせず、直す箇所だけキャラの反応・動作・語り手の声で書き直します）\n\n`
  report += `## 種類ごとの件数\n`
  for (const { rule, count, detail } of summarizeProse(all)) {
    report += `- ⚠️ ${PROSE_RULE_LABELS[rule]}: ${count}件${detail ? `（${detail}）` : ""}\n`
  }
  if (crossRepeats.length > 0) {
    report += `- ⚠️ 話をまたいだ繰り返し: ${crossRepeats.length}件（${crossRepeats.map((r) => r.motif).join("、")}）\n`
  }
  for (const { section, prose } of results) {
    if (prose.length === 0) continue
    report += `\n## ${sectionLabel(section, unit)}（${prose.length}件）\n`
    for (const issue of prose.slice(0, max)) report += `${formatProseIssue(issue)}\n`
    if (prose.length > max) {
      report += `…ほか${prose.length - max}件（maxIssues を上げるか、${unit}を指定して見てください）\n`
    }
  }
  if (crossRepeats.length > 0) {
    report += `\n## 話をまたいだ繰り返し（${crossRepeats.length}件）\n`
    for (const repeat of crossRepeats.slice(0, max)) report += `${formatCrossChapterRepeat(repeat)}\n`
  }
  return report
}

export function summarizeProseForSave(
  text: string,
  section: ManuscriptSection,
  opts?: CheckProseOptions,
  crossRepeats: CrossChapterRepeat[] = [],
): string {
  const issues = checkProse(text, opts)
  const total = issues.length + crossRepeats.length
  if (total === 0) return ""
  const counts = [
    ...summarizeProse(issues).map(
      ({ rule, count, detail }) => `${PROSE_RULE_LABELS[rule]} ${count}${detail ? `：${detail}` : ""}`,
    ),
    ...(crossRepeats.length > 0
      ? [`話をまたいだ繰り返し ${crossRepeats.length}：${crossRepeats.map((r) => r.motif).join("、")}`]
      : []),
  ].join("／")
  return `✍️ 文章: ⚠️ 確認 ${total}件（${counts}）\n  → novel_check(${sectionCallArgs(section)}) で箇所を見られます。文体見本やトーンに合う表現は残してよく、AI定型・教訓まとめ・話末の定型締めを優先して書き直します（⚠️ 0件を目的にしない）\n`
}

export function summarizeForSave(
  text: string,
  section: ManuscriptSection,
  shown = 3,
  indent?: IndentStyle,
  glossary?: GlossaryCheck,
): string {
  const issues = checkTypography(text, { indent, glossary })
  if (issues.length === 0) return `📝 表記: 規約から外れた箇所はありません\n`
  const errors = issues.filter((i) => i.severity === "error").length
  const counts = countByRule(issues)
    .map(({ rule, count }) => `${TYPOGRAPHY_RULE_LABELS[rule]} ${count}`)
    .join("、")
  let out = `📝 表記: ❌ 規約違反 ${errors}件 / ⚠️ 確認 ${issues.length - errors}件（${counts}）\n`
  for (const issue of issues.slice(0, shown)) out += `  ${formatIssue(issue).replace(/\n/g, "\n  ")}\n`
  out += `  → novel_check(${sectionCallArgs(section)}) で全件を見て、直してから保存し直してください\n`
  return out
}

function formatSections(sections: ManuscriptSection[], unit: ChapterUnit): string {
  const chapters = sections.flatMap((s) => (s.kind === "chapter" ? [s.chapter] : []))
  const others = sections.filter((s) => s.kind !== "chapter").map((s) => sectionLabel(s, unit))
  return [...(chapters.length > 0 ? [formatChapterRanges(chapters, unit)] : []), ...others].join("、")
}

function describeScope(sections: ManuscriptSection[], unit: ChapterUnit): string {
  const chapters = sections.filter((s) => s.kind === "chapter").length
  const extras = describeExtraSections(sections)
  if (!extras) return `${chapters}${unit}`
  return chapters > 0 ? `${chapters}${unit}と${extras}` : extras
}
