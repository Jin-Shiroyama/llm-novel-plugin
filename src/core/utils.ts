/**
 * llm-novel-plugin - 共通ユーティリティ
 *
 * パス解決・ファイル入出力・文書解析・進行状況の判定・文字数カウントをまとめたモジュール。
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises"
import { join, resolve, relative } from "node:path"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import {
  DEFAULTS,
  LIMITS,
  FORESHADOW_LOOKAHEAD,
  MINIMAL_WORLD_GENRE_KEYWORDS,
  LIGHT_TONE_GENRE_KEYWORDS,
  FANTASY_GENRE_KEYWORDS,
  ROMANCE_GENRE_KEYWORDS,
  SLICE_OF_LIFE_GENRE_KEYWORDS,
  SF_GENRE_KEYWORDS,
} from "./constants.js"
import type {
  LimitKey,
  StoryMode,
  Seriousness,
  WorldBuildingMode,
  IndentStyle,
  ChapterUnit,
} from "./constants.js"
import { stripRuby } from "./ruby.js"
import { parseNameFields } from "./name-fields.js"
import {
  CONCEPT_TEMPLATE,
  WORLD_BUILDING_TEMPLATE,
  CHARACTER_PROFILES_TEMPLATE,
  isUntouchedTemplate,
} from "./templates.js"

export { existsSync } from "node:fs"

// ============================================================
// 定数
// ============================================================

/** 作品データを置くディレクトリ */
export const NOVEL_DIR = ".novel"

/** 文書の種類 */
export type DocType =
  | "concept"
  | "world-building"
  | "glossary"
  | "characters"
  | "character-state"
  | "outline-brief"
  | "outline-detailed"
  | "scenes"
  | "summary"
  | "foreshadow"
  | "chapter"

/** 執筆の進行段階 */
export type Phase = "concept" | "world-building" | "characters" | "outline" | "scenes" | "writing" | "completed"

/** シーンの状態 */
export type SceneStatus = "pending" | "in-progress" | "completed"

/** 伏線の状態 */
export type ForeshadowStatus = "pending" | "planted" | "resolved" | "abandoned"

// ============================================================
// パス
// ============================================================

/** 作品データディレクトリのパスを返す */
export function getNovelDir(projectDir: string): string {
  return join(projectDir, NOVEL_DIR)
}

/** 設定ファイルのパスを返す */
export function getConfigPath(projectDir: string): string {
  return join(getNovelDir(projectDir), "config.json")
}

/** 文書の種類からファイルパスを返す */
export function getDocPath(projectDir: string, docType: DocType, name?: string): string {
  const base = getNovelDir(projectDir)
  switch (docType) {
    case "concept":
      return join(base, "concept.md")
    case "world-building":
      return join(base, "world-building.md")
    case "glossary":
      return join(base, "glossary.md")
    case "characters":
      return join(base, "characters", "profiles.md")
    case "character-state":
      return join(base, "characters", "state.json")
    case "outline-brief":
      return join(base, "outline-brief.md")
    case "outline-detailed":
      return join(base, "outline-detailed.md")
    case "scenes":
      return join(base, "scenes.md")
    case "summary":
      return join(base, "summary.md")
    case "foreshadow":
      return join(base, "foreshadow.json")
    case "chapter":
      return join(base, "chapters", `${name}.md`)
    default:
      return join(base, `${docType}.md`)
  }
}

/** 本文ディレクトリのパスを返す */
export function getChaptersDir(projectDir: string): string {
  return join(getNovelDir(projectDir), "chapters")
}

// ============================================================
// ファイル入出力
// ============================================================

/** ファイルを読む。存在しなければ null を返す */
export async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8")
  } catch {
    return null
  }
}

/** ファイルを書く。親ディレクトリがなければ作る */
export async function safeWriteFile(filePath: string, content: string): Promise<void> {
  const dir = resolve(filePath, "..")
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
  await writeFile(filePath, content, "utf-8")
}

/** 上書き保存の前に旧稿を .novel/drafts/ へ退避する */
export async function backupPreviousDraft(dir: string, fileName: string, content: string): Promise<string> {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const base = join(getNovelDir(dir), "drafts", `${fileName.replace(/\.md$/, "")}-${stamp}`)
  let path = `${base}.md`
  for (let n = 2; existsSync(path); n++) path = `${base}-${n}.md`
  await safeWriteFile(path, content)
  return path
}

