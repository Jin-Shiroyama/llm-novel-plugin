import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  inferWorldBuilding,
  inferSeriousness,
  recommendedGenreSkills,
  resolveGenreSkills,
  determinePhase,
  isDocFilled,
  characterNameKeys,
  stripChapterHeading,
  chapterTitleFromHeading,
} from "../src/core/utils.js"
import type { NovelConfig } from "../src/core/utils.js"
import { checkTypography, fixTypography, formatFixChanges } from "../src/core/typography.js"
import {
  checkProse,
  scaledPhraseLimit,
  extractChapterEnding,
  findCrossChapterRepeats,
} from "../src/core/prose.js"
import { conceptParts, worldBuildingParts } from "../src/core/doc-sections.js"
import { CONCEPT_TEMPLATE, WORLD_BUILDING_TEMPLATE } from "../src/core/templates.js"
import { listPromptTemplates, buildPromptVars, getPromptTemplate } from "../src/core/prompts.js"
import { getGuideContent } from "../src/tools/guide.js"
import { extractNextOutlinePreview } from "../src/tools/context.js"
import { parseSummaryInput, upsertSummarySections, LEGACY_HEADING } from "../src/core/records.js"

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "llm-novel-v2-"))
}

function writeFile(root: string, rel: string, content: string): void {
  const path = join(root, rel)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content, "utf-8")
}

describe("ジャンル推定とスキル案内", () => {
  test("恋愛・ラブコメ・いちゃラブ・日常系は worldBuilding: minimal、対応するスキルを分けて返す", () => {
    assert.equal(inferWorldBuilding("ラブコメ"), "minimal")
    assert.equal(inferWorldBuilding("いちゃラブ"), "minimal")
    assert.equal(inferWorldBuilding("学園・日常コメディ"), "minimal")
    assert.equal(inferSeriousness("ラブコメ"), "light")
    assert.equal(inferSeriousness("いちゃラブ"), "light")
    assert.equal(inferSeriousness("スローライフ"), "light")
    assert.deepEqual(recommendedGenreSkills("ラブコメ"), ["genre-romance"])
    assert.deepEqual(recommendedGenreSkills("いちゃラブ"), ["genre-romance"])
    assert.deepEqual(recommendedGenreSkills("学園日常"), ["genre-slice-of-life"])
    assert.deepEqual(recommendedGenreSkills("スローライフ"), ["genre-slice-of-life"])
    assert.deepEqual(recommendedGenreSkills("青春コメディ"), ["genre-slice-of-life"])
    assert.deepEqual(recommendedGenreSkills("いちゃラブ日常"), ["genre-romance", "genre-slice-of-life"])
    assert.deepEqual(recommendedGenreSkills("学園ラブコメ・日常"), ["genre-romance", "genre-slice-of-life"])
  })

  test("異世界ファンタジー・SF は worldBuilding: standard、対応スキルを返す（学園単体で恋愛スキルを誤推薦しない）", () => {
    assert.equal(inferWorldBuilding("異世界ファンタジー"), "standard")
    assert.equal(inferWorldBuilding("近未来SF"), "standard")
    assert.equal(inferWorldBuilding("学園ラブコメSF"), "standard")
    assert.equal(inferWorldBuilding("学園異能バトル"), "standard")
    assert.equal(inferSeriousness("異世界ファンタジー"), "balanced")
    assert.deepEqual(recommendedGenreSkills("異世界ファンタジー"), ["genre-fantasy"])
    assert.deepEqual(recommendedGenreSkills("異世界スローライフ"), ["genre-fantasy", "genre-slice-of-life"])
    assert.deepEqual(recommendedGenreSkills("学園異能バトル"), ["genre-fantasy"])
    assert.deepEqual(recommendedGenreSkills("近未来SF"), ["genre-sf"])
    assert.deepEqual(recommendedGenreSkills("学園SF"), ["genre-sf"])
    assert.deepEqual(recommendedGenreSkills("学園ラブコメSF"), ["genre-romance", "genre-sf"])
  })

  test("短編はジャンルに関わらず worldBuilding: minimal", () => {
    assert.equal(inferWorldBuilding("異世界ファンタジー", "short"), "minimal")
  })

  test("resolveGenreSkills は config.genreSkills の明示指定を優先し、未対応名と空配列を区別する", () => {
    assert.deepEqual(resolveGenreSkills({ genre: "悪役令嬢" }), {
      skills: ["genre-fantasy"],
      source: "inferred",
      invalid: [],
    })
    assert.deepEqual(
      resolveGenreSkills({ genre: "悪役令嬢", genreSkills: ["genre-fantasy", "genre-romance", "genre-fantasy"] }),
      {
        skills: ["genre-fantasy", "genre-romance"],
        source: "config",
        invalid: [],
      },
    )
    assert.deepEqual(resolveGenreSkills({ genre: "ラブコメ", genreSkills: [] }), {
      skills: [],
      source: "config",
      invalid: [],
    })
    assert.deepEqual(
      resolveGenreSkills({ genre: "ミステリー", genreSkills: ["genre-sf", "genre-unknown" as any] }),
      {
        skills: ["genre-sf"],
        source: "config",
        invalid: ["genre-unknown"],
      },
    )
    const nonArray = resolveGenreSkills({ genre: "ラブコメ", genreSkills: "genre-romance" as any })
    assert.deepEqual(nonArray.skills, ["genre-romance"])
    assert.equal(nonArray.source, "inferred")
    assert.ok(nonArray.error && nonArray.error.includes("配列で指定"))
  })
})

