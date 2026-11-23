/**
 * 評価ランナーの 1 話執筆＆記録更新ハーネス
 *
 * - 本番の novel-writer プロンプト＋対象スキル本文に、新旧共通の固定上書き指示を添えて 1 話を生成する
 * - タグ欠落・極端な短文・ツール記法混入時は 1 回だけ再試行（予算計上）
 * - 保存後、1 回の統合 JSON 呼び出しで character-state / summary / foreshadow を更新し、
 *   novelUpdateExecute の ❌ 戻り値を検知した場合も 1 回だけ再試行（予算計上）
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { callChatCompletion } from "./llm-client.mjs"

/** 新旧どちらの版でも完全に同一の上書き指示 */
export const RUNNER_OVERRIDE_INSTRUCTION = [
  "## 実行環境の上書き指示（評価ランナー）",
  "- この環境ではツール（novel_context / novel_save_chapter / novel_update / novel_check 等）は呼び出せません。ツール呼び出し記法や完了報告は出力しないでください。",
  "- 必要な資料（novel_context の出力）はユーザーメッセージにすべて渡します。",
  "- 出力は次のタグ形式のみで返してください（タグの外に挨拶・解説・報告を書かないこと）：",
  "<タイトル>サブタイトルのみ（話数や見出し記号を含めない）</タイトル>",
  "<本文>",
  "本文のみ（見出し行を含めない）",
  "</本文>",
].join("\n")

