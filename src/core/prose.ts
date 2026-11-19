/**
 * llm-novel-plugin - 文章の点検（ライトノベル・Web小説向け反AIチェッカー）
 *
 * novel-writing skill の「AI くさい言い回しを避ける」のうち、機械で数えられるものを拾う。
 * すべて確認（⚠️）にとどめ、規約違反（❌）にはしない。
 *
 * 見るのは4つ:
 *   - できあいの言い回し（「思わず」「その瞬間」「胸が熱く」など）
 *   - 説教・教訓まとめの定型（「大切なことに気づいた」「絆がさらに深まった」など、AIが勝手に話を道徳的に締める癖）
 *   - 同じ文末の連続（「〜た。」が4文以上続く）
 *   - 長い文（1文が80文字を超える）
 *
 * ラノベ・Web小説の一人称語りや軽快なツッコミで自然に使う表現
 * （「つまり」「要するに」「まだ知らなかった」など）は過剰検出しない。
 */

import { stripRubyLine } from "./ruby.js"
import { excerptAt, isNarrationLine, isSeparatorLine } from "./typography.js"

export type ProseRule = "stock-phrase" | "preachy-ending" | "repeated-ending" | "long-sentence"

export const PROSE_RULE_LABELS: Record<ProseRule, string> = {
  "stock-phrase": "できあいの言い回し",
  "preachy-ending": "教訓・まとめ臭い表現",
  "repeated-ending": "同じ文末の連続",
  "long-sentence": "長い文",
}

export interface ProseIssue {
  /** ファイルの行番号（1から） */
  line: number
  /** 行内の位置（1から。コードポイント単位。元の行での位置） */
  column: number
  rule: ProseRule
  /** できあいの言い回し・教訓表現のとき、どの語か */
  phrase?: string
  message: string
  excerpt: string
}

/** 同じ文末が続いたとみなす文の数 */
export const REPEATED_ENDING_RUN = 4
/** 長い文とみなす文字数（スマホでも読みやすくするため80文字超を拾う） */
export const LONG_SENTENCE_CHARS = 80

interface PhraseRule {
  rule: "stock-phrase" | "preachy-ending"
  phrase: string
  pattern: RegExp
  /** 1話の中で使ってよい回数。超えた分だけ拾う */
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
    advice: "戦闘や急展開の要所で1話1回まで。普段は接続語を外し、起きた動きを順に並べる",
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
    advice: "1話1回まで。あとはリアクションや間（ま）で見せる",
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

/** 本文の文章を点検する */
export function checkProse(text: string): ProseIssue[] {
  const issues: ProseIssue[] = []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
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
    const { chars, columns } = stripRubyLine(line)
    const at = (column: number) => (column < columns.length ? columns[column] : original.length)
    if (!isNarrationLine(chars)) {
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

    for (const s of sentences) {
      const column = at(s.start)
      const length = [...s.text].length
      if (length > LONG_SENTENCE_CHARS) {
        issues.push({
          line: i + 1,
          column: column + 1,
          rule: "long-sentence",
          message: `1文が${length}文字あります（${LONG_SENTENCE_CHARS}文字を超える文は、2〜3文に割るとテンポが出ます）`,
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
    if (hits.length <= rule.allowed) continue
    const total = hits.length
    const limit = rule.allowed > 0 ? `この話に${total}回（${rule.allowed}回まで）。` : total > 1 ? `この話に${total}回。` : ""
    for (const hit of hits.slice(rule.allowed)) {
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
  const order: ProseRule[] = ["stock-phrase", "preachy-ending", "repeated-ending", "long-sentence"]
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
