/**
 * llm-novel-plugin - 文章の点検（ライトノベル・Web小説向け反AIチェッカー）
 *
 * novel-writing skill の「AI くさい言い回しを避ける」のうち、機械で数えられるものを拾う。
 * すべて確認（⚠️）にとどめ、規約違反（❌）にはしない。
 *
 * 見るのは5つ＋話またぎ重複:
 *   - できあいの言い回し（「思わず」「その瞬間」「胸が熱く」「肩をすくめる」など。許容回数は3,000字基準で文字数比例）
 *   - 説教・教訓まとめの定型（「大切なことに気づいた」「絆がさらに深まった」など、AIが勝手に話を道徳的に締める癖）
 *   - 話末の定型締め（末尾3行以内の地の文に出る「……悪くない」「そう思いながら」等の内省・総括締め）
 *   - 同じ文末の連続（「〜た。」が4文以上続く）
 *   - 長い文（1文が80文字を超える。seriousness: "serious" のときは100文字超）
 *   - 話をまたいだ定型仕草の偏り（近い5話・節の中で3話以上かつ計5回以上に出る目立つ仕草）
 *
 * ラノベ・Web小説の一人称語りや軽快なツッコミで自然に使う表現
 * （「つまり」「要するに」「まだ知らなかった」など）は過剰検出しない。
 */

import { analyzeManuscriptLine } from "./text-analysis.js"
import { excerptAt, isSeparatorLine } from "./typography.js"
import { countWords, stripChapterHeading } from "./utils.js"
import type { Seriousness } from "./constants.js"

export type ProseRule =
  | "stock-phrase"
  | "preachy-ending"
  | "closing-cliche"
  | "repeated-ending"
  | "long-sentence"

export const PROSE_RULE_LABELS: Record<ProseRule, string> = {
  "stock-phrase": "できあいの言い回し",
  "preachy-ending": "教訓・まとめ臭い表現",
  "closing-cliche": "話末の定型締め",
  "repeated-ending": "同じ文末の連続",
  "long-sentence": "長い文",
}

export interface ProseIssue {
  /** ファイルの行番号（1から） */
  line: number
  /** 行内の位置（1から。コードポイント単位。元の行での位置） */
  column: number
  rule: ProseRule
  /** できあいの言い回し・教訓表現・話末定型のとき、どの語か */
  phrase?: string
  message: string
  excerpt: string
}

export interface CheckProseOptions {
  /** シリアス度。serious のとき長い文の目安を 100 文字に緩和する */
  seriousness?: Seriousness
}

/** 同じ文末が続いたとみなす文の数 */
export const REPEATED_ENDING_RUN = 4
/** 長い文とみなす文字数（スマホでも読みやすくするため80文字超を拾う） */
export const LONG_SENTENCE_CHARS = 80
/** シリアス重視（serious）のときの長い文の目安 */
export const SERIOUS_LONG_SENTENCE_CHARS = 100
/** 許容回数を比例換算する基準文字数（Web連載の標準1話＝3,000字） */
export const PROSE_DENSITY_BASE_CHARS = 3000
/** 話末の定型締めを見る末尾の非空行数 */
export const CLOSING_TAIL_LINES = 3
/** 話をまたいだ重複を見るウィンドウ幅（話・節数） */
export const CROSS_CHAPTER_WINDOW = 5
/** ウィンドウ内で重複とみなす出現話・節数 */
export const CROSS_CHAPTER_MIN_CHAPTERS = 3
/** ウィンドウ内で重複とみなす合計出現回数（各話1回×3話の通常使用で鳴らないようにする） */
export const CROSS_CHAPTER_MIN_TOTAL = 5

/** シリアス度に応じた1文の文字数上限を返す */
export function longSentenceLimit(seriousness?: Seriousness): number {
  return seriousness === "serious" ? SERIOUS_LONG_SENTENCE_CHARS : LONG_SENTENCE_CHARS
}

/** 本文文字数に応じて許容回数（3,000字基準）を換算する。0回禁止の語は常に 0 */
export function scaledPhraseLimit(allowed: number, bodyChars: number): number {
  if (allowed <= 0) return 0
  return Math.max(allowed, Math.round((allowed * bodyChars) / PROSE_DENSITY_BASE_CHARS))
}

