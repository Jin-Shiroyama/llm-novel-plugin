/**
 * 位置スワップ付き LLM ペア比較審査・確定率 d ＆偽陽性率目安・事前採否判定モジュール
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { callChatCompletion } from "./llm-client.mjs"
import { PROSE_METRIC_RULES } from "./metrics.mjs"

export const EVAL_AXES = ["buildup_and_payoff", "tone_and_ng", "character_voice", "overall"]

/** 書けた話の文字数ズレ（絶対値平均）の許容悪化幅（ポイント未満。+8.0pt 以上悪化で不合格） */
export const WORD_DEVIATION_REGRESSION_TOLERANCE_PT = 8.0

export const AXIS_LABELS = {
  buildup_and_payoff: "溜めと見返り（平坦化チェック）",
  tone_and_ng: "トーン適合・NGライン遵守",
  character_voice: "キャラ立ち・ことばづかい",
  overall: "総合的な面白さ・引き",
}

const PROSE_RULE_LABELS = {
  "stock-phrase": "できあいの言い回し (stock-phrase)",
  "preachy-ending": "教訓まとめ (preachy-ending)",
  "closing-cliche": "話末の定型締め (closing-cliche)",
  "repeated-ending": "文末連続 (repeated-ending)",
  "long-sentence": "長い文 (long-sentence)",
  "cross-chapter-repeat": "話またぎ重複 (cross-chapter-repeat)",
}

/** 二項係数 C(n, k) */
function nCk(n, k) {
  if (k < 0 || k > n) return 0
  let res = 1
  for (let i = 1; i <= Math.min(k, n - k); i++) {
    res = (res * (n - i + 1)) / i
  }
  return res
}

/** 帰無仮説下で勝敗確定率 d のとき、B 側が totalPairs 中 requiredWins 勝以上する片側誤採用確率 */
export function computeFalsePositiveRate(totalPairs, requiredWins, decidedRate) {
  if (!Number.isFinite(totalPairs) || totalPairs <= 0) return null
  if (!Number.isFinite(decidedRate) || decidedRate <= 0) return 0
  const pWin = Math.min(1, Math.max(0, decidedRate)) / 2
  let prob = 0
  for (let w = requiredWins; w <= totalPairs; w++) {
    prob += nCk(totalPairs, w) * Math.pow(pWin, w) * Math.pow(1 - pWin, totalPairs - w)
  }
  return Number(prob.toFixed(4))
}

/** 位置入れ替え 2 回（Pass 1: X=A/Y=B、Pass 2: X=B/Y=A）の勝敗を統合する */
export function resolveSwappedVote(pass1Winner, pass2Winner) {
  const norm = (v) => {
    const s = String(v ?? "").trim().toUpperCase()
    if (s === "X" || s === "Y") return s
    return "TIE"
  }
  const p1 = norm(pass1Winner)
  const p2 = norm(pass2Winner)

  if (p1 === "X" && p2 === "Y") return { outcome: "A", decided: true }
  if (p1 === "Y" && p2 === "X") return { outcome: "B", decided: true }
  if (p1 === "TIE" && p2 === "TIE") return { outcome: "tie", decided: false }
  return { outcome: "tie_position_sensitive", decided: false }
}

/** 審査 LLM の JSON 応答をパースする */
export function parseJudgeResponse(raw) {
  const text = String(raw ?? "").trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  let candidate = fenced ? fenced[1].trim() : text
  const first = candidate.indexOf("{")
  const last = candidate.lastIndexOf("}")
  if (first !== -1 && last > first) {
    candidate = candidate.slice(first, last + 1)
  }
  const parsed = JSON.parse(candidate)
  const out = {}
  for (const axis of EVAL_AXES) {
    const entry = parsed?.[axis]
    const winner = typeof entry === "string" ? entry : entry?.winner
    const reason = typeof entry === "object" && entry ? String(entry.reason ?? "") : ""
    out[axis] = {
      winner: String(winner ?? "tie").trim(),
      reason,
    }
  }
  return out
}

