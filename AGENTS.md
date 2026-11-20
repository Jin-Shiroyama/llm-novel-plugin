# llm-novel-plugin — ライトノベル・Web小説特化の執筆支援プラグイン

## 概要

ライトノベル・Web小説（異世界・現代ファンタジー、SF、ラブコメ、学園日常、スローライフ、二次創作）の執筆に特化したプラグインです。
OpenCode プラグインとしてすぐに動作しつつ、コアロジックとツール関数をハーネス非依存（`{ projectDir }` のみ受け取る設計）に分離しており、将来の MCP サーバー化にも対応できる構成です。

### 設計思想（v2 刷新の柱）

- **「対立・教訓テーマ駆動」から「フック・読者体験・キャラ掛け合い駆動」へ**：
  企画書（`concept.md`）は「フック」「面白さの柱（ワクワク／ニヤニヤ／スカッと／知的興奮）」「お約束とひとひねり」「トーンと NG ライン」を軸にし、頼まれていないシリアス化・重い過去・説教くさい教訓まとめを構造レベルで防ぎます。
- **軽量で柔軟な工程**：
  ラブコメ・学園・日常・短編では `worldBuilding: "minimal"` により世界観工程をスキップでき、シーン分割も任意です。最短「企画 → キャラ → プロット → 第1話執筆」で書き始められます。
- **正本の一元化（Single Source of Truth）**：
  エージェントプロンプトはスリムに保ち、執筆メソッド・ジャンル別のコツ・作例はすべて `skills/` に集約しています。
- **二次創作（`.novel/canon/`）を第一級機能として維持**：
  原作の事実はモデルの記憶で埋めず、書き手が確認した資料を正本として毎話注入・照合します。

## ディレクトリ構成

```
llm-novel-plugin/
├── src/
│   ├── index.ts                          # OpenCode プラグイン入口（{ id, server }）
│   ├── core/                             # ハーネス非依存コアエンジン
│   │   ├── index.ts                      # コア＆ツール関数の公開入口（将来の MCP 層が参照）
│   │   ├── constants.ts                  # 既定値・構成型・シリアス度・ジャンル判定キーワード
│   │   ├── utils.ts                      # パス・ファイル・進行判定・ジャンル推定・文字数・キャラ照合
│   │   ├── records.ts                    # 記録検証（character-state / foreshadow / summary）
│   │   ├── character-state.ts            # 人物状態の章・節ごと差分管理
│   │   ├── sections.ts                   # プロローグ・幕間・エピローグ・部
│   │   ├── ruby.ts                       # ルビ・傍点の解析と投稿先別変換
│   │   ├── typography.ts                 # 表記点検（indent: fullwidth / none 対応）
│   │   ├── prose.ts                      # 反AI＋教訓まとめ（preachy-ending）点検
│   │   ├── glossary.ts                   # 用語集の読み込み・動的抽出・禁止表記点検
│   │   ├── canon.ts                      # 二次創作の原作資料（.novel/canon/）
│   │   ├── publish.ts                    # 投稿情報（publish.md）の文字数・タグ数点検
│   │   ├── doc-sections.ts               # 企画書・舞台設定の優先枠配分
│   │   ├── templates.ts                  # 文書雛形（Markdown / JSON）
│   │   └── prompts.ts                    # RTCO プロンプト集
│   ├── tools/                            # ハーネス非依存ツール実行関数（{ projectDir }）
│   │   ├── types.ts                      # ToolRuntimeContext = { projectDir: string }
│   │   ├── init.ts                       # novel_init
│   │   ├── status.ts                     # novel_status
│   │   ├── context.ts                    # novel_context
│   │   ├── save.ts                       # novel_save_chapter
│   │   ├── track.ts                      # novel_update
│   │   ├── check.ts                      # novel_check
│   │   ├── export.ts                     # novel_export
│   │   └── guide.ts                      # novel_guide
│   └── adapters/
│       └── opencode/                     # OpenCode 専用の薄い接続層
│           ├── plugin.ts                 # ツール・エージェント・コマンド・スキル登録
│           ├── commands.ts               # commands/*.md ローダー
│           ├── agent-config.ts           # opencode.json 設定マージ
│           └── agents/
│               ├── novel-planner.ts      # 企画・構成コーチ
│               ├── novel-writer.ts       # 本文書き手
│               └── novel-editor.ts       # エンタメ担当編集者
├── commands/                             # OpenCode スラッシュコマンド（13本）
├── skills/                               # ハーネス非依存 Agent Skills（8本）
│   ├── novel-planning/                   # 企画・キャラ・プロットの正本
│   ├── novel-writing/                    # 表記規約・反AI・語り・特殊書式・投稿準備の正本
│   ├── novel-editing/                    # エンタメ編集者の点検観点・リライトの正本
│   ├── genre-fantasy/                    # 異世界・現代ファンタジー特化
│   ├── genre-romance/                    # 恋愛・ラブコメ・いちゃラブ特化
│   ├── genre-slice-of-life/              # 日常系・コメディ・スローライフ特化
│   ├── genre-sf/                         # SF・近未来・アイデア小説特化
│   └── novel-fanfic/                     # 二次創作（原作資料・照合・権利と規約）
├── scripts/
│   └── check-japanese.mjs                # 簡体字・中国語残存チェック
└── test-src/                             # テスト（node:test）
```

