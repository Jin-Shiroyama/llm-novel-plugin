/** 人物名の出現と同一人物の解決。書かれた手がかり以外は生成しない。 */
import { parseNameFields } from "./name-fields.js"
export interface NameDocument {
  label: string
  content: string
  aliases?: string[]
  canon?: boolean
}

export interface CharacterIdentity {
  name: string
  hints: string[]
}
export type CharacterIndex = CharacterIdentity[]
export type NameResolution =
  | { kind: "resolved"; name: string }
  | { kind: "ambiguous"; name: string; candidates: string[] }
  | { kind: "unknown"; name: string }

/** 「名前」欄だけを読む。括弧内の読みは呼称に明記された場合だけ使う。 */
export function writtenNameHints(content: string): string[] {
  return parseNameFields(content).nameHints
}

/** 旧公開関数も明示的な空白・中黒だけを区切りとして扱う。 */
export function characterNameKeys(name: string, aliases: string[] = []): { strong: string[]; weak: string[] } {
  const keys = [...new Set([name.trim(), ...name.trim().split(/[\s　・]+/), ...aliases.map(a => a.trim())].filter(Boolean))]
  return { strong: keys.filter(k => [...k].length > 1), weak: keys.filter(k => [...k].length === 1) }
}

/** 原作と作品側の同名シートは同じ人物。両方の明示的な手がかりを使う。 */
export function buildCharacterIndex(docs: NameDocument[]): CharacterIndex {
  const byName = new Map<string, Set<string>>()
  for (const doc of docs) {
    const name = doc.label.trim()
    if (!name) continue
    const hints = byName.get(name) ?? new Set<string>()
    const keys = characterNameKeys(name, [...(doc.aliases ?? []), ...writtenNameHints(doc.content)])
    for (const key of [...keys.strong, ...keys.weak]) hints.add(key)
    byName.set(name, hints)
  }
  return [...byName].map(([name, hints]) => ({ name, hints: [...hints] }))
}

export function resolveCharacterName(index: CharacterIndex, input: string): NameResolution {
  const name = input.trim()
  if (index.some(c => c.name === name)) return { kind: "resolved", name }
  const candidates = index.filter(c => c.hints.includes(name)).map(c => c.name)
  if (candidates.length === 1) return { kind: "resolved", name: candidates[0] }
  return candidates.length > 1 ? { kind: "ambiguous", name, candidates } : { kind: "unknown", name }
}

export interface CharacterMention {
  name: string
  hint: string
  /** 文章内の UTF-16 オフセット。提示・選択理由用で、人物の確定には使わない。 */
  offset: number
  strength: "strong" | "weak"
}

export function findCharacterMentions(index: CharacterIndex, text: string): CharacterMention[] {
  const owners = new Map<string, Set<string>>()
  for (const person of index) for (const hint of person.hints) {
    if (!hint.trim() || !person.name.trim()) continue
    const names = owners.get(hint) ?? new Set<string>()
    names.add(person.name.trim())
    owners.set(hint, names)
  }
  const hints = [...owners.keys()].sort((a, b) => b.length - a.length)
  const mentions: CharacterMention[] = []
  for (let i = 0; i < text.length;) {
    // 長い名前を先に消費し、正式名の中の共通の姓で別人を拾わない。
    const hint = hints.find(h => text.startsWith(h, i))
    if (!hint) { i++; continue }
    const candidates = owners.get(hint)!
    const strength = [...hint].length === 1 || candidates.size > 1 ? "weak" : "strong"
    for (const name of candidates) mentions.push({ name, hint, offset: i, strength })
    i += hint.length
  }
  return mentions
}

/** 当話の強い一致、弱い一致、前話の強い一致、弱い一致の順。未特定は含めない。 */
export function characterRanks(index: CharacterIndex, current: string, previous = ""): Map<string, number> {
  const ranks = new Map<string, number>()
  for (const [source, text] of [current, previous].entries()) {
    for (const hit of findCharacterMentions(index, text)) {
      const rank = source * 2 + (hit.strength === "weak" ? 1 : 0)
      ranks.set(hit.name, Math.min(rank, ranks.get(hit.name) ?? Infinity))
    }
  }
  return ranks
}

export function selectCharacterDocs<T extends NameDocument>(docs: T[], current: string, previous = ""): T[] {
  const ranks = characterRanks(buildCharacterIndex(docs), current, previous)
  return docs.filter(d => ranks.has(d.label.trim())).sort((a, b) => ranks.get(a.label.trim())! - ranks.get(b.label.trim())!)
}