function buildJudgeMessages({ exampleName, conceptMd, chaptersTextX, chaptersTextY }) {
  const system = [
    "あなたはライトノベル・Web小説の担当編集者です。2つの原稿（原稿X・原稿Y）を企画書と照らして公平に比較審査します。",
    "文章の長さや見た目の分量だけで有利不利をつけず、読者としての面白さ・溜めと見返り・トーン遵守・キャラ立ちを基準に判定してください。",
    "必ず指定の JSON 形式のみを返してください。",
  ].join("\n")

  const user = [
    `# 比較対象作品: ${exampleName}`,
    "",
    "## 企画書（フック・面白さ・トーン・摩擦・NGライン・文体見本）",
    conceptMd,
    "",
    "## 判定する 4 軸（各軸で \"X\" / \"Y\" / \"tie\" のいずれかと短い根拠を返す）",
    "1. buildup_and_payoff（溜めと見返り）: 起きた困りごと・照れ・制約が1〜2往復で都合よく即解決して平坦になっていないか。一拍の引っかかりの後に見返り・ごほうびがしっかり効いているか。",
    "2. tone_and_ng（トーン適合・NGライン遵守）: 企画書のシリアス度とNGラインを守っているか。頼まれていないシリアス化・重い過去の後付け・説教や教訓まとめ（「大切なことに気づいた」等）が無いか。",
    "3. character_voice（キャラ立ち・ことばづかい）: 名前を隠しても誰の台詞か分かるか。掛け合いのテンポと一人称・呼び方・口調が一貫しているか。",
    "4. overall（総合的な面白さ・引き）: ライトノベル・Web小説として読んで楽しく、次の話を開きたくなる引きや余韻が決まっているか。",
    "",
    "---",
    "# 原稿X",
    chaptersTextX,
    "",
    "---",
    "# 原稿Y",
    chaptersTextY,
    "",
    "---",
    "以下の JSON のみを返してください:",
    "```json",
    "{",
    '  "buildup_and_payoff": { "winner": "X|Y|tie", "reason": "1〜2文の具体的根拠" },',
    '  "tone_and_ng": { "winner": "X|Y|tie", "reason": "1〜2文の具体的根拠" },',
    '  "character_voice": { "winner": "X|Y|tie", "reason": "1〜2文の具体的根拠" },',
    '  "overall": { "winner": "X|Y|tie", "reason": "1〜2文の具体的根拠" }',
    "}",
    "```",
  ].join("\n")

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

function loadConcatenatedChapters(runDir, chapters) {
  const parts = []
  for (const ch of chapters) {
    const file = join(runDir, ".novel", "chapters", `chapter-${String(ch).padStart(3, "0")}.md`)
    if (!existsSync(file)) {
      parts.push(`## 第${ch}話\n（本文なし）`)
    } else {
      parts.push(readFileSync(file, "utf-8").trim())
    }
  }
  return parts.join("\n\n---\n\n")
}

function summarizeJudgeAttempt(attempt, res, failureType = null, failureReason = null) {
  const contentText = String(res?.content ?? "")
  return {
    attempt,
    finishReason: res?.finishReason ?? null,
    contentChars: contentText.length,
    completionTokens: Number.isFinite(res?.usage?.completionTokens) ? res.usage.completionTokens : null,
    reasoningTokens: Number.isFinite(res?.usage?.reasoningTokens) ? res.usage.reasoningTokens : null,
    reasoningChars: Number.isFinite(res?.reasoningChars) ? res.reasoningChars : 0,
    failureType,
    failureReason,
  }
}

async function callJudgePassWithRetry({ messages, judgeLlmConfig, budget, callLlm, label }) {
  const conv = [...messages]
  const attempts = []
  let emptyResponseRetries = 0
  let formatRetries = 0
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await callLlm({
      ...judgeLlmConfig,
      messages: conv,
      budget,
      label: attempt === 1 ? label : `${label}-retry`,
    })
    const rawContent = String(res.content ?? "")
    if (rawContent.trim().length === 0) {
      const isLengthTruncated = res.finishReason === "length"
      const reason = isLengthTruncated
        ? "空応答が返されました（finish_reason=length: 推論等で出力上限を使い切った可能性があります。--judge-max-tokens や --judge-extra-body の設定を見直してください）"
        : `空応答が返されました（content が空 / finish_reason=${res.finishReason ?? "unknown"}）`
      attempts.push(summarizeJudgeAttempt(attempt, res, "empty_response", reason))
      if (isLengthTruncated) {
        console.error(`[eval judge] ⚠️ ${label} attempt${attempt}: ${reason}`)
      }
      if (attempt === 2) {
        throw new Error(`審査応答が空のまま2回失敗しました（${label} / finish_reason=${res.finishReason ?? "unknown"}）: ${reason}`)
      }
      emptyResponseRetries++
      // 空応答では空の assistant メッセージを会話履歴へ積まず、元プロンプトをそのまま送り直す
      continue
    }

    try {
      const parsed = parseJudgeResponse(rawContent)
      attempts.push(summarizeJudgeAttempt(attempt, res, null, null))
      return { parsed, attempts, emptyResponseRetries, formatRetries }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      attempts.push(summarizeJudgeAttempt(attempt, res, "json_parse_error", reason))
      if (attempt === 2) {
        throw new Error(
          `審査応答の JSON 解析に2回失敗しました（${label} / finish_reason=${res.finishReason ?? "unknown"}）: ${reason}`,
        )
      }
      formatRetries++
      conv.push(
        { role: "assistant", content: rawContent },
        {
          role: "user",
          content: `前回の応答は JSON として解析できませんでした（${reason}）。指定された 4 軸を含む有効な JSON オブジェクトのみを返してください。`,
        },
      )
    }
  }
}

/** 1 ペア（A vs B）に対して位置入れ替え 2 回の審査を実行する */
export async function judgePairSwapped({
  exampleName,
  projectDirA,
  projectDirB,
  chapters,
  judgeLlmConfig,
  budget,
  callLlm = callChatCompletion,
  pairLabel = "pair",
}) {
  const conceptPath = join(projectDirA, ".novel", "concept.md")
  const conceptMd = existsSync(conceptPath) ? readFileSync(conceptPath, "utf-8") : ""
  const textA = loadConcatenatedChapters(projectDirA, chapters)
  const textB = loadConcatenatedChapters(projectDirB, chapters)

  // Pass 1: X = A, Y = B
  const pass1Res = await callJudgePassWithRetry({
    messages: buildJudgeMessages({ exampleName, conceptMd, chaptersTextX: textA, chaptersTextY: textB }),
    judgeLlmConfig,
    budget,
    callLlm,
    label: `judge-${pairLabel}-pass1`,
  })

  // Pass 2: X = B, Y = A
  const pass2Res = await callJudgePassWithRetry({
    messages: buildJudgeMessages({ exampleName, conceptMd, chaptersTextX: textB, chaptersTextY: textA }),
    judgeLlmConfig,
    budget,
    callLlm,
    label: `judge-${pairLabel}-pass2`,
  })

  const resolved = {}
  for (const axis of EVAL_AXES) {
    const vote = resolveSwappedVote(pass1Res.parsed[axis].winner, pass2Res.parsed[axis].winner)
    resolved[axis] = {
      ...vote,
      pass1: pass1Res.parsed[axis],
      pass2: pass2Res.parsed[axis],
    }
  }

  return {
    pairLabel,
    exampleName,
    axes: resolved,
    diagnostics: {
      pass1: {
        attempts: pass1Res.attempts,
        emptyResponseRetries: pass1Res.emptyResponseRetries,
        formatRetries: pass1Res.formatRetries,
      },
      pass2: {
        attempts: pass2Res.attempts,
        emptyResponseRetries: pass2Res.emptyResponseRetries,
        formatRetries: pass2Res.formatRetries,
      },
    },
  }
}