/** JSON ファイルを読む。存在しないか壊れていれば null を返す */
export async function safeReadJson<T>(filePath: string): Promise<T | null> {
  const content = await safeReadFile(filePath)
  if (!content) return null
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

/** JSON ファイルを書く */
export async function safeWriteJson<T>(filePath: string, data: T): Promise<void> {
  await safeWriteFile(filePath, JSON.stringify(data, null, 2))
}

// ============================================================
// 分割保存
// ============================================================

/** .novel/ 配下のパスを組み立てる */
export function getNovelPath(projectDir: string, ...parts: string[]): string {
  return join(getNovelDir(projectDir), ...parts)
}

/** 文書の一片。label はどのファイル由来かを示す */
export interface DocPart {
  label: string
  content: string
  /** 文字数の枠を先に確保する */
  priority?: boolean
  /** 小さい順に文字数を配分する。指定が無い場合は priority に従う。 */
  rank?: number
}

/** ディレクトリを再帰的にたどり、.md のパスを集める（深さは3階層まで） */
function collectMarkdownPaths(dir: string, depth = 3): string[] {
  if (depth < 0 || !existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir).sort()
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) out.push(...collectMarkdownPaths(full, depth - 1))
    else if (name.endsWith(".md")) out.push(full)
  }
  return out
}

/** 統合ファイルと分割ディレクトリの両方から文書を集める */
export async function readDocParts(
  projectDir: string,
  filePath: string | null,
  dirPath: string | null,
): Promise<DocPart[]> {
  const parts: DocPart[] = []
  if (filePath) {
    const content = await safeReadFile(getNovelPath(projectDir, filePath))
    if (content && content.trim().length > 0) parts.push({ label: filePath, content })
  }
  if (dirPath) {
    const base = getNovelPath(projectDir, dirPath)
    for (const full of collectMarkdownPaths(base)) {
      const content = await safeReadFile(full)
      if (content && content.trim().length > 0) {
        parts.push({ label: relative(getNovelDir(projectDir), full), content })
      }
    }
  }
  return parts
}

/**
 * 話・章ごとの分割ファイルの名前。
 * 読み込み・存在判定・集計の除外判定がすべてこの定義を共有する。
 */
const CHAPTER_FILE_PATTERN = /^chapter-(\d+)\.md$/

/** 話・章ごとの分割ファイル名（chapter-001.md のように3桁ゼロ埋め） */
export function chapterFileName(chapterNum: number): string {
  return `chapter-${String(chapterNum).padStart(3, "0")}.md`
}

/** ファイル名から番号を取る。正式な形式でなければ null */
export function chapterNumberFromFileName(fileName: string): number | null {
  const m = fileName.match(CHAPTER_FILE_PATTERN)
  return m ? parseInt(m[1], 10) : null
}

/** 分割ファイルの相対パスが直下の正式なファイルかを判定して番号を返す */
export function chapterDocNumber(relPath: string, dirName: string): number | null {
  const segs = relPath.split(/[\\/]+/).filter((x) => x.length > 0)
  if (segs.length !== 2 || segs[0] !== dirName) return null
  return chapterNumberFromFileName(segs[1])
}

/** ディレクトリ直下の正式な話・章ファイルを列挙する */
export async function listChapterDocs(
  projectDir: string,
  dirName: string,
): Promise<Array<{ chapter: number; label: string; content: string }>> {
  const dir = getNovelPath(projectDir, dirName)
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  const out: Array<{ chapter: number; label: string; content: string }> = []
  const seen = new Set<number>()
  for (const name of names) {
    const chapter = chapterNumberFromFileName(name)
    if (chapter === null) continue
    if (seen.has(chapter)) continue
    const content = await safeReadFile(join(dir, name))
    if (!content || content.trim().length === 0) continue
    seen.add(chapter)
    out.push({ chapter, label: `${dirName}/${name}`, content })
  }
  return out
}

/** 話・章ごとに分割された文書を読む */
export async function readChapterDoc(
  projectDir: string,
  dirName: string,
  chapterNum: number,
): Promise<string | null> {
  const docs = await listChapterDocs(projectDir, dirName)
  return docs.find((d) => d.chapter === chapterNum)?.content ?? null
}

/** シーンID「2.1」から話・章番号 2 を取り出す */
export function sceneChapterNumber(sceneId: string): number | null {
  const head = sceneId.split(".")[0]
  return parseChapterNumber(head)
}

/** 集計用のシーン */
export interface SceneEntry {
  id: string
  title: string
  status: SceneStatus
  source: string
}

