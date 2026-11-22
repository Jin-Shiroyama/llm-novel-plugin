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

  test("次話抜粋（P2）はプロローグ→第1話・話→直後の幕間を対象とし、抜粋不可の幕間があっても飛ばして次話を読まない", async () => {
    const dir = makeDir()
    const ctx = { projectDir: dir }
    await novelInitExecute(
      { title: "幕間つなぎテスト", genre: "異世界ファンタジー", storyMode: "arc", targetWords: 6000, chapterCount: 2 },
      ctx,
    )
    writeDoc(
      dir,
      "outline-detailed.md",
      `## プロローグ
- **この節の見どころ**：旅立ちの前夜

## 第1話：最初の依頼
- **この話の見どころ**：ギルドで初めての仕事を受ける
### 展開（3ビート）
1. **入り**：朝のギルドに駆け込む

## 幕間（第1話のあと）
- **この節の見どころ**：受付嬢から見た新人の印象
### 展開（3ビート）
1. **入り**：カウンターで書類を整理する

## 第2話：森の奥へ
- **この話の見どころ**：初めての森探索
### 展開（3ビート）
1. **入り**：東門から街道へ出る
`,
    )

    // プロローグでは第1話が抜粋される
    const pro = await novelContextExecute({ section: "prologue" }, ctx)
    assert.ok(pro.includes("## ⏭️ 次の話のプロット抜粋 (P2 — 引きのつなぎ・先食い防止)"))
    assert.ok(pro.includes("### 第1話：最初の依頼"))
    assert.ok(pro.includes("朝のギルドに駆け込む"))

    // 第1話の直後に幕間プロットがあれば、第2話ではなく幕間が見出し「次の幕間」で抜粋される
    const ch1 = await novelContextExecute({ chapterNumber: 1 }, ctx)
    assert.ok(ch1.includes("## ⏭️ 次の幕間のプロット抜粋 (P2 — 引きのつなぎ・先食い防止)"))
    assert.ok(ch1.includes("受付嬢から見た新人の印象"))
    assert.ok(!ch1.includes("初めての森探索"))

    // 幕間の次は第2話が抜粋される
    const inter = await novelContextExecute({ section: "interlude", chapterNumber: 1 }, ctx)
    assert.ok(inter.includes("## ⏭️ 次の話のプロット抜粋 (P2 — 引きのつなぎ・先食い防止)"))
    assert.ok(inter.includes("### 第2話：森の奥へ"))

    // 掲示板回のように見どころ・入り欄が無い幕間が存在する場合は、飛ばして第2話を抜粋せず何も出さない
    writeDoc(
      dir,
      "outline/interlude-001-1.md",
      "## 幕間（第1話のあと）\n掲示板で新人の噂が盛り上がる回。\n",
    )
    const ch1WithBoardInterlude = await novelContextExecute({ chapterNumber: 1 }, ctx)
    assert.ok(!ch1WithBoardInterlude.includes("## ⏭️ 次の"))
    assert.ok(!ch1WithBoardInterlude.includes("初めての森探索"))
  })

  test("novel_save_chapter の edits 部分置換（完全一致・整形フォールバック・行途中照合・旧稿退避・類似行ヒント・各種エラー）", async () => {
    const dir = makeDir()
    const ctx = { projectDir: dir }
    await novelInitExecute(
      { title: "部分置換テスト", genre: "現代ファンタジー", targetWords: 1000, chapterCount: 1 },
      ctx,
    )

    // 未保存ファイルへの edits はエラー
    const missingOut = await novelSaveChapterExecute(
      { chapterNumber: 1, edits: [{ from: "廊下", to: "階段" }] },
      ctx,
    )
    assert.match(missingOut, /^❌ 第1話は保存していません。既存の本文ファイル/)

    // まず未整形の下書きを保存（自動整形で字下げ・！？空白・三点リーダ・会話末句点が整形される）
    const initialBody = [
      "放課後の廊下を走った!間に合うか。",
      "「待ってくれ。」",
      "...窓の外でチャイムが鳴る。",
      "同じ言葉がここにある!",
      "同じ言葉がここにある!",
    ].join("\n")
    const firstSave = await novelSaveChapterExecute(
      { chapterNumber: 1, title: "放課後の疾走", content: initialBody },
      ctx,
    )
    assert.ok(firstSave.includes("✅ 第1話「放課後の疾走」を保存しました"))
    const chPath = join(dir, ".novel/chapters/chapter-001.md")
    const afterFirst = readFileSync(chPath, "utf-8")
    assert.ok(afterFirst.includes("　放課後の廊下を走った！　間に合うか。\n「待ってくれ」\n……窓の外でチャイムが鳴る。"))

    // 1. 完全一致での部分置換（title 省略時は既存タイトル維持、置換前原稿が .novel/drafts/ に退避され、置換後の自動整形も走る）
    const exactOut = await novelSaveChapterExecute(
      {
        chapterNumber: 1,
        edits: [{ from: "「待ってくれ」", to: "「待ってくれよ。」" }],
      },
      ctx,
    )
    assert.ok(exactOut.includes("✅ 第1話「放課後の疾走」を保存しました"))
    assert.ok(exactOut.includes("✏️ 部分置換を適用しました（1件）"))
    assert.ok(!exactOut.includes("自動整形後の文面へ照合"))
    assert.ok(exactOut.includes("🗂️ 前の原稿を残しました"))
    assert.ok(exactOut.includes("✨ 表記を自動整形しました"))
    const afterExact = readFileSync(chPath, "utf-8")
    assert.ok(afterExact.includes("「待ってくれよ」"))
    // 退避された旧稿に置換前の「待ってくれ」が残っていること
    const draftFiles = readdirSync(join(dir, ".novel/drafts"))
      .filter((f) => f.startsWith("chapter-001") && !f.includes("before-fix"))
      .sort()
    assert.equal(draftFiles.length, 1)
    assert.ok(readFileSync(join(dir, ".novel/drafts", draftFiles[0]), "utf-8").includes("「待ってくれ」"))

    // 2. 第2段フォールバック照合: 自動整形前の記憶（字下げなし・半角!・...）でも照合成功し、行途中スニペットも吸収する
    const fallbackOut = await novelSaveChapterExecute(
      {
        chapterNumber: 1,
        title: "夕暮れの疾走",
        edits: [
          { from: "廊下を走った!間に合うか。", to: "階段を駆け上がった！　まだ間に合う。" },
          { from: "...窓の外でチャイムが鳴る。", to: "……遠くでチャイムが鳴り響く。" },
        ],
      },
      ctx,
    )
    assert.ok(fallbackOut.includes("✅ 第1話「夕暮れの疾走」を保存しました"))
    assert.ok(fallbackOut.includes("✏️ 部分置換を適用しました（2件）"))
    assert.ok(fallbackOut.includes("ℹ️ edits の1件目・2件目は自動整形後または抜粋復元後の文面へ照合して置換しました"))
    const afterFallback = readFileSync(chPath, "utf-8")
    assert.ok(afterFallback.includes("　放課後の階段を駆け上がった！　まだ間に合う。"))
    assert.ok(afterFallback.includes("……遠くでチャイムが鳴り響く。"))

    // 2a. 自動整形前の下書き（単独 … ＋ 会話末句点）を from・to ともに渡しても抜粋誤判定で拒否されず置換＆自動整形される
    await novelSaveChapterExecute(
      { chapterNumber: 3, title: "下書き記憶テスト", content: "「…わかった。」" },
      ctx,
    )
    const draftMemoryOut = await novelSaveChapterExecute(
      { chapterNumber: 3, edits: [{ from: "…わかった。」", to: "…わかったよ。」" }] },
      ctx,
    )
    assert.ok(draftMemoryOut.includes("✅ 第3話「下書き記憶テスト」を保存しました"))
    assert.ok(draftMemoryOut.includes("規約から外れた箇所はありません"))
    const ch3Saved = readFileSync(join(dir, ".novel/chapters/chapter-003.md"), "utf-8")
    assert.ok(ch3Saved.includes("「……わかったよ」"))

    // 2b. 保存レポート・novel_check の抜粋（□ と両端の単独 …）をそのまま from に渡すケース
    const badLine = "「待って！　まだ話は終わっていないんだぞ、本当にこれでいいのか（開きっぱなし"
    const saveWithError = await novelSaveChapterExecute(
      { chapterNumber: 2, title: "抜粋テスト", content: badLine },
      ctx,
    )
    assert.ok(saveWithError.includes("❌ 規約違反"))
    // 保存レポートに出た実際の抜粋行を抽出（□ と末尾の単独 … の両方を含む: 「待って！□まだ話…）
    const excerptMatch = saveWithError.match(/\n\s+([^\n]*□[^\n]*…)\n/)
    assert.ok(excerptMatch, `保存レポートに □ と … を含む抜粋が出ること:\n${saveWithError}`)
    const rawExcerpt = excerptMatch[1].trim()
    // to に抜粋記号（□ や単独 …）が残ったままだと本文破壊を防ぐため拒否される
    const unsafeExcerptEdit = await novelSaveChapterExecute(
      { chapterNumber: 2, edits: [{ from: rawExcerpt, to: `${rawExcerpt}」` }] },
      ctx,
    )
    assert.match(unsafeExcerptEdit, /^❌ 第2話は保存していません。edits の1件目の to に抜粋記号/)
    // to がクリーンな本文断片であれば抜粋復元照合で1件一致して置換できる
    const cleanedTarget = rawExcerpt.replace(/□/g, "　").replace(/^…(?!…)/, "").replace(/(?<!…)…$/, "")
    const excerptFixOut = await novelSaveChapterExecute(
      {
        chapterNumber: 2,
        edits: [
          { from: rawExcerpt, to: cleanedTarget.replace("待って", "少し待って") },
          { from: "（開きっぱなし", to: "（解決済み）」" },
        ],
      },
      ctx,
    )
    assert.ok(excerptFixOut.includes("✅ 第2話「抜粋テスト」を保存しました"))
    assert.ok(excerptFixOut.includes("ℹ️ edits の1件目は自動整形後または抜粋復元後の文面へ照合して置換しました"))
    assert.ok(excerptFixOut.includes("規約から外れた箇所はありません"))
    const ch2Saved = readFileSync(join(dir, ".novel/chapters/chapter-002.md"), "utf-8")
    assert.ok(ch2Saved.includes("「少し待って！　まだ話は終わっていないんだぞ、本当にこれでいいのか（解決済み）」"))
    assert.ok(!ch2Saved.includes("□"))

    // 3. 同一結果の置換では重複退避されない
    const sameOut = await novelSaveChapterExecute(
      {
        chapterNumber: 1,
        edits: [{ from: "「待ってくれよ」", to: "「待ってくれよ」" }],
      },
      ctx,
    )
    assert.ok(sameOut.includes("前に保存した内容と同じでした"))

    // 4. 0件一致エラー: ファイル不変（前の edits が成功していても全体ロールバック）＆保存後の本文から近い行の現在文面が切られず提示される
    const longUniqueLine = "　夕焼けの差し込む図書室の長いテーブルの向こう側で、彼女は古い地図の端を指先でそっとなぞりながら、まだ誰にも見つかっていない秘密の階段の話を落ち着いた声で語り始めたのだった。"
    await novelSaveChapterExecute(
      {
        chapterNumber: 1,
        edits: [{ from: "……遠くでチャイムが鳴り響く。", to: `……遠くでチャイムが鳴り響く。\n${longUniqueLine}` }],
      },
      ctx,
    )
    const snapshot = readFileSync(chPath, "utf-8")
    const missOut = await novelSaveChapterExecute(
      {
        chapterNumber: 1,
        edits: [
          { from: "「待ってくれよ」", to: "「行かないでくれ」" },
          { from: "夕焼けの差し込む図書室の長いテーブルの向こう側で彼女は別の話を始めた。", to: "書き換え" },
        ],
      },
      ctx,
    )
    assert.match(missOut, /^❌ 第1話は保存していません。edits の2件目の from に一致する箇所が本文に見つかりませんでした/)
    assert.ok(missOut.includes("保存後の本文で近い行"))
    // 80字超の行も途中で「…」付きに切られず原文全文が提示されること
    assert.ok(missOut.includes(`6行目: ${longUniqueLine}`))
    assert.equal(readFileSync(chPath, "utf-8"), snapshot)

    // 5. 複数一致（完全一致・整形後フォールバックともに）で曖昧エラー＆ファイル不変
    const dupExact = await novelSaveChapterExecute(
      { chapterNumber: 1, edits: [{ from: "　同じ言葉がここにある！", to: "変更" }] },
      ctx,
    )
    assert.match(dupExact, /edits の1件目の from が本文中の 2 箇所に一致しました/)
    assert.equal(readFileSync(chPath, "utf-8"), snapshot)

    const dupFallback = await novelSaveChapterExecute(
      { chapterNumber: 1, edits: [{ from: "同じ言葉がここにある!", to: "変更" }] },
      ctx,
    )
    assert.match(dupFallback, /edits の1件目の from（自動整形後の文面）が本文中の 2 箇所に一致しました/)
    assert.equal(readFileSync(chPath, "utf-8"), snapshot)

    // 6. 引数バリデーション（排他・未指定・空配列・空from）
    assert.match(
      await novelSaveChapterExecute(
        { chapterNumber: 1, title: "両方", content: "本文", edits: [{ from: "a", to: "b" }] },
        ctx,
      ),
      /同時に指定できません/,
    )
    assert.match(await novelSaveChapterExecute({ chapterNumber: 1 }, ctx), /どちらか一方を指定/)
    assert.match(await novelSaveChapterExecute({ chapterNumber: 1, edits: [] }, ctx), /1件以上の置換/)
    assert.match(
      await novelSaveChapterExecute({ chapterNumber: 1, edits: [{ from: "", to: "x" }] }, ctx),
      /edits の1件目には空でない from/,
    )
  })
})