interface PhraseRule {
  rule: "stock-phrase" | "preachy-ending" | "closing-cliche"
  phrase: string
  pattern: RegExp
  /** 3,000字あたり使ってよい回数。超えた分だけ拾う */
  allowed: number
  advice: string
}

const PHRASES: PhraseRule[] = [
  // --- できあいの言い回し（stock-phrase） ---
  {
    rule: "stock-phrase",
    phrase: "思わず",
    pattern: /思わず|ずにはいられな/g,
    allowed: 0,
    advice: "修飾を外し、キャラの具体的な動きや反応をそのまま書く",
  },
  {
    rule: "stock-phrase",
    phrase: "胸が熱く・込み上げる",
    pattern: /胸が熱く|胸の奥が締めつけ|込み上げ|こみ上げ/g,
    allowed: 0,
    advice: "感情のラベルを貼らず、声の調子・行動・語り手の素直な受け止め方で書く",
  },
  {
    rule: "stock-phrase",
    phrase: "その瞬間",
    pattern: /(?:その|次の|この)瞬間/g,
    allowed: 1,
    advice: "戦闘や急展開の要所で3,000字あたり1回まで。普段は接続語を外し、起きた動きを順に並べる",
  },
  {
    rule: "stock-phrase",
    phrase: "まるで・かのよう",
    pattern: /まるで|かのよう/g,
    allowed: 2,
    advice: "型の直喩を続けない。語り手の個性ある例えか、直接描写にする",
  },
  {
    rule: "stock-phrase",
    phrase: "世界が止まった",
    pattern: /世界が止まっ|世界から音が消え|時が止まっ|時間が止まっ/g,
    allowed: 0,
    advice: "大げさな定型をやめ、その場で目に入ったもの・聞こえたものを1つ書く",
  },
  {
    rule: "stock-phrase",
    phrase: "目の奥・瞳の色",
    pattern: /目の奥に|瞳の奥に|瞳に[^。]{0,12}色が(?:浮か|宿|揺)/g,
    allowed: 0,
    advice: "瞳の中の比喩をやめ、視線の動き・表情・間の取り方を場面ごとに描き分ける",
  },
  {
    rule: "stock-phrase",
    phrase: "心の中で呟く",
    pattern: /(?:心の中|心のなか|胸の内|胸のうち|内心)で(?:呟|つぶや)/g,
    allowed: 0,
    advice: "ラベルを外し、地の文のツッコミ・モノローグとしてそのまま書く",
  },
  {
    rule: "stock-phrase",
    phrase: "言葉を失う・息を呑む",
    pattern: /言葉を失|息を呑|息をのん|絶句し/g,
    allowed: 1,
    advice: "3,000字あたり1回まで。あとはリアクションや間（ま）で見せる",
  },
  {
    rule: "stock-phrase",
    phrase: "静寂が支配・空気が張り詰める",
    pattern: /静寂が(?:支配|包|訪)|沈黙が(?:降り|落ち|支配)|空気が張り詰め|空気が張りつめ/g,
    allowed: 0,
    advice: "抽象的な空気描写をやめ、周りの反応や音を書く",
  },
  {
    rule: "stock-phrase",
    phrase: "総括の語",
    pattern: /結論として|言うまでもなく|言うまでもない/g,
    allowed: 0,
    advice: "論文調の総括語を削り、話し言葉の地の文にする",
  },
  {
    rule: "stock-phrase",
    phrase: "〜なのだった",
    pattern: /なのだった|のであった/g,
    allowed: 3,
    advice: "一人称ツッコミ以外で連発しない。素の文末や体言止めを混ぜる",
  },
  {
    rule: "stock-phrase",
    phrase: "できあいの擬音",
    pattern: /ドクンと|ドキリと|ゴクリと|視界が(?:涙で)?滲/g,
    allowed: 0,
    advice: "できあいの擬音フレーズを避け、キャラの反応や具体的な動きで書く",
  },
  {
    rule: "stock-phrase",
    phrase: "煽りの語り",
    pattern: /運命は|それだけではなかった|知る由もなかった/g,
    allowed: 1,
    advice: "大げさなナレーター煽りを控え、次の出来事や台詞で引く",
  },
  {
    rule: "stock-phrase",
    phrase: "硬い漢語調",
    pattern: /を余儀なくされ|を禁じ得な/g,
    allowed: 0,
    advice: "ライトノベル・Web小説らしく平たい口語・自然な表現にする",
  },
  {
    rule: "stock-phrase",
    phrase: "肩をすくめる",
    pattern: /肩をすくめ/g,
    allowed: 1,
    advice: "翻訳調・AI定番の仕草を連発しない。キャラ固有の反応や台詞で書き分ける",
  },
  {
    rule: "stock-phrase",
    phrase: "小さく笑う・苦笑",
    pattern: /小さく笑(?:っ|い|う)|苦笑/g,
    allowed: 1,
    advice: "笑い方の定型を連発しない。表情・声色・視線・返しの台詞で描き分ける",
  },
  {
    rule: "stock-phrase",
    phrase: "〜気がした",
    pattern: /気がした/g,
    allowed: 2,
    advice: "曖昧なぼかし語尾を連発しない。語り手の実感や具体的な観察で言い切る",
  },
  {
    rule: "stock-phrase",
    phrase: "ゆっくりと",
    pattern: /ゆっくりと/g,
    allowed: 3,
    advice: "副詞の連発を避け、動詞そのものやテンポで表現する",
  },
  {
    rule: "stock-phrase",
    phrase: "そっと",
    pattern: /そっと/g,
    allowed: 3,
    advice: "副詞の連発を避け、具体的な仕草に替える",
  },
  {
    rule: "stock-phrase",
    phrase: "静かに",
    pattern: /静かに/g,
    allowed: 3,
    advice: "副詞の連発を避け、キャラの佇まいや反応で書く",
  },

  // --- 教訓・説教まとめの定型（preachy-ending） ---
  {
    rule: "preachy-ending",
    phrase: "大切なこと・学びのまとめ",
    pattern: /大切なこと(?:に気づ|を学ん|を知っ)|大事なこと(?:に気づ|を学ん)|本当の意味(?:に気づ|を知っ|を理解し)/g,
    allowed: 0,
    advice: "AIが勝手に道徳的な教訓でまとめる癖。教訓を語らず、キャラの反応や次へのワクワク・引きで終える",
  },
  {
    rule: "preachy-ending",
    phrase: "絆が深まった・成長を実感",
    pattern: /絆(?:が|は)(?:さらに|いっそう|より)?深まっ|成長を実感し|一歩(?:成長|大人になっ)/g,
    allowed: 0,
    advice: "関係や成長を説明でまとめない。呼び方の変化や軽口、具体的なやり取りで見せる",
  },
  {
    rule: "preachy-ending",
    phrase: "かけがえのない〜",
    pattern: /かけがえのない(?:もの|時間|存在|仲間|日々)/g,
    allowed: 0,
    advice: "できあいの感動まとめ語。具体的な楽しい場面や一言で読者に感じさせる",
  },
]

