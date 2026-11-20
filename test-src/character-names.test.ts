import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { selectCharacterDocs, extractNameAliases, clipDocParts } from "../src/core/utils.js"
import { buildCharacterIndex, resolveCharacterName, characterRanks, findCharacterMentions, writtenNameHints } from "../src/core/character-names.js"
import { parseNameFields, readNameField } from "../src/core/name-fields.js"
import { normalizeCharacterState, statesBefore } from "../src/core/character-state.js"
import { novelContextExecute } from "../src/tools/context.js"
import { novelUpdateExecute } from "../src/tools/track.js"
import { novelStatusExecute } from "../src/tools/status.js"

const doc = (label: string, aliases: string[] = [], content = "") => ({ label, aliases, content })
const names = (text: string, docs = [doc("長谷川栞"), doc("ユウト")]) => selectCharacterDocs(docs, text).map(d => d.label)

test("CRLF の行末を含む名前欄も読み取れる", () => {
  assert.deepEqual(readNameField("- **視点キャラ**：栞\r"), { label: "視点キャラ", value: "栞" })
})

test("区切りなしの引用を結合せず、正常な別項目は残して診断する", () => {
  for (const value of ["「ハル」「春樹」", "『ハル』『春樹』", "「ハル」 「春樹」", "**「ハル」「春樹」**（愛称）"]) {
    const parsed = parseNameFields(`- **呼称**：栞、${value}、悠真`)
    assert.deepEqual(parsed.aliases, ["栞", "悠真"], value)
    assert.equal(parsed.issues.length, 1, value)
    assert.match(parsed.issues[0].message, /引用.*区切り/)
    const written = parseNameFields(`- **名前**：${value}`)
    assert.deepEqual(written.nameHints, [])
    assert.equal(written.issues.length, 1)
  }
})

test("引用・装飾に続く末尾注記を外し、引用内部の括弧と区切りは保持する", () => {
  for (const value of ["「ハル」（愛称）", "『ハル』（愛称）（注記）", "**ハル**（愛称）", "`ハル`（愛称）", "**ハル（愛称）**"]) {
    const parsed = parseNameFields(`- **呼称**：${value}`)
    assert.deepEqual(parsed.aliases, ["ハル"], value)
    assert.deepEqual(parsed.issues, [])
    assert.deepEqual(writtenNameHints(`- **名前**：${value}`), ["ハル"], value)
  }
  assert.deepEqual(extractNameAliases('- **呼称**：**「影（シャドウ）」**（別名）、「A/B」（識別名）、「[ハル]」（表示名）'), ["影（シャドウ）", "A/B", "[ハル]"])
  assert.deepEqual(writtenNameHints('- **名前**：「黒の 剣士」（通称）'), ["黒の 剣士"])
})

test("名前欄の途中の読みと補足、呼称の末尾注記・引用を混同しない", () => {
  assert.deepEqual(writtenNameHints("- **名前**：佐伯（さえき） 悠真（ゆうま）／主人公"), ["佐伯 悠真", "佐伯", "悠真"])
  assert.deepEqual(writtenNameHints("- **名前**：佐伯（さえき）　悠真（ゆうま）"), ["佐伯　悠真", "佐伯", "悠真"])
  assert.deepEqual(extractNameAliases('- **呼称・あだ名**：栞（しおり）（読み）、「ハル」／「春樹」、黒の　剣士、「A/B」、「影（シャドウ）」'),
    ["栞", "ハル", "春樹", "黒の　剣士", "A/B", "影（シャドウ）"])
  const broken = parseNameFields("- **呼称**：栞、悠真（ゆうま")
  assert.deepEqual(broken.aliases, ["栞"])
  assert.equal(broken.issues[0].line, 1)
  assert.deepEqual(extractNameAliases('- **呼称**：「[ハル]」、栞\uFF0C「A(未閉じ」'), ["[ハル]", "栞", "A(未閉じ"])
  assert.deepEqual(writtenNameHints("- **名前**：／主人公"), [])
})

