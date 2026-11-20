import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { buildCharacterIndex } from "../src/core/character-names.js"
import { parsePovFields, resolvePovContext, withoutPovFields } from "../src/core/pov.js"
import { novelContextExecute } from "../src/tools/context.js"
import { novelStatusExecute } from "../src/tools/status.js"

const index = buildCharacterIndex([
  { label: "佐伯悠真", content: "", aliases: ["悠真", "佐伯"] },
  { label: "佐伯美咲", content: "", aliases: ["美咲", "佐伯"] },
  { label: "栞", content: "", aliases: ["旧名"] },
])
const scene = (id: string, value: string) => ({ id, raw: `### ${id}\n- **視点キャラ**：${value}` })

test("専用欄だけを解析し、自由文は厳格な人物指定にしない", () => {
  const fields = parsePovFields("- **登場キャラと掛け合い**：知らない人が主人公と話す\n- **登場人物**：「佐伯悠真」／栞（しおり）", index, "例")
  assert.deepEqual(fields.cast, ["佐伯悠真", "栞"])
  assert.deepEqual(fields.warnings, [])
  assert.equal(fields.pov.kind, "unspecified")
  for (const value of ["（なし）", "(なし)", "-", "佐伯", "未登録", "佐伯悠真、栞"]) {
    assert.equal(parsePovFields(`- **視点キャラ**：${value}`, index, "例").pov.kind, "invalid")
  }
  assert.equal(parsePovFields("- **視点キャラ**：栞\n- **視点キャラ**：佐伯悠真", index, "例").pov.kind, "invalid")
})

test("全シーンを個別に継承して合算し、なしと不正な明示値では継承を止める", () => {
  const args = { defaultPov: "佐伯悠真", outline: "", label: "第1話", scenes: [scene("1.1", "[人物名]"), scene("1.2", "栞"), scene("1.3", "なし")] }
  const all = resolvePovContext(index, args)
  assert.deepEqual(all.names, ["佐伯悠真", "栞"])
  assert.deepEqual(all.views.map(v => v.pov.kind), ["resolved", "resolved", "none"])
  assert.deepEqual(resolvePovContext(index, { ...args, sceneId: "1.2" }).names, ["栞"])
  assert.deepEqual(resolvePovContext(index, { ...args, scenes: [scene("1.1", "栞"), scene("1.2", "なし")] }).names, ["栞"])
  assert.deepEqual(resolvePovContext(index, { ...args, outline: "- **視点キャラ**：なし", scenes: [scene("1.1", "")] }).names, [])
  assert.deepEqual(resolvePovContext(index, { ...args, outline: "- **視点キャラ**：未登録", scenes: [scene("1.1", "")] }).names, [])
  assert.deepEqual(resolvePovContext(index, { ...args, sceneId: "9.9" }).names, [])
})

function project(t: { after(fn: () => void): void }, files: Record<string, string>) {
  const projectDir = mkdtempSync(join(tmpdir(), "novel-pov-"))
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  const sheet = (name: string, voice: string) => `# ${name}\n- **呼称**：${name}\n固有設定${name}\n## ことばづかい\n- **一人称**：${voice}`
  for (const [path, body] of Object.entries({ "characters/佐伯悠真.md": sheet("佐伯悠真", "俺"), "characters/栞.md": sheet("栞", "私"), ...files })) {
    const full = join(projectDir, ".novel", path)
    mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, body)
  }
  return { projectDir }
}
const config = (extra = {}) => JSON.stringify({ title: "試験", genre: "日常", chapterCount: 3, narrativePerspective: "一人称", defaultPovCharacter: "佐伯悠真", ...extra })

test("CRLF の無効な視点指定を出現検索へ戻さない", async t => {
  assert.equal(withoutPovFields("- **視点キャラ**：栞\r\n本文\r\n- **登場人物**：悠真"), "本文")
  for (const view of ["なし", "栞"]) {
    const ctx = project(t, {
      "config.json": config(),
      "outline/chapter-001.md": "- **視点キャラ**：佐伯悠真\r\n俺が語る。\r\n",
      "scenes/chapter-001.md": `### 1.1\r\n- **視点キャラ**：佐伯悠真\r\n### 1.2\r\n- **視点キャラ**：${view}\r\n`,
    })
    const out = await novelContextExecute({ chapterNumber: 1, sceneId: "1.2", includePrompts: false }, ctx)
    assert.doesNotMatch(out, /固有設定佐伯悠真|一人称: 俺/)
    if (view === "栞") assert.match(out, /固有設定栞/)
    else assert.doesNotMatch(out, /固有設定栞/)
  }
})

test("作品既定の予約値は前後空白を除いて検証する", () => {
  for (const value of ["なし", "（なし）", "(なし)", "-"]) {
    const args = { outline: "", label: "第1話", scenes: [] }
    const plain = resolvePovContext(index, { ...args, defaultPov: value })
    const padded = resolvePovContext(index, { ...args, defaultPov: `　${value} \t` })
    assert.deepEqual(padded, plain)
    assert.match(padded.warnings[0], /既定を設けない場合は項目を省略/)
  }
})

test("フェンスは同じ文字・開始以上の長さ・単独の閉じ行だけで閉じる", async t => {
  for (const [open, wrong, short, annotated, close] of [
    ["````md", "~~~", "```", "````md", "`````"],
    ["~~~~md", "```", "~~~", "~~~~md", "~~~~~"],
  ]) {
    const text = [open, wrong, "## 第9話", "### 9.1", "- **視点キャラ**：未登録1", short,
      "- **視点キャラ**：未登録2", annotated, "- **登場人物**：未登録3", close,
      "## 第1話", "### 1.1", "- **視点キャラ**：栞"].join("\r\n")
    assert.deepEqual(parsePovFields(text, index, "例"), { pov: { kind: "resolved", name: "栞" }, cast: [], warnings: [] })
    const ctx = project(t, { "config.json": config(), "outline-detailed.md": text, "scenes.md": text })
    const status = await novelStatusExecute({}, ctx)
    assert.doesNotMatch(status, /未登録[123]/)
  }
})