/** シーンを集めて数える（同じ話が統合と分割の両方にあるときは分割側だけを数える） */
export async function collectScenes(projectDir: string): Promise<SceneEntry[]> {
  const chapterDocs = await listChapterDocs(projectDir, "scenes")
  const consolidated = await readDocParts(projectDir, "scenes.md", null)
  const coveredChapters = new Set(chapterDocs.map((d) => d.chapter))
  const entries: SceneEntry[] = []

  for (const doc of chapterDocs) {
    for (const scene of parseScenes(doc.content)) {
      entries.push({ id: scene.id, title: scene.title, status: scene.status, source: doc.label })
    }
  }

  for (const part of consolidated) {
    for (const scene of parseScenes(part.content)) {
      const chapter = sceneChapterNumber(scene.id)
      if (chapter !== null && coveredChapters.has(chapter)) continue
      entries.push({ id: scene.id, title: scene.title, status: scene.status, source: part.label })
    }
  }

  return entries
}

/** 分割ファイルが1つ以上あるか */
export function hasChapterDocs(projectDir: string, dirName: string): boolean {
  const dir = getNovelPath(projectDir, dirName)
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).some((f) => CHAPTER_FILE_PATTERN.test(f))
  } catch {
    return false
  }
}

/** 話別（章別）プロットができているか */
export function hasOutlineDetailed(projectDir: string): boolean {
  return existsSync(getDocPath(projectDir, "outline-detailed")) || hasChapterDocs(projectDir, "outline")
}

/** シーン一覧ができているか */
export function hasSceneList(projectDir: string): boolean {
  return existsSync(getDocPath(projectDir, "scenes")) || hasChapterDocs(projectDir, "scenes")
}

/** 一人ずつのキャラクターシート */
export interface CharacterDoc extends DocPart {
  /** 文書中に書かれた呼称・別名 */
  aliases: string[]
  /** 原作の人物（二次創作。canon/characters/ に置いたもの） */
  canon?: boolean
}

export async function listCharacterDocs(projectDir: string): Promise<CharacterDoc[]> {
  return [
    ...(await readCharacterDir(getNovelPath(projectDir, "characters"), false)),
    ...(await readCharacterDir(getNovelPath(projectDir, "canon", "characters"), true)),
  ]
}

async function readCharacterDir(dir: string, canon: boolean): Promise<CharacterDoc[]> {
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "profiles.md").sort()
  } catch {
    return []
  }
  const parts: CharacterDoc[] = []
  for (const name of names) {
    const content = await safeReadFile(join(dir, name))
    if (content && content.trim().length > 0) {
      parts.push({
        label: name.replace(/\.md$/, ""),
        content,
        aliases: extractNameAliases(content),
        ...(canon ? { canon: true } : {}),
      })
    }
  }
  return parts
}

/** 雛形のプレースホルダ（`[…]`）のままの値か */
export function isPlaceholderValue(value: string): boolean {
  const t = value.replace(/\*\*/g, "").trim()
  return t.length === 0 || /^\[[^\]]*\]$/.test(t)
}

/** キャラクターシートから呼称・別名を読み取る */
export function extractNameAliases(content: string): string[] {
  return parseNameFields(content).aliases
}

/** 人物のことばづかい（`## ことばづかい` から読み取る） */
export interface SpeechProfile {
  firstPerson?: string
  secondPerson?: string
  politeness?: string
  addressTerms: Array<{ target: string; term: string; politeness?: string }>
}

const SPEECH_FIELD_LINE = /^\s*[-*・]\s*(?:\*\*)?(一人称|二人称|丁寧さの基本)(?:\*\*)?\s*[：:]\s*(.*)$/
const ADDRESS_TABLE_HEADING = /^#{2,6}\s*相手ごとの呼び方/