/** 複数ペアの審査結果から軸ごとの勝率・確定率 d・位置バイアス・誤判定確率目安を集計する */
export function summarizePairJudgments(pairResults, opts = {}) {
  const totalPairs = pairResults.length
  const requiredWinsForImprove = totalPairs > 0 ? Math.ceil(totalPairs * 0.75) : 0
  const requiredWinsForReject = requiredWinsForImprove
  const byAxis = {}

  let firstPositionWins = 0
  let secondPositionWins = 0
  let tiePassVotes = 0
  let judgeEmptyResponseRetries = 0
  let judgeFormatRetries = 0
  let judgeLengthTruncatedAttempts = 0
  let judgeTotalPasses = 0

  for (const pair of pairResults) {
    if (pair.diagnostics) {
      for (const passKey of ["pass1", "pass2"]) {
        const pd = pair.diagnostics[passKey]
        if (!pd) continue
        judgeTotalPasses++
        judgeEmptyResponseRetries += pd.emptyResponseRetries ?? 0
        judgeFormatRetries += pd.formatRetries ?? 0
        for (const a of pd.attempts ?? []) {
          if (a.finishReason === "length") judgeLengthTruncatedAttempts++
        }
      }
    }
  }

  for (const axis of EVAL_AXES) {
    let aWins = 0
    let bWins = 0
    let ties = 0
    let positionSensitiveTies = 0
    for (const pair of pairResults) {
      const axisEntry = pair.axes[axis]
      const outcome = axisEntry?.outcome
      if (outcome === "A") aWins++
      else if (outcome === "B") bWins++
      else if (outcome === "tie") ties++
      else positionSensitiveTies++

      // 各パスの先出し（X）勝率を集計（位置バイアス可視化用）
      for (const passKey of ["pass1", "pass2"]) {
        const w = axisEntry?.[passKey]?.winner
        if (w === undefined || w === null) continue
        const norm = String(w).trim().toUpperCase()
        if (norm === "X") firstPositionWins++
        else if (norm === "Y") secondPositionWins++
        else tiePassVotes++
      }
    }
    const decided = aWins + bWins
    const decidedRate = totalPairs > 0 ? Number((decided / totalPairs).toFixed(3)) : 0
    // 対称な 75% 基準のため、帰無仮説下の片側誤採用率（improve）と片側誤却下率（simplify 単軸）は同一式
    const falsePositiveRate = computeFalsePositiveRate(totalPairs, requiredWinsForImprove, decidedRate)
    const falseRejectRate = computeFalsePositiveRate(totalPairs, requiredWinsForReject, decidedRate)
    byAxis[axis] = {
      totalPairs,
      aWins,
      bWins,
      ties,
      positionSensitiveTies,
      decided,
      decidedRate,
      aWinRate: totalPairs > 0 ? Number((aWins / totalPairs).toFixed(3)) : 0,
      bWinRate: totalPairs > 0 ? Number((bWins / totalPairs).toFixed(3)) : 0,
      requiredWinsForImprove,
      requiredWinsForReject,
      falsePositiveRate,
      falseRejectRate,
      highFalsePositiveWarning: falsePositiveRate !== null && falsePositiveRate > (opts.maxFalsePositiveRate ?? 0.1),
    }
  }

  // simplify は tone_and_ng または overall のいずれかで A >= 75% のとき却下するため、独立近似の合算上限目安も算出
  let simplifyCombinedFalseRejectRate = null
  if (totalPairs > 0) {
    const pTone = byAxis.tone_and_ng?.falseRejectRate ?? 0
    const pOverall = byAxis.overall?.falseRejectRate ?? 0
    simplifyCombinedFalseRejectRate = Number((1 - (1 - pTone) * (1 - pOverall)).toFixed(4))
  }

  const nonTiePassVotes = firstPositionWins + secondPositionWins
  const positionBias = {
    firstPositionWins,
    secondPositionWins,
    tiePassVotes,
    nonTiePassVotes,
    firstPositionWinRate: nonTiePassVotes > 0 ? Number((firstPositionWins / nonTiePassVotes).toFixed(3)) : null,
  }

  return {
    totalPairs,
    requiredWinsForImprove,
    requiredWinsForReject,
    simplifyCombinedFalseRejectRate,
    positionBias,
    judgeDiagnostics: {
      totalPasses: judgeTotalPasses,
      emptyResponseRetries: judgeEmptyResponseRetries,
      formatRetries: judgeFormatRetries,
      lengthTruncatedAttempts: judgeLengthTruncatedAttempts,
    },
    byAxis,
  }
}

