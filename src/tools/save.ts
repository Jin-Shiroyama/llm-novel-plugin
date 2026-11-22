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
  chapterTitleFromHeading,
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
import type { IndentStyle } from "../core/constants.js"
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

export interface ChapterEdit {
  from: string
  to: string
}

export interface SaveChapterArgs {
  section?: SectionKind
  chapterNumber?: number
  interludeIndex?: number
  /** 全文保存（content 指定）時は必須。部分置換（edits 指定）時は省略すると既存タイトルを維持 */
  title?: string
  /** 本文（見出し行は含めない）。edits と排他 */
  content?: string
  /** 既存保存済み本文に対する部分置換。content と排他 */
  edits?: ChapterEdit[]
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

  const hasContent = args.content !== undefined
  const hasEdits = args.edits !== undefined
  if (hasContent && hasEdits) {
    return `❌ ${label}は保存していません。content と edits は同時に指定できません。どちらか一方を指定してください。`
  }
  if (!hasContent && !hasEdits) {
    return `❌ ${label}は保存していません。content（全文保存）または edits（部分置換）のどちらか一方を指定してください。`
  }

  let existingRaw: string | null = null
  const fileExists = existsSync(filePath)
  if (fileExists) {
    existingRaw = await safeReadFile(filePath)
    if (existingRaw === null) {
      return `❌ ${label}は保存していません。いまの ${fileName} を読み込めず、前の原稿を残せないためです。
   ファイルの権限や中身（ディレクトリになっていないか）を確かめてください。`
    }
  }

  let rawBody: string
  let rawTitle: string
  let editSummaryNote = ""

