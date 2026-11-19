import {
  safeReadFile,
  safeReadJson,
  getDocPath,
  getConfigPath,
  resolveLimit,
  takeTailChars,
  parseChapterNumber,
  truncateChars,
  toKanjiNumber,
  readDocParts,
  readChapterDoc,
  listCharacterDocs,
  parseScenes,
  clipDocParts,
  selectForeshadowReminders,
  extractSpeechProfile,
  isShortForm,
  isSerial,
  storyModeOf,
  storyModeLabel,
  seriousnessOf,
  seriousnessLabel,
  indentStyleOf,
  recommendedGenreSkills,
} from "../core/utils.js"
import type {
  NovelConfig,
  DocPart,
  ForeshadowReminder,
  CharacterDoc,
  SpeechProfile,
} from "../core/utils.js"
import { DEFAULTS, CHAPTER_WORD_TOLERANCE } from "../core/constants.js"
import {
  buildSummaryContext,
  splitForeshadowEntries,
  readCharacterStateRecord,
  readForeshadowRecord,
  readTextRecord,
  describeBrokenRecord,
} from "../core/records.js"
import {
  isUntouchedTemplate,
  WORLD_BUILDING_TEMPLATE,
  GLOSSARY_TEMPLATE,
  CONCEPT_TEMPLATE,
} from "../core/templates.js"
import {
  sectionFromArgs,
  sectionLabel,
  sectionFileName,
  parseSectionLabel,
  readSectionDoc,
  listManuscriptFiles,
  previousManuscriptFile,
  recordChapterOf,
  sameSection,
  parseParts,
  partOfChapter,
  partName,
  partRange,
  lastChapterForRecords,
  lastWrittenChapter,
} from "../core/sections.js"
import type { ManuscriptSection, SectionKind } from "../core/sections.js"
import { worldBuildingParts, conceptParts } from "../core/doc-sections.js"
import { parseGlossary, buildGlossaryContext } from "../core/glossary.js"
import { statesBefore, lastRecordedBefore, stateKeyNames, formatStateKeyNames, normalizeCharacterState } from "../core/character-state.js"
import type { ResolvedCharacter } from "../core/character-state.js"
import { sourceWorkOf, readCanonParts } from "../core/canon.js"
import type { LimitKey, Seriousness, ChapterUnit } from "../core/constants.js"
import { buildCharacterIndex, characterRanks, resolveCharacterName } from "../core/character-names.js"
import type { CharacterIndex } from "../core/character-names.js"
import type { ToolRuntimeContext } from "./types.js"

export interface ContextArgs {
  section?: SectionKind
  chapterNumber?: number
  interludeIndex?: number
  sceneId?: string
  includePrompts?: boolean
}

function toneWritingGuideline(level: Seriousness): string {
  switch (level) {
    case "light":
      return "軽快・明るめ: プロットに無い死・喪失・重い過去・胸糞展開・説教くさい教訓まとめを絶対に足さない。キャラの掛け合い、テンポ、この話の見どころを楽しむ"
    case "balanced":
      return "エンタメ標準: 見せ場の緊張感や熱さは活かしつつ、必要以上に暗く重く引きずらない。カタルシスやごほうび（周りの反応・達成感）をしっかり書く"
    case "serious":
      return "シリアス重視: 緊張感や葛藤をしっかり描きつつ、説明過多や説教臭いまとめを避け、行動とキャラの選択で魅せる"
  }
}

