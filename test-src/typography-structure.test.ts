import { test } from "node:test"
import assert from "node:assert/strict"
import { checkTypography, fixTypography } from "../src/core/typography.js"
import { parseRubyLine } from "../src/core/ruby.js"

test("傍点内の修正は傍点内に収まり、異なる記法の範囲を結合しない", () => {
  for (const [before, after] of [
    ["「《《…》》」", "「《《……》》」"],
    ["「《《...》》」", "「《《……》》」"],
    ["「《《！》》続き」", "「《《！》》　続き」"],
  ]) {
    const fixed = fixTypography(before)
    assert.equal(fixed.text, after)
    assert.deepEqual(checkTypography(after), [])
    assert.equal(fixTypography(after).totalFixes, 0)
    assert.equal(parseRubyLine(after).segments.filter(s => s.kind === "emphasis").length, 1)
  }
  assert.equal(fixTypography("「｜…《てん》」").text, "「｜…《てん》」", "ルビ対象の長さを変える修正は手動")
  assert.equal(fixTypography("「.《《..》》」").text, "「.《《..》》」", "記法をまたいで三点リーダを生成しない")
})

test("日本語を含む裸のURLは境界が曖昧なら保護し、明示的に区切ったURLも保持する", () => {
  for (const body of ["　https://example.com/検索?q=1", "　<https://example.com/検索?q=1>"]) {
    assert.equal(fixTypography(body).text, body)
    assert.equal(checkTypography(body).filter(i => i.severity === "error").length, 0)
  }
  const body = "「サイトは<https://example.com/top>だよ。」"
  assert.equal(fixTypography(body).text, "「サイトは<https://example.com/top>だよ」")
})

test("規則・行の種類・記法を組み合わせても、再整形で変化せず修正可能な診断が残らない", () => {
  for (const wrap of [(s: string) => `「${s}」`, (s: string) => `　${s}続き。`, (s: string) => `「《《${s}》》」`]) {
    for (const text of ["…", "...", "—", "!続き", "?　", "１２", "！　！", "……　続き"]) {
      const fixed = fixTypography(wrap(text))
      assert.equal(fixTypography(fixed.text).text, fixed.text)
      assert.deepEqual(checkTypography(fixed.text).filter(i => i.fix), [])
    }
  }
})

test("傍点を空にせず、ルビの読み・CRLF・元の位置を保持する", () => {
  assert.equal(fixTypography("「《《。》》」").text, "「《《。》》」")
  const input = "「😀《《...》》」\r\n　｜３《さん！》歩。\r\n"
  const expected = "「😀《《……》》」\r\n　｜3《さん！》歩。\r\n"
  assert.equal(fixTypography(input).text, expected)
  assert.equal(fixTypography(expected).text, expected)
  const [issue] = checkTypography("「😀《《...》》」")
  assert.equal(issue.column, 5)
  assert.deepEqual(issue.fix, { start: 4, end: 7, replacement: "……" })
})