  if (hasEdits) {
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return `❌ ${label}は保存していません。edits には1件以上の置換（{ from, to }）を指定してください。`
    }
    for (let i = 0; i < args.edits.length; i++) {
      const e = args.edits[i]
      if (!e || typeof e.from !== "string" || typeof e.to !== "string" || e.from.length === 0) {
        return `❌ ${label}は保存していません。edits の${i + 1}件目には空でない from と文字列の to を指定してください。`
      }
    }
    if (!fileExists || existingRaw === null) {
      return `❌ ${label}は保存していません。既存の本文ファイル（${fileName}）が見つかりません。先に content で新規保存してください。`
    }
    const existingBody = stripChapterHeading(existingRaw)
    const bodyStartLine = computeBodyStartLine(existingRaw)
    const applied = applyChapterEdits(existingBody, args.edits, indent, bodyStartLine, label)
    if ("error" in applied) return applied.error
    rawBody = applied.text
    rawTitle = args.title !== undefined ? args.title : chapterTitleFromHeading(existingRaw)
    editSummaryNote = `✏️ 部分置換を適用しました（${args.edits.length}件）\n`
    if (applied.fallbackIndices.length > 0) {
      const items = applied.fallbackIndices.map((n) => `${n}件目`).join("・")
      editSummaryNote += `ℹ️ edits の${items}は自動整形後または抜粋復元後の文面へ照合して置換しました\n`
    }
  } else {
    if (typeof args.title !== "string") {
      return `❌ ${label}は保存していません。content で保存するときは title（サブタイトル）を指定してください。`
    }
    rawBody = stripChapterHeading(args.content!)
    rawTitle = args.title
  }

  const autoFix = args.autoFix ?? DEFAULT_AUTO_FIX
  const fixResult = autoFix ? fixTypography(rawBody, { indent }) : null
  if (fixResult?.unconvergedLines.length) {
    return formatUnconvergedSaveError(label, section, rawBody, fixResult.unconvergedLines)
  }
  const body = fixResult ? fixResult.text : rawBody
  const title = normalizeChapterTitle(rawTitle)

  // 保存ファイル内部の見出しは算用数字の「第N章」で統一（書き出し時に chapterUnit で「第N話」等へ変換）
  const name = section.kind === "chapter" ? `第${section.chapter}章` : SECTION_NAMES[section.kind]
  const header = title.length > 0 ? `# ${name} ${title}\n\n` : `# ${name}\n\n`
  const saved = header + body

  let previousNote = ""
  let sameAsPrevious = false
  if (fileExists && existingRaw !== null) {
    if (existingRaw === saved) {
      sameAsPrevious = true
      previousNote = `ℹ️ 前に保存した内容と同じでした\n`
    } else {
      const backupPath = await backupPreviousDraft(dir, fileName, existingRaw)
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
  if (title !== rawTitle.trim()) {
    report += `ℹ️ タイトルに改行などが含まれていたため、1行に直しました\n`
  }
  report += `📄 ファイル: ${filePath}\n`
  report += editSummaryNote
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

const CHAPTER_HEADING_PATTERN =
  /^#{1,6}\s*(?:第\s*[0-9０-９〇零一二三四五六七八九十百千]+\s*[章話]|(?:プロローグ|エピローグ|幕間)(?=[\s　]|$))/

/** 保存ファイル内で見出し行＋直後の空行を除いた本文の開始行番号（1始まり）を返す */
function computeBodyStartLine(fileContent: string): number {
  const lines = fileContent.replace(/\r\n/g, "\n").split("\n")
  let i = 0
  while (i < lines.length && lines[i].trim().length === 0) i++
  if (i >= lines.length || !CHAPTER_HEADING_PATTERN.test(lines[i].trim())) return 1
  i++
  while (i < lines.length && lines[i].trim().length === 0) i++
  return i + 1
}

function findOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return []
  const indices: number[] = []
  let pos = 0
  while (pos <= haystack.length) {
    const idx = haystack.indexOf(needle, pos)
    if (idx === -1) break
    indices.push(idx)
    pos = idx + needle.length
  }
  return indices
}

function replaceAt(source: string, start: number, length: number, replacement: string): string {
  return source.slice(0, start) + replacement + source.slice(start + length)
}

function toBigrams(text: string): Set<string> {
  const chars = [...text.replace(/[\s　]+/g, "")]
  if (chars.length === 0) return new Set()
  if (chars.length === 1) return new Set(chars)
  const set = new Set<string>()
  for (let i = 0; i < chars.length - 1; i++) {
    set.add(chars[i] + chars[i + 1])
  }
  return set
}

interface UnexcerptResult {
  text: string
  strippedHead: boolean
  strippedTail: boolean
  replacedSquare: boolean
}

/** novel_check / 保存レポートの抜粋記号（□ と両端の単独 …）を本文表記へ復元する */
function unexcerptFrom(raw: string): UnexcerptResult | null {
  let text = raw
  let replacedSquare = false
  let strippedHead = false
  let strippedTail = false
  if (text.includes("□")) {
    text = text.replace(/□/g, "　")
    replacedSquare = true
  }
  if (/^…(?!…)/.test(text)) {
    text = text.slice(1)
    strippedHead = true
  }
  if (/(?<!…)…$/.test(text)) {
    text = text.slice(0, -1)
    strippedTail = true
  }
  if (!replacedSquare && !strippedHead && !strippedTail) return null
  if (text.length === 0) return null
  return { text, strippedHead, strippedTail, replacedSquare }
}

function hasUnsafeExcerptMarkersInTo(toText: string, unexcerpt: UnexcerptResult): boolean {
  if (unexcerpt.replacedSquare && toText.includes("□")) return true
  if ((unexcerpt.strippedHead || unexcerpt.strippedTail) && /(?<!…)…(?!…)/.test(toText)) return true
  return false
}

function collectTypographyCandidates(source: string, indent: IndentStyle, exclude: Set<string>): string[] {
  const fixed = fixTypography(source, { indent })
  if (fixed.unconvergedLines.length > 0) return []
  const out: string[] = []
  const push = (cand: string) => {
    if (cand.length > 0 && !exclude.has(cand)) {
      exclude.add(cand)
      out.push(cand)
    }
  }
  push(fixed.text)
  if (indent === "fullwidth" && !source.startsWith("　") && fixed.text.startsWith("　")) {
    push(fixed.text.slice(1))
  }
  return out
}

function findSimilarLines(
  body: string,
  fromText: string,
  bodyStartLine: number,
  maxResults = 3,
): Array<{ lineNumber: number; text: string }> {
  const unexcerpted = unexcerptFrom(fromText)
  const searchSource = unexcerpted ? unexcerpted.text : fromText
  const fromLines = searchSource
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (fromLines.length === 0) return []
  const query =
    [...fromLines[0]].length >= 4
      ? fromLines[0]
      : fromLines.reduce((best, cur) => ([...cur].length > [...best].length ? cur : best), fromLines[0])
  const normQuery = query.replace(/[\s　]+/g, "")
  const qBigrams = toBigrams(query)
  if (qBigrams.size === 0) return []

  const scored: Array<{ lineNumber: number; text: string; score: number }> = []
  const bodyLines = body.split("\n")
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]
    const normLine = line.replace(/[\s　]+/g, "")
    if (normLine.length === 0) continue
    const lBigrams = toBigrams(line)
    let overlap = 0
    for (const bg of qBigrams) {
      if (lBigrams.has(bg)) overlap++
    }
    let score = (2 * overlap) / (qBigrams.size + lBigrams.size)
    if (normQuery.length >= 2 && normLine.length >= 2 && (normLine.includes(normQuery) || normQuery.includes(normLine))) {
      score += 0.35
    }
    if (score >= 0.15) {
      scored.push({ lineNumber: bodyStartLine + i, text: line, score })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || a.lineNumber - b.lineNumber)
    .slice(0, maxResults)
    .map(({ lineNumber, text }) => ({ lineNumber, text }))
}