/** 2 つの run のメタデータ条件差を検査し、意図しない混入があれば警告を返す */
export function checkRunCompatibility(metaA, metaB) {
  const warnings = []
  const notes = []

  if (metaA?.git?.dirty) warnings.push(`A（${metaA.label}）は未コミット変更がある状態で計測されています`)
  if (metaB?.git?.dirty) warnings.push(`B（${metaB.label}）は未コミット変更がある状態で計測されています`)
  if (metaA?.stoppedByBudget) warnings.push(`A（${metaA.label}）は予算上限で途中停止しています`)
  if (metaB?.stoppedByBudget) warnings.push(`B（${metaB.label}）は予算上限で途中停止しています`)
  if (metaA?.stoppedByError) {
    warnings.push(`A（${metaA.label}）はエラーで途中停止しています（${metaA.stopErrorMessage ?? "詳細不明"}）`)
  }
  if (metaB?.stoppedByError) {
    warnings.push(`B（${metaB.label}）はエラーで途中停止しています（${metaB.stopErrorMessage ?? "詳細不明"}）`)
  }
  if (metaA?.artifacts?.staleDistBypassed) {
    warnings.push(`A（${metaA.label}）は --allow-stale-dist で古いビルドの警告を無視して計測されています`)
  }
  if (metaB?.artifacts?.staleDistBypassed) {
    warnings.push(`B（${metaB.label}）は --allow-stale-dist で古いビルドの警告を無視して計測されています`)
  }
  if (Boolean(metaA?.dryRun) !== Boolean(metaB?.dryRun)) {
    warnings.push(`dryRun 条件が異なります（A: ${Boolean(metaA?.dryRun)} / B: ${Boolean(metaB?.dryRun)}）`)
  }
  const sameWriterTemp = metaA?.writerTemperature === metaB?.writerTemperature
  if (!sameWriterTemp) {
    warnings.push(`書き手 temperature が異なります（A: ${metaA?.writerTemperature} / B: ${metaB?.writerTemperature}）`)
  }
  const sameWriterMaxTokens = (metaA?.writerMaxTokens ?? null) === (metaB?.writerMaxTokens ?? null)
  if (!sameWriterMaxTokens) {
    warnings.push(
      `書き手 maxTokens が異なります（A: ${metaA?.writerMaxTokens ?? "未指定"} / B: ${metaB?.writerMaxTokens ?? "未指定"}）`,
    )
  }
  const sameWriterExtraBody =
    JSON.stringify(metaA?.writerExtraBody ?? {}) === JSON.stringify(metaB?.writerExtraBody ?? {})
  if (!sameWriterExtraBody) {
    warnings.push("書き手 extraBody の指定が異なります")
  }
  const sameWriterBaseUrl = (metaA?.writerBaseUrl ?? null) === (metaB?.writerBaseUrl ?? null)
  if (!sameWriterBaseUrl) {
    warnings.push(`書き手 baseUrl が異なります（A: ${metaA?.writerBaseUrl ?? "未指定"} / B: ${metaB?.writerBaseUrl ?? "未指定"}）`)
  }
  const sameWriterTimeout = (metaA?.writerTimeoutMs ?? null) === (metaB?.writerTimeoutMs ?? null)
  if (!sameWriterTimeout) {
    warnings.push(
      `書き手 timeoutMs が異なります（A: ${metaA?.writerTimeoutMs ?? "未指定"} / B: ${metaB?.writerTimeoutMs ?? "未指定"}）`,
    )
  }

  const sameExamples = JSON.stringify(metaA?.examples ?? []) === JSON.stringify(metaB?.examples ?? [])
  if (!sameExamples) {
    warnings.push(
      `対象見本が一致していません（A: ${(metaA?.examples ?? []).join(",")} / B: ${(metaB?.examples ?? []).join(",")}）`,
    )
  }
  const sameChapters = JSON.stringify(metaA?.chapters ?? []) === JSON.stringify(metaB?.chapters ?? [])
  if (!sameChapters) {
    warnings.push(
      `対象話数が一致していません（A: ${(metaA?.chapters ?? []).join(",")} / B: ${(metaB?.chapters ?? []).join(",")}）`,
    )
  }
  if ((metaA?.runs ?? 0) !== (metaB?.runs ?? 0)) {
    warnings.push(`試行数が異なります（A: ${metaA?.runs} / B: ${metaB?.runs}）。完了済み一致試行のみでペアリングします`)
  }
  const sameWriterModel = metaA?.writerModel === metaB?.writerModel
  if (!sameWriterModel) {
    warnings.push(`書き手モデル指定が異なります（A: ${metaA?.writerModel} / B: ${metaB?.writerModel}）`)
  }

  const respA = [...new Set(metaA?.budget?.responseModels ?? [])].sort()
  const respB = [...new Set(metaB?.budget?.responseModels ?? [])].sort()
  const sameResponseModels =
    respA.length === 0 || respB.length === 0 || JSON.stringify(respA) === JSON.stringify(respB)
  if (!sameResponseModels) {
    warnings.push(`API 応答の解決モデルが異なります（A: ${respA.join(",")} / B: ${respB.join(",")}）`)
  }

  const sameWriterConfig =
    sameWriterModel &&
    sameResponseModels &&
    sameWriterBaseUrl &&
    sameWriterTemp &&
    sameWriterMaxTokens &&
    sameWriterExtraBody &&
    sameWriterTimeout

  const hasCommits = Boolean(metaA?.git?.commit && metaB?.git?.commit)
  const sameCommit = hasCommits && metaA.git.commit === metaB.git.commit
  const sameVariant = metaA?.skillVariant === metaB?.skillVariant

  // no-ban-list A/B のはずなのに commit も違う場合は、別変更の効果混入を警告
  if (!sameVariant && hasCommits && !sameCommit) {
    warnings.push(
      `skillVariant（A: ${metaA.skillVariant} / B: ${metaB.skillVariant}）だけでなく git commit（A: ${metaA.git.shortCommit} / B: ${metaB.git.shortCommit}）も異なっています。別変更の効果が混ざるおそれがあります`,
    )
  }

  // dist/ および skills/ の実体指紋（SHA-256）の整合性確認
  const artifactsComparable = Boolean(metaA?.artifacts && metaB?.artifacts)
  const sameDist = artifactsComparable && metaA.artifacts.distHash === metaB.artifacts.distHash
  const sameSkills = artifactsComparable && metaA.artifacts.skillsHash === metaB.artifacts.skillsHash
  const sameArtifacts = !artifactsComparable || (sameDist && sameSkills)

  if (hasCommits && !sameCommit && artifactsComparable && sameDist && sameSkills) {
    warnings.push(
      `git commit は異なりますが、dist/ と skills/ の指紋が完全に一致しています（pnpm build のし忘れ、または文書のみの変更か確認してください）`,
    )
  }
  if (sameCommit && sameVariant && artifactsComparable && (!sameDist || !sameSkills)) {
    warnings.push(
      `同一コミット・同一スキル変種の比較ですが、dist/ または skills/ の指紋が異なっています（未コミット変更またはビルド差分の混入を確認してください）`,
    )
  }

  const hashesA = JSON.stringify(metaA?.systemPromptHashes ?? {})
  const hashesB = JSON.stringify(metaB?.systemPromptHashes ?? {})
  let comparisonType = "ab_comparison"
  if (sameCommit && sameVariant && hashesA === hashesB && sameArtifacts) {
    if (sameWriterConfig) {
      comparisonType = "aa_test"
      notes.push(
        "同一コミット・同一スキル条件・同一成果物指紋・同一システムプロンプトハッシュ・同一書き手設定のため、A/A テスト条件として比較しています",
      )
    } else {
      comparisonType = "model_or_config_comparison"
      notes.push(
        "同一コード・同一スキル条件ですが書き手モデルまたは生成設定が異なるため、モデル／設定比較として集計しています（プラグイン採否基準の直接適用対象外・参考表示）",
      )
    }
  } else if (hasCommits && !sameCommit && artifactsComparable && !sameDist && sameVariant && hashesA === hashesB) {
    notes.push("システムプロンプトハッシュは同一ですが dist/ の指紋が異なっています（コード側変更の比較として実行しています）")
  } else if (sameVariant && hashesA === hashesB && !(hasCommits && !sameCommit && artifactsComparable && sameDist && sameSkills)) {
    warnings.push("比較する2つの run のシステムプロンプトハッシュが完全に同一です（コード側のみの変更か確認してください）")
  }

  return { warnings, notes, comparisonType, sameWriterConfig }
}

