# 執筆品質の評価手順（半自動ベンチマーク＆ブラインド読み比べ）

`llm-novel-plugin` のスキル・プロンプト・ツールを変更した際、単体テスト（整形・照合の正しさ）だけでは「実際に書かれた小説が面白いか」「平坦化やトーン逸脱が起きていないか」を測れません。
この手順書では、`examples/` の見本作品を使って変更前後を同じ条件で比較する進め方（**半自動評価ランナーによる日常計測**と、**大きな節目での人間ブラインド読み比べ**）を定めます。

---

## 1. 見本作品（`examples/`）

| ディレクトリ | ジャンル・構成 | トーン・設定 | 主な確認ポイント |
|---|---|---|---|
| `examples/romcom-light/` | ラブコメ（`episodic`） | `light` / `worldBuilding: "minimal"` / `indent: "none"` | 軽快な掛け合い、照れ隠しによる一拍の溜め→ニヤニヤの見返り、重い過去・教訓まとめの非混入、字下げなし規約 |
| `examples/fantasy-balanced/` | 異世界ファンタジー（`arc`） | `balanced` / `worldBuilding: "standard"` / `indent: "fullwidth"` | 能力の制約と工夫による溜め→スカッと見返り、ごほうび場面の厚み、用語集・伏線（F1）・世界観ルールの整合、全角1字下げ規約 |

いずれも企画書（文体見本あり）・登場人物（呼称・ことばづかい完備）・プロット概要・第1〜4話の話別プロットが記入済みで、すぐに第1話から執筆を始められる状態（`writing` 段階）です。

> **重要**：`examples/` 内で直接執筆を実行すると見本データが汚れてしまいます。半自動評価ランナーは自動的に `.eval-runs/` 配下へ一時コピーして実行します。手動で試す場合も必ず別ディレクトリへコピーしてください。

---

## 2. 半自動評価ランナー（`scripts/eval-runner.mjs`）

OpenCode ハーネスを通さずに、対象版（`--plugin-root`）のツール関数・書き手プロンプト（`createNovelWriterAgent()`）・スキル本文と OpenAI 互換 API（OpenAI / OpenRouter / LiteLLM 等）を直接呼び出し、第1〜3話の執筆・記録更新（`character-state` / `summary` / `foreshadow`）・機械指標集計・位置スワップ付き LLM ペア比較を行います。

### 本番（OpenCode）との再現差（必ず意識する点）

- 半自動評価ランナーは **「1 パス執筆＋ランナーによる保存・記録更新」** です。OpenCode 上での `novel_check` 確認 → `edits` 部分修正ループ（最大 2 回）やツールの自律操作は再現されません。
- そのため、本ランナーは **「プロンプト・スキル・資料注入の素の効き目（初回出力の質）」を低コストで A/B 比較する用途** に使います。大きな変更の最終確認では、後述の OpenCode 上でのエンドツーエンド比較も併用します。

### 基本コマンド

```bash
# 事前に比較対象のプラグインをビルドしておく
pnpm build

# 1) 実行（出力は .eval-runs/<timestamp>-<label>/ へ保存）
node scripts/eval-runner.mjs run \
  --label baseline-a \
  --runs 2 \
  --writer-model <provider/writer-model> \
  --max-calls 60

# 2) 既存の run または OpenCode 手動実行ディレクトリの機械指標を再集計
node scripts/eval-runner.mjs metrics .eval-runs/<runDir>

# 3) 2つの run を比較（機械指標の差分＋位置入れ替え2回の LLM ペア審査）
# ※ 自己評価バイアスを避けるため、審査モデル（--judge-model）は書き手と別モデルを推奨
node scripts/eval-runner.mjs compare \
  .eval-runs/<runDirA> \
  .eval-runs/<runDirB> \
  --judge-model <provider/judge-model> \
  --criteria improve
```

### 主なオプションと安全ガード

