import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import pluginModule from "../src/index.js"
import { mergeAgentConfig } from "../src/adapters/opencode/agent-config.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

describe("OpenCode アダプタ層とハーネス非依存性", () => {
  test("default export は { id, server } のみで、8ツール・3エージェント・13コマンド・skills を登録する", async () => {
    assert.equal(pluginModule.id, "llm-novel-plugin")
    assert.equal(typeof pluginModule.server, "function")

    const hooks = await pluginModule.server({} as any)
    assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), [
      "novel_check",
      "novel_context",
      "novel_export",
      "novel_guide",
      "novel_init",
      "novel_save_chapter",
      "novel_status",
      "novel_update",
    ])

    const config: Record<string, any> = {
      agent: {
        "novel-writer": { model: "custom/model", options: {}, permission: {} },
      },
    }
    await hooks.config?.(config as any)

    assert.equal(config.agent["novel-planner"].mode, "primary")
    assert.equal(config.agent["novel-writer"].mode, "all")
    assert.equal(config.agent["novel-editor"].mode, "primary")
    // 利用者の model 指定で webfetch: "deny" や bash: "deny" が消えないこと
    assert.equal(config.agent["novel-writer"].model, "custom/model")
    assert.equal(config.agent["novel-writer"].permission.webfetch, "deny")
    assert.equal(config.agent["novel-writer"].permission.bash, "deny")
    assert.equal(config.agent["novel-editor"].permission.bash, "deny")
    assert.equal(config.agent["novel-planner"].permission.bash, "ask")

    const commandNames = Object.keys(config.command ?? {}).sort()
    assert.equal(commandNames.length, 13)
    assert.ok(commandNames.includes("novel-canon"))
    assert.ok(!commandNames.includes("novel-reality"))
    assert.ok(Array.isArray(config.skills?.paths) && config.skills.paths.length === 1)
  })

  test("mergeAgentConfig はネストされた権限キーを保ちつつ利用者指定を優先する", () => {
    const merged = mergeAgentConfig(
      { temperature: 0.7, permission: { edit: "allow", webfetch: "deny" } },
      { model: "test/model", permission: {} },
    )
    assert.equal(merged.model, "test/model")
    assert.equal((merged.permission as any).webfetch, "deny")
  })

  test("将来の MCP 化に向けて src/core と src/tools に @opencode-ai 依存が無い", () => {
    for (const sub of ["core", "tools"]) {
      const dir = join(root, "src", sub)
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".ts")) continue
        const content = readFileSync(join(dir, file), "utf-8")
        assert.ok(!content.includes("@opencode-ai"), `src/${sub}/${file} が @opencode-ai に依存しています`)
      }
    }
  })
})