/** キャラクターシートからことばづかいを読み取る。記入された項目が無ければ null */
export function extractSpeechProfile(content: string): SpeechProfile | null {
  const profile: SpeechProfile = { addressTerms: [] }
  const keys = { 一人称: "firstPerson", 二人称: "secondPerson", 丁寧さの基本: "politeness" } as const
  const lines = content.split("\n")
  let inTable = false
  let headerSeen = false
  for (const line of lines) {
    const field = line.match(SPEECH_FIELD_LINE)
    if (field) {
      const value = field[2].trim()
      if (!isPlaceholderValue(value)) profile[keys[field[1] as keyof typeof keys]] = value
      continue
    }
    if (ADDRESS_TABLE_HEADING.test(line)) {
      inTable = true
      headerSeen = false
      continue
    }
    if (!inTable) continue
    const trimmed = line.trim()
    if (/^#/.test(trimmed)) {
      inTable = false
      continue
    }
    if (!trimmed.startsWith("|")) {
      if (headerSeen && trimmed.length > 0) inTable = false
      continue
    }
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.replace(/\*\*/g, "").trim())
    if (!headerSeen) {
      headerSeen = true
      continue
    }
    if (cells.every((c) => /^:?-+:?$/.test(c) || c === "")) continue
    const [target = "", term = "", politeness = ""] = cells
    if (isPlaceholderValue(target) || isPlaceholderValue(term)) continue
    profile.addressTerms.push(isPlaceholderValue(politeness) ? { target, term } : { target, term, politeness })
  }
  const filled =
    profile.firstPerson !== undefined ||
    profile.secondPerson !== undefined ||
    profile.politeness !== undefined ||
    profile.addressTerms.length > 0
  return filled ? profile : null
}

export { characterNameKeys, selectCharacterDocs } from "./character-names.js"

// ============================================================
// 文字数の枠の配分
// ============================================================

function fairAllocate(sizes: number[], limit: number): number[] {
  const alloc = sizes.map(() => 0)
  if (limit <= 0) return alloc

  let remaining = limit
  let pending = sizes.map((_, i) => i).filter((i) => sizes[i] > 0)

  while (pending.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / pending.length)
    if (share < 1) break
    const satisfied = pending.filter((i) => sizes[i] <= share)
    if (satisfied.length === 0) {
      for (const i of pending) {
        alloc[i] = share
        remaining -= share
      }
      pending = []
      break
    }
    for (const i of satisfied) {
      alloc[i] = sizes[i]
      remaining -= sizes[i]
    }
    const done = new Set(satisfied)
    pending = pending.filter((i) => !done.has(i))
  }

  for (const i of pending) {
    if (remaining <= 0) break
    const give = Math.min(remaining, sizes[i] - alloc[i])
    alloc[i] += give
    remaining -= give
  }

  return alloc
}

export function allocateCharBudget(
  sizes: number[],
  limit: number,
  priority: boolean[] = [],
): number[] {
  const alloc = sizes.map(() => 0)
  if (limit <= 0) return alloc

  const priorityIdx = sizes.map((_, i) => i).filter((i) => priority[i])
  const restIdx = sizes.map((_, i) => i).filter((i) => !priority[i])

  if (priorityIdx.length === 0) return fairAllocate(sizes, limit)

  const priorityAlloc = fairAllocate(priorityIdx.map((i) => sizes[i]), limit)
  priorityIdx.forEach((i, k) => {
    alloc[i] = priorityAlloc[k]
  })

  const used = priorityAlloc.reduce((a, b) => a + b, 0)
  const restAlloc = fairAllocate(restIdx.map((i) => sizes[i]), limit - used)
  restIdx.forEach((i, k) => {
    alloc[i] = restAlloc[k]
  })

  return alloc
}

export function clipDocParts(parts: DocPart[], limit: number): string {
  if (parts.length === 0) return ""

  const rank = (p: DocPart) => p.rank ?? (p.priority ? 0 : 1)
  const ordered = [...parts].sort((a, b) => rank(a) - rank(b))
  const bodies = ordered.map((p) => p.content.trim())
  const sizes = bodies.map((b) => [...b].length)
  const showLabels = ordered.length > 1
  const label = (i: number) => (showLabels ? `### ${ordered[i].label}\n` : "")

  if (sizes.reduce((a, b) => a + b, 0) <= limit) {
    return ordered.map((_, i) => label(i) + bodies[i]).join("\n\n")
  }

  const alloc = sizes.map(() => 0)
  let remaining = limit
  for (const tier of [...new Set(ordered.map(rank))]) {
    const indices = ordered.map((p, i) => rank(p) === tier ? i : -1).filter(i => i >= 0)
    const shares = fairAllocate(indices.map(i => sizes[i]), remaining)
    indices.forEach((i, k) => { alloc[i] = shares[k]; remaining -= shares[k] })
  }
  const out: string[] = []
  for (let i = 0; i < ordered.length; i++) {
    if (alloc[i] <= 0) {
      out.push(`### ${ordered[i].label}\n…（文字数の枠が足りず省略。全文はファイルを直接参照してください）`)
      continue
    }
    const [body, truncated] = truncateChars(bodies[i], alloc[i])
    out.push(label(i) + body + (truncated ? "\n…（以下省略。全文は該当ファイルを直接参照してください）" : ""))
  }
  return out.join("\n\n")
}

