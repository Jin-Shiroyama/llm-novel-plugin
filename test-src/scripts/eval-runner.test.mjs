import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BudgetExceededError,
  BudgetTracker,
  buildChatRequestBody,
  callChatCompletion,
  parseExtraBodyOption,
  parseTemperatureOption,
} from "../../scripts/eval/llm-client.mjs"
import {
  NO_BAN_LIST_PRINCIPLE,
  checkDistFreshness,
  computeDirectoryFingerprint,
  loadPluginFromRoot,
  transformNovelWritingSkillNoBanList,
} from "../../scripts/eval/plugin-loader.mjs"
import {
  RUNNER_OVERRIDE_INSTRUCTION,
  buildWriterSystemPrompt,
  createDryRunLlmClient,
  executeChapterStep,
  parseRecordUpdateJson,
  parseWriterOutput,
} from "../../scripts/eval/writer-harness.mjs"
import { aggregateRunsMetrics } from "../../scripts/eval/metrics.mjs"
import {
  checkRunCompatibility,
  computeFalsePositiveRate,
  evaluateDecision,
  judgePairSwapped,
  resolveSwappedVote,
  summarizePairJudgments,
} from "../../scripts/eval/judge.mjs"
import { compareCommand, metricsCommand, parseCliArgs, runCommand } from "../../scripts/eval-runner.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

function makeTempDir(prefix = "llm-novel-eval-test-") {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe("評価ランナー: llm-client（temperature omit / extra-body / 予算ガード）", () => {
  test("buildChatRequestBody は temperature: omit でキーを省き、extraBody をマージする", () => {
    const omitted = buildChatRequestBody({
      model: "o3-mini",
      messages: [{ role: "user", content: "hello" }],
      temperature: parseTemperatureOption("omit", 0.75),
      extraBody: parseExtraBodyOption('{"max_completion_tokens": 4096, "reasoning_effort": "low"}'),
    })
    assert.equal("temperature" in omitted, false)
    assert.equal("max_tokens" in omitted, false)
    assert.equal(omitted.max_completion_tokens, 4096)
    assert.equal(omitted.reasoning_effort, "low")

    const withTemp = buildChatRequestBody({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "hi" }],
      temperature: parseTemperatureOption("0.6", 0.75),
      maxTokens: 2048,
    })
    assert.equal(withTemp.temperature, 0.6)
    assert.equal(withTemp.max_tokens, 2048)
  })

  test("BudgetTracker は呼び出し回数・トークン・コスト上限で BudgetExceededError を投げる", () => {
    const byCalls = new BudgetTracker({ maxCalls: 2 })
    byCalls.assertCanCall("c1")
    byCalls.record({ label: "c1", promptTokens: 100, completionTokens: 50, model: "m-1" })
    byCalls.assertCanCall("c2")
    byCalls.record({ label: "c2", promptTokens: 100, completionTokens: 50, model: "m-1" })
    assert.throws(() => byCalls.assertCanCall("c3"), BudgetExceededError)
    assert.deepEqual(byCalls.summary().responseModels, ["m-1"])

    const byCost = new BudgetTracker({
      maxCalls: 10,
      maxCostUsd: 0.01,
      inputPricePer1M: 5,
      outputPricePer1M: 15,
    })
    byCost.record({ label: "big", promptTokens: 1000, completionTokens: 1000 })
    // 1000*5/1e6 + 1000*15/1e6 = 0.02 > 0.01
    assert.throws(() => byCost.assertCanCall("next"), BudgetExceededError)
  })

  test("callChatCompletion は 429・503・通信エラーを再試行して予算計上し、失敗呼出を responseModels へ混ぜない", async () => {
    const budget = new BudgetTracker({ maxCalls: 10 })
    const sleeps = []
    let calls = 0
    const mockFetch = async () => {
      calls++
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: new Map([["retry-after", "0"]]),
          text: async () => "rate limit",
        }
      }
      if (calls === 2) {
        return {
          ok: false,
          status: 503,
          headers: new Map(),
          text: async () => "service unavailable",
        }
      }
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () =>
          JSON.stringify({
            model: "resolved-writer-v1",
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      }
    }

    const res = await callChatCompletion({
      apiKey: "test-key",
      model: "requested-writer",
      messages: [{ role: "user", content: "hi" }],
      budget,
      label: "transient-test",
      retryBaseDelayMs: 10,
      fetchImpl: mockFetch,
      sleepImpl: async (ms) => {
        sleeps.push(ms)
      },
    })
    assert.equal(res.content, "ok")
    assert.equal(res.model, "resolved-writer-v1")
    assert.equal(budget.calls, 3, "初回＋再試行2回＝計3回が予算計上されること")
    assert.equal(budget.failedCalls, 2)
    assert.equal(budget.transientRetries, 2)
    assert.deepEqual(budget.summary().responseModels, ["resolved-writer-v1"], "失敗呼出のモデルが混入しないこと")
    assert.equal(sleeps.length, 2)

    // ネットワーク/Abort 例外からの再試行成功
    const netBudget = new BudgetTracker({ maxCalls: 10 })
    let netCalls = 0
    const netRes = await callChatCompletion({
      apiKey: "test-key",
      model: "requested-writer",
      messages: [{ role: "user", content: "hi" }],
      budget: netBudget,
      label: "net-retry",
      retryBaseDelayMs: 5,
      fetchImpl: async () => {
        netCalls++
        if (netCalls === 1) throw new Error("socket hang up")
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          text: async () =>
            JSON.stringify({
              model: "resolved-net",
              choices: [{ message: { content: "recovered" } }],
              usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
            }),
        }
      },
      sleepImpl: async () => {},
    })
    assert.equal(netRes.content, "recovered")
    assert.equal(netBudget.calls, 2)
    assert.equal(netBudget.failedCalls, 1)
    assert.equal(netBudget.transientRetries, 1)
    assert.deepEqual(netBudget.summary().responseModels, ["resolved-net"])

    // HTTP 400（クライアントエラー）は再試行せず即座に失敗し responseModels は空のまま
    const badBudget = new BudgetTracker({ maxCalls: 10 })
    await assert.rejects(
      () =>
        callChatCompletion({
          apiKey: "test-key",
          model: "bad-model",
          messages: [{ role: "user", content: "hi" }],
          budget: badBudget,
          label: "bad-req",
          fetchImpl: async () => ({
            ok: false,
            status: 400,
            headers: new Map(),
            text: async () => "invalid parameter",
          }),
          sleepImpl: async () => {},
        }),
      /HTTP 400/,
    )
    assert.equal(badBudget.calls, 1)
    assert.equal(badBudget.failedCalls, 1)
    assert.equal(badBudget.transientRetries, 0)
    assert.deepEqual(badBudget.summary().responseModels, [])
  })
})

