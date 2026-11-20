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

### 一、資料をそろえ、該当スキルを読み込む
1. `novel_context` を呼ぶ（`chapterNumber` または `section`、特定シーンだけなら `sceneId`）
2. 「書くときの条件」の **参照するスキル** を確認し、`novel-writing` と該当スキル（`genre-fantasy` / `genre-romance` / `genre-slice-of-life` / `genre-sf` / `novel-fanfic`）を読み込む
3. プロジェクトやプロットが未作成なら、ここで止めて `/novel-init` や `/novel-outline` を案内する

### 二、資料の要点を頭に入れる
- この話のプロット（P0）：見どころ、展開ビート、この話で進むもの、引き／オチ
- **作品の核・トーン＆NGライン**：シリアス度と「やらないこと」
- 登場人物の魅力と **🗣️ ことばづかい**（一人称・二人称・呼び方・敬語）
- 現在の状態、前の話の末尾（引きの受け方と語りのテンション）、直近の締め方・繰り返しやすい表現、用語集、伏線、原作の資料（二次創作）

### 三、1 話を通して書く
候補出しや注記を挟まず、本文だけを書き上げます（相談しながら書きたいと頼まれたときだけ候補を出す）。
- `novel_context` の「✍️ 書くときの条件」（分量目安・視点・トーン方針・文体見本・字下げ）と、`novel-writing` skill・該当ジャンルスキルの方針に従う
- 企画書の NG ラインとキャラの「🗣️ ことばづかい」を厳守し、二次創作は `novel-fanfic` skill を守る
- **保存前のセルフチェック**：プロット（P0）の見どころ・展開ビート・ごほうびが描けているか、話末の引き／オチが直近の話と被らず気持ちよく決まっているかを確認してから保存する

### 四、保存して機械点検を通す
```
novel_save_chapter(chapterNumber: {N}, title: "サブタイトル", content: "本文（見出し行を含めない）")
```
- 保存結果の点検を確認します。自動整形は `autoFix` が有効な場合に適用します（省略時の動作はツールの引数説明、規則は novel-writing skill を参照）
- 保存結果の「📝 表記」に ❌ がある場合は `novel_check` で確認して直し、保存し直す
- 「✍️ 文章」に ⚠️ が出ていれば箇所を確認し、AI定型・教訓まとめ・話末の定型締め・話またぎ重複を優先してキャラの反応・動作・語り手の声で書き直す（**⚠️ を 0 件にすることが目的ではなく、文体見本やトーンに合う長文・表現は無理に直さず残してよい**。保存し直しは最大 2 回まで）

### 五、記録を更新する（JSON を Edit で直接書き換えない）
1. `novel_update(action: "character-state", chapterNumber: {N}, ...)`（変化が無ければ `{"updates": []}`。呼び方や一人称が変わったら `speech` に記録）
2. `novel_update(action: "summary", chapterNumber: {N}, ...)`（この話だけのあらすじ 300〜500 文字。「全体の流れ」更新の ⚠️ が出ていれば `## 全体の流れ` も更新）
3. `novel_update(action: "foreshadow", chapterNumber: {N}, ...)`（伏線を張った・回収したとき）
4. 任意でシーン一覧を作っている話なら、書いたシーンを `[x]` に直す

### 六、短く報告する
タイトル、文字数（目安との比較）、保存先、見どころ・引き（1行）、表記・文章チェック結果、更新した記録、気づいた点（あれば 3 点まで）、次のおすすめコマンド（`/write-chapter {N+1}` または `/write-chapters next 3`）を簡潔に返します。

</command-instruction>

<user-request>
$ARGUMENTS
</user-request>
