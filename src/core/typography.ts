/**
 * llm-novel-plugin - 表記の点検（ライトノベル・Web小説特化）
 *
 * novel-writing skill の表記規約のうち、機械で確かめられるものを点検する。
 *
 * - 段落頭の字下げは indent オプションで切り替え可能:
 *     "fullwidth"（既定）: 地の文は全角1字下げ。会話・記号・画面・掲示板の行は字下げしない
 *     "none":              Web小説の字下げなしスタイル。全角字下げが残っていれば確認（⚠️）で知らせる
 * - 単位付きの数やステータス表記の半角算用数字は常に許容（文芸向けの漢数字強制は行わない）
 */

import { analyzeManuscriptLine, visibleEdit, insertAfter } from "./text-analysis.js"
import { punctuationRole } from "./punctuation.js"
import type { LineAnalysis, TypographyEdit } from "./text-analysis.js"
export { isNarrationLine, isSeparatorLine, isBoxDrawingLine } from "./text-analysis.js"
export type { TypographyEdit } from "./text-analysis.js"
import type { IndentStyle } from "./constants.js"

export type TypographySeverity = "error" | "warning"

export interface TypographyIssue {
  /** ファイルの行番号（1から） */
  line: number
  /** 行内の位置（1から。コードポイント単位） */
  column: number
  rule: TypographyRule
  severity: TypographySeverity
  message: string
  /** 問題の箇所の前後 */
  excerpt: string
  /** この診断に対応する安全な修正。無い場合は点検のみ。 */
  fix?: TypographyEdit
}

export type TypographyRule =
  | "bracket"
  | "dialogue-period"
  | "ellipsis"
  | "dash"
  | "space-after-ellipsis-dash"
  | "halfwidth-punctuation"
  | "exclamation-space"
  | "indent"
  | "fullwidth-digit"
  | "ascii-space"
  | "ruby"
  | "glossary-term"
  | "url-boundary"

export const TYPOGRAPHY_RULE_LABELS: Record<TypographyRule, string> = {
  "url-boundary": "URL と本文の境界",
  bracket: "括弧の対応",
  "dialogue-period": "会話文末の句点",
  ellipsis: "三点リーダ",
  dash: "ダッシュ",
  "space-after-ellipsis-dash": "三点リーダ・ダッシュのあとの空白",
  "halfwidth-punctuation": "半角の約物",
  "exclamation-space": "感嘆符・疑問符のあとの空白",
  indent: "段落頭の字下げ",
  "fullwidth-digit": "全角の算用数字",
  "ascii-space": "日本語と英数字のあいだの空白",
  ruby: "ルビ・傍点の記法",
  "glossary-term": "用語集の使わない表記",
}

export interface GlossaryCheck {
  terms: string[]
  avoid: Array<{ form: string; term: string }>
}

const OPEN_BRACKETS: Record<string, string> = { "「": "」", "『": "』" }
const CLOSE_BRACKETS: Record<string, string> = { "」": "「", "』": "『" }

const CLOSERS = new Set(["」", "』", "）", ")", "】", "〕", "〉", "》", "＞", ">", "］", "]", "｝", "}", "≫"])
const FOLLOWING_PUNCTUATION = new Set(["…", "―", "、", "。", "・", "（", "「", "『", "♪", "♡", "♥", "☆", "★", "♫", "♬", "ｗ", "w"])
const NO_SPACE_BEFORE = new Set(["！", "？", "!", "?", "…", "―", "、", "。", "・"])

const KATAKANA = /[ァ-ヺー]/
const JAPANESE = /[぀-ヿ㐀-鿿豈-﫿々〆ヶ]/
const ASCII_ALNUM = /[A-Za-z0-9]/