test("出現判定では正式名と他人の呼称の衝突も全員を弱い候補にする", () => {
  const index = buildCharacterIndex([doc("ハル"), doc("春樹", ["ハル"])])
  assert.deepEqual(findCharacterMentions(index, "ハルが来た").map(m => [m.name, m.strength]), [["ハル", "weak"], ["春樹", "weak"]])
  assert.deepEqual(resolveCharacterName(index, "ハル"), { kind: "resolved", name: "ハル" })
  assert.deepEqual(findCharacterMentions([{ name: "人物", hints: ["", " "] }], "本文"), [])
  assert.deepEqual(names("ハル", [doc(" ハル ")]), [" ハル "])
})

test("記入のない姓名を推測せず、一致ゼロでも全員へ戻さない", () => {
  assert.deepEqual(names("栞が来た。"), [])
  assert.deepEqual(names("ユウトが栞を待つ。"), ["ユウト"])
  assert.deepEqual(names("ユウトが白い花を見る。", [doc("白瀬栞"), doc("ユウト")]), ["ユウト"])
  assert.deepEqual(names(""), [])
})

test("名前欄の明示的な区切りと呼称を使い、括弧の読みは推測しない", () => {
  const docs = [doc("長谷川栞", [], "- **名前**：長谷川 栞（はせがわ しおり）"), doc("ユウト")]
  assert.deepEqual(names("栞を待つ。", docs), ["長谷川栞"])
  assert.deepEqual(names("しおりを挟む。", docs), [])
  assert.deepEqual(names("林が来た。", [doc("林美智子", ["林", "美智子"])]), ["林美智子"])
})

test("長い正式名の中の共通の姓で別人を選ばない。弱い一致より強い一致を優先する", () => {
  const docs = [doc("佐伯悠真", ["佐伯", "悠真"]), doc("佐伯美咲", ["佐伯", "美咲"])]
  assert.deepEqual(names("佐伯美咲が来た。", docs), ["佐伯美咲"])
  assert.deepEqual(names("栞とユウト。", [doc("長谷川栞", ["栞"]), doc("ユウト")]), ["ユウト", "長谷川栞"])
})

test("正式名の一致を別人の呼称より優先し、原作と作品側の同名シートは一人にまとめる", () => {
  const index = buildCharacterIndex([doc("栞"), doc("長谷川栞", ["栞"]), doc("レンカ", ["居候"]), { ...doc("レンカ", ["魔女"]), canon: true }])
  assert.deepEqual(resolveCharacterName(index, "栞"), { kind: "resolved", name: "栞" })
  assert.deepEqual(resolveCharacterName(index, "魔女"), { kind: "resolved", name: "レンカ" })
  assert.equal(index.filter(c => c.name === "レンカ").length, 1)
  assert.deepEqual(extractNameAliases("- **呼称**：黒の 剣士、リナ・フォレスト\n本文の呼称：これは欄ではない"), ["黒の 剣士", "リナ・フォレスト"])
})

test("前話の人物が多くても当話の資料枠を先に確保する", () => {
  const docs = [doc("ユウト", [], "当話設定".repeat(10)), doc("長谷川栞", ["栞"], "前話設定".repeat(10))]
  const ranks = characterRanks(buildCharacterIndex(docs), "ユウト", "栞")
  const out = clipDocParts(docs.map(d => ({ ...d, rank: ranks.get(d.label) })), 20)
  assert.match(out, /当話設定/)
  assert.doesNotMatch(out, /前話設定/)
})

test("過去の別名による一覧と相手キーの削除、変更時点、未来の除外を守る", () => {
  const index = buildCharacterIndex([doc("長谷川栞", ["栞"]), doc("佐伯悠真", ["悠真"])])
  const normalized = normalizeCharacterState({ sections: {
    "chapter-001": { updates: [{ name: "栞", changes: { lists: { 所持品: { added: ["鍵"] } }, relationships: { 悠真: "知人" }, events: ["鍵を拾う"] } }] },
    "chapter-002": { updates: [{ name: "長谷川栞", changes: { lists: { 所持品: { removed: ["鍵"] } }, relationships: { 佐伯悠真: null }, speech: { firstPerson: "あたし" } } }] },
    "chapter-003": { updates: [{ name: "栞", changes: { speech: { firstPerson: "わたくし" } } }] },
  } }, index)
  const [state] = statesBefore(normalized.file, { kind: "chapter", chapter: 3 })
  assert.deepEqual(state.lists, {})
  assert.deepEqual(state.relationships, {})
  assert.equal(state.firstPerson, "あたし")
  assert.deepEqual(state.changedAt.firstPerson, { kind: "chapter", chapter: 2 })
  assert.equal(state.events.length, 1)
})

