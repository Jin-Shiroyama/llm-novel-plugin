#!/usr/bin/env node
/**
 * llm-novel-plugin 半自動評価ランナー
 *
 * OpenCode を通さずにツール関数と OpenAI 互換 API を直接呼び出し、
 * examples/ の見本2作品（romcom-light / fantasy-balanced）の第1〜3話を執筆・計測・ペア比較する。
 *
 * 使い方:
 *   node scripts/eval-runner.mjs run --label baseline --runs 2 --writer-model <model>
 *   node scripts/eval-runner.mjs metrics <runDir-or-projectDir>
 *   node scripts/eval-runner.mjs compare <runDirA> <runDirB> --judge-model <other-model> --criteria improve|simplify
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BudgetExceededError,
  BudgetTracker,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_CALLS,
  DEFAULT_TIMEOUT_MS,
  parseExtraBodyOption,
  parseTemperatureOption,
} from "./eval/llm-client.mjs"
import { loadPluginFromRoot } from "./eval/plugin-loader.mjs"
import { createDryRunLlmClient, executeChapterStep } from "./eval/writer-harness.mjs"
import { aggregateRunsMetrics, collectProjectMetrics, REPO_ROOT } from "./eval/metrics.mjs"
import {
  checkRunCompatibility,
  createDryRunJudgeClient,
  evaluateDecision,
  formatComparisonMarkdown,
  judgePairSwapped,
  summarizePairJudgments,
} from "./eval/judge.mjs"

const ALL_EXAMPLES = ["romcom-light", "fantasy-balanced"]

function printHelp() {
  console.log(`llm-novel-plugin 半自動評価ランナー

サブコマンド:
  run [options]                  見本作品を執筆し、機械指標を集計する
  metrics <dir> [--chapters 1-3] 既存の run ディレクトリまたは作品ディレクトリの機械指標を再集計する
  compare <runA> <runB> [opts]   2つの run を機械指標＋位置スワップ LLM ペア比較で評価する

主なオプション (run):
  --label <name>                 実行ラベル（既定: run）
  --example <all|romcom-light|fantasy-balanced>  対象見本（既定: all）
  --chapters <1-3>               対象話範囲（既定: 1-3）
  --runs <N>                     試行数（既定: 2）
  --plugin-root <dir>            評価対象プラグインのルートまたは worktree（既定: .）
  --skills-dir <dir>             スキルディレクトリの上書き（任意）
  --skill-variant <default|no-ban-list>  スキル変種（既定: default）
  --allow-stale-dist             src/ が dist/ より新しくてもビルド警告を無視して続行
  --writer-model <model>         書き手モデル（環境変数: EVAL_WRITER_MODEL / OPENAI_MODEL）
  --writer-base-url <url>        書き手 API Base URL（既定: OPENAI_BASE_URL または https://api.openai.com/v1）
  --writer-api-key-env <ENV>     書き手 API キー環境変数名（既定: OPENAI_API_KEY）
  --writer-temperature <num|omit> 書き手 temperature（既定: novel-writer 定義値 0.75。omit で送信省略）
  --writer-max-tokens <num>      書き手 max_tokens（任意。未指定時は送信しない）
  --writer-extra-body <json>     書き手追加パラメータ JSON（例: '{"max_completion_tokens":4096}'）
  --timeout-ms <ms>              API タイムアウト ms（既定: ${DEFAULT_TIMEOUT_MS}）
  --writer-timeout-ms <ms>       書き手 API タイムアウト ms（未指定時は --timeout-ms）
  --max-calls <N>                API 呼び出し上限（既定: ${DEFAULT_MAX_CALLS}）
  --max-total-tokens <N>         累計トークン上限（任意）
  --max-cost-usd <num>           推定コスト上限 USD（--input-price-per-1m / --output-price-per-1m と併用）
  --input-price-per-1m <num>     入力 100万トークン単価 USD（任意）
  --output-price-per-1m <num>    出力 100万トークン単価 USD（任意）
  --out-dir <dir>                出力先ルート（既定: .eval-runs）
  --dry-run                      API を呼ばずモック応答で全パイプラインを検証

主なオプション (compare):
  --criteria <improve|simplify>  事前採否基準（既定: improve）
  --primary-axis <axis>          improve 基準の主軸（既定: buildup_and_payoff）
  --judge-model <model>          審査モデル（書き手と別モデルを推奨）
  --judge-base-url <url>         審査 API Base URL
  --judge-api-key-env <ENV>      審査 API キー環境変数名（既定: OPENAI_API_KEY）
  --judge-temperature <num|omit> 審査 temperature（既定: 0。omit で送信省略）
  --judge-max-tokens <num>       審査 max_tokens（任意）
  --judge-extra-body <json>      審査追加パラメータ JSON
  --timeout-ms <ms>              API タイムアウト ms（既定: ${DEFAULT_TIMEOUT_MS}）
  --judge-timeout-ms <ms>        審査 API タイムアウト ms（未指定時は --timeout-ms）
  --out <dir>                    比較レポート出力先
  --dry-run                      モック審査で比較パイプラインを検証
`)
}

export function parseCliArgs(argv) {
  const positionals = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    if (key === "dry-run" || key === "help" || key === "allow-stale-dist") {
      flags[key] = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true
    } else {
      flags[key] = next
      i++
    }
  }
  return { command: positionals[0] ?? null, positionals: positionals.slice(1), flags }
}

export function parseChapterRange(raw = "1-3") {
  const text = String(raw).trim()
  const rangeMatch = text.match(/^(\d+)\s*-\s*(\d+)$/)
  if (rangeMatch) {
    const from = Number(rangeMatch[1])
    const to = Number(rangeMatch[2])
    if (from < 1 || to < from) throw new Error(`話数範囲が不正です: ${raw}`)
    return Array.from({ length: to - from + 1 }, (_, i) => from + i)
  }
  const single = Number(text)
  if (Number.isInteger(single) && single >= 1) return [single]
  throw new Error(`話数範囲は 1-3 のように指定してください: ${raw}`)
}

function parseOptionalNumber(raw, name) {
  if (raw === undefined || raw === null || raw === "") return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`${name} には数値を指定してください: ${raw}`)
  return n
}

function parsePositiveNumber(raw, name) {
  const n = parseOptionalNumber(raw, name)
  if (n === undefined) return undefined
  if (n <= 0) throw new Error(`${name} には正の数を指定してください: ${raw}`)
  return n
}

function isTruthyFlag(val) {
  if (val === true) return true
  if (typeof val === "string") {
    const s = val.trim().toLowerCase()
    return s !== "" && s !== "false" && s !== "0"
  }
  return false
}

function makeTimestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function sanitizeLabel(label) {
  return String(label || "run")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "run"
}

function buildBudget(flags) {
  return new BudgetTracker({
    maxCalls: parseOptionalNumber(flags["max-calls"], "max-calls") ?? DEFAULT_MAX_CALLS,
    maxTotalTokens: parseOptionalNumber(flags["max-total-tokens"], "max-total-tokens"),
    maxCostUsd: parseOptionalNumber(flags["max-cost-usd"], "max-cost-usd"),
    inputPricePer1M: parseOptionalNumber(flags["input-price-per-1m"], "input-price-per-1m"),
    outputPricePer1M: parseOptionalNumber(flags["output-price-per-1m"], "output-price-per-1m"),
  })
}

function formatRunSummaryMarkdown(meta, summary) {
  const fpText = meta.artifacts
    ? `dist=\`${meta.artifacts.distHash?.slice(0, 12) ?? "n/a"}\` (${meta.artifacts.distFileCount ?? 0}件) / skills=\`${meta.artifacts.skillsHash?.slice(0, 12) ?? "n/a"}\` (${meta.artifacts.skillsFileCount ?? 0}件)${meta.artifacts.staleDistBypassed ? " ⚠️ stale-dist 無視" : ""}`
    : "n/a"
  const st = meta.executionStats
  const statsLine = st
    ? `- **実行内訳**: 成功=${st.okChapters}話 / 記録一部失敗=${st.partialRecordErrorChapters}話 / 執筆・保存失敗=${st.failedChapters}話 / 外部中断=${st.abortedRuns ?? 0}試行（再試行: 執筆形式=${st.writerFormatRetries ?? st.writerRetries}, 空応答=${st.emptyResponseRetries ?? 0}, 記録形式=${st.recordFormatRetries ?? st.recordRetries}, API一時障害=${st.transientApiRetries}${(st.lengthTruncatedAttempts ?? 0) > 0 ? `, length打切=${st.lengthTruncatedAttempts}` : ""}）`
    : null
  const incompleteSummary = Object.entries(meta.incompleteRuns ?? {})
    .flatMap(([ex, items]) => items.map((it) => `${ex}#run-${it.run}(${it.reason})`))

  const lines = [
    `# 評価ラン結果: ${meta.label}`,
    "",
    `- **日時**: ${meta.createdAt}`,
    `- **plugin-root**: \`${meta.pluginRoot}\` (commit=${meta.git?.shortCommit ?? "unknown"}${meta.git?.dirty ? " dirty" : ""})`,
    `- **成果物指紋**: ${fpText}`,
    `- **skill-variant**: \`${meta.skillVariant}\``,
    `- **writer-model**: \`${meta.writerModel}\` (応答モデル: ${(meta.budget?.responseModels ?? []).join(", ") || "n/a"})`,
    `- **対象**: examples=[${meta.examples.join(", ")}], chapters=[${meta.chapters.join(", ")}], runs=${meta.runs}`,
    `- **API使用量**: calls=${meta.budget.calls}/${meta.budget.maxCalls}, tokens=${meta.budget.totalTokens}${meta.budget.estimatedCostUsd !== null ? `, estCost=$${meta.budget.estimatedCostUsd.toFixed(4)}` : ""}`,
    ...(statsLine ? [statsLine] : []),
  ]
  if ((st?.lengthTruncatedAttempts ?? 0) > 0) {
    lines.push(
      `- **⚠️ 出力上限打切り**: \`finish_reason=length\` による打切りが ${st.lengthTruncatedAttempts} 回発生しました。\`--writer-max-tokens\` や \`--writer-extra-body\` で推論量・出力上限の設定を見直してください。`,
    )
  }
  if (meta.stoppedByBudget) {
    lines.push(`- **⚠️ 予算上限停止**: ${meta.budgetStopReason}`)
  }
  if (meta.stoppedByError) {
    lines.push(`- **❌ エラー途中停止**: ${meta.stopErrorMessage}`)
  }
  if (incompleteSummary.length > 0) {
    lines.push(`- **⚠️ 外部停止による未完了試行（集計除外）**: ${incompleteSummary.join(" / ")}`)
  }
  lines.push(
    "",
    "## 機械指標サマリー（外部中断を除いた試行を集計）",
    "| 作品 | 試行 | 欠落話数 | 表記❌合計 | 文章⚠️密度(/1k字) | 定型句16規則/外5規則(生件数) | 書けた話ズレ平均 | 文字数逸脱(参考) | 記録⚠️合計 | 文体絶対値ズレ(1文平均/会話比) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  )
  const formatStyleCell = (drift) => {
    if (!drift) return "n/a"
    const s = `${drift.meanSentenceCharsAbsDelta.toFixed(1)}字`
    const d = `${(drift.dialogueCharRatioAbsDelta * 100).toFixed(1)}pt`
    return `${s} / ${d}`
  }
  const fmtWrittenDev = (agg) =>
    Number.isFinite(agg.meanAbsWordDeviationPctWrittenAvg)
      ? `${agg.meanAbsWordDeviationPctWrittenAvg.toFixed(1)}%`
      : "n/a"
  for (const [ex, data] of Object.entries(summary.byExample)) {
    const agg = data.aggregate
    const stockCell = `${agg.stockPhraseSkillTotal ?? 0}件 / ${agg.stockPhraseOtherTotal ?? 0}件 (計${agg.stockPhraseRawTotal ?? 0}件)`
    lines.push(
      `| ${ex} | ${agg.runCount}/${meta.runs} | ${agg.missingChaptersTotal ?? 0} | ${agg.typographyErrorsTotal} | ${agg.proseWarningsPer1kCharsAvg.toFixed(3)} | ${stockCell} | ${fmtWrittenDev(agg)} | ${agg.outOfRangeChaptersTotal} | ${agg.statusWarningsTotal} | ${formatStyleCell(agg.styleDriftAvg)} |`,
    )
  }
  const ov = summary.overall
  const ovStockCell = `${ov.stockPhraseSkillTotal ?? 0}件 / ${ov.stockPhraseOtherTotal ?? 0}件 (計${ov.stockPhraseRawTotal ?? 0}件)`
  lines.push(
    `| **全体** | **${ov.runCount}** | **${ov.missingChaptersTotal ?? 0}** | **${ov.typographyErrorsTotal}** | **${ov.proseWarningsPer1kCharsAvg.toFixed(3)}** | **${ovStockCell}** | **${fmtWrittenDev(ov)}** | **${ov.outOfRangeChaptersTotal}** | **${ov.statusWarningsTotal}** | **${formatStyleCell(ov.styleDriftAvg)}** |`,
    "",
  )
  return lines.join("\n")
}

export async function runCommand(flags, deps = {}) {
  const dryRun = isTruthyFlag(flags["dry-run"])
  const label = sanitizeLabel(flags.label ?? (dryRun ? "dry-run" : "run"))
  const exampleOpt = String(flags.example ?? "all")
  const examples =
    exampleOpt === "all"
      ? [...ALL_EXAMPLES]
      : ALL_EXAMPLES.includes(exampleOpt)
        ? [exampleOpt]
        : (() => {
            throw new Error(`未対応の --example です: ${exampleOpt}（all / romcom-light / fantasy-balanced）`)
          })()
  const chapters = parseChapterRange(flags.chapters ?? "1-3")
  const runs = Math.max(1, Math.floor(parseOptionalNumber(flags.runs, "runs") ?? 2))
  const pluginRoot = resolve(flags["plugin-root"] ?? REPO_ROOT)
  const skillVariant = String(flags["skill-variant"] ?? "default")
  const allowStaleDist = isTruthyFlag(flags["allow-stale-dist"])
  const outRoot = resolve(flags["out-dir"] ?? join(REPO_ROOT, ".eval-runs"))

  const plugin = await loadPluginFromRoot(pluginRoot, {
    skillsDir: flags["skills-dir"],
    skillVariant,
    allowStaleDist,
  })

  const writerModel =
    flags["writer-model"] ?? process.env.EVAL_WRITER_MODEL ?? process.env.OPENAI_MODEL ?? (dryRun ? "dry-run-writer" : "")
  if (!writerModel) {
    throw new Error("--writer-model（または環境変数 EVAL_WRITER_MODEL / OPENAI_MODEL）を指定してください")
  }
  const writerApiKeyEnv = String(flags["writer-api-key-env"] ?? "OPENAI_API_KEY")
  const writerApiKey = dryRun ? "dry-run-key" : process.env[writerApiKeyEnv] ?? ""
  if (!dryRun && !writerApiKey) {
    throw new Error(`環境変数 ${writerApiKeyEnv} が未設定です`)
  }
  const writerBaseUrl =
    flags["writer-base-url"] ?? process.env.EVAL_WRITER_BASE_URL ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL
  const writerTemperature = parseTemperatureOption(flags["writer-temperature"], plugin.writerAgent.temperature)
  const writerMaxTokens = parseOptionalNumber(flags["writer-max-tokens"], "writer-max-tokens")
  const writerExtraBody = parseExtraBodyOption(flags["writer-extra-body"])
  const writerTimeoutMs =
    parsePositiveNumber(flags["writer-timeout-ms"] ?? flags["timeout-ms"], "writer-timeout-ms") ?? DEFAULT_TIMEOUT_MS
  const budget = buildBudget(flags)

  const plannedMinCalls = examples.length * chapters.length * runs * 2
  console.log(
    `[eval run] label=${label} examples=${examples.join(",")} chapters=${chapters.join(",")} runs=${runs} ` +
      `plannedMinCalls=${plannedMinCalls} maxCalls=${budget.maxCalls} timeoutMs=${writerTimeoutMs} dryRun=${dryRun}`,
  )
  if (plannedMinCalls > budget.maxCalls) {
    throw new Error(
      `予定最小 API コール数（${plannedMinCalls}回）が --max-calls（${budget.maxCalls}回）を超えています。--max-calls を増やすか --runs / --example を調整してください。`,
    )
  }

  const runRootDir = join(outRoot, `${makeTimestamp()}-${label}`)
  mkdirSync(runRootDir, { recursive: true })

  const systemPromptHashes = {}
  const executionLogs = {}
  const byExampleMetrics = {}
  const completedRuns = {}
  const incompleteRuns = {}
  const executionStats = {
    totalPlannedChapters: examples.length * runs * chapters.length,
    okChapters: 0,
    partialRecordErrorChapters: 0,
    failedChapters: 0,
    abortedRuns: 0,
    writerRetries: 0,
    writerFormatRetries: 0,
    emptyResponseRetries: 0,
    recordRetries: 0,
    recordFormatRetries: 0,
    lengthTruncatedAttempts: 0,
    transientApiRetries: 0,
    failedApiCalls: 0,
  }
  for (const ex of examples) {
    executionLogs[ex] = []
    byExampleMetrics[ex] = { runs: [], aggregate: aggregateRunsMetrics([]) }
    completedRuns[ex] = []
    incompleteRuns[ex] = []
  }

  let stoppedByBudget = false
  let budgetStopReason = null
  let stoppedByError = false
  let stopErrorMessage = null
  let inProgressRun = null

  try {
    for (const ex of examples) {
      const srcExampleDir = join(REPO_ROOT, "examples", ex)
      if (!existsSync(srcExampleDir)) {
        throw new Error(`見本ディレクトリが見つかりません: ${srcExampleDir}`)
      }
      const runMetricsList = byExampleMetrics[ex].runs

      for (let r = 1; r <= runs; r++) {
        const workDir = join(runRootDir, ex, `run-${r}`)
        rmSync(workDir, { recursive: true, force: true })
        cpSync(srcExampleDir, workDir, { recursive: true })

        const callLlm = deps.createCallLlm
          ? deps.createCallLlm({ exampleName: ex, run: r })
          : deps.callLlm ?? (dryRun ? createDryRunLlmClient({ exampleName: ex }) : undefined)
        const chapterLogs = []
        inProgressRun = { ex, run: r, workDir, chapterLogs }
        let chapterFailureReason = null

        for (const ch of chapters) {
          const step = await executeChapterStep({
            plugin,
            projectDir: workDir,
            chapterNumber: ch,
            llmConfig: {
              baseUrl: writerBaseUrl,
              apiKey: writerApiKey,
              model: writerModel,
              temperature: writerTemperature,
              maxTokens: writerMaxTokens,
              extraBody: writerExtraBody,
              timeoutMs: writerTimeoutMs,
            },
            budget,
            callLlm,
          })
          chapterLogs.push(step)
          executionStats.writerRetries += step.writerRetries ?? 0
          executionStats.writerFormatRetries += step.writerFormatRetries ?? 0
          executionStats.emptyResponseRetries += (step.emptyResponseRetries ?? 0) + (step.recordEmptyResponseRetries ?? 0)
          executionStats.recordRetries += step.recordRetries ?? 0
          executionStats.recordFormatRetries += step.recordFormatRetries ?? 0
          executionStats.lengthTruncatedAttempts += step.lengthTruncatedAttempts ?? 0
          if (step.systemPromptHash && !systemPromptHashes[ex]) {
            systemPromptHashes[ex] = step.systemPromptHash
          }
          if (step.status === "ok") {
            executionStats.okChapters++
          } else if (step.status === "partial_record_error") {
            executionStats.partialRecordErrorChapters++
          } else {
            executionStats.failedChapters++
            chapterFailureReason = `第${ch}話失敗: ${step.error}`
            console.error(`[eval run] ⚠️ ${ex} run-${r} ${chapterFailureReason}`)
            break
          }
        }

        // 形式違反や保存 ❌ などの内容起因の失敗は外部中断ではないため、比較から除外しない（生存バイアス防止）。
        // 欠落した話は collectProjectMetrics の missingChapters / outOfRangeChapters として不利に計上される。
        completedRuns[ex].push(r)
        const metrics = await collectProjectMetrics(workDir, chapters)
        runMetricsList.push(metrics)
        byExampleMetrics[ex].aggregate = aggregateRunsMetrics(runMetricsList)
        executionLogs[ex].push({
          run: r,
          workDir,
          completed: true,
          abortedByExternalError: false,
          chapterFailureReason,
          chapters: chapterLogs,
        })
        inProgressRun = null
      }
    }
  } catch (err) {
    const isBudgetErr = err instanceof BudgetExceededError
    const reason = isBudgetErr ? err.reason : err instanceof Error ? err.message : String(err)
    if (inProgressRun) {
      // 予算上限や API エラーなど外部要因で途中停止した試行のみ incompleteRuns として比較・集計から除外する
      // （外部エラーはモデルの執筆失敗ではないため executionStats.failedChapters には加算しない）
      incompleteRuns[inProgressRun.ex].push({ run: inProgressRun.run, reason })
      executionStats.abortedRuns++
      executionLogs[inProgressRun.ex].push({
        run: inProgressRun.run,
        workDir: inProgressRun.workDir,
        completed: false,
        abortedByExternalError: true,
        incompleteReason: reason,
        chapters: inProgressRun.chapterLogs,
      })
      inProgressRun = null
    }
    if (isBudgetErr) {
      stoppedByBudget = true
      budgetStopReason = err.reason
      console.error(`[eval run] ⚠️ ${err.message}`)
    } else {
      stoppedByError = true
      stopErrorMessage = reason
      console.error(`[eval run] ❌ 途中エラーのため完了済み試行を保存して停止しました: ${reason}`)
    }
  }

  const budgetSummary = budget.summary()
  executionStats.transientApiRetries = budgetSummary.transientRetries
  executionStats.failedApiCalls = budgetSummary.failedCalls

  const allRunMetrics = Object.values(byExampleMetrics).flatMap((x) => x.runs)
  const summary = {
    byExample: byExampleMetrics,
    overall: aggregateRunsMetrics(allRunMetrics),
  }
  const meta = {
    version: 2,
    label,
    createdAt: new Date().toISOString(),
    dryRun,
    pluginRoot: plugin.rootDir,
    skillsDir: plugin.skillsDir,
    skillVariant: plugin.skillVariant,
    git: plugin.git,
    artifacts: plugin.artifacts,
    examples,
    chapters,
    runs,
    completedRuns,
    incompleteRuns,
    executionStats,
    writerModel,
    writerBaseUrl,
    writerTemperature,
    writerMaxTokens: writerMaxTokens ?? null,
    writerExtraBody,
    writerTimeoutMs,
    systemPromptHashes,
    plannedMinCalls,
    stoppedByBudget,
    budgetStopReason,
    stoppedByError,
    stopErrorMessage,
    budget: budgetSummary,
  }

  writeFileSync(join(runRootDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8")
  writeFileSync(join(runRootDir, "execution.json"), JSON.stringify(executionLogs, null, 2), "utf-8")
  writeFileSync(join(runRootDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8")
  writeFileSync(join(runRootDir, "summary.md"), formatRunSummaryMarkdown(meta, summary), "utf-8")

  console.log(`[eval run] 完了: ${runRootDir}`)
  return { runRootDir, meta, summary, stoppedByBudget, stoppedByError }
}

export async function metricsCommand(targetPath, flags) {
  if (!targetPath) throw new Error("metrics には対象ディレクトリを指定してください")
  const dir = resolve(targetPath)
  const metaPath = join(dir, "meta.json")
  const chapters = flags.chapters ? parseChapterRange(flags.chapters) : null

  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"))
    const chs = chapters ?? meta.chapters ?? [1, 2, 3]
    const byExample = {}
    for (const ex of meta.examples ?? ALL_EXAMPLES) {
      const targetRuns = Array.isArray(meta.completedRuns?.[ex])
        ? meta.completedRuns[ex]
        : Array.from({ length: meta.runs ?? 1 }, (_, i) => i + 1)
      const list = []
      for (const r of targetRuns) {
        const workDir = join(dir, ex, `run-${r}`)
        if (!existsSync(workDir)) continue
        list.push(await collectProjectMetrics(workDir, chs))
      }
      byExample[ex] = { runs: list, aggregate: aggregateRunsMetrics(list) }
    }
    const all = Object.values(byExample).flatMap((x) => x.runs)
    const summary = { byExample, overall: aggregateRunsMetrics(all) }
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8")
    writeFileSync(join(dir, "summary.md"), formatRunSummaryMarkdown(meta, summary), "utf-8")
    console.log(formatRunSummaryMarkdown(meta, summary))
    return { summary }
  }

  // 単体プロジェクトディレクトリ（OpenCode 手動実行結果など）
  const chs = chapters ?? [1, 2, 3]
  const m = await collectProjectMetrics(dir, chs)
  console.log(JSON.stringify(m, null, 2))
  return { metrics: m }
}

export async function compareCommand(dirAPath, dirBPath, flags, deps = {}) {
  if (!dirAPath || !dirBPath) throw new Error("compare には <runDirA> <runDirB> の2つを指定してください")
  const dirA = resolve(dirAPath)
  const dirB = resolve(dirBPath)
  const metaA = JSON.parse(readFileSync(join(dirA, "meta.json"), "utf-8"))
  const metaB = JSON.parse(readFileSync(join(dirB, "meta.json"), "utf-8"))

  const dryRun = isTruthyFlag(flags["dry-run"])
  const criteria = String(flags.criteria ?? "improve")
  if (criteria !== "improve" && criteria !== "simplify") {
    throw new Error(`--criteria は improve または simplify を指定してください: ${criteria}`)
  }
  const primaryAxis = String(flags["primary-axis"] ?? "buildup_and_payoff")
  const judgeModel =
    flags["judge-model"] ?? process.env.EVAL_JUDGE_MODEL ?? process.env.OPENAI_MODEL ?? (dryRun ? "dry-run-judge" : "")
  if (!judgeModel) {
    throw new Error("--judge-model（または環境変数 EVAL_JUDGE_MODEL / OPENAI_MODEL）を指定してください")
  }
  const judgeApiKeyEnv = String(flags["judge-api-key-env"] ?? "OPENAI_API_KEY")
  const judgeApiKey = dryRun ? "dry-run-key" : process.env[judgeApiKeyEnv] ?? ""
  if (!dryRun && !judgeApiKey) {
    throw new Error(`環境変数 ${judgeApiKeyEnv} が未設定です`)
  }
  const judgeBaseUrl =
    flags["judge-base-url"] ?? process.env.EVAL_JUDGE_BASE_URL ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL
  const judgeTemperature = parseTemperatureOption(flags["judge-temperature"], 0)
  const judgeMaxTokens = parseOptionalNumber(flags["judge-max-tokens"], "judge-max-tokens")
  const judgeExtraBody = parseExtraBodyOption(flags["judge-extra-body"])
  const judgeTimeoutMs =
    parsePositiveNumber(flags["judge-timeout-ms"] ?? flags["timeout-ms"], "judge-timeout-ms") ?? DEFAULT_TIMEOUT_MS
  const budget = buildBudget(flags)

  // 最新基準で両ランの「完了済みかつ両方そろう試行」のみをペアリングする
  const commonExamples = (metaA.examples ?? []).filter((e) => (metaB.examples ?? []).includes(e))
  const commonChapters = metaA.chapters ?? [1, 2, 3]
  const getCompletedRuns = (meta, ex) =>
    Array.isArray(meta.completedRuns?.[ex])
      ? meta.completedRuns[ex]
      : Array.from({ length: meta.runs ?? 1 }, (_, i) => i + 1)

  const pairedPlan = []
  const excludedPairWarnings = []
  for (const ex of commonExamples) {
    const runsA = getCompletedRuns(metaA, ex)
    const runsB = getCompletedRuns(metaB, ex)
    const setB = new Set(runsB)
    const matched = runsA.filter(
      (r) => setB.has(r) && existsSync(join(dirA, ex, `run-${r}`)) && existsSync(join(dirB, ex, `run-${r}`)),
    )
    const plannedMax = Math.max(metaA.runs ?? 0, metaB.runs ?? 0)
    if (matched.length < plannedMax || runsA.length < (metaA.runs ?? 0) || runsB.length < (metaB.runs ?? 0)) {
      excludedPairWarnings.push(
        `${ex}: 未完了または片側のみの試行を除外し、完了済み一致試行 [${matched.join(", ") || "なし"}] のみを比較しました（A完了: [${runsA.join(", ") || "なし"}] / B完了: [${runsB.join(", ") || "なし"}]）`,
      )
    }
    pairedPlan.push({ ex, runNumbers: matched })
  }

  const totalPlannedPairs = pairedPlan.reduce((sum, item) => sum + item.runNumbers.length, 0)
  if (totalPlannedPairs === 0) {
    throw new Error("完了済み試行の一致ペアが 0 件のため比較を実行できません（A・B の完了済み試行を確認してください）")
  }
  const plannedCalls = totalPlannedPairs * 2
  if (plannedCalls > budget.maxCalls) {
    throw new Error(
      `比較に必要な API コール数（${plannedCalls}回）が --max-calls（${budget.maxCalls}回）を超えています。`,
    )
  }

  const metricsListA = []
  const metricsListB = []
  const metricsListByExA = Object.fromEntries(commonExamples.map((ex) => [ex, []]))
  const metricsListByExB = Object.fromEntries(commonExamples.map((ex) => [ex, []]))
  const pairResults = []
  const callLlm =
    deps.callLlm ?? (dryRun ? createDryRunJudgeClient({ prefer: flags["dry-run-prefer"] ?? "tie" }) : undefined)
  let stoppedByBudget = false
  let budgetStopReason = null
  let stoppedByError = false
  let stopErrorMessage = null

  try {
    for (const { ex, runNumbers } of pairedPlan) {
      for (const r of runNumbers) {
        const workA = join(dirA, ex, `run-${r}`)
        const workB = join(dirB, ex, `run-${r}`)
        const mA = await collectProjectMetrics(workA, commonChapters)
        const mB = await collectProjectMetrics(workB, commonChapters)
        const judged = await judgePairSwapped({
          exampleName: ex,
          projectDirA: workA,
          projectDirB: workB,
          chapters: commonChapters,
          judgeLlmConfig: {
            baseUrl: judgeBaseUrl,
            apiKey: judgeApiKey,
            model: judgeModel,
            temperature: judgeTemperature,
            maxTokens: judgeMaxTokens,
            extraBody: judgeExtraBody,
            timeoutMs: judgeTimeoutMs,
          },
          budget,
          callLlm,
          pairLabel: `${ex}-run${r}`,
        })
        metricsListA.push(mA)
        metricsListB.push(mB)
        metricsListByExA[ex].push(mA)
        metricsListByExB[ex].push(mB)
        pairResults.push(judged)
      }
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      stoppedByBudget = true
      budgetStopReason = err.reason
      console.error(`[eval compare] ⚠️ ${err.message}`)
    } else {
      stoppedByError = true
      stopErrorMessage = err instanceof Error ? err.message : String(err)
      console.error(`[eval compare] ❌ 途中エラーのため完了済みペアを保存して停止しました: ${stopErrorMessage}`)
    }
  }

  const overallMetricsA = aggregateRunsMetrics(metricsListA)
  const overallMetricsB = aggregateRunsMetrics(metricsListB)
  const byExampleMetricsA = Object.fromEntries(
    commonExamples.map((ex) => [ex, aggregateRunsMetrics(metricsListByExA[ex])]),
  )
  const byExampleMetricsB = Object.fromEntries(
    commonExamples.map((ex) => [ex, aggregateRunsMetrics(metricsListByExB[ex])]),
  )
  const pairSummary = summarizePairJudgments(pairResults)
  const compatibility = checkRunCompatibility(metaA, metaB)
  for (const w of excludedPairWarnings) compatibility.warnings.push(w)
  if (stoppedByBudget) {
    compatibility.warnings.push(`審査が予算上限で途中停止しました（${budgetStopReason}）`)
  }
  if (stoppedByError) {
    compatibility.warnings.push(`審査が途中エラーで停止しました（${stopErrorMessage}）`)
  }
  const decision = evaluateDecision({
    criteria,
    primaryAxis,
    pairSummary,
    overallMetricsA,
    overallMetricsB,
  })
  const judgeBudget = budget.summary()

  const comparison = {
    createdAt: new Date().toISOString(),
    dirA,
    dirB,
    metaA,
    metaB,
    judgeTimeoutMs,
    stoppedByBudget,
    budgetStopReason,
    stoppedByError,
    stopErrorMessage,
    compatibility,
    overallMetricsA,
    overallMetricsB,
    byExampleMetricsA,
    byExampleMetricsB,
    pairSummary,
    decision,
    pairResults,
    judgeBudget,
  }
  const markdown = formatComparisonMarkdown(comparison)
  const outDir = resolve(
    flags.out ?? join(dirname(dirB), `compare-${basename(dirA)}-vs-${basename(dirB)}`),
  )
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, "comparison.json"), JSON.stringify(comparison, null, 2), "utf-8")
  writeFileSync(join(outDir, "comparison.md"), markdown, "utf-8")

  console.log(markdown)
  console.log(`\n[eval compare] 保存先: ${outDir}`)
  return { outDir, comparison, markdown, stoppedByBudget, stoppedByError }
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isDirectRun) {
  const { command, positionals, flags } = parseCliArgs(process.argv.slice(2))
  if (!command || flags.help || command === "help") {
    printHelp()
    process.exit(0)
  }
  ;(async () => {
    if (command === "run") {
      const res = await runCommand(flags)
      if (res.stoppedByBudget) process.exit(2)
      if (res.stoppedByError) process.exit(1)
    } else if (command === "metrics") {
      await metricsCommand(positionals[0], flags)
    } else if (command === "compare") {
      const res = await compareCommand(positionals[0], positionals[1], flags)
      if (res.stoppedByBudget) process.exit(2)
      if (res.stoppedByError) process.exit(1)
    } else {
      console.error(`未対応のサブコマンドです: ${command}`)
      printHelp()
      process.exit(1)
    }
  })().catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
