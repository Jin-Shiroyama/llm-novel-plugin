import {
  safeWriteFile,
  safeWriteJson,
  getNovelDir,
  getDocPath,
  getNovelPath,
  existsSync,
  getConfigPath,
  inferWorldBuilding,
  inferSeriousness,
  storyModeLabel,
  seriousnessLabel,
  recommendedGenreSkills,
} from "../core/utils.js"
import {
  fillTemplateVars,
  CONFIG_TEMPLATE,
  CONCEPT_TEMPLATE,
  WORLD_BUILDING_TEMPLATE,
  GLOSSARY_TEMPLATE,
  CHARACTER_PROFILES_TEMPLATE,
  SUMMARY_TEMPLATE,
  FORESHADOW_TEMPLATE,
  CHARACTER_STATE_TEMPLATE,
  CANON_OVERVIEW_TEMPLATE,
  CANON_TIMELINE_TEMPLATE,
  CANON_SETTING_TEMPLATE,
} from "../core/templates.js"
import { DEFAULTS, SHORT_DEFAULTS } from "../core/constants.js"
import type {
  StoryMode,
  Seriousness,
  WorldBuildingMode,
  IndentStyle,
  ChapterUnit,
} from "../core/constants.js"
import type { ToolRuntimeContext } from "./types.js"

export interface InitArgs {
  title: string
  genre: string
  /** 構成の型: arc（アーク連載）/ episodic（日常・イベント）/ plot（1巻完結）/ short（短編） */
  storyMode?: StoryMode
  /** 作品の雰囲気・読後感（例: 笑える・掛け合い／ニヤニヤ・甘い、ワクワク・爽快） */
  tone?: string
  /** シリアス度: light（軽快・明るめ）/ balanced（エンタメ標準）/ serious（シリアス重視） */
  seriousness?: Seriousness
  /** 世界観・設定の扱い: minimal（省略可）/ standard（world-building.md を作成） */
  worldBuilding?: WorldBuildingMode
  /** 段落頭の字下げ: fullwidth（全角1字下げ）/ none（字下げなし） */
  indent?: IndentStyle
  targetWords?: number
  chapterCount?: number
  narrativePerspective?: string
  /** 書き出し時の単位の呼び名（既定 "話"） */
  chapterUnit?: ChapterUnit
  /** 連載（結末未定）か。省略時は arc / episodic で true、plot / short で false */
  serial?: boolean
  /** 二次創作の原作名。渡すと .novel/canon/ に原作資料の雛形を作る */
  sourceWork?: string
}

/** トーンを1行に直し、角括弧を外す */
export function normalizeTone(tone: string): string {
  return tone.replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim()
}

/** 企画書雛形の「全体の雰囲気」の行へトーンを書き込む */
export function writeToneToConcept(concept: string, tone: string): string {
  const value = normalizeTone(tone)
  if (!value) return concept
  return concept.replace(/^- \*\*全体の雰囲気\*\*：.*$/m, () => `- **全体の雰囲気**：${value}`)
}