/** 本文の表記を点検する */
export function checkTypography(
  text: string,
  opts: { indent?: IndentStyle; glossary?: GlossaryCheck } = {},
): TypographyIssue[] {
  const indent: IndentStyle = opts.indent ?? "fullwidth"
  const issues: TypographyIssue[] = []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  lines.forEach((line, i) => {
    const analysis = analyzeManuscriptLine(line)
    if (analysis.kind === "empty" || analysis.kind === "heading") return
    const { original, chars, columns } = analysis
    for (const issue of analysis.rubyIssues) {
      issues.push({ line: i + 1, column: issue.column + 1, rule: "ruby", severity: "error", message: issue.message, excerpt: excerptAt(original, issue.column) })
    }
    checkLine(analysis, i + 1, issues, indent)
    if (opts.glossary) checkGlossaryTerms(chars, columns, original, i + 1, issues, opts.glossary)
  })
  return issues
}

function checkGlossaryTerms(
  chars: string[],
  columns: number[],
  original: string[],
  lineNo: number,
  issues: TypographyIssue[],
  glossary: GlossaryCheck,
): void {
  const line = chars.join("")
  if (!glossary.avoid.some(({ form }) => line.includes(form))) return

  const forms = [
    ...glossary.terms.map((t) => ({ chars: [...t], avoid: null })),
    ...glossary.avoid.map((a) => ({ chars: [...a.form], avoid: a })),
  ]
    .filter((f) => f.chars.length > 0)
    .sort((x, y) => y.chars.length - x.chars.length || (x.avoid ? 1 : 0) - (y.avoid ? 1 : 0))
  for (let i = 0; i < chars.length; ) {
    const hit = forms.find((f) => i + f.chars.length <= chars.length && f.chars.every((c, k) => chars[i + k] === c))
    if (!hit) {
      i++
      continue
    }
    if (hit.avoid) {
      const at = columns[i]
      issues.push({
        line: lineNo,
        column: at + 1,
        rule: "glossary-term",
        severity: "warning",
        message: `「${hit.avoid.form}」は用語集で使わない表記です（「${hit.avoid.term}」と書く。人物があえて言うのでなければ）`,
        excerpt: excerptAt(original, at),
      })
    }
    i += hit.chars.length
  }
}

