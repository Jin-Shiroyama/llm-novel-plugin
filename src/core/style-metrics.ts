/**
 * llm-novel-plugin - 文体距離メトリクス（文体見本と本文の数値比較）
 *
 * 文体見本は 200〜600 字（十数文程度）と短いため、高次分位点や標準偏差ではなく
 * 少ないサンプルでも安定しやすい「平均」と「比率」に絞って算出する。
 */

import { analyzeManuscriptLine } from "./text-analysis.js"
import { splitSentences, LONG_SENTENCE_CHARS } from "./prose.js"
import { countWords, stripChapterHeading } from "./utils.js"

/** サンプル文数がこの値未満のときは参考値扱い（lowSample: true）とする */
export const MIN_STABLE_SENTENCES = 5

export interface EndingRatios {
  /** 過去形・タ止め（「〜た。」「〜だ。」）の比率 */
  pastTa: number
  /** 現在形・その他ひらがな述語（「〜る。」「〜い。」等）の比率 */
  nonPast: number
  /** 体言止め・記号終わり（「！」「？」・句点なし等）の比率 */
  nominalOrPunct: number
}

export interface StyleMetrics {
  /** 本文総文字数（見出し・空白除く） */
  totalChars: number
  /** 地の文の文数 */
  narrationSentenceCount: number
  /** 地の文の段落（非空行）数 */
  narrationParagraphCount: number
  /** 会話行数 */
  dialogueLineCount: number
  /** 地の文の文数が MIN_STABLE_SENTENCES 未満のとき true */
  lowSample: boolean
  /** 地の文の 1 文あたり平均文字数 */
  meanSentenceChars: number
  /** 地の文のうち 80 文字を超える文の割合 */
  over80SentenceRatio: number
  /** 会話行の文字数比率（会話文字数 / (会話文字数 + 地の文文字数)） */
  dialogueCharRatio: number
  /** 会話行の行数比率（会話行数 / (会話行数 + 地の文行数)） */
  dialogueLineRatio: number
  /** 地の文 1 段落（1 非空行）あたりの平均文数 */
  meanParagraphSentences: number
  /** 地の文 1 段落（1 非空行）あたりの平均文字数 */
  meanParagraphChars: number
  /** 地の文のうち 1 文だけで構成される段落（単文段落）の割合 */
  singleSentenceParagraphRatio: number
  /** 地の文の文末構成比 */
  endingRatios: EndingRatios
}

export interface StyleDriftDeltas {
  meanSentenceChars: number
  over80SentenceRatio: number
  dialogueCharRatio: number
  dialogueLineRatio: number
  meanParagraphSentences: number
  meanParagraphChars: number
  singleSentenceParagraphRatio: number
  pastTaRatio: number
  nonPastRatio: number
  nominalOrPunctRatio: number
}

export interface StyleDriftReport {
  sample: StyleMetrics
  actual: StyleMetrics
  lowSampleWarning: boolean
  deltas: StyleDriftDeltas
}