// ============================================================
// 文書解析
// ============================================================

export function parseScenes(content: string): Array<{
  id: string
  title: string
  status: SceneStatus
  raw: string
}> {
  const scenes: Array<{ id: string; title: string; status: SceneStatus; raw: string }> = []
  const lines = content.split("\n")
  let currentScene: { id: string; title: string; status: SceneStatus; rawLines: string[] } | null = null

  for (const line of lines) {
    const sceneMatch = line.match(/^###\s+(?:(?:シーン|場面|Scene)\s*)?(\d+(?:\.\d+)?)\s*[-–—]?\s*(.*)/)
    if (sceneMatch) {
      if (currentScene) {
        scenes.push({ ...currentScene, raw: currentScene.rawLines.join("\n") })
      }
      currentScene = {
        id: sceneMatch[1],
        title: sceneMatch[2].trim(),
        status: "pending",
        rawLines: [line],
      }
      continue
    }

    const checkMatch = line.match(/^\s*(?:[-*+]\s+)+\[([ xX\-])\]/)
    if (checkMatch && currentScene) {
      const flag = checkMatch[1].toLowerCase()
      if (flag === "x") currentScene.status = "completed"
      else if (flag === "-") currentScene.status = "in-progress"
      else currentScene.status = "pending"
    }

    if (currentScene) {
      currentScene.rawLines.push(line)
    }
  }

  if (currentScene) {
    scenes.push({ ...currentScene, raw: currentScene.rawLines.join("\n") })
  }

  return scenes
}

/** 伏線の項目 */
export interface ForeshadowEntry {
  id: string
  title: string
  content: string
  category: string
  status: ForeshadowStatus
  plantChapter?: number
  targetChapter?: number
  resolvedChapter?: number
  notes?: string
}

export type ForeshadowTiming = "overdue" | "due" | "upcoming" | "undated"

export interface ForeshadowReminder {
  item: ForeshadowEntry
  timing: ForeshadowTiming
}

const FORESHADOW_CLOSED: ReadonlySet<ForeshadowStatus> = new Set<ForeshadowStatus>([
  "resolved",
  "abandoned",
])

const TIMING_ORDER: Record<ForeshadowTiming, number> = {
  overdue: 0,
  due: 1,
  upcoming: 2,
  undated: 3,
}

export function selectForeshadowReminders(
  items: ForeshadowEntry[],
  chapterNum: number,
  lookahead: number = FORESHADOW_LOOKAHEAD,
): ForeshadowReminder[] {
  const reminders: ForeshadowReminder[] = []

  for (const item of items) {
    if (FORESHADOW_CLOSED.has(item.status)) continue

    const target = item.targetChapter
    let timing: ForeshadowTiming
    if (target === undefined || target === null) {
      timing = "undated"
    } else if (target < chapterNum) {
      timing = "overdue"
    } else if (target === chapterNum) {
      timing = "due"
    } else {
      timing = "upcoming"
    }

    const always = item.status === "planted" || timing === "overdue" || timing === "due"
    const near = target !== undefined && target !== null && target <= chapterNum + lookahead
    if (!always && !near) continue

    reminders.push({ item, timing })
  }

  return reminders.sort((a, b) => {
    const byTiming = TIMING_ORDER[a.timing] - TIMING_ORDER[b.timing]
    if (byTiming !== 0) return byTiming
    const ta = a.item.targetChapter ?? Number.MAX_SAFE_INTEGER
    const tb = b.item.targetChapter ?? Number.MAX_SAFE_INTEGER
    return ta - tb
  })
}

export type NovelLimits = Partial<Record<LimitKey, number>>

/** プロジェクト設定（.novel/config.json） */
export interface NovelConfig {
  title: string
  genre: string
  /** 構成の型: arc（アーク連載）/ episodic（日常・イベント）/ plot（1巻完結）/ short（短編） */
  storyMode?: StoryMode
  /** 作品の雰囲気・読後感（例: 笑える・掛け合い／ニヤニヤ・甘い、ワクワク・爽快） */
  tone?: string
  /** シリアス度: light（軽快・明るめ）/ balanced（エンタメ標準）/ serious（シリアス重視） */
  seriousness?: Seriousness
  /** 世界観・設定の扱い: minimal（最小限・世界観工程スキップ可）/ standard（world-building.md を使う） */
  worldBuilding?: WorldBuildingMode
  /** 段落頭の字下げ: fullwidth（全角1字下げ）/ none（Web小説の字下げなし） */
  indent?: IndentStyle
  targetWords?: number
  chapterCount?: number
  narrativePerspective?: string
  /** 任意の既定視点人物。キャラ設計後に正式名で設定する。 */
  defaultPovCharacter?: string
  /** 資料読み込みの文字数上限の上書き */
  limits?: NovelLimits
  /** 部の構成（カクヨムの大見出し等）。fromChapter は通し番号 */
  parts?: Array<{ title: string; fromChapter: number }>
  /** 連載（結末未定）。true なら chapterCount は目安で、epilogue.md で完結判定 */
  serial?: boolean
  /** 二次創作の原作名。あれば .novel/canon/ を資料に載せる */
  sourceWork?: string
  /** 書き出し時の単位の呼び名（既定 "話"） */
  chapterUnit?: ChapterUnit
  createdAt: string
  updatedAt: string
  currentPhase: Phase
}

export function resolveLimit(config: NovelConfig | null | undefined, key: LimitKey): number {
  const override = config?.limits?.[key]
  if (typeof override === "number" && Number.isFinite(override)) {
    const value = Math.floor(override)
    if (value >= 1) return value
  }
  return LIMITS[key]
}

// ============================================================
// 文字数
// ============================================================

/** 空白と改行を除いた本文の文字数（ルビ・傍点は親文字だけ数える） */
export function countWords(text: string): number {
  if (!text) return 0
  let count = 0
  for (const ch of stripRuby(text)) {
    if (!isWhitespace(ch)) count++
  }
  return count
}

/**
 * 話・章見出しの行。
 * 保存ファイルは `# 第N章 タイトル` だが、手動編集で `# 第N話 タイトル` になっていても認識する。
 */
const CHAPTER_HEADING_LINE =
  /^#{1,6}\s*(?:第\s*[0-9０-９〇零一二三四五六七八九十百千]+\s*[章話]|(?:プロローグ|エピローグ|幕間)(?=[\s　]|$))/

export function normalizeChapterTitle(title: string): string {
  if (!title) return ""
  return title
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\t\v\f\u0000-\u001f\u007f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
}

export function stripChapterHeading(content: string): string {
  if (!content) return content
  const lines = content.replace(/\r\n/g, "\n").split("\n")

  let i = 0
  while (i < lines.length && lines[i].trim().length === 0) i++
  if (i >= lines.length) return ""
  if (!CHAPTER_HEADING_LINE.test(lines[i].trim())) return content

  i++
  while (i < lines.length && lines[i].trim().length === 0) i++
  return lines.slice(i).join("\n").replace(/\s+$/, "")
}

function isWhitespace(ch: string): boolean {
  return /^[\s　\u00A0\u200B\uFEFF]$/u.test(ch)
}

export function truncateChars(text: string, limit: number): [string, boolean] {
  if (limit <= 0) return ["", text.length > 0]
  const chars = [...text]
  if (chars.length <= limit) return [text, false]
  return [chars.slice(0, limit).join(""), true]
}

export function takeTailChars(text: string, limit: number): string {
  if (limit <= 0) return ""
  const chars = [...text]
  if (chars.length <= limit) return text
  return chars.slice(-limit).join("")
}

// ============================================================
// 作品設定・ジャンル推定
// ============================================================

function normalizeGenre(genre: string | undefined | null): string {
  if (!genre) return ""
  return genre.normalize("NFKC").replace(/[\s　・、\uFF0C,/|()（）【】\[\]「」]/g, "")
}

/** ジャンルから世界観の標準/最小限を推定する */
export function inferWorldBuilding(genre: string | undefined | null, storyMode?: StoryMode): WorldBuildingMode {
  if (storyMode === "short") return "minimal"
  const norm = normalizeGenre(genre)
  if (!norm) return DEFAULTS.worldBuilding
  // ファンタジーやSFが同時に含まれる場合（「学園ファンタジー」「ラブコメSF」等）は設定が必要になりやすい
  if (FANTASY_GENRE_KEYWORDS.some((k) => norm.includes(k)) || SF_GENRE_KEYWORDS.some((k) => norm.includes(k))) {
    return "standard"
  }
  if (MINIMAL_WORLD_GENRE_KEYWORDS.some((k) => norm.includes(k))) return "minimal"
  return DEFAULTS.worldBuilding
}

/** ジャンルからシリアス度の既定を推定する */
export function inferSeriousness(genre: string | undefined | null): Seriousness {
  const norm = normalizeGenre(genre)
  if (LIGHT_TONE_GENRE_KEYWORDS.some((k) => norm.includes(k))) return "light"
  return DEFAULTS.seriousness
}

/** ジャンルに対応する特化スキル名の一覧を返す（該当が無ければ空配列） */
export function recommendedGenreSkills(genre: string | undefined | null): string[] {
  const norm = normalizeGenre(genre)
  if (!norm) return []
  const skills: string[] = []
  if (FANTASY_GENRE_KEYWORDS.some((k) => norm.includes(k))) skills.push("genre-fantasy")
  if (ROMANCE_GENRE_KEYWORDS.some((k) => norm.includes(k))) skills.push("genre-romance")
  if (SLICE_OF_LIFE_GENRE_KEYWORDS.some((k) => norm.includes(k))) skills.push("genre-slice-of-life")
  if (SF_GENRE_KEYWORDS.some((k) => norm.includes(k))) skills.push("genre-sf")
  return skills
}

export function storyModeOf(config: Pick<NovelConfig, "storyMode"> | null | undefined): StoryMode {
  return config?.storyMode ?? DEFAULTS.storyMode
}

export function isShortForm(config: Pick<NovelConfig, "storyMode"> | null | undefined): boolean {
  return storyModeOf(config) === "short"
}

export function isSerial(config: Pick<NovelConfig, "serial"> | null | undefined): boolean {
  return config?.serial === true
}

export function usesWorldBuilding(
  config: Pick<NovelConfig, "storyMode" | "worldBuilding" | "genre"> | null | undefined,
): boolean {
  if (isShortForm(config)) return false
  if (config?.worldBuilding) return config.worldBuilding === "standard"
  return inferWorldBuilding(config?.genre, config?.storyMode) === "standard"
}

export function seriousnessOf(
  config: Pick<NovelConfig, "seriousness" | "genre"> | null | undefined,
): Seriousness {
  return config?.seriousness ?? inferSeriousness(config?.genre)
}

export function indentStyleOf(config: Pick<NovelConfig, "indent"> | null | undefined): IndentStyle {
  return config?.indent ?? DEFAULTS.indent
}

export function storyModeLabel(mode: StoryMode): string {
  switch (mode) {
    case "arc":
      return "アーク連載型（10〜15話で1つの山）"
    case "episodic":
      return "日常・イベント型（掛け合い・行事・甘さや暮らしで進む）"
    case "plot":
      return "完結プロット型（1巻完結・全体構成）"
    case "short":
      return "短編・読み切り"
  }
}

export function seriousnessLabel(level: Seriousness): string {
  switch (level) {
    case "light":
      return "軽快・明るめ（シリアス・重い過去を勝手に足さない）"
    case "balanced":
      return "エンタメ標準（楽しさと見せ場の熱さのバランス）"
    case "serious":
      return "シリアス重視（緊張感や葛藤をしっかり描く）"
  }
}

// ============================================================
// 進行状況の判定
// ============================================================

const PLACEHOLDER_PATTERN = /\[(?![ x-]\])[^\]\n]{1,60}\](?!\()/
const TEMPLATE_PLACEHOLDER_GLOBAL = /\[(?![ x-]\])[^\]\n]+\](?!\()/g

function hasRemainingTemplatePlaceholder(content: string, template: string): boolean {
  if (isUntouchedTemplate(content, template)) return true
  const placeholders = new Set<string>()
  for (const m of template.matchAll(TEMPLATE_PLACEHOLDER_GLOBAL)) {
    placeholders.add(m[0])
  }
  for (const p of placeholders) {
    if (content.includes(p)) return true
  }
  return false
}

/**
 * 雛形ファイルが記入済みかを判定する。
 * template を渡した場合は、テンプレート由来のプレースホルダが残っている（または未編集のまま）ときだけ未記入とみなし、
 * 書き手が意図して書いた角括弧（[Lv1] や [仮] など）で工程が止まらないようにする。
 */
export function isDocFilled(filePath: string, template?: string): boolean {
  if (!existsSync(filePath)) return false
  let content: string
  try {
    content = readFileSync(filePath, "utf-8")
  } catch {
    return false
  }
  if (content.trim().length === 0) return false
  if (template !== undefined) return !hasRemainingTemplatePlaceholder(content, template)
  return !PLACEHOLDER_PATTERN.test(content)
}

export function countWrittenChapters(projectDir: string): number {
  const dir = getChaptersDir(projectDir)
  if (!existsSync(dir)) return 0
  try {
    return readdirSync(dir).filter((f) => /^chapter-\d+\.md$/.test(f)).length
  } catch {
    return 0
  }
}

/**
 * 現在の進行段階を判定する。
 *
 * - ラブコメ・日常・短編（usesWorldBuilding が false）は world-building を飛ばす
 * - シーン設計は任意工程とし、話別プロットがあればそのまま writing へ進める
 * - 連載（serial: true）は epilogue.md があれば completed、そうでなければ writing
 */
export function determinePhase(projectDir: string, config?: NovelConfig | null): Phase {
  const short = isShortForm(config)
  if (!isDocFilled(getDocPath(projectDir, "concept"), CONCEPT_TEMPLATE)) return "concept"
  if (usesWorldBuilding(config) && !isDocFilled(getDocPath(projectDir, "world-building"), WORLD_BUILDING_TEMPLATE)) return "world-building"
  if (!isDocFilled(getDocPath(projectDir, "characters"), CHARACTER_PROFILES_TEMPLATE)) return "characters"
  if (!existsSync(getDocPath(projectDir, "outline-brief"))) return "outline"
  if (!short && !hasOutlineDetailed(projectDir)) return "outline"

  if (isSerial(config)) {
    return existsSync(join(getChaptersDir(projectDir), "epilogue.md")) ? "completed" : "writing"
  }
  const written = countWrittenChapters(projectDir)
  const planned = config?.chapterCount ?? DEFAULTS.chapterCount
  if (written > 0 && written >= planned) return "completed"
  return "writing"
}

export async function listMarkdownFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const files = await readdir(dir)
  return files.filter((f) => f.endsWith(".md")).sort()
}