export async function novelContextExecute(
  args: ContextArgs,
  ctx: ToolRuntimeContext,
): Promise<string> {
  const dir = ctx.projectDir
  const resolved = sectionFromArgs(args)
  if ("error" in resolved) return `❌ ${resolved.error}。`
  const section = resolved.section
  const includePrompts = args.includePrompts !== false
  const config = await safeReadJson<NovelConfig>(getConfigPath(dir))
  const chapterCount = Math.max(1, config?.chapterCount ?? DEFAULTS.chapterCount)
  const unit = config?.chapterUnit ?? DEFAULTS.chapterUnit
  let label = sectionLabel(section, unit)
  const manuscriptFiles = await listManuscriptFiles(dir)
  const lastWritten = lastWrittenChapter(manuscriptFiles)
  const chapterNum = recordChapterOf(section, lastChapterForRecords(manuscriptFiles, chapterCount))
  const short = isShortForm(config)
  const singleBody = short && chapterCount === 1 && section.kind === "chapter" && section.chapter === 1
  if (singleBody) label = "本文"
  else if (section.kind === "chapter") label = `第${section.chapter}${unit}`

  const clipParts = (parts: DocPart[], key: LimitKey): string =>
    clipDocParts(parts, resolveLimit(config, key))

  let context = `📝 執筆用の資料 — ${label}\n${"=".repeat(50)}\n\n`

  if (config) {
    const targetWords = config.targetWords && config.targetWords > 0 ? config.targetWords : DEFAULTS.targetWords
    context += `## 📖 作品情報\n`
    context += `タイトル: ${config.title}\n`
    context += `ジャンル: ${config.genre}\n`
    context += `構成の型: ${storyModeLabel(storyModeOf(config))}\n`
    if (config.tone) context += `雰囲気・トーン: ${config.tone}\n`
    context += `シリアス度: ${seriousnessLabel(seriousnessOf(config))}\n`
    context += `視点: ${config.narrativePerspective ?? DEFAULTS.narrativePerspective}\n`
    const parts = parseParts(config.parts)
    if (parts && "parts" in parts && (section.kind === "chapter" || section.kind === "interlude")) {
      const part = partOfChapter(parts.parts, section.chapter)
      if (part) {
        const nth = section.kind === "chapter" ? `の${section.chapter - part.fromChapter + 1}${unit}目` : ""
        context += `部: ${partName(part, "arabic", toKanjiNumber)}「${part.title}」（${partRange(part, Math.max(chapterCount, lastWritten), unit)}）${nth}\n`
      }
    } else if (parts && "error" in parts) {
      context += `⚠️ ${parts.error}\n`
    }
    context += singleBody
      ? `形式: 短編・読み切り\n`
      : isSerial(config)
        ? `目標文字数: ${targetWords.toLocaleString("ja-JP")}文字（連載。目安 全${chapterCount}${unit}${lastWritten > 0 ? `、本文は第${lastWritten}${unit}まで` : ""}）\n`
        : `目標文字数: ${targetWords.toLocaleString("ja-JP")}文字（全${chapterCount}${unit}）\n`
    const perChapter = Math.round(targetWords / chapterCount).toLocaleString("ja-JP")
    context += singleBody
      ? `本文の目安: ${perChapter}文字 ±${Math.round(CHAPTER_WORD_TOLERANCE * 100)}%\n\n`
      : section.kind === "chapter"
        ? `この${unit}の目安: ${perChapter}文字 ±${Math.round(CHAPTER_WORD_TOLERANCE * 100)}%\n\n`
        : `分量の目安: プロットに従う（1${unit}の目安は ${perChapter}文字。${label}は${unit}数に入りません）\n\n`
  }

  // --- この話のプロット（P0） ---
  let chapterOutline = await readSectionDoc(dir, "outline", section)
  if (!chapterOutline) {
    const outline = await safeReadFile(getDocPath(dir, "outline-detailed"))
    if (outline) chapterOutline = extractOutlineSection(outline, section)
  }
  if (chapterOutline) {
    context += `## 📋 この${section.kind === "chapter" ? unit : "節"}のプロット (P0 — 必ず従う)\n${chapterOutline.trim()}\n\n`
  }

  let shortBrief: string | null = null
  if (!chapterOutline && short && section.kind === "chapter") {
    shortBrief = await safeReadFile(getDocPath(dir, "outline-brief"))
    if (shortBrief && shortBrief.trim()) {
      const [brief, truncated] = truncateChars(shortBrief.trim(), resolveLimit(config, "outlineBrief"))
      context += `## 📋 短編プロット (P0 — 必ず従う)\n`
      context += brief
      if (truncated) context += `\n…（以下省略。limits.outlineBrief で枠を広げられます）`
      context += "\n\n"
    }
  }
  if (!chapterOutline && section.kind === "chapter" && isSerial(config) && !(shortBrief && shortBrief.trim())) {
    context += `## 📋 この${unit}のプロット (P0 — 必ず従う)\n`
    context += `⚠️ 第${section.chapter}${unit}のプロットが見つかりません。書く前に outline/${sectionFileName(section)}（または outline-detailed.md）へプロットを足してください\n\n`
  }
  if (!chapterOutline && section.kind !== "chapter") {
    context += `## 📋 この節のプロット (P0 — 必ず従う)\n`
    context += `⚠️ ${label}のプロットが見つかりません。outline-detailed.md に「## ${label}」の節を書くか、outline/${sectionFileName(section)} を作ってください\n\n`
  }

  // --- この話のシーン（任意で作成した場合のみ） ---
  const sceneSource =
    section.kind !== "chapter"
      ? null
      : ((await readChapterDoc(dir, "scenes", section.chapter)) ?? (await safeReadFile(getDocPath(dir, "scenes"))))
  const sceneParts =
    sceneSource && section.kind === "chapter" ? extractChapterScenes(sceneSource, section.chapter, args.sceneId) : []
  if (sceneParts.length > 0) {
    context += `## 🎬 この${unit}のシーン (P0 — 執筆の手引き)\n`
    if (args.sceneId) context += `今回書くシーン: ${args.sceneId}\n\n`
    context += clipParts(sceneParts, "scenes") + "\n\n"
  }

  // --- 作品の核・トーン・NGライン（P1 — プロットのすぐ下に置き、雰囲気とNGラインを最優先で守る） ---
  const conceptFile = await safeReadFile(getDocPath(dir, "concept"))
  const concept = conceptParts(conceptFile ?? "", CONCEPT_TEMPLATE)
  if (concept.length > 0) {
    context += `## 💡 作品の核・トーン・NGライン (P1 — 面白さと雰囲気を守る)\n`
    context += clipParts(withHeading(concept), "concept") + "\n\n"
  }

  const chapterText = [chapterOutline ?? "", shortBrief ?? "", ...sceneParts.map((p) => p.content)].join("\n")

  // 人物選択に使う資料を先にそろえる。前話末尾も同じ索引で照合する。
  const prev = previousManuscriptFile(manuscriptFiles, section)
  const prevText = prev ? await safeReadFile(prev.path) : null
  const tail = prevText ? takeTailChars(prevText, resolveLimit(config, "previousChapterTail")) : ""
  const allCharacterDocs = await listCharacterDocs(dir)
  const index = buildCharacterIndex(allCharacterDocs)
  const charState = await readCharacterStateRecord(getDocPath(dir, "character-state"))
  const normalized = charState.kind === "ok" ? normalizeCharacterState(charState.value, index) : null
  const states = normalized ? statesBefore(normalized.file, section) : []
  // シート未登録の記録名も、その名前そのものだけを文章から探す。曖昧な呼称は追加しない。
  const stateIndex = [...index, ...states.filter(c => resolveCharacterName(index, c.name).kind === "unknown")
    .map(c => ({ name: c.name, hints: [c.name] }))]
  const ranks = characterRanks(stateIndex, chapterText, tail)
  const relevantDocs = allCharacterDocs.filter(d => ranks.has(d.label))
    .sort((a, b) => ranks.get(a.label)! - ranks.get(b.label)!)
  const profileParts = (await readDocParts(dir, "characters/profiles.md", null)).map(p => ({
    ...p, label: "一覧・関係性（profiles.md）", rank: 4,
  }))
  const characterParts = [
    ...relevantDocs.map(d => ({ ...d, label: d.canon ? `${d.label}（原作の人物）` : d.label, content: d.canon ? `（原作の人物）\n${d.content}` : d.content, rank: ranks.get(d.label) })),
    ...profileParts,
  ]
  if (allCharacterDocs.length > 0 || characterParts.length > 0) {
    context += `## 👤 登場人物 (P1 — キャラ立ちと掛け合い)\n`
    if (relevantDocs.length > 0) {
      context += `（この${unit}に関わる人物の設定を載せています: ${[...new Set(relevantDocs.map(d => d.label))].join("、")}。当話のプロット・シーン、前の節の末尾の順）\n`
    } else if (index.length > 0) {
      const [names] = truncateChars(index.map(c => c.name).join("、"), resolveLimit(config, "characterProfiles"))
      context += `⚠️ 人物を特定できませんでした。プロットの登場人物名とシートの呼称を確認してください。\n人物一覧: ${names}\n`
    }
    context += clipParts(characterParts, "characterProfiles") + "\n\n"
  }
  for (const warning of normalized?.warnings ?? []) context += `⚠️ 人物名の記録: ${warning}\n`

  // --- ことばづかい（P1） ---
  const speech = buildSpeechContext(index, relevantDocs, states, ranks, unit)
  if (speech) {
    const limit = resolveLimit(config, "speech")
    const [body, truncated] = truncateChars(speech, limit)
    context += `## 🗣️ ことばづかい (P1 — 口調と距離感を保つ)\n`
    context += `台詞と、一人称の語りなら地の文も、このとおりに書きます。呼び方や敬語が変わるときは理由になる出来事を本文に置き、novel_update(character-state) の speech を更新します。\n`
    context += body
    if (truncated) context += `\n…（以下省略。limits.speech で枠を広げられます）`
    context += "\n\n"
  }

  // --- 登場人物の現在の状態（P1） ---
  if (charState.kind === "broken") {
    context += `## 🔄 登場人物の現在の状態 (P1 — 重要)\n`
    context += `⚠️ ${describeBrokenRecord(".novel/characters/state.json", charState)}。直すまで人物の状態は載せられず、更新もできません\n\n`
  } else if (states.length > 0 && charState.kind === "ok") {
    const asOf = lastRecordedBefore(charState.value, section)
    context += `## 🔄 登場人物の現在の状態（${asOf ? `${sectionLabel(asOf, unit)}の終わり時点` : "記録より"}） (P1 — 重要)\n`
    context += buildCharacterStateContext(states, ranks, resolveLimit(config, "characterState"), unit)
    context += "\n\n"
  }
  const keyNames = charState.kind === "ok" ? formatStateKeyNames(stateKeyNames(charState.value)) : ""
  if (keyNames) {
    context += `📌 人物の状態の記録で使っている項目名: ${keyNames}（novel_update(character-state) では同じものをこの名前で書きます）\n\n`
  }

  // --- 前の話の末尾（P1） ---
  if (prev && prevText) {
    const limit = resolveLimit(config, "previousChapterTail")
    const prevName = prev.section.kind === "chapter" ? `前の${unit}` : `前の${sectionLabel(prev.section, unit)}`
    context += `## 📖 ${prevName}の末尾${limit.toLocaleString("ja-JP")}文字 (P1 — つなぎ)\n${tail}\n\n`
  }

  // --- 原作の資料（二次創作。P1） ---
  const sourceWork = sourceWorkOf(config)
  const canonParts = await readCanonParts(dir, chapterText)
  if (canonParts.length > 0) {
    context += `## 📚 原作の資料${sourceWork ? ` —『${sourceWork}』` : ""} (P1 — 原作と食い違わせない)\n`
    context += `原作の事実はこの資料と、登場人物の「（原作の人物）」の設定を正とします。「変えること」に書かれた点のほかは原作どおりに書きます。\n`
    context += clipParts(withHeading(canonParts), "canon") + "\n\n"
  } else if (sourceWork) {
    context += `## 📚 原作の資料 —『${sourceWork}』 (P1 — 原作と食い違わせない)\n`
    context += `⚠️ 原作の資料がまだありません（.novel/canon/overview.md が雛形のまま、または無い）。基準にする範囲・分岐点・変えることを先に整えてください。\n\n`
  }

  // --- 舞台・設定（P1） ---
  const worldFile = await safeReadFile(getDocPath(dir, "world-building"))
  const worldParts = [
    ...worldBuildingParts(worldFile ?? "", WORLD_BUILDING_TEMPLATE),
    ...(await readDocParts(dir, null, "world")),
  ]
  if (worldParts.length > 0) {
    context += `## 🗺️ 舞台・設定 (P1 — ルールとギミック)\n`
    context += clipParts(withHeading(worldParts), "worldBuilding") + "\n\n"
  }

  // --- 用語集（P1） ---
  const glossaryFile = await safeReadFile(getDocPath(dir, "glossary"))
  if (glossaryFile && glossaryFile.trim().length > 0 && !isUntouchedTemplate(glossaryFile, GLOSSARY_TEMPLATE)) {
    const limit = resolveLimit(config, "glossary")
    const entries = parseGlossary(glossaryFile)
    let body = buildGlossaryContext(entries, chapterText, limit)
    if (entries.length === 0) {
      const [raw, truncated] = truncateChars(glossaryFile.trim(), limit)
      body = raw + (truncated ? "\n…（以下省略。limits.glossary で枠を広げられます）" : "")
    }
    if (body) {
      context += `## 📕 用語集 (P1 — 表記と意味)\n`
      context += `用語は太字の表記で書き、「使わない表記」は使いません。意味は書き手のためのメモなので、場面の中で自然に見せます。\n`
      context += body + "\n\n"
    }
  }

  // --- これまでのあらすじ（P2） ---
  if (
    section.kind !== "prologue" &&
    !(section.kind === "chapter" && section.chapter === 1 && !manuscriptFiles.some((f) => f.section.kind === "prologue"))
  ) {
    const summary = await readTextRecord(getDocPath(dir, "summary"))
    const summaryText =
      summary.kind === "broken"
        ? `⚠️ ${describeBrokenRecord(".novel/summary.md", summary)}。直すまであらすじは載せられず、更新もできません`
        : summary.kind === "ok"
          ? buildSummaryContext(summary.value, section, resolveLimit(config, "summary"), lastWritten, unit)
          : ""
    if (summaryText) {
      context += `## 📚 これまでのあらすじ (P2 — 参考)\n${summaryText}\n\n`
    }
  }

  // --- 伏線の確認（P2） ---
  const foreshadowRecord = await readForeshadowRecord(getDocPath(dir, "foreshadow"))
  if (foreshadowRecord.kind === "broken") {
    context += `## 🎯 伏線の確認 (P2 — 参考)\n`
    context += `⚠️ ${describeBrokenRecord(".novel/foreshadow.json", foreshadowRecord)}。直すまで伏線は確かめられず、更新もできません\n\n`
  }
  const foreshadow = foreshadowRecord.kind === "ok" ? foreshadowRecord.value : null
  if (foreshadow) {
    const { valid, invalid } = splitForeshadowEntries(foreshadow.items)
    const reminders = selectForeshadowReminders(valid, chapterNum)
    if (reminders.length > 0 || invalid.length > 0) {
      context += `## 🎯 伏線の確認 (P2 — 参考)\n`
      for (const r of reminders) {
        context += `${foreshadowIcon(r)} [${r.item.id}] ${r.item.title}: ${r.item.content}\n`
        context += `   ${foreshadowNote(r, label, unit)}\n`
      }
      for (const x of invalid) {
        const raw = foreshadow.items.find((f) => (f as { id?: unknown })?.id === x.id) as Record<string, unknown> | undefined
        const text = raw ? String(raw.title ?? raw.detail ?? raw.content ?? "") : ""
        context += `❓ [${x.id}] ${text}\n`
        context += `   記録の形が崩れていて状態を判定できません（${x.problems.join("、")}）。本文と照らして novel_update で直してください\n`
      }
      context += "\n"
    }
  }

  // --- 書くときの条件 ---
  if (includePrompts && config) {
    const targetWords = config.targetWords && config.targetWords > 0 ? config.targetWords : DEFAULTS.targetWords
    const isOpening = prev === null && (section.kind === "prologue" || (section.kind === "chapter" && section.chapter === 1))
    const perChapter = Math.round(targetWords / chapterCount).toLocaleString("ja-JP")
    const tolerance = Math.round(CHAPTER_WORD_TOLERANCE * 100)
    const seriousness = seriousnessOf(config)
    const indent = indentStyleOf(config)
    const genreSkills = recommendedGenreSkills(config.genre)
    const skillsList = ["novel-writing", ...genreSkills, ...(sourceWork ? ["novel-fanfic"] : [])]

    context += `## ✍️ 書くときの条件\n`
    context += `- 書くもの: ${label}（${isOpening ? "物語の書き出し。説明から入らず、キャラの動きや会話・フックからスッと始める" : "続き。前の話の引きと語りのノリを引き継いで自然につなぐ"}）\n`
    context += section.kind === "chapter"
      ? `- 分量: ${perChapter}文字 ±${tolerance}%\n`
      : `- 分量: プロットに従う（1${unit}の目安は ${perChapter}文字）\n`
    context += `- 視点: ${config.narrativePerspective ?? DEFAULTS.narrativePerspective}（同じ場面の中で視点人物を入れ替えない。替えるなら区切りの行で分ける）\n`
    const hasStyleSample = concept.some((p) => p.content.includes("文体見本"))
    context += `- トーン方針: ${toneWritingGuideline(seriousness)}\n`
    if (hasStyleSample) {
      context += `- 文体見本: 企画書の「文体見本」の語尾・リズム・一文の長さ・距離感を最優先でそろえる\n`
    }
    context += `- 段落の字下げ: ${indent === "none" ? "字下げなし（Web小説スタイル）" : "地の文は全角1字下げ（会話・記号・画面行は字下げしない）"}\n`
    context += `- 参照するスキル: ${skillsList.join("、")}\n`
    context += `- 上のプロット（P0）と企画書の「トーンとNGライン」を守り、人物の魅力と「ことばづかい」を保つ\n`
    if (sourceWork) {
      context += `- 二次創作（原作『${sourceWork}』）: 原作の人物の口調・呼び方・能力・出来事は「原作の資料」と人物設定どおりにする。資料に無い原作の事実を記憶で補って断定しない。原作の文章・台詞・歌詞を写さない（novel-fanfic skill）\n`
    }
    context += `- 本文だけを書き、見出し行を付けずに novel_save_chapter に渡す\n`
  }

  return context
}

