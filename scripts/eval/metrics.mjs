/**
 * 半自動評価ランナーの機械指標集計モジュール
 *
 * 新旧の比較で採点基準がずれないよう、常に最新リポジトリの dist/core/* と
 * dist/tools/status.js を使って統一的に機械指標を集計する。
 * - 規則別の文章 ⚠️ 密度（特に stock-phrase）を個別に算出
 * - 文体見本とのズレは打ち消し合いを防ぐため「絶対値の平均」を主指標として算出
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { checkTypography } from "../../dist/core/typography.js"
import { checkProse, findCrossChapterRepeats } from "../../dist/core/prose.js"
import {
  extractStyleSample,
  analyzeStyleMetrics,
  compareStyleMetrics,
} from "../../dist/core/style-metrics.js"
import {
  countWords,
  stripChapterHeading,
  indentStyleOf,
  seriousnessOf,
  chapterFileName,
} from "../../dist/core/utils.js"
import { readGlossaryCheck } from "../../dist/core/glossary.js"
import { DEFAULTS, CHAPTER_WORD_TOLERANCE } from "../../dist/core/constants.js"
import { novelStatusExecute } from "../../dist/tools/status.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(__dirname, "..", "..")

export const PROSE_METRIC_RULES = [
  "stock-phrase",
  "preachy-ending",
  "closing-cliche",
  "repeated-ending",
  "long-sentence",
  "cross-chapter-repeat",
]

function readJsonIfExists(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

/** 1 試行（1 プロジェクトディレクトリ）の機械指標を集計する */
export async function collectProjectMetrics(projectDir, chapters = [1, 2, 3]) {
  const config = readJsonIfExists(join(projectDir, ".novel", "config.json"))
  const indent = indentStyleOf(config)
  const seriousness = seriousnessOf(config)
  const targetWords = Number(config?.targetWords ?? DEFAULTS.targetWords)
  const chapterCount = Math.max(1, Number(config?.chapterCount ?? DEFAULTS.chapterCount))
  const targetPerChapter = Math.round(targetWords / chapterCount)
  const minAllowed = Math.round(targetPerChapter * (1 - CHAPTER_WORD_TOLERANCE))
  const maxAllowed = Math.round(targetPerChapter * (1 + CHAPTER_WORD_TOLERANCE))
  const glossary = await readGlossaryCheck(projectDir)

  const chapterMetrics = []
  const chapterTexts = []
  let totalBodyChars = 0
  let typographyErrors = 0
  let typographyWarnings = 0
  let proseWarningsSingle = 0
  let missingChapters = 0
  let outOfRangeChapters = 0
  let sumAbsWordDeviationPct = 0
  const proseByRule = Object.fromEntries(PROSE_METRIC_RULES.map((r) => [r, 0]))
  const typographyByRule = {}

  for (const ch of chapters) {
    const filePath = join(projectDir, ".novel", "chapters", chapterFileName(ch))
    if (!existsSync(filePath)) {
      chapterMetrics.push({
        chapter: ch,
        missing: true,
        words: 0,
        targetWords: targetPerChapter,
        deviationPct: -100,
        withinTolerance: false,
        typographyErrors: 0,
        typographyWarnings: 0,
        proseWarnings: 0,
      })
      missingChapters++
      outOfRangeChapters++
      sumAbsWordDeviationPct += 100
      continue
    }

    const raw = readFileSync(filePath, "utf-8")
    const body = stripChapterHeading(raw)
    const words = countWords(body)
    const deviationPct = targetPerChapter > 0 ? ((words - targetPerChapter) / targetPerChapter) * 100 : 0
    const withinTolerance = words >= minAllowed && words <= maxAllowed

    const typoIssues = checkTypography(raw, { indent, glossary })
    const chTypoErrors = typoIssues.filter((i) => i.severity === "error").length
    const chTypoWarnings = typoIssues.length - chTypoErrors
    for (const issue of typoIssues) {
      typographyByRule[issue.rule] = (typographyByRule[issue.rule] ?? 0) + 1
    }

    const proseIssues = checkProse(raw, { seriousness })
    for (const issue of proseIssues) {
      proseByRule[issue.rule] = (proseByRule[issue.rule] ?? 0) + 1
    }

    totalBodyChars += words
    typographyErrors += chTypoErrors
    typographyWarnings += chTypoWarnings
    proseWarningsSingle += proseIssues.length
    if (!withinTolerance) outOfRangeChapters++
    sumAbsWordDeviationPct += Math.abs(deviationPct)

    chapterTexts.push({ label: `第${ch}話`, text: raw })
    chapterMetrics.push({
      chapter: ch,
      missing: false,
      words,
      targetWords: targetPerChapter,
      deviationPct: Number(deviationPct.toFixed(1)),
      withinTolerance,
      typographyErrors: chTypoErrors,
      typographyWarnings: chTypoWarnings,
      proseWarnings: proseIssues.length,
    })
  }

  const crossRepeats = findCrossChapterRepeats(chapterTexts)
  proseByRule["cross-chapter-repeat"] = crossRepeats.length
  const proseWarningsTotal = proseWarningsSingle + crossRepeats.length
  const per1k = (count) => (totalBodyChars > 0 ? Number(((count / totalBodyChars) * 1000).toFixed(3)) : 0)
  const proseWarningsPer1kChars = per1k(proseWarningsTotal)
  const proseByRulePer1kChars = Object.fromEntries(
    PROSE_METRIC_RULES.map((rule) => [rule, per1k(proseByRule[rule] ?? 0)]),
  )
  const meanAbsWordDeviationPct =
    chapters.length > 0 ? Number((sumAbsWordDeviationPct / chapters.length).toFixed(1)) : 0

  // 文体見本との比較（全対象話を連結して比較）
  const conceptPath = join(projectDir, ".novel", "concept.md")
  const conceptMd = existsSync(conceptPath) ? readFileSync(conceptPath, "utf-8") : ""
  const sampleText = extractStyleSample(conceptMd)
  let styleDrift = null
  if (sampleText && chapterTexts.length > 0) {
    const sampleMetrics = analyzeStyleMetrics(sampleText)
    const combinedBody = chapterTexts.map((c) => stripChapterHeading(c.text)).join("\n\n")
    const actualMetrics = analyzeStyleMetrics(combinedBody)
    styleDrift = compareStyleMetrics(sampleMetrics, actualMetrics)
  }

  // 記録の完全性（novel_status の ⚠️ を確認）
  const statusReport = await novelStatusExecute({ detailed: false }, { projectDir })
  const statusWarningLines = statusReport
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("⚠️"))

  return {
    projectDir,
    chapters: chapterMetrics,
    totalBodyChars,
    targetPerChapter,
    meanAbsWordDeviationPct,
    missingChapters,
    outOfRangeChapters,
    typographyErrors,
    typographyWarnings,
    typographyByRule,
    proseWarningsSingle,
    crossChapterRepeats: crossRepeats.length,
    proseWarningsTotal,
    proseWarningsPer1kChars,
    proseByRule,
    proseByRulePer1kChars,
    styleDrift,
    statusWarningsCount: statusWarningLines.length,
    statusWarningLines,
  }
}

