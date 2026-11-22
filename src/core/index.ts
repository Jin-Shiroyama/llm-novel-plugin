/**
 * llm-novel-plugin - ハーネス非依存コアのエントリポイント
 *
 * 将来の MCP サーバーや他ハーネス向けアダプタは、ここからコアロジックを直接インポートできる。
 * ツール実行関数は `llm-novel-plugin/tools`（src/tools/index.ts）からインポートする。
 */

export * from "./constants.js"
export * from "./utils.js"
export * from "./records.js"
export * from "./character-state.js"
export * from "./character-names.js"
export * from "./name-fields.js"
export * from "./pov.js"
export * from "./sections.js"
export * from "./ruby.js"
export * from "./typography.js"
export { analyzeManuscriptLine, classifyLine } from "./text-analysis.js"
export type { LineKind, LineAnalysis } from "./text-analysis.js"
export * from "./prose.js"
export * from "./glossary.js"
export * from "./canon.js"
export * from "./publish.js"
export * from "./doc-sections.js"
export * from "./templates.js"
export * from "./prompts.js"