const charCount = (text: string) => [...text].length
const STATUS_LABELS: Record<string, string> = { deceased: "死亡", missing: "行方不明", retired: "退場" }
const RECENT_EVENTS = 5

function buildCharacterStateContext(
  states: ResolvedCharacter[],
  ranks: Map<string, number>,
  limit: number,
  unit: ChapterUnit,
): string {
  const statusMark = (c: ResolvedCharacter) => {
    if (c.status === "active") return ""
    const at = c.changedAt.status
    return `【${STATUS_LABELS[c.status] ?? c.status}${at ? `（${sectionLabel(at, unit)}）` : ""}】`
  }
  const pairs = (map: Record<string, string>, sep: string) =>
    Object.entries(map).map(([k, v]) => `${k}${sep}${v}`).join(" ／ ")

  const main = states.filter(c => ranks.has(c.name)).sort((a, b) => ranks.get(a.name)! - ranks.get(b.name)!)
  const others = states.filter(c => !ranks.has(c.name))
  const blocks: Array<{ name: string; text: string }> = []
  for (const c of main) {
    const lines = [`**${c.name}**${statusMark(c)}`]
    if (c.mentalState) lines.push(`  心: ${c.mentalState}`)
    if (c.physicalState) lines.push(`  体: ${c.physicalState}`)
    if (Object.keys(c.attributes).length > 0) lines.push(`  ${pairs(c.attributes, ": ")}`)
    for (const [name, values] of Object.entries(c.lists)) lines.push(`  ${name}: ${values.join("、")}`)
    if (Object.keys(c.relationships).length > 0) lines.push(`  関係: ${pairs(c.relationships, " → ")}`)
    const recent = c.events.slice(-RECENT_EVENTS)
    if (recent.length > 0) {
      const omitted = c.events.length - recent.length
      lines.push(`  これまでの出来事${omitted > 0 ? `（直近${recent.length}件）` : ""}:`)
      for (const e of recent) lines.push(`    - [${sectionLabel(e.at, unit)}] ${e.text}`)
    }
    blocks.push({ name: c.name, text: lines.join("\n") })
  }
  if (others.length > 0) {
    const heading = main.length > 0 ? "\n### ほかの人物（当話・前の節の末尾で未特定）" : ""
    others.forEach((c, i) => {
      const summary = [c.mentalState, c.attributes["現在地"]].filter(Boolean).join(" ／ ")
      const line = `- **${c.name}**${statusMark(c)}${summary ? `: ${summary}` : ""}`
      blocks.push({ name: c.name, text: i === 0 && heading ? `${heading}\n${line}` : line })
    })
  }

  let out = main.length > 0 && others.length > 0 ? "### この話に関わる人物\n" : ""
  const dropped: string[] = []
  let cut: string | null = null
  let placed = 0
  for (const b of blocks) {
    const next = out.length === 0 || out.endsWith("\n") ? b.text : `\n${b.text}`
    if (dropped.length === 0 && charCount(out) + charCount(next) <= limit) {
      out += next
      placed++
    } else if (placed === 0) {
      out += truncateChars(next, Math.max(0, limit - charCount(out)))[0]
      cut = b.name
      placed++
    } else {
      dropped.push(b.name)
    }
  }
  if (cut || dropped.length > 0) {
    const p = [...(cut ? [`${cut}の途中から`] : []), ...(dropped.length > 0 ? [dropped.join("、")] : [])]
    out += `\n…（枠が足りず省略: ${p.join("、")}。limits.characterState で枠を広げられます）`
  }
  return out
}