- **`--plugin-root <dir>`**：旧コミットの worktree 等を指定し、その版の `dist/tools/*.js`・`novel-writer` プロンプト・`prompts.js`・`records.js`・`skills/` を丸ごと読み込む（`context.ts` などコード側変更の新旧比較に使用）。なお、機械指標の採点自体は基準をそろえるため常に最新リポジトリの `dist/core/*` で統一計測します。
- **ビルドし忘れ検知＆成果物指紋**：`src/` の更新時刻が `dist/` より新しい場合は API 呼び出し前に自動停止して `pnpm build` を案内します（意図的にそのまま測る場合のみ `--allow-stale-dist`）。また `meta.json` に `dist/` と `skills/` の全ファイル SHA-256 指紋を記録し、`compare` で「コミットが異なるのに指紋が一致（ビルドし忘れ疑い）」「A/A 条件なのに指紋が異なる」といった不整合を自動警告します。
- **`--runs <N>`**：各見本あたりの試行数（既定 `2`。Phase 3-2 の `simplify` 検証・Phase 4 の `improve` 検証ではどちらも **`--runs 3`** ＝ 6 ペアを推奨）。
- **費用・暴走防止と障害耐性**：`--max-calls`（既定 `60`）、`--max-total-tokens`、`--max-cost-usd`（`--input-price-per-1m` / `--output-price-per-1m` と併用）、`--timeout-ms`（既定 `180000` ms。`--writer-timeout-ms` / `--judge-timeout-ms` で個別指定可）。HTTP 429・5xx・タイムアウト等の API 一時障害は待機後に最大 2 回自動再試行し、執筆形式エラー・空応答・`novel_update` の `❌` 戻り値による 1 回再試行とあわせてすべて予算計上します（失敗呼び出しのモデル名は `responseModels` へ混入させません）。空応答は形式違反と別カウントし、再試行時に空の `assistant` メッセージを履歴へ積まず送り直します。また書き手・審査役とも各試行の `finish_reason`・出力文字数・トークン数を `execution.json` / `comparison.json` に記録し、`finish_reason=length` で空応答になった場合は `--*-max-tokens` / `--*-extra-body` の見直しを促します。予算上限到達や API エラーなど **外部要因で途中停止した試行だけ** を未完了（`incompleteRuns`）として `metrics`・`compare` から除外し、完了済み試行を `meta.json`・`summary.json`・`summary.md` に保存して安全停止します（外部中断は執筆失敗話数へ加算しません）。一方、**書き手の形式検証 2 回失敗・空応答 2 回失敗・保存 `❌` など内容起因の失敗** は生存バイアスを防ぐため比較から除外せず、欠落話数（`missingChapters`）として不利に計上します。
- **推論系モデル向け**：`--writer-temperature omit` / `--judge-temperature omit` でリクエストから `temperature` を完全除外、`--writer-extra-body '{"max_completion_tokens":4096}'` 等でモデル固有パラメータを指定できます。
- **オフライン検証**：`--dry-run` で API を呼ばずに全パイプラインを検証できます。
- **条件差の自動警告**：各 run の `meta.json` に git commit・未コミット変更の有無（`dirty`）・`dist/`/`skills/` 指紋・書き手モデル／生成設定・応答の `model`・システムプロンプト SHA-256 ハッシュ・失敗話数と再試行回数を記録します。`compare` は書き手設定まで含めて一致したときのみ A/A テスト条件とみなし、モデルや生成設定が異なる場合は「モデル／設定比較（採否判定は参考扱い）」として区別します。**ベースラインおよび比較計測は、必ず未コミット変更の無いクリーンなコミット上で実施してください。**

---

## 3. 事前採否基準（Decision Rules）

結果を見てから基準を動かすのを防ぐため、比較の目的ごとに次の 2 種類の基準を事前に固定します。

### 共通の必須条件（機械指標のリグレッション禁止）

- 表記 ❌ の合計が増加していないこと（基準：0 件維持）
- 執筆・保存失敗による欠落話数（`missingChaptersTotal`）が増加していないこと（基準：0 話維持）
- 記録警告（`novel_status` の ⚠️）が増加していないこと（基準：0 件維持）
- **書けた話の文字数ズレ（絶対値平均）が A より +8.0 ポイント以上悪化していないこと**
  - 平均は run ごとの平均を再平均せず、全試行の「書けた話（`!missing`）」をすべてまとめて計算する（欠落話は `missingChaptersTotal` 側で厳密判定し、二重計上しない）。
  - 文字数目安（±15%）の逸脱話数は境界での揺れが大きいため参考表示のみとし、判定には使わない。
  - `+8.0pt` は 2 試行ずつの A/A データから出した概算（同一 run 内の相関を考慮すると独立仮定より実効誤判定率はやや高めに出る）のため、**Phase 3-2 の `default` 側実測値（`--runs 3`）で再確認し、必要に応じ見直す**。

### A. 改善変更の基準（`--criteria improve`：トーン指針の肯定形化など）