describe("進行段階（determinePhase）の軽量化", () => {
  const baseConfig: NovelConfig = {
    title: "テスト作",
    genre: "ラブコメ",
    storyMode: "episodic",
    worldBuilding: "minimal",
    serial: true,
    chapterCount: 30,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    currentPhase: "concept",
  }

  test("worldBuilding: minimal は世界観工程を飛ばし、シーン設計なしでも writing に進む", () => {
    const dir = makeTempProject()
    writeFile(dir, ".novel/concept.md", "# 企画書\n\n## フック\n面白い話。")
    assert.equal(determinePhase(dir, baseConfig), "characters")

    writeFile(dir, ".novel/characters/profiles.md", "# 登場人物\n\n| 名前 | 立場 |\n|---|---|\n| 悠真 | 主人公 |")
    assert.equal(determinePhase(dir, baseConfig), "outline")

    writeFile(dir, ".novel/outline-brief.md", "# プロット概要\n序盤")
    assert.equal(determinePhase(dir, baseConfig), "outline")

    writeFile(dir, ".novel/outline/chapter-001.md", "## 第1話：はじまり\n見どころ")
    // シーン一覧が無くても直接 writing に進む
    assert.equal(determinePhase(dir, baseConfig), "writing")

    writeFile(dir, ".novel/chapters/epilogue.md", "# エピローグ その後\n\n　おしまい。")
    assert.equal(determinePhase(dir, baseConfig), "completed")
  })

  test("短編（storyMode: short）は outline-brief.md だけで writing に進む", () => {
    const dir = makeTempProject()
    const shortConfig: NovelConfig = { ...baseConfig, storyMode: "short", serial: false, chapterCount: 1 }
    writeFile(dir, ".novel/concept.md", "# 企画書\nフックあり。")
    writeFile(dir, ".novel/characters/profiles.md", "# 登場人物\n主人公あり。")
    writeFile(dir, ".novel/outline-brief.md", "# 短編プロット\nオチまで。")
    assert.equal(determinePhase(dir, shortConfig), "writing")

    writeFile(dir, ".novel/chapters/chapter-001.md", "# 第1章 短編\n\n　本文。")
    assert.equal(determinePhase(dir, shortConfig), "completed")
  })

  test("見出しの「第N話」「第N章」を両方認識できる", () => {
    assert.equal(stripChapterHeading("# 第1話 はじまり\n\n　本文だ。"), "　本文だ。")
    assert.equal(chapterTitleFromHeading("# 第1話 はじまり\n\n　本文だ。"), "はじまり")
    assert.equal(chapterTitleFromHeading("# 第2章 つづき\n\n　本文だ。"), "つづき")
  })

  test("isDocFilled は書き手の角括弧（[Lv1] や [仮]）で誤って未記入と判定しない", () => {
    const dir = makeTempProject()
    // 雛形のプレースホルダが残っていれば未記入
    writeFile(dir, ".novel/concept.md", CONCEPT_TEMPLATE)
    assert.equal(isDocFilled(join(dir, ".novel/concept.md"), CONCEPT_TEMPLATE), false)
    assert.equal(determinePhase(dir, baseConfig), "concept")

    // 雛形をすべて書き換えたうえで、本文中に [Lv1] や [仮] があっても記入済みになる
    writeFile(
      dir,
      ".novel/concept.md",
      "# 『[仮] 底なし鞄』作品企画書\n\n## フック\n> [Lv1]の荷運びが最強になる話。\n",
    )
    assert.equal(isDocFilled(join(dir, ".novel/concept.md"), CONCEPT_TEMPLATE), true)
    assert.equal(determinePhase(dir, baseConfig), "characters")
  })

  test("characterNameKeys は記入された区切りと呼称だけを使い、姓名を推測しない", () => {
    const minato = characterNameKeys("ミナト")
    assert.deepEqual(minato.strong, ["ミナト"])
    assert.deepEqual(minato.weak, [])

    const shiori = characterNameKeys("白瀬 栞")
    assert.ok(shiori.strong.includes("白瀬"))
    assert.ok(shiori.weak.includes("栞"))

    const hanKana = characterNameKeys("白瀬しおり", ["白瀬", "しおり"])
    assert.ok(hanKana.strong.includes("白瀬"))
    assert.ok(hanKana.strong.includes("しおり"))

    const fourHan = characterNameKeys("佐伯悠真")
    assert.deepEqual(fourHan.strong.sort(), ["佐伯悠真"].sort())
    assert.deepEqual(fourHan.weak, [])

    const middleDot = characterNameKeys("リナ・フォレスト")
    assert.ok(middleDot.strong.includes("リナ"))
    assert.ok(middleDot.strong.includes("フォレスト"))
  })
})

