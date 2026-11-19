import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { novelInitExecute } from "../../src/tools/init.js"
import { novelStatusExecute } from "../../src/tools/status.js"
import { novelContextExecute } from "../../src/tools/context.js"
import { novelSaveChapterExecute } from "../../src/tools/save.js"
import { novelUpdateExecute } from "../../src/tools/track.js"
import { novelCheckExecute } from "../../src/tools/check.js"
import { novelExportExecute } from "../../src/tools/export.js"

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "llm-novel-e2e-"))
}

function writeDoc(dir: string, rel: string, content: string): void {
  const path = join(dir, ".novel", rel)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content, "utf-8")
}

describe("E2E ワークフロー: ジャンル別（ラブコメ／ファンタジー／SF／二次創作）", () => {
  test("ラブコメ（episodic / light / worldBuilding: minimal / indent: none）の立ち上げ〜書き出し", async () => {
    const dir = makeDir()
    const ctx = { projectDir: dir }

    const initOut = await novelInitExecute(
      {
        title: "放課後、塩対応な図書委員が俺の弁当だけ狙ってくる",
        genre: "ラブコメ",
        storyMode: "episodic",
        tone: "笑える・掛け合い、ニヤニヤ・甘い",
        indent: "none",
      },
      ctx,
    )
    assert.ok(initOut.includes("準備ができました"))
    assert.ok(initOut.includes("genre-romance"))
    // ラブコメは world-building.md と reality-source.md を作らない
    assert.equal(existsSync(join(dir, ".novel/world-building.md")), false)
    assert.equal(existsSync(join(dir, ".novel/reality-source.md")), false)

    // 企画書・キャラ・プロットを記入（シーン一覧は作らない）
    writeDoc(
      dir,
      "concept.md",
      `# 『放課後、塩対応な図書委員が俺の弁当だけ狙ってくる』作品企画書

## フック（ひとことで言うと）
> 自炊好きの男子高校生がクールな図書委員におかずの試食係として呼び出されるラブコメ。

## この作品の面白さ（読者体験の柱）
- クール美少女の食いしん坊ギャップにニヤニヤする

## トーンと NG ライン
- **全体の雰囲気**：笑える・掛け合い、ニヤニヤ・甘い
- **シリアス度**：軽快・明るめ
- **NG ライン（やらないこと）**：重いトラウマや教訓まとめを絶対に足さない
`,
    )
    writeDoc(dir, "characters/profiles.md", "# 登場人物\n\n| 名前 | 立場 | 魅力 | 状態 |\n|---|---|---|---|\n| 悠真 | 主人公 | 自炊好きツッコミ | 健在 |\n| 白瀬栞 | ヒロイン | クール×食いしん坊 | 健在 |")
    writeDoc(
      dir,
      "characters/白瀬栞.md",
      `# 白瀬栞

## 基本情報
- **名前**：白瀬 栞
- **呼称**：白瀬、栞

## ことばづかい
- **一人称**：私
- **二人称**：あなた
- **丁寧さの基本**：淡々とした敬語

### 相手ごとの呼び方
| 相手 | 呼び方 | 丁寧さ | 変わるとき |
|---|---|---|---|
| 悠真 | 佐伯くん | 丁寧語 | 仲良くなったら悠真くん |
`,
    )
    writeDoc(dir, "outline-brief.md", "# プロット概要\n序盤は放課後の試食会から。")
    writeDoc(
      dir,
      "outline/chapter-001.md",
      `## 第1話：食品ロス防止という名のカツアゲ
- **この話の見どころ**：白瀬が卵焼きを食べて耳まで赤くなるギャップ
- **登場キャラと掛け合い**：悠真 × 白瀬
`,
    )

    const statusBefore = await novelStatusExecute({}, ctx)
    assert.ok(statusBefore.includes("本文執筆（writing）"))

    const contextOut = await novelContextExecute({ chapterNumber: 1 }, ctx)
    assert.ok(contextOut.includes("作品の核・トーン・NGライン"))
    assert.ok(contextOut.includes("重いトラウマや教訓まとめを絶対に足さない"))
    assert.ok(contextOut.includes("軽快・明るめ"))
    assert.ok(contextOut.includes("字下げなし"))
    assert.ok(contextOut.includes("genre-romance"))
    assert.ok(contextOut.includes("佐伯くん"))

    const body = `放課後の図書準備室。白瀬が俺の卵焼きを一口頬張った。

「……ん」

耳の先がうっすら赤い。
「佐伯くん、明日もこれを提出してください」
「いやカツアゲが丁寧すぎるだろ！」`

    const saveOut = await novelSaveChapterExecute({ chapterNumber: 1, title: "食品ロス防止という名のカツアゲ", content: body }, ctx)
    assert.ok(saveOut.includes("✅ 第1話"))
    assert.ok(saveOut.includes("規約から外れた箇所はありません"))

    const checkOut = await novelCheckExecute({ chapterNumber: 1 }, ctx)
    assert.ok(checkOut.includes("✅ 表記の点検"))
    assert.ok(!checkOut.includes("✍️ 文章の点検"))

    await novelUpdateExecute(
      {
        action: "character-state",
        chapterNumber: 1,
        content: JSON.stringify({ updates: [{ name: "白瀬栞", changes: { mentalState: "卵焼きに大満足" } }] }),
      },
      ctx,
    )
    await novelUpdateExecute({ action: "summary", chapterNumber: 1, content: "白瀬が悠真の卵焼きを気に入り、明日も持ってくるよう約束させた。" }, ctx)

    const exportOut = await novelExportExecute({ split: true }, ctx)
    assert.ok(exportOut.includes("✅ 原稿を書き出しました"))
    const indexTxt = readFileSync(join(dir, ".novel/export/episodes/index.txt"), "utf-8")
    assert.ok(indexTxt.includes("第1話　食品ロス防止という名のカツアゲ"))
  })

  test("日常系（恋愛なし）では genre-slice-of-life のみが案内され、いちゃラブ日常では genre-romance と併用される", async () => {
    const dirDaily = makeDir()
    const outDaily = await novelInitExecute(
      {
        title: "美術室は今日も扇風機が回らない",
        genre: "学園日常",
        storyMode: "episodic",
      },
      { projectDir: dirDaily },
    )
    assert.ok(outDaily.includes("genre-slice-of-life"))
    assert.ok(!outDaily.includes("genre-romance"))
    assert.equal(existsSync(join(dirDaily, ".novel/world-building.md")), false)

    const dirSweet = makeDir()
    const outSweet = await novelInitExecute(
      {
        title: "鉄壁主任は家に帰ると3パーセントになる",
        genre: "いちゃラブ日常",
        storyMode: "episodic",
      },
      { projectDir: dirSweet },
    )
    assert.ok(outSweet.includes("genre-romance"))
    assert.ok(outSweet.includes("genre-slice-of-life"))
    assert.equal(existsSync(join(dirSweet, ".novel/world-building.md")), false)
  })

  test("SF（plot / 完結型）では serial: false となり world-building.md が作られる", async () => {
    const dir = makeDir()
    const ctx = { projectDir: dir }
    const out = await novelInitExecute(
      {
        title: "軌道宅配便かもめ号",
        genre: "近未来SF",
        storyMode: "plot",
        chapterCount: 2,
        targetWords: 6000,
      },
      ctx,
    )
    assert.ok(out.includes("genre-sf"))
    assert.equal(existsSync(join(dir, ".novel/world-building.md")), true)
    const config = JSON.parse(readFileSync(join(dir, ".novel/config.json"), "utf-8"))
    assert.equal(config.serial, false)
    assert.equal(config.worldBuilding, "standard")
  })

  test("二次創作（sourceWork 指定）では canon/ 雛形が作られ、資料に原作情報と novel-fanfic が載る", async () => {
    const dir = makeDir()
    const ctx = { projectDir: dir }
    const out = await novelInitExecute(
      {
        title: "もしも学園で料理対決したら",
        genre: "異世界ファンタジー",
        sourceWork: "サンプル原作",
      },
      ctx,
    )
    assert.ok(out.includes("サンプル原作"))
    assert.ok(out.includes("novel-fanfic"))
    assert.equal(existsSync(join(dir, ".novel/canon/overview.md")), true)
    assert.equal(existsSync(join(dir, ".novel/canon/timeline.md")), true)
    assert.equal(existsSync(join(dir, ".novel/canon/setting.md")), true)

    writeDoc(dir, "canon/overview.md", "# 原作と扱い方\n\n## 原作\n- 作品名：サンプル原作\n- 基準：アニメ1期")
    writeDoc(dir, "outline/chapter-001.md", "## 第1話：開幕\nアリスが登場する。")
    writeDoc(
      dir,
      "canon/characters/アリス.md",
      `# アリス
## ことばづかい
- **一人称**：あたし
- **丁寧さの基本**：元気なため口
`,
    )
    const contextOut = await novelContextExecute({ chapterNumber: 1 }, ctx)
    assert.ok(contextOut.includes("原作の資料 —『サンプル原作』"))
    assert.ok(contextOut.includes("アリス（原作の人物）"))
    assert.ok(contextOut.includes("一人称: あたし"))
    assert.ok(contextOut.includes("novel-fanfic"))
  })
})
