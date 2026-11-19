import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { join } from "node:path"
import { novelInitExecute } from "../../tools/init.js"
import { novelStatusExecute } from "../../tools/status.js"
import { novelSaveChapterExecute } from "../../tools/save.js"
import { novelContextExecute } from "../../tools/context.js"
import { novelGuideExecute } from "../../tools/guide.js"
import { novelUpdateExecute } from "../../tools/track.js"
import { novelCheckExecute } from "../../tools/check.js"
import { novelExportExecute } from "../../tools/export.js"
import {
  STORY_MODES,
  SERIOUSNESS_LEVELS,
  WORLD_BUILDING_MODES,
  INDENT_STYLES,
  CHAPTER_UNITS,
} from "../../core/constants.js"
import {
  CHARACTER_STATE_EXAMPLE,
  CHARACTER_STATE_KEYS,
  FORESHADOW_EXAMPLE,
  FORESHADOW_KEYS,
} from "../../core/records.js"
import { RUBY_NOTATIONS } from "../../core/ruby.js"
import { SECTION_KINDS } from "../../core/sections.js"
import { createNovelPlannerAgent } from "./agents/novel-planner.js"
import { createNovelWriterAgent } from "./agents/novel-writer.js"
import { createNovelEditorAgent } from "./agents/novel-editor.js"
import { mergeAgentConfig } from "./agent-config.js"
import { loadCommands } from "./commands.js"

const z = tool.schema

function sectionArgs(verb: string) {
  return {
    section: z.enum(SECTION_KINDS).optional()
      .describe(`${verb}もの。chapter（既定＝通常の話・章）/ prologue（プロローグ）/ interlude（幕間）/ epilogue（エピローグ）`),
    chapterNumber: z.number().int().positive().optional()
      .describe("話・章の番号（1から数える）。通常の話では必須。幕間では直前の話の番号。プロローグ・エピローグでは不要"),
    interludeIndex: z.number().int().positive().optional()
      .describe("幕間のとき、同じ話のあとの何番目か（1から）。既定 1"),
  }
}

