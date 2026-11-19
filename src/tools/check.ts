import {
  safeReadFile,
  safeReadJson,
  safeWriteFile,
  backupPreviousDraft,
  getConfigPath,
  indentStyleOf,
} from "../core/utils.js"
import type { NovelConfig } from "../core/utils.js"
import {
  checkTypography,
  fixTypography,
  formatFixSummary,
  countByRule,
  formatIssue,
  TYPOGRAPHY_RULE_LABELS,
} from "../core/typography.js"
import type { TypographyIssue, TypographyRule, GlossaryCheck } from "../core/typography.js"
import { formatChapterRanges } from "../core/records.js"
import {
  listManuscriptFiles,
  describeExtraSections,
  sectionFromArgs,
  sectionLabel,
  sectionFileName,
  sameSection,
  sectionCallArgs,
} from "../core/sections.js"
import type { ManuscriptSection, SectionKind } from "../core/sections.js"
import { readGlossaryCheck } from "../core/glossary.js"
import { checkProse, summarizeProse, formatProseIssue, PROSE_RULE_LABELS } from "../core/prose.js"
import type { ProseIssue } from "../core/prose.js"
import type { IndentStyle } from "../core/constants.js"
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
  const files = (await listManuscriptFiles(dir)).filter(
    (f) => target === null || sameSection(f.section, target),
  )
  if (files.length === 0) {
    return target === null
      ? `❌ 本文がまだありません（.novel/chapters/chapter-NNN.md）。`
      : `❌ ${sectionLabel(target)}の本文が見つかりません（.novel/chapters/${sectionFileName(target)}）。`
  }

  const config = await safeReadJson<NovelConfig>(getConfigPath(dir))
  const indent = indentStyleOf(config)
  const glossary = await readGlossaryCheck(dir)
  const results: Array<{ section: ManuscriptSection; issues: TypographyIssue[]; prose: ProseIssue[] }> = []
  const unreadable: ManuscriptSection[] = []
  const fixedCounts = new Map<TypographyRule, number>()
  let fixedFiles = 0

  for (const f of files) {
    const raw = await safeReadFile(f.path)
    if (raw === null) {
      unreadable.push(f.section)
      continue
    }
    let text = raw
    if (applyFix) {
      const fixed = fixTypography(raw, { indent })
      if (fixed.totalFixes > 0 && fixed.text !== raw) {
        await backupPreviousDraft(dir, sectionFileName(f.section), raw)
        await safeWriteFile(f.path, fixed.text)
        text = fixed.text
        fixedFiles++
        for (const item of fixed.fixes) {
          fixedCounts.set(item.rule, (fixedCounts.get(item.rule) ?? 0) + item.count)
        }
      }
    }
    results.push({ section: f.section, issues: checkTypography(text, { indent, glossary }), prose: checkProse(text) })
  }

  const unreadableNote = unreadable.length > 0
    ? `⚠️ 読み込めず点検できなかった話: ${formatSections(unreadable)}（ファイルの権限や中身を確かめてください）\n`
    : ""
  if (results.length === 0) {
    return `❌ 点検できる本文がありません。\n${unreadableNote}`
  }

  const totalFixed = [...fixedCounts.values()].reduce((a, b) => a + b, 0)
  const fixedList = [...fixedCounts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count)
  const fixNote = !applyFix
    ? ""
    : totalFixed > 0
      ? `✨ 表記を自動修正しました（${totalFixed}件／${fixedFiles}ファイル: ${formatFixSummary(fixedList)}。旧稿は .novel/drafts/ に残しました）\n`
      : `ℹ️ 自動修正できる表記箇所はありませんでした\n`

  const all = results.flatMap((r) => r.issues)
  const scope = target === null ? describeScope(results.map((r) => r.section)) : sectionLabel(target)
  const proseReport = formatProseReport(results, scope, max)
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
    report += `\n## ${sectionLabel(section)}（${issues.length}件）\n`
    for (const issue of issues.slice(0, max)) report += `${formatIssue(issue)}\n`
    if (issues.length > max) {
      report += `…ほか${issues.length - max}件（maxIssues を上げるか、話を指定して見てください）\n`
    }
  }
  return proseReport ? `${report}\n${proseReport}` : report
}

function formatProseReport(
  results: Array<{ section: ManuscriptSection; prose: ProseIssue[] }>,
  scope: string,
  max: number,
): string {
  const all = results.flatMap((r) => r.prose)
  if (all.length === 0) return ""
  let report = `✍️ 文章の点検（${scope}）: ⚠️ 確認 ${all.length}件\n`
  report += `（novel-writing skill の反AI・教訓まとめチェック。地の文だけを見ます。意図したものは残してかまいません。\n`
  report += ` 直すときは語の言い換えではなく、キャラの反応・動作・語り手の声で書き直します）\n\n`
  report += `## 種類ごとの件数\n`
  for (const { rule, count, detail } of summarizeProse(all)) {
    report += `- ⚠️ ${PROSE_RULE_LABELS[rule]}: ${count}件${detail ? `（${detail}）` : ""}\n`
  }
  for (const { section, prose } of results) {
    if (prose.length === 0) continue
    report += `\n## ${sectionLabel(section)}（${prose.length}件）\n`
    for (const issue of prose.slice(0, max)) report += `${formatProseIssue(issue)}\n`
    if (prose.length > max) {
      report += `…ほか${prose.length - max}件（maxIssues を上げるか、話を指定して見てください）\n`
    }
  }
  return report
}

export function summarizeProseForSave(text: string, section: ManuscriptSection): string {
  const issues = checkProse(text)
  if (issues.length === 0) return ""
  const counts = summarizeProse(issues)
    .map(({ rule, count, detail }) => `${PROSE_RULE_LABELS[rule]} ${count}${detail ? `：${detail}` : ""}`)
    .join("／")
  return `✍️ 文章: ⚠️ 確認 ${issues.length}件（${counts}）\n  → novel_check(${sectionCallArgs(section)}) で箇所を見られます。語の言い換えではなく、キャラの反応・動作・語り手の声で書き直します（意図したものは残してよい）\n`
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

function formatSections(sections: ManuscriptSection[]): string {
  const chapters = sections.flatMap((s) => (s.kind === "chapter" ? [s.chapter] : []))
  const others = sections.filter((s) => s.kind !== "chapter").map(sectionLabel)
  return [...(chapters.length > 0 ? [formatChapterRanges(chapters)] : []), ...others].join("、")
}

function describeScope(sections: ManuscriptSection[]): string {
  const chapters = sections.filter((s) => s.kind === "chapter").length
  const extras = describeExtraSections(sections)
  if (!extras) return `${chapters}話`
  return chapters > 0 ? `${chapters}話と${extras}` : extras
}
