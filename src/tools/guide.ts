import { DEFAULTS, CHAPTER_LENGTH, CHAPTER_WORD_TOLERANCE, FORESHADOW_LOOKAHEAD } from "../core/constants.js"
import type { ToolRuntimeContext } from "./types.js"

export interface GuideArgs {
  section?: "workflow" | "prompts" | "writing" | "foreshadow" | "characters"
}

export async function novelGuideExecute(
  args: GuideArgs,
  _ctx: ToolRuntimeContext,
): Promise<string> {
  return getGuideContent(args.section ?? "workflow")
}

const WORKFLOW_GUIDE = `# 📖 ライトノベル・Web小説の進め方

## 全体の流れ（最短3〜4ステップで執筆開始）

\`\`\`
企画（concept.md） → ［任意］舞台・設定（world-building.md） → キャラ（characters/） → プロット（outline/） → 本文執筆（chapters/）
\`\`\`

- **舞台・設定は必要な作品だけ**：現代ラブコメ・学園・日常コメディ・短編（\`worldBuilding: "minimal"\`）ではスキップできます
- **シーン分割は任意**：1話 2,000〜4,000文字なら、話別プロットから直接執筆に入れます
- **キャラ起点でもOK**：「こんなヒロインや相棒を出したい」から始めて企画書へ落とし込めます

## 構成の型（storyMode）

| 型 | 向く作品 | 進め方 |
|---|---|---|
| \`arc\`（既定） | 異世界ファンタジー、現代異能、SF冒険、バトル | 序盤3話フック → 10〜15話で1つの山（アーク）を重ねる連載 |
| \`episodic\` | ラブコメ・いちゃラブ、学園日常、コメディ、スローライフ | 距離感・暮らしのステップ（または関係良好な日常の広げ方）＋イベント／行事ネタ帳で回ごとに楽しむ連載 |
| \`plot\` | 文庫1巻完結、SF長編、ミステリ | 序盤・中盤・クライマックスを全体設計して完結させる |
| \`short\` | 短編・読み切り | 1つの見どころに絞り、プロット概要からすぐ執筆 |

## シリアス度（seriousness）と NG ライン

- \`light\`（軽快・明るめ）：掛け合い・笑い・ニヤニヤ・爽快感重視。頼まれていない死・重い過去・胸糞展開・教訓まとめを足さない
- \`balanced\`（エンタメ標準）：普段は楽しく、見せ場では熱く。カタルシスとごほうびをしっかり描く
- \`serious\`（シリアス重視）：緊張感や葛藤を正面から描く

企画書（\`.novel/concept.md\`）に **NG ライン（やらないこと）** を書いておくと、毎話 \`novel_context\` で最優先注入されます。

## 執筆ループ（1話ごと）

1. \`novel_context(chapterNumber: N)\` で資料を一式そろえる
2. プロット・トーン・ことばづかいに沿って本文を書く
3. \`novel_save_chapter\` で保存し、点検結果と目安文字数を確認する。❌ があれば直す。自動整形は autoFix が有効な場合に適用する（省略時の動作はツールの引数説明を参照）
4. \`novel_update\` で \`character-state\` / \`summary\` / \`foreshadow\` を更新する
5. まとまったら \`novel_export(split: true)\` で1話ずつ書き出す

## 二次創作（sourceWork）

\`novel_init\` に \`sourceWork\`（原作名）を渡すと \`.novel/canon/\` に原作資料の雛形ができます。
原作の事実は記憶で埋めず、確かめた内容を \`canon/\` に書いて正本にします（詳しくは \`novel-fanfic\` skill）。
`

const PROMPTS_GUIDE = `# 📝 プロンプト一覧（novel_update(action: "prompt")）

| 名前 | 用途 |
|---|---|
| \`concept\` | 作品企画書（フック・面白さの柱・お約束とひとひねり・NGライン） |
| \`world-building\` | 舞台・設定・ギミック・用語集 |
| \`characters\` | 推せるキャラ設計・掛け合い・ことばづかい |
| \`outline-brief\` | アーク連載・1巻完結のプロット概要 |
| \`outline-episodic\` | ラブコメ・日常・イベント型のプロット概要 |
| \`outline-short\` | 短編・読み切りのプロット概要 |
| \`outline-detailed\` | 1話ごとのプロット（見どころ・展開ビート・進むもの・引き） |
| \`scenes\` | 任意のシーン分割 |
| \`consistency-check\` | つじつま・トーン確認 |
| \`character-state-update\` | キャラの状態・関係・ことばづかいの更新 JSON |
| \`summary-update\` | 1話ごとのあらすじ・全体の流れの更新 |

※ 本文執筆の資料・条件は \`novel_context\` を使います（プロンプト取得は不要です）。

詳しい執筆技法・ジャンル別のコツはスキルを参照します:
- 共通: \`novel-planning\` / \`novel-writing\` / \`novel-editing\`
- ジャンル別: \`genre-fantasy\` / \`genre-romance\` / \`genre-slice-of-life\` / \`genre-sf\` / \`novel-fanfic\`
`