/** 話末の末尾数行（地の文）だけで見る定型締め */
const CLOSING_CLICHES: PhraseRule[] = [
  {
    rule: "closing-cliche",
    phrase: "「悪くない」締め",
    pattern: /悪くない(?:な|ね|よな|の?かも(?:しれない)?|と思(?:った|う)|気がした|(?:一日|時間|毎日|日々|気分|感じ|もの|はず)(?:だ|だった|かもしれない))?(?=[。！、…]|$)/g,
    allowed: 0,
    advice: "AI定番の「悪くない」締め。内省でまとめず、具体的な動作・台詞・次への引きで切る",
  },
  {
    rule: "closing-cliche",
    phrase: "内省・総括モノローグ締め",
    pattern: /(?:そう思いながら|そんな気がした|そんな予感がした|そんな思いが胸を|これから先も|これからもきっと|これからもずっと|新しい(?:日常|日々|物語)が始ま|確かな手応えを感じ)/g,
    allowed: 0,
    advice: "話末を内省や総括の定型で閉じない。具体的な動作・台詞・余韻のある情景や引きで切る",
  },
]

const OPEN = new Set(["「", "『"])
const CLOSE = new Set(["」", "』"])
const SENTENCE_END = new Set(["。", "！", "？"])

interface Sentence {
  start: number
  text: string
  period: boolean
}