/** 事前採否基準（improve / simplify）に従って目安判定を算出する */
export function evaluateDecision({
  criteria = "improve",
  primaryAxis = "buildup_and_payoff",
  pairSummary,
  overallMetricsA,
  overallMetricsB,
}) {
  const reasons = []
  let mechanicalRegression = false

  if (overallMetricsB.typographyErrorsTotal > overallMetricsA.typographyErrorsTotal) {
    mechanicalRegression = true
    reasons.push(
      `表記 ❌ が増加（A: ${overallMetricsA.typographyErrorsTotal}件 → B: ${overallMetricsB.typographyErrorsTotal}件）`,
    )
  }
  const missingA = overallMetricsA.missingChaptersTotal ?? 0
  const missingB = overallMetricsB.missingChaptersTotal ?? 0
  if (missingB > missingA) {
    mechanicalRegression = true
    reasons.push(`執筆・保存失敗による欠落話数が増加（A: ${missingA}話 → B: ${missingB}話）`)
  }
  if (overallMetricsB.statusWarningsTotal > overallMetricsA.statusWarningsTotal) {
    mechanicalRegression = true
    reasons.push(
      `記録警告 ⚠️ が増加（A: ${overallMetricsA.statusWarningsTotal}件 → B: ${overallMetricsB.statusWarningsTotal}件）`,
    )
  }

  // 文字数判定は範囲外件数の厳密比較ではなく、書けた話の文字数ズレ（絶対値平均）が A より +8pt 以上悪化したかで判定する
  const wordDevA =
    overallMetricsA.meanAbsWordDeviationPctWrittenAvg !== undefined
      ? overallMetricsA.meanAbsWordDeviationPctWrittenAvg
      : overallMetricsA.meanAbsWordDeviationPctAvg
  const wordDevB =
    overallMetricsB.meanAbsWordDeviationPctWrittenAvg !== undefined
      ? overallMetricsB.meanAbsWordDeviationPctWrittenAvg
      : overallMetricsB.meanAbsWordDeviationPctAvg
  if (Number.isFinite(wordDevA) && Number.isFinite(wordDevB)) {
    const wordDevDeltaPt = Number((wordDevB - wordDevA).toFixed(1))
    if (wordDevDeltaPt >= WORD_DEVIATION_REGRESSION_TOLERANCE_PT) {
      mechanicalRegression = true
      reasons.push(
        `書けた話の文字数ズレ（絶対値平均）が +${WORD_DEVIATION_REGRESSION_TOLERANCE_PT}pt 以上悪化（A: ${wordDevA.toFixed(1)}% → B: ${wordDevB.toFixed(1)}% / 差 +${wordDevDeltaPt.toFixed(1)}pt）`,
      )
    }
  }

  const toneAxis = pairSummary.byAxis.tone_and_ng
  const overallAxis = pairSummary.byAxis.overall

  if (criteria === "simplify") {
    const densityA = overallMetricsA.proseWarningsPer1kCharsAvg
    const densityB = overallMetricsB.proseWarningsPer1kCharsAvg
    const allowedDensity = Math.max(densityA * 1.2, densityA + 0.3)
    const densityRegressed = densityB > allowedDensity
    if (densityRegressed) {
      reasons.push(
        `文章 ⚠️ 密度が許容上限を超過（A: ${densityA.toFixed(3)} → B: ${densityB.toFixed(3)} / 上限 ${allowedDensity.toFixed(3)} 件/1,000字）`,
      )
    }

    // 禁止表現リスト削減の影響が長い文などのノイズに埋もれないよう、stock-phrase 密度も個別監視する
    const stockA = overallMetricsA.proseByRulePer1kCharsAvg?.["stock-phrase"]
    const stockB = overallMetricsB.proseByRulePer1kCharsAvg?.["stock-phrase"]
    let stockRegressed = false
    if (Number.isFinite(stockA) && Number.isFinite(stockB)) {
      const allowedStock = Math.max(stockA * 1.2, stockA + 0.2)
      if (stockB > allowedStock) {
        stockRegressed = true
        reasons.push(
          `できあいの言い回し（stock-phrase）⚠️ 密度が許容上限を超過（A: ${stockA.toFixed(3)} → B: ${stockB.toFixed(3)} / 上限 ${allowedStock.toFixed(3)} 件/1,000字）`,
        )
      }
    }

    const requiredWinsForReject = pairSummary.requiredWinsForReject ?? pairSummary.requiredWinsForImprove
    const toneRegressed = pairSummary.totalPairs > 0 && toneAxis.aWins >= requiredWinsForReject
    const overallRegressed = pairSummary.totalPairs > 0 && overallAxis.aWins >= requiredWinsForReject
    if (toneRegressed) {
      reasons.push(
        `tone_and_ng で A が却下基準以上勝利（A ${toneAxis.aWins}勝 / ${pairSummary.totalPairs}ペア、却下基準 ${requiredWinsForReject}勝以上）`,
      )
    }
    if (overallRegressed) {
      reasons.push(
        `overall で A が却下基準以上勝利（A ${overallAxis.aWins}勝 / ${pairSummary.totalPairs}ペア、却下基準 ${requiredWinsForReject}勝以上）`,
      )
    }

    if (mechanicalRegression || densityRegressed || stockRegressed || toneRegressed || overallRegressed) {
      return { verdict: "REJECT_REGRESSION", criteria, primaryAxis, reasons }
    }
    if (pairSummary.totalPairs === 0) {
      reasons.push("完了した比較ペアが 0 件のため採否を判定できません")
      return { verdict: "HOLD_NO_DIFF", criteria, primaryAxis, reasons }
    }
    reasons.push(
      `機械指標・文章 ⚠️ 密度（全体・stock-phrase）の悪化がなく、tone_and_ng・overall のいずれも A 側 75%（${requiredWinsForReject}勝/${pairSummary.totalPairs}ペア）以上の却下基準に該当しない（非劣性基準を満たす）`,
    )
    return { verdict: "ADOPT_CANDIDATE", criteria, primaryAxis, reasons }
  }

  // improve 基準
  const mainAxis = pairSummary.byAxis[primaryAxis]
  const requiredWins = pairSummary.requiredWinsForImprove
  const toneLost = toneAxis.bWins < toneAxis.aWins
  if (toneLost) {
    reasons.push(`安全軸 tone_and_ng で負け越し（A ${toneAxis.aWins}勝 vs B ${toneAxis.bWins}勝）`)
  }
  if (mechanicalRegression || toneLost) {
    return { verdict: "REJECT_REGRESSION", criteria, primaryAxis, reasons }
  }
  if (pairSummary.totalPairs === 0) {
    reasons.push("完了した比較ペアが 0 件のため採否を判定できません")
    return { verdict: "HOLD_NO_DIFF", criteria, primaryAxis, reasons }
  }
  if (mainAxis.bWins >= requiredWins) {
    reasons.push(
      `主軸 ${primaryAxis} で基準達成（B ${mainAxis.bWins}勝 / ${pairSummary.totalPairs}ペア、必要 ${requiredWins}勝以上）かつ tone_and_ng 負け越しなし`,
    )
    return { verdict: "ADOPT_CANDIDATE", criteria, primaryAxis, reasons }
  }
  reasons.push(
    `主軸 ${primaryAxis} が基準未達（B ${mainAxis.bWins}勝 / ${pairSummary.totalPairs}ペア、必要 ${requiredWins}勝以上）のため差なし（現状維持）`,
  )
  return { verdict: "HOLD_NO_DIFF", criteria, primaryAxis, reasons }
}

