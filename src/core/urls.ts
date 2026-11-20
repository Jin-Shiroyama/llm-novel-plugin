/** URL の範囲は点検・ルビ変換で共用する。位置はコードポイント単位。 */
export interface UrlRange { from: number; to: number; explicit: boolean; ambiguous: boolean }
const DOMAIN = /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?=[:/?#]|$)/
function isUrl(value: string): boolean {
  if (/[\s<>]/u.test(value) || !(/^https?:\/\//.test(value) || DOMAIN.test(value))) return false
  try { return !!new URL(/^https?:\/\//.test(value) ? value : `https://${value}`).hostname } catch { return false }
}

export function explicitUrlRanges(line: string): UrlRange[] {
  const ranges: UrlRange[] = []
  for (const match of line.matchAll(/<([^<>\s]+)>/gu)) {
    if (!isUrl(match[1])) continue
    const from = [...line.slice(0, match.index)].length
    ranges.push({ from, to: from + [...match[0]].length, explicit: true, ambiguous: false })
  }
  return ranges
}

const TERMINATOR = /[\s<>【】＜＞（）「」『』《》〈〉〔〕［］｛｝、。！？…―]/u
const START = /https?:\/\/|(?<![A-Za-z0-9._-])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g
export function urlRanges(line: string): UrlRange[] {
  const chars = [...line]
  const ranges = explicitUrlRanges(line)
  for (const match of line.matchAll(START)) {
    const from = [...line.slice(0, match.index)].length
    if (ranges.some(r => from >= r.from && from < r.to)) continue
    const stack: string[] = []
    let to = from
    for (; to < chars.length; to++) {
      const ch = chars[to]
      if (TERMINATOR.test(ch)) break
      if (ch === "(" || ch === "[") stack.push(ch === "(" ? ")" : "]")
      else if (ch === ")" || ch === "]") {
        if (stack.at(-1) !== ch) break
        stack.pop()
      }
    }
    let candidate = chars.slice(from, to).join("")
    const ambiguous = /[^\x00-\x7f]/.test(candidate) || stack.length > 0
    if (!ambiguous) candidate = candidate.replace(/[.!?,;:]+$/, "")
    // 末尾の括弧が未閉じでも候補は保護し、境界を通知する。
    if (!isUrl(candidate)) continue
    ranges.push({ from, to: from + [...candidate].length, explicit: false, ambiguous })
  }
  return ranges.sort((a, b) => a.from - b.from)
}