describe("表記の点検（typography）: 字下げ設定と特殊書式", () => {
  test("indent: none（Web小説スタイル）では字下げなしを許容し、全角字下げを警告する", () => {
    const noIndent = "放課後の教室は静かだった。\n「帰ろうぜ！」\n俺は鞄を掴んだ。"
    assert.equal(checkTypography(noIndent, { indent: "none" }).length, 0)

    const withIndent = "　放課後の教室は静かだった。"
    const issues = checkTypography(withIndent, { indent: "none" })
    assert.equal(issues.length, 1)
    assert.equal(issues[0].rule, "indent")
    assert.equal(issues[0].severity, "warning")
  })

  test("ステータス画面・掲示板・配信・チャット行と算用数字を誤検出しない", () => {
    const text = [
      "　画面を開くとレベル5になっていた。残り10分だ。",
      "",
      "【ステータス】",
      "名前：ミナト",
      "HP：120／120",
      "スキル：〈無限収納〉Lv1",
      "",
      "＞草",
      "＞同接：1,204",
      "",
      "白瀬：明日も卵焼きをお願いします",
    ].join("\n")
    assert.equal(checkTypography(text).length, 0)
  })

  test("fixTypography は機械修正可能な表記を自動整形し、ルビ・傍点や文意を壊さない", () => {
    const dirty = [
      "放課後の廊下は３メートル先に窓がある。",
      "　「行こう。」",
      "「本当か?彼はまだHP1200だ!」",
      "「待て!　」「どこだ!?」",
      "...　それで—どうなったんだ。",
      "｜背負子《しょいこ》が軽い。",
      "「｜行こう《いこう》。」",
      "　｜彼女《かのじょ》!あ、漢字《かんじ》と《《絶対》》!",
      "【ステータス】",
      "名前：ミナト",
      "＞草",
      "◇",
    ].join("\n")

    const expected = [
      "　放課後の廊下は3メートル先に窓がある。",
      "「行こう」",
      "「本当か？　彼はまだHP1200だ！」",
      "「待て！」「どこだ！？」",
      "……それで――どうなったんだ。",
      "　｜背負子《しょいこ》が軽い。",
      "「｜行こう《いこう》」",
      "　｜彼女《かのじょ》！　あ、漢字《かんじ》と《《絶対》》！",
      "【ステータス】",
      "名前：ミナト",
      "＞草",
      "◇",
    ].join("\n")

    const res = fixTypography(dirty, { indent: "fullwidth" })
    assert.equal(res.text, expected)
    assert.ok(res.totalFixes > 0)
    assert.ok(res.changes.length > 0)
    assert.deepEqual(checkTypography(res.text, { indent: "fullwidth" }), [])
    // 冪等性
    const second = fixTypography(res.text, { indent: "fullwidth" })
    assert.equal(second.text, expected)
    assert.equal(second.totalFixes, 0)
    assert.deepEqual(second.changes, [])
  })

  test("fixTypography は特殊書式（罫線ステータス・飾り見出し・通知・配信・記号・URL・数値範囲）と確認どまり（⚠️）を書き換えない", () => {
    const special = [
      "┌────────┐",
      "│ 名前：ミナト │",
      "│ HP：120／120 │",
      "└────────┘",
      "━━━━ ステータス ━━━━",
      "── 第1部 ──",
      "",
      "＜レベルが上がりました！＞",
      "＞すげえ！ｗ",
      "「好き！♡」",
      "　第1–3層を攻略した。",
      "　詳細はこちら https://example.com/?q=1&a=2 と example.com/?page=3 を確認した。",
      "　彼は Hello World と言った。",
      "　　詩の1行目。",
    ].join("\n")

    const res = fixTypography(special, { indent: "fullwidth" })
    assert.equal(res.text, special)
    assert.equal(res.totalFixes, 0)
    assert.deepEqual(res.changes, [])
    // 点検でもエラー（❌）は 0 件（Hello World の ascii-space と 2字字下げは ⚠️ のみ）
    const errors = checkTypography(special, { indent: "fullwidth" }).filter((i) => i.severity === "error")
    assert.deepEqual(errors, [])
  })

  test("裸のURLと日本語の境界が曖昧なら保持し、明示したURLの後ろは整形する", () => {
    const src = [
      "　example.com/newsです!すごい!",
      "「サイトは<example.com/top>だよ。」",
    ].join("\n")
    const res = fixTypography(src, { indent: "fullwidth" })
    assert.equal(
      res.text,
      [
        "　example.com/newsです!すごい!",
        "「サイトは<example.com/top>だよ」",
      ].join("\n"),
    )
    assert.deepEqual(
      checkTypography(res.text, { indent: "fullwidth" }).filter((i) => i.severity === "error"),
      [],
    )
  })

  test("formatFixChanges は長い行の行末付近の修正でも差分位置を中心に切り出して前後を区別できる", () => {
    const longBefore = "「この長い会話文はずっと続いていて、四十文字を優に超えたあたりの最後の最後にだけ句点がある。」"
    const res = fixTypography(longBefore, { indent: "fullwidth" })
    const summary = formatFixChanges(res.changes)
    const [left, right] = summary.trim().replace(/^-\s*\d+行目:\s*/, "").split(" → ")
    assert.notEqual(left, right)
    assert.ok(left.includes("。」"))
    assert.ok(right.endsWith("」") && !right.endsWith("。」"))
  })

  test("あらすじの「全体の流れ（第N話まで）」を受理し、旧形式へ誤移送しない", () => {
    const parsed = parseSummaryInput("## 全体の流れ（第3話まで）\n\n三話までのあらすじ。", undefined)
    assert.equal(parsed.ok, true)

    const current = "# 『テスト』これまでのあらすじ\n\n## 全体の流れ（第3話まで）\n\n三話までのあらすじ。\n\n## 第1章 始まり\n\n始まった。\n"
    const next = upsertSummarySections(
      current,
      [{ chapter: 2, heading: "## 第2章 続き", body: "続いた。" }],
      2,
    )
    assert.ok(next.includes("三話までのあらすじ。"))
    assert.ok(!next.includes(LEGACY_HEADING))
  })

  test("fixTypography は indent: none の字下げ除去に対応し、括弧崩れ・ルビ崩れ・長音符「ーー」には触らない", () => {
    const src = [
      "　放課後の教室だ。",
      "「閉じていない会話",
      "「うわーーっ!」",
      "　｜閉じてない《ルビ",
    ].join("\n")

    const res = fixTypography(src, { indent: "none" })
    assert.equal(
      res.text,
      [
        "放課後の教室だ。",
        "「閉じていない会話",
        "「うわーーっ！」",
        "｜閉じてない《ルビ",
      ].join("\n"),
    )
    const remaining = checkTypography(res.text, { indent: "none" }).map((i) => i.rule)
    assert.ok(remaining.includes("bracket"))
    assert.ok(remaining.includes("dash"))
    assert.ok(remaining.includes("ruby"))
    assert.ok(!remaining.includes("indent"))
    assert.ok(!remaining.includes("halfwidth-punctuation"))
  })
})

