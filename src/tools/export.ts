import { lstat, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  safeReadFile,
  safeReadJson,
  safeWriteFile,
  getConfigPath,
  getNovelDir,
  getChaptersDir,
  chapterTitleFromHeading,
  isShortForm,
  indentStyleOf,
  stripChapterHeading,
  countWords,
  toKanjiNumber,
} from "../core/utils.js"
import type { NovelConfig } from "../core/utils.js"
import { CHAPTER_UNITS, DEFAULTS } from "../core/constants.js"
import type { ChapterUnit } from "../core/constants.js"
import { formatChapterRanges } from "../core/records.js"
import { checkTypography } from "../core/typography.js"
import { convertRuby, countRubyMarks } from "../core/ruby.js"
import type { RubyNotation } from "../core/ruby.js"
import {
  listManuscriptFiles,
  describeExtraSections,
  sectionLabel,
  sectionFileName,
  SECTION_NAMES,
  parseParts,
  partName,
} from "../core/sections.js"
import type { ManuscriptFile } from "../core/sections.js"
import type { ToolRuntimeContext } from "./types.js"

export interface ExportArgs {
  format?: "text" | "markdown"
  numerals?: "kanji" | "arabic"
  ruby?: RubyNotation
  fromChapter?: number
  toChapter?: number
  outputPath?: string
  /** 話・章の単位の呼び名（既定は config.json の chapterUnit、無ければ「話」） */
  unit?: string
  /** true なら1話ずつ別ファイルに書き出す（投稿サイトの本文欄に貼る形） */
  split?: boolean
}

interface ExportEntry {
  file: ManuscriptFile
  partLine: string | null
  name: string
  title: string
  body: string
  chars: number
}