function buildSpeechContext(
  index: CharacterIndex,
  relevantDocs: CharacterDoc[],
  states: ResolvedCharacter[],
  ranks: Map<string, number>,
  unit: ChapterUnit,
): string {

  const entries: Array<{ name: string; profile: SpeechProfile; state?: ResolvedCharacter }> = []
  for (const doc of relevantDocs) {
    if (doc.canon && relevantDocs.some((d) => !d.canon && d.label === doc.label)) continue
    const state = states.find((s) => s.name === doc.label)
    const profile = extractSpeechProfile(doc.content) ?? { addressTerms: [] }
    entries.push({ name: doc.label, profile, state })
  }
  for (const state of states) {
    if (!state.firstPerson && Object.keys(state.addressTerms).length === 0) continue
    if (resolveCharacterName(index, state.name).kind !== "unknown") continue
    if (!ranks.has(state.name)) continue
    entries.push({ name: state.name, profile: { addressTerms: [] }, state })
  }

  entries.sort((a, b) => (ranks.get(a.name) ?? 4) - (ranks.get(b.name) ?? 4))
  const blocks: string[] = []
  for (const { name, profile, state } of entries) {
    const changed = (field: string) => {
      const at = state?.changedAt[field]
      return at ? `（${sectionLabel(at, unit)}で変更）` : "（記録で変更）"
    }
    const fields: string[] = []
    const firstPerson = state?.firstPerson ?? profile.firstPerson
    if (firstPerson) {
      const mark = state?.firstPerson && state.firstPerson !== profile.firstPerson ? changed("firstPerson") : ""
      fields.push(`一人称: ${firstPerson}${mark}`)
    }
    if (profile.secondPerson) fields.push(`二人称: ${profile.secondPerson}`)
    if (profile.politeness) fields.push(`丁寧さ: ${profile.politeness}`)

    const rows = profile.addressTerms.map((r) => {
      const target = resolveCharacterName(index, r.target)
      return { ...r, target: target.kind === "resolved" ? target.name : r.target, mark: "" }
    })
    for (const [target, term] of Object.entries(state?.addressTerms ?? {})) {
      const row = rows.find((r) => r.target === target)
      if (!row) rows.push({ target, term, mark: changed(`addressTerms.${target}`) })
      else if (row.term !== term) Object.assign(row, { term, politeness: undefined, mark: changed(`addressTerms.${target}`) })
    }

    if (fields.length === 0 && rows.length === 0) continue
    let block = `**${name}**${fields.length > 0 ? ` — ${fields.join(" ／ ")}` : ""}`
    for (const r of rows) {
      block += `\n  - ${r.target} → ${r.term}${r.politeness ? `（${r.politeness}）` : ""}${r.mark}`
    }
    blocks.push(block)
  }
  return blocks.join("\n")
}