const WRITING_GUIDE = `# ✍️ ライトノベル・Web小説の書きかた（要点）

> 表記規約・反AI一覧・特殊書式（ステータス画面／掲示板回／配信回）の正本は \`novel-writing\` skill です。

## 読みやすさと面白さの要点

- **企画書の「語りと文体」「文体見本」を最優先する**：軽快な一人称から落ち着いた三人称まで、作品のトーンに合った声とリズムで書く
- **トーンに合った段落テンポ**：軽快・Web連載標準では段落 1〜3 文と間の 1 行あけを活用し、シリアスや描写重視では呼吸に合わせて 3〜5 文の段落も自然に使う
- **説明をため込まない**：設定説明は場面の中で 1〜2 文ずつ。会話や失敗・実験の中で見せる
- **見どころと引き**：1 話ごとに「読んでよかった（キュン／笑い／爽快／驚き）」と「次も読みたい（引き・余韻）」を置く
- **教訓や説教で締めない**：「大切なことに気づいた」「絆がさらに深まった」などの AI 臭いまとめを書かない

## 表記のきまり（要点）

- 会話は「」、会話中の引用は『』。会話文末に句点は打たない
- 三点リーダは「……」、ダッシュは「――」（必ず偶数個）
- 感嘆符・疑問符は全角「！」「？」。直後に全角スペース1つ（閉じ括弧の直前・行末・約物の連続は除く）
- 段落頭は \`config.json\` の \`indent\` に従う（\`fullwidth\`＝全角1字下げ／\`none\`＝字下げなし）。会話・記号・画面行は字下げしない
- 単位付きの数やステータスは半角算用数字（3メートル、HP 1200、レベル5）
- ルビは \`｜親文字《ルビ》\`、傍点は \`《《傍点》》\`（カクヨム記法。書き出し時に他サイトへ変換可能）

## 文字数の目安

- 1話の目標 = 目標総文字数 ÷ 予定話数（±${Math.round(CHAPTER_WORD_TOLERANCE * 100)}%）
- 既定では ${DEFAULTS.targetWords.toLocaleString("ja-JP")}文字 ÷ ${DEFAULTS.chapterCount}話 = 1話 ${Math.round(DEFAULTS.targetWords / DEFAULTS.chapterCount).toLocaleString("ja-JP")}文字
- Web連載の読みやすい目安：1話 ${CHAPTER_LENGTH.min.toLocaleString("ja-JP")}〜${CHAPTER_LENGTH.max.toLocaleString("ja-JP")}文字（山場は ${CHAPTER_LENGTH.peak.toLocaleString("ja-JP")}文字まで）
`

const FORESHADOW_GUIDE = `# 🎯 伏線の扱い

## 状態の移り変わり

\`\`\`
pending（計画のみ） → planted（本文に張った） → resolved（回収した）
                                               → abandoned（取り下げた）
\`\`\`

## novel_context での通知ルール

- \`resolved\` / \`abandoned\`：通知しない
- \`planted\`：回収予定にかかわらず常に通知する（張りっぱなし防止）
- \`pending\`：回収予定が過ぎた・この話・${FORESHADOW_LOOKAHEAD}話以内のものだけ通知する

## 連載でのコツ

回収話数がまだ決まっていない伏線は \`targetChapter\` を省いて登録できます。
アークの切り替わりで \`novel_status\` を見て、張りっぱなしの伏線を次の山に組み込みましょう。
`

const CHARACTERS_GUIDE = `# 👤 キャラクターの設計と管理

## キャラを立たせる 4 本柱

1. **キャッチコピー・属性とギャップ**：一目で覚えられ、推したくなる魅力（例：クール優等生×超甘党）
2. **好きなこと・やりたいこと**：シンプルで分かりやすい行動原理
3. **掛け合いでの役割**：ボケ／ツッコミ／振り回し役／デレ担当／常識人など、他キャラと並んだときの化学反応
4. **ことばづかい**：一人称・二人称・敬語・相手ごとの呼び方（\`novel_context\` が「🗣️ ことばづかい」として毎話自動抽出）

## 話ごとの状態記録（state.json）

1話書き終えたら \`novel_update(action: "character-state", chapterNumber: N)\` で変化した欄だけ記録します。
- \`mentalState\` / \`physicalState\` / \`attributes\`（現在地・レベル・好感度など）/ \`lists\`（所持品・スキルなど）/ \`relationships\` / \`speech\`（一人称や呼び方の変化）/ \`events\`
- 変化が無かった話も \`{"updates": []}\` を渡して記録済みにします
`

export function getGuideContent(section: string): string {
  switch (section) {
    case "workflow":
      return WORKFLOW_GUIDE
    case "prompts":
      return PROMPTS_GUIDE
    case "writing":
      return WRITING_GUIDE
    case "foreshadow":
      return FORESHADOW_GUIDE
    case "characters":
      return CHARACTERS_GUIDE
    default:
      return WORKFLOW_GUIDE
  }
}
