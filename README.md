# llm-novel-plugin

A light-novel & Japanese web-novel writing plugin for LLM harnesses (OpenCode-first, MCP-ready).

日本語の詳しいドキュメントは [README.ja.md](./README.ja.md) をご覧ください。

## Highlights

- **Entertainment-first workflow**: Built specifically for Japanese light novels and web novels (fantasy, SF, rom-com, slice-of-life, fan fiction) instead of literary/conflict-heavy drama templates.
- **Tone & NG-line guardrails**: Structured `storyMode` (`arc` / `episodic` / `plot` / `short`) and `seriousness` (`light` / `balanced` / `serious`), plus explicit NG-lines injected at high priority on every episode to prevent unwanted angst or preachy moralizing endings.
- **Battle-tested core engine**: Event-sourced per-episode character state diffs, speech-profile tracking (first-person / address terms / politeness), Japanese typography & anti-AI / preachy-ending linter, glossary consistency checks, Kakuyomu / Narou / pixiv ruby conversion, split episode exporter, and dedicated fan-fiction canon management (`.novel/canon/`).
- **Harness-agnostic core**: All tool executors in `src/tools/` accept only `{ projectDir: string }`, keeping OpenCode coupling isolated inside `src/adapters/opencode/` for straightforward future MCP server support.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check:ja
```

## License

AGPL-3.0-or-later (see [LICENSE](./LICENSE)).