## 作品データ（`.novel/`）

```
.novel/
├── config.json              # 作品設定（genre / storyMode / tone / seriousness / worldBuilding / indent / serial / sourceWork / parts / limits）
├── concept.md               # 作品企画書（フック・面白さの柱・お約束とひとひねり・トーン＆NGライン・文体）
├── world-building.md        # 舞台・設定（worldBuilding: "standard" のとき作成。world/{項目}.md に分割可）
├── glossary.md              # 用語集（用語｜読み｜意味｜使わない表記）
├── characters/
│   ├── profiles.md          # 一覧・関係性マップ・掛け合いの組み合わせ
│   ├── {キャラクター名}.md   # 個別キャラシート（魅力とキャラ立ち・ことばづかい・相手ごとの呼び方）
│   └── state.json           # 話・節ごとの状態差分
├── outline-brief.md         # プロット概要（arc / episodic / plot / short）
├── outline-detailed.md      # 話別プロット（outline/chapter-001.md に分割可）
├── scenes.md                # シーン一覧（任意。scenes/chapter-001.md に分割可）
├── summary.md               # これまでのあらすじ（話ごとの節＋全体の流れ）
├── foreshadow.json          # 伏線
├── publish.md               # 投稿用の情報（題・キャッチコピー・紹介文・タグ）
├── export/                  # 書き出し先（episodes/ は1話ずつ分割書き出し）
├── canon/                   # 二次創作の原作資料（sourceWork があるとき）
│   ├── overview.md
│   ├── timeline.md
│   ├── setting.md
│   └── characters/{名前}.md
├── chapters/                # 本文（prologue.md / chapter-001.md / interlude-001-1.md / epilogue.md）
└── drafts/                  # 上書き保存時の旧稿バックアップ
```

## 開発・検証コマンド

```bash
pnpm install
pnpm typecheck   # 型検査
pnpm test        # node:test 実行
pnpm build       # dist/ ビルド
pnpm check:ja    # 簡体字・中国語残存チェック
```

## 重要な決めごと

- `src/index.ts` は OpenCode プラグインオブジェクト `{ id, server }` のみを default export する（余計な named export をしない）。
- `src/tools/*.ts` は `ToolRuntimeContext`（`{ projectDir: string }`）のみを受け取り、`@opencode-ai/plugin` に依存しない。
- `skills/*/SKILL.md` 内の ` ```text ` 作例はすべて `checkTypography`（規約違反 0 件）と `checkProse`（検出 0 件）を通過することをテストで保証する。
- `novel_context` は `concept.md` のフック・面白さ・トーン・NG ラインに優先枠を割り当て、毎話必ず注入する。
- `novel_export` の既定単位は `"話"`（`第1話　タイトル`・算用数字）、`split: true` で投稿サイト向けの 1 話分割書き出し＋`index.txt` を出力する。

## 人物名と表記の仕様

- 人物名は正式名（シートのファイル名）・名前欄の明示的な区切り・呼称欄だけで照合する。文字数や文字種で姓名を推測しない。
- 出現判定と同一人物の解決を分離する。状態更新は正式名へ統一し、複数人物に当たる呼称での更新はバッチ全体を拒否する。
- 既存の名前の揺れは差分適用前に読み込み側で解決する。更新対象でない節の名前は書き換えない。
- 人物資料は任意の視点人物・明示された登場人物、当話の強い一致・弱い一致、前の節の強い一致・弱い一致、人物一覧の順に枠を配分する。視点はシーン → 話・節 → defaultPovCharacter の順に継承し、`なし` で停止する。
- 呼称はキャラ作成時に必須として案内する。未記入でも作品を読み込めるが、`novel_status` で通知する。
- 自動整形の規則と有効化条件を分離する。実装・ツール説明の既定値は `DEFAULT_AUTO_FIX` を参照し、有効な場合に点検結果の修正案を適用する。未収束時は原文を返してそのファイルの保存を止める。
- 詳細と互換性は `docs/specs/character-name-matching.md`、`docs/specs/typography-autofix.md`、`docs/specs/pov-context.md` を参照する。

## 残る制約

- 明記された1文字の呼称（例：栞）も普通名詞と一致し得る。文章中の出現は弱い根拠として扱い、状態更新には完全一致で一意に解決できる名前だけを使う。
- 裸の URL と後続の日本語の境界は文字列だけで決められない。曖昧な範囲は自動整形せず、明示的な区切りを案内する。