function splitSentences(chars: string[]): { sentences: Sentence[]; inDialogue: boolean[] } {
  const sentences: Sentence[] = []
  const inDialogue: boolean[] = []
  let depth = 0
  let start = 0
  while (chars[start] === "　") start++
  const push = (end: number, period: boolean) => {
    const text = chars.slice(start, end).join("").trim()
    if (text.length > 0) sentences.push({ start, text, period })
  }
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (OPEN.has(ch)) depth++
    inDialogue[i] = depth > 0
    if (CLOSE.has(ch) && depth > 0) depth--
    if (depth === 0 && SENTENCE_END.has(ch)) {
      let j = i
      while (j + 1 < chars.length && SENTENCE_END.has(chars[j + 1])) j++
      push(i, ch === "。" && j === i)
      i = j
      start = j + 1
      while (chars[start] === "　") start++
    }
  }
  push(chars.length, false)
  return { sentences, inDialogue }
}

function endingOf(sentence: Sentence): string | null {
  if (!sentence.period) return null
  const last = [...sentence.text].pop()
  return last && /[ぁ-ん]/.test(last) ? last : null
}

/** 末尾の非空・非見出し・非区切り行のインデックス（最大 CLOSING_TAIL_LINES 件） */
function tailLineIndexSet(lines: string[]): Set<number> {
  const indices: number[] = []
  for (let i = lines.length - 1; i >= 0 && indices.length < CLOSING_TAIL_LINES; i--) {
    const trimmed = lines[i].trim()
    if (trimmed.length === 0 || /^#/.test(trimmed) || isSeparatorLine(lines[i])) continue
    indices.push(i)
  }
  return new Set(indices)
}

/** 本文の文章を点検する */
export function checkProse(text: string, opts: CheckProseOptions = {}): ProseIssue[] {
  const issues: ProseIssue[] = []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const tailLines = tailLineIndexSet(lines)
  const bodyChars = countWords(stripChapterHeading(text))
  const maxSentenceChars = longSentenceLimit(opts.seriousness)
  const phraseHits = new Map<PhraseRule, Array<{ line: number; column: number; excerpt: string; word: string }>>()
  let run: { ending: string; count: number; line: number; column: number; excerpt: string } | null = null
  const flushRun = () => {
    if (run && run.count >= REPEATED_ENDING_RUN) {
      issues.push({
        line: run.line,
        column: run.column,
        rule: "repeated-ending",
        message: `「〜${run.ending}。」で終わる文が${run.count}文続いています（体言止め・現在形・ツッコミ・短い段落を混ぜる）`,
        excerpt: run.excerpt,
      })
    }
    run = null
  }

  lines.forEach((line, i) => {
    if (line.trim().length === 0) return
    const original = [...line]
    const analysis = analyzeManuscriptLine(line)
    const { chars, columns } = analysis
    const at = (column: number) => (column < columns.length ? columns[column] : original.length)
    if (analysis.kind !== "narration") {
      if (isSeparatorLine(line) || /^#/.test(line) || chars.length > 0) flushRun()
      return
    }
    const { sentences, inDialogue } = splitSentences(chars)

    const narration = chars.map((ch, k) => (inDialogue[k] ? "\u0000" : ch)).join("")
    const toIndex = (offset: number) => [...narration.slice(0, offset)].length
    for (const rule of PHRASES) {
      for (const m of narration.matchAll(rule.pattern)) {
        const column = at(toIndex(m.index ?? 0))
        const hits = phraseHits.get(rule) ?? []
        hits.push({ line: i + 1, column: column + 1, excerpt: excerptAt(original, column), word: m[0] })
        phraseHits.set(rule, hits)
      }
    }
    if (tailLines.has(i)) {
      for (const rule of CLOSING_CLICHES) {
        for (const m of narration.matchAll(rule.pattern)) {
          const column = at(toIndex(m.index ?? 0))
          issues.push({
            line: i + 1,
            column: column + 1,
            rule: rule.rule,
            phrase: rule.phrase,
            message: `「${m[0]}」${rule.advice}`,
            excerpt: excerptAt(original, column),
          })
        }
      }
    }

    for (const s of sentences) {
      const column = at(s.start)
      const length = [...s.text].length
      if (length > maxSentenceChars) {
        issues.push({
          line: i + 1,
          column: column + 1,
          rule: "long-sentence",
          message: `1文が${length}文字あります（${maxSentenceChars}文字を超える文は、2〜3文に割るとテンポが出ます）`,
          excerpt: excerptAt(original, column),
        })
      }
      const ending = endingOf(s)
      if (ending && run && run.ending === ending) {
        run.count++
      } else {
        flushRun()
        if (ending) run = { ending, count: 1, line: i + 1, column: column + 1, excerpt: excerptAt(original, column) }
      }
    }
  })
  flushRun()

  for (const [rule, hits] of phraseHits) {
    const allowed = scaledPhraseLimit(rule.allowed, bodyChars)
    if (hits.length <= allowed) continue
    const total = hits.length
    const limit = allowed > 0 ? `この話に${total}回（目安${allowed}回まで）。` : total > 1 ? `この話に${total}回。` : ""
    for (const hit of hits.slice(allowed)) {
      issues.push({
        line: hit.line,
        column: hit.column,
        rule: rule.rule,
        phrase: rule.phrase,
        message: `「${hit.word}」${limit}${rule.advice}`,
        excerpt: hit.excerpt,
      })
    }
  }
  return issues.sort((a, b) => a.line - b.line || a.column - b.column)
}

export function summarizeProse(issues: ProseIssue[]): Array<{ rule: ProseRule; count: number; detail: string }> {
  const order: ProseRule[] = ["stock-phrase", "preachy-ending", "closing-cliche", "repeated-ending", "long-sentence"]
  return order.flatMap((rule) => {
    const of = issues.filter((i) => i.rule === rule)
    if (of.length === 0) return []
    const phrases = new Map<string, number>()
    for (const i of of) if (i.phrase) phrases.set(i.phrase, (phrases.get(i.phrase) ?? 0) + 1)
    const detail = [...phrases].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join("、")
    return [{ rule, count: of.length, detail }]
  })
}

export function formatProseIssue(issue: ProseIssue): string {
  return `⚠️ ${issue.line}行${issue.column}字目［${PROSE_RULE_LABELS[issue.rule]}］${issue.message}\n     ${issue.excerpt}`
}

// ============================================================
// 話をまたいだ繰り返しの抑止・検出（直近話の締め＆定型仕草の偏り）
// ============================================================

interface CrossChapterMotif {
  motif: string
  pattern: RegExp
  advice: string
}

const CROSS_CHAPTER_MOTIFS: CrossChapterMotif[] = [
  { motif: "苦笑・小さく笑う", pattern: /小さく笑(?:っ|い|う)|苦笑/g, advice: "表情・声色・視線・返しの台詞で描き分ける" },
  { motif: "肩をすくめる", pattern: /肩をすくめ/g, advice: "キャラ固有の反応や台詞に変える" },
  { motif: "口元・頬を緩める", pattern: /口元[がを]緩|口角[がを]上|頬[がを]緩/g, advice: "嬉しさや照れの表現を別の行動・口調で見せる" },
  { motif: "目を細める", pattern: /目を細め/g, advice: "視線や表情の描写を場面ごとに変える" },
  { motif: "目を見開く・目を丸くする", pattern: /目を丸く|目を見開/g, advice: "驚きの反応を間・動作・台詞で書き分ける" },
]

export interface ChapterProseInput {
  label: string
  text: string
}

export interface CrossChapterRepeat {
  motif: string
  chapters: string[]
  totalCount: number
  advice: string
}

/** 本文の末尾（非空・非区切り行の最後 maxLines 行）を短く抜き出す */
export function extractChapterEnding(text: string, maxLines = 2, maxChars = 120): string {
  const body = stripChapterHeading(text).replace(/\r\n/g, "\n")
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isSeparatorLine(l))
  if (lines.length === 0) return ""
  const joined = lines.slice(-maxLines).join(" ／ ")
  const chars = [...joined]
  if (chars.length <= maxChars) return joined
  return `…${chars.slice(-(maxChars - 1)).join("")}`
}

/** 地の文（会話外）だけを抜き出す */
function extractNarrationOnly(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const analysis = analyzeManuscriptLine(line)
    if (analysis.kind !== "narration") continue
    const { inDialogue } = splitSentences(analysis.chars)
    out.push(analysis.chars.map((ch, k) => (inDialogue[k] ? "\u0000" : ch)).join(""))
  }
  return out.join("\n")
}