/** 各規則は診断と修正案を同時に返す。整形側に別の規則は持たせない。 */
function checkLine(a: LineAnalysis, lineNo: number, issues: TypographyIssue[], indent: IndentStyle): void {
  const { chars, columns, original, urlMask } = a
  if (a.kind === "frame" || a.kind === "separator") return
  const add = (column: number, rule: TypographyRule, severity: TypographySeverity, message: string, fix?: TypographyEdit) => {
    const at = column < columns.length ? columns[column] : original.length
    issues.push({ line: lineNo, column: at + 1, rule, severity, message, excerpt: excerptAt(original, at), ...(fix ? { fix } : {}) })
  }
  const edit = (from: number, to: number, replacement: string) => visibleEdit(a, from, to, replacement)
  const runEnd = (i: number, predicate: (char: string) => boolean) => {
    let j = i
    while (j < chars.length && a.spanAt[j] === a.spanAt[i] && !urlMask[j] && predicate(chars[j])) j++
    return j
  }
  const roleAt = (i: number) => urlMask[i] ? null : punctuationRole(chars, i, a.spanAt[i]?.to ?? i)

  // 行の分類は文章点検と共通。字下げだけは、壊れたルビより前の空白も安全に修正できる。
  const n = a.leading
  const halfIndent = chars.slice(0, n).some(c => c === " " || c === "\t")
  const desired = a.noIndent || indent === "none" || a.kind === "display" ? "" : "　"
  const indentEdit = { start: 0, end: n, replacement: desired }
  const plainLeading = original.slice(0, n).every(c => c === " " || c === "　" || c === "\t")
  if (a.kind === "display") {
    // 表示行の空白は半角・タブも含めてレイアウトとして保持する。
  } else if (halfIndent) {
    add(0, "indent", "error", "段落頭に半角スペースやタブを使わない", plainLeading ? indentEdit : undefined)
  } else if (n > 0 && a.noIndent) {
    add(0, "indent", "error", "会話・三点リーダ・ダッシュで始まる行は字下げしない", plainLeading ? indentEdit : undefined)
  } else if (n > 0 && indent === "none") {
    add(0, "indent", "warning", "この作品は字下げなし（indent: none）設定です。段落頭の全角スペースを外してそろえます", plainLeading ? indentEdit : undefined)
  } else if (a.kind === "narration" && !a.noIndent && indent === "fullwidth") {
    if (n === 0) add(0, "indent", "error", "地の文の段落頭は全角スペース1字下げ", indentEdit)
    else if (n > 1) add(0, "indent", "warning", `段落頭の字下げが${n}字あります（1字にする）`)
  }

  for (const at of a.ambiguousUrls) add(at, "url-boundary", "warning", "URL 候補と本文の境界が曖昧なため、この範囲は整形しません。URL なら <...> で囲むか空白で区切ってください")
  const stack: Array<{ ch: string; at: number }> = []
  for (let i = 0; i < chars.length; i++) {
    if (urlMask[i]) continue
    const ch = chars[i]
    if (ch in OPEN_BRACKETS) stack.push({ ch, at: i })
    else if (ch in CLOSE_BRACKETS) {
      const top = stack.at(-1)
      if (top && top.ch === CLOSE_BRACKETS[ch]) stack.pop()
      else add(i, "bracket", "error", `対応する「${CLOSE_BRACKETS[ch]}」の無い「${ch}」です`)
      if (ch === "」" && chars[i - 1] === "。") add(i - 1, "dialogue-period", "error", "会話文末に句点を打たない（「行こう。」→「行こう」）", edit(i - 1, i, ""))
    }
  }
  for (const open of stack) add(open.at, "bracket", "error", `「${open.ch}」が行の中で閉じていません（括弧の中では改行しない）`)

  for (let i = 0; i < chars.length;) {
    if (urlMask[i]) { i++; continue }
    const ch = chars[i]
    if (ch === "…" || ch === "―") {
      const j = runEnd(i, c => c === ch)
      if ((j - i) % 2 === 1) add(i, ch === "…" ? "ellipsis" : "dash", "error", `${ch === "…" ? "三点リーダ" : "ダッシュ"}は2つ重ね。偶数個にする`, edit(i, j, ch.repeat(j - i + 1)))
      if (chars[j] === "　") {
        const k = runEnd(j, c => c === "　")
        add(j, "space-after-ellipsis-dash", "error", "三点リーダ・ダッシュの直後に全角スペースを入れない", edit(j, k, ""))
      }
      i = j; continue
    }
    if (roleAt(i) === "ellipsis") {
      const j = runEnd(i, c => c === ch)
      const run = j - i
      if ((ch === "." && run < 3) || (ch === "・" && run < 2)) { i = j; continue }
      const length = ch === "‥" ? run + run % 2 : Math.max(2, Math.ceil(run / 3) * 2)
      add(i, "ellipsis", "error", "三点リーダは「……」を使う（‥、・・・、... は使わない）", edit(i, j, "…".repeat(length)))
      i = j; continue
    }
    if (ch === "—" || ch === "─" || ch === "–") {
      const j = runEnd(i, c => c === ch)
      if (roleAt(i) === "dash") add(i, "dash", "error", `ダッシュは「――」（U+2015）を使う（「${ch}」は使わない）`, edit(i, j, "―".repeat(j - i + (j - i) % 2)))
      i = j; continue
    }
    if (ch === "ー" && chars[i + 1] === "ー" && !(i > 0 && KATAKANA.test(chars[i - 1]))) {
      add(i, "dash", "error", "長音符「ー」でダッシュを代用しない（「――」を使う）")
      i = runEnd(i, c => c === "ー"); continue
    }
    if ("！？!?".includes(ch)) {
      const j = runEnd(i, c => "！？!?".includes(c))
      for (let k = i; k < j; k++) {
        if (chars[k] === "!" || chars[k] === "?") add(k, "halfwidth-punctuation", "error", `半角の「${chars[k]}」は使わない`, edit(k, k + 1, chars[k] === "!" ? "！" : "？"))
      }
      const next = chars[j]
      if (next !== undefined && !CLOSERS.has(next) && !FOLLOWING_PUNCTUATION.has(next) && !roleAt(j) && !"!?！？".includes(next)) {
        if (next === " " || next === "　") {
          const k = runEnd(j, c => c === " " || c === "　")
          const after = chars[k]
          const replacement = after === undefined || CLOSERS.has(after) || NO_SPACE_BEFORE.has(after) || roleAt(k) ? "" : "　"
          if (chars.slice(j, k).join("") !== replacement) add(j, "exclamation-space", "error", "感嘆符・疑問符のあとは全角スペース1つ。行末・閉じ括弧・約物の前には入れない", edit(j, k, replacement))
        } else {
          add(j, "exclamation-space", "error", "感嘆符・疑問符の直後に全角スペースを1つ入れる", insertAfter(a, j - 1, "　"))
        }
      }
      i = j; continue
    }
    if (/[０-９]/.test(ch)) {
      const j = runEnd(i, c => /[０-９]/.test(c))
      const replacement = chars.slice(i, j).map(c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).join("")
      add(i, "fullwidth-digit", "error", "算用数字は半角にする（全角の「０〜９」は使わない）", edit(i, j, replacement))
      i = j; continue
    }
    if (ch === " " && i > 0 && i + 1 < chars.length && !urlMask[i - 1] && !urlMask[i + 1]) {
      const before = chars[i - 1], after = chars[i + 1]
      if ((JAPANESE.test(before) && ASCII_ALNUM.test(after)) || (ASCII_ALNUM.test(before) && JAPANESE.test(after))) add(i, "ascii-space", "warning", "日本語と英数字のあいだに半角スペースを入れない")
    }
    i++
  }
}

