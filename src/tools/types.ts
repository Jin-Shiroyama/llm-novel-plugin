/**
 * ハーネス非依存のツール実行コンテキスト。
 *
 * OpenCode や将来の MCP サーバーなど、どのハーネスからも
 * `{ projectDir }` を渡すだけで全ツールを実行できる。
 */
export interface ToolRuntimeContext {
  /** 作品データ（.novel/）を置くプロジェクトのルートディレクトリ */
  projectDir: string
}
