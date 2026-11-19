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
} from "../core/utils.js"
import type { NovelConfig } from "../core/utils.js"
import { sectionFromArgs, sectionFileName, sectionLabel, SECTION_NAMES } from "../core/sections.js"
import type { SectionKind } from "../core/sections.js"
import { summarizeForSave, summarizeProseForSave } from "./check.js"
import { readGlossaryCheck } from "../core/glossary.js"
import { fixTypography, formatFixSummary } from "../core/typography.js"
import { DEFAULTS, CHAPTER_WORD_TOLERANCE } from "../core/constants.js"
import type { ToolRuntimeContext } from "./types.js"

export interface SaveChapterArgs {
  section?: SectionKind
  chapterNumber?: number
  interludeIndex?: number
  title: string
  content: string
  updateState?: boolean
  /** 機械的に直せる表記を保存時に自動整形するかどうか。既定 true */
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
  const autoFix = args.autoFix !== false
  const fixResult = autoFix ? fixTypography(rawBody, { indent }) : null
  const body = fixResult ? fixResult.text : rawBody
  const title = normalizeChapterTitle(args.title)

  // 保存ファイル内部の見出しは算用数字の「第N章」で統一（書き出し時に chapterUnit で「第N話」等へ変換）
  const name = section.kind === "chapter" ? `第${section.chapter}章` : SECTION_NAMES[section.kind]
  const header = title.length > 0 ? `# ${name} ${title}\n\n` : `# ${name}\n\n`
  const saved = header + body

  let previousNote = ""
  if (existsSync(filePath)) {
    const previous = await safeReadFile(filePath)
    if (previous === null) {
      return `❌ ${label}は保存していません。いまの ${fileName} を読み込めず、前の原稿を残せないためです。
   ファイルの権限や中身（ディレクトリになっていないか）を確かめてください。`
    }
    if (previous === saved) {
      previousNote = `ℹ️ 前に保存した内容と同じでした\n`
    } else {
      const backupPath = await backupPreviousDraft(dir, fileName, previous)
      previousNote = `🗂️ 前の原稿を残しました: ${backupPath}\n`
    }
  }
  await safeWriteFile(filePath, saved)

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
  }
  report += summarizeForSave(saved, section, undefined, indent, await readGlossaryCheck(dir))
  report += summarizeProseForSave(saved, section)

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
      ? `⚠️ 目安より${(min - wordCount).toLocaleString("ja-JP")}文字少なめ`
      : wordCount > max
        ? `⚠️ 目安より${(wordCount - max).toLocaleString("ja-JP")}文字多め`
        : "目安の範囲内"
  return `📊 文字数: ${formatted}文字（目安 ${perChapter.toLocaleString("ja-JP")}文字 ±${tolerancePct}%［${range}］: ${status}）\n`
}
