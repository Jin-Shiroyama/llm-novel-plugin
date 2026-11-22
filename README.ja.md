# llm-novel-plugin

ライトノベル・Web小説（ファンタジー、SF、ラブコメ、学園日常、スローライフ、二次創作）の執筆に特化した LLM 向けプラグインです。
現在は **OpenCode プラグイン** として利用できます。ツール実行層（`./tools`）とコア層（`./core`）をハーネス非依存に分離しているため、将来の **MCP サーバー化** にも対応できる設計です（コマンド・スキル・エージェントの進行定義は現在 OpenCode 向け）。

## 主な特徴

- **エンタメ・ラノベ特化の企画とプロット**
  - 「学ぶべきテーマ」や「対立・ジレンマ」を押しつけず、**フック（売り）・読者体験の柱・キャラの魅力と掛け合い・トーン＆NG ライン** を軸に設計します。
  - 構成の型（`storyMode`）を `arc`（10〜15話アーク連載）／`episodic`（ラブコメ・日常イベント）／`plot`（文庫1巻完結）／`short`（短編）から選べます。
  - `seriousness`（`light` / `balanced` / `serious`）と企画書の **NG ライン** を毎話 `novel_context` の最優先枠に載せることで、勝手なシリアス化や説教くさい教訓まとめを防ぎます。
- **最短 3 ステップで執筆開始**
  - ラブコメ・学園日常・短編では世界観工程をスキップ可能（`worldBuilding: "minimal"`）。
  - シーン分割も任意のため、話別プロットからすぐ本文執筆に入れます。
- **長編・Web 連載を支える堅牢な管理エンジン**
  - **ことばづかい追跡**：キャラの一人称・二人称・敬語・相手ごとの呼び方を毎話自動抽出し、途中の呼び方変化も差分記録（`state.json`）で引き継ぎます。
  - **表記・反 AI・教訓まとめチェッカー**：会話句点・三点リーダ・ダッシュ・感嘆符空白・字下げ（全角1字下げ／Web小説の字下げなし両対応）・用語集の禁止表記・AI定型句・教訓まとめを自動点検。ステータス画面・掲示板回・配信回・チャット書式にも対応しています。
  - **二次創作（`.novel/canon/`）**：原作の事実をモデルの記憶で補わず、手元の資料を正本として毎話注入・照合できます。
  - **投稿サイト向け書き出し**：カクヨム・小説家になろう・pixiv・青空文庫・HTML へのルビ変換、1話ずつの分割書き出し（`split: true`）と `index.txt` 生成、カクヨムのキャッチコピー文字数・タグ数チェックに対応。
- **ジャンル特化スキル（オンデマンド読み込み）**
  - 共通：`novel-planning` / `novel-writing` / `novel-editing`
  - ジャンル別：`genre-fantasy` / `genre-romance` / `genre-slice-of-life` / `genre-sf` / `novel-fanfic`

## 導入と使い方（OpenCode）

ビルドしたプラグインを OpenCode の設定（`opencode.json`）に登録します。

```bash
pnpm install
pnpm build
```

- `package.json` に `prepare` スクリプトを同梱しているため、リポジトリ直下での `pnpm install`（または `npm install`）時に `dist/` もビルドされます。別プロジェクトの依存として git 経由で導入した場合、pnpm 10 以降のように依存パッケージのビルドスクリプトが既定で無効な環境では自動実行されないため、`pnpm approve-builds` で許可するか手動で `pnpm build` を実行してください。

`opencode.json` の設定例（ビルド済みローカルファイルで読み込む場合）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/llm-novel-plugin/dist/index.js"],
  "agent": {
    "novel-writer": {
      "model": "<provider>/<writer-model>"
    },
    "novel-editor": {
      "model": "<provider>/<editor-model>"
    }
  }
}
```

- **書き手（`novel-writer`）と編集者（`novel-editor`）には別のモデルを割り当てることをおすすめします**。同じモデルで書いた本文を自分で点検すると評価が甘くなりがちなため、`/novel-review` や `/write-chapters --revise` で別モデルの視点を入れると品質が安定します。
- `plugin` にはビルド後のエントリポイント（`dist/index.js`）までの `file://` パスを指定してください（環境や OpenCode のバージョンにより記法が異なる場合は公式ドキュメントをご確認ください）。
- 既定の権限では `novel-writer` / `novel-editor` の `bash` は `deny`、`novel-planner` は `ask` に設定されています。`git` などを使いたい場合は `opencode.json` の `agent.<name>.permission.bash` で上書きできます。

主なスラッシュコマンド：

| コマンド | 用途 |
|---|---|
| `/novel-init [タイトル]` | 作品プロジェクトを対話で立ち上げる |
| `/novel-canon` | （二次創作）原作の資料を `.novel/canon/` に整える |
| `/novel-concept` | 企画書（フック・面白さの柱・お約束とひとひねり・トーン＆NGライン）を固める |
| `/novel-world` | （必要な作品のみ）舞台・設定・ギミック・用語集を組み立てる |
| `/novel-characters` | キャラの魅力・ギャップ・掛け合い・ことばづかい・関係性マップを作る |
| `/novel-outline` | プロット概要と話別プロットを作る |
| `/novel-scenes` | （任意）長めの話や山場だけシーンに割る |
| `/write-chapter <話番号>` | 1話を書き上げ、保存・点検・記録更新まで完了する |
| `/write-chapters <範囲\|next N> [--review-every=N] [--revise]` | 複数話を1話ずつ別セッションで続けて書く（`--revise` で編集者講評＋必要時最大1回リライト） |
| `/novel-review <話番号\|all>` | エンタメ編集者の5軸（キャラ・快感・テンポ・トーン・つじつま＆表記）でレビューする |
| `/novel-publish` | 題・キャッチコピー・紹介文・タグ作成と1話ずつの書き出し |
| `/novel-status` | 進行状況と記録の抜けを確認する |

## 人物名と表記の自動整形

- 人物名はファイル名・名前欄の明示的な区切り・呼称欄を使って照合します。姓名を文字数で推測しないため、呼称欄に本文で使う姓・名・あだ名を記入してください（未記入は `/novel-status` で確認できます）。
- 状態更新は一意に特定できる正式名へ統一します。兄妹の共通の姓など、曖昧な呼称での更新は保存せず候補を示します。既存の名前の揺れは読み込み時に解決し、元データを一括で書き換えません。
- 保存時は安全な表記修正を既定で自動整形します（整形せずに保存する場合は `novel_save_chapter(autoFix: false)`、既存ファイルの一括整形は `novel_check(fix: true)` を指定してください）。保存済み本文の小規模な手直しには `novel_save_chapter(..., edits: [{ from, to }])` を使うと、全文を出力し直さずに旧稿退避・自動整形・点検を通せます。
- 傍点の対象範囲とルビの読みを保持します。裸の URL と日本語の境界が曖昧な場合は整形を見送り、URL を空白や `<...>` で区切るよう案内します。

## 開発・テスト

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm check:ja
```

## ライセンス

`AGPL-3.0-or-later`（[LICENSE](./LICENSE) を参照）。
本プロジェクトのデータ管理・検証・書き出しエンジン層は [opencode-novel-plugin](https://github.com/Jin-Shiroyama/opencode-novel-plugin)（上流: [wmzy/opencode-novel-plugin](https://github.com/wmzy/opencode-novel-plugin)）の成果を継承し、ライトノベル・Web小説特化およびハーネス非依存アーキテクチャへ全面刷新したものです。
