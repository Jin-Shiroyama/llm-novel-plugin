import { join } from "node:path"
import {
  safeReadFile,
  safeReadJson,
  safeWriteFile,
  backupPreviousDraft,
  getChaptersDir,
  getConfigPath,
  countWords,
  stripChapterHeading,
  normalizeChapterTitle,
  existsSync,
  chapterFileName,
  isShortForm,
  indentStyleOf,
  seriousnessOf,
  truncateChars,
} from "../core/utils.js"
import type { NovelConfig } from "../core/utils.js"
import {
  sectionFromArgs,
  sectionFileName,
  sectionLabel,
  sectionCallArgs,
  listManuscriptFiles,
  compareSections,
  SECTION_NAMES,
} from "../core/sections.js"
import type { ManuscriptSection, SectionKind } from "../core/sections.js"
import { summarizeForSave, summarizeProseForSave } from "./check.js"
import { readGlossaryCheck } from "../core/glossary.js"
import { fixTypography, formatFixSummary, formatFixChanges } from "../core/typography.js"
import { findCrossChapterRepeats, CROSS_CHAPTER_WINDOW } from "../core/prose.js"
import { DEFAULTS, CHAPTER_WORD_TOLERANCE, DEFAULT_AUTO_FIX } from "../core/constants.js"
import type { ToolRuntimeContext } from "./types.js"

/** 自動整形が未収束で保存を止めたときの詳細メッセージ（該当行の抜粋と次の手順） */
export function formatUnconvergedSaveError(
  label: string,
  section: ManuscriptSection,
  rawBody: string,
  unconvergedLines: number[],
): string {
  const rawLines = rawBody.split(/\r?\n/)
  const shown = unconvergedLines.slice(0, 5)
  const excerpts = shown
    .map((lineNo) => {
      const lineText = (rawLines[lineNo - 1] ?? "").replace(/　/g, "□")
      const [clipped, truncated] = truncateChars(lineText, 60)
      return `  - ${lineNo}行目: ${clipped}${truncated ? "…" : ""}`
    })
    .join("\n")
  const more =
    unconvergedLines.length > shown.length
      ? `\n  …ほか${unconvergedLines.length - shown.length}行`
      : ""
  const callArgs = sectionCallArgs(section)
  return (
    `❌ ${label}は保存していません。自動整形が収束しませんでした（本文 ${unconvergedLines.join("、")}行。□ は全角スペース）。\n` +
    `${excerpts}${more}\n` +
    `💡 次の手順:\n` +
    `  1. 該当行のルビ・傍点・URL・約物（括弧や三点リーダ等）を手動で整えてから保存し直す\n` +
    `  2. いったん保存して箇所を詳しく見たい場合は novel_save_chapter(${callArgs}, autoFix: false, ...) で保存し、novel_check(${callArgs}) で確認する`
  )
}

export interface SaveChapterArgs {
  section?: SectionKind
  chapterNumber?: number
  interludeIndex?: number
  title: string
  content: string
  updateState?: boolean
  /** 機械的に直せる表記を保存時に自動整形するかどうか。既定 DEFAULT_AUTO_FIX（true） */
  autoFix?: boolean
}