describe("文章の点検（prose）: 反AIと教訓まとめ検出", () => {
  test("勝手な教訓・感動まとめを preachy-ending として検出する", () => {
    const preachy = [
      "　この出来事を通して、俺は大切なことに気づいた。",
      "　二人の絆がさらに深まった。",
      "　それはかけがえのない時間だった。",
    ].join("\n")
    const issues = checkProse(preachy)
    const preachyIssues = issues.filter((i) => i.rule === "preachy-ending")
    assert.equal(preachyIssues.length, 3)
  })

  test("ラノベの一人称語り（つまり・まだ知らなかった等）は過剰検出しない", () => {
    const light = [
      "　つまり、あの6人の横を通る必要がある。",
      "　帰りたい。",
      "　彼らはまだ知らなかった。俺のスキルが規格外だということを。",
    ].join("\n")
    assert.equal(checkProse(light).length, 0)
  })

  test("「その瞬間／次の瞬間」は1話1回まで許容し、2回目から検出する", () => {
    const once = "　剣を振り下ろした。次の瞬間、石壁が真っ二つに割れた。"
    assert.equal(checkProse(once).length, 0)

    const twice = [
      "　剣を振り下ろした。次の瞬間、石壁が真っ二つに割れた。",
      "　その瞬間、奥から赤い光が吹き上がった。",
    ].join("\n")
    const issues = checkProse(twice).filter((i) => i.phrase === "その瞬間")
    assert.equal(issues.length, 1)
  })

  test("文字数に応じて許容回数が3,000字基準でスケールし、serious では1文100字まで許容する", () => {
    assert.equal(scaledPhraseLimit(0, 12000), 0)
    assert.equal(scaledPhraseLimit(1, 3000), 1)
    assert.equal(scaledPhraseLimit(1, 6000), 2)
    assert.equal(scaledPhraseLimit(3, 12000), 12)

    const filler = "　雨が石畳を濡らして、通りに明かりが灯る。".repeat(300) // 約6,000字
    const longTwice = `${filler}\n　次の瞬間、鐘が鳴った。\n　その瞬間、門が開いた。`
    assert.equal(checkProse(longTwice).filter((i) => i.phrase === "その瞬間").length, 0)

    const longThrice = `${longTwice}\n　この瞬間、風が止んだ。`
    assert.equal(checkProse(longThrice).filter((i) => i.phrase === "その瞬間").length, 1)

    const ninetyChars = `　${"あ".repeat(90)}。`
    const overHundredChars = `　${"あ".repeat(105)}。`
    assert.equal(checkProse(ninetyChars).filter((i) => i.rule === "long-sentence").length, 1)
    assert.equal(checkProse(ninetyChars, { seriousness: "serious" }).filter((i) => i.rule === "long-sentence").length, 0)
    assert.equal(checkProse(overHundredChars, { seriousness: "serious" }).filter((i) => i.rule === "long-sentence").length, 1)
  })

  test("話末（末尾3行）の「悪くない」締め・内省モノローグ締めだけを closing-cliche として検出し、途中や会話は誤検出しない", () => {
    const badClosing1 = [
      "　放課後の昇降口を出た。",
      "　夕焼けの坂道を歩きながら、ポケットの鍵を鳴らす。",
      "　こんな毎日も、悪くないな。",
    ].join("\n")
    assert.equal(checkProse(badClosing1).filter((i) => i.rule === "closing-cliche").length, 1)

    const badClosing2 = [
      "　駅前の信号が青に変わった。",
      "　そう思いながら、俺は自転車のペダルを踏み込んだ。",
    ].join("\n")
    assert.equal(checkProse(badClosing2).filter((i) => i.rule === "closing-cliche").length, 1)

    const badClosing3 = "　悪くない気分だ。\n　これも悪くない……かもしれない。"
    assert.equal(checkProse(badClosing3).filter((i) => i.rule === "closing-cliche").length, 2)

    // 話の途中（末尾3行より前）や文中修飾、会話内の「悪くない」は誤検出しない
    const safeText = [
      "　味自体は悪くないのに、見た目だけが妙に派手だ。",
      "　そう思いながら皿を下げた。",
      "　店を出て交差点を曲がる。",
      "　遠くで踏切の音が鳴った。",
      "「これ、悪くないね」",
      "　先輩はそう笑ってコンビニの袋を揺らした。",
    ].join("\n")
    assert.equal(checkProse(safeText).filter((i) => i.rule === "closing-cliche").length, 0)
  })

  test("高シグナルな仕草・ぼかし語尾（肩をすくめる・苦笑・気がした）は許容内を通し連発だけ拾う", () => {
    const okOnce = [
      "　先輩は肩をすくめた。",
      "　俺は苦笑してノートを閉じる。",
      "　少し寒い気がした。風の音が強くなった気がした。",
    ].join("\n")
    assert.equal(checkProse(okOnce).length, 0)

    const overused = [
      okOnce,
      "　もう一度、先輩は肩をすくめた。",
      "　俺も小さく笑った。",
      "　何か忘れている気がした。",
    ].join("\n")
    const phrases = checkProse(overused).map((i) => i.phrase)
    assert.ok(phrases.includes("肩をすくめる"))
    assert.ok(phrases.includes("小さく笑う・苦笑"))
    assert.ok(phrases.includes("〜気がした"))
  })

  test("extractChapterEnding と findCrossChapterRepeats が締め抽出と話またぎ重複を正しく判定する", () => {
    const ch = "# 第1章 放課後\n\n　チャイムが鳴った。\n\n「また明日な」\n　夕焼けの廊下を歩き出した。\n\n◇\n"
    assert.equal(extractChapterEnding(ch), "「また明日な」 ／ 夕焼けの廊下を歩き出した。")

    // 陰性: ありふれた副詞・仕草（そっと・ゆっくりと・静かに・ため息・首を傾げる）や目立つ仕草でも各話1回×3話では鳴らない
    const normalThree = [
      { label: "第1話", text: "　彼はそっと扉を閉め、ゆっくりと歩き出した。静かにため息をつき、首を傾げる。肩をすくめた。" },
      { label: "第2話", text: "　彼女はそっと本を置き、ゆっくりと顔を上げた。静かにため息をつき、首を傾げる。肩をすくめた。" },
      { label: "第3話", text: "　俺はそっと窓を開け、ゆっくりと背伸びした。静かにため息をつき、首を傾げる。肩をすくめた。" },
    ]
    assert.deepEqual(findCrossChapterRepeats(normalThree), [])

    // 陽性1: 近い5話のうち3話以上かつ計5回以上（2+1+2）は検出。会話文や間隔の空いた使用は誤検出しない
    const chapters = [
      { label: "第1話", text: "　彼は肩をすくめた。もう一度、肩をすくめた。\n　俺は目を細めた。" },
      { label: "第2話", text: "「肩をすくめるなよ」「また肩をすくめるなよ」\n　窓の外では雨が降っていた。" },
      { label: "第3話", text: "　彼女は肩をすくめた。" },
      { label: "第4話", text: "　再び彼は肩をすくめた。呆れて肩をすくめた。" },
      { label: "第5話", text: "　朝の光が差し込んだ。" },
      { label: "第6話", text: "　俺はまた目を細めた。二度目を細めた。" },
      { label: "第7話", text: "　静かな午後だった。" },
      { label: "第8話", text: "　最後に目を細めた。もう一度目を細めた。" },
    ]
    const allRepeats = findCrossChapterRepeats(chapters)
    assert.equal(allRepeats.length, 1)
    assert.equal(allRepeats[0].motif, "肩をすくめる")
    assert.deepEqual(allRepeats[0].chapters, ["第1話", "第3話", "第4話"])
    assert.equal(allRepeats[0].totalCount, 5)

    // targetIndex 指定時: 対象話に出ていない表現は報告しない
    assert.deepEqual(findCrossChapterRepeats(chapters, { targetIndex: 4 }), [])
    const atCh4 = findCrossChapterRepeats(chapters, { targetIndex: 3 })
    assert.equal(atCh4.length, 1)
    assert.equal(atCh4[0].motif, "肩をすくめる")

    // 陽性2: 目立つ仕草が5話連続で毎話1回ずつ（5話・計5回）出れば検出する
    const fiveStreak = [1, 2, 3, 4, 5].map((n) => ({
      label: `第${n}話`,
      text: "　彼は苦笑して席を立った。",
    }))
    const streakRepeats = findCrossChapterRepeats(fiveStreak)
    assert.equal(streakRepeats.length, 1)
    assert.equal(streakRepeats[0].motif, "苦笑・小さく笑う")
    assert.equal(streakRepeats[0].totalCount, 5)

    // 陰性2: 「目を細める」と驚き（「目を見開く・目を丸くする」）は別分類のため、5話で混ぜて使っても誤検出しない
    const mixedEyes = [
      { label: "第1話", text: "　先輩は眩しそうに目を細めた。" },
      { label: "第2話", text: "　彼女は思わずではなく素直に目を見開いた。" },
      { label: "第3話", text: "　俺は画面を見て目を丸くした。" },
      { label: "第4話", text: "　遠くの塔へ視線を送り、目を細めた。" },
      { label: "第5話", text: "　予想外の言葉に目を見開いた。" },
    ]
    assert.deepEqual(findCrossChapterRepeats(mixedEyes), [])

    // 陽性3: 驚きの表現（「目を見開く」「目を丸くする」）だけで5話連続・計5回なら検出する
    const surpriseStreak = [
      { label: "第1話", text: "　目を見開いた。" },
      { label: "第2話", text: "　目を丸くした。" },
      { label: "第3話", text: "　目を見開いた。" },
      { label: "第4話", text: "　目を丸くした。" },
      { label: "第5話", text: "　目を見開いた。" },
    ]
    const surpriseRepeats = findCrossChapterRepeats(surpriseStreak)
    assert.equal(surpriseRepeats.length, 1)
    assert.equal(surpriseRepeats[0].motif, "目を見開く・目を丸くする")
  })
})

