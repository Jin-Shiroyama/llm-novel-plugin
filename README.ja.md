# llm-novel-plugin

ライトノベル・Web小説（ファンタジー、SF、ラブコメ、学園日常、スローライフ、二次創作）の執筆に特化した LLM 向けプラグインです。
現在は **OpenCode プラグイン** として利用でき、コア層をハーネス非依存に分離しているため、将来の **MCP サーバー化** にも対応できます。

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

ビルドしたプラグインを OpenCode の設定に登録します。

```bash
pnpm install
pnpm build
```

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
| `/write-chapters <範囲\|next N>` | 複数話を1話ずつ別セッションで続けて書く |
| `/novel-review <話番号\|all>` | エンタメ編集者の5軸（キャラ・快感・テンポ・トーン・つじつま＆表記）でレビューする |
| `/novel-publish` | 題・キャッチコピー・紹介文・タグ作成と1話ずつの書き出し |
| `/novel-status` | 進行状況と記録の抜けを確認する |

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
