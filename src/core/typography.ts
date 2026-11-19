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

import { parseRubyLine, stripRubyLine } from "./ruby.js"
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

export const TYPOGRAPHY_RULE_LABELS: Record<TypographyRule, string> = {
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

const CLOSERS = new Set(["」", "』", "）", ")", "】", "〕", "〉", "》"])
const FOLLOWING_PUNCTUATION = new Set(["…", "―", "、", "。", "・", "（", "「", "『", "♪"])
const NO_SPACE_BEFORE = new Set(["！", "？", "!", "?", "…", "―", "、", "。", "・"])

const KATAKANA = /[ァ-ヺー]/
const JAPANESE = /[぀-ヿ㐀-鿿豈-﫿々〆ヶ]/
const ASCII_ALNUM = /[A-Za-z0-9]/

const SEPARATOR_LINE = /^[\s　]*[＊*◇◆□■○●※・〜~\-－―]+(?:[\s　]*[＊*◇◆□■○●※・〜~\-－―]+)*[\s　]*$/

/** ステータス画面・心の声・システム通知などの開き括弧。字下げを強制しない */
const BLOCK_OPENERS = new Set(["【", "（", "(", "＜", "<", "〈", "《", "≪", "［", "[", "〔", "｛", "{"])
/** 箇条書き・配信コメント・別視点見出しの記号。字下げを強制しない */
const LINE_MARKERS = new Set(["・", "※", "＊", "*", "◇", "◆", "□", "■", "○", "●", "▽", "▼", "△", "▲", "▶", "▷", "→", "＞", ">"])
/** 「項目：値」の行（ステータス画面・掲示板・チャットログ） */
const LABEL_LINE = /^[^\s　、。！？!?「」『』：:]{1,12}[：:]/u

/** 本文の表記を点検する */
export function checkTypography(
  text: string,
  opts: { indent?: IndentStyle; glossary?: GlossaryCheck } = {},
): TypographyIssue[] {
  const indent: IndentStyle = opts.indent ?? "fullwidth"
  const issues: TypographyIssue[] = []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  lines.forEach((line, i) => {
    if (line.trim().length === 0 || /^#/.test(line)) return
    const original = [...line]
    for (const issue of parseRubyLine(line).issues) {
      issues.push({
        line: i + 1,
        column: issue.column + 1,
        rule: "ruby",
        severity: "error",
        message: issue.message,
        excerpt: excerptAt(original, issue.column),
      })
    }
    const { chars, columns } = stripRubyLine(line)
    checkLine(chars, columns, original, i + 1, issues, indent)
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

function checkLine(
  chars: string[],
  columns: number[],
  original: string[],
  lineNo: number,
  issues: TypographyIssue[],
  indent: IndentStyle,
): void {
  const add = (column: number, rule: TypographyRule, severity: TypographySeverity, message: string) => {
    const at = column < columns.length ? columns[column] : original.length
    issues.push({ line: lineNo, column: at + 1, rule, severity, message, excerpt: excerptAt(original, at) })
  }

  checkIndent(chars, indent, add)

  const stack: Array<{ ch: string; at: number }> = []

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch in OPEN_BRACKETS) {
      stack.push({ ch, at: i })
    } else if (ch in CLOSE_BRACKETS) {
      const top = stack[stack.length - 1]
      if (top && top.ch === CLOSE_BRACKETS[ch]) {
        stack.pop()
      } else {
        add(i, "bracket", "error", `対応する「${CLOSE_BRACKETS[ch]}」の無い「${ch}」です`)
      }
      if (ch === "」" && chars[i - 1] === "。") {
        add(i - 1, "dialogue-period", "error", "会話文末に句点を打たない（「行こう。」→「行こう」）")
      }
    }
  }
  for (const open of stack) {
    add(open.at, "bracket", "error", `「${open.ch}」が行の中で閉じていません（括弧の中では改行しない）`)
  }

  for (let i = 0; i < chars.length; ) {
    const ch = chars[i]

    if (ch === "…" || ch === "―") {
      let j = i
      while (chars[j] === ch) j++
      const run = j - i
      if (run % 2 === 1) {
        if (ch === "…") add(i, "ellipsis", "error", `三点リーダは2つ重ね（……）。偶数個にする（いまは${run}個）`)
        else add(i, "dash", "error", `ダッシュは2つ重ね（――）。偶数個にする（いまは${run}個）`)
      }
      if (chars[j] === "　") {
        add(j, "space-after-ellipsis-dash", "error", `${ch === "…" ? "三点リーダ" : "ダッシュ"}の直後に全角スペースを入れない`)
      }
      i = j
      continue
    }

    if (ch === "‥" || (ch === "・" && chars[i + 1] === "・") || (ch === "." && chars[i + 1] === "." && chars[i + 2] === ".")) {
      add(i, "ellipsis", "error", "三点リーダは「……」を使う（‥、・・・、... は使わない）")
      let j = i
      while (chars[j] === ch) j++
      i = j
      continue
    }

    if (ch === "—" || ch === "─" || ch === "–") {
      add(i, "dash", "error", `ダッシュは「――」（U+2015）を使う（「${ch}」は使わない）`)
      let j = i
      while (chars[j] === ch) j++
      i = j
      continue
    }

    if (ch === "ー" && chars[i + 1] === "ー" && !(i > 0 && KATAKANA.test(chars[i - 1]))) {
      add(i, "dash", "error", "長音符「ー」でダッシュを代用しない（「――」を使う）")
      let j = i
      while (chars[j] === "ー") j++
      i = j
      continue
    }

    if (ch === "!" || ch === "?") {
      add(i, "halfwidth-punctuation", "error", `半角の「${ch}」は使わない（全角「${ch === "!" ? "！" : "？"}」にする）`)
    }

    if (ch === "！" || ch === "？" || ch === "!" || ch === "?") {
      let j = i
      while (chars[j] === "！" || chars[j] === "？" || chars[j] === "!" || chars[j] === "?") j++
      for (let k = i + 1; k < j; k++) {
        if (chars[k] === "!" || chars[k] === "?") {
          add(k, "halfwidth-punctuation", "error", `半角の「${chars[k]}」は使わない（全角「${chars[k] === "!" ? "！" : "？"}」にする）`)
        }
      }
      checkAfterExclamation(chars, j, add)
      i = j
      continue
    }

    if (/[０-９]/.test(ch)) {
      add(i, "fullwidth-digit", "error", "算用数字は半角にする（全角の「０〜９」は使わない）")
      while (/[０-９]/.test(chars[i] ?? "")) i++
      continue
    }

    if (ch === " " && i > 0 && i + 1 < chars.length) {
      const before = chars[i - 1]
      const after = chars[i + 1]
      if ((JAPANESE.test(before) && ASCII_ALNUM.test(after)) || (ASCII_ALNUM.test(before) && JAPANESE.test(after))) {
        add(i, "ascii-space", "warning", "日本語と英数字のあいだに半角スペースを入れない")
      }
    }

    i++
  }
}

function checkAfterExclamation(
  chars: string[],
  j: number,
  add: (column: number, rule: TypographyRule, severity: TypographySeverity, message: string) => void,
): void {
  const next = chars[j]
  if (next === undefined) return
  if (CLOSERS.has(next) || FOLLOWING_PUNCTUATION.has(next)) return
  if (next === "　") {
    let k = j
    while (chars[k] === "　" || chars[k] === " ") k++
    const after = chars[k]
    if (after === undefined) {
      add(j, "exclamation-space", "error", "感嘆符・疑問符のあと、行末には空白を入れない")
    } else if (CLOSERS.has(after)) {
      add(j, "exclamation-space", "error", "閉じ括弧の直前には空白を入れない（「待て！　」→「待て！」）")
    } else if (NO_SPACE_BEFORE.has(after)) {
      add(j, "exclamation-space", "error", `約物が続くときは空白を入れない（「！　${after}」→「！${after}」）`)
    } else if (k - j > 1) {
      add(j, "exclamation-space", "error", "感嘆符・疑問符のあとの空白は全角スペース1つにする")
    }
    return
  }
  if (next === " ") {
    add(j, "exclamation-space", "error", "感嘆符・疑問符のあとは全角スペースにする（半角スペースは使わない）")
    return
  }
  add(j, "exclamation-space", "error", "感嘆符・疑問符の直後に全角スペースを1つ入れる（「本当か？　彼は」）")
}

/** 地の文の行か（会話行・区切りの行・ステータス画面・掲示板・配信コメントの行を除く） */
export function isNarrationLine(chars: string[]): boolean {
  const line = chars.join("")
  if (line.trim().length === 0 || /^#/.test(line) || SEPARATOR_LINE.test(line)) return false
  let n = 0
  while (chars[n] === "　") n++
  const first = chars[n]
  if (first === undefined || first === "「" || first === "『") return false
  if (BLOCK_OPENERS.has(first) || LINE_MARKERS.has(first)) return false
  if (n === 0 && LABEL_LINE.test(line)) return false
  return true
}

export function isSeparatorLine(line: string): boolean {
  return SEPARATOR_LINE.test(line)
}

function checkIndent(
  chars: string[],
  indent: IndentStyle,
  add: (column: number, rule: TypographyRule, severity: TypographySeverity, message: string) => void,
): void {
  const line = chars.join("")
  if (SEPARATOR_LINE.test(line)) return

  let n = 0
  while (chars[n] === "　") n++
  const first = chars[n]

  if (chars[0] === " " || chars[0] === "\t") {
    add(
      0,
      "indent",
      "error",
      indent === "none"
        ? "段落頭に半角スペースやタブを入れない（この作品は字下げなし設定）"
        : "段落頭に半角スペースやタブを使わない（地の文は全角スペース1字下げ）",
    )
    return
  }
  if (first === "「" || first === "『") {
    if (n > 0) add(0, "indent", "error", "会話行（「『で始まる行）は字下げしない")
    return
  }
  if (first === "…" || first === "―") {
    if (n > 0) add(0, "indent", "error", "三点リーダ・ダッシュで始まる行は字下げしない")
    return
  }

  if (indent === "none") {
    // 字下げなし設定（Web小説スタイル）：全角スペースが入っていたら混在防止で警告する
    if (n > 0) {
      add(0, "indent", "warning", "この作品は字下げなし（indent: none）設定です。段落頭の全角スペースを外してそろえます")
    }
    return
  }

  if (n === 0) {
    if (first !== undefined && (BLOCK_OPENERS.has(first) || LINE_MARKERS.has(first))) return
    if (LABEL_LINE.test(line)) return
    add(0, "indent", "error", "地の文の段落頭は全角スペース1字下げ")
  } else if (n > 1) {
    add(0, "indent", "warning", `段落頭の字下げが${n}字あります（1字にする）`)
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

export interface FixTypographyResult {
  text: string
  /** 自動修正した総件数（0 なら変更なし） */
  totalFixes: number
  /** 規則ごとの修正件数（件数の多い順） */
  fixes: TypographyFixSummary[]
}

interface LineToken {
  prefix: string
  char: string
  suffix: string
}

const isPlainToken = (t: LineToken) => t.prefix.length === 0 && t.suffix.length === 0
const plainToken = (char: string): LineToken => ({ prefix: "", char, suffix: "" })
const ALT_DASHES = new Set(["—", "─", "–"])

/**
 * 1行を「表示文字＋元のルビ・傍点マーク」のトークン列へ分解する。
 * ルビ記法の崩れ等で元行と完全一致復元できない場合は null を返し、その行を無修正で保護する。
 */
function tokenizeLine(line: string): LineToken[] | null {
  const original = [...line]
  const { segments } = parseRubyLine(line)
  const tokens: LineToken[] = []
  let cursor = 0

  for (const seg of segments) {
    if (seg.kind === "text") {
      const segChars = [...seg.text]
      for (let k = 0; k < segChars.length; k++) {
        const col = seg.columns[k]
        if (col < cursor) return null
        const prefix = col > cursor ? original.slice(cursor, col).join("") : ""
        tokens.push({ prefix, char: segChars[k], suffix: "" })
        cursor = col + 1
      }
      continue
    }
    if (seg.kind === "ruby") {
      const baseChars = [...seg.base]
      if (baseChars.length === 0 || seg.baseStart < cursor) return null
      const prefix = seg.baseStart > cursor ? original.slice(cursor, seg.baseStart).join("") : ""
      const readingSuffix = `《${seg.reading}》`
      for (let k = 0; k < baseChars.length; k++) {
        tokens.push({
          prefix: k === 0 ? prefix : "",
          char: baseChars[k],
          suffix: k === baseChars.length - 1 ? readingSuffix : "",
        })
      }
      cursor = seg.baseStart + baseChars.length + [...readingSuffix].length
      continue
    }
    const textChars = [...seg.text]
    if (textChars.length === 0 || seg.textStart < cursor) return null
    const openPrefix = original.slice(cursor, seg.textStart).join("")
    const closeSuffix = "》》"
    for (let k = 0; k < textChars.length; k++) {
      tokens.push({
        prefix: k === 0 ? openPrefix : "",
        char: textChars[k],
        suffix: k === textChars.length - 1 ? closeSuffix : "",
      })
    }
    cursor = seg.textStart + textChars.length + 2
  }

  if (cursor !== original.length) return null
  const reconstructed = tokens.map((t) => t.prefix + t.char + t.suffix).join("")
  return reconstructed === line ? tokens : null
}

function fixLine(
  line: string,
  indent: IndentStyle,
  counts: Map<TypographyRule, number>,
): string {
  if (line.trim().length === 0 || /^#/.test(line)) return line
  const tokens = tokenizeLine(line)
  if (!tokens) return line

  const bump = (rule: TypographyRule, n = 1) => {
    counts.set(rule, (counts.get(rule) ?? 0) + n)
  }

  // A. 会話文末の句点（「行こう。」→「行こう」）
  for (let i = tokens.length - 1; i >= 1; i--) {
    if (tokens[i].char === "」" && tokens[i - 1].char === "。" && isPlainToken(tokens[i - 1])) {
      tokens.splice(i - 1, 1)
      bump("dialogue-period")
    }
  }

  // B-1. 代替の三点リーダ（... / ‥ / ・・）と代替ダッシュ（— / ─ / –）を正規化
  for (let i = 0; i < tokens.length; ) {
    const ch = tokens[i].char
    if (
      isPlainToken(tokens[i]) &&
      (ch === "‥" ||
        (ch === "・" && tokens[i + 1]?.char === "・" && isPlainToken(tokens[i + 1])) ||
        (ch === "." &&
          tokens[i + 1]?.char === "." &&
          tokens[i + 2]?.char === "." &&
          isPlainToken(tokens[i + 1]) &&
          isPlainToken(tokens[i + 2])))
    ) {
      let j = i
      while (j < tokens.length && tokens[j].char === ch && isPlainToken(tokens[j])) j++
      const run = j - i
      const targetLen = ch === "‥" ? (run % 2 === 0 ? run : run + 1) : Math.max(2, Math.ceil(run / 3) * 2)
      const replacement = Array.from({ length: targetLen }, () => plainToken("…"))
      tokens.splice(i, run, ...replacement)
      bump("ellipsis")
      i += targetLen
      continue
    }
    if (isPlainToken(tokens[i]) && ALT_DASHES.has(ch)) {
      let j = i
      while (j < tokens.length && tokens[j].char === ch && isPlainToken(tokens[j])) j++
      const run = j - i
      const targetLen = run % 2 === 0 ? run : run + 1
      const replacement = Array.from({ length: targetLen }, () => plainToken("―"))
      tokens.splice(i, run, ...replacement)
      bump("dash")
      i += targetLen
      continue
    }
    i++
  }

  // B-2. 三点リーダ・ダッシュの奇数個を偶数個にそろえる（長音符「ーー」は叫び声の誤変換防止のため対象外）
  // C. 三点リーダ・ダッシュ直後の全角スペースを除去
  for (let i = 0; i < tokens.length; ) {
    const ch = tokens[i].char
    if (ch === "…" || ch === "―") {
      let j = i
      while (j < tokens.length && tokens[j].char === ch) j++
      const run = j - i
      if (run % 2 === 1) {
        tokens.splice(j, 0, plainToken(ch))
        bump(ch === "…" ? "ellipsis" : "dash")
        j++
      }
      if (j < tokens.length && tokens[j].char === "　" && isPlainToken(tokens[j])) {
        let k = j
        while (k < tokens.length && tokens[k].char === "　" && isPlainToken(tokens[k])) k++
        tokens.splice(j, k - j)
        bump("space-after-ellipsis-dash")
      }
      i = j
      continue
    }
    i++
  }

  // D. 半角の ! ? を全角 ！ ？ に統一
  for (const t of tokens) {
    if (t.char === "!") {
      t.char = "！"
      bump("halfwidth-punctuation")
    } else if (t.char === "?") {
      t.char = "？"
      bump("halfwidth-punctuation")
    }
  }

  // E. 感嘆符・疑問符のあとの空白ルールを整形
  for (let i = 0; i < tokens.length; ) {
    const ch = tokens[i].char
    if (ch === "！" || ch === "？") {
      let j = i
      while (j < tokens.length && (tokens[j].char === "！" || tokens[j].char === "？")) j++
      const next = tokens[j]?.char
      if (next !== undefined && !CLOSERS.has(next) && !FOLLOWING_PUNCTUATION.has(next)) {
        if (next === "　" || next === " ") {
          let k = j
          while (k < tokens.length && (tokens[k].char === "　" || tokens[k].char === " ") && isPlainToken(tokens[k])) {
            k++
          }
          const after = tokens[k]?.char
          if (k > j) {
            if (after === undefined || CLOSERS.has(after) || NO_SPACE_BEFORE.has(after)) {
              tokens.splice(j, k - j)
              bump("exclamation-space")
            } else if (!(k - j === 1 && tokens[j].char === "　")) {
              tokens.splice(j, k - j, plainToken("　"))
              bump("exclamation-space")
              j++
            } else {
              j = k
            }
          }
        } else {
          tokens.splice(j, 0, plainToken("　"))
          bump("exclamation-space")
          j++
        }
      }
      i = j
      continue
    }
    i++
  }

  // F. 全角の算用数字（０〜９）を半角へ
  for (let i = 0; i < tokens.length; ) {
    if (/[０-９]/.test(tokens[i].char)) {
      while (i < tokens.length && /[０-９]/.test(tokens[i].char)) {
        tokens[i].char = String.fromCharCode(tokens[i].char.charCodeAt(0) - 0xfee0)
        i++
      }
      bump("fullwidth-digit")
      continue
    }
    i++
  }

  // G. 日本語と英数字のあいだの半角スペースを除去
  for (let i = tokens.length - 2; i >= 1; i--) {
    if (tokens[i].char === " " && isPlainToken(tokens[i])) {
      const before = tokens[i - 1].char
      const after = tokens[i + 1].char
      if ((JAPANESE.test(before) && ASCII_ALNUM.test(after)) || (ASCII_ALNUM.test(before) && JAPANESE.test(after))) {
        tokens.splice(i, 1)
        bump("ascii-space")
      }
    }
  }

  // H. 段落頭の字下げ（indent: fullwidth / none）
  const visibleLine = tokens.map((t) => t.char).join("")
  if (!SEPARATOR_LINE.test(visibleLine)) {
    let leadEnd = 0
    while (
      leadEnd < tokens.length &&
      (tokens[leadEnd].char === "　" || tokens[leadEnd].char === " " || tokens[leadEnd].char === "\t") &&
      isPlainToken(tokens[leadEnd])
    ) {
      leadEnd++
    }
    const restLine = tokens.slice(leadEnd).map((t) => t.char).join("")
    const first = tokens[leadEnd]?.char
    const hasHalfOrTab = tokens.slice(0, leadEnd).some((t) => t.char === " " || t.char === "\t")
    const noIndentLine =
      first === undefined ||
      first === "「" ||
      first === "『" ||
      first === "…" ||
      first === "―" ||
      indent === "none"

    if (noIndentLine) {
      if (leadEnd > 0) {
        tokens.splice(0, leadEnd)
        bump("indent")
      }
    } else {
      const skipIndent = BLOCK_OPENERS.has(first) || LINE_MARKERS.has(first) || LABEL_LINE.test(restLine)
      if (skipIndent) {
        if (hasHalfOrTab || leadEnd > 1) {
          tokens.splice(0, leadEnd)
          bump("indent")
        }
      } else if (hasHalfOrTab || leadEnd === 0 || leadEnd > 1) {
        tokens.splice(0, leadEnd, plainToken("　"))
        bump("indent")
      }
    }
  }

  return tokens.map((t) => t.prefix + t.char + t.suffix).join("")
}

/**
 * 機械的に安全に直せる表記規約違反（会話末の句点・半角!?・感嘆符空白・三点リーダ/ダッシュ・全角数字・字下げ・日英間半角空白）を自動整形する。
 * 括弧の対応崩れ・ルビ記法ミス・長音符「ーー」・用語集の禁止表記は文意に関わるため変更しない。
 */
export function fixTypography(
  text: string,
  opts: { indent?: IndentStyle } = {},
): FixTypographyResult {
  const indent: IndentStyle = opts.indent ?? "fullwidth"
  const counts = new Map<TypographyRule, number>()
  const fixed = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => fixLine(line, indent, counts))
    .join("\n")

  const fixes: TypographyFixSummary[] = [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count)
  const totalFixes = fixes.reduce((sum, f) => sum + f.count, 0)
  return { text: fixed, totalFixes, fixes }
}

export function formatFixSummary(fixes: TypographyFixSummary[]): string {
  return fixes.map(({ rule, count }) => `${TYPOGRAPHY_RULE_LABELS[rule]} ${count}`).join("、")
}
