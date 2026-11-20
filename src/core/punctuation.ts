/** 正規化前の約物の役割。空白・字下げ・置換が同じ判定を使う。 */
const DIGIT = /[0-9０-９〇零一二三四五六七八九十百千]/
export function punctuationRole(chars: string[], start: number, end = chars.length): "ellipsis" | "dash" | null {
  const ch = chars[start]
  if (!ch || !"…‥・.―—─–".includes(ch) || start >= end) return null
  let to = start + 1
  while (to < end && chars[to] === ch) to++
  if (ch === "…" || ch === "‥" || (ch === "." && to - start >= 3) || (ch === "・" && to - start >= 2)) return "ellipsis"
  if (ch === "―" || ch === "—" || ch === "─" || ch === "–") {
    if (ch === "–" && to - start === 1 && DIGIT.test(chars[start - 1] ?? "") && DIGIT.test(chars[to] ?? "")) return null
    if (ch === "─" && (/[\u2501-\u257F]/.test(chars[start - 1] ?? "") || /[\u2501-\u257F]/.test(chars[to] ?? ""))) return null
    return "dash"
  }
  return null
}