// ============================================================
// 表示・数値変換
// ============================================================

export function progressBar(completed: number, total: number, width = 20): string {
  if (total === 0) return "[" + "─".repeat(width) + "] 0%"
  const filled = Math.round((completed / total) * width)
  const bar = "█".repeat(filled) + "░".repeat(width - filled)
  const percent = Math.round((completed / total) * 100)
  return `[${bar}] ${percent}% (${completed}/${total})`
}

const KANJI_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

export function parseChapterNumber(raw: string): number | null {
  const text = raw.trim().normalize("NFKC")
  if (/^\d+$/.test(text)) return parseInt(text, 10)

  if (!/^[〇零一二三四五六七八九十百千]+$/.test(text)) return null

  let total = 0
  let section = 0
  let current = 0
  for (const ch of text) {
    if (ch in KANJI_DIGITS) {
      current = KANJI_DIGITS[ch]
      continue
    }
    if (ch === "十") {
      section += (current || 1) * 10
      current = 0
      continue
    }
    if (ch === "百") {
      section += (current || 1) * 100
      current = 0
      continue
    }
    if (ch === "千") {
      total += (section + (current || 1)) * 1000
      section = 0
      current = 0
      continue
    }
  }
  const value = total + section + current
  return value > 0 ? value : null
}