describe("企画書・舞台設定の優先枠配分（doc-sections）", () => {
  test("conceptParts はフック・面白さ・トーンとNGライン・語りに priority を立て、基本情報を省く", () => {
    const doc = `# 『テスト』作品企画書

## フック（ひとことで言うと）
> クール美少女が弁当を狙うラブコメ。

## この作品の面白さ（読者体験の柱）
- ギャップにニヤニヤする

## トーンと NG ライン
- **全体の雰囲気**：笑える・掛け合い
- **NG ライン（やらないこと）**：重い過去や教訓を足さない

## 大まかな流れ（第1部・全体の方向）
1. 放課後に試食会が始まる

## 基本情報
- ジャンル：ラブコメ
`
    const parts = conceptParts(doc, CONCEPT_TEMPLATE)
    assert.ok(parts.some((p) => p.label.includes("フック") && p.priority === true))
    assert.ok(parts.some((p) => p.label.includes("面白さ") && p.priority === true))
    assert.ok(parts.some((p) => p.label.includes("NG") && p.priority === true))
    assert.ok(parts.some((p) => p.label.includes("大まかな流れ") && !p.priority))
    assert.ok(!parts.some((p) => p.label === "基本情報"))
  })

  test("conceptParts は未記入の文体見本案内を省き、記入された文体見本は優先枠で載せる", () => {
    const unfilled = `# 『テスト』作品企画書

## 語りと文体
- **視点**：三人称
- **語り手のテンション**：落ち着いたシリアス
- **特殊書式**：なし

### 文体見本（任意・200〜600文字）
> 書き手自身の文章や、理想のテンポ・語尾・一文の長さがわかる数段落をここに書きます（未記入のままでも進められます。第1話から気に入った箇所を移してもかまいません）。
`
    const partsUnfilled = conceptParts(unfilled, CONCEPT_TEMPLATE)
    const styleUnfilled = partsUnfilled.find((p) => p.label.includes("文体"))
    assert.ok(styleUnfilled && styleUnfilled.priority === true)
    assert.ok(!styleUnfilled.content.includes("文体見本"))

    const filled = `${unfilled}\n　雨が石畳を叩いていた。セシルは短剣の柄を静かに握り直す。\n`
    const partsFilled = conceptParts(filled, CONCEPT_TEMPLATE)
    const styleFilled = partsFilled.find((p) => p.label.includes("文体"))
    assert.ok(styleFilled && styleFilled.priority === true)
    assert.ok(styleFilled.content.includes("文体見本"))
    assert.ok(styleFilled.content.includes("雨が石畳を叩いていた"))
    assert.ok(!styleFilled.content.includes("未記入のままでも進められます"))
  })

  test("conceptParts はトーン内の摩擦・ままならなさを優先枠で載せ、未記入行は除外し、独立見出しも優先する", () => {
    const withFilledFriction = `# 『テスト』作品企画書

## トーンと NG ライン
- **全体の雰囲気**：笑える・掛け合い
- **物語を動かす摩擦・ままならなさ**：素直になれない照れ隠しと時間の制約
- **NG ライン（やらないこと）**：重い過去や教訓を足さない
`
    const parts = conceptParts(withFilledFriction, CONCEPT_TEMPLATE)
    const tonePart = parts.find((p) => p.label.includes("NG"))
    assert.ok(tonePart && tonePart.priority === true)
    assert.ok(tonePart.content.includes("素直になれない照れ隠しと時間の制約"))

    const withUnfilledFriction = `# 『テスト』作品企画書

## トーンと NG ライン
- **全体の雰囲気**：笑える・掛け合い
- **物語を動かす摩擦・ままならなさ**：[この作品の軽さに合う引っかかり（例：照れ隠し・小さな勘違い・スキルの制約や条件・時間の縛り・無害なこだわりのぶつかり）。純粋な空気系・いちゃラブなら「小さなハプニングやシチュエーション変化のみ」]
- **NG ライン（やらないこと）**：重い過去や教訓を足さない
`
    const partsUnfilled = conceptParts(withUnfilledFriction, CONCEPT_TEMPLATE)
    const toneUnfilled = partsUnfilled.find((p) => p.label.includes("NG"))
    assert.ok(toneUnfilled && !toneUnfilled.content.includes("物語を動かす摩擦・ままならなさ"))

    const standalone = `# 『テスト』作品企画書

## 物語を動かす摩擦・ままならなさ
- 歩いた場所しか測れない制約
`
    const standaloneParts = conceptParts(standalone, CONCEPT_TEMPLATE)
    assert.ok(standaloneParts.some((p) => p.label.includes("摩擦") && p.priority === true))
  })

  test("worldBuildingParts はギミック・ルール・約束ごとに priority を立てる", () => {
    const doc = `# 『テスト』舞台・設定

## 舞台の雰囲気と主な場所
- 宇宙港第7ドック

## ギミック・ルール・能力・技術（あれば）
### 基本の仕組み
反重力リングは消費電力が低い。

## この世界の約束ごと
1. 無重力下では反作用が働く
`
    const parts = worldBuildingParts(doc, WORLD_BUILDING_TEMPLATE)
    assert.ok(parts.some((p) => p.label.includes("ギミック") && p.priority === true))
    assert.ok(parts.some((p) => p.label.includes("約束ごと") && p.priority === true))
  })
})

