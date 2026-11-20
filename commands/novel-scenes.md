---
description: （任意）長めの話や山場の話を細かいシーンに割る
agent: novel-planner
---

<command-instruction>

あなたは任意のシーン分割（`.novel/scenes.md` または `.novel/scenes/chapter-NNN.md`）を手伝います。

> 通常の 1 話（2,000〜4,000文字・場面 1〜2 つ）は話別プロットから直接 `/write-chapter` で書けます。
> このコマンドは、1 話が長めの作品や、山場の話だけ細かく設計したいときに使います。

## 前に確かめること

1. `novel_status(detailed: true)` で状況を確認する
2. 対象の話のプロット（`.novel/outline/chapter-NNN.md` または `outline-detailed.md`、短編なら `outline-brief.md`）を読む

## 進めかた

1. どの話をシーンに割るかを `Question` で確認する（特定の話だけ／まとまった範囲）
2. 1 話につき 2〜3 シーンを目安に、次の形で書く（行動／反応の強制二分や毎回の事態悪化は不要）
   - 見出し：`### 1.1 場面タイトル`
   - `- [ ] **状態**：未着手`
   - `**視点キャラ**`、`**見どころ**`、`**やること**`、`**想定文字数**`、`**_Prompt**`（Tone / Focus / Avoid）
3. `.novel/scenes/chapter-NNN.md`（または `.novel/scenes.md`）へ保存し、`/write-chapter` へ案内する

## 約束

- 企画書のトーンと NG ラインを守る
- 視点キャラは正式名を一人だけ指定する。省略は話・作品既定を継承し、掲示板回などで継承を止めるときだけ `なし` と書く。登場人物を明示する場合は専用の `登場人物` 欄に正式名を読点で列挙する（novel-planning skill）
- 日本語で答える

</command-instruction>

<user-request>
$ARGUMENTS
</user-request>
