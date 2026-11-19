import { join } from "node:path"
import {
  safeReadFile,
  safeReadJson,
  safeWriteJson,
  getDocPath,
  safeWriteFile,
  getConfigPath,
  getChaptersDir,
  listMarkdownFiles,
  chapterNumberFromFileName,
  chapterTitleFromHeading,
} from "../core/utils.js"
import type { ForeshadowEntry, NovelConfig } from "../core/utils.js"
import { DEFAULTS } from "../core/constants.js"
import {
  sectionFromArgs,
  recordChapterOf,
  sectionFileName,
  sectionLabel,
  sectionKey,
  compareSections,
  listManuscriptFiles,
  lastChapterForRecords,
} from "../core/sections.js"
import type { ManuscriptSection, SectionKind } from "../core/sections.js"
import {
  parseCharacterUpdates,
  parseForeshadowUpdates,
  parseSummaryInput,
  upsertSummarySections,
  summaryChapters,
  summarySections,
  splitForeshadowEntries,
  formatChapterRanges,
  readCharacterStateRecord,
  readForeshadowRecord,
  readTextRecord,
  describeBrokenRecord,
  summaryEntryOf,
} from "../core/records.js"
import type { SummarySection, RecordFile } from "../core/records.js"
import {
  applySectionUpdates,
  describeStateChange,
  emptyCharacterStateFile,
  recordedNames,
  recordedSections,
  statesThrough,
  stateKeyNames,
  formatStateKeyNames,
} from "../core/character-state.js"
import type { CharacterStateFile } from "../core/character-state.js"
import type { ToolRuntimeContext } from "./types.js"

export interface UpdateArgs {
  action: "character-state" | "summary" | "foreshadow" | "prompt"
  content: string
  section?: SectionKind
  chapterNumber?: number
  interludeIndex?: number
}

export async function novelUpdateExecute(
  args: UpdateArgs,
  ctx: ToolRuntimeContext,
): Promise<string> {
  const dir = ctx.projectDir

  if (args.chapterNumber !== undefined && !(Number.isInteger(args.chapterNumber) && args.chapterNumber > 0)) {
    return `❌ chapterNumber は1以上の整数で渡してください（受け取ったのは ${args.chapterNumber}）。記録は更新していません。`
  }

  let target: ManuscriptSection | undefined
  if (args.section !== undefined || args.interludeIndex !== undefined) {
    const resolved = sectionFromArgs(args)
    if ("error" in resolved) return `❌ ${resolved.error}。記録は更新していません。`
    target = resolved.section
  } else if (args.chapterNumber !== undefined) {
    target = { kind: "chapter", chapter: args.chapterNumber }
  }
  let chapterNumber = args.chapterNumber
  if (target && target.kind !== "chapter") {
    const config = await safeReadJson<NovelConfig>(getConfigPath(dir))
    const files = await listManuscriptFiles(dir)
    chapterNumber = recordChapterOf(target, lastChapterForRecords(files, config?.chapterCount ?? DEFAULTS.chapterCount))
  }

  switch (args.action) {
    case "character-state":
      return updateCharacterState(dir, args.content, target)
    case "summary":
      return updateSummary(dir, args.content, target)
    case "foreshadow":
      return updateForeshadow(dir, args.content, chapterNumber)
    case "prompt":
      return getUpdatePrompt(dir, args.content, chapterNumber)
    default:
      return `❌ 対応していない更新種別です: ${args.action}`
  }
}

function refuseBroken(label: string, file: string, state: Extract<RecordFile<unknown>, { kind: "broken" }>): string {
  return `❌ ${label}は更新していません（元のファイルはそのまま残しています）。
  - ${describeBrokenRecord(file, state)}
直してから、同じ内容をもう一度渡してください。`
}