test("口調資料の人物名は一人でも複数でも重複表示しない", async t => {
  for (const cast of ["佐伯悠真", "佐伯悠真、栞"]) {
    const ctx = project(t, { "outline/chapter-001.md": `- **登場人物**：${cast}` })
    const out = await novelContextExecute({ chapterNumber: 1, includePrompts: false }, ctx)
    const speech = out.split("## 🗣️ ことばづかい")[1].split(/\n## /)[0]
    for (const name of cast.split("、")) assert.equal(speech.split(name).length - 1, 1, speech)
    assert.match(speech, /一人称: 俺/)
    if (cast.includes("栞")) assert.match(speech, /一人称: 私/)
  }
})

test("代名詞だけの話にも既定視点人物の設定・状態・口調を載せる", async t => {
  const ctx = project(t, {
    "config.json": config(), "outline/chapter-002.md": "俺は買い物へ行く。",
    "characters/state.json": JSON.stringify({ sections: { "chapter-001": { updates: [{ name: "佐伯悠真", changes: { physicalState: "元気", speech: { firstPerson: "僕" } } }] } } }),
  })
  const out = await novelContextExecute({ chapterNumber: 2, includePrompts: false }, ctx)
  assert.match(out, /第2話: 佐伯悠真/)
  assert.match(out, /固有設定佐伯悠真/)
  assert.match(out, /体: 元気/)
  assert.match(out, /一人称: 僕/)
  assert.doesNotMatch(out, /固有設定栞/)
})

test("全話・シーン指定で視点の範囲を変え、分割シーンを統合シーンより優先する", async t => {
  const ctx = project(t, {
    "config.json": config(), "outline/chapter-001.md": "俺と彼女が歩く。",
    "scenes.md": scene("1.1", "未登録").raw,
    "scenes/chapter-001.md": [scene("1.1", ""), scene("1.2", "栞"), scene("1.3", "なし")].map(s => s.raw).join("\n"),
  })
  const all = await novelContextExecute({ chapterNumber: 1, includePrompts: false }, ctx)
  assert.match(all, /シーン 1.1: 佐伯悠真/)
  assert.match(all, /シーン 1.2: 栞/)
  assert.match(all, /シーン 1.3: なし/)
  assert.match(all, /固有設定佐伯悠真/); assert.match(all, /固有設定栞/)
  const one = await novelContextExecute({ chapterNumber: 1, sceneId: "1.2", includePrompts: false }, ctx)
  assert.match(one, /固有設定栞/); assert.doesNotMatch(one, /固有設定佐伯悠真/)
})

test("幕間のなしと不正指定は既定を抑止し、登場人物指定は独立して有効", async t => {
  for (const value of ["なし", "未登録"]) {
    const ctx = project(t, { "config.json": config(), "outline/interlude-001-1.md": `- **視点キャラ**：${value}\n- **登場人物**：栞` })
    const out = await novelContextExecute({ section: "interlude", chapterNumber: 1, interludeIndex: 1, includePrompts: false }, ctx)
    assert.doesNotMatch(out, /固有設定佐伯悠真/)
    assert.match(out, /固有設定栞/)
  }
})

test("短編概要の指定と資料枠による省略を扱い、未設定から主人公を推測しない", async t => {
  const ctx = project(t, { "config.json": config({ storyMode: "short", chapterCount: 1, limits: { characterProfiles: 1, speech: 1 } }), "outline-brief.md": "- **視点キャラ**：栞\n- **登場人物**：佐伯悠真\n彼女が話す。" })
  const out = await novelContextExecute({ chapterNumber: 1, includePrompts: false }, ctx)
  assert.match(out, /本文: 栞/)
  assert.match(out, /佐伯悠真\n…（文字数の枠が足りず省略/)
  const legacy = project(t, { "outline/chapter-001.md": "俺が主人公として語る。" })
  assert.doesNotMatch(await novelContextExecute({ chapterNumber: 1, includePrompts: false }, legacy), /固有設定佐伯悠真|固有設定栞/)
})

test("status は設定・統合・分割・短編の全参照を検証し、ファイルを書き換えない", async t => {
  const paths = ["outline-detailed.md", "outline/chapter-001.md", "outline-brief.md", "scenes.md", "scenes/chapter-001.md"]
  const files = Object.fromEntries(paths.map(path => [path, "- **視点キャラ**：消えた人物"]))
  const ctx = project(t, { ...files, "config.json": config({ storyMode: "short", defaultPovCharacter: "削除済み" }), "characters/栞.md": "# 栞\n- **呼称**：旧名、壊れた（読み" })
  const out = await novelStatusExecute({}, ctx)
  for (const path of ["config.json", ...paths]) assert.ok(out.includes(path), path)
  assert.match(out, /characters\/栞.md:2/)
  for (const [path, body] of Object.entries(files)) assert.equal(readFileSync(join(ctx.projectDir, ".novel", path), "utf8"), body)
})

test("改名前の呼称への参照は解決しながら更新案内を出す", () => {
  const fields = parsePovFields("- **視点キャラ**：旧名", index, "プロット")
  assert.deepEqual(fields.pov, { kind: "resolved", name: "栞" })
  assert.match(fields.warnings[0], /正式名への更新/)
})
