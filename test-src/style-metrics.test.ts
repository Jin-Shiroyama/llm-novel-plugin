import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  extractStyleSample,
  analyzeStyleMetrics,
  compareStyleMetrics,
  formatStyleDrift,
} from "../src/core/style-metrics.js"
import { CONCEPT_TEMPLATE } from "../src/core/templates.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

describe("文体距離メトリクス（style-metrics）", () => {
  test("extractStyleSample は未記入テンプレートで null を返し、見本2作品の文体見本を正しく抜く", () => {
    assert.equal(extractStyleSample(CONCEPT_TEMPLATE), null)

    const romcomConcept = readFileSync(join(root, "examples/romcom-light/.novel/concept.md"), "utf-8")
    const romcomSample = extractStyleSample(romcomConcept)
    assert.ok(romcomSample && romcomSample.includes("自動販売機"))

    const fantasyConcept = readFileSync(join(root, "examples/fantasy-balanced/.novel/concept.md"), "utf-8")
    const fantasySample = extractStyleSample(fantasyConcept)
    assert.ok(fantasySample && fantasySample.includes("北へ28歩"))

    const romcomMetrics = analyzeStyleMetrics(romcomSample)
    const fantasyMetrics = analyzeStyleMetrics(fantasySample)
    assert.equal(romcomMetrics.lowSample, false)
    assert.equal(fantasyMetrics.lowSample, false)
    assert.ok(romcomMetrics.dialogueLineRatio > 0.3, "ラブコメ見本は会話比率が高めであること")
    assert.ok(fantasyMetrics.meanSentenceChars > 10 && fantasyMetrics.meanSentenceChars < 60)
    const sumEndings =
      romcomMetrics.endingRatios.pastTa +
      romcomMetrics.endingRatios.nonPast +
      romcomMetrics.endingRatios.nominalOrPunct
    assert.ok(Math.abs(sumEndings - 1) < 1e-9, "文末比率の合計が 1 であること")
  })

  test("同一テキスト比較で差分がすべて 0 になり、文体の異なる本文では期待方向の差分が出る", () => {
    const romcomConcept = readFileSync(join(root, "examples/romcom-light/.novel/concept.md"), "utf-8")
    const sampleText = extractStyleSample(romcomConcept)!
    const sampleMetrics = analyzeStyleMetrics(sampleText)

    const same = compareStyleMetrics(sampleMetrics, analyzeStyleMetrics(sampleText))
    assert.equal(same.deltas.meanSentenceChars, 0)
    assert.equal(same.deltas.dialogueCharRatio, 0)
    assert.equal(same.deltas.dialogueLineRatio, 0)
    assert.equal(same.deltas.pastTaRatio, 0)

    const heavyNoDialogue = [
      "# 第1章 重い報告書",
      "",
      `　${"雨が石畳を濡らし続けていた".repeat(8)}。${"風もまた冷たく吹き抜けていた".repeat(3)}。`,
      `　${"遠くの鐘楼から低い音が響いた".repeat(7)}。${"誰もその場を動かなかった".repeat(3)}。`,
      "　長い夜が静かに明けていった。",
    ].join("\n")
    const heavyMetrics = analyzeStyleMetrics(heavyNoDialogue)
    const drift = compareStyleMetrics(sampleMetrics, heavyMetrics)

    assert.equal(heavyMetrics.dialogueLineCount, 0)
    assert.equal(heavyMetrics.dialogueCharRatio, 0)
    assert.ok(drift.deltas.meanSentenceChars > 20, "1文平均が大きく伸びる方向に出ること")
    assert.ok(drift.deltas.over80SentenceRatio > 0.2, "80字超比率が増えること")
    assert.ok(drift.deltas.dialogueCharRatio < -0.2, "会話比率が下がること")
    assert.ok(drift.deltas.pastTaRatio > 0, "過去形比率が上がること")

    const formatted = formatStyleDrift(drift)
    assert.ok(formatted.includes("1文平均"))
    assert.ok(formatted.includes("会話比率"))
    assert.ok(formatted.includes("文末比率"))
  })

  test("地の文が 5 文未満の短い見本では lowSample フラグが立つ", () => {
    const shortSample = "　朝の風が冷たい。\n「おはよう」\n　俺は手を振った。"
    const metrics = analyzeStyleMetrics(shortSample)
    assert.equal(metrics.narrationSentenceCount, 2)
    assert.equal(metrics.lowSample, true)
    const drift = compareStyleMetrics(metrics, metrics)
    assert.equal(drift.lowSampleWarning, true)
    assert.ok(formatStyleDrift(drift).includes("参考値"))
  })
})