async function updateCharacterState(dir: string, content: string, target?: ManuscriptSection): Promise<string> {
  if (!target) {
    return `❌ 登場人物の状態は更新していません。どの話・節の変化かが分かりません。chapterNumber（プロローグ・幕間・エピローグなら section）を渡してください。`
  }
  const parsed = parseCharacterUpdates(content)
  if (!parsed.ok) return parsed.message

  const filePath = getDocPath(dir, "character-state")
  const current = await readCharacterStateRecord(filePath)
  if (current.kind === "broken") return refuseBroken("登場人物の状態", ".novel/characters/state.json", current)
  const file: CharacterStateFile = current.kind === "ok" ? current.value : emptyCharacterStateFile()

  const key = sectionKey(target)
  const label = sectionLabel(target)
  const existed = key in file.sections
  const next: CharacterStateFile = {
    ...file,
    sections: { ...file.sections, [key]: applySectionUpdates(file.sections[key], parsed.value.updates, parsed.value.replace ?? false) },
  }

  const before = statesThrough(file, target)
  const after = statesThrough(next, target)
  const names = [...new Set([...parsed.value.updates.map((u) => u.name), ...before.map((c) => c.name), ...after.map((c) => c.name)])]
  const lines: string[] = []
  let added = 0
  let changed = 0
  let unchanged = 0
  for (const name of names) {
    const b = before.find((c) => c.name === name)
    const a = after.find((c) => c.name === name)
    const applied = describeStateChange(b, a, target)
    const requested = parsed.value.updates.some((u) => u.name === name)
    if (applied.length === 0) {
      if (requested) {
        unchanged++
        lines.push(`  - ${name}: 変更なし（記録と同じ内容でした）`)
      }
    } else if (!b) {
      added++
      lines.push(`  - ${name}（新規）: ${applied.join(", ")}`)
    } else if (!a) {
      changed++
      lines.push(`  - ${name}: ${label}の記録を外しました`)
    } else {
      changed++
      lines.push(`  - ${name}: ${applied.join(", ")}`)
    }
  }

  if (existed && added === 0 && changed === 0) {
    return `ℹ️ 登場人物の状態は変わりませんでした（${label}の記録と同じ内容でした。ファイルは書き換えていません）
${lines.join("\n")}`.trimEnd()
  }

  await safeWriteJson(filePath, next)
  const total = statesThrough(next, target).length
  let report = added === 0 && changed === 0
    ? `✅ ${label}の人物の状態を記録しました（状態の変化はありません。${label}まで登場 ${total}人）`
    : `✅ ${label}の人物の状態を更新しました（新規 ${added}人 / 更新 ${changed}人 / 変更なし ${unchanged}人 / ${label}まで登場 ${total}人）`
  if (lines.length > 0) report += `\n${lines.join("\n")}`
  const later = recordedSections(next).filter((r) => compareSections(r.section, target) > 0)
  if (later.length > 0) {
    report += `\n💡 ${sectionLabel(later[0].section)}以降の記録があります。この変化は、それより後の話・節の資料にも反映されます。`
  }
  const known = stateKeyNames(file)
  const incoming = stateKeyNames({ sections: { [key]: { updates: parsed.value.updates } } })
  const fresh: string[] = []
  for (const field of ["attributes", "lists"] as const) {
    if (known[field].length === 0) continue
    for (const k of incoming[field]) if (!known[field].includes(k)) fresh.push(`${field}.${k}`)
  }
  if (fresh.length > 0) {
    report += `\nℹ️ 新しい項目名を使いました: ${fresh.join("、")}。すでに使っている項目名: ${formatStateKeyNames(known)}（同じものを指すなら名前をそろえてください）`
  }
  return report
}

async function updateSummary(dir: string, content: string, target?: ManuscriptSection): Promise<string> {
  const parsed = parseSummaryInput(content, target)
  if (!parsed.ok) return parsed.message

  const sections: SummarySection[] = []
  for (const s of parsed.value) {
    const at: ManuscriptSection | null = s.section ?? (s.chapter !== null ? { kind: "chapter", chapter: s.chapter } : null)
    const bare = at ? summaryEntryOf(at).heading : null
    if (at && s.heading === bare) {
      const title = await chapterTitle(dir, at)
      sections.push(title ? { ...s, heading: `${bare} ${title}` } : s)
    } else {
      sections.push(s)
    }
  }

  const filePath = getDocPath(dir, "summary")
  const read = await readTextRecord(filePath)
  if (read.kind === "broken") return refuseBroken("あらすじ", ".novel/summary.md", read)
  const current = read.kind === "ok" ? read.value : ""
  const written = (await listMarkdownFiles(getChaptersDir(dir)))
    .map(chapterNumberFromFileName)
    .filter((n): n is number => n !== null)
  const incoming = sections.filter((s) => s.chapter !== null).map((s) => s.chapter as number)
  const legacyCoverage = Math.max(0, ...written, ...incoming.map((n) => n - 1))
  const next = upsertSummarySections(current, sections, legacyCoverage)
  await safeWriteFile(filePath, next)

  const touched = sections
    .map((s) => (s.section ? sectionLabel(s.section) : s.chapter !== null ? `第${s.chapter}章` : "全体の流れ"))
    .join("、")
  const recorded = summaryChapters(next)
  const recordedExtras = summarySections(next).map(sectionLabel)
  return `✅ あらすじを更新しました（${touched}）
   記録のある章: ${recorded.length > 0 ? formatChapterRanges(recorded) : "なし"}${recordedExtras.length > 0 ? `（ほかに ${recordedExtras.join("、")}）` : ""}`
}

async function chapterTitle(dir: string, section: ManuscriptSection): Promise<string | null> {
  const file = join(getChaptersDir(dir), sectionFileName(section))
  const text = await safeReadFile(file)
  return (text && chapterTitleFromHeading(text)) || null
}

