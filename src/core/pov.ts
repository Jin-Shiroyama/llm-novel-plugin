/** 任意の視点・登場人物指定。自由文の人物出現判定とは別に扱う。 */
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { resolveCharacterName } from "./character-names.js"
import type { CharacterIndex } from "./character-names.js"
import { isUnspecifiedName, parseNameList, readNameField } from "./name-fields.js"
import { getNovelDir, safeReadFile, isShortForm } from "./utils.js"
import type { NovelConfig } from "./utils.js"

export type PovChoice = { kind: "unspecified" | "none" | "invalid" } | { kind: "resolved"; name: string }
export interface PovFields { pov: PovChoice; cast: string[]; warnings: string[] }

function resolveReference(index: CharacterIndex, input: string, source: string, warnings: string[]): string | null {
  const ref = resolveCharacterName(index, input)
  if (ref.kind !== "resolved") {
    warnings.push(`${source}: 人物「${input}」を${ref.kind === "unknown" ? "登録済みのシートに解決できません" : `一人に確定できません（候補: ${ref.candidates.join("、")}）`}。正式名で指定してください`)
    return null
  }
  if (ref.name !== input) warnings.push(`${source}: 「${input}」を「${ref.name}」として参照しています。正式名への更新を確認してください`)
  return ref.name
}

function parsePov(value: unknown, index: CharacterIndex, source: string, warnings: string[], allowNone: boolean): PovChoice {
  if (typeof value === "string") value = value.trim()
  if (value === undefined || (typeof value === "string" && isUnspecifiedName(value))) return { kind: "unspecified" }
  if (allowNone && value === "なし") return { kind: "none" }
  if (typeof value !== "string") {
    warnings.push(`${source}: 視点キャラは人物名の文字列で指定してください`)
    return { kind: "invalid" }
  }
  const parsed = parseNameList(value)
  if (parsed.issues.length || parsed.names.length !== 1 || ["なし", "（なし）", "(なし)", "-"].includes(value)) {
    warnings.push(`${source}: 視点キャラは一人の正式名${allowNone ? "、または「なし」" : "（既定を設けない場合は項目を省略）"}で指定してください${parsed.issues.length ? `（${parsed.issues.join("、")}）` : ""}`)
    return { kind: "invalid" }
  }
  const name = resolveReference(index, parsed.names[0], source, warnings)
  return name ? { kind: "resolved", name } : { kind: "invalid" }
}

/** 行番号を保ったままコードフェンスとその内部を除く。節分割より先に適用する。 */
function outsideFenceLines(content: string): string[] {
  let fence: { char: string; length: number } | null = null
  return content.split(/\r?\n/).map(line => {
    const marker = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/)
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null
      return ""
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length }
      return ""
    }
    return line
  })
}

export function parsePovFields(content: string, index: CharacterIndex, source: string, lineOffset = 0): PovFields {
  const result: PovFields = { pov: { kind: "unspecified" }, cast: [], warnings: [] }
  let seenPov = false
  outsideFenceLines(content).forEach((line, i) => {
    const field = readNameField(line)
    if (!field || (field.label !== "視点キャラ" && field.label !== "登場人物")) return
    const at = `${source}:${lineOffset + i + 1}`
    if (field.label === "視点キャラ") {
      if (seenPov) {
        result.pov = { kind: "invalid" }
        result.warnings.push(`${at}: 同じ範囲に視点キャラが複数指定されています`)
      } else result.pov = parsePov(field.value, index, at, result.warnings, true)
      seenPov = true
    } else {
      if (field.value === "なし") return
      const parsed = parseNameList(field.value)
      result.warnings.push(...parsed.issues.map(message => `${at}: ${message}`))
      for (const input of parsed.names) {
        const name = resolveReference(index, input, at, result.warnings)
        if (name && !result.cast.includes(name)) result.cast.push(name)
      }
    }
  })
  return result
}

/** 厳格な指定を出現検索で再解釈しない。「登場キャラと掛け合い」は残す。 */
export function withoutPovFields(content: string): string {
  return content.split(/\r?\n/).filter(line => !["視点キャラ", "登場人物"].includes(readNameField(line)?.label ?? "")).join("\n")
}

export interface PovContext {
  views: Array<{ scope: string; pov: PovChoice }>
  names: string[]
  cast: string[]
  warnings: string[]
}

export function resolvePovContext(index: CharacterIndex, args: {
  defaultPov?: unknown; outline: string; label: string; scenes: Array<{ id: string; raw: string }>; sceneId?: string
}): PovContext {
  const warnings: string[] = []
  const defaultPov = parsePov(args.defaultPov, index, "config.json:defaultPovCharacter", warnings, false)
  const chapter = parsePovFields(args.outline, index, `${args.label}のプロット`)
  warnings.push(...chapter.warnings)
  const inherit = (lower: PovChoice, upper: PovChoice) => lower.kind === "unspecified" ? upper : lower
  const base = inherit(chapter.pov, defaultPov)
  const selected = args.sceneId ? args.scenes.filter(s => s.id === args.sceneId) : args.scenes
  const views: PovContext["views"] = []
  const cast = new Set(chapter.cast)
  for (const scene of selected) {
    const fields = parsePovFields(scene.raw, index, `シーン ${scene.id}`)
    warnings.push(...fields.warnings)
    fields.cast.forEach(name => cast.add(name))
    views.push({ scope: `シーン ${scene.id}`, pov: inherit(fields.pov, base) })
  }
  if (args.sceneId && !selected.length) {
    warnings.push(`シーン ${args.sceneId} が見つからず、視点人物を確定できません`)
    views.push({ scope: `シーン ${args.sceneId}`, pov: { kind: "invalid" } })
  } else if (!selected.length) views.push({ scope: args.label, pov: base })
  return { views, names: [...new Set(views.flatMap(v => v.pov.kind === "resolved" ? [v.pov.name] : []))], cast: [...cast], warnings }
}

/** status の検証対象。分割・統合の両方を検証し、未使用側の古い参照も通知する。 */
export const POV_REFERENCE_DOCUMENTS = ["config.json", "outline-detailed.md", "outline/*.md", "outline-brief.md（短編時）", "scenes.md", "scenes/*.md"] as const
export async function validatePovReferences(projectDir: string, config: NovelConfig | null, index: CharacterIndex): Promise<string[]> {
  const warnings: string[] = []
  parsePov(config?.defaultPovCharacter, index, "config.json:defaultPovCharacter", warnings, false)
  const root = getNovelDir(projectDir)
  const paths = ["outline-detailed.md", "scenes.md", ...(isShortForm(config) ? ["outline-brief.md"] : [])]
  for (const dir of ["outline", "scenes"]) {
    try {
      for (const name of (await readdir(join(root, dir))).filter(name => name.endsWith(".md")).sort()) paths.push(`${dir}/${name}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${dir}/: 視点・登場人物の指定を読み込めません`)
    }
  }
  for (const path of paths) {
    const content = await safeReadFile(join(root, path))
    if (content === null) continue
    const lines = outsideFenceLines(content)
    const boundary = path.startsWith("scenes") ? /^###\s+(?:(?:シーン|場面|Scene)\s*)?\d/ : path === "outline-brief.md" ? /$^/ : /^##\s/
    let from = 0
    for (let to = 1; to <= lines.length; to++) {
      if (to < lines.length && !boundary.test(lines[to])) continue
      warnings.push(...parsePovFields(lines.slice(from, to).join("\n"), index, path, from).warnings)
      from = to
    }
  }
  return warnings
}