export async function novelSaveChapterExecute(
  args: SaveChapterArgs,
  ctx: ToolRuntimeContext,
): Promise<string> {
  const dir = ctx.projectDir
  const resolved = sectionFromArgs(args)
  if ("error" in resolved) return `❌ 保存していません。${resolved.error}。`
  const section = resolved.section
  const config = await safeReadJson<NovelConfig>(getConfigPath(dir))
  const unit = config?.chapterUnit ?? DEFAULTS.chapterUnit
  const indent = indentStyleOf(config)
  const singleBody =
    isShortForm(config) && (config?.chapterCount ?? 1) === 1 && section.kind === "chapter" && section.chapter === 1
  const label = singleBody
    ? "本文"
    : section.kind === "chapter"
      ? `第${section.chapter}${unit}`
      : sectionLabel(section, unit)
  const fileName = sectionFileName(section)
  const chaptersDir = getChaptersDir(dir)
  const filePath = join(chaptersDir, fileName)

  const rawBody = stripChapterHeading(args.content)
  const autoFix = args.autoFix ?? DEFAULT_AUTO_FIX
  const fixResult = autoFix ? fixTypography(rawBody, { indent }) : null
  if (fixResult?.unconvergedLines.length) {
    return formatUnconvergedSaveError(label, section, rawBody, fixResult.unconvergedLines)
  }
  const body = fixResult ? fixResult.text : rawBody
  const title = normalizeChapterTitle(args.title)

  // 保存ファイル内部の見出しは算用数字の「第N章」で統一（書き出し時に chapterUnit で「第N話」等へ変換）
  const name = section.kind === "chapter" ? `第${section.chapter}章` : SECTION_NAMES[section.kind]
  const header = title.length > 0 ? `# ${name} ${title}\n\n` : `# ${name}\n\n`
  const saved = header + body

  let previousNote = ""
  let sameAsPrevious = false
  if (existsSync(filePath)) {
    const previous = await safeReadFile(filePath)
    if (previous === null) {
      return `❌ ${label}は保存していません。いまの ${fileName} を読み込めず、前の原稿を残せないためです。
   ファイルの権限や中身（ディレクトリになっていないか）を確かめてください。`
    }
    if (previous === saved) {
      sameAsPrevious = true
      previousNote = `ℹ️ 前に保存した内容と同じでした\n`
    } else {
      const backupPath = await backupPreviousDraft(dir, fileName, previous)
      previousNote = `🗂️ 前の原稿を残しました: ${backupPath}\n`
    }
  }
  let rawBackupPath: string | null = null
  if (fixResult && fixResult.totalFixes > 0 && body !== rawBody && !sameAsPrevious) {
    rawBackupPath = await backupPreviousDraft(
      dir,
      `${fileName.replace(/\.md$/, "")}-before-fix.md`,
      header + rawBody,
    )
  }
  if (!sameAsPrevious) await safeWriteFile(filePath, saved)

  const wordCount = countWords(body)

  let report = title.length > 0
    ? `✅ ${label}「${title}」を保存しました\n`
    : `✅ ${label}を保存しました\n`
  if (title !== args.title.trim()) {
    report += `ℹ️ タイトルに改行などが含まれていたため、1行に直しました\n`
  }
  report += `📄 ファイル: ${filePath}\n`
  report += previousNote
  if (section.kind === "interlude" && !existsSync(join(chaptersDir, chapterFileName(section.chapter)))) {
    report += `⚠️ 第${section.chapter}${unit}の本文はまだありません（この幕間は第${section.chapter}${unit}のあとに置かれます）\n`
  }
  report += formatWordCountLine(wordCount, section, unit, config)
  if (fixResult && fixResult.totalFixes > 0) {
    report += `✨ 表記を自動整形しました（${fixResult.totalFixes}件: ${formatFixSummary(fixResult.fixes)}）\n`
    report += formatFixChanges(fixResult.changes)
    if (rawBackupPath) {
      report += `  🗂️ 整形前の本文を残しました: ${rawBackupPath}\n`
    }
  }
  report += summarizeForSave(saved, section, undefined, indent, await readGlossaryCheck(dir))
  const priorFiles = (await listManuscriptFiles(dir))
    .filter((f) => compareSections(f.section, section) < 0)
    .slice(-(CROSS_CHAPTER_WINDOW - 1))
  const windowChapters: Array<{ label: string; text: string }> = []
  for (const f of priorFiles) {
    const content = await safeReadFile(f.path)
    if (content !== null) windowChapters.push({ label: sectionLabel(f.section, unit), text: content })
  }
  windowChapters.push({ label: sectionLabel(section, unit), text: saved })
  const crossRepeats = findCrossChapterRepeats(windowChapters, { targetIndex: windowChapters.length - 1 })
  report += summarizeProseForSave(saved, section, { seriousness: seriousnessOf(config) }, crossRepeats)

  if (args.updateState !== false) {
    report += `\n💡 novel_update で次の記録を更新しておくと、後の話でつじつまが合わせやすくなります:\n`
    report += `  - character-state: 登場人物の状態・関係・ことばづかいの変化\n`
    report += `  - summary: この話のあらすじ\n`
    report += `  - foreshadow: 伏線の進み具合\n`
  }

  return report
}

function formatWordCountLine(
  wordCount: number,
  section: { kind: SectionKind },
  unit: string,
  config: NovelConfig | null,
): string {
  const formatted = wordCount.toLocaleString("ja-JP")
  if (!config) return `📊 文字数: ${formatted}文字\n`
  const targetWords = config.targetWords ?? DEFAULTS.targetWords
  const chapterCount = Math.max(1, config.chapterCount ?? DEFAULTS.chapterCount)
  if (!(Number.isFinite(targetWords) && targetWords > 0)) {
    return `📊 文字数: ${formatted}文字\n`
  }
  const perChapter = Math.round(targetWords / chapterCount)
  if (section.kind !== "chapter") {
    return `📊 文字数: ${formatted}文字（プロットに従う。1${unit}の目安は ${perChapter.toLocaleString("ja-JP")}文字）\n`
  }
  const tolerancePct = Math.round(CHAPTER_WORD_TOLERANCE * 100)
  const min = Math.round(perChapter * (1 - CHAPTER_WORD_TOLERANCE))
  const max = Math.round(perChapter * (1 + CHAPTER_WORD_TOLERANCE))
  const range = `${min.toLocaleString("ja-JP")}〜${max.toLocaleString("ja-JP")}文字`
  const status =
    wordCount < min
      ? `⚠️ 目安より${(min - wordCount).toLocaleString("ja-JP")}文字少なめ（水増しせず、直すなら展開ビートや掛け合いの厚みで調整）`
      : wordCount > max
        ? `⚠️ 目安より${(wordCount - max).toLocaleString("ja-JP")}文字多め（見どころやごほうびは削らず、説明の重複や場面配分で調整）`
        : "目安の範囲内"
  return `📊 文字数: ${formatted}文字（目安 ${perChapter.toLocaleString("ja-JP")}文字 ±${tolerancePct}%［${range}］: ${status}）\n`
}