const SIMILAR_LINE_MAX_CHARS = 200

function formatSimilarLineHint(lineNumber: number, text: string): string {
  const [clipped, truncated] = truncateChars(text, SIMILAR_LINE_MAX_CHARS)
  if (!truncated) return `  - ${lineNumber}行目: ${text}`
  return `  - ${lineNumber}行目（先頭${SIMILAR_LINE_MAX_CHARS}字のみ表示・以下略。全文は本文ファイルを確認）: ${clipped}`
}

function applyChapterEdits(
  body: string,
  edits: ChapterEdit[],
  indent: IndentStyle,
  bodyStartLine: number,
  label: string,
): { text: string; fallbackIndices: number[] } | { error: string } {
  let working = body.replace(/\r\n/g, "\n")
  const fallbackIndices: number[] = []

  for (let i = 0; i < edits.length; i++) {
    const index = i + 1
    const fromNorm = edits[i].from.replace(/\r\n/g, "\n")
    const toNorm = edits[i].to.replace(/\r\n/g, "\n")

    // 第1段: 完全一致
    const exact = findOccurrences(working, fromNorm)
    if (exact.length === 1) {
      working = replaceAt(working, exact[0], fromNorm.length, toNorm)
      continue
    }
    if (exact.length > 1) {
      return {
        error: `❌ ${label}は保存していません。edits の${index}件目の from が本文中の ${exact.length} 箇所に一致しました。前後の文脈を含めて一意にしてください。`,
      }
    }

    // 第2段: 自動整形後または抜粋復元後の文面でフォールバック照合
    const seen = new Set<string>([fromNorm])
    const candidates: Array<{ text: string; source: "typography" | "excerpt" }> = []
    for (const c of collectTypographyCandidates(fromNorm, indent, seen)) {
      candidates.push({ text: c, source: "typography" })
    }

    const unexcerpt = unexcerptFrom(fromNorm)
    if (unexcerpt) {
      if (!seen.has(unexcerpt.text)) {
        seen.add(unexcerpt.text)
        candidates.push({ text: unexcerpt.text, source: "excerpt" })
      }
      for (const c of collectTypographyCandidates(unexcerpt.text, indent, seen)) {
        candidates.push({ text: c, source: "excerpt" })
      }
    }

    let matched = false
    for (const candidate of candidates) {
      const hits = findOccurrences(working, candidate.text)
      if (hits.length === 1) {
        if (candidate.source === "excerpt" && unexcerpt && hasUnsafeExcerptMarkersInTo(toNorm, unexcerpt)) {
          return {
            error:
              `❌ ${label}は保存していません。edits の${index}件目の to に抜粋記号（□ や単独の …）が残っています。` +
              `\n💡 点検結果の抜粋は場所の目印にだけ使い、from・to は保存後の本文ファイルを読んで写してください。`,
          }
        }
        working = replaceAt(working, hits[0], candidate.text.length, toNorm)
        fallbackIndices.push(index)
        matched = true
        break
      }
      if (hits.length > 1) {
        const kindLabel = candidate.source === "excerpt" ? "抜粋復元後の文面" : "自動整形後の文面"
        return {
          error: `❌ ${label}は保存していません。edits の${index}件目の from（${kindLabel}）が本文中の ${hits.length} 箇所に一致しました。前後の文脈を含めて一意にしてください。`,
        }
      }
    }

    if (!matched) {
      const similar = findSimilarLines(working, fromNorm, bodyStartLine)
      const hint =
        similar.length > 0
          ? `\n💡 保存後の本文で近い行（from は保存後の本文ファイルを読んで写してください。点検結果の抜粋は場所の目印にだけ使います）:\n` +
            similar.map(({ lineNumber, text }) => formatSimilarLineHint(lineNumber, text)).join("\n")
          : `\n💡 from は保存後の本文ファイルを読んで写してください（点検結果の抜粋は場所の目印にだけ使います）。`
      return {
        error: `❌ ${label}は保存していません。edits の${index}件目の from に一致する箇所が本文に見つかりませんでした（自動整形後・抜粋復元後の文面でも不一致）。${hint}`,
      }
    }
  }

  return { text: working, fallbackIndices }
}
