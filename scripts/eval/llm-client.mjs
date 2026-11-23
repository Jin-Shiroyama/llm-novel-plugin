/**
 * 半自動評価ランナー用 OpenAI 互換 API クライアント＆予算ガード
 *
 * 外部 npm 依存を増やさず Node 標準 fetch のみで OpenAI 互換 Chat Completions API を呼び出す。
 * OpenRouter / LiteLLM / OpenAI / ローカル互換サーバー等から複数モデルを統一的に扱える。
 * - HTTP 429 / 5xx / タイムアウト・一時的ネットワーク障害は待機後に自動再試行（予算計上）
 * - 失敗した呼び出しのモデル名は responseModels へ記録しない
 */

export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const DEFAULT_MAX_CALLS = 60
export const DEFAULT_TIMEOUT_MS = 180_000
export const DEFAULT_TRANSIENT_RETRIES = 2
export const DEFAULT_RETRY_BASE_DELAY_MS = 2_000

export class BudgetExceededError extends Error {
  constructor(reason, summary) {
    super(`予算上限に達したため安全停止しました: ${reason}`)
    this.name = "BudgetExceededError"
    this.reason = reason
    this.summary = summary
  }
}

export class BudgetTracker {
  constructor(opts = {}) {
    this.maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS
    this.maxTotalTokens = opts.maxTotalTokens ?? Number.POSITIVE_INFINITY
    this.maxCostUsd = opts.maxCostUsd ?? Number.POSITIVE_INFINITY
    this.inputPricePer1M = opts.inputPricePer1M ?? null
    this.outputPricePer1M = opts.outputPricePer1M ?? null

    this.calls = 0
    this.failedCalls = 0
    this.transientRetries = 0
    this.promptTokens = 0
    this.completionTokens = 0
    this.totalTokens = 0
    this.responseModels = new Set()
    this.history = []
  }

  get estimatedCostUsd() {
    if (this.inputPricePer1M === null && this.outputPricePer1M === null) return null
    const inCost = ((this.inputPricePer1M ?? 0) * this.promptTokens) / 1_000_000
    const outCost = ((this.outputPricePer1M ?? 0) * this.completionTokens) / 1_000_000
    return inCost + outCost
  }

  assertCanCall(label = "api-call") {
    if (this.calls >= this.maxCalls) {
      throw new BudgetExceededError(
        `API 呼び出し回数が上限（${this.maxCalls}回）に到達しました（次: ${label}）`,
        this.summary(),
      )
    }
    if (this.totalTokens >= this.maxTotalTokens) {
      throw new BudgetExceededError(
        `累計トークン数（${this.totalTokens}）が上限（${this.maxTotalTokens}）に到達しました（次: ${label}）`,
        this.summary(),
      )
    }
    const cost = this.estimatedCostUsd
    if (cost !== null && cost >= this.maxCostUsd) {
      throw new BudgetExceededError(
        `推定費用（$${cost.toFixed(4)}）が上限（$${this.maxCostUsd.toFixed(4)}）に到達しました（次: ${label}）`,
        this.summary(),
      )
    }
  }

  record({
    label = "api-call",
    promptTokens = 0,
    completionTokens = 0,
    totalTokens,
    model = null,
    finishReason = null,
    failed = false,
    isTransientRetry = false,
  }) {
    const p = Number.isFinite(promptTokens) ? promptTokens : 0
    const c = Number.isFinite(completionTokens) ? completionTokens : 0
    const t = Number.isFinite(totalTokens) ? totalTokens : p + c
    this.calls += 1
    if (failed) this.failedCalls += 1
    if (isTransientRetry) this.transientRetries += 1
    this.promptTokens += p
    this.completionTokens += c
    this.totalTokens += t
    // 失敗した呼び出しのモデル名は応答解決モデルへ入れない
    if (!failed && model) this.responseModels.add(String(model))
    this.history.push({
      label,
      promptTokens: p,
      completionTokens: c,
      totalTokens: t,
      model: failed ? null : (model ?? null),
      finishReason: failed ? null : (finishReason ?? null),
      failed,
      isTransientRetry,
    })
  }

  summary() {
    return {
      calls: this.calls,
      failedCalls: this.failedCalls,
      transientRetries: this.transientRetries,
      maxCalls: this.maxCalls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      maxTotalTokens: Number.isFinite(this.maxTotalTokens) ? this.maxTotalTokens : null,
      estimatedCostUsd: this.estimatedCostUsd === null ? null : Number(this.estimatedCostUsd.toFixed(6)),
      maxCostUsd: Number.isFinite(this.maxCostUsd) ? this.maxCostUsd : null,
      responseModels: [...this.responseModels],
    }
  }
}

/** temperature オプションを解釈する（"omit" はリクエスト送信自体を省略） */
export function parseTemperatureOption(raw, defaultValue) {
  if (raw === undefined || raw === null || raw === "") return defaultValue
  const text = String(raw).trim().toLowerCase()
  if (text === "omit" || text === "none") return "omit"
  const num = Number(text)
  if (!Number.isFinite(num) || num < 0 || num > 2) {
    throw new Error(`temperature の指定が不正です（0〜2 の数値または omit を指定してください）: ${raw}`)
  }
  return num
}

