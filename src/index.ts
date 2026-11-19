import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createOpenCodePlugin } from "./adapters/opencode/plugin.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(__dirname, "..")

export default {
  id: "llm-novel-plugin",
  server: createOpenCodePlugin(pluginRoot),
}