export function excerptAt(chars: string[], column: number): string {
  const start = Math.max(0, column - 8)
  const end = Math.min(chars.length, column + 9)
  const head = start > 0 ? "…" : ""
  const tail = end < chars.length ? "…" : ""
  return (head + chars.slice(start, end).join("") + tail).replace(/　/g, "□")
}

export function countByRule(
  issues: TypographyIssue[],
): Array<{ rule: TypographyRule; severity: TypographySeverity; count: number }> {
  const map = new Map<string, { rule: TypographyRule; severity: TypographySeverity; count: number }>()
  for (const issue of issues) {
    const key = `${issue.severity}:${issue.rule}`
    const entry = map.get(key) ?? { rule: issue.rule, severity: issue.severity, count: 0 }
    entry.count++
    map.set(key, entry)
  }
  return [...map.values()].sort((a, b) =>
    a.severity === b.severity ? b.count - a.count : a.severity === "error" ? -1 : 1,
  )
}

export function formatIssue(issue: TypographyIssue): string {
  const mark = issue.severity === "error" ? "❌" : "⚠️"
  return `${mark} ${issue.line}行${issue.column}字目［${TYPOGRAPHY_RULE_LABELS[issue.rule]}］${issue.message}\n     ${issue.excerpt}`
}

// ============================================================
// 安全な自動整形（fixTypography）
// ============================================================

export interface TypographyFixSummary {
  rule: TypographyRule
  count: number
}

export interface TypographyFixChange {
  /** 1始まりの行番号 */
  line: number
  before: string
  after: string
}

export interface FixTypographyResult {
  text: string
  /** 自動修正した総件数（0 なら変更なし） */
  totalFixes: number
  /** 規則ごとの修正件数（件数の多い順） */
  fixes: TypographyFixSummary[]
  /** 変更された行の前後一覧 */
  changes: TypographyFixChange[]
  /** 未収束なら原文・修正0件を返す。呼び出し側はそのファイルを保存しない。 */
  unconvergedLines: number[]
}