function fmtSigned(val, digits, suffix = "") {
  if (!Number.isFinite(val)) return "n/a"
  return `${val >= 0 ? "+" : ""}${val.toFixed(digits)}${suffix}`
}

function fmtStyleCell(absVal, signedVal, digits, scale = 1, suffix = "") {
  if (!Number.isFinite(absVal)) return "n/a"
  const absText = `${(absVal * scale).toFixed(digits)}${suffix}`
  if (!Number.isFinite(signedVal)) return absText
  return `${absText} (平均 ${fmtSigned(signedVal * scale, digits, suffix)})`
}

function fmtPctOrNa(val) {
  return Number.isFinite(val) ? `${val.toFixed(1)}%` : "n/a"
}

function formatRunMetaLine(tag, meta) {
  const fp = meta.artifacts
    ? ` / dist=${meta.artifacts.distHash?.slice(0, 12) ?? "n/a"} / skills=${meta.artifacts.skillsHash?.slice(0, 12) ?? "n/a"}`
    : ""
  const st = meta.executionStats
    ? ` / 話内訳(ok=${stStr(meta.executionStats.okChapters)}, partial=${stStr(meta.executionStats.partialRecordErrorChapters)}, fail=${stStr(meta.executionStats.failedChapters)}, retry[fmt=${stStr(meta.executionStats.writerFormatRetries ?? meta.executionStats.writerRetries)},empty=${stStr(meta.executionStats.emptyResponseRetries)},r=${stStr(meta.executionStats.recordRetries)},api=${stStr(meta.executionStats.transientApiRetries)}])`
    : ""
  return `- **${tag} (${meta.label})**: commit=${meta.git?.shortCommit ?? "unknown"}${meta.git?.dirty ? " (dirty)" : ""}${fp} / skillVariant=${meta.skillVariant} / writer=${meta.writerModel} (応答: ${(meta.budget?.responseModels ?? []).join(", ") || "n/a"}) / runs=${meta.runs}${st}`
}

function stStr(n) {
  return Number.isFinite(n) ? String(n) : "0"
}