function project(t: { after: (fn: () => void) => void }, files: Record<string, string>) {
  const projectDir = mkdtempSync(join(tmpdir(), "novel-names-"))
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  for (const [path, body] of Object.entries(files)) {
    const full = join(projectDir, ".novel", path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return { projectDir }
}
const sheet = "# 長谷川栞\n- **呼称**：長谷川、栞\n## ことばづかい\n- **一人称**：私"
const update = (ctx: { projectDir: string }, chapterNumber: number, name: string, changes: object) =>
  novelUpdateExecute({ action: "character-state", chapterNumber, content: JSON.stringify({ updates: [{ name, changes }] }) }, ctx)

test("更新時に正式名へ統一し、最新の状態と口調を一人分だけ載せる", async t => {
  const ctx = project(t, { "characters/長谷川栞.md": sheet, "outline/chapter-003.md": "栞が話す。" })
  assert.match(await update(ctx, 1, "栞", { speech: { firstPerson: "私" }, physicalState: "負傷" }), /「栞」を「長谷川栞」として記録/)
  await update(ctx, 2, "長谷川栞", { speech: { firstPerson: "あたし" }, physicalState: "回復" })
  const out = await novelContextExecute({ chapterNumber: 3, includePrompts: false }, ctx)
  assert.match(out, /一人称: あたし/)
  assert.doesNotMatch(out, /体: 負傷|\*\*栞\*\*/)
  const file = JSON.parse(readFileSync(join(ctx.projectDir, ".novel/characters/state.json"), "utf8"))
  assert.equal(file.sections["chapter-001"].updates[0].name, "長谷川栞")
})

test("既存の揺れは差分適用前に統合し、ファイルを変更せず、削除と時点を守る", async t => {
  const state = JSON.stringify({ sections: {
    "chapter-001": { updates: [{ name: "栞", changes: { physicalState: "負傷", speech: { firstPerson: "私" } } }] },
    "chapter-002": { updates: [{ name: "長谷川栞", changes: { physicalState: null, speech: { firstPerson: "あたし" } } }] },
  } })
  const ctx = project(t, { "characters/長谷川栞.md": sheet, "characters/state.json": state, "outline/chapter-003.md": "栞が話す。" })
  const out = await novelContextExecute({ chapterNumber: 3, includePrompts: false }, ctx)
  assert.match(out, /一人称: あたし/)
  assert.doesNotMatch(out, /体: 負傷|\*\*栞\*\*/)
  assert.equal(readFileSync(join(ctx.projectDir, ".novel/characters/state.json"), "utf8"), state)
  await update(ctx, 2, "栞", { mentalState: "元気" })
  const file = JSON.parse(readFileSync(join(ctx.projectDir, ".novel/characters/state.json"), "utf8"))
  assert.equal(file.sections["chapter-001"].updates[0].name, "栞", "更新対象でない過去の記録は書き換えない")
})

test("曖昧な呼称はバッチ全体を保存せず、既存の曖昧な状態を二人の口調へ適用しない", async t => {
  const state = JSON.stringify({ sections: { "chapter-001": { updates: [{ name: "佐伯", changes: { speech: { firstPerson: "わし" } } }] } } })
  const ctx = project(t, {
    "characters/佐伯悠真.md": "# 佐伯悠真\n- **呼称**：佐伯、悠真\n## ことばづかい\n- **一人称**：俺",
    "characters/佐伯美咲.md": "# 佐伯美咲\n- **呼称**：佐伯、美咲\n## ことばづかい\n- **一人称**：私",
    "characters/state.json": state, "outline/chapter-002.md": "悠真と美咲が話す。",
  })
  assert.match(await update(ctx, 2, "佐伯", { speech: { firstPerson: "わし" } }), /^❌/)
  assert.equal(readFileSync(join(ctx.projectDir, ".novel/characters/state.json"), "utf8"), state)
  const out = await novelContextExecute({ chapterNumber: 2, includePrompts: false }, ctx)
  assert.doesNotMatch(out, /一人称: わし/)
  assert.match(out, /曖昧/)
})

test("関係と呼び方の相手キーも統一し、呼び方の値は保持する", async t => {
  const ctx = project(t, { "characters/長谷川栞.md": sheet })
  await update(ctx, 1, "ユウト", { relationships: { 栞: "友達" }, speech: { addressTerms: { 栞: "栞ちゃん" } } })
  const file = JSON.parse(readFileSync(join(ctx.projectDir, ".novel/characters/state.json"), "utf8"))
  const changes = file.sections["chapter-001"].updates[0].changes
  assert.deepEqual(changes.relationships, { 長谷川栞: "友達" })
  assert.deepEqual(changes.speech.addressTerms, { 長谷川栞: "栞ちゃん" })
})

test("同じ節に別名と正式名が重複する旧記録を更新できる", async t => {
  const ctx = project(t, {
    "characters/長谷川栞.md": sheet,
    "characters/state.json": JSON.stringify({ sections: { "chapter-001": { updates: [
      { name: "栞", changes: { speech: { firstPerson: "私" } } },
      { name: "長谷川栞", changes: { speech: { firstPerson: "あたし" } } },
    ] } } }),
  })
  await update(ctx, 1, "栞", { speech: { firstPerson: "わたくし" } })
  const file = JSON.parse(readFileSync(join(ctx.projectDir, ".novel/characters/state.json"), "utf8"))
  assert.equal(file.sections["chapter-001"].updates.length, 1)
  assert.equal(file.sections["chapter-001"].updates[0].changes.speech.firstPerson, "わたくし")
})

test("曖昧な相手キーを含むバッチでは、先にある正しい更新も保存しない", async t => {
  const original = JSON.stringify({ sections: {} })
  const ctx = project(t, {
    "characters/佐伯悠真.md": "- **呼称**：佐伯、悠真", "characters/佐伯美咲.md": "- **呼称**：佐伯、美咲",
    "characters/state.json": original,
  })
  const out = await novelUpdateExecute({ action: "character-state", chapterNumber: 1, content: JSON.stringify({ updates: [
    { name: "ユウト", changes: { mentalState: "元気" } },
    { name: "栞", changes: { relationships: { 佐伯: "友達" } } },
  ] }) }, ctx)
  assert.match(out, /^❌/)
  assert.equal(readFileSync(join(ctx.projectDir, ".novel/characters/state.json"), "utf8"), original)
})

test("前話末尾だけに出る人物の設定・口調を載せ、未記入の呼称を通知する", async t => {
  const ctx = project(t, {
    "characters/長谷川栞.md": sheet, "characters/ユウト.md": "# ユウト\n## ことばづかい\n- **一人称**：俺",
    "outline/chapter-002.md": "ユウトが朝食を作る。", "chapters/chapter-001.md": "# 第1章\n\n　栞が玄関に立っていた。",
  })
  const out = await novelContextExecute({ chapterNumber: 2, includePrompts: false }, ctx)
  const speech = out.split("## 🗣️ ことばづかい")[1]
  assert.match(speech, /### ユウト\n一人称: 俺/)
  assert.match(speech, /### 長谷川栞\n一人称: 私/)
  assert.ok(speech.indexOf("### ユウト") < speech.indexOf("### 長谷川栞"))
  assert.match(await novelStatusExecute({}, ctx), /呼称が未記入.*ユウト/)
})

test("シート未登録の記録名を含め、シート・状態・口調に同じ出現判定を使う", async t => {
  const ctx = project(t, {
    "characters/佐伯悠真.md": "# 佐伯悠真\n- **呼称**：佐伯、悠真\n## ことばづかい\n- **一人称**：俺",
    "outline/chapter-002.md": "佐伯美咲が話す。",
  })
  await update(ctx, 1, "佐伯美咲", { speech: { firstPerson: "わたし" } })
  const out = await novelContextExecute({ chapterNumber: 2, includePrompts: false }, ctx)
  assert.match(out, /\*\*佐伯美咲\*\* — 一人称: わたし/)
  assert.doesNotMatch(out, /一人称: 俺/)
})