/** extra-body JSON 文字列を検証付きでパースする */
export function parseExtraBodyOption(raw) {
  if (raw === undefined || raw === null || raw === "") return {}
  if (typeof raw === "object" && !Array.isArray(raw)) return { ...raw }
  let parsed
  try {
    parsed = JSON.parse(String(raw))
  } catch (err) {
    throw new Error(`extra-body の JSON 解析に失敗しました: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('extra-body には JSON オブジェクト（例: {"max_completion_tokens": 4096}）を指定してください')
  }
  return parsed
}

/** OpenAI 互換 Chat Completions のリクエストボディを組み立てる */
export function buildChatRequestBody({ model, messages, temperature, maxTokens, extraBody }) {
  const body = {
    model,
    messages,
  }
  if (temperature !== "omit" && temperature !== undefined && temperature !== null) {
    body.temperature = temperature
  }
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    body.max_tokens = Math.floor(maxTokens)
  }
  if (extraBody && typeof extraBody === "object") {
    Object.assign(body, extraBody)
  }
  return body
}

function normalizeMessageContent(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part.text === "string") return part.text
        return ""
      })
      .join("")
  }
  return ""
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

function parseRetryAfterMs(response) {
  const header = response?.headers?.get?.("retry-after")
  if (!header) return null
  const secs = Number(header)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000)
  return null
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * OpenAI 互換 Chat Completions API を呼び出す。
 * HTTP 429・5xx・タイムアウト・一時的ネットワークエラーは待機後に最大 maxTransientRetries 回再試行する（全試行を予算計上）。
 */
export async function callChatCompletion({
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  extraBody,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTransientRetries = DEFAULT_TRANSIENT_RETRIES,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  budget,
  label = "chat-completion",
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultSleep,
}) {
  if (!model) throw new Error(`モデル名が指定されていません（${label}）`)
  if (!apiKey) throw new Error(`API キーが設定されていません（${label}）`)

  const endpoint = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`
  const payload = buildChatRequestBody({ model, messages, temperature, maxTokens, extraBody })
  const maxAttempts = Math.max(1, 1 + Math.max(0, maxTransientRetries))

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptLabel = attempt === 1 ? label : `${label}-transient-retry${attempt - 1}`
    const isTransientRetry = attempt > 1
    budget?.assertCanCall(attemptLabel)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      budget?.record({
        label: attemptLabel,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        model: null,
        failed: true,
        isTransientRetry,
      })
      const reason = err instanceof Error ? err.message : String(err)
      if (attempt < maxAttempts) {
        const delayMs = retryBaseDelayMs * Math.pow(2, attempt - 1)
        await sleepImpl(delayMs)
        continue
      }
      throw new Error(`API 呼び出しに失敗しました（${label} / ${endpoint}）: ${reason}`)
    } finally {
      clearTimeout(timer)
    }

    const rawText = await response.text()
    if (!response.ok) {
      budget?.record({
        label: attemptLabel,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        model: null,
        failed: true,
        isTransientRetry,
      })
      const snippet = rawText.slice(0, 300)
      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        const delayMs = parseRetryAfterMs(response) ?? retryBaseDelayMs * Math.pow(2, attempt - 1)
        await sleepImpl(delayMs)
        continue
      }
      throw new Error(`API エラー HTTP ${response.status}（${label}）: ${snippet}`)
    }

    let data
    try {
      data = JSON.parse(rawText)
    } catch (err) {
      budget?.record({
        label: attemptLabel,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        model: null,
        failed: true,
        isTransientRetry,
      })
      throw new Error(
        `API 応答の JSON 解析に失敗しました（${label}）: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const choice = data?.choices?.[0]
    const content = normalizeMessageContent(choice?.message?.content)
    const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null
    const reasoningRaw =
      typeof choice?.message?.reasoning_content === "string"
        ? choice.message.reasoning_content
        : typeof choice?.message?.reasoning === "string"
          ? choice.message.reasoning
          : ""
    const reasoningChars = reasoningRaw.length
    const responseModel = typeof data?.model === "string" && data.model.length > 0 ? data.model : model
    const promptTokens = Number(data?.usage?.prompt_tokens ?? 0)
    const completionTokens = Number(data?.usage?.completion_tokens ?? 0)
    const totalTokens = Number(data?.usage?.total_tokens ?? promptTokens + completionTokens)
    const rawReasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens ?? data?.usage?.reasoning_tokens
    const reasoningTokens =
      rawReasoningTokens !== null && rawReasoningTokens !== undefined && Number.isFinite(Number(rawReasoningTokens))
        ? Number(rawReasoningTokens)
        : null

    budget?.record({
      label: attemptLabel,
      promptTokens,
      completionTokens,
      totalTokens,
      model: responseModel,
      finishReason,
      failed: false,
      isTransientRetry,
    })

    return {
      content,
      model: responseModel,
      finishReason,
      reasoningChars,
      usage: { promptTokens, completionTokens, totalTokens, reasoningTokens },
      raw: data,
    }
  }
}