describe("プロンプト一覧（prompts）と次話プロット抜粋", () => {
  test("wuxia・reality および廃止済みの chapter-write / chapter-continue を含まず、outline-episodic を含む", () => {
    const names = listPromptTemplates()
    assert.ok(names.includes("outline-episodic"))
    assert.ok(!names.some((n) => n.includes("wuxia") || n.includes("reality") || n.includes("archetype")))
    assert.ok(!names.includes("chapter-write"))
    assert.ok(!names.includes("chapter-continue"))
    assert.equal(getPromptTemplate("chapter-write"), null)
    assert.equal(getPromptTemplate("chapter-continue"), null)
    assert.ok(getPromptTemplate("outline-episodic"))

    const guide = getGuideContent("prompts")
    assert.ok(!guide.includes("chapter-write"))
    assert.ok(!guide.includes("chapter-continue"))
    assert.ok(guide.includes("novel_context"))

    const vars = buildPromptVars({
      title: "放課後弁当",
      genre: "ラブコメ",
      storyMode: "episodic",
      seriousness: "light",
      targetWords: 90000,
      chapterCount: 30,
    })
    assert.equal(vars.targetWordCount, "3,000")
    assert.ok(vars.seriousness.includes("軽快"))
  })

  test("extractNextOutlinePreview は見出し・見どころ・入りのみを抜き出し、山場や引きを除外する", () => {
    const outline = `## 第2話：雨宿りの約束

- **視点キャラ**：悠真
- **登場人物**：悠真、白瀬栞
- **この話の見どころ**：急な夕立で二人が軒先へ駆け込む急接近
- **話末の引き／オチ**：秘密の連絡先を交換する

### 展開（3ビート）
1. **入り**：帰り道に突然の大雨が降り出し、駅前の古書店へ飛び込む
2. **転がし**：タオルを分け合って掛け合い
3. **この話の山**：白瀬が初めて下の名前で呼ぶ
`
    const preview = extractNextOutlinePreview(outline)
    assert.ok(preview)
    assert.ok(preview.includes("### 第2話：雨宿りの約束"))
    assert.ok(preview.includes("- 見どころ: 急な夕立で二人が軒先へ駆け込む急接近"))
    assert.ok(preview.includes("- 入り: 帰り道に突然の大雨が降り出し、駅前の古書店へ飛び込む"))
    assert.ok(!preview.includes("下の名前で呼ぶ"))
    assert.ok(!preview.includes("秘密の連絡先"))

    // 見どころ・入り欄が無い自由書式メモや未記入プレースホルダのみなら、先食い防止のため null
    const freeform = "## 第3話：テスト勉強\n- **視点キャラ**：悠真\n図書館の自習室でテスト対策を始める。\n"
    assert.equal(extractNextOutlinePreview(freeform), null)
    assert.equal(extractNextOutlinePreview("## 第2話：[未定]\n- **この話の見どころ**：[見どころ]\n"), null)
  })
})