export async function novelInitExecute(
  args: InitArgs,
  ctx: ToolRuntimeContext,
): Promise<string> {
  const dir = ctx.projectDir
  const novelDir = getNovelDir(dir)

  if (existsSync(novelDir)) {
    return `❌ このディレクトリにはすでに作品データがあります: ${novelDir}
作り直す場合は .novel ディレクトリを削除してください。`
  }

  const title = args.title.trim()
  const genre = args.genre.trim()
  const storyMode: StoryMode = args.storyMode ?? DEFAULTS.storyMode
  const short = storyMode === "short"
  const defaults = short ? SHORT_DEFAULTS : DEFAULTS
  const targetWords = args.targetWords ?? defaults.targetWords
  const chapterCount = args.chapterCount ?? defaults.chapterCount
  const perspective = args.narrativePerspective ?? DEFAULTS.narrativePerspective
  const chapterUnit: ChapterUnit = args.chapterUnit ?? DEFAULTS.chapterUnit
  const serial = args.serial ?? (storyMode === "arc" || storyMode === "episodic")
  const seriousness: Seriousness = args.seriousness ?? inferSeriousness(genre)
  const worldBuilding: WorldBuildingMode = args.worldBuilding ?? inferWorldBuilding(genre, storyMode)
  const indent: IndentStyle = args.indent ?? DEFAULTS.indent
  const sourceWork = args.sourceWork?.trim() ?? ""
  const tone = normalizeTone(args.tone ?? "")

  const vars = {
    title,
    genre,
    storyMode: storyModeLabel(storyMode),
    seriousness: seriousnessLabel(seriousness),
    targetWords,
    chapterCount,
    narrativePerspective: perspective,
  }

  const config = {
    ...CONFIG_TEMPLATE,
    title,
    genre,
    storyMode,
    tone,
    seriousness,
    worldBuilding,
    indent,
    targetWords,
    chapterCount,
    narrativePerspective: perspective,
    chapterUnit,
    serial,
    ...(sourceWork ? { sourceWork } : {}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentPhase: "concept",
  }
  await safeWriteJson(getConfigPath(dir), config)

  await safeWriteFile(
    getDocPath(dir, "concept"),
    writeToneToConcept(fillTemplateVars(CONCEPT_TEMPLATE, vars), tone),
  )

  if (worldBuilding === "standard" && !short) {
    await safeWriteFile(getDocPath(dir, "world-building"), fillTemplateVars(WORLD_BUILDING_TEMPLATE, vars))
  }
  await safeWriteFile(getDocPath(dir, "glossary"), fillTemplateVars(GLOSSARY_TEMPLATE, vars))
  await safeWriteFile(getDocPath(dir, "characters"), fillTemplateVars(CHARACTER_PROFILES_TEMPLATE, vars))
  await safeWriteFile(getDocPath(dir, "summary"), fillTemplateVars(SUMMARY_TEMPLATE, vars))
  await safeWriteJson(getDocPath(dir, "foreshadow"), FORESHADOW_TEMPLATE)
  await safeWriteJson(getDocPath(dir, "character-state"), CHARACTER_STATE_TEMPLATE)

  if (sourceWork) {
    const canonVars = { ...vars, sourceWork }
    await safeWriteFile(getNovelPath(dir, "canon", "overview.md"), fillTemplateVars(CANON_OVERVIEW_TEMPLATE, canonVars))
    await safeWriteFile(getNovelPath(dir, "canon", "timeline.md"), fillTemplateVars(CANON_TIMELINE_TEMPLATE, canonVars))
    await safeWriteFile(getNovelPath(dir, "canon", "setting.md"), fillTemplateVars(CANON_SETTING_TEMPLATE, canonVars))
  }

  const canonNote = sourceWork
    ? `
  📚 原作の資料（二次創作）:
  canon/
  ├── overview.md       (原作と扱い方 ← まずここから)
  ├── timeline.md       (原作の時系列と分岐)
  ├── setting.md        (原作の設定)
  └── characters/       (原作の人物。一人ずつ {名前}.md を足します)`
    : ""

  const perChapter = Math.round(targetWords / chapterCount)
  const chaptersLine = short && chapterCount === 1
    ? `構成: 短編・読み切り（1本で完結、約${perChapter.toLocaleString("ja-JP")}文字）`
    : serial
      ? `構成: ${storyModeLabel(storyMode)}／連載（目安 全${chapterCount}${chapterUnit}・1${chapterUnit}あたり約${perChapter.toLocaleString("ja-JP")}文字。超えて書いてよい）`
      : `構成: ${storyModeLabel(storyMode)}／全${chapterCount}${chapterUnit}（1${chapterUnit}あたり約${perChapter.toLocaleString("ja-JP")}文字）`

  const genreSkills = recommendedGenreSkills(genre)
  const skillHint = [
    ...genreSkills,
    ...(sourceWork ? ["novel-fanfic"] : []),
  ]
  const worldFileLine = worldBuilding === "standard" && !short ? "  ├── world-building.md    (舞台・設定)\n" : ""
  const nextStepWorld =
    worldBuilding === "standard" && !short
      ? "  2. 舞台・設定（.novel/world-building.md）とキャラクター（.novel/characters/）を設計します"
      : "  2. キャラクター（.novel/characters/）を設計します（舞台設定が必要になったら後から足せます）"

  return `✅ 作品『${title}』の準備ができました。

📁 作成したファイル:
  .novel/
  ├── config.json          (作品設定)
  ├── concept.md           (作品企画書 ← まずここから)
${worldFileLine}  ├── glossary.md          (用語集。造語・固有名詞の表記と意味)
  ├── characters/          (登場人物)
  │   ├── profiles.md      (一覧・関係性マップ・掛け合い)
  │   └── state.json       (話ごとの状態の変化)
  ├── summary.md           (これまでのあらすじ)
  ├── foreshadow.json      (伏線の管理)
  └── chapters/            (本文。保存時に自動で作られます)${canonNote}

📋 作品の基本情報:
  ジャンル: ${genre}${tone ? `\n  雰囲気・トーン: ${tone}` : ""}
  シリアス度: ${seriousnessLabel(seriousness)}${sourceWork ? `\n  二次創作: 原作『${sourceWork}』` : ""}
  ${chaptersLine}
  視点: ${perspective}
  段落の字下げ: ${indent === "none" ? "字下げなし（Web小説スタイル）" : "全角1字下げ"}${skillHint.length > 0 ? `\n  おすすめスキル: ${skillHint.join("、")}` : ""}

📝 次にやること:${sourceWork ? "\n  0. 原作の資料（.novel/canon/overview.md・timeline.md・setting.md・原作キャラ）を先に整えます" : ""}
  1. 企画書（.novel/concept.md）で、フック・面白さの柱・お約束とひとひねり・NG ラインを固めます
${nextStepWorld}
  3. プロットを作って第1話から書き始めます（シーン分割は任意です）`
}