function avg(nums) {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

/** 複数試行（run-1〜run-N）の機械指標を集約する */
export function aggregateRunsMetrics(runMetricsList) {
  const emptyRuleDensity = Object.fromEntries(PROSE_METRIC_RULES.map((r) => [r, 0]))
  if (runMetricsList.length === 0) {
    return {
      runCount: 0,
      totalBodyCharsAvg: 0,
      meanAbsWordDeviationPctAvg: 0,
      missingChaptersTotal: 0,
      outOfRangeChaptersTotal: 0,
      outOfRangeChaptersAvg: 0,
      typographyErrorsTotal: 0,
      typographyErrorsAvg: 0,
      typographyWarningsAvg: 0,
      proseWarningsTotalAvg: 0,
      proseWarningsPer1kCharsAvg: 0,
      proseWarningsPer1kCharsRange: [0, 0],
      proseByRulePer1kCharsAvg: emptyRuleDensity,
      statusWarningsTotal: 0,
      statusWarningsAvg: 0,
      styleDriftAvg: null,
    }
  }

  const densities = runMetricsList.map((m) => m.proseWarningsPer1kChars)
  const proseByRulePer1kCharsAvg = Object.fromEntries(
    PROSE_METRIC_RULES.map((rule) => [
      rule,
      Number(avg(runMetricsList.map((m) => m.proseByRulePer1kChars?.[rule] ?? 0)).toFixed(3)),
    ]),
  )

  const drifts = runMetricsList.map((m) => m.styleDrift).filter(Boolean)
  // 符号付きの差が試行間で打ち消し合わないよう、絶対値の平均（AbsDelta）を主指標として算出する
  const styleDriftAvg =
    drifts.length > 0
      ? {
          meanSentenceCharsAbsDelta: Number(avg(drifts.map((d) => Math.abs(d.deltas.meanSentenceChars))).toFixed(2)),
          dialogueCharRatioAbsDelta: Number(avg(drifts.map((d) => Math.abs(d.deltas.dialogueCharRatio))).toFixed(4)),
          meanParagraphSentencesAbsDelta: Number(
            avg(drifts.map((d) => Math.abs(d.deltas.meanParagraphSentences))).toFixed(2),
          ),
          pastTaRatioAbsDelta: Number(avg(drifts.map((d) => Math.abs(d.deltas.pastTaRatio))).toFixed(4)),
          signed: {
            meanSentenceCharsDelta: Number(avg(drifts.map((d) => d.deltas.meanSentenceChars)).toFixed(2)),
            dialogueCharRatioDelta: Number(avg(drifts.map((d) => d.deltas.dialogueCharRatio)).toFixed(4)),
            meanParagraphSentencesDelta: Number(avg(drifts.map((d) => d.deltas.meanParagraphSentences)).toFixed(2)),
            pastTaRatioDelta: Number(avg(drifts.map((d) => d.deltas.pastTaRatio)).toFixed(4)),
          },
        }
      : null

  return {
    runCount: runMetricsList.length,
    totalBodyCharsAvg: Math.round(avg(runMetricsList.map((m) => m.totalBodyChars))),
    meanAbsWordDeviationPctAvg: Number(avg(runMetricsList.map((m) => m.meanAbsWordDeviationPct)).toFixed(1)),
    missingChaptersTotal: runMetricsList.reduce((s, m) => s + (m.missingChapters ?? 0), 0),
    outOfRangeChaptersTotal: runMetricsList.reduce((s, m) => s + m.outOfRangeChapters, 0),
    outOfRangeChaptersAvg: Number(avg(runMetricsList.map((m) => m.outOfRangeChapters)).toFixed(2)),
    typographyErrorsTotal: runMetricsList.reduce((s, m) => s + m.typographyErrors, 0),
    typographyErrorsAvg: Number(avg(runMetricsList.map((m) => m.typographyErrors)).toFixed(2)),
    typographyWarningsAvg: Number(avg(runMetricsList.map((m) => m.typographyWarnings)).toFixed(2)),
    proseWarningsTotalAvg: Number(avg(runMetricsList.map((m) => m.proseWarningsTotal)).toFixed(2)),
    proseWarningsPer1kCharsAvg: Number(avg(densities).toFixed(3)),
    proseWarningsPer1kCharsRange: [Math.min(...densities), Math.max(...densities)],
    proseByRulePer1kCharsAvg,
    statusWarningsTotal: runMetricsList.reduce((s, m) => s + m.statusWarningsCount, 0),
    statusWarningsAvg: Number(avg(runMetricsList.map((m) => m.statusWarningsCount)).toFixed(2)),
    styleDriftAvg,
  }
}
