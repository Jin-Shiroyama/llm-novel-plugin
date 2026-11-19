import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  inferWorldBuilding,
  inferSeriousness,
  recommendedGenreSkills,
  determinePhase,
  stripChapterHeading,
  chapterTitleFromHeading,
} from "../src/core/utils.js"
import type { NovelConfig } from "../src/core/utils.js"
import { checkTypography, fixTypography } from "../src/core/typography.js"
import { checkProse } from "../src/core/prose.js"
import { conceptParts, worldBuildingParts } from "../src/core/doc-sections.js"
import { CONCEPT_TEMPLATE, WORLD_BUILDING_TEMPLATE } from "../src/core/templates.js"
import { listPromptTemplates, buildPromptVars, getPromptTemplate } from "../src/core/prompts.js"

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
      "「本当か?彼はまだ HP1200 だ!」",
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
    assert.deepEqual(checkTypography(res.text, { indent: "fullwidth" }), [])
    // 冪等性
    const second = fixTypography(res.text, { indent: "fullwidth" })
    assert.equal(second.text, expected)
    assert.equal(second.totalFixes, 0)
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

describe("プロンプト一覧（prompts）", () => {
  test("wuxia・reality を含まず、outline-episodic を含む", () => {
    const names = listPromptTemplates()
    assert.ok(names.includes("outline-episodic"))
    assert.ok(!names.some((n) => n.includes("wuxia") || n.includes("reality") || n.includes("archetype")))
    assert.ok(getPromptTemplate("outline-episodic"))

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
})