/** 話別（章別）プロットから該当する話・節の記述を抜き出す。「## 第1話」「## 第1章」の両対応 */
function extractOutlineSection(outline: string, target: ManuscriptSection): string | null {
  const lines = outline.split("\n")
  let collecting = false
  const collected: string[] = []

  for (const line of lines) {
    const heading = outlineHeadingSection(line)
    if (heading) {
      if (collecting) break
      if (sameSection(heading, target)) collecting = true
    }
    if (collecting) collected.push(line)
  }

  return collected.length > 0 ? collected.join("\n") : null
}

function outlineHeadingSection(line: string): ManuscriptSection | null {
  const chapterHeader = line.match(/^##\s+第\s*([0-9０-９〇零一二三四五六七八九十百千]+)\s*[章話]/)
  if (chapterHeader) {
    const num = parseChapterNumber(chapterHeader[1])
    return num === null ? null : { kind: "chapter", chapter: num }
  }
  const m = line.match(/^##\s+(.*)$/)
  return m ? parseSectionLabel(m[1], parseChapterNumber) : null
}

function extractChapterScenes(source: string, chapterNum: number, sceneId?: string): DocPart[] {
  const scenes = parseScenes(source)
  if (scenes.length === 0) {
    return source.trim().length > 0 ? [{ label: "シーン一覧", content: source }] : []
  }

  const prefix = `${chapterNum}.`
  const mine = scenes.filter((s) => s.id === String(chapterNum) || s.id.startsWith(prefix))
  if (mine.length === 0) return []

  return mine.map((s) => {
    const raw = s.raw.replace(/\s+$/, "")
    const isTarget = Boolean(sceneId) && s.id === sceneId
    if (isTarget) {
      const lines = raw.split("\n")
      lines[0] = `${lines[0]}　← 今回書くシーン`
      return { label: `シーン ${s.id}`, content: lines.join("\n"), priority: true }
    }
    return { label: `シーン ${s.id}`, content: raw }
  })
}

function foreshadowIcon(r: ForeshadowReminder): string {
  switch (r.timing) {
    case "overdue":
      return "⚠️"
    case "due":
      return "🎯"
    case "upcoming":
      return "⏰"
    case "undated":
      return "🌱"
  }
}

function foreshadowNote(r: ForeshadowReminder, currentLabel: string, unit: ChapterUnit): string {
  const planted = r.item.status === "planted" ? "張り済み" : "まだ張っていません"
  const target = r.item.targetChapter
  switch (r.timing) {
    case "overdue":
      return `${planted}／回収予定の第${target}${unit}を過ぎています（現在は${currentLabel}）`
    case "due":
      return `${planted}／← ここで回収予定`
    case "upcoming":
      return `${planted}／第${target}${unit}あたりで回収予定`
    case "undated":
      return `${planted}／回収のタイミングは未定`
  }
}

function withHeading(parts: DocPart[]): DocPart[] {
  return parts.length === 1 ? [{ ...parts[0], content: `### ${parts[0].label}\n${parts[0].content}` }] : parts
}
