import { test } from "node:test"
import assert from "node:assert/strict"
import { checkTypography, fixTypography } from "../src/core/typography.js"
import { parseRubyLine, convertRuby, RUBY_NOTATIONS } from "../src/core/ruby.js"
import { urlRanges, explicitUrlRanges } from "../src/core/urls.js"
import { checkProse } from "../src/core/prose.js"

test("傍点内の明示 URL は未対応の記法として診断し、自動整形しない", () => {
  const input = "《《<https://example.com/a>》》"
  assert.ok(checkTypography(input).some(i => i.rule === "ruby"))
  const result = fixTypography(input)
  assert.equal(result.text, input)
  assert.equal(result.totalFixes, 0)
})

test("URL は外側の括弧や全角約物を取り込まず、内部の半角括弧を保持する", () => {
  for (const [input, expected] of [
    ["【詳細：https://example.com/top】", "https://example.com/top"],
    ["（参照：https://example.com/top）", "https://example.com/top"],
    ["(参照: https://example.com/Foo_(bar))", "https://example.com/Foo_(bar)"],
    ["[参照: https://example.com/Foo_[bar]]", "https://example.com/Foo_[bar]"],
  ]) {
    const [r] = urlRanges(input)
    assert.equal([...input].slice(r.from, r.to).join(""), expected)
  }
  for (const terminator of [..."【】＜＞（）「」『』《》〈〉〔〕［］｛｝、。！？…―"]) {
    assert.equal(urlRanges(`https://example.com/top${terminator}`)[0].to, "https://example.com/top".length)
  }
  assert.equal(fixTypography("「https://example.com/top】だよ!」").text, "「https://example.com/top】だよ！」")
  assert.ok(checkTypography("Dr.Smith/佐藤だよ!").some(i => i.rule === "url-boundary"))
})

test("明示 URL はルビ点検と全書き出し形式で素通しし、通常の山括弧は保護しない", () => {
  const url = "<https://example.com/漢字《かな》/《《…》》/「!>"
  assert.deepEqual(parseRubyLine(url).issues, [])
  assert.deepEqual(checkTypography(url), [])
  for (const notation of RUBY_NOTATIONS) assert.equal(convertRuby(url, notation), url)
  assert.deepEqual(explicitUrlRanges("<SYSTEM> <Lv.5>"), [])
  assert.equal(fixTypography("<SYSTEM>!続き").text, "<SYSTEM>！　続き")
  assert.equal(convertRuby(`${url}漢字《かんじ》`, "none"), `${url}漢字`)
})

test("表示行の字下げを保持し、連続する中黒を先に三点リーダと判定する", () => {
  for (const indent of ["none", "fullwidth"] as const) {
    for (const line of ["　・HP：100", "  HP：100", "\t（心の声）", "　　理由：彼は寝坊した。"])
      assert.equal(fixTypography(line, { indent }).text, line)
    const result = fixTypography("　・・・と呟いた。", { indent, maxPasses: 1 })
    assert.equal(result.text, "……と呟いた。")
    assert.deepEqual(result.unconvergedLines, [])
  }
  assert.ok(checkTypography("　#拡散希望！続き").some(i => i.rule === "exclamation-space"))
  assert.ok(checkProse("　#拡散希望。静寂が支配した。").length > 0)
})

test("約物の役割を正規化前から判定し、仮の空白修正を数えない", () => {
  for (const [input, output, rule] of [["「！...」", "「！……」", "ellipsis"], ["「！—」", "「！――」", "dash"]]) {
    assert.ok(!checkTypography(input).some(i => i.rule === "exclamation-space"))
    const fixed = fixTypography(input)
    assert.equal(fixed.text, output)
    assert.deepEqual(fixed.fixes, [{ rule, count: 1 }])
    assert.equal(fixTypography(output).totalFixes, 0)
  }
  assert.equal(fixTypography("「！ ...」").text, "「！……」")
  assert.equal(fixTypography("　...　続き").text, "……続き")
})

test("反復上限時は他の行も含めて原文を返し、修正件数と差分を確定しない", () => {
  const text = "「!」\r\n　...　続き"
  const fixed = fixTypography(text, { maxPasses: 1 })
  assert.equal(fixed.text, text)
  assert.deepEqual(fixed.unconvergedLines, [2])
  assert.equal(fixed.totalFixes, 0)
  assert.deepEqual(fixed.changes, [])
  assert.deepEqual(fixed.fixes, [])
  assert.deepEqual(fixTypography("無変更", { indent: "none", maxPasses: 0 }).unconvergedLines, [])
})

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