/** 診断が持つ修正案だけを適用する。位置の重なる編集は次の解析で再評価する。 */
export function fixTypography(text: string, opts: { indent?: IndentStyle; maxPasses?: number } = {}): FixTypographyResult {
  const counts = new Map<TypographyRule, number>()
  const changes: TypographyFixChange[] = []
  const unconvergedLines: number[] = []
  const maxPasses = Number.isInteger(opts.maxPasses) && opts.maxPasses! >= 0 ? opts.maxPasses! : 16
  // 区切りも残し、無変更の本文では CRLF を含め文字列を完全に保持する。
  const lines = text.split(/(\r?\n)/)
  for (let part = 0; part < lines.length; part += 2) {
    const before = lines[part]
    let current = before
    const lineCounts = new Map<TypographyRule, number>()
    const seen = new Set<string>([current])
    for (let pass = 0; ; pass++) {
      const chars = [...current]
      const candidates = checkTypography(current, opts).filter((i): i is TypographyIssue & { fix: TypographyEdit } => !!i.fix)
        .filter(i => chars.slice(i.fix.start, i.fix.end).join("") !== i.fix.replacement)
        .sort((a, b) => a.fix.start - b.fix.start || a.fix.end - b.fix.end)
      const edits: typeof candidates = []
      let end = -1
      for (const issue of candidates) {
        if (issue.fix.start < end) continue
        edits.push(issue)
        end = issue.fix.end
      }
      if (edits.length === 0) break
      if (pass >= maxPasses) { unconvergedLines.push(part / 2 + 1); break }
      for (const issue of edits.reverse()) {
        const { start, end, replacement } = issue.fix
        chars.splice(start, end - start, ...replacement)
        lineCounts.set(issue.rule, (lineCounts.get(issue.rule) ?? 0) + 1)
      }
      const next = chars.join("")
      if (seen.has(next)) { unconvergedLines.push(part / 2 + 1); break }
      seen.add(next)
      current = next
    }
    if (current !== before) {
      changes.push({ line: part / 2 + 1, before, after: current })
      for (const [rule, count] of lineCounts) counts.set(rule, (counts.get(rule) ?? 0) + count)
    }
    lines[part] = current
  }
  if (unconvergedLines.length) return { text, fixes: [], totalFixes: 0, changes: [], unconvergedLines }
  const fixes = [...counts].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count)
  return { text: lines.join(""), fixes, totalFixes: fixes.reduce((sum, f) => sum + f.count, 0), changes, unconvergedLines }
}

export function formatFixSummary(fixes: TypographyFixSummary[]): string {
  return fixes.map(({ rule, count }) => `${TYPOGRAPHY_RULE_LABELS[rule]} ${count}`).join("、")
}

/** 変更された行の前後スニペットを最大 maxLines 行まで整形する（□ は全角スペース。最初の差分位置を中心に切り出す） */
export function formatFixChanges(changes: TypographyFixChange[], maxLines = 5): string {
  if (changes.length === 0) return ""
  const maxWidth = 44
  const formatPair = (beforeRaw: string, afterRaw: string): [string, string] => {
    const bChars = [...beforeRaw.replace(/　/g, "□")]
    const aChars = [...afterRaw.replace(/　/g, "□")]
    if (bChars.length <= maxWidth && aChars.length <= maxWidth) {
      return [bChars.join(""), aChars.join("")]
    }
    let diff = 0
    const minLen = Math.min(bChars.length, aChars.length)
    while (diff < minLen && bChars[diff] === aChars[diff]) diff++
    const sliceAround = (chars: string[]): string => {
      if (chars.length <= maxWidth) return chars.join("")
      const lead = 14
      const start = Math.max(0, Math.min(diff - lead, chars.length - maxWidth))
      const end = Math.min(chars.length, start + maxWidth)
      return `${start > 0 ? "…" : ""}${chars.slice(start, end).join("")}${end < chars.length ? "…" : ""}`
    }
    return [sliceAround(bChars), sliceAround(aChars)]
  }
  const lines = changes.slice(0, maxLines).map((c) => {
    const [b, a] = formatPair(c.before, c.after)
    return `  - ${c.line}行目: ${b} → ${a}`
  })
  if (changes.length > maxLines) lines.push(`  …ほか${changes.length - maxLines}行`)
  return lines.join("\n") + "\n"
}
