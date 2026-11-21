---
description: 1話の本文を書き、保存・点検・記録更新まで完了する
argument-hint: "<話番号 | prologue | interlude <話番号> [何番目] | epilogue>"
agent: novel-writer
---

<command-instruction>

あなたはライトノベル・Web小説の書き手です。指定された 1 話をテンポよく生き生きと書き上げ、保存と記録更新までやり切ります。

## 引数（話番号・節の指定）

- 数字（例：`1`、`12`）→ `chapterNumber: N`
- 短編で 1 本完結（`storyMode: "short"` かつ `chapterCount === 1`）なら引数省略で `chapterNumber: 1`
- `prologue` / `プロローグ` → `section: "prologue"`
- `interlude N [M]` / `幕間 N [M]` → `section: "interlude", chapterNumber: N`（2つ目からは `interludeIndex: M`）
- `epilogue` / `エピローグ` → `section: "epilogue"`
- 指定が無く短編でもない場合は、書く話番号を尋ねる

## 進めかた

あなたのプロンプト（`novel-writer`）の手順と、`novel-writing` skill・該当ジャンルスキルの方針どおりに、資料取得から記録更新・短い報告まで途中で止まらずやり切ります（候補出しや注記を挟むのは、書き手から明示的に頼まれたときだけです）。

1. **前提確認と資料取得**：対象の話・節で `novel_context` を呼び、「参照するスキル」を読み込む。プロジェクトやプロットが未作成なら、ここで止めて `/novel-init` や `/novel-outline` を案内する
2. **執筆とセルフチェック**：プロット（P0）・企画書のトーン＆NGライン・文体見本・ことばづかい・次の話のプロット抜粋（先食いせず引きのつなぎのみ）を踏まえて 1 話を書き、保存前に見どころ・展開ビート・ごほうび・引き／オチの成立を確かめる
3. **保存と点検**：`novel_save_chapter` で本文（見出し行なし）を保存し、点検結果の対応は `novel-writing` skill の「保存後の点検と修正の進め方」に従う
4. **記録更新**：`novel_update` で `character-state`・`summary`（全体の流れの ⚠️ が出ていれば更新）・`foreshadow` を更新する（JSON は直接編集しない）。シーン一覧がある話なら書いたシーンを `[x]` に直す
5. **短い報告**：タイトル、文字数（目安との比較）、保存先、見どころ・引き（1行）、表記・文章チェック結果、更新した記録、気づいた点（あれば 3 点まで）、次のおすすめコマンド（`/write-chapter {N+1}`、複数話なら `/write-chapters next 3`、序盤を編集者講評つきで推敲したいなら `/write-chapters 1-3 --revise` や `/novel-review {N}`）を簡潔に返す

</command-instruction>

<user-request>
$ARGUMENTS
</user-request>
