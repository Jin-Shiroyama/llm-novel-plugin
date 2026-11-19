/**
 * llm-novel-plugin - 既定値と上限値
 *
 * ライトノベル・Web小説執筆に特化した既定値を一元管理する。
 * 各ツール・テンプレート・コンテキスト生成からは必ず本モジュールを参照する。
 */

/** 構成の型（ストーリーモード） */
export const STORY_MODES = ["arc", "episodic", "plot", "short"] as const
export type StoryMode = (typeof STORY_MODES)[number]

/** シリアス度 */
export const SERIOUSNESS_LEVELS = ["light", "balanced", "serious"] as const
export type Seriousness = (typeof SERIOUSNESS_LEVELS)[number]

/** 世界観・設定ファイルの扱い */
export const WORLD_BUILDING_MODES = ["minimal", "standard"] as const
export type WorldBuildingMode = (typeof WORLD_BUILDING_MODES)[number]

/** 段落頭の字下げスタイル */
export const INDENT_STYLES = ["fullwidth", "none"] as const
export type IndentStyle = (typeof INDENT_STYLES)[number]

/** 話・章の単位の呼び名 */
export const CHAPTER_UNITS = ["話", "章"] as const
export type ChapterUnit = (typeof CHAPTER_UNITS)[number]

/** プロジェクト既定値（Web連載・ライトノベル標準） */
export const DEFAULTS = {
  /** 目標総文字数（Web連載の当面30話＝9万字／文庫1冊相当は10〜12万字） */
  targetWords: 90000,
  /** 予定話数（90000 / 30 = 1話 3,000文字） */
  chapterCount: 30,
  /** 叙述の視点（ラノベ・Web小説の主流は一人称） */
  narrativePerspective: "一人称",
  /** 書き出し時の単位の呼び名 */
  chapterUnit: "話" as ChapterUnit,
  /** 構成の型 */
  storyMode: "arc" as StoryMode,
  /** シリアス度 */
  seriousness: "balanced" as Seriousness,
  /** 世界観・設定の扱い */
  worldBuilding: "standard" as WorldBuildingMode,
  /** 段落頭の字下げ */
  indent: "fullwidth" as IndentStyle,
} as const

/** 短編・読み切り（storyMode: "short"）の既定値 */
export const SHORT_DEFAULTS = {
  targetWords: 12000,
  chapterCount: 1,
} as const

/**
 * novel_context が各資料から読み込む文字数の上限（コードポイント単位）。
 * config.json の limits で作品ごとに上書きできる。
 */
export const LIMITS = {
  /** 前の話の末尾の引き継ぎ分量 */
  previousChapterTail: 1200,
  /** キャラクターシート */
  characterProfiles: 6000,
  /** これまでのあらすじ */
  summary: 4000,
  /** この話のシーン一覧（任意で作成した場合） */
  scenes: 4000,
  /** ことばづかいの一覧（一人称・二人称・相手ごとの呼び方） */
  speech: 1500,
  /** 登場人物の状態（書く話より前の記録を重ねたもの） */
  characterState: 3000,
  /** プロット概要（短編で話別プロットが無いときに載せる） */
  outlineBrief: 4000,
  /** 企画書（フック・面白さの柱・トーン＆NGライン・文体と見本に優先枠を配る） */
  concept: 4000,
  /** 舞台・設定（world-building.md と world/ 配下。ルール・能力・ギミックに優先枠） */
  worldBuilding: 6000,
  /** 用語集（この話のプロットに出る用語を先に載せる） */
  glossary: 3000,
  /** 原作の資料（二次創作。canon/ の扱い方・時系列・設定） */
  canon: 6000,
} as const

export type LimitKey = keyof typeof LIMITS

/** 未着手の伏線を知らせはじめる話数 */
export const FORESHADOW_LOOKAHEAD = 3

/** 1話あたりの推奨文字数レンジ（Web小説・ラノベ標準） */
export const CHAPTER_LENGTH = {
  min: 2000,
  max: 4000,
  /** 山場の話で許容する上限 */
  peak: 6000,
} as const

/** 1話の目標文字数に許容する振れ幅（比率） */
export const CHAPTER_WORD_TOLERANCE = 0.15

/** 世界観工程を既定で minimal（省略可）と推定するジャンルキーワード */
export const MINIMAL_WORLD_GENRE_KEYWORDS = [
  "ラブコメ",
  "恋愛",
  "いちゃラブ",
  "イチャラブ",
  "溺愛",
  "甘々",
  "日常",
  "コメディ",
  "学園",
  "青春",
  "現代ドラマ",
  "スローライフ",
  "ほのぼの",
  "ギャグ",
  "部活",
  "グルメ",
  "お仕事",
] as const

/** シリアス度を既定で light（軽快・明るめ）と推定するジャンルキーワード */
export const LIGHT_TONE_GENRE_KEYWORDS = [
  "ラブコメ",
  "いちゃラブ",
  "イチャラブ",
  "甘々",
  "日常",
  "コメディ",
  "スローライフ",
  "ほのぼの",
  "ギャグ",
  "空気系",
] as const

/** ファンタジー系ジャンル判定キーワード（スキル案内に使用） */
export const FANTASY_GENRE_KEYWORDS = [
  "ファンタジー",
  "異世界",
  "転生",
  "転移",
  "追放",
  "悪役令嬢",
  "ダンジョン",
  "異能",
  "魔法",
  "冒険",
  "バトル",
  "VRMMO",
] as const

/** 恋愛・ラブコメ系ジャンル判定キーワード（スキル案内に使用） */
export const ROMANCE_GENRE_KEYWORDS = [
  "ラブコメ",
  "恋愛",
  "いちゃラブ",
  "イチャラブ",
  "溺愛",
  "甘々",
  "恋人",
  "夫婦",
  "純愛",
] as const

/** 日常系・コメディ・スローライフ系ジャンル判定キーワード（スキル案内に使用） */
export const SLICE_OF_LIFE_GENRE_KEYWORDS = [
  "日常",
  "コメディ",
  "スローライフ",
  "ほのぼの",
  "ギャグ",
  "空気系",
  "青春",
  "部活",
  "グルメ",
  "料理",
  "お仕事",
] as const

/** SF系ジャンル判定キーワード（スキル案内に使用） */
export const SF_GENRE_KEYWORDS = [
  "SF",
  "近未来",
  "サイバーパンク",
  "宇宙",
  "ロボット",
  "タイムリープ",
  "ループ",
  "ディストピア",
  "ポスト・アポカリプス",
  "ポストアポカリプス",
] as const
