import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { novelInitExecute } from "../../src/tools/init.js"
import { novelStatusExecute } from "../../src/tools/status.js"
import { novelContextExecute } from "../../src/tools/context.js"
import { novelSaveChapterExecute, formatUnconvergedSaveError } from "../../src/tools/save.js"
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

## 語りと文体
- **視点**：一人称（悠真）
- **語り手のテンション**：軽快・会話多め

### 文体見本（任意・200〜600文字）
放課後の図書室は少し古い紙の匂いがする。俺は鞄を机に置いた。
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
    assert.ok(contextOut.includes("文体見本"))
    assert.ok(contextOut.includes("少し古い紙の匂いがする"))
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
    assert.ok(saveOut.includes("目安 3,000文字 ±15%"))
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

  test("保存時の自動整形（既定 ON）・目安文字数比較・novel_check(fix: true) が正しく動く", async () => {
    const dir = makeDir()
    const ctx = { projectDir: dir }
    await novelInitExecute(
      { title: "自動整形テスト", genre: "現代ファンタジー", targetWords: 100, chapterCount: 1 },
      ctx,
    )

    // 既定 autoFix: true で保存時に表記が自動整形され、目安文字数（100±15%）と比較される
    const dirtyBody = "「行こう。」\n廊下を歩いた!　３メートル先だ。"
    const saveOut = await novelSaveChapterExecute({ chapterNumber: 1, title: "テスト", content: dirtyBody }, ctx)
    assert.ok(saveOut.includes("✨ 表記を自動整形しました"))
    assert.ok(saveOut.includes("→"))
    assert.ok(saveOut.includes("整形前の本文を残しました"))
    assert.ok(saveOut.includes("規約から外れた箇所はありません"))
    assert.ok(saveOut.includes("目安 100文字 ±15%"))
    assert.ok(saveOut.includes("少なめ"))
    assert.ok(saveOut.includes("水増しせず"))
    const savedFile = readFileSync(join(dir, ".novel/chapters/chapter-001.md"), "utf-8")
    assert.ok(savedFile.includes("「行こう」\n　廊下を歩いた！　3メートル先だ。"))
    // 同じ内容を繰り返し保存しても before-fix の控えが重複生成されない
    const repeatOut = await novelSaveChapterExecute({ chapterNumber: 1, title: "テスト", content: dirtyBody }, ctx)
    assert.ok(repeatOut.includes("前に保存した内容と同じでした"))
    assert.ok(!repeatOut.includes("整形前の本文を残しました"))
    const beforeFixDrafts = readdirSync(join(dir, ".novel/drafts")).filter((f) => f.includes("before-fix"))
    assert.equal(beforeFixDrafts.length, 1)

    // autoFix: false で未整形のまま保存したあと、novel_check(fix: true) で自動修正＋旧稿退避できる
    const unfixedOut = await novelSaveChapterExecute(
      { chapterNumber: 2, title: "未整形", content: "「閉じてない\n「行く。」", autoFix: false },
      ctx,
    )
    assert.ok(unfixedOut.includes("❌ 規約違反"))
    assert.ok(!unfixedOut.includes("自動整形しました"))
    assert.ok(readFileSync(join(dir, ".novel/chapters/chapter-002.md"), "utf-8").includes("「行く。」"))
    const fixOut = await novelCheckExecute({ chapterNumber: 2, fix: true }, ctx)
    assert.ok(fixOut.includes("✨ 表記を自動修正しました"))
    assert.ok(fixOut.includes("旧稿は .novel/drafts/ に残しました"))
    // 会話末句点は直り、括弧の閉じ忘れだけが残る
    assert.ok(fixOut.includes("会話文末の句点 1"))
    assert.ok(fixOut.includes("❌ 規約違反 1件"))
    assert.ok(fixOut.includes("括弧の対応"))
    assert.ok(!fixOut.includes("[-❌] 会話文末の句点") && !fixOut.includes("- ❌ 会話文末の句点"))
    const fixedFile = readFileSync(join(dir, ".novel/chapters/chapter-002.md"), "utf-8")
    assert.ok(fixedFile.includes("「行く」"))
  })

  test("SF（plot / 完結型）では serial: false となり world-building.md が作られる（plot 既定値と正の整数検証）", async () => {
    const badDir = makeDir()
    assert.match(
      await novelInitExecute({ title: "不正", genre: "SF", targetWords: 0 }, { projectDir: badDir }),
      /^❌ targetWords は1以上の整数/,
    )
    assert.match(
      await novelInitExecute({ title: "不正", genre: "SF", chapterCount: 0 }, { projectDir: badDir }),
      /^❌ chapterCount は1以上の整数/,
    )
    assert.match(
      await novelInitExecute({ title: "不正", genre: "SF", chapterCount: -2 }, { projectDir: badDir }),
      /^❌ chapterCount は1以上の整数/,
    )

    const dir = makeDir()
    const ctx = { projectDir: dir }
    const out = await novelInitExecute(
      {
        title: "軌道宅配便かもめ号",
        genre: "近未来SF",
        storyMode: "plot",
      },
      ctx,
    )
    assert.ok(out.includes("genre-sf"))
    assert.equal(existsSync(join(dir, ".novel/world-building.md")), true)
    const config = JSON.parse(readFileSync(join(dir, ".novel/config.json"), "utf-8"))
    assert.equal(config.serial, false)
    assert.equal(config.worldBuilding, "standard")
    assert.equal(config.targetWords, 100000)
    assert.equal(config.chapterCount, 35)
  })

  test("chapterUnit: 章 を選んだ作品では資料・伏線案内・進行状況の単位が「章」で統一される", async () => {
    const dir = makeDir()
    const ctx = { projectDir: dir }
    await novelInitExecute(
      { title: "章立てテスト", genre: "SF", storyMode: "plot", chapterUnit: "章", targetWords: 6000, chapterCount: 2 },
      ctx,
    )
    await novelUpdateExecute(
      {
        action: "foreshadow",
        chapterNumber: 1,
        content: JSON.stringify({ items: [{ title: "暗号", content: "謎の信号", status: "planted", targetChapter: 2 }] }),
      },
      ctx,
    )
    const ctxOut = await novelContextExecute({ chapterNumber: 1 }, ctx)
    assert.ok(ctxOut.includes("執筆用の資料 — 第1章"))
    assert.ok(ctxOut.includes("第2章あたりで回収予定"))
    assert.ok(!ctxOut.includes("第2話あたりで回収予定"))
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

  test("話またぎ重複と直近話の締めが novel_context / novel_save_chapter / novel_check に連動し、serious の長文許容も効く", async () => {
    const dir = makeDir()
    const ctx = { projectDir: dir }
    await novelInitExecute(
      {
        title: "雨の鐘楼",
        genre: "ダークファンタジー",
        seriousness: "serious",
        targetWords: 30000,
        chapterCount: 10,
      },
      ctx,
    )

    await novelSaveChapterExecute(
      {
        chapterNumber: 1,
        title: "始まり",
        content: "　鐘楼の下で男はそっと肩をすくめた。ため息をつき、もう一度肩をすくめた。\n　冷たい風が石畳を撫でていく。",
      },
      ctx,
    )
    await novelSaveChapterExecute(
      {
        chapterNumber: 2,
        title: "再会",
        content: "　相棒がそっと肩をすくめ、静かにため息をついた。\n　門番は黙って松明を掲げた。",
      },
      ctx,
    )

    // 3話目の執筆資料には直近2話の締め方が載る
    const ctx3 = await novelContextExecute({ chapterNumber: 3 }, ctx)
    assert.ok(ctx3.includes("直近の締め方・繰り返しやすい表現"))
    assert.ok(ctx3.includes("第1話「始まり」"))
    assert.ok(ctx3.includes("第2話「再会」"))

    // 3話目で肩をすくめるが計5回に達すると保存時・個別点検・全話点検で話またぎ重複が出る
    // （一方、各話1回ずつの「そっと」「ため息」は鳴らず、serious の90字文も警告しない）
    const ninetyCharLine = `　${"あ".repeat(90)}。`
    const save3 = await novelSaveChapterExecute(
      {
        chapterNumber: 3,
        title: "夜明け前",
        content: `　隊長はそっと肩をすくめ、ため息をついてもう一度肩をすくめた。\n${ninetyCharLine}\n　鐘の音が遠ざかった。`,
      },
      ctx,
    )
    assert.ok(save3.includes("話をまたいだ繰り返し"))
    assert.ok(save3.includes("肩をすくめる"))
    assert.ok(!save3.includes("そっと"))
    assert.ok(!save3.includes("ため息"))
    assert.ok(!save3.includes("長い文"))

    const check3 = await novelCheckExecute({ chapterNumber: 3 }, ctx)
    assert.ok(check3.includes("話をまたいだ繰り返し"))
    assert.ok(check3.includes("第1話・第2話・第3話"))
    assert.ok(!check3.includes("長い文"))

    const checkAll = await novelCheckExecute({}, ctx)
    assert.ok(checkAll.includes("話をまたいだ繰り返し"))

    // 4話目の執筆資料には直近3話で重なった定型仕草の注意も載る
    const ctx4 = await novelContextExecute({ chapterNumber: 4 }, ctx)
    assert.ok(ctx4.includes("直近で重なっている定型仕草"))
    assert.ok(ctx4.includes("肩をすくめる"))
  })

  test("genreSkills の明示指定・未一致通知・不正値点検が novel_init / novel_status / novel_context で動作する", async () => {
    const badDir = makeDir()
    const badOut = await novelInitExecute(
      { title: "不正", genre: "悪役令嬢", genreSkills: ["genre-nope" as any] },
      { projectDir: badDir },
    )
    assert.match(badOut, /^❌ genreSkills に未対応のスキル名/)

    const explicitDir = makeDir()
    const explicitCtx = { projectDir: explicitDir }
    const initOut = await novelInitExecute(
      {
        title: "悪役令嬢は領地経営で恋をする",
        genre: "悪役令嬢",
        genreSkills: ["genre-fantasy", "genre-romance"],
      },
      explicitCtx,
    )
    assert.ok(initOut.includes("genre-fantasy、genre-romance（明示指定）"))
    const statusOut = await novelStatusExecute({}, explicitCtx)
    assert.ok(statusOut.includes("ジャンルスキル: genre-fantasy、genre-romance（config.json で指定）"))
    const contextOut = await novelContextExecute({ chapterNumber: 1 }, explicitCtx)
    assert.ok(contextOut.includes("novel-writing、genre-fantasy、genre-romance"))

    const unmatchedDir = makeDir()
    const unmatchedCtx = { projectDir: unmatchedDir }
    const unmatchedInit = await novelInitExecute({ title: "放課後ミステリー", genre: "ミステリー" }, unmatchedCtx)
    assert.ok(unmatchedInit.includes("参照ジャンルスキル: なし"))
    const unmatchedStatus = await novelStatusExecute({}, unmatchedCtx)
    assert.ok(unmatchedStatus.includes("ジャンルスキル: なし（ジャンルから該当なし"))

    // 手動編集で不正な genreSkills が入った場合は記録の点検で警告する
    const cfgPath = join(unmatchedDir, ".novel/config.json")
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"))
    cfg.genreSkills = ["genre-invalid"]
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8")
    const warnStatus = await novelStatusExecute({}, unmatchedCtx)
    assert.ok(warnStatus.includes("genreSkills に未対応のスキル名があります: genre-invalid"))

    // 配列以外（文字列など）で手書きされた場合も記録の点検で警告する
    cfg.genreSkills = "genre-romance"
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8")
    const nonArrayStatus = await novelStatusExecute({}, unmatchedCtx)
    assert.ok(nonArrayStatus.includes("config.json の genreSkills は配列で指定してください"))
  })

  test("自動整形未収束時のエラーには該当行の抜粋（□凡例つき）と autoFix: false の回避手順が含まれる", () => {
    const msg = formatUnconvergedSaveError(
      "第2話",
      { kind: "chapter", chapter: 2 },
      "　1行目は正常。\n　...　怪しい2行目だ!",
      [2],
    )
    assert.ok(msg.includes("第2話は保存していません"))
    assert.ok(msg.includes("□ は全角スペース"))
    assert.ok(msg.includes("2行目: □...□怪しい2行目だ!"))
    assert.ok(msg.includes("autoFix: false"))
    assert.ok(msg.includes("novel_check(chapterNumber: 2)"))
  })

  test("次話プロット抜粋（P2）は引きのつなぎ向けに見どころ・入りのみ載せ、P1人物抽出を汚染せず、最終話や単話短編では出さない", async () => {
    const dir = makeDir()
    const ctx = { projectDir: dir }
    await novelInitExecute(
      { title: "次話先読みテスト", genre: "ラブコメ", storyMode: "episodic", targetWords: 100, chapterCount: 2 },
      ctx,
    )
    writeDoc(dir, "characters/アオイ.md", "# アオイ\n## 基本情報\n- **名前**：アオイ\n- **呼称**：アオイ\n")
    writeDoc(dir, "characters/カエデ.md", "# カエデ\n## 基本情報\n- **名前**：カエデ\n- **呼称**：カエデ\n")
    writeDoc(
      dir,
      "outline-detailed.md",
      `## 第1話：放課後の出会い
- **この話の見どころ**：アオイが教室で忘れ物を拾う
- **登場キャラと掛け合い**：アオイ

### 展開（3ビート）
1. **入り**：チャイムが鳴る

## 第2話：屋上の転校生
- **この話の見どころ**：カエデが屋上で弁当を広げるギャップ
- **話末の引き／オチ**：カエデの秘密が明かされる

### 展開（3ビート）
1. **入り**：翌日、屋上の扉を開けるとカエデが立っていた
3. **この話の山**：カエデが過去を語る
`,
    )

    const ch1 = await novelContextExecute({ chapterNumber: 1 }, ctx)
    assert.ok(ch1.includes("## ⏭️ 次の話のプロット抜粋 (P2 — 引きのつなぎ・先食い防止)"))
    assert.ok(ch1.includes("カエデが屋上で弁当を広げるギャップ"))
    assert.ok(ch1.includes("屋上の扉を開けるとカエデが立っていた"))
    assert.ok(!ch1.includes("カエデが過去を語る"))
    assert.ok(!ch1.includes("カエデの秘密が明かされる"))
    // 次話にしか出ないカエデが第1話の P1 登場人物シートに混入しないこと
    assert.ok(ch1.includes("この話に関わる人物の設定を載せています: アオイ。"))

    // 次話プロットが無い第2話では次話抜粋を出さない
    const ch2 = await novelContextExecute({ chapterNumber: 2 }, ctx)
    assert.ok(!ch2.includes("## ⏭️ 次の話のプロット抜粋"))

    // 文字数多めの ⚠️ にもごほうび削減防止の案内が付く
    const longBody = `　${"あ".repeat(120)}。`
    const saveLong = await novelSaveChapterExecute({ chapterNumber: 1, title: "多めテスト", content: longBody }, ctx)
    assert.ok(saveLong.includes("多め"))
    assert.ok(saveLong.includes("見どころやごほうびは削らず"))
  })
})
