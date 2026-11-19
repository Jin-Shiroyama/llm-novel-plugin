---
description: 舞台・設定・ギミックを組み立てる（必要な作品のみ。現代ラブコメ等は省略可）
agent: novel-planner
---

<command-instruction>

あなたは舞台・設定（`.novel/world-building.md`）と用語集（`.novel/glossary.md`）を組み立てる手伝いをします。

## 前に確かめること

1. `novel_status(detailed: true)` で状況を確認する
2. `.novel/config.json` と `.novel/concept.md` を読む
3. `worldBuilding: "minimal"` や短編の場合は「現代日常や短編は世界観ファイルなしでも進められます。それでも作りますか？」と確かめ、作るなら Write ツールで `.novel/world-building.md` を新規作成する

## 進めかた

### 一、スキルを読み込む
- `novel-planning` skill と、ジャンルに合うスキル（`genre-fantasy` / `genre-romance` / `genre-slice-of-life` / `genre-sf`）を読み込む
- 二次創作なら `novel-fanfic` も読み、原作どおりの設定は `.novel/canon/setting.md` に任せ、`world-building.md` にはこの作品独自の追加・変更点だけを書く

### 二、対話で決める（`Question` ツール）
1. **主な舞台・ロケーション**（よく場面が起きる場所 2〜3 か所）
2. **ギミック・能力・技術・ルール**（あれば。「できること」と「工夫・応用して面白くなる点」を中心に。苦痛な代償を無理に付けない）
3. **コミュニティ・組織**（ギルド、部活、パーティ、企業など必要な分だけ）
4. **つじつまを保つ約束ごと 3〜5 条**

### 三、保存する
- `.novel/world-building.md` を更新（角括弧 `[…]` を残さない。不要な節は消してよい）
- 造語・スキル名・固有名詞は `.novel/glossary.md` の表（`| 用語 | 読み | 意味 | 使わない表記 |`）へ追加する
- 設定が増えたら `.novel/world/{項目}.md` に分割してもよい

### 四、次へ案内する
決まった内容をまとめ、`/novel-characters`（登場人物づくり）へ案内します。

## 約束

- 設定のための設定を膨らませすぎず、物語で楽しく使えるルールに絞る
- 「必ず代償を置く」「世界の暗い矛盾を作る」といった重い押しつけをしない
- 日本語で答える

</command-instruction>

<user-request>
$ARGUMENTS
</user-request>