/** 比較結果を Markdown レポートへ整形する */
export function formatComparisonMarkdown({
  metaA,
  metaB,
  compatibility,
  overallMetricsA,
  overallMetricsB,
  byExampleMetricsA = null,
  byExampleMetricsB = null,
  pairSummary,
  decision,
  pairResults,
  judgeBudget,
}) {
  const jd = pairSummary.judgeDiagnostics
  const judgeRetryParts = []
  if ((jd?.formatRetries ?? 0) > 0) judgeRetryParts.push(`JSON再試行=${jd.formatRetries}`)
  if ((jd?.emptyResponseRetries ?? 0) > 0) judgeRetryParts.push(`空応答再試行=${jd.emptyResponseRetries}`)
  if ((jd?.lengthTruncatedAttempts ?? 0) > 0) judgeRetryParts.push(`length打切=${jd.lengthTruncatedAttempts}`)
  if ((judgeBudget.transientRetries ?? 0) > 0) judgeRetryParts.push(`一時障害再試行=${judgeBudget.transientRetries}`)
  if ((judgeBudget.failedCalls ?? 0) > 0) judgeRetryParts.push(`失敗呼出=${judgeBudget.failedCalls}`)
  const judgeRetryNote = judgeRetryParts.length > 0 ? ` (${judgeRetryParts.join(", ")})` : ""

  const lines = [
    `# 評価比較レポート: A (${metaA.label}) vs B (${metaB.label})`,
    "",
    "## 実行メタデータ",
    formatRunMetaLine("A", metaA),
    formatRunMetaLine("B", metaB),
    `- **比較ペア数**: ${pairResults.length} ペア`,
    `- **審査コスト**: calls=${judgeBudget.calls}${judgeRetryNote} / totalTokens=${judgeBudget.totalTokens}${judgeBudget.estimatedCostUsd !== null ? ` / estCost=$${judgeBudget.estimatedCostUsd.toFixed(4)}` : ""} / judgeModels=${(judgeBudget.responseModels ?? []).join(", ") || "n/a"}`,
    "",
  ]

  if ((jd?.lengthTruncatedAttempts ?? 0) > 0) {
    lines.push(
      `> ⚠️ 審査応答で \`finish_reason=length\` が ${jd.lengthTruncatedAttempts} 回発生しています。\`--judge-max-tokens\` や \`--judge-extra-body\` で推論量・出力上限を見直してください。`,
      "",
    )
  }

  if (compatibility.notes.length > 0) {
    lines.push("### 条件メモ")
    for (const n of compatibility.notes) lines.push(`- ℹ️ ${n}`)
    lines.push("")
  }
  if (compatibility.warnings.length > 0) {
    lines.push("### ⚠️ 条件差の警告")
    for (const w of compatibility.warnings) lines.push(`- ⚠️ ${w}`)
    lines.push("")
  }

  const proseRuleRows = PROSE_METRIC_RULES.map((rule) => {
    const aVal = overallMetricsA.proseByRulePer1kCharsAvg?.[rule] ?? 0
    const bVal = overallMetricsB.proseByRulePer1kCharsAvg?.[rule] ?? 0
    return `| 　└ ${PROSE_RULE_LABELS[rule] ?? rule} | ${aVal.toFixed(3)} | ${bVal.toFixed(3)} |`
  })

  const dA = overallMetricsA.styleDriftAvg
  const dB = overallMetricsB.styleDriftAvg
  const styleRows =
    dA && dB
      ? [
          `| 文体見本ズレ：1文平均 絶対値平均（字） | ${fmtStyleCell(dA.meanSentenceCharsAbsDelta, dA.signed?.meanSentenceCharsDelta, 1)} | ${fmtStyleCell(dB.meanSentenceCharsAbsDelta, dB.signed?.meanSentenceCharsDelta, 1)} |`,
          `| 文体見本ズレ：会話文字比率 絶対値平均（pt） | ${fmtStyleCell(dA.dialogueCharRatioAbsDelta, dA.signed?.dialogueCharRatioDelta, 1, 100, "pt")} | ${fmtStyleCell(dB.dialogueCharRatioAbsDelta, dB.signed?.dialogueCharRatioDelta, 1, 100, "pt")} |`,
          `| 文体見本ズレ：段落平均文数 絶対値平均 | ${fmtStyleCell(dA.meanParagraphSentencesAbsDelta, dA.signed?.meanParagraphSentencesDelta, 2)} | ${fmtStyleCell(dB.meanParagraphSentencesAbsDelta, dB.signed?.meanParagraphSentencesDelta, 2)} |`,
          `| 文体見本ズレ：過去形(た/だ)比率 絶対値平均（pt） | ${fmtStyleCell(dA.pastTaRatioAbsDelta, dA.signed?.pastTaRatioDelta, 1, 100, "pt")} | ${fmtStyleCell(dB.pastTaRatioAbsDelta, dB.signed?.pastTaRatioDelta, 1, 100, "pt")} |`,
        ]
      : []

  const criteriaDesc =
    decision.criteria === "improve"
      ? `（主軸: \`${decision.primaryAxis}\`、B 側 75% 以上勝利で採用）`
      : "（非劣性：A 側 75% 以上勝利または機械／密度悪化がなければ採用）"
  const isModelComparison = compatibility.comparisonType === "model_or_config_comparison"
  const decisionHeading = isModelComparison
    ? "## 事前採否基準による参考判定（モデル／生成設定比較のため採否基準の直接適用対象外）"
    : "## 事前採否基準による目安判定"

  const wordDevWrittenA =
    overallMetricsA.meanAbsWordDeviationPctWrittenAvg !== undefined
      ? overallMetricsA.meanAbsWordDeviationPctWrittenAvg
      : overallMetricsA.meanAbsWordDeviationPctAvg
  const wordDevWrittenB =
    overallMetricsB.meanAbsWordDeviationPctWrittenAvg !== undefined
      ? overallMetricsB.meanAbsWordDeviationPctWrittenAvg
      : overallMetricsB.meanAbsWordDeviationPctAvg

  lines.push(
    decisionHeading,
    `- **基準種別**: \`${decision.criteria}\`${criteriaDesc}`,
    `- **判定**: **${decision.verdict}**${isModelComparison ? "（参考値）" : ""}`,
    ...decision.reasons.map((r) => `- ${r}`),
    "",
    "## 機械指標の比較（完了済み一致試行の集計）",
    "| 指標 | A | B |",
    "|---|---:|---:|",
    `| 表記 ❌ 合計 | ${overallMetricsA.typographyErrorsTotal} | ${overallMetricsB.typographyErrorsTotal} |`,
    `| 欠落話数合計（執筆・保存失敗） | ${overallMetricsA.missingChaptersTotal ?? 0} | ${overallMetricsB.missingChaptersTotal ?? 0} |`,
    `| 文章 ⚠️ 密度（件/1,000字・合計平均） | ${overallMetricsA.proseWarningsPer1kCharsAvg.toFixed(3)} | ${overallMetricsB.proseWarningsPer1kCharsAvg.toFixed(3)} |`,
    ...proseRuleRows,
    `| 書けた話の文字数ズレ絶対値平均（%・判定対象、+${WORD_DEVIATION_REGRESSION_TOLERANCE_PT}pt未満許容） | ${fmtPctOrNa(wordDevWrittenA)} | ${fmtPctOrNa(wordDevWrittenB)} |`,
    `| 全話の文字数ズレ絶対値平均（%・欠落=100%含む参考） | ${overallMetricsA.meanAbsWordDeviationPctAvg.toFixed(1)}% | ${overallMetricsB.meanAbsWordDeviationPctAvg.toFixed(1)}% |`,
    `| 文字数目安 ±15% 逸脱話数合計（参考表示） | ${overallMetricsA.outOfRangeChaptersTotal} | ${overallMetricsB.outOfRangeChaptersTotal} |`,
    `| 記録警告 ⚠️ 合計 | ${overallMetricsA.statusWarningsTotal} | ${overallMetricsB.statusWarningsTotal} |`,
    ...styleRows,
  )

  // 作品別の文体見本ズレ（作品間で符号が逆の過去形比率などが打ち消し合わないよう個別表示）
  if (byExampleMetricsA && byExampleMetricsB) {
    const exNames = Object.keys(byExampleMetricsA).filter((ex) => byExampleMetricsB[ex])
    const exStyleRows = []
    for (const ex of exNames) {
      const sA = byExampleMetricsA[ex]?.styleDriftAvg
      const sB = byExampleMetricsB[ex]?.styleDriftAvg
      if (!sA || !sB) continue
      exStyleRows.push(
        `| ${ex}：1文平均（字） | ${fmtStyleCell(sA.meanSentenceCharsAbsDelta, sA.signed?.meanSentenceCharsDelta, 1)} | ${fmtStyleCell(sB.meanSentenceCharsAbsDelta, sB.signed?.meanSentenceCharsDelta, 1)} |`,
        `| ${ex}：会話文字比率（pt） | ${fmtStyleCell(sA.dialogueCharRatioAbsDelta, sA.signed?.dialogueCharRatioDelta, 1, 100, "pt")} | ${fmtStyleCell(sB.dialogueCharRatioAbsDelta, sB.signed?.dialogueCharRatioDelta, 1, 100, "pt")} |`,
        `| ${ex}：段落平均文数 | ${fmtStyleCell(sA.meanParagraphSentencesAbsDelta, sA.signed?.meanParagraphSentencesDelta, 2)} | ${fmtStyleCell(sB.meanParagraphSentencesAbsDelta, sB.signed?.meanParagraphSentencesDelta, 2)} |`,
        `| ${ex}：過去形(た/だ)比率（pt） | ${fmtStyleCell(sA.pastTaRatioAbsDelta, sA.signed?.pastTaRatioDelta, 1, 100, "pt")} | ${fmtStyleCell(sB.pastTaRatioAbsDelta, sB.signed?.pastTaRatioDelta, 1, 100, "pt")} |`,
      )
    }
    if (exStyleRows.length > 0) {
      lines.push("", "### 作品別の文体見本ズレ（絶対値平均・括弧内は符号付き平均）", "| 作品・指標 | A | B |", "|---|---:|---:|", ...exStyleRows)
    }
  }

  lines.push(
    "",
    "## LLM ペア比較（位置スワップ2回一致で確定）",
    "| 軸 | A勝 | B勝 | 合意分 | 位置依存分 | 確定率 d | 単軸誤判定目安 (75%基準・ペア審査分のみ) |",
    "|---|---:|---:|---:|---:|---:|---:|",
  )

  const highFpAxes = []
  for (const axis of EVAL_AXES) {
    const s = pairSummary.byAxis[axis]
    const fpText = s.falsePositiveRate === null ? "n/a" : `${(s.falsePositiveRate * 100).toFixed(1)}%`
    if (s.highFalsePositiveWarning) highFpAxes.push(`${axis} (d=${s.decidedRate}, 単軸目安 ${fpText})`)
    lines.push(
      `| ${AXIS_LABELS[axis]} (\`${axis}\`) | ${s.aWins} | ${s.bWins} | ${s.ties} | ${s.positionSensitiveTies} | ${(s.decidedRate * 100).toFixed(0)}% | ${fpText} |`,
    )
  }

  lines.push("")
  const pb = pairSummary.positionBias
  if (pb && pb.nonTiePassVotes > 0) {
    lines.push(
      `- **位置バイアス参考（先出し X 勝率）**: **${pb.firstPositionWins}/${pb.nonTiePassVotes} (${(pb.firstPositionWinRate * 100).toFixed(1)}%)**（引き分けパス: ${pb.tiePassVotes}件。位置スワップで誤勝ちは相殺されるが、偏りが強いと確定率 d と感度が下がります）`,
    )
  }

  if (decision.criteria === "simplify" && pairSummary.simplifyCombinedFalseRejectRate !== null) {
    lines.push(
      `- **\`simplify\` 2軸（\`tone_and_ng\` または \`overall\`）合算の誤却下確率上限目安（ペア審査分のみ）**: **${(pairSummary.simplifyCombinedFalseRejectRate * 100).toFixed(1)}%**（独立近似／却下基準: A 側 ${pairSummary.requiredWinsForReject}勝以上 / ${pairSummary.totalPairs}ペア。機械指標の揺れは含みません）`,
    )
  } else {
    lines.push("- ※上記の誤判定確率目安はペア審査分のみであり、機械指標の揺れは含みません。")
  }

  if (highFpAxes.length > 0) {
    lines.push(
      "",
      `> ⚠️ **誤判定確率警告（単軸 10% 超）**: ${highFpAxes.join("、")}。\`--runs\` を増やす（例: \`--runs 3\` 以上）か、審査モデル・軸定義の見直しを検討してください。`,
    )
  }

  if (metaA.skillVariant !== metaB.skillVariant) {
    lines.push(
      "",
      "## `no-ban-list` 比較の解釈注記",
      "- 本比較が測るのは `skills/novel-writing/SKILL.md` の表 A＋❌ 悪文例の有無による初回執筆への影響のみです。",
      "- 本番（OpenCode）では保存時・`novel_check` の ⚠️ が禁止語を名指しで返すため、本番全体での実効差はさらに小さくなり得ます。",
      "- 表 B（教訓まとめ禁止）と 96 行目注記は語を列挙したまま残しています。",
      "- `novel_context` の「直近で重なっている定型仕草」（`src/tools/context.ts`）は、どちらの条件でも語を名指しします。",
    )
  }

  lines.push("", "## ペアごとの詳細")
  for (const pair of pairResults) {
    lines.push(`### ${pair.pairLabel}（${pair.exampleName}）`)
    for (const axis of EVAL_AXES) {
      const a = pair.axes[axis]
      lines.push(`- **${axis}**: **${a.outcome}**（Pass1: ${a.pass1.winner}「${a.pass1.reason}」／Pass2: ${a.pass2.winner}「${a.pass2.reason}」）`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

/** --dry-run 用の決定論的審査モッククライアント */
export function createDryRunJudgeClient({ prefer = "tie" } = {}) {
  return async ({ budget, label, model = "dry-run-judge" }) => {
    budget?.assertCanCall(label)
    const isPass2 = label.endsWith("-pass2")
    let winner = "tie"
    if (prefer === "B") winner = isPass2 ? "X" : "Y"
    else if (prefer === "A") winner = isPass2 ? "Y" : "X"
    const payload = {}
    for (const axis of EVAL_AXES) {
      payload[axis] = { winner, reason: `dry-run (${prefer})` }
    }
    const content = JSON.stringify(payload)
    budget?.record({ label, promptTokens: 400, completionTokens: 120, totalTokens: 520, model, finishReason: "stop" })
    return {
      content,
      model,
      finishReason: "stop",
      reasoningChars: 0,
      usage: { promptTokens: 400, completionTokens: 120, totalTokens: 520, reasoningTokens: null },
      raw: { dryRun: true },
    }
  }
}