export function toKanjiNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 9999) return String(n)
  if (n === 0) return "〇"
  const digits = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"]
  const units: Array<[number, string]> = [[1000, "千"], [100, "百"], [10, "十"]]
  let rest = n
  let out = ""
  for (const [value, unit] of units) {
    const d = Math.floor(rest / value)
    if (d > 0) out += (d === 1 ? "" : digits[d]) + unit
    rest %= value
  }
  return out + digits[rest]
}

export async function listChapterFiles(projectDir: string): Promise<Array<{ chapter: number; path: string }>> {
  const dir = getChaptersDir(projectDir)
  return (await listMarkdownFiles(dir))
    .map((f) => ({ chapter: chapterNumberFromFileName(f), path: join(dir, f) }))
    .filter((x): x is { chapter: number; path: string } => x.chapter !== null)
    .sort((a, b) => a.chapter - b.chapter)
}

/** 保存ファイルの見出し（`# 第N章 タイトル`、`# 第N話 タイトル`、`# プロローグ タイトル` など）からタイトルを読む */
export function chapterTitleFromHeading(text: string): string {
  const firstLine = text.replace(/\r\n/g, "\n").split("\n").find((l) => l.trim().length > 0) ?? ""
  const m = firstLine.match(
    /^#[ \t]*(?:第[ \t]*[0-9０-９〇零一二三四五六七八九十百千]+[ \t]*[章話]|プロローグ|エピローグ|幕間)[ \t　]+(\S.*)$/,
  )
  return m ? m[1].trim() : ""
}
