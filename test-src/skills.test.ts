import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { checkTypography, fixTypography } from "../src/core/typography.js"
import { checkProse } from "../src/core/prose.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const EXPECTED_SKILLS = [
  "novel-planning",
  "novel-writing",
  "novel-editing",
  "genre-fantasy",
  "genre-romance",
  "genre-slice-of-life",
  "genre-sf",
  "novel-fanfic",
]

function extractTextCodeBlocks(markdown: string): string[] {
  const blocks: string[] = []
  const re = /```text\n([\s\S]*?)```/g
  for (const m of markdown.matchAll(re)) blocks.push(m[1])
  return blocks
}

describe("スキル構成と作例品質（checkTypography / checkProse）", () => {
  test("8本のスキルがすべて存在し、不要な旧スキルが存在しない", () => {
    const skillsDir = join(root, "skills")
    const dirs = readdirSync(skillsDir).sort()
    assert.deepEqual(dirs, [...EXPECTED_SKILLS].sort())
    for (const name of EXPECTED_SKILLS) {
      const path = join(skillsDir, name, "SKILL.md")
      assert.ok(existsSync(path), `${name}/SKILL.md が存在すること`)
      const raw = readFileSync(path, "utf-8")
      assert.ok(raw.startsWith("---\n"), `${name} に frontmatter があること`)
      assert.ok(raw.includes(`name: ${name}`), `${name} の frontmatter name が一致すること`)
    }
  })

  test("全スキルの ```text 作例が表記エラー 0件・反AI／教訓まとめ検出 0件を通過する", () => {
    let totalBlocks = 0
    for (const name of EXPECTED_SKILLS) {
      const raw = readFileSync(join(root, "skills", name, "SKILL.md"), "utf-8")
      const blocks = extractTextCodeBlocks(raw)
      for (const [idx, block] of blocks.entries()) {
        totalBlocks++
        const typoErrors = checkTypography(block).filter((i) => i.severity === "error")
        assert.deepEqual(
          typoErrors,
          [],
          `${name} の作例 #${idx + 1} に表記エラー: ${JSON.stringify(typoErrors)}`,
        )
        const proseIssues = checkProse(block)
        assert.deepEqual(
          proseIssues,
          [],
          `${name} の作例 #${idx + 1} に文章警告: ${JSON.stringify(proseIssues)}`,
        )
        const fixed = fixTypography(block)
        assert.equal(
          fixed.totalFixes,
          0,
          `${name} の作例 #${idx + 1} が fixTypography で書き換わりました: ${JSON.stringify(fixed.changes)}`,
        )
      }
    }
    assert.ok(totalBlocks >= 10, `作例ブロックが十分に検証されたこと（実測: ${totalBlocks}）`)
  })
})

describe("回帰ガード: 文芸・時代小説・社会派・葛藤強制の遺物が残っていないこと", () => {
  const FORBIDDEN_PATTERNS = [
    "九月の忘れもの",
    "森田悠",
    "鏡味",
    "吉川英治",
    "柴田錬三郎",
    "藤沢周平",
    "松本清張",
    "山崎豊子",
    "novel-wuxia",
    "novel-reality",
    "reality-source",
    "genre-romcom",
    "2つのジレンマを必ず置く",
    "必ず制約と代償を置く",
    "主要人物には必ず動機の三角形",
  ]

  function collectTextFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...collectTextFiles(full))
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".md")) out.push(full)
    }
    return out
  }

  test("src / commands / skills に旧設計の遺物が一切含まれない", () => {
    const files = [
      ...collectTextFiles(join(root, "src")),
      ...collectTextFiles(join(root, "commands")),
      ...collectTextFiles(join(root, "skills")),
    ]
    for (const file of files) {
      const content = readFileSync(file, "utf-8")
      for (const word of FORBIDDEN_PATTERNS) {
        assert.ok(!content.includes(word), `${file} に禁止語「${word}」が残っています`)
      }
    }
  })
})
