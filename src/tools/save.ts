import { join } from "node:path"
import {
  safeReadFile,
  safeReadJson,
  safeWriteFile,
  getChaptersDir,
  getNovelDir,
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
import { DEFAULTS } from "../core/constants.js"
import type { ToolRuntimeContext } from "./types.js"

export interface SaveChapterArgs {
  section?: SectionKind
  chapterNumber?: number
  interludeIndex?: number
  title: string
  content: string
  updateState?: boolean
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
  const singleBody =
    isShortForm(config) && (config?.chapterCount ?? 1) === 1 && section.kind === "chapter" && section.chapter === 1
  const label = singleBody
    ? "本文"
    : section.kind === "chapter"
      ? `第${section.chapter}${unit}`
      : sectionLabel(section)
  const fileName = sectionFileName(section)
  const chaptersDir = getChaptersDir(dir)
  const filePath = join(chaptersDir, fileName)

  const body = stripChapterHeading(args.content)
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
  report += `📊 文字数: ${wordCount.toLocaleString("ja-JP")}文字\n`
  report += summarizeForSave(saved, section, undefined, indentStyleOf(config), await readGlossaryCheck(dir))
  report += summarizeProseForSave(saved, section)

  if (args.updateState !== false) {
    report += `\n💡 novel_update で次の記録を更新しておくと、後の話でつじつまが合わせやすくなります:\n`
    report += `  - character-state: 登場人物の状態・関係・ことばづかいの変化\n`
    report += `  - summary: この話のあらすじ\n`
    report += `  - foreshadow: 伏線の進み具合\n`
  }

  return report
}

async function backupPreviousDraft(dir: string, fileName: string, content: string): Promise<string> {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const base = join(getNovelDir(dir), "drafts", `${fileName.replace(/\.md$/, "")}-${stamp}`)
  let path = `${base}.md`
  for (let n = 2; existsSync(path); n++) path = `${base}-${n}.md`
  await safeWriteFile(path, content)
  return path
}