async function updateForeshadow(dir: string, content: string, chapterNumber?: number): Promise<string> {
  const filePath = getDocPath(dir, "foreshadow")
  const current = await readForeshadowRecord(filePath)
  if (current.kind === "broken") return refuseBroken("伏線の記録", ".novel/foreshadow.json", current)
  const items = (current.kind === "ok" ? current.value.items : []) as unknown as ForeshadowEntry[]

  const parsed = parseForeshadowUpdates(content, new Set(items.map((f) => f.id)))
  if (!parsed.ok) return parsed.message

  let added = 0
  let changed = 0
  let unchanged = 0
  const unchangedIds: string[] = []
  for (const update of parsed.value) {
    const existing = update.id ? items.find((f) => f.id === update.id) : undefined
    const newlyResolved = update.status === "resolved" && existing?.status !== "resolved"
    if (
      newlyResolved &&
      update.resolvedChapter === undefined &&
      existing?.resolvedChapter == null &&
      chapterNumber !== undefined
    ) {
      update.resolvedChapter = chapterNumber
    }
    const target = existing ?? ({ id: update.id ?? nextForeshadowId(items), status: "pending" } as ForeshadowEntry)
    const record = target as unknown as Record<string, unknown>
    const before = JSON.stringify(record)
    const { removeKeys, ...fields } = update
    for (const [key, value] of Object.entries(fields)) {
      if (key === "id" || value === undefined) continue
      if (value === null) delete record[key]
      else record[key] = value
    }
    for (const key of removeKeys ?? []) delete record[key]

    if (!existing) {
      added++
      items.push(target)
    } else if (JSON.stringify(record) !== before) {
      changed++
    } else {
      unchanged++
      unchangedIds.push(target.id)
    }
  }

  if (added === 0 && changed === 0) {
    return `ℹ️ 伏線の記録は変わりませんでした（${unchangedIds.join("、")} は渡された内容と同じでした。ファイルは書き換えていません）`
  }

  await safeWriteJson(filePath, { items })

  const { valid, invalid } = splitForeshadowEntries(items)
  const count = (s: string) => valid.filter((f) => f.status === s).length
  let report = `✅ 伏線の記録を更新しました
   新規 ${added} / 更新 ${changed}${unchanged > 0 ? ` / 変更なし ${unchanged}（${unchangedIds.join("、")}）` : ""} / 合計 ${items.length}
   内訳: 未着手 ${count("pending")} / 張り済み ${count("planted")} / 回収済み ${count("resolved")} / 取り下げ ${count("abandoned")}`
  if (invalid.length > 0) {
    report += `\n⚠️ 形の崩れた記録が残っています: ${invalid.map((x) => `${x.id}（${x.problems.join("、")}）`).join(" / ")}`
    report += `\n   id を指して title・content・status を正しい値で渡し直してください。`
  }
  return report
}

function nextForeshadowId(items: ForeshadowEntry[]): string {
  const used = new Set(items.map((f) => f.id))
  let n = items.length + 1
  while (used.has(`F${n}`)) n++
  return `F${n}`
}

async function getUpdatePrompt(dir: string, promptType: string, chapterNumber?: number): Promise<string> {
  const { getPromptTemplate, listPromptTemplates, buildPromptVars, fillPrompt, remainingPlaceholders } = await import("../core/prompts.js")
  const template = getPromptTemplate(promptType)
  if (!template) {
    return `❌ そのプロンプトは見つかりません: ${promptType}
使えるもの: ${listPromptTemplates().join(", ")}`
  }

  const config = await safeReadJson<NovelConfig>(getConfigPath(dir))
  const state = await readCharacterStateRecord(getDocPath(dir, "character-state"))
  const names = state.kind === "ok" ? recordedNames(state.value) : []
  const keyNames = state.kind === "ok" ? formatStateKeyNames(stateKeyNames(state.value)) : ""
  const vars = buildPromptVars(config, {
    chapterNumber,
    charactersToTrack: names.length > 0 ? `${names.join("、")}（この話に出てこない人物は省く）` : "この話に出てきた全員",
  })
  const filled = fillPrompt(template, vars)
  const left = remainingPlaceholders(filled)
  const leftNote = left.length > 0
    ? `\n\n📌 資料から埋めて使う差し込み: ${left.map((k) => `{${k}}`).join("、")}`
    : ""

  const keyNote = promptType === "character-state-update" && keyNames
    ? `\n\n📌 この作品の記録で使っている項目名: ${keyNames}（同じものはこの名前で書く）`
    : ""

  return `📝 プロンプト「${promptType}」:

${filled}${leftNote}${keyNote}

💡 このプロンプトと本文を合わせて使い、得られた結果を novel_update で保存してください。`
}