/** 企画書（concept.md）の「### 文体見本」節から見本本文を抜き出す（未記入なら null） */
export function extractStyleSample(conceptMd: string): string | null {
  const lines = conceptMd.replace(/\r\n/g, "\n").split("\n")
  let collecting = false
  const collected: string[] = []
  for (const line of lines) {
    if (/^###\s+文体見本/.test(line)) {
      collecting = true
      continue
    }
    if (collecting && /^#{1,3}\s+/.test(line)) break
    if (collecting) collected.push(line)
  }
  if (collected.length === 0) return null

  // 先頭側の案内引用行（> ...）と空行をスキップ
  let start = 0
  while (start < collected.length) {
    const trimmed = collected[start].trim()
    if (trimmed.length === 0 || trimmed.startsWith(">")) {
      start++
      continue
    }
    break
  }
  const body = collected.slice(start).join("\n").replace(/^\n+|\n+$/g, "")
  return body.length > 0 ? body : null
}

function nonSpaceLength(chars: string[]): number {
  let count = 0
  for (const ch of chars) {
    if (!/[\s　]/.test(ch)) count++
  }
  return count
}

/** 本文（または文体見本）の文体メトリクスを算出する */
export function analyzeStyleMetrics(text: string): StyleMetrics {
  const body = stripChapterHeading(text).replace(/\r\n/g, "\n")
  const totalChars = countWords(body)
  const lines = body.split("\n")

  let dialogueLineCount = 0
  let dialogueChars = 0
  let narrationParagraphCount = 0
  let narrationChars = 0
  let narrationSentenceCount = 0
  let narrationSentenceCharTotal = 0
  let over80Sentences = 0
  let singleSentenceParagraphs = 0
  let pastTaCount = 0
  let nonPastCount = 0
  let nominalOrPunctCount = 0

  for (const line of lines) {
    if (line.trim().length === 0) continue
    const analysis = analyzeManuscriptLine(line)
    if (analysis.kind === "dialogue") {
      dialogueLineCount++
      dialogueChars += nonSpaceLength(analysis.chars)
      continue
    }
    if (analysis.kind !== "narration") continue

    narrationParagraphCount++
    narrationChars += nonSpaceLength(analysis.chars)
    const { sentences } = splitSentences(analysis.chars)
    if (sentences.length === 1) singleSentenceParagraphs++
    for (const s of sentences) {
      narrationSentenceCount++
      const len = [...s.text].length
      narrationSentenceCharTotal += len
      if (len > LONG_SENTENCE_CHARS) over80Sentences++

      if (s.period) {
        const last = [...s.text].pop() ?? ""
        if (last === "た" || last === "だ") {
          pastTaCount++
        } else if (/[ぁ-ん]/.test(last)) {
          nonPastCount++
        } else {
          nominalOrPunctCount++
        }
      } else {
        nominalOrPunctCount++
      }
    }
  }

  const ratio = (num: number, den: number) => (den > 0 ? num / den : 0)
  const proseCharsTotal = dialogueChars + narrationChars
  const proseLinesTotal = dialogueLineCount + narrationParagraphCount

  return {
    totalChars,
    narrationSentenceCount,
    narrationParagraphCount,
    dialogueLineCount,
    lowSample: narrationSentenceCount < MIN_STABLE_SENTENCES,
    meanSentenceChars: ratio(narrationSentenceCharTotal, narrationSentenceCount),
    over80SentenceRatio: ratio(over80Sentences, narrationSentenceCount),
    dialogueCharRatio: ratio(dialogueChars, proseCharsTotal),
    dialogueLineRatio: ratio(dialogueLineCount, proseLinesTotal),
    meanParagraphSentences: ratio(narrationSentenceCount, narrationParagraphCount),
    meanParagraphChars: ratio(narrationChars, narrationParagraphCount),
    singleSentenceParagraphRatio: ratio(singleSentenceParagraphs, narrationParagraphCount),
    endingRatios: {
      pastTa: ratio(pastTaCount, narrationSentenceCount),
      nonPast: ratio(nonPastCount, narrationSentenceCount),
      nominalOrPunct: ratio(nominalOrPunctCount, narrationSentenceCount),
    },
  }
}

/** 文体見本と実本文のメトリクス差分を算出する */
export function compareStyleMetrics(sample: StyleMetrics, actual: StyleMetrics): StyleDriftReport {
  return {
    sample,
    actual,
    lowSampleWarning: sample.lowSample || actual.lowSample,
    deltas: {
      meanSentenceChars: actual.meanSentenceChars - sample.meanSentenceChars,
      over80SentenceRatio: actual.over80SentenceRatio - sample.over80SentenceRatio,
      dialogueCharRatio: actual.dialogueCharRatio - sample.dialogueCharRatio,
      dialogueLineRatio: actual.dialogueLineRatio - sample.dialogueLineRatio,
      meanParagraphSentences: actual.meanParagraphSentences - sample.meanParagraphSentences,
      meanParagraphChars: actual.meanParagraphChars - sample.meanParagraphChars,
      singleSentenceParagraphRatio: actual.singleSentenceParagraphRatio - sample.singleSentenceParagraphRatio,
      pastTaRatio: actual.endingRatios.pastTa - sample.endingRatios.pastTa,
      nonPastRatio: actual.endingRatios.nonPast - sample.endingRatios.nonPast,
      nominalOrPunctRatio: actual.endingRatios.nominalOrPunct - sample.endingRatios.nominalOrPunct,
    },
  }
}

function signed(value: number, digits = 1): string {
  const fixed = value.toFixed(digits)
  return value > 0 ? `+${fixed}` : fixed
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function signedPct(value: number): string {
  const v = value * 100
  const fixed = v.toFixed(1)
  return `${v > 0 ? "+" : ""}${fixed}pt`
}

/** 文体比較レポートを短いテキストへ整形する */
export function formatStyleDrift(report: StyleDriftReport): string {
  const { sample, actual, deltas, lowSampleWarning } = report
  const lines = [
    `文体見本との比較${lowSampleWarning ? "（⚠️ 地の文の文数が少なく参考値）" : ""}:`,
    `- 1文平均: 見本 ${sample.meanSentenceChars.toFixed(1)}字 → 本文 ${actual.meanSentenceChars.toFixed(1)}字（${signed(deltas.meanSentenceChars)}字）／80字超 ${pct(sample.over80SentenceRatio)} → ${pct(actual.over80SentenceRatio)}（${signedPct(deltas.over80SentenceRatio)}）`,
    `- 会話比率: 文字 ${pct(sample.dialogueCharRatio)} → ${pct(actual.dialogueCharRatio)}（${signedPct(deltas.dialogueCharRatio)}）／行 ${pct(sample.dialogueLineRatio)} → ${pct(actual.dialogueLineRatio)}（${signedPct(deltas.dialogueLineRatio)}）`,
    `- 段落長: 平均 ${sample.meanParagraphSentences.toFixed(2)}文・${sample.meanParagraphChars.toFixed(1)}字 → ${actual.meanParagraphSentences.toFixed(2)}文・${actual.meanParagraphChars.toFixed(1)}字（単文段落率 ${pct(sample.singleSentenceParagraphRatio)} → ${pct(actual.singleSentenceParagraphRatio)}）`,
    `- 文末比率: 過去(た/だ) ${pct(sample.endingRatios.pastTa)} → ${pct(actual.endingRatios.pastTa)}（${signedPct(deltas.pastTaRatio)}）／非過去 ${pct(sample.endingRatios.nonPast)} → ${pct(actual.endingRatios.nonPast)}／体言・記号 ${pct(sample.endingRatios.nominalOrPunct)} → ${pct(actual.endingRatios.nominalOrPunct)}`,
  ]
  return lines.join("\n")
}
