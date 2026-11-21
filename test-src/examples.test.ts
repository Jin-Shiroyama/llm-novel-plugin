import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { novelStatusExecute } from "../src/tools/status.js"
import { novelContextExecute } from "../src/tools/context.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const examplesRoot = join(root, "examples")

function extractSection(doc: string, headingPrefix: string): string {
  const lines = doc.split("\n")
  let collecting = false
  const out: string[] = []
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (collecting) break
      if (line.startsWith(headingPrefix)) collecting = true
    }
    if (collecting) out.push(line)
  }
  return out.join("\n")
}

describe("見本作品フィクスチャ（examples/）の整合性と資料生成", () => {
  test("romcom-light は writing 段階で警告 0 件、第1〜3話の novel_context が必須要素と次話抜粋を正しく組み立てる", async () => {
    const dir = join(examplesRoot, "romcom-light")
    const ctx = { projectDir: dir }

    const status = await novelStatusExecute({ detailed: true }, ctx)
    assert.ok(status.includes("本文執筆（writing）"), `writing 段階であること:\n${status}`)
    assert.ok(!status.includes("⚠️"), `警告が 0 件であること:\n${status}`)
    assert.ok(!status.includes("呼称が未記入"), `呼称未記入が無いこと:\n${status}`)
    assert.ok(status.includes("genre-romance"))

    for (const ch of [1, 2, 3]) {
      const out = await novelContextExecute({ chapterNumber: ch }, ctx)
      assert.ok(out.includes(`## 📋 この話のプロット (P0 — 必ず従う)`), `第${ch}話に P0 プロットがあること`)
      assert.ok(out.includes("## 💡 作品の核・トーン・NGライン"), `第${ch}話に企画書があること`)
      assert.ok(out.includes("物語を動かす摩擦・ままならなさ"), `第${ch}話に摩擦・ままならなさが入ること`)
      assert.ok(out.includes("文体見本"), `第${ch}話に文体見本が入ること`)
      assert.ok(out.includes("## 👁️ 視点人物"), `第${ch}話に視点人物が入ること`)
      assert.ok(out.includes("水野航"), `第${ch}話に主人公が入ること`)
      assert.ok(out.includes("橘千歳"), `第${ch}話にヒロインが入ること`)
      assert.ok(out.includes("## 🗣️ ことばづかい"), `第${ch}話にことばづかいが入ること`)
      assert.ok(out.includes("字下げなし"), `第${ch}話に字下げなし設定が反映されること`)
      assert.ok(out.includes("genre-romance"), `第${ch}話にジャンルスキルが載ること`)
      assert.ok(out.includes("## ⏭️ 次の話のプロット抜粋 (P2 — 引きのつなぎ・先食い防止)"), `第${ch}話に次話抜粋が載ること`)
      assert.ok(out.includes(`### 第${ch + 1}話`), `第${ch}話の次話抜粋が第${ch + 1}話を指すこと`)
      assert.ok(!out.includes("枠が足りず省略"), `第${ch}話の重要資料が枠超過で切れていないこと`)
    }

    // 第2話の次話抜粋（第3話）には森下陽菜が出るが、第2話の P1 登場人物シートには混入しないこと
    const ch2 = await novelContextExecute({ chapterNumber: 2 }, ctx)
    const ch2Next = extractSection(ch2, "## ⏭️ 次の話のプロット抜粋")
    const ch2Chars = extractSection(ch2, "## 👤 登場人物")
    assert.ok(ch2Next.includes("陽菜"), "第2話の次話抜粋に第3話の入り・見どころが含まれること")
    assert.ok(!ch2Chars.includes("この話に関わる人物の設定を載せています: 水野航、橘千歳、森下陽菜"), "次話限定キャラが今話 P1 へ混入しないこと")
    assert.ok(!ch2Chars.includes("森下陽菜の個別シート") && ch2Chars.includes("この話に関わる人物の設定を載せています: 水野航、橘千歳"))
  })

  test("fantasy-balanced は writing 段階で警告 0 件、世界観・用語集・伏線・次話抜粋が欠落なく揃う", async () => {
    const dir = join(examplesRoot, "fantasy-balanced")
    const ctx = { projectDir: dir }

    const status = await novelStatusExecute({ detailed: true }, ctx)
    assert.ok(status.includes("本文執筆（writing）"), `writing 段階であること:\n${status}`)
    assert.ok(!status.includes("⚠️"), `警告が 0 件であること:\n${status}`)
    assert.ok(!status.includes("呼称が未記入"), `呼称未記入が無いこと:\n${status}`)
    assert.ok(status.includes("genre-fantasy"))

    for (const ch of [1, 2, 3]) {
      const out = await novelContextExecute({ chapterNumber: ch }, ctx)
      assert.ok(out.includes("## 📋 この話のプロット (P0 — 必ず従う)"))
      assert.ok(out.includes("## 💡 作品の核・トーン・NGライン"))
      assert.ok(out.includes("物語を動かす摩擦・ままならなさ"))
      assert.ok(out.includes("文体見本"))
      assert.ok(out.includes("## 🗺️ 舞台・設定 (P1 — ルールとギミック)"))
      assert.ok(out.includes("## 📕 用語集 (P1 — 表記と意味)"))
      assert.ok(out.includes("## 🎯 伏線の確認 (P2 — 参考)"))
      assert.ok(out.includes("F1"))
      assert.ok(out.includes("全角1字下げ"))
      assert.ok(out.includes("genre-fantasy"))
      assert.ok(out.includes("## ⏭️ 次の話のプロット抜粋 (P2 — 引きのつなぎ・先食い防止)"))
      assert.ok(out.includes(`### 第${ch + 1}話`))
      assert.ok(!out.includes("枠が足りず省略"))
    }

    // 第1話の次話抜粋（第2話）にはバルドが出るが、第1話の P1 登場人物シートには混入しないこと
    const ch1 = await novelContextExecute({ chapterNumber: 1 }, ctx)
    const ch1Next = extractSection(ch1, "## ⏭️ 次の話のプロット抜粋")
    const ch1Chars = extractSection(ch1, "## 👤 登場人物")
    assert.ok(ch1Next.includes("バルド"), "第1話の次話抜粋に第2話のバルドが含まれること")
    assert.ok(ch1Chars.includes("この話に関わる人物の設定を載せています: レオ、フィナ"))
    assert.ok(!ch1Chars.includes("この話に関わる人物の設定を載せています: レオ、フィナ、バルド"))
  })
})