/** novel_context の出力から「参照するスキル」一覧を抽出する */
export function extractReferencedSkills(contextText) {
  const m = contextText.match(/^- 参照するスキル:\s*(.+)$/m)
  if (!m) return ["novel-writing"]
  const names = m[1]
    .split(/[、,]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return names.length > 0 ? names : ["novel-writing"]
}

/** 書き手用システムプロンプトと SHA-256 ハッシュを組み立てる */
export function buildWriterSystemPrompt({ agentPrompt, skillDocs }) {
  const parts = [agentPrompt.trim()]
  for (const doc of skillDocs) {
    parts.push(`---\n# 参照スキル: ${doc.name}\n\n${doc.content.trim()}`)
  }
  parts.push(RUNNER_OVERRIDE_INSTRUCTION)
  const prompt = parts.join("\n\n")
  const sha256 = createHash("sha256").update(prompt, "utf-8").digest("hex")
  return { prompt, sha256 }
}

const TOOL_OR_REPORT_ARTIFACT =
  /(?:novel_save_chapter\s*\(|novel_update\s*\(|novel_context\s*\(|novel_check\s*\(|^結果:\s*(?:書いた|書けなかった))/m

/** 書き手 LLM の応答から <タイトル> と <本文> を抽出し妥当性検証する */
export function parseWriterOutput(raw, opts = {}) {
  const minChars = opts.minChars ?? 300
  const text = String(raw ?? "")
  const titleMatch = text.match(/<タイトル>([\s\S]*?)<\/タイトル>/)
  const bodyMatch = text.match(/<本文>([\s\S]*?)<\/本文>/)

  if (!bodyMatch) {
    return { ok: false, reason: "<本文>…</本文> タグが見つかりません" }
  }
  const content = bodyMatch[1].replace(/^\r?\n+|\r?\n+$/g, "")
  const nonSpaceChars = [...content.replace(/[\s　]+/g, "")].length
  if (nonSpaceChars < minChars) {
    return {
      ok: false,
      reason: `本文が極端に短すぎます（${nonSpaceChars}字。最低 ${minChars}字以上必要）`,
    }
  }
  if (TOOL_OR_REPORT_ARTIFACT.test(content)) {
    return { ok: false, reason: "本文にツール呼び出し記法または完了報告が混入しています" }
  }
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : ""
  if (!title) {
    return { ok: false, reason: "<タイトル>…</タイトル> タグが空または欠落しています" }
  }
  return { ok: true, title, content }
}

/** 統合記録更新 JSON の応答を抽出・検証する */
export function parseRecordUpdateJson(raw) {
  const text = String(raw ?? "").trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  let candidate = fenced ? fenced[1].trim() : text
  const firstBrace = candidate.indexOf("{")
  const lastBrace = candidate.lastIndexOf("}")
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1)
  }

  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch (err) {
    return { ok: false, reason: `JSON 解析に失敗しました: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "応答が JSON オブジェクトではありません" }
  }
  if (!parsed.characterState || !Array.isArray(parsed.characterState.updates)) {
    return { ok: false, reason: "characterState.updates 配列が欠落しています" }
  }
  if (typeof parsed.summary !== "string" || parsed.summary.trim().length === 0) {
    return { ok: false, reason: "summary 文字列が空または欠落しています" }
  }
  const foreshadowItems = parsed.foreshadow === undefined ? [] : parsed.foreshadow?.items
  if (!Array.isArray(foreshadowItems)) {
    return { ok: false, reason: "foreshadow.items が配列ではありません" }
  }
  return {
    ok: true,
    characterState: parsed.characterState,
    summary: parsed.summary.trim(),
    foreshadow: { items: foreshadowItems },
  }
}

function buildRecordUpdateMessages({ plugin, chapterNumber, chapterTitle, chapterBody, currentForeshadowJson }) {
  const system = [
    "あなたはライトノベル・Web小説の編集者です。書き終えた1話の本文を読み、作品記録（character-state・summary・foreshadow）を1つの JSON にまとめて返します。",
    "JSON 以外の説明文は書かないでください。",
  ].join("\n")

  const user = [
    `# 第${chapterNumber}話「${chapterTitle}」の記録更新`,
    "",
    "## 本文",
    chapterBody,
    "",
    "## 1. character-state の規約",
    plugin.prompts.CHARACTER_STATE_UPDATE_PROMPT.replaceAll("{chapterNumber}", String(chapterNumber)).replaceAll(
      "{charactersToTrack}",
      "この話に登場・言及された主要キャラクター（キャラシートの正式名を使用）",
    ),
    `changes で使えるキー: ${plugin.records.CHARACTER_STATE_KEYS}`,
    plugin.records.CHARACTER_STATE_EXAMPLE,
    "",
    "## 2. summary の規約",
    plugin.prompts.SUMMARY_UPDATE_PROMPT.replaceAll("{chapterNumber}", String(chapterNumber)),
    "",
    "## 3. foreshadow の規約",
    `使えるキー: ${plugin.records.FORESHADOW_KEYS}`,
    plugin.records.FORESHADOW_EXAMPLE,
    "### 現在の .novel/foreshadow.json",
    currentForeshadowJson,
    "※ この話で本文に張った伏線は status を \"planted\" に、回収した伏線は \"resolved\" に更新してください（既存は id で指定し、変える項目だけ渡す）。動きが無ければ items は空配列 [] にしてください。",
    "",
    "## 出力形式（厳守・JSON のみ）",
    "```json",
    "{",
    '  "characterState": { "updates": [] },',
    '  "summary": "この話だけのあらすじ（300〜500文字目安）",',
    '  "foreshadow": { "items": [] }',
    "}",
    "```",
  ].join("\n")

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

function readConfigTargetChapterWords(projectDir) {
  const cfgPath = join(projectDir, ".novel", "config.json")
  if (!existsSync(cfgPath)) return 3000
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"))
    const targetWords = Number(cfg.targetWords ?? 90000)
    const chapterCount = Math.max(1, Number(cfg.chapterCount ?? 30))
    return Math.round(targetWords / chapterCount)
  } catch {
    return 3000
  }
}

function summarizeLlmAttempt(attempt, res, failureType = null, failureReason = null) {
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

function buildEmptyResponseReason(finishReason, roleFlagPrefix = "writer") {
  if (finishReason === "length") {
    return (
      `空応答が返されました（finish_reason=length: 推論等で出力上限を使い切った可能性があります。` +
      `--${roleFlagPrefix}-max-tokens や --${roleFlagPrefix}-extra-body の設定を見直してください）`
    )
  }
  return `空応答が返されました（content が空 / finish_reason=${finishReason ?? "unknown"}）`
}

/** 1 話の執筆 → 保存 → 記録更新（character-state / summary / foreshadow）を実行する */
export async function executeChapterStep({
  plugin,
  projectDir,
  chapterNumber,
  llmConfig,
  budget,
  callLlm = callChatCompletion,
  minBodyChars,
}) {
  const ctx = { projectDir }
  const contextText = await plugin.tools.novelContextExecute({ chapterNumber }, ctx)
  const skillNames = extractReferencedSkills(contextText)
  const skillDocs = skillNames.map((name) => ({ name, content: plugin.readSkill(name) }))
  const { prompt: systemPrompt, sha256: systemPromptHash } = buildWriterSystemPrompt({
    agentPrompt: plugin.writerAgent.prompt,
    skillDocs,
  })

  const targetChapterWords = readConfigTargetChapterWords(projectDir)
  const effectiveMinChars = minBodyChars ?? Math.max(300, Math.round(targetChapterWords * 0.25))

  // --- 1. 本文執筆（失敗時は 1 回だけ再試行。予算計上） ---
  const writerMessages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `以下の資料をもとに第${chapterNumber}話を執筆し、<タイトル> と <本文> タグのみで出力してください。\n\n${contextText}`,
    },
  ]

  let parsedWriter = null
  let writerRetries = 0
  let writerFormatRetries = 0
  let emptyResponseRetries = 0
  let lengthTruncatedAttempts = 0
  const writerAttempts = []
  let lastWriterRaw = ""
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await callLlm({
      ...llmConfig,
      messages: writerMessages,
      budget,
      label: `write-ch${chapterNumber}-attempt${attempt}`,
    })
    lastWriterRaw = String(res.content ?? "")
    const isEmpty = lastWriterRaw.trim().length === 0
    if (isEmpty) {
      const reason = buildEmptyResponseReason(res.finishReason ?? null, "writer")
      if (res.finishReason === "length") {
        lengthTruncatedAttempts++
        console.error(`[eval write] ⚠️ 第${chapterNumber}話 attempt${attempt}: ${reason}`)
      }
      writerAttempts.push(summarizeLlmAttempt(attempt, res, "empty_response", reason))
      if (attempt === 1) {
        writerRetries = 1
        emptyResponseRetries = 1
        // 空応答の再試行では空の assistant メッセージを積まず、元プロンプトのまま送り直す
        continue
      }
      return {
        status: "failed",
        stage: "write",
        failureType: "empty_response",
        finishReason: res.finishReason ?? null,
        chapterNumber,
        systemPromptHash,
        skillNames,
        writerRetries,
        writerFormatRetries,
        emptyResponseRetries,
        lengthTruncatedAttempts,
        writerAttempts,
        error: `本文生成が空応答で2回失敗しました: ${reason}`,
        lastRawSample: "",
      }
    }

    const parsed = parseWriterOutput(lastWriterRaw, { minChars: effectiveMinChars })
    if (parsed.ok) {
      writerAttempts.push(summarizeLlmAttempt(attempt, res, null, null))
      parsedWriter = parsed
      break
    }
    writerAttempts.push(summarizeLlmAttempt(attempt, res, "format_error", parsed.reason))
    if (attempt === 1) {
      writerRetries = 1
      writerFormatRetries = 1
      writerMessages.push(
        { role: "assistant", content: lastWriterRaw },
        {
          role: "user",
          content: `前回の出力は形式要件を満たしませんでした（理由: ${parsed.reason}）。ツール呼び出しや報告を含めず、<タイトル>…</タイトル> と <本文>…</本文> のみで第${chapterNumber}話を出力し直してください。`,
        },
      )
    } else {
      return {
        status: "failed",
        stage: "write",
        failureType: "format_error",
        finishReason: res.finishReason ?? null,
        chapterNumber,
        systemPromptHash,
        skillNames,
        writerRetries,
        writerFormatRetries,
        emptyResponseRetries,
        lengthTruncatedAttempts,
        writerAttempts,
        error: `本文の抽出・検証に2回失敗しました: ${parsed.reason}`,
        lastRawSample: lastWriterRaw.slice(0, 300),
      }
    }
  }

  // --- 2. 本文保存 ---
  const saveReport = await plugin.tools.novelSaveChapterExecute(
    { chapterNumber, title: parsedWriter.title, content: parsedWriter.content },
    ctx,
  )
  if (saveReport.startsWith("❌")) {
    return {
      status: "failed",
      stage: "save",
      failureType: "save_error",
      chapterNumber,
      title: parsedWriter.title,
      systemPromptHash,
      skillNames,
      writerRetries,
      writerFormatRetries,
      emptyResponseRetries,
      lengthTruncatedAttempts,
      writerAttempts,
      error: saveReport,
    }
  }

  // --- 3. 記録更新（character-state / summary / foreshadow。❌ 戻り値や JSON 不正時は 1 回だけ再試行） ---
  const foreshadowPath = join(projectDir, ".novel", "foreshadow.json")
  const currentForeshadowJson = existsSync(foreshadowPath)
    ? readFileSync(foreshadowPath, "utf-8")
    : '{"items": []}'
  const recordMessages = buildRecordUpdateMessages({
    plugin,
    chapterNumber,
    chapterTitle: parsedWriter.title,
    chapterBody: parsedWriter.content,
    currentForeshadowJson,
  })

  let recordRetries = 0
  let recordEmptyResponseRetries = 0
  let recordErrors = []
  const recordAttempts = []
  const updateReports = {}
  const appliedDone = { characterState: false, summary: false, foreshadow: false }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await callLlm({
      ...llmConfig,
      temperature: llmConfig.temperature === "omit" ? "omit" : 0,
      messages: recordMessages,
      budget,
      label: `update-ch${chapterNumber}-attempt${attempt}`,
    })

    const rawRecord = String(res.content ?? "")
    if (rawRecord.trim().length === 0) {
      const reason = buildEmptyResponseReason(res.finishReason ?? null, "writer")
      if (res.finishReason === "length") {
        lengthTruncatedAttempts++
        console.error(`[eval update] ⚠️ 第${chapterNumber}話 attempt${attempt}: ${reason}`)
      }
      recordErrors = [reason]
      recordAttempts.push(summarizeLlmAttempt(attempt, res, "empty_response", reason))
      if (attempt === 1) {
        recordRetries = 1
        recordEmptyResponseRetries = 1
        // 空応答では空の assistant メッセージを積まずに送り直す
        continue
      }
      break
    }

    const parsed = parseRecordUpdateJson(rawRecord)
    if (!parsed.ok) {
      recordErrors = [`JSON検証失敗: ${parsed.reason}`]
    } else {
      const errors = []

      if (!appliedDone.characterState) {
        const csOut = await plugin.tools.novelUpdateExecute(
          { action: "character-state", chapterNumber, content: JSON.stringify(parsed.characterState) },
          ctx,
        )
        updateReports.characterState = csOut
        if (csOut.startsWith("❌")) errors.push(`character-state: ${csOut}`)
        else appliedDone.characterState = true
      }

      if (!appliedDone.summary) {
        const sumOut = await plugin.tools.novelUpdateExecute(
          { action: "summary", chapterNumber, content: parsed.summary },
          ctx,
        )
        updateReports.summary = sumOut
        if (sumOut.startsWith("❌")) errors.push(`summary: ${sumOut}`)
        else appliedDone.summary = true
      }

      if (!appliedDone.foreshadow && parsed.foreshadow.items.length > 0) {
        const fsOut = await plugin.tools.novelUpdateExecute(
          { action: "foreshadow", chapterNumber, content: JSON.stringify(parsed.foreshadow) },
          ctx,
        )
        updateReports.foreshadow = fsOut
        if (fsOut.startsWith("❌")) errors.push(`foreshadow: ${fsOut}`)
        else appliedDone.foreshadow = true
      }

      recordErrors = errors
    }

    recordAttempts.push(
      summarizeLlmAttempt(
        attempt,
        res,
        recordErrors.length > 0 ? "format_or_update_error" : null,
        recordErrors.length > 0 ? recordErrors.join(" / ") : null,
      ),
    )

    if (recordErrors.length === 0) break
    if (attempt === 1) {
      recordRetries = 1
      recordMessages.push(
        { role: "assistant", content: rawRecord },
        {
          role: "user",
          content: `前回の記録更新で次のエラーが発生しました:\n${recordErrors.join("\n")}\n\n規約どおりの JSON のみで出力し直してください（人物名は必ずキャラシートの正式名を使用してください）。`,
        },
      )
    }
  }

  return {
    status: recordErrors.length === 0 ? "ok" : "partial_record_error",
    chapterNumber,
    title: parsedWriter.title,
    systemPromptHash,
    skillNames,
    writerRetries,
    writerFormatRetries,
    emptyResponseRetries,
    recordRetries,
    recordEmptyResponseRetries,
    lengthTruncatedAttempts,
    writerAttempts,
    recordAttempts,
    recordErrors,
    saveReport,
    updateReports,
  }
}

/** --dry-run 用の決定論的モック LLM クライアント（予算カウントも通常どおり記録する） */
export function createDryRunLlmClient({ exampleName }) {
  return async ({ messages, budget, label, model = "dry-run-model" }) => {
    budget?.assertCanCall(label)
    const isUpdate = label.startsWith("update-")
    const chMatch = label.match(/ch(\d+)/)
    const ch = chMatch ? Number(chMatch[1]) : 1

    let content
    if (isUpdate) {
      if (exampleName === "fantasy-balanced") {
        const payload = {
          characterState: {
            updates: [
              {
                name: "レオ",
                changes: {
                  mentalState: `第${ch}話の探索を終えて次の測量に意欲的`,
                  events: [`第${ch}話の測量と探索をやり遂げた`],
                },
              },
            ],
          },
          summary: `第${ch}話ではレオとフィナが迷宮の地形を測量し、隠れた通路と手がかりを見つけた。次の区画へ進む準備を整える。`,
          foreshadow: ch === 1 ? { items: [{ id: "F1", status: "planted" }] } : { items: [] },
        }
        content = JSON.stringify(payload, null, 2)
      } else {
        const payload = {
          characterState: {
            updates: [
              {
                name: "高瀬健人",
                changes: {
                  mentalState: `第${ch}話の放課後を経て少し気が緩んだ`,
                  events: [`第${ch}話で天野と4コマの話をした`],
                },
              },
            ],
          },
          summary: `第${ch}話では健人とこはるが放課後に落書きノートを広げ、掛け合いながら次の企画へ動き出した。`,
          foreshadow: { items: [] },
        }
        content = JSON.stringify(payload, null, 2)
      }
    } else {
      const indentPrefix = exampleName === "romcom-light" ? "" : "　"
      const paragraphs =
        exampleName === "romcom-light"
          ? [
              `放課後の教室に、少し傾いた西日が差し込んでいる。第${ch}話の放課後も、隣の席の天野はいつもの勢いでノートを覗き込んできた。`,
              `「高瀬！　今日の4コマ、オチの切れ味がさらに上がってない？」`,
              `「いや、まだ下書きだから勝手にページをめくるな」`,
              `慌ててノートを押さえる俺の手の上から、天野は楽しそうに笑って次のコマを指さした。`,
              `「だって面白いんだもん。次の展開、駅前でまた会議しようよ」`,
              `照れ隠しにペンを回しながら、俺は机の上の消しゴムを片づけた。帰り道の風が心地いい。`,
            ]
          : [
              `${indentPrefix}石畳の通路を北へ28歩。俺の固有魔法〈歩数計〉が、壁の裏側にわずかな空白を示している。`,
              `「レオ、本当にこの石壁の向こうに隠し部屋があるのか？」`,
              `「間違いありません。第${ch}話の測量でも、床の高さがちょうど3段ぶんずれています」`,
              `${indentPrefix}フィナが槍の石突で壁を軽く叩くと、乾いた高い音が返ってきた。俺は羊皮紙の地図に新しい印を書き込む。`,
              `${indentPrefix}隠し扉の奥に転がっていた金属片を拾い上げると、初代測量士ギルドの六角星の目盛りが薄く刻まれていた。`,
              `「よし、次の区画もこのまま一気に調べようぜ！」`,
            ]
      // minChars（目標の25%）を確実に満たす長さに自然な段落を繰り返す
      const repeated = Array.from({ length: 6 }, () => paragraphs.join("\n\n")).join("\n\n")
      content = `<タイトル>テスト第${ch}話</タイトル>\n<本文>\n${repeated}\n</本文>`
    }

    const promptChars = messages.reduce((sum, m) => sum + String(m.content ?? "").length, 0)
    const promptTokens = Math.ceil(promptChars / 2)
    const completionTokens = Math.ceil(content.length / 2)
    budget?.record({
      label,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model,
      finishReason: "stop",
    })

    return {
      content,
      model,
      finishReason: "stop",
      reasoningChars: 0,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, reasoningTokens: null },
      raw: { dryRun: true },
    }
  }
}