export async function novelExportExecute(args: ExportArgs, ctx: ToolRuntimeContext): Promise<string> {
  const dir = ctx.projectDir
  const format = args.format ?? "text"
  const ruby: RubyNotation = args.ruby ?? (format === "text" ? "kakuyomu" : "html")
  const from = args.fromChapter ?? 1
  const to = args.toChapter ?? Number.MAX_SAFE_INTEGER
  if (from > to) return `❌ fromChapter（${from}）が toChapter（${to}）より後ろです。`

  const config = await safeReadJson<NovelConfig>(getConfigPath(dir))
  const workTitle = config?.title?.trim() || "原稿"
  const unitRaw = args.unit ?? config?.chapterUnit ?? DEFAULTS.chapterUnit
  if (!CHAPTER_UNITS.includes(unitRaw as ChapterUnit)) {
    return `❌ 単位（${args.unit !== undefined ? "unit" : "config.json の chapterUnit"}）は「話」か「章」にしてください（受け取ったのは ${JSON.stringify(unitRaw)}）。`
  }
  const unit = unitRaw as ChapterUnit
  const numerals = args.numerals ?? (unit === "話" ? "arabic" : format === "text" ? "kanji" : "arabic")
  const split = args.split === true
  const indent = indentStyleOf(config)

  const partsResult = parseParts(config?.parts)
  if (partsResult && "error" in partsResult) return `❌ ${partsResult.error}`
  const bookParts = partsResult?.parts ?? []

  const ext = format === "text" ? "txt" : "md"
  const defaultPath = split
    ? join(getNovelDir(dir), "export", "episodes")
    : join(getNovelDir(dir), "export", `${safeFileName(workTitle)}.${ext}`)
  const outPath = args.outputPath ? resolve(dir, args.outputPath) : defaultPath
  if (!split) {
    const refused = await checkOutputPath(dir, outPath, args.outputPath ?? outPath)
    if (refused) return refused
  }

  const allManuscripts = await listManuscriptFiles(dir)
  const files = allManuscripts.filter((f) => inRange(f, from, to, args.toChapter === undefined))
  if (files.length === 0) return `❌ 書き出す本文がありません（.novel/chapters/chapter-NNN.md）。`
  const chapters = files.flatMap((f) => (f.section.kind === "chapter" ? [f.section.chapter] : []))
  const short = isShortForm(config)
  const allChapters = allManuscripts.filter((f) => f.section.kind === "chapter").length
  const bareChapter = short && allChapters <= 1

  const texts: string[] = []
  const unreadable: ManuscriptFile[] = []
  for (const f of files) {
    const text = await safeReadFile(f.path)
    if (text === null) unreadable.push(f)
    else texts.push(text)
  }
  if (unreadable.length > 0) {
    const unreadableChapters = unreadable.flatMap((f) => (f.section.kind === "chapter" ? [f.section.chapter] : []))
    const names = [
      ...(unreadableChapters.length > 0 ? [formatChapterRanges(unreadableChapters)] : []),
      ...unreadable.filter((f) => f.section.kind !== "chapter").map((f) => sectionLabel(f.section)),
    ]
    return `❌ 読み込めない本文があるため、書き出していません: ${names.join("、")}
   ファイルの権限や中身を確かめてください。`
  }

  const entries: ExportEntry[] = []
  let totalChars = 0
  let typographyErrors = 0
  const marks = { ruby: 0, emphasis: 0 }
  const chapterMark = bookParts.length > 0 ? "###" : "##"
  const partsShown: string[] = []
  for (const [i, f] of files.entries()) {
    const text = texts[i]
    const section = f.section
    const part = section.kind === "chapter" ? bookParts.find((p) => p.fromChapter === section.chapter) : undefined
    let partLine: string | null = null
    if (part) {
      const name = partName(part, numerals, toKanjiNumber)
      partsShown.push(name)
      partLine = `${name}　${part.title}`
    }
    const rawBody = stripChapterHeading(text).replace(/\s+$/, "")
    const chars = countWords(rawBody)
    totalChars += chars
    typographyErrors += checkTypography(text, { indent }).filter((issue) => issue.severity === "error").length
    const counted = countRubyMarks(text)
    marks.ruby += counted.ruby
    marks.emphasis += counted.emphasis
    const title = convertRuby(chapterTitleFromHeading(text), ruby)
    const body = convertRuby(rawBody, ruby)

    if (f.section.kind === "chapter" && bareChapter) {
      entries.push({ file: f, partLine, name: "", title: "", body, chars })
      continue
    }
    const no = f.section.kind === "chapter" ? (numerals === "kanji" ? toKanjiNumber(f.section.chapter) : String(f.section.chapter)) : ""
    const name =
      f.section.kind === "chapter" ? `第${no}${unit}` : SECTION_NAMES[f.section.kind]
    entries.push({ file: f, partLine, name, title, body, chars })
  }

  let written: string
  if (split) {
    const result = await writeEpisodes(dir, outPath, args.outputPath ?? outPath, ext, workTitle, entries)
    if ("error" in result) return result.error
    written = `📁 ディレクトリ: ${outPath}（${entries.length}ファイル＋${result.index}。本文だけで、見出しは付けていません。題は ${result.index} にあります）`
  } else {
    const parts: string[] = []
    for (const e of entries) {
      if (e.partLine) parts.push(format === "text" ? e.partLine : `## ${e.partLine.replace("　", " ")}`)
      if (!e.name) {
        parts.push(e.body)
        continue
      }
      const heading =
        format === "text"
          ? `${e.name}${e.title ? `　${e.title}` : ""}`
          : `${chapterMark} ${e.name}${e.title ? ` ${e.title}` : ""}`
      parts.push(`${heading}\n\n${e.body}`)
    }
    const head = format === "text" ? `${workTitle}\n\n\n` : `# ${workTitle}\n\n`
    const separator = format === "text" ? "\n\n\n" : "\n\n"
    await safeWriteFile(outPath, head + parts.join(separator) + "\n")
    written = `📄 ファイル: ${outPath}`
  }

  const present = new Set(chapters)
  const last = args.toChapter ?? (chapters.length > 0 ? chapters[chapters.length - 1] : from - 1)
  const missing: number[] = []
  for (let n = from; n <= last; n++) if (!present.has(n)) missing.push(n)

  const extras = describeExtraSections(files.map((f) => f.section))
  const range = [
    ...(bareChapter && chapters.length > 0
      ? ["本文（短編・読み切り）"]
      : chapters.length > 0 ? [`${formatChapterRanges(chapters)}（${chapters.length}${unit}）`] : []),
    ...(extras ? [extras] : []),
  ].join("＋")
  let report = `✅ 原稿を書き出しました（${format === "text" ? "テキスト" : "Markdown"}${split ? "・1話ずつ" : ""}）
${written}
📚 範囲: ${range}
📊 文字数: ${totalChars.toLocaleString("ja-JP")}文字（本文のみ。見出しは含まない）
`
  if (partsShown.length > 0) report += `🗂️ 部の見出し: ${partsShown.join("・")}\n`
  if (marks.ruby + marks.emphasis > 0) {
    report += `🔤 ルビ ${marks.ruby}箇所・傍点 ${marks.emphasis}箇所を ${RUBY_NOTATION_LABELS[ruby]} で書き出しました\n`
  }
  if (missing.length > 0) {
    report += `⚠️ 本文の無い話を飛ばしました: ${formatChapterRanges(missing)}\n`
  }
  if (typographyErrors > 0) {
    report += `⚠️ 表記の規約違反が ${typographyErrors}件あります（書き出しでは直していません）。novel_check で確かめられます\n`
  }
  return report
}