describe("評価ランナー: plugin-loader（no-ban-list 見出し・❌目印変換）", () => {
  test("現行 novel-writing/SKILL.md に対して表Aと❌悪文例4箇所を除去し、86行目原則・表B・✅作例4本を保持する", () => {
    const raw = readFileSync(join(root, "skills/novel-writing/SKILL.md"), "utf-8")
    const { text, removedBadExamples } = transformNovelWritingSkillNoBanList(raw)

    assert.equal(removedBadExamples, 4, "書き比べの ❌ 悪文例4箇所がすべて除去されること")
    assert.ok(text.includes(NO_BAN_LIST_PRINCIPLE), "固定の肯定原則文面が差し込まれること")
    // 表 A の具体語列挙が消えていること
    assert.ok(!text.includes("| 世界が止まったかのように"))
    assert.ok(!text.includes("口元が緩んだ"))
    // 86 行目相当の原則文は保持されていること
    assert.ok(text.includes("避ける表現を毎回べつの決まり文句へ機械的に置き換えると"))
    assert.ok(text.includes("複数話にまたがって同じ仕草が偏らないよう"))
    // 表 B と 96 行目注記は保持されていること
    assert.ok(text.includes("### B. 厳禁：勝手な教訓・感動まとめ"))
    assert.ok(text.includes("大切なことに気づいた"))
    assert.ok(text.includes("……悪くない"))
    // ❌ 悪文例が消え、✅ 良い作例 4 本が残っていること
    assert.ok(!text.includes("❌ **硬くて説明的な AI 文**"))
    assert.ok(!text.includes("❌ **情緒語と総括で埋めた AI 文**"))
    assert.ok(text.includes("✅ **動きと余韻のあるラノベ文**"))
    assert.ok(text.includes("✅ **声のある語り＋場面の中で見せる**"))
    assert.ok(text.includes("✅ **実験と実感で見せる**"))
    assert.ok(text.includes("✅ **呼吸と具体的なディテールで見せる三人称**"))
  })

  test("目印が欠落した Markdown では黙って返さず例外を投げる", () => {
    assert.throws(() => transformNovelWritingSkillNoBanList("# 見出しのみ\n本文"), /### A\./)
    assert.throws(
      () => transformNovelWritingSkillNoBanList("### A. テスト\n表のみ\n### B. テスト\n## 三、書き比べ\n"),
      /注記が見つかりません/,
    )
    assert.throws(
      () =>
        transformNovelWritingSkillNoBanList(
          [
            "### A. テスト",
            "> 避ける表現を毎回べつの決まり文句（「苦笑」など）へ置き換えると新しい定型になります。",
            "### B. テスト",
            "## 三、書き比べ",
            "✅ **良い例**",
          ].join("\n"),
        ),
      /❌ 悪文例ブロックが見つかりません/,
    )
  })

  test("computeDirectoryFingerprint と checkDistFreshness がビルドし忘れと指紋変化を検知する", async () => {
    const tmp = makeTempDir("llm-novel-fp-")
    try {
      mkdirSync(join(tmp, "src"), { recursive: true })
      mkdirSync(join(tmp, "dist"), { recursive: true })
      const srcFile = join(tmp, "src", "a.ts")
      const distFile = join(tmp, "dist", "a.js")
      writeFileSync(srcFile, "export const x = 1\n", "utf-8")
      writeFileSync(distFile, "export const x = 1\n", "utf-8")

      const fp1 = computeDirectoryFingerprint(join(tmp, "dist"))
      assert.equal(fp1.fileCount, 1)
      assert.equal(fp1.hash?.length, 64)

      writeFileSync(distFile, "export const x = 2\n", "utf-8")
      const fp2 = computeDirectoryFingerprint(join(tmp, "dist"))
      assert.notEqual(fp1.hash, fp2.hash, "ファイル内容が変われば SHA-256 指紋が変わること")

      // src を dist より 10 秒新しくする → stale: true かつ loadPluginFromRoot が停止
      const oldDate = new Date(Date.now() - 20_000)
      const newDate = new Date(Date.now())
      utimesSync(distFile, oldDate, oldDate)
      utimesSync(srcFile, newDate, newDate)
      const staleRes = checkDistFreshness(tmp)
      assert.equal(staleRes.stale, true)
      await assert.rejects(() => loadPluginFromRoot(tmp), /pnpm build/)

      // dist を src より新しくすると stale: false
      const newerDist = new Date(Date.now() + 5_000)
      utimesSync(distFile, newerDist, newerDist)
      assert.equal(checkDistFreshness(tmp).stale, false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("評価ランナー: metrics（規則別密度・文体ズレ絶対値平均）", () => {
  test("aggregateRunsMetrics は正負の文体ズレを打ち消さず絶対値平均を算出し、stock-phrase 密度を独立集計する", () => {
    const makeRun = (sentDelta, dialDelta, stockDensity) => ({
      totalBodyChars: 3000,
      meanAbsWordDeviationPct: 5,
      outOfRangeChapters: 0,
      typographyErrors: 0,
      typographyWarnings: 0,
      proseWarningsTotal: 3,
      proseWarningsPer1kChars: 1.0,
      proseByRulePer1kChars: {
        "stock-phrase": stockDensity,
        "preachy-ending": 0,
        "closing-cliche": 0,
        "repeated-ending": 0,
        "long-sentence": 1.0 - stockDensity,
        "cross-chapter-repeat": 0,
      },
      statusWarningsCount: 0,
      styleDrift: {
        deltas: {
          meanSentenceChars: sentDelta,
          dialogueCharRatio: dialDelta,
          meanParagraphSentences: sentDelta / 5,
          pastTaRatio: dialDelta,
        },
      },
    })

    const agg = aggregateRunsMetrics([makeRun(5, 0.1, 0.2), makeRun(-5, -0.1, 0.6)])
    assert.equal(agg.styleDriftAvg.meanSentenceCharsAbsDelta, 5)
    assert.equal(agg.styleDriftAvg.signed.meanSentenceCharsDelta, 0)
    assert.equal(agg.styleDriftAvg.dialogueCharRatioAbsDelta, 0.1)
    assert.equal(agg.styleDriftAvg.signed.dialogueCharRatioDelta, 0)
    assert.equal(agg.proseByRulePer1kCharsAvg["stock-phrase"], 0.4)
  })
})

describe("評価ランナー: writer-harness（タグ検証・執筆/記録更新の再試行・予算計上）", () => {
  test("parseWriterOutput は正常出力・タグ欠落・短文・ツール記法混入を正しく判定する", () => {
    const body = "放課後の教室は静かだった。".repeat(30)
    const ok = parseWriterOutput(`<タイトル>放課後のテスト</タイトル>\n<本文>\n${body}\n</本文>`)
    assert.equal(ok.ok, true)
    assert.equal(ok.title, "放課後のテスト")

    assert.equal(parseWriterOutput("タグなし本文").ok, false)
    assert.equal(parseWriterOutput("<タイトル>題</タイトル><本文>短い</本文>").ok, false)
    assert.equal(
      parseWriterOutput(`<タイトル>題</タイトル><本文>${body}\nnovel_save_chapter(chapterNumber: 1)</本文>`).ok,
      false,
    )

    const rec = parseRecordUpdateJson(
      '```json\n{"characterState":{"updates":[]},"summary":"第1話のあらすじ。","foreshadow":{"items":[{"id":"F1","status":"planted"}]}}\n```',
    )
    assert.equal(rec.ok, true)
    assert.equal(rec.foreshadow.items[0].id, "F1")
  })

  test("executeChapterStep は本文タグ欠落と novelUpdateExecute の ❌ 戻り値でそれぞれ1回再試行し予算へ計上する", async () => {
    const tmp = makeTempDir("llm-novel-retry-")
    try {
      // examples/fantasy-balanced をコピーした小プロジェクトを使う
      const plugin = await loadPluginFromRoot(root, { allowStaleDist: true })
      const { cpSync } = await import("node:fs")
      cpSync(join(root, "examples/fantasy-balanced"), tmp, { recursive: true })

      const budget = new BudgetTracker({ maxCalls: 10 })
      const validBody = "　石畳を北へ28歩進んだところで、フィナが足を止めた。\n「レオ、壁の裏に空間があるのか？」\n「間違いない。〈歩数計〉の計測が3段ぶんずれている」\n".repeat(
        8,
      )
      const responses = [
        // 1回目執筆: タグ欠落（失敗 → 再試行）
        "結果: 第1話を書きました。novel_save_chapter を呼びました。",
        // 2回目執筆: 成功
        `<タイトル>隠し通路の計測</タイトル>\n<本文>\n${validBody}\n</本文>`,
        // 1回目記録更新: 不正な characterState 形式で novelUpdateExecute が ❌ を返す（失敗 → 再試行）
        JSON.stringify({
          characterState: { updates: [{ name: "", changes: {} }] },
          summary: "第1話で隠し部屋を見つけた。",
          foreshadow: { items: [{ id: "F1", status: "planted" }] },
        }),
        // 2回目記録更新: 正常
        JSON.stringify({
          characterState: { updates: [{ name: "レオ", changes: { mentalState: "手応えあり" } }] },
          summary: "第1話でレオとフィナは隠し部屋と古い金属片を見つけた。",
          foreshadow: { items: [{ id: "F1", status: "planted" }] },
        }),
      ]
      let idx = 0
      const mockCall = async ({ budget: b, label }) => {
        b.assertCanCall(label)
        const content = responses[idx++]
        b.record({ label, promptTokens: 200, completionTokens: 100, model: "mock-writer" })
        return { content, model: "mock-writer", usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 } }
      }

      const step = await executeChapterStep({
        plugin,
        projectDir: tmp,
        chapterNumber: 1,
        llmConfig: { model: "mock-writer", apiKey: "k", temperature: 0.75 },
        budget,
        callLlm: mockCall,
        minBodyChars: 200,
      })

      assert.equal(step.status, "ok")
      assert.equal(step.writerRetries, 1)
      assert.equal(step.recordRetries, 1)
      assert.equal(step.recordErrors.length, 0)
      assert.equal(budget.calls, 4, "執筆2回＋記録更新2回＝計4回が予算に計上されること")

      // F1 が planted に更新されていること
      const fsAfter = JSON.parse(readFileSync(join(tmp, ".novel/foreshadow.json"), "utf-8"))
      assert.equal(fsAfter.items[0].status, "planted")
      // システムプロンプトに固定上書き指示が含まれること
      const built = buildWriterSystemPrompt({ agentPrompt: plugin.writerAgent.prompt, skillDocs: [] })
      assert.ok(built.prompt.includes(RUNNER_OVERRIDE_INSTRUCTION))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("評価ランナー: judge（位置スワップ・確定率 d・偽陽性率/誤却下率・対称75%判定・指紋警告）", () => {
  test("resolveSwappedVote と computeFalsePositiveRate・2軸合算誤却下率が理論値どおり算出される", () => {
    assert.deepEqual(resolveSwappedVote("X", "Y"), { outcome: "A", decided: true })
    assert.deepEqual(resolveSwappedVote("Y", "X"), { outcome: "B", decided: true })
    assert.deepEqual(resolveSwappedVote("tie", "tie"), { outcome: "tie", decided: false })
    assert.deepEqual(resolveSwappedVote("X", "X"), { outcome: "tie_position_sensitive", decided: false })

    // 4ペア中3勝以上: d=1.0 -> 31.25%, d=0.5 -> 5.08%
    assert.equal(computeFalsePositiveRate(4, 3, 1.0), 0.3125)
    assert.equal(computeFalsePositiveRate(4, 3, 0.5), 0.0508)
    // 6ペア中5勝以上: d=1.0 -> 10.94%
    assert.equal(computeFalsePositiveRate(6, 5, 1.0), 0.1094)

    // 6ペアすべて確定（d=1.0）→ simplify 2軸合算の独立近似上限 = 1 - (1 - 0.1094)^2 = 0.2068
    const sixDecided = summarizePairJudgments(
      Array.from({ length: 6 }, () => ({
        pairLabel: "p",
        exampleName: "romcom-light",
        axes: {
          buildup_and_payoff: { outcome: "A", decided: true },
          tone_and_ng: { outcome: "A", decided: true },
          character_voice: { outcome: "B", decided: true },
          overall: { outcome: "B", decided: true },
        },
      })),
    )
    assert.equal(sixDecided.requiredWinsForReject, 5)
    assert.equal(sixDecided.byAxis.tone_and_ng.falseRejectRate, 0.1094)
    assert.equal(sixDecided.simplifyCombinedFalseRejectRate, 0.2068)
  })

  test("evaluateDecision が improve 基準と対称 75% の simplify 基準（＋stock-phrase 密度）を正しく判定する", () => {
    const mkPair = (outcomes) => ({
      pairLabel: "p",
      exampleName: "romcom-light",
      axes: Object.fromEntries(
        Object.entries(outcomes).map(([k, v]) => [k, { outcome: v, decided: v === "A" || v === "B" }]),
      ),
    })
    const cleanMetrics = {
      typographyErrorsTotal: 0,
      statusWarningsTotal: 0,
      outOfRangeChaptersTotal: 0,
      proseWarningsPer1kCharsAvg: 1.0,
      proseByRulePer1kCharsAvg: { "stock-phrase": 0.2 },
    }

    // 引き分け6ペア → improve は HOLD_NO_DIFF、simplify は ADOPT_CANDIDATE
    const allTie = summarizePairJudgments(
      Array.from({ length: 6 }, () =>
        mkPair({ buildup_and_payoff: "tie", tone_and_ng: "tie", character_voice: "tie", overall: "tie" }),
      ),
    )
    assert.equal(
      evaluateDecision({
        criteria: "improve",
        primaryAxis: "buildup_and_payoff",
        pairSummary: allTie,
        overallMetricsA: cleanMetrics,
        overallMetricsB: cleanMetrics,
      }).verdict,
      "HOLD_NO_DIFF",
    )
    assert.equal(
      evaluateDecision({
        criteria: "simplify",
        pairSummary: allTie,
        overallMetricsA: cleanMetrics,
        overallMetricsB: { ...cleanMetrics, proseWarningsPer1kCharsAvg: 1.15 }, // +15% <= +20%
      }).verdict,
      "ADOPT_CANDIDATE",
    )
    // simplify で全体 ⚠️ 密度が +20% 超（1.0 -> 1.35）なら REJECT_REGRESSION
    assert.equal(
      evaluateDecision({
        criteria: "simplify",
        pairSummary: allTie,
        overallMetricsA: cleanMetrics,
        overallMetricsB: { ...cleanMetrics, proseWarningsPer1kCharsAvg: 1.35 },
      }).verdict,
      "REJECT_REGRESSION",
    )
    // 全体密度が許容内でも stock-phrase 密度が上限超過（0.2 -> 0.5 > max(0.24, 0.4)）なら REJECT_REGRESSION
    assert.equal(
      evaluateDecision({
        criteria: "simplify",
        pairSummary: allTie,
        overallMetricsA: cleanMetrics,
        overallMetricsB: {
          ...cleanMetrics,
          proseWarningsPer1kCharsAvg: 1.1,
          proseByRulePer1kCharsAvg: { "stock-phrase": 0.5 },
        },
      }).verdict,
      "REJECT_REGRESSION",
    )

    // 対称 75% 却下基準：6ペア中 A が 4勝（66.7% < 75%）なら simplify はまだ ADOPT_CANDIDATE
    const aFourOfSix = summarizePairJudgments([
      ...Array.from({ length: 4 }, () =>
        mkPair({ buildup_and_payoff: "tie", tone_and_ng: "tie", character_voice: "tie", overall: "A" }),
      ),
      ...Array.from({ length: 2 }, () =>
        mkPair({ buildup_and_payoff: "tie", tone_and_ng: "tie", character_voice: "tie", overall: "tie" }),
      ),
    ])
    assert.equal(
      evaluateDecision({
        criteria: "simplify",
        pairSummary: aFourOfSix,
        overallMetricsA: cleanMetrics,
        overallMetricsB: cleanMetrics,
      }).verdict,
      "ADOPT_CANDIDATE",
    )

    // 6ペア中 A が 5勝（83.3% >= 75%）なら simplify は REJECT_REGRESSION（overall / tone_and_ng それぞれ確認）
    const aFiveOverall = summarizePairJudgments([
      ...Array.from({ length: 5 }, () =>
        mkPair({ buildup_and_payoff: "tie", tone_and_ng: "tie", character_voice: "tie", overall: "A" }),
      ),
      mkPair({ buildup_and_payoff: "tie", tone_and_ng: "tie", character_voice: "tie", overall: "tie" }),
    ])
    assert.equal(
      evaluateDecision({
        criteria: "simplify",
        pairSummary: aFiveOverall,
        overallMetricsA: cleanMetrics,
        overallMetricsB: cleanMetrics,
      }).verdict,
      "REJECT_REGRESSION",
    )
    const aFiveTone = summarizePairJudgments([
      ...Array.from({ length: 5 }, () =>
        mkPair({ buildup_and_payoff: "tie", tone_and_ng: "A", character_voice: "tie", overall: "tie" }),
      ),
      mkPair({ buildup_and_payoff: "tie", tone_and_ng: "tie", character_voice: "tie", overall: "tie" }),
    ])
    assert.equal(
      evaluateDecision({
        criteria: "simplify",
        pairSummary: aFiveTone,
        overallMetricsA: cleanMetrics,
        overallMetricsB: cleanMetrics,
      }).verdict,
      "REJECT_REGRESSION",
    )

    // 完了ペア 0 件のときは simplify でも ADOPT_CANDIDATE にせず HOLD_NO_DIFF
    const zeroPairs = summarizePairJudgments([])
    assert.equal(
      evaluateDecision({
        criteria: "simplify",
        pairSummary: zeroPairs,
        overallMetricsA: cleanMetrics,
        overallMetricsB: cleanMetrics,
      }).verdict,
      "HOLD_NO_DIFF",
    )

    // 執筆・保存失敗による欠落話数が増えた場合は文字数逸脱が同数でも REJECT_REGRESSION
    assert.equal(
      evaluateDecision({
        criteria: "simplify",
        pairSummary: allTie,
        overallMetricsA: { ...cleanMetrics, missingChaptersTotal: 0 },
        overallMetricsB: { ...cleanMetrics, missingChaptersTotal: 1 },
      }).verdict,
      "REJECT_REGRESSION",
    )

    // 6ペア中5勝（tone_and_ng 引き分け）→ improve は ADOPT_CANDIDATE
    const fiveOfSix = summarizePairJudgments([
      ...Array.from({ length: 5 }, () =>
        mkPair({ buildup_and_payoff: "B", tone_and_ng: "tie", character_voice: "tie", overall: "B" }),
      ),
      mkPair({ buildup_and_payoff: "tie", tone_and_ng: "tie", character_voice: "tie", overall: "tie" }),
    ])
    assert.equal(
      evaluateDecision({
        criteria: "improve",
        primaryAxis: "buildup_and_payoff",
        pairSummary: fiveOfSix,
        overallMetricsA: cleanMetrics,
        overallMetricsB: cleanMetrics,
      }).verdict,
      "ADOPT_CANDIDATE",
    )
  })

  test("checkRunCompatibility は未コミット変更・モデル違い・skillVariantとcommitの同時変更・成果物指紋不整合を警告する", () => {
    const metaA = {
      label: "a",
      git: { commit: "aaaa111", shortCommit: "aaaa111", dirty: true },
      artifacts: { distHash: "dist-same", skillsHash: "skills-same", staleDistBypassed: true },
      stoppedByError: true,
      stopErrorMessage: "timeout",
      skillVariant: "default",
      writerModel: "model-x",
      examples: ["romcom-light"],
      chapters: [1, 2, 3],
      runs: 2,
      systemPromptHashes: { "romcom-light": "h1" },
      budget: { responseModels: ["model-x-2026-01"] },
    }
    const metaB = {
      label: "b",
      git: { commit: "bbbb222", shortCommit: "bbbb222", dirty: false },
      artifacts: { distHash: "dist-same", skillsHash: "skills-same", staleDistBypassed: false },
      skillVariant: "no-ban-list",
      writerModel: "model-x",
      examples: ["romcom-light"],
      chapters: [1, 2, 3],
      runs: 2,
      systemPromptHashes: { "romcom-light": "h2" },
      budget: { responseModels: ["model-x-2026-02"] },
    }
    const compat = checkRunCompatibility(metaA, metaB)
    assert.ok(compat.warnings.some((w) => w.includes("未コミット変更")))
    assert.ok(compat.warnings.some((w) => w.includes("解決モデルが異なります")))
    assert.ok(compat.warnings.some((w) => w.includes("git commit")))
    assert.ok(compat.warnings.some((w) => w.includes("dist/ と skills/ の指紋が完全に一致")))
    assert.ok(compat.warnings.some((w) => w.includes("--allow-stale-dist")))
    assert.ok(compat.warnings.some((w) => w.includes("エラーで途中停止")))

    // A/A 条件（同一 commit・同一 skillVariant）なのに distHash が異なる場合も警告し、A/A メモを出さないこと
    const aaMismatch = checkRunCompatibility(
      {
        label: "aa1",
        git: { commit: "cccc333", shortCommit: "cccc333", dirty: false },
        artifacts: { distHash: "dist-1", skillsHash: "skills-1", staleDistBypassed: false },
        skillVariant: "default",
        writerModel: "m",
        examples: ["romcom-light"],
        chapters: [1, 2],
        runs: 2,
        systemPromptHashes: { "romcom-light": "h1" },
        budget: { responseModels: ["m"] },
      },
      {
        label: "aa2",
        git: { commit: "cccc333", shortCommit: "cccc333", dirty: false },
        artifacts: { distHash: "dist-2", skillsHash: "skills-1", staleDistBypassed: false },
        skillVariant: "default",
        writerModel: "m",
        examples: ["romcom-light"],
        chapters: [1, 2],
        runs: 2,
        systemPromptHashes: { "romcom-light": "h1" },
        budget: { responseModels: ["m"] },
      },
    )
    assert.ok(aaMismatch.warnings.some((w) => w.includes("dist/ または skills/ の指紋が異なっています")))
    assert.equal(aaMismatch.notes.length, 0)
  })
})

describe("評価ランナー: CLI エンドツーエンド --dry-run（run / metrics / compare / 途中停止除外）", () => {
  test("parseCliArgs は --allow-stale-dist や --timeout-ms を正しく解釈する", () => {
    const parsed = parseCliArgs([
      "run",
      "--label",
      "t1",
      "--allow-stale-dist",
      "--timeout-ms",
      "45000",
      "--dry-run",
    ])
    assert.equal(parsed.command, "run")
    assert.equal(parsed.flags["allow-stale-dist"], true)
    assert.equal(parsed.flags["timeout-ms"], "45000")
    assert.equal(parsed.flags["dry-run"], true)
  })

  test("run (--runs 2 --dry-run) → metrics → compare が完走し、伏線・指紋・途中停止の除外が正しく動く", async () => {
    const outRoot = makeTempDir("llm-novel-eval-out-")
    try {
      const runA = await runCommand({
        label: "aa-1",
        runs: "2",
        chapters: "1-2",
        "plugin-root": root,
        "allow-stale-dist": true,
        "timeout-ms": "60000",
        "out-dir": outRoot,
        "dry-run": true,
      })
      assert.equal(runA.stoppedByBudget, false)
      assert.equal(runA.stoppedByError, false)
      assert.equal(runA.meta.budget.calls, 16, "2作品×2話×2試行×2コール＝16回")
      assert.equal(runA.meta.artifacts.distHash?.length, 64)
      assert.equal(runA.meta.artifacts.skillsHash?.length, 64)
      assert.deepEqual(runA.meta.completedRuns, { "romcom-light": [1, 2], "fantasy-balanced": [1, 2] })
      assert.equal(runA.meta.executionStats.okChapters, 8)
      assert.equal(runA.meta.executionStats.failedChapters, 0)
      assert.equal(runA.meta.writerTimeoutMs, 60000)
      assert.equal(runA.summary.overall.typographyErrorsTotal, 0)
      assert.equal(runA.summary.overall.statusWarningsTotal, 0, "状態・あらすじ・伏線の欠け警告が0件であること")

      // fantasy-balanced run-1 で F1 が第1話後に planted へ更新されていること
      const f1Path = join(runA.runRootDir, "fantasy-balanced/run-1/.novel/foreshadow.json")
      const f1Data = JSON.parse(readFileSync(f1Path, "utf-8"))
      assert.equal(f1Data.items[0].status, "planted")

      // metrics サブコマンドが runDir と単体作品ディレクトリの両方で動くこと
      const mRun = await metricsCommand(runA.runRootDir, {})
      assert.equal(mRun.summary.overall.typographyErrorsTotal, 0)
      const mSingle = await metricsCommand(join(runA.runRootDir, "romcom-light/run-1"), { chapters: "1-2" })
      assert.equal(mSingle.metrics.typographyErrors, 0)

      // 2つ目の run を no-ban-list で走らせ、compare (simplify) を検証
      const runB = await runCommand({
        label: "no-ban",
        runs: "2",
        chapters: "1-2",
        "plugin-root": root,
        "skill-variant": "no-ban-list",
        "allow-stale-dist": true,
        "out-dir": outRoot,
        "dry-run": true,
      })
      assert.notEqual(
        runA.meta.systemPromptHashes["romcom-light"],
        runB.meta.systemPromptHashes["romcom-light"],
        "default と no-ban-list でシステムプロンプトハッシュが異なること",
      )

      const cmp = await compareCommand(runA.runRootDir, runB.runRootDir, {
        criteria: "simplify",
        "timeout-ms": "45000",
        "dry-run": true,
      })
      assert.ok(existsSync(join(cmp.outDir, "comparison.json")))
      assert.ok(existsSync(join(cmp.outDir, "comparison.md")))
      assert.equal(cmp.comparison.decision.verdict, "ADOPT_CANDIDATE")
      assert.equal(cmp.comparison.judgeTimeoutMs, 45000)
      assert.ok(cmp.markdown.includes("`no-ban-list` 比較の解釈注記"))
      assert.ok(cmp.markdown.includes("できあいの言い回し (stock-phrase)"))
      assert.ok(cmp.markdown.includes("文体見本ズレ：1文平均 絶対値平均"))
      assert.ok(cmp.markdown.includes("合算の誤却下確率上限目安"))

      // 審査 JSON 解析失敗時は 1 回だけ再試行し予算へ計上する
      const judgeBudget = new BudgetTracker({ maxCalls: 10 })
      const judgeResponses = [
        "壊れたJSON",
        JSON.stringify({
          buildup_and_payoff: { winner: "Y", reason: "pass1" },
          tone_and_ng: { winner: "tie", reason: "ok" },
          character_voice: { winner: "tie", reason: "ok" },
          overall: { winner: "Y", reason: "pass1" },
        }),
        JSON.stringify({
          buildup_and_payoff: { winner: "X", reason: "pass2" },
          tone_and_ng: { winner: "tie", reason: "ok" },
          character_voice: { winner: "tie", reason: "ok" },
          overall: { winner: "X", reason: "pass2" },
        }),
      ]
      let jIdx = 0
      const judgedRetry = await judgePairSwapped({
        exampleName: "romcom-light",
        projectDirA: join(runA.runRootDir, "romcom-light/run-1"),
        projectDirB: join(runB.runRootDir, "romcom-light/run-1"),
        chapters: [1, 2],
        judgeLlmConfig: { model: "mock-judge", apiKey: "k", temperature: 0 },
        budget: judgeBudget,
        callLlm: async ({ budget: b, label }) => {
          b.assertCanCall(label)
          const content = judgeResponses[jIdx++]
          b.record({ label, promptTokens: 100, completionTokens: 50, model: "mock-judge" })
          return { content, model: "mock-judge", usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }
        },
        pairLabel: "retry-pair",
      })
      assert.equal(judgeBudget.calls, 3, "Pass1の1回再試行＋Pass2＝計3回が予算に計上されること")
      assert.equal(judgedRetry.axes.buildup_and_payoff.outcome, "B")

      // 実行途中のトークン上限到達でも、完了済み試行のみ保持して安全停止し、compare は未完了試行を除外する
      const stoppedRun = await runCommand({
        label: "mid-stop",
        example: "romcom-light",
        runs: "2",
        chapters: "1-2",
        "max-total-tokens": "35000",
        "plugin-root": root,
        "allow-stale-dist": true,
        "out-dir": outRoot,
        "dry-run": true,
      })
      assert.equal(stoppedRun.stoppedByBudget, true)
      assert.equal(stoppedRun.stoppedByError, false)
      assert.ok(existsSync(join(stoppedRun.runRootDir, "meta.json")))
      assert.ok(existsSync(join(stoppedRun.runRootDir, "summary.json")))
      assert.deepEqual(stoppedRun.meta.completedRuns["romcom-light"], [1])
      assert.equal(stoppedRun.meta.incompleteRuns["romcom-light"].length, 1)
      assert.equal(stoppedRun.summary.byExample["romcom-light"].runs.length, 1, "完了済みの1試行目のみ集計されること")

      // 未完了 run-2 がディレクトリだけ存在していても compare は完了済み [1] のみを比較し警告を出すこと
      const cmpPartial = await compareCommand(stoppedRun.runRootDir, runA.runRootDir, {
        criteria: "simplify",
        "dry-run": true,
      })
      assert.equal(cmpPartial.comparison.pairResults.length, 1, "未完了の run-2 は比較対象から除外されること")
      assert.ok(
        cmpPartial.comparison.compatibility.warnings.some((w) => w.includes("未完了または片側のみの試行を除外")),
      )

      // 予算以外の途中 API エラー（外部要因）では meta.json / summary.json を保存して stoppedByError: true で止まり、
      // 外部中断した試行は incompleteRuns へ入り failedChapters（内容起因の失敗）には加算されないこと
      const dryRomcom = createDryRunLlmClient({ exampleName: "romcom-light" })
      const errRun = await runCommand(
        {
          label: "api-err-stop",
          example: "romcom-light",
          runs: "2",
          chapters: "1-2",
          "plugin-root": root,
          "allow-stale-dist": true,
          "out-dir": outRoot,
          "dry-run": true,
        },
        {
          createCallLlm: ({ run }) => async (args) => {
            if (run === 2) throw new Error("模擬 HTTP 500 連続失敗")
            return dryRomcom(args)
          },
        },
      )
      assert.equal(errRun.stoppedByError, true)
      assert.equal(errRun.stoppedByBudget, false)
      assert.ok(existsSync(join(errRun.runRootDir, "meta.json")))
      assert.ok(existsSync(join(errRun.runRootDir, "summary.md")))
      assert.deepEqual(errRun.meta.completedRuns["romcom-light"], [1])
      assert.equal(errRun.meta.incompleteRuns["romcom-light"].length, 1)
      assert.equal(errRun.meta.executionStats.failedChapters, 0, "外部 API エラーは執筆失敗話数へ加算しないこと")
      assert.equal(errRun.meta.executionStats.abortedRuns, 1)

      // 書き手の形式検証2回失敗（内容起因）は生存バイアスを防ぐため比較・集計から除外せず、欠落話数として不利に計上すること
      const contentFailRun = await runCommand(
        {
          label: "content-fail",
          example: "romcom-light",
          runs: "2",
          chapters: "1-2",
          "plugin-root": root,
          "allow-stale-dist": true,
          "out-dir": outRoot,
          "dry-run": true,
        },
        {
          createCallLlm: ({ run }) => async (args) => {
            if (run === 2) {
              args.budget?.assertCanCall(args.label)
              args.budget?.record({ label: args.label, promptTokens: 50, completionTokens: 20, model: "mock-broken" })
              return {
                content: "タグのない壊れた出力",
                model: "mock-broken",
                usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
              }
            }
            return dryRomcom(args)
          },
        },
      )
      assert.equal(contentFailRun.stoppedByError, false)
      assert.equal(contentFailRun.stoppedByBudget, false)
      assert.deepEqual(
        contentFailRun.meta.completedRuns["romcom-light"],
        [1, 2],
        "内容起因の失敗試行は比較から除外されないこと",
      )
      assert.equal(contentFailRun.meta.incompleteRuns["romcom-light"].length, 0)
      assert.equal(contentFailRun.meta.executionStats.failedChapters, 1)
      assert.equal(contentFailRun.meta.executionStats.abortedRuns, 0)
      assert.equal(contentFailRun.summary.overall.missingChaptersTotal, 2, "run-2 の未執筆 2 話が欠落話数に計上されること")

      // 健全な run（A）と内容失敗のある run（B）を compare すると 2 ペアすべて比較され、欠落話数増で REJECT_REGRESSION になること
      const cleanRomcomRun = await runCommand({
        label: "clean-romcom",
        example: "romcom-light",
        runs: "2",
        chapters: "1-2",
        "plugin-root": root,
        "allow-stale-dist": true,
        "out-dir": outRoot,
        "dry-run": true,
      })
      const cmpContentFail = await compareCommand(cleanRomcomRun.runRootDir, contentFailRun.runRootDir, {
        criteria: "simplify",
        "dry-run": true,
      })
      assert.equal(cmpContentFail.comparison.pairResults.length, 2, "失敗試行も含めて全2ペアが比較されること")
      assert.equal(cmpContentFail.comparison.overallMetricsB.missingChaptersTotal, 2)
      assert.equal(cmpContentFail.comparison.decision.verdict, "REJECT_REGRESSION")
      assert.ok(cmpContentFail.comparison.decision.reasons.some((r) => r.includes("欠落話数が増加")))

      // 予定コール数が --max-calls を超えるときは実行前にエラーで止まること
      await assert.rejects(
        () =>
          runCommand({
            label: "over-budget",
            runs: "2",
            chapters: "1-3",
            "max-calls": "10",
            "allow-stale-dist": true,
            "out-dir": outRoot,
            "dry-run": true,
          }),
        /予定最小 API コール数/,
      )
    } finally {
      rmSync(outRoot, { recursive: true, force: true })
    }
  })
})
