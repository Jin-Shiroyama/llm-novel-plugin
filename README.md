# llm-novel-plugin

A light-novel & Japanese web-novel writing plugin for LLM harnesses (OpenCode-first, MCP-ready).

日本語の詳しいドキュメントは [README.ja.md](./README.ja.md) をご覧ください。

## Highlights

- **Entertainment-first workflow**: Built specifically for Japanese light novels and web novels (fantasy, SF, rom-com, slice-of-life, fan fiction) instead of literary/conflict-heavy drama templates.
- **Tone & NG-line guardrails**: Structured `storyMode` (`arc` / `episodic` / `plot` / `short`) and `seriousness` (`light` / `balanced` / `serious`), plus explicit NG-lines injected at high priority on every episode to prevent unwanted angst or preachy moralizing endings.
- **Structured core engine**: Event-sourced per-episode character state diffs, speech-profile tracking (first-person / address terms / politeness), Japanese typography & anti-AI / preachy-ending linter, glossary consistency checks, Kakuyomu / Narou / pixiv ruby conversion, split episode exporter, and dedicated fan-fiction canon management (`.novel/canon/`).
- **Harness-agnostic tool/core layer**: All 8 tool executors in `src/tools/` (exported via `./tools`) accept only `{ projectDir: string }`, keeping OpenCode coupling isolated inside `src/adapters/opencode/` so the tool layer can back a future MCP server (commands, skills, and agent workflows are currently tailored for OpenCode).
- **Cross-model review ready**: Assign a different model to `novel-editor` than `novel-writer` in `opencode.json` to reduce self-evaluation bias during `/novel-review` and `/write-chapters --revise`.

## Character names and formatting

Character matching uses filenames, explicitly separated names, and aliases written in character sheets. Fill in the aliases field; surname boundaries are no longer guessed. Ambiguous aliases cannot update character state. Existing unambiguous aliases are resolved in memory before replaying state changes.

Saving applies safe typography fixes by default (`novel_save_chapter(autoFix: false)` to skip auto-fix, `novel_check(fix: true)` for existing chapters). For small revisions to an already saved chapter, pass `edits: [{ from, to }]` to `novel_save_chapter` to keep draft backup, auto-fix, and checks without re-emitting the whole chapter. Ruby readings and emphasis boundaries are preserved; ambiguous URL boundaries are reported for manual clarification.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check:ja
```

> Note: `package.json` includes a `prepare` script that builds `dist/` during a local `pnpm install` / `npm install`. When installed as a git dependency from another project with a package manager that disables dependency build scripts by default (such as pnpm 10+), approve the build (`pnpm approve-builds`) or run `pnpm build` manually.

## License

AGPL-3.0-or-later (see [LICENSE](./LICENSE)).