async function writeEpisodes(
  dir: string,
  outDir: string,
  shown: string,
  ext: string,
  workTitle: string,
  entries: ExportEntry[],
): Promise<{ index: string } | { error: string }> {
  const stat = await lstat(outDir).catch(() => null)
  if (stat && !stat.isDirectory() && !stat.isSymbolicLink()) {
    return { error: `❌ 1話ずつ書き出すときの書き出し先はディレクトリにしてください（${shown} はファイルです）。` }
  }
  const indexName = `index.${ext}`
  const targets = [
    ...entries.map((e) => join(outDir, sectionFileName(e.file.section).replace(/\.md$/, `.${ext}`))),
    join(outDir, indexName),
  ]
  for (const target of targets) {
    const refused = await checkOutputPath(dir, target, relative(dir, target))
    if (refused) return { error: refused }
  }

  const lines: string[] = [workTitle, ""]
  for (const [i, e] of entries.entries()) {
    await safeWriteFile(targets[i], e.body + "\n")
    if (e.partLine) lines.push("", `■ ${e.partLine}`)
    const heading = e.name ? `${e.name}${e.title ? `　${e.title}` : ""}` : "本文"
    lines.push(`${basename(targets[i])}　${heading}（${e.chars.toLocaleString("ja-JP")}文字）`)
  }
  await safeWriteFile(targets[targets.length - 1], lines.join("\n") + "\n")
  return { index: indexName }
}

function inRange(f: ManuscriptFile, from: number, to: number, toEnd: boolean): boolean {
  switch (f.section.kind) {
    case "chapter":
    case "interlude":
      return f.section.chapter >= from && f.section.chapter <= to
    case "prologue":
      return from <= 1
    case "epilogue":
      return toEnd
  }
}

const RUBY_NOTATION_LABELS: Record<RubyNotation, string> = {
  kakuyomu: "カクヨム形式（｜親文字《ルビ》・《《傍点》》）",
  narou: "小説家になろう形式（｜親文字《ルビ》。傍点は「・」のルビ）",
  aozora: "青空文庫形式（｜親文字《ルビ》・［＃「…」に傍点］）",
  pixiv: "pixiv 形式（[[rb:親文字 > ルビ]]。傍点は「・」のルビ）",
  html: "HTML の <ruby>（傍点は「・」のルビ）",
  paren: "括弧書き（親文字（ルビ）。傍点は外す）",
  none: "ルビなし（親文字だけ。傍点は外す）",
}

async function checkOutputPath(dir: string, outPath: string, shown: string): Promise<string | null> {
  const outside = `❌ 書き出し先は作品のディレクトリの中にしてください（受け取ったのは ${shown}）。`
  const intoChapters = `❌ .novel/chapters/ には書き出せません（本文ファイルと混ざるため）。`

  const rel = relative(dir, outPath)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return outside
  const chaptersDir = getChaptersDir(dir)
  if (isInside(chaptersDir, outPath)) return intoChapters

  const stat = await lstat(outPath).catch(() => null)
  if (stat?.isSymbolicLink()) {
    return `❌ 書き出し先がシンボリックリンクです（${shown}）。リンク先を上書きしないよう、書き出していません。`
  }
  if (stat?.isDirectory()) return `❌ 書き出し先がディレクトリです（${shown}）。ファイル名まで指定してください。`

  const realProject = await realpath(dir)
  const realChapters = await realpath(chaptersDir).catch(() => resolve(realProject, relative(dir, chaptersDir)))
  const realTarget = join(await realpathOfNearest(dirname(outPath)), basename(outPath))
  if (!isInside(realProject, realTarget)) return outside
  if (isInside(realChapters, realTarget)) return intoChapters
  return null
}

async function realpathOfNearest(path: string): Promise<string> {
  const rest: string[] = []
  let current = path
  for (;;) {
    try {
      return join(await realpath(current), ...rest.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      rest.push(basename(current))
      current = parent
    }
  }
}

function isInside(base: string, child: string): boolean {
  const rel = relative(base, child)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").slice(0, 100) || "原稿"
}