出力の質を上げる目的の変更に適用します（既定 **`--runs 3`** ＝ 2 作品 × 3 試行 ＝ **6 ペア** を推奨）。

- 上記の共通必須条件を満たすこと
- 狙った主軸（例：`buildup_and_payoff`）で **全ペアの 75% 以上勝利**（6 ペアなら **5 勝以上**、4 ペアなら 3 勝以上）
- 安全軸 **`tone_and_ng` で負け越していないこと**（B の勝数 ≥ A の勝数。※後述の `d = 0%` は GLM 審査時の値のため、**審査モデルを替えた場合は必ず A/A で `tone_and_ng` の確定率 `d` を確かめ直す**）
- 基準に届かない場合は **「差なし（現状維持）」** として見送る

### B. 簡素化変更の基準（`--criteria simplify`：スキル削減・禁止語リスト削除など）

スキルを短く簡素にする目的の変更には **対称な 75% 却下基準による非劣性（「明確な悪化がなければ採用」）** を適用します（こちらも **`--runs 3`** ＝ **6 ペア** を推奨）。

- 上記の共通必須条件を満たすこと
- **文章 ⚠️ 密度（件 / 1,000 字）の悪化が +20% 以内**（下限余裕 +0.3 件 / 1,000 字）かつ、**できあいの言い回し（`stock-phrase`）密度の悪化が +20% 以内**（下限余裕 +0.2 件 / 1,000 字）
- **`tone_and_ng` と `overall` のいずれでも A 側（現行版）が全ペアの 75% 以上勝利していないこと**（6 ペアなら A 側 5 勝以上で却下）。「1 勝差の負け越しで即却下」とすると差の無い簡素化でも誤却下率が跳ね上がるため、`improve` と対称な 75% 基準を採用しています（`compare` レポートに単軸および 2 軸合算の誤却下確率目安を **ペア審査分のみ** として表示します）。

---

## 4. A/A テスト（確定率・位置偏り確認）・陽性対照・人手キャリブレーション

新しい審査モデルや比較実験を始める前に、まず **現行版どうしの A/A テスト**・**陽性対照確認**・**人間によるブラインド校正** を行います。

### ステップ 1：A/A テスト（確定率 `d`・位置偏り・機械指標の揺れ幅を確認）

位置を入れ替えて 2 回一致したペアの割合を **確定率 `d`** とします。審査 LLM が文章の長さなど品質以外の特徴を一貫して好むと、`d` が高くなり差の無い比較でも偶然で基準を満たしてしまいます（例：4 ペア中 3 勝以上は `d = 100%` で誤採用確率 **31%**、`d = 50%` で **5%**。6 ペア中 5 勝以上なら `d = 100%` でも **11%**、`d = 50%` で **0.5%**）。あわせて、位置スワップ前の各パスで先出し原稿（X）が選ばれた割合（先出し X 勝率）も確認します。

```bash
node scripts/eval-runner.mjs run --label baseline-a --runs 2 --writer-model <model>
node scripts/eval-runner.mjs run --label baseline-b --runs 2 --writer-model <model>
node scripts/eval-runner.mjs compare .eval-runs/<baseline-a> .eval-runs/<baseline-b> --judge-model <other-model> --criteria simplify
```

`compare` の表に出る **軸ごとの確定率 `d` と「単軸誤判定目安（ペア審査分のみ）」が 10% を超える場合、または A/A で基準超過が出た場合** は、そのまま本実験へ進まず以下で調整します：

1. 審査モデル（`--judge-model`）を別のモデルへ替える（同じ run 組を 8 回審査し直して比較）
2. 審査軸の説明文・審査プロンプトを見直す（※審査プロンプトを変えた場合は、必ず同じ run 組で 8 回の A/A 再審査とセットで行う）
3. 試行数（`--runs`）を 3 以上へ増やす