function countMotifMatches(narration: string, pattern: RegExp): number {
  let count = 0
  for (const _ of narration.matchAll(pattern)) count++
  return count
}

/**
 * 複数話・節にわたって連続・頻出している定型仕草を拾う。
 *
 * - targetIndex を渡したとき: その話を含む直近 window 話を見て、targetIndex 自身にも出ており
 *   minChapters 話以上 かつ 合計 minTotal 回以上の重複だけを返す
 * - targetIndex を省いたとき: window 話のスライド窓で minChapters 話以上 かつ 合計 minTotal 回以上出たものを返す
 */
export function findCrossChapterRepeats(
  chapters: ChapterProseInput[],
  opts: { window?: number; minChapters?: number; minTotal?: number; targetIndex?: number } = {},
): CrossChapterRepeat[] {
  const windowSize = opts.window ?? CROSS_CHAPTER_WINDOW
  const minChapters = opts.minChapters ?? CROSS_CHAPTER_MIN_CHAPTERS
  const minTotal = opts.minTotal ?? CROSS_CHAPTER_MIN_TOTAL
  if (chapters.length < minChapters) return []

  const narrations = chapters.map((c) => extractNarrationOnly(c.text))
  const results: CrossChapterRepeat[] = []

  for (const m of CROSS_CHAPTER_MOTIFS) {
    const counts = narrations.map((n) => countMotifMatches(n, m.pattern))
    if (opts.targetIndex !== undefined) {
      const idx = opts.targetIndex
      if (idx < 0 || idx >= chapters.length || counts[idx] === 0) continue
      const start = Math.max(0, idx - windowSize + 1)
      const matchedLabels: string[] = []
      let total = 0
      for (let i = start; i <= idx; i++) {
        if (counts[i] > 0) {
          matchedLabels.push(chapters[i].label)
          total += counts[i]
        }
      }
      if (matchedLabels.length >= minChapters && total >= minTotal) {
        results.push({ motif: m.motif, chapters: matchedLabels, totalCount: total, advice: m.advice })
      }
      continue
    }

    let best: { labels: string[]; total: number } | null = null
    const lastStart = Math.max(0, chapters.length - windowSize)
    for (let start = 0; start <= lastStart; start++) {
      const end = Math.min(chapters.length, start + windowSize)
      const matchedLabels: string[] = []
      let total = 0
      for (let i = start; i < end; i++) {
        if (counts[i] > 0) {
          matchedLabels.push(chapters[i].label)
          total += counts[i]
        }
      }
      if (matchedLabels.length < minChapters || total < minTotal) continue
      // 出現話数が多い窓、同率なら計回数が多い窓、さらに同率ならより新しい窓を優先
      if (
        !best ||
        matchedLabels.length > best.labels.length ||
        (matchedLabels.length === best.labels.length && total >= best.total)
      ) {
        best = { labels: matchedLabels, total }
      }
    }
    if (best) {
      results.push({ motif: m.motif, chapters: best.labels, totalCount: best.total, advice: m.advice })
    }
  }

  return results.sort((a, b) => b.chapters.length - a.chapters.length || b.totalCount - a.totalCount)
}

export function formatCrossChapterRepeat(repeat: CrossChapterRepeat): string {
  return `⚠️ 「${repeat.motif}」が近い範囲の ${repeat.chapters.join("・")}（計${repeat.totalCount}回）に重なっています。${repeat.advice}`
}
