/** 表記点検・整形・文章点検が共有する行と記法の解析。位置はコードポイント単位。 */
import { parseRubyLine } from "./ruby.js"
import type { RubyIssue, RubySegment } from "./ruby.js"
import { urlRanges } from "./urls.js"
import { punctuationRole } from "./punctuation.js"

export type LineKind = "empty" | "heading" | "separator" | "frame" | "dialogue" | "display" | "narration"
const SEPARATOR = /^[\s　]*[＊*◇◆□■○●※・〜~\-－―]+(?:[\s　]*[＊*◇◆□■○●※・〜~\-－―]+)*[\s　]*$/
const BLOCK_OPENERS = new Set(["【", "（", "(", "＜", "<", "〈", "《", "≪", "［", "[", "〔", "｛", "{"])
const LINE_MARKERS = new Set(["・", "※", "＊", "*", "◇", "◆", "□", "■", "○", "●", "▽", "▼", "△", "▲", "▶", "▷", "→", "＞", ">"])
const LABEL_LINE = /^[^\s　、。！？!?「」『』：:]{1,12}[：:]/u
export const BOX_FRAME_CHAR = /[\u2501-\u257F]/

export function isBoxDrawingLine(line: string): boolean {
  const text = line.trim()
  return !!text && (BOX_FRAME_CHAR.test([...text][0]) || /^[\u2500-\u257F\s　]+$/.test(text) || /^─{2,}[\s　]+.+[\s　]+─{2,}$/.test(text))
}
export const isSeparatorLine = (line: string) => SEPARATOR.test(line)

export function classifyLine(chars: string[]): { kind: LineKind; leading: number; noIndent: boolean } {
  const line = chars.join("")
  const leading = chars.findIndex(c => c !== " " && c !== "　" && c !== "\t")
  const n = leading < 0 ? chars.length : leading
  const rest = chars.slice(n).join("")
  const first = chars[n]
  let kind: LineKind = "narration"
  if (!rest) kind = "empty"
  else if (line.startsWith("#")) kind = "heading"
  else if (isBoxDrawingLine(line)) kind = "frame"
  else if (isSeparatorLine(line)) kind = "separator"
  else if (first === "「" || first === "『") kind = "dialogue"
  else if (punctuationRole(chars, n)) kind = "narration"
  else if (BLOCK_OPENERS.has(first) || LINE_MARKERS.has(first) || LABEL_LINE.test(rest)) kind = "display"
  const noIndent = kind === "dialogue" || (kind === "narration" && punctuationRole(chars, n) !== null)
  return { kind, leading: n, noIndent }
}
export const isNarrationLine = (chars: string[]) => classifyLine(chars).kind === "narration"

export interface TextSpan {
  kind: RubySegment["kind"]
  /** 表示文字の範囲 */
  from: number
  to: number
  /** 元の行での、読みや閉じ記号を含めた末尾 */
  sourceEnd: number
}
export interface LineAnalysis {
  original: string[]
  chars: string[]
  columns: number[]
  spans: TextSpan[]
  spanAt: TextSpan[]
  rubyIssues: RubyIssue[]
  urlMask: boolean[]
  ambiguousUrls: number[]
  kind: LineKind
  leading: number
  noIndent: boolean
}

export function analyzeManuscriptLine(line: string): LineAnalysis {
  const original = [...line]
  const { segments, issues: rubyIssues } = parseRubyLine(line)
  const chars: string[] = []
  const columns: number[] = []
  const spans: TextSpan[] = []
  const spanAt: TextSpan[] = []
  for (const seg of segments) {
    const content = [...(seg.kind === "ruby" ? seg.base : seg.text)]
    const positions = seg.kind === "text" ? seg.columns : content.map((_, k) => (seg.kind === "ruby" ? seg.baseStart : seg.textStart) + k)
    const sourceEnd = seg.kind === "text" ? (positions.at(-1) ?? -1) + 1
      : seg.kind === "ruby" ? seg.baseStart + content.length + [...seg.reading].length + 2
      : seg.textStart + content.length + 2
    const span: TextSpan = { kind: seg.kind, from: chars.length, to: chars.length + content.length, sourceEnd }
    spans.push(span)
    chars.push(...content)
    columns.push(...positions)
    spanAt.push(...content.map(() => span))
  }
  const urlMask = chars.map(() => false)
  const ambiguousUrls: number[] = []
  for (const range of urlRanges(chars.join(""))) {
    if (range.ambiguous) ambiguousUrls.push(range.from)
    for (let k = range.from; k < range.to; k++) urlMask[k] = true
  }
  return { original, chars, columns, spans, spanAt, rubyIssues, urlMask, ambiguousUrls, ...classifyLine(chars) }
}

export interface TypographyEdit {
  /** 元の行のコードポイント位置（0始まり、end は含まない） */
  start: number
  end: number
  replacement: string
}

/** 連続した同一範囲内だけを編集する。読み・記法・URL・ルビ対象の長さは変えない。 */
export function visibleEdit(a: LineAnalysis, from: number, to: number, replacement: string): TypographyEdit | undefined {
  if (a.rubyIssues.length > 0 || from >= to || a.urlMask.slice(from, to).some(Boolean)) return undefined
  const span = a.spanAt[from]
  if (!span || a.spanAt[to - 1] !== span) return undefined
  if (span.kind === "ruby" && [...replacement].length !== to - from) return undefined
  if (span.kind === "emphasis" && from === span.from && to === span.to && replacement.length === 0) return undefined
  const start = a.columns[from]
  const end = a.columns[to - 1] + 1
  if (end - start !== to - from || a.original.slice(start, end).join("") === replacement) return undefined
  return { start, end, replacement }
}

/** 末尾の閉じ記号の外側、または同じ傍点本文の内側へ挿入する。 */
export function insertAfter(a: LineAnalysis, index: number, replacement: string): TypographyEdit | undefined {
  if (a.rubyIssues.length > 0 || a.urlMask[index]) return undefined
  const span = a.spanAt[index]
  if (!span || (span.kind === "ruby" && index + 1 < span.to)) return undefined
  const start = index + 1 === span.to ? span.sourceEnd : a.columns[index] + 1
  return { start, end: start, replacement }
}