#### 参考：現行版（`038ede6`）の初回 A/A 実測値
- **計測日**：2026-11-22 ／ **対象コミット**：`038ede6`（`dirty: false`、`--runs 2`＝4 ペア・各 12 話）
- **書き手モデル**：`pqhaz/DeepSeek-V4.1-Flash-1017-heretic:thinking`（A/B とも 12/12 話成功・再試行 0）
- **審査モデル**：`z-ai/glm-5.3-flash-uncensored`（`calls=10`＝JSON 解析再試行 2 回含む）
- **ペア審査結果**：`buildup_and_payoff` `d=0.75`（A1/B2/位置依存1、4 ペア目安 15.2% → 6 ペア換算 3.1%）、`tone_and_ng` `d=0.00`（合意分 4/4）、`character_voice` `d=0.50`（A1/B1/位置依存2）、`overall` `d=0.25`（B1/位置依存3）。先出し（X）勝率は **18/24（75.0%）** と強めの先出し偏りあり。
- **機械指標**：表記 ❌ 0/0、欠落話数 0/0、記録警告 0/0、文章 ⚠️ 密度 `0.069` / `0.101`（`stock-phrase` `0.038` / `0.034`）、書けた話の文字数ズレ絶対値平均 `19.1%` / `20.0%`（±15% 逸脱話数は 8/7 話と高頻度）、文体 1 文平均ズレ `-11.4` / `-11.7` 字。
- ※ 上記の `d` と先出し偏りは **`z-ai/glm-5.3-flash-uncensored` を審査役にした 2026-11-22 時点の値** です。審査役を替えた場合は必ず同じ run 組で再計測して比較してください。

### ステップ 2：陽性対照確認（審査役の感度チェック・8 コール活用）

A/A テストだけでは「`tone_and_ng` が違反を本当につかまえられるか」は確認できないため、固定する審査モデルが決まったら 1 回だけ陽性対照（わざと違反を入れた比較）を回します。`compare` は全 4 ペア（8 コール）を審査するため、次の手順で 8 コールを無駄なく使います：

1. A/A で作成した run ディレクトリを丸ごと別ディレクトリへコピーする。
2. 4 ペアのうち **2 箇所だけ** 自然な 1 文〜1 段落の違反を差し込む（露骨すぎる改変にしない）：
   - `romcom-light` の 1 試行：話末に説教・教訓めいた締めを 1 文追加（機械点検 `preachy-ending` が拾うかもあわせて確認）
   - `fantasy-balanced` の 1 試行：重い過去の後付けを 1 段落追加
3. 残り 2 ペアは一切書き換えずに `compare` を実行する。これにより、違反を差し込んだ 2 ペアで `tone_and_ng` の検出感度を確かめつつ、無改変の 2 ペア（完全同一本文どうし）で内容差ゼロのときの位置偏りも同時に測れる。

### ステップ 3：人によるブラインド校正（LLM 確認とは別工程）

初回比較や大きな変更では、LLM による点検とは別に、**人間が最低 2 ペア（2〜3 話）を伏せ読み**し、次の 2 点を確認します：

1. LLM ペア審査の勝敗と人間の読後感が合っているか。
2. 審査の理由文が本文の事実と合っているか（位置を入れ替えた片方でしか欠陥に触れていない例や、本文に実在する設定矛盾・人称揺れの見落としが無いか）。

---

## 5. `no-ban-list` A/B 比較と変更前後の手順

### スキル本文の禁止表現リスト A/B 比較（`--skill-variant no-ban-list`）

- 他の変更と効果が混ざるのを防ぐため、事前のスキル整理（URL 説明等の移設）を先にコミットし、**その同一コミット上で `default` と `no-ban-list` を続けて計測**します（過去コミットの `baseline-a` は使い回しません）。
- `--skill-variant no-ban-list` が見出しと `❌` 目印で自動変換する範囲：
  1. `skills/novel-writing/SKILL.md` の `### A. 避ける定型句` の表を固定の肯定原則 1 文へ置換
  2. 86 行目相当の注記からは括弧内の具体語列挙だけを外し、「別の決まり文句へ置き換えない」「複数話にまたいで仕草を偏らせない」原則は保持
  3. `## 三、書き比べ` の `❌` 悪文例 4 箇所を除去し、`✅` 良い作例 4 本は保持
  4. `### B. 厳禁：勝手な教訓・感動まとめ`（および 96 行目注記）はそのまま保持

```bash
node scripts/eval-runner.mjs run --label p3-default --runs 3 --writer-model <model>
node scripts/eval-runner.mjs run --label p3-no-ban --runs 3 --skill-variant no-ban-list --writer-model <model>
node scripts/eval-runner.mjs compare .eval-runs/<p3-default> .eval-runs/<p3-no-ban> --judge-model <other-model> --criteria simplify
```

> **結果解釈の注記（3 点）**
> 1. 本比較が測るのは `skills/novel-writing/SKILL.md` 本文の表 A＋❌ 悪文例による初回出力への効果だけです。本番（OpenCode）では保存時・`novel_check` の ⚠️ が禁止語を名指しして返すため、本番全体での実効差はさらに小さくなり得ます。
> 2. 表 B（教訓まとめ禁止）と 96 行目注記は語を列挙したままのため、本実験で測れるのは表 A の効果だけです。
> 3. `novel_context` の「直近で重なっている定型仕草」（`src/tools/context.ts`）は、どちらの条件でも語を名指しします。

