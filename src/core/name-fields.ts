/** 名前欄と呼称・人物一覧欄の共通解析。姓名や読みを推測しない。 */
export interface NameFieldIssue { line: number; message: string }
export interface ParsedNameFields { nameHints: string[]; aliases: string[]; issues: NameFieldIssue[] }

export function readNameField(line: string): { label: string; value: string } | null {
  const m = line.replace(/\r$/, "").match(/^\s*(?:[-*・]\s*)?(?:\*\*)?([^：:*]+?)(?:\*\*)?\s*[：:]\s*(.*)$/)
  return m ? { label: m[1].trim(), value: m[2].trim() } : null
}

export const isUnspecifiedName = (value: string): boolean => !value.trim() || /^\[[^\]]*\]$/.test(value.trim())
const PAIRS: Record<string, string> = { "（": "）", "(": ")", "[": "]", "［": "］", "「": "」", "『": "』" }
const CLOSERS = new Set(Object.values(PAIRS))
const undecorate = (value: string) => value.trim().replace(/^\*\*([\s\S]*)\*\*$/, "$1").replace(/^`([\s\S]*)`$/, "$1").trim()

/** 括弧の外だけで区切る。壊れた項目は結合・推測せず捨て、理由を返す。 */
function splitItems(value: string, separators: RegExp): { items: string[]; issues: string[] } {
  const items: string[] = [], issues: string[] = [], stack: string[] = []
  let item = "", broken = false
  const finish = () => {
    if (broken || stack.length) issues.push(`括弧または引用が対応していない項目: ${item.trim()}`)
    else items.push(undecorate(item))
    item = ""; broken = false
  }
  for (const ch of value) {
    if (stack.length === 0 && separators.test(ch)) { finish(); continue }
    item += ch
    if (stack.at(-1) === "」" || stack.at(-1) === "』") {
      if (ch === stack.at(-1)) stack.pop()
      continue
    }
    if (PAIRS[ch]) stack.push(PAIRS[ch])
    else if (CLOSERS.has(ch)) {
      if (stack.at(-1) === ch) stack.pop()
      else broken = true
    }
  }
  finish()
  return { items, issues }
}

function literal(value: string): string | null {
  const close = value[0] === "「" ? "」" : value[0] === "『" ? "』" : null
  return close && value.indexOf(close, 1) === value.length - 1 ? value.slice(1, -1).trim() : null
}

/** 対応済みの丸括弧を注記として除く。呼称では連続した末尾注記だけを除く。 */
function removeNotes(value: string, all: boolean): string {
  const ranges: Array<[number, number]> = []
  const stack: string[] = []
  let start = -1
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (stack.at(-1) === "」" || stack.at(-1) === "』") {
      if (ch === stack.at(-1)) stack.pop()
      continue
    }
    if (PAIRS[ch]) {
      if (stack.length === 0 && (ch === "(" || ch === "（")) start = i
      stack.push(PAIRS[ch])
    } else if (stack.at(-1) === ch) {
      stack.pop()
      if (stack.length === 0 && start >= 0) { ranges.push([start, i + 1]); start = -1 }
    }
  }
  let result = value
  for (const [from, to] of ranges.reverse()) {
    if (all || !result.slice(to).trim()) result = result.slice(0, from) + result.slice(to)
  }
  return result.trim()
}

/** 注記の外にある装飾を外す。引用は項目全体を囲む一組だけを受理する。 */
function normalizeItem(value: string, allNotes: boolean, issues: string[]): { name: string; quoted: boolean } | null {
  const cleaned = undecorate(removeNotes(undecorate(value), allNotes))
  const quoted = literal(cleaned)
  if ((cleaned.startsWith("「") || cleaned.startsWith("『")) && quoted === null) {
    issues.push(`引用された名前の間に区切りがありません: ${value}。項目を読点などで区切ってください`)
    return null
  }
  return { name: quoted ?? cleaned, quoted: quoted !== null }
}

/** 呼称と明示的な登場人物のリスト。項目内の空白・中黒は保持する。 */
export function parseNameList(value: string): { names: string[]; issues: string[] } {
  if (isUnspecifiedName(undecorate(value))) return { names: [], issues: [] }
  const { items, issues } = splitItems(value, /[、,\uFF0C/／]/)
  const names = items.flatMap(item => {
    const parsed = normalizeItem(item, false, issues)
    if (!parsed || !parsed.name || (!parsed.quoted && isUnspecifiedName(parsed.name))) return []
    return [parsed.name]
  })
  return { names: [...new Set(names)], issues }
}

export function parseNameFields(content: string): ParsedNameFields {
  const nameHints = new Set<string>(), aliases = new Set<string>(), issues: NameFieldIssue[] = []
  content.split(/\r?\n/).forEach((line, i) => {
    const field = readNameField(line)
    if (!field || isUnspecifiedName(undecorate(field.value))) return
    if (field.label === "名前") {
      const parsed = splitItems(field.value, /[/／]/)
      // 名前欄のスラッシュ以降は肩書きなどの補足。最初の項目だけを使う。
      const first = parsed.items[0]
      const normalized = first && !parsed.issues.length ? normalizeItem(first, true, parsed.issues) : null
      issues.push(...parsed.issues.map(message => ({ line: i + 1, message })))
      if (!normalized) return
      const { name, quoted } = normalized
      if (!name || (!quoted && isUnspecifiedName(name))) return
      nameHints.add(name)
      if (!quoted) for (const piece of name.split(/[\s　・]+/)) if (piece) nameHints.add(piece)
    } else if (field.label.split(/[・/／]/).every(label => /^(呼称|別名|通称|愛称|あだ名)$/.test(label.trim()))) {
      const parsed = parseNameList(field.value)
      parsed.names.forEach(name => aliases.add(name))
      issues.push(...parsed.issues.map(message => ({ line: i + 1, message })))
    }
  })
  return { nameHints: [...nameHints], aliases: [...aliases], issues }
}
