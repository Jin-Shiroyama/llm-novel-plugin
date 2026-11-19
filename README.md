# llm-novel-plugin

A light-novel & Japanese web-novel writing plugin for LLM harnesses (OpenCode-first, MCP-ready).

日本語の詳しいドキュメントは [README.ja.md](./README.ja.md) をご覧ください。

## Highlights

- **Entertainment-first workflow**: Built specifically for Japanese light novels and web novels (fantasy, SF, rom-com, slice-of-life, fan fiction) instead of literary/conflict-heavy drama templates.
- **Tone & NG-line guardrails**: Structured `storyMode` (`arc` / `episodic` / `plot` / `short`) and `seriousness` (`light` / `balanced` / `serious`), plus explicit NG-lines injected at high priority on every episode to prevent unwanted angst or preachy moralizing endings.
- **Battle-tested core engine**: Event-sourced per-episode character state diffs, speech-profile tracking (first-person / address terms / politeness), Japanese typography & anti-AI / preachy-ending linter, glossary consistency checks, Kakuyomu / Narou / pixiv ruby conversion, split episode exporter, and dedicated fan-fiction canon management (`.novel/canon/`).
- **Harness-agnostic core**: All tool executors in `src/tools/` accept only `{ projectDir: string }`, keeping OpenCode coupling isolated inside `src/adapters/opencode/` for straightforward future MCP server support.

## Character names and formatting

Character matching uses filenames, explicitly separated names, and aliases written in character sheets. Fill in the aliases field; surname boundaries are no longer guessed. Ambiguous aliases cannot update character state. Existing unambiguous aliases are resolved in memory before replaying state changes.

Saving now checks typography without changing the manuscript by default. Use `novel_save_chapter(autoFix: true)` or `novel_check(fix: true)` to apply safe fixes explicitly. Ruby readings and emphasis boundaries are preserved; ambiguous URL boundaries are reported for manual clarification.

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