### コード・プロンプト変更の新旧 worktree 比較（`--plugin-root`）

```bash
# 変更前のコミット（例: 直前の確定コミット）を worktree で取り出してビルドする
git worktree add /tmp/llm-novel-plugin-before <比較元コミット>
cd /tmp/llm-novel-plugin-before
pnpm install && pnpm build

# 最新作業ツリー側もビルドし、--plugin-root を切り替えて実行（改善検証は --runs 3 推奨）
cd /path/to/llm-novel-plugin
pnpm build
node scripts/eval-runner.mjs run --label before --runs 3 --plugin-root /tmp/llm-novel-plugin-before --writer-model <model>
node scripts/eval-runner.mjs run --label after --runs 3 --plugin-root . --writer-model <model>
node scripts/eval-runner.mjs compare .eval-runs/<before> .eval-runs/<after> --judge-model <other-model> --criteria improve
```

評価終了後、一時 worktree は `git worktree remove /tmp/llm-novel-plugin-before` で片づけられます。

---

## 6. 大きな節目でのエンドツーエンド確認（OpenCode＋人間ブラインド読み比べ）

半自動ランナーで有意な差が見えた大きな変更については、OpenCode 上で `/write-chapters 1-3`（および必要に応じ `--revise`）を実行し、保存→点検→修正ループを含めた本番体験を人間が伏せ読みで確認します。

### 変更前・変更後プラグインの切り替え（OpenCode）

> **重要**：`opencode.json` の `"plugin"` 配列には**変更前と変更後のどちらか一方だけ**を指定してください。新旧を同時に読み込むとツール名が衝突します。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///tmp/llm-novel-plugin-before/dist/index.js"]
}
```

### 企画書の「摩擦・ままならなさ」欄の扱い（2 通りの比較）

1. **スキル・プロンプト改善単体の比較**：変更前・変更後とも、コピー先の `.novel/concept.md` から `- **物語を動かす摩擦・ままならなさ**：...` の 1 行を外した同一入力で比較する。
2. **企画書テンプレート＋スキル改善全体の比較**：変更前側は摩擦欄を外した版、変更後側は `examples/` のまま（摩擦欄あり）でエンドツーエンド比較する。

### 人間による採点シート

| 観点 | 変更前 (/10) | 変更後 (/10) | 主な確認ポイント |
|---|---:|---:|---|
| 1. キャラ立ち・掛け合い | | | 名前を隠しても誰の台詞か分かるか。「🗣️ ことばづかい」の維持 |
| 2. 見どころ・快感 | | | 第1〜3話でフックの約束を果たしているか。ごほうび場面が削られていないか |
| 2b. 溜めと見返り（平坦化チェック） | | | 起きた困りごと・照れ・制約が 1〜2 往復で都合よく即解決したり、全員が物分かりよく丸く収めたりしていないか |
| 3. テンポ・読みやすさ・つなぎ | | | 文体見本の呼吸に近いか。次話展開を先食いせず、話末の引きが次話の入りへ自然につながるか |
| 4. トーン＆NG ライン遵守 | | | 勝手なシリアス化・重い過去の後付け・説教や教訓まとめが無いか |
| 5. つじつま・表記・反 AI | | | 設定・用語集・状態・伏線の整合。AI 定型句や話またぎ仕草の偏り |

### あわせて記録する機械指標

`node scripts/eval-runner.mjs metrics <コピー先ディレクトリ>` を実行すると、以下を一括で集計できます：

- **表記 ❌（全3話合計）**：0 件が基準
- **文章 ⚠️ 密度（件 / 1,000 字）**：合計密度および規則別内訳（`stock-phrase`・`preachy-ending`・`closing-cliche`・`repeated-ending`・`long-sentence`・`cross-chapter-repeat`）
- **文字数の目安逸脱**：±15% から外れた話の有無
- **文体見本とのズレ（絶対値平均）**：1 文平均・会話比率・段落長・過去形(た/だ)比率の絶対値ズレ（試行間で正負が打ち消し合わないよう絶対値平均を主指標とし、符号付き平均も併記）
- **記録の完全性**：`novel_status` で `character-state`・`summary`・`foreshadow` の欠けや異常が無いこと