export function createOpenCodePlugin(pluginRoot: string): Plugin {
  const commandsDir = join(pluginRoot, "commands")
  const skillsDir = join(pluginRoot, "skills")
  const cachedCommands = loadCommands(commandsDir)

  return async (_ctx: PluginInput): Promise<Hooks> => {
    return {
      tool: {
        novel_init: tool({
          description: `ライトノベル・Web小説プロジェクトを新規に作成する。.novel ディレクトリと企画書・キャラクター・用語集・記録ファイルの雛形を用意する。
使う場面: 新しい作品を立ち上げるとき。`,
          args: {
            title: z.string().describe("作品タイトル（仮題可）"),
            genre: z.string().describe("ジャンル（例: 異世界ファンタジー、現代ファンタジー、ラブコメ、学園日常、SF、悪役令嬢、スローライフ、ダンジョン配信、青春コメディ）"),
            storyMode: z.enum(STORY_MODES).optional()
              .describe("構成の型。arc（既定・アーク連載型：10〜15話で1つの山）/ episodic（日常・ラブコメ・イベント型）/ plot（文庫1巻完結型）/ short（短編・読み切り）"),
            tone: z.string().optional()
              .describe("作品の雰囲気・読後感（例: 笑える・掛け合い、ニヤニヤ・甘い、ワクワク・爽快、熱いバトル、ほのぼの、知的興奮・SF、シリアス）。config.json と concept.md の両方に記録する"),
            seriousness: z.enum(SERIOUSNESS_LEVELS).optional()
              .describe("シリアス度。light（軽快・明るめ：死・喪失・重い過去を勝手に足さない）/ balanced（エンタメ標準）/ serious（シリアス重視）。省略時はジャンルから推定"),
            worldBuilding: z.enum(WORLD_BUILDING_MODES).optional()
              .describe("舞台・設定ファイルの扱い。minimal（ラブコメ・日常・短編など世界観工程を省略）/ standard（world-building.md を作成）。省略時はジャンルと構成型から推定"),
            indent: z.enum(INDENT_STYLES).optional()
              .describe("段落頭の字下げ。fullwidth（既定・全角1字下げ）/ none（Web小説の字下げなし）"),
            targetWords: z.number().int().positive().optional().describe("目標総文字数（1以上の整数）。既定 90000（30話×3,000字）。plot の既定は 100000、short の既定は 12000"),
            chapterCount: z.number().int().positive().optional().describe("予定話数（1以上の整数）。既定 30。plot の既定は 35、short の既定は 1"),
            narrativePerspective: z.string().optional().describe("視点。既定「一人称」（三人称キャラ視点・三人称多元視点も可）"),
            chapterUnit: z.enum(CHAPTER_UNITS).optional().describe("書き出し時の単位の呼び名。既定「話」（「章」も可）"),
            serial: z.boolean().optional()
              .describe("連載（結末未定）なら true。省略時は arc / episodic で true、plot / short で false"),
            sourceWork: z.string().optional()
              .describe("二次創作のときの原作名（クロスオーバーは「A × B」）。渡すと .novel/canon/ に原作資料の雛形を作り、毎話の資料に載せる"),
          },
          async execute(args, context) {
            return novelInitExecute(args as any, { projectDir: context.directory })
          },
        }),

        novel_status: tool({
          description: `作品の進行状況・工程・話数・累計文字数・伏線・記録の点検（あらすじ欠け・状態欠け・投稿情報の文字数上限・二次創作資料の有無）をまとめて返す。`,
          args: {
            detailed: z.boolean().optional().describe("話ごとの文字数まで出すかどうか"),
          },
          async execute(args, context) {
            return novelStatusExecute(args as any, { projectDir: context.directory })
          },
        }),

        novel_save_chapter: tool({
          description: `書き上げた1話を chapters ディレクトリに保存する。連番付け・文字数と目安（±15%）の比較・旧稿の .novel/drafts/ 退避・表記の自動整形（既定 ON）と点検を自動で行う。
プロローグ・幕間・エピローグは section で指定する。`,
          args: {
            ...sectionArgs("保存する"),
            title: z.string().describe("サブタイトル（話タイトル）"),
            content: z.string().describe("本文。見出し行は含めない"),
            updateState: z.boolean().optional().describe("保存後に記録更新の案内を出すかどうか。既定 true"),
            autoFix: z.boolean().optional().describe("機械的に直せる表記（会話末の句点・半角!?・字下げなど）を保存時に自動整形するかどうか。既定 true"),
          },
          async execute(args, context) {
            return novelSaveChapterExecute(args as any, { projectDir: context.directory })
          },
        }),

        novel_context: tool({
          description: `指定した話を書くための資料を一式そろえる。この話のプロット、企画書のフック・トーン・NGライン、登場人物とことばづかい、現在の状態、前の話の末尾、舞台・設定、用語集、あらすじ、伏線、二次創作の原作資料を優先度付きで返す。`,
          args: {
            ...sectionArgs("これから書く"),
            sceneId: z.string().optional().describe("任意で作成したシーンID（例 1.1）を指定すると印が付く"),
            includePrompts: z.boolean().optional().describe("末尾に「書くときの条件」を付けるかどうか。既定 true"),
          },
          async execute(args, context) {
            return novelContextExecute(args as any, { projectDir: context.directory })
          },
        }),

        novel_guide: tool({
          description: `ライトノベル・Web小説執筆の手引きを返す（workflow / prompts / writing / foreshadow / characters）。`,
          args: {
            section: z.enum(["workflow", "prompts", "writing", "foreshadow", "characters"]).optional()
              .describe("読みたい手引きの章。既定は workflow"),
          },
          async execute(args, context) {
            return novelGuideExecute(args as any, { projectDir: context.directory })
          },
        }),

        novel_update: tool({
          description: `作品の記録を更新する（character-state / summary / foreshadow）またはプロンプトを取得する（prompt）。
形が違うと何も書かず ❌ と理由を返す。

■ character-state（content は JSON。変わったキャラと欄だけを渡す。chapterNumber か section が必須）
changes で使えるキー: ${CHARACTER_STATE_KEYS}
${CHARACTER_STATE_EXAMPLE}

■ summary（content はこの話だけのあらすじ。chapterNumber か section が必須）
content を「## 全体の流れ」で始めると全体の要約を差し替える（chapterNumber は何話までの要約か）。

■ foreshadow（content は JSON。既存は id で指し、変える項目だけ渡す）
使えるキー: ${FORESHADOW_KEYS}
${FORESHADOW_EXAMPLE}`,
          args: {
            action: z.enum(["character-state", "summary", "foreshadow", "prompt"]).describe("更新の種別"),
            content: z.string().describe("更新内容（JSON 文字列、あらすじ本文、またはプロンプト名）"),
            section: z.enum(SECTION_KINDS).optional().describe("プロローグ・幕間・エピローグの記録のとき"),
            chapterNumber: z.number().int().positive().optional().describe("対象の話番号（1以上の整数）"),
            interludeIndex: z.number().int().positive().optional().describe("幕間のとき、同じ話のあとの何番目か。既定 1"),
          },
          async execute(args, context) {
            return novelUpdateExecute(args as any, { projectDir: context.directory })
          },
        }),

        novel_check: tool({
          description: `本文の表記（❌ 規約違反 / ⚠️ 確認）と文章（⚠️ 反AI・教訓まとめ・文末連続・長い文）を点検し、行と字の位置つきで返す。fix: true で機械修正可能な表記を自動修正して保存できる。`,
          args: {
            section: z.enum(SECTION_KINDS).optional().describe("点検する節の種類。省くと chapterNumber の話、どちらも省くと全話"),
            chapterNumber: z.number().int().positive().optional().describe("点検する話番号"),
            interludeIndex: z.number().int().positive().optional().describe("幕間のとき何番目か。既定 1"),
            maxIssues: z.number().int().positive().optional().describe("1話あたりに並べる箇所の上限。既定 30"),
            fix: z.boolean().optional().describe("true のとき、機械的に直せる表記を自動修正して保存する（旧稿は .novel/drafts/ に退避）。既定 false"),
          },
          async execute(args, context) {
            return novelCheckExecute(args as any, { projectDir: context.directory })
          },
        }),

        novel_export: tool({
          description: `書いた話を繋いで原稿を書き出す（本文は書き換えない）。
unit の既定は config.json の chapterUnit（既定「話」→「第1話　タイトル」）。
split: true にすると投稿サイト向けの1話ずつ別ファイル＋index.txt で書き出す。`,
          args: {
            format: z.enum(["text", "markdown"]).optional().describe("書き出す形式。既定 text"),
            numerals: z.enum(["kanji", "arabic"]).optional().describe("見出しの数字。unit が「話」なら既定 arabic"),
            ruby: z.enum(RUBY_NOTATIONS).optional().describe("ルビ・傍点の記法。既定は text なら kakuyomu、markdown なら html"),
            fromChapter: z.number().int().positive().optional().describe("この話から書き出す。既定 1"),
            toChapter: z.number().int().positive().optional().describe("この話まで書き出す。既定は最後の話"),
            outputPath: z.string().optional().describe("書き出し先（作品ディレクトリ内の相対パス）"),
            unit: z.enum(CHAPTER_UNITS).optional().describe("見出しの単位（「話」か「章」）。既定は config.json の chapterUnit（無ければ「話」）"),
            split: z.boolean().optional().describe("true なら1話ずつ別ファイルに書き出す。既定 false"),
          },
          async execute(args, context) {
            return novelExportExecute(args as any, { projectDir: context.directory })
          },
        }),
      },
      config: async (config) => {
        const planner = createNovelPlannerAgent()
        const writer = createNovelWriterAgent()
        const editor = createNovelEditorAgent()
        planner.mode = "primary"
        writer.mode = "all"
        editor.mode = "primary"

        const userAgents = (config.agent ?? {}) as Record<string, Record<string, unknown>>
        config.agent = {
          ...userAgents,
          "novel-planner": mergeAgentConfig(planner, userAgents["novel-planner"]),
          "novel-writer": mergeAgentConfig(writer, userAgents["novel-writer"]),
          "novel-editor": mergeAgentConfig(editor, userAgents["novel-editor"]),
        } as typeof config.agent
        config.command = {
          ...config.command,
          ...cachedCommands,
        }
        ;(config as any).skills = {
          ...(config as any).skills,
          paths: [...((config as any).skills?.paths ?? []), skillsDir],
        }
      },
    }
  }
}
