import { existsSync } from "node:fs"
import { basename } from "node:path"
import {
  getNovelDir,
  getDocPath,
  getChaptersDir,
  getConfigPath,
  getNovelPath,
  safeReadFile,
  safeReadJson,
  listMarkdownFiles,
  countWords,
  progressBar,
  determinePhase,
  isDocFilled,
  isShortForm,
  isSerial,
  usesWorldBuilding,
  storyModeOf,
  storyModeLabel,
  seriousnessOf,
  seriousnessLabel,
  indentStyleOf,
  hasOutlineDetailed,
  hasSceneList,
  collectScenes,
  stripChapterHeading,
  sceneChapterNumber,
  toKanjiNumber,
  resolveLimit,
  listCharacterDocs,
} from "../core/utils.js"
import type { NovelConfig, Phase } from "../core/utils.js"
import {
  splitForeshadowEntries,
  summaryChapters,
  summaryGap,
  summarySections,
  formatChapterRanges,
  readForeshadowRecord,
  readCharacterStateRecord,
  readTextRecord,
  describeBrokenRecord,
} from "../core/records.js"
import {
  listManuscriptFiles,
  describeExtraSections,
  sectionLabel,
  sectionKey,
  sameSection,
  parseParts,
  partName,
  partRange,
} from "../core/sections.js"
import type { ManuscriptSection } from "../core/sections.js"
import { sourceWorkOf, hasCanonOverview } from "../core/canon.js"
import { parsePublishInfo, describePublishInfo, publishIssues } from "../core/publish.js"
import { DEFAULTS } from "../core/constants.js"
import { CONCEPT_TEMPLATE, WORLD_BUILDING_TEMPLATE, CHARACTER_PROFILES_TEMPLATE } from "../core/templates.js"
import { buildCharacterIndex } from "../core/character-names.js"
import { parseNameFields } from "../core/name-fields.js"
import { validatePovReferences } from "../core/pov.js"
import { normalizeCharacterState } from "../core/character-state.js"
import type { ToolRuntimeContext } from "./types.js"

export interface StatusArgs {
  detailed?: boolean
}

const PHASE_LABELS: Record<Phase, string> = {
  concept: "📝 企画づくり（concept）",
  "world-building": "🗺️ 舞台・設定づくり（world-building）",
  characters: "👤 キャラ設計（characters）",
  outline: "📋 プロットづくり（outline）",
  scenes: "🎬 シーン分割（任意）",
  writing: "✍️ 本文執筆（writing）",
  completed: "✅ 完結（completed）",
}

const PHASE_HINTS: Record<Phase, string> = {
  concept: "企画書（.novel/concept.md）でフック・面白さの柱・トーンとNGラインを固めましょう。",
  "world-building": "舞台・設定（.novel/world-building.md）を整えましょう。",
  characters: "登場人物（.novel/characters/）の魅力・掛け合い・ことばづかいを設計しましょう。",
  outline: "プロット概要と話別プロット（.novel/outline-brief.md / outline/）を作りましょう。",
  scenes: "必要ならシーン一覧を作り、準備ができたら本文を書き始めましょう。",
  writing: "次の話の本文を書き進めましょう。",
  completed: "予定の話数がそろいました。全体のレビューや投稿準備へ進みましょう。",
}

function serialHint(next: number, unit: string): string {
  return `第${next}${unit}の本文を書き進めましょう（話別プロットがまだなら先に足します。完結させるときはエピローグを書きます）。`
}

export async function novelStatusExecute(
  args: StatusArgs,
  ctx: ToolRuntimeContext,
): Promise<string> {
  const dir = ctx.projectDir
  const novelDir = getNovelDir(dir)

  if (!existsSync(novelDir)) {
    return `❌ 作品データが見つかりません。先に novel_init でプロジェクトを作ってください。`
  }

  const config = await safeReadJson<NovelConfig>(getConfigPath(dir))
  const phase = determinePhase(dir, config)
  const detailed = args.detailed ?? false
  const short = isShortForm(config)
  const serial = isSerial(config)
  const unit = config?.chapterUnit ?? DEFAULTS.chapterUnit
  const needsWorld = usesWorldBuilding(config)

  let report = `📊 作品の進行状況\n${"=".repeat(40)}\n\n`

  if (config) {
    report += `📖 タイトル: ${config.title}\n`
    report += `🏷️  ジャンル: ${config.genre}\n`
    report += `🧭 構成の型: ${storyModeLabel(storyModeOf(config))}\n`
    if (config.tone) report += `🎨 雰囲気・トーン: ${config.tone}\n`
    report += `🎚️  シリアス度: ${seriousnessLabel(seriousnessOf(config))}\n`
    report += `🎯 目標文字数: ${config.targetWords?.toLocaleString("ja-JP") ?? "未設定"}文字\n`
    if (short) {
      report += `📋 形式: 短編（${config.chapterCount && config.chapterCount > 1 ? `全${config.chapterCount}${unit}` : "1本の本文"}）\n`
    } else if (serial) {
      report += `📋 連載（結末未定）／話数の目安: ${config.chapterCount ? `全${config.chapterCount}${unit}` : "未設定"}\n`
    } else {
      report += `📋 予定${unit}数: ${config.chapterCount ? `全${config.chapterCount}${unit}` : "未設定"}\n`
    }
    report += `👁️  視点: ${config.narrativePerspective ?? DEFAULTS.narrativePerspective}\n`
    report += `✒️ 字下げ: ${indentStyleOf(config) === "none" ? "なし（Web小説スタイル）" : "全角1字下げ"}\n`
    const sourceWork = sourceWorkOf(config)
    if (sourceWork) report += `📚 二次創作: 原作『${sourceWork}』\n`
    report += `📅 開始日: ${new Date(config.createdAt).toLocaleDateString("ja-JP")}\n\n`
  }

  report += `📍 現在の段階: ${PHASE_LABELS[phase] ?? phase}\n`
  if (phase === "completed") {
    report += serial
      ? `   （連載で、エピローグを書いた状態です。記録の点検は下を参照）\n`
      : `   （予定の話数がそろった状態です。分量と記録の点検は下を参照）\n`
  }
  report += `\n`

  const worldExists = existsSync(getDocPath(dir, "world-building"))
  const stages: Array<{ label: string; done: boolean; template?: boolean; optional?: boolean }> = [
    {
      label: "作品企画書（concept.md）",
      done: isDocFilled(getDocPath(dir, "concept"), CONCEPT_TEMPLATE),
      template: existsSync(getDocPath(dir, "concept")),
    },
    ...(needsWorld || worldExists
      ? [{
          label: `舞台・設定（world-building.md${needsWorld ? "" : "・任意"}）`,
          done: isDocFilled(getDocPath(dir, "world-building"), WORLD_BUILDING_TEMPLATE),
          template: worldExists,
          optional: !needsWorld,
        }]
      : []),
    {
      label: "登場人物（characters/）",
      done: isDocFilled(getDocPath(dir, "characters"), CHARACTER_PROFILES_TEMPLATE),
      template: existsSync(getDocPath(dir, "characters")),
    },
    { label: "プロット概要（outline-brief.md）", done: existsSync(getDocPath(dir, "outline-brief")) },
    ...(!short ? [{ label: "話別プロット（outline/）", done: hasOutlineDetailed(dir) }] : []),
    ...(hasSceneList(dir) ? [{ label: "シーン一覧（任意）", done: true, optional: true }] : []),
  ]

  report += `📋 工程の進み具合:\n`
  for (const stage of stages) {
    let mark = stage.done ? "✅" : "⬜"
    if (!stage.done && stage.template) mark = "📝"
    report += `  ${mark} ${stage.label}\n`
  }
  report += `  （✅ 記入済み / 📝 雛形あり・未記入 / ⬜ 未作成）\n`
  if (!needsWorld && !worldExists && !short) {
    report += `  （舞台・設定は最小限設定のため省略中です。必要になったら追加できます）\n`
  }
  if (!hasSceneList(dir)) {
    report += `  （シーン分割は任意です。話別プロットがあればそのまま本文を書けます）\n`
  }

  const scenes = await collectScenes(dir)
  if (scenes.length > 0) {
    const completed = scenes.filter((s) => s.status === "completed").length
    const inProgress = scenes.filter((s) => s.status === "in-progress").length
    const total = scenes.length
    const sources = new Set(scenes.map((s) => s.source))

    report += `\n🎬 シーンの進捗:\n`
    report += `  ${progressBar(completed, total)}\n`
    if (inProgress > 0) report += `  🔄 執筆中: ${inProgress}シーン\n`
    if (sources.size > 1) report += `  📁 ${sources.size}ファイルから集計\n`
  }

  const chaptersDir = getChaptersDir(dir)
  const manuscriptFiles = await listManuscriptFiles(dir)
  const chapterFiles = manuscriptFiles.filter((f) => f.section.kind === "chapter")
  const extraFiles = manuscriptFiles.filter((f) => f.section.kind !== "chapter")
  const writtenChapters = chapterFiles.flatMap((f) => (f.section.kind === "chapter" ? [f.section.chapter] : []))
  const counted: Array<{ section: ManuscriptSection; file: string; words: number }> = []
  const unreadable: ManuscriptSection[] = []

  for (const f of manuscriptFiles) {
    const content = await safeReadFile(f.path)
    if (content === null) {
      unreadable.push(f.section)
      continue
    }
    const body = stripChapterHeading(content)
    counted.push({
      section: f.section,
      file: basename(f.path),
      words: countWords(body),
    })
  }

  const countedChapters = counted.filter((c) => c.section.kind === "chapter")
  const unreadableChapters = unreadable.flatMap((s) => (s.kind === "chapter" ? [s.chapter] : []))
  const unreadableExtras = unreadable.filter((s) => s.kind !== "chapter").map((s) => sectionLabel(s, unit))
  const totalWords = counted.reduce((sum, c) => sum + c.words, 0)
  const manuscriptFileNames = new Set(manuscriptFiles.map((f) => basename(f.path)))
  const otherFiles = (await listMarkdownFiles(chaptersDir)).filter((f) => !manuscriptFileNames.has(f))

  if (manuscriptFiles.length > 0) {
    const extras = describeExtraSections(extraFiles.map((f) => f.section))
    const extrasNote = extras ? `（ほかに${extras}）` : ""
    report +=
      unreadableChapters.length > 0
        ? `\n✍️ 執筆済み: 本文ファイル ${chapterFiles.length}${unit} ／ 集計できた本文 ${countedChapters.length}${unit}${extrasNote}\n`
        : `\n✍️ 執筆済み: ${chapterFiles.length}${unit}${extrasNote}\n`
    if (detailed) {
      for (const c of counted) {
        const name = c.section.kind === "chapter" ? "" : `（${sectionLabel(c.section, unit)}）`
        report += `  📄 ${c.file}${name}: ${c.words.toLocaleString("ja-JP")}文字\n`
      }
    }
    if (unreadable.length > 0) {
      const names = [...(unreadableChapters.length > 0 ? [formatChapterRanges(unreadableChapters, unit)] : []), ...unreadableExtras]
      report += `  ⚠️ 読み込めず数えていない${unit}: ${names.join("、")}\n`
    }
    report += `\n📊 累計: ${totalWords.toLocaleString("ja-JP")}文字`
    if (config?.targetWords) {
      const percent = Math.round((totalWords / config.targetWords) * 100)
      report += ` / ${config.targetWords.toLocaleString("ja-JP")}文字 (${percent}%${serial ? "。連載なので目安" : ""})`
    }
    if (counted.some((c) => c.section.kind !== "chapter")) report += `（${extras}を含む）`
    report += "\n"
    if (countedChapters.length > 0) {
      const chapterWords = countedChapters.reduce((sum, c) => sum + c.words, 0)
      const perChapter = Math.round(chapterWords / countedChapters.length)
      report += `📐 1${unit}平均: ${perChapter.toLocaleString("ja-JP")}文字\n`
    }
  }

  const parts = parseParts(config?.parts)
  if (parts && "parts" in parts) {
    const planned = config?.chapterCount ?? undefined
    report += `\n📚 部の進み具合:\n`
    for (const part of parts.parts) {
      const to = part.toChapter ?? Math.max(planned ?? part.fromChapter, part.fromChapter, ...writtenChapters)
      const total = Math.max(0, to - part.fromChapter + 1)
      const done = writtenChapters.filter((n) => n >= part.fromChapter && n <= to).length
      report += `  ${partName(part, "arabic", toKanjiNumber)}「${part.title}」（${partRange(part, to, unit)}）: ${done}/${total}${unit}\n`
    }
  }
  if (otherFiles.length > 0) {
    report += `ℹ️ chapters/ にある本文以外のファイルは数えていません: ${otherFiles.join("、")}\n`
  }

  const issues: string[] = []
  const characterDocs = await listCharacterDocs(dir)
  const index = buildCharacterIndex(characterDocs)
  issues.push(...await validatePovReferences(dir, config, index))
  for (const doc of characterDocs) for (const issue of parseNameFields(doc.content).issues) {
    issues.push(`${doc.canon ? "canon/characters" : "characters"}/${doc.label}.md:${issue.line}: ${issue.message}`)
  }
  const missingAliases = index.filter(c => !characterDocs.some(d => d.label.trim() === c.name && d.aliases.length > 0))
  if (missingAliases.length > 0) issues.push(`呼称が未記入の人物: ${missingAliases.map(c => c.name).join("、")}。シートの呼称欄に、本文で使う姓・名・あだ名を記入してください`)
  const foreshadowRecord = await readForeshadowRecord(getDocPath(dir, "foreshadow"))
  const { valid: foreshadowItems, invalid: brokenForeshadow } = splitForeshadowEntries(
    foreshadowRecord.kind === "ok" ? foreshadowRecord.value.items : [],
  )
  if (foreshadowRecord.kind === "broken") {
    report += `\n🎯 伏線: ⚠️ 記録を読めません（下の「記録の点検」を参照）\n`
    issues.push(`${describeBrokenRecord(".novel/foreshadow.json", foreshadowRecord)}。直すまで伏線の更新はできません`)
  } else if (foreshadowItems.length + brokenForeshadow.length > 0) {
    const count = (status: string) => foreshadowItems.filter((f) => f.status === status).length
    report += `\n🎯 伏線: 張り済み ${count("planted")} / 回収済み ${count("resolved")} / 未着手 ${count("pending")}`
    if (count("abandoned") > 0) report += ` / 取り下げ ${count("abandoned")}`
    if (brokenForeshadow.length > 0) report += ` / 形の崩れた記録 ${brokenForeshadow.length}`
    report += `\n`
  }

  const stateRecord = await readCharacterStateRecord(getDocPath(dir, "character-state"))
  if (stateRecord.kind === "ok") issues.push(...normalizeCharacterState(stateRecord.value, index).warnings)
  if (stateRecord.kind === "broken") {
    issues.push(`${describeBrokenRecord(".novel/characters/state.json", stateRecord)}。直すまで人物の状態の更新はできません`)
  }
  const summaryRecord = await readTextRecord(getDocPath(dir, "summary"))
  if (summaryRecord.kind === "broken") {
    issues.push(`${describeBrokenRecord(".novel/summary.md", summaryRecord)}。直すまであらすじの更新はできません`)
  }
  if (writtenChapters.length > 0) {
    if (summaryRecord.kind === "ok") {
      const gap = summaryGap(summaryRecord.value, Math.max(...writtenChapters) + 1, resolveLimit(config, "summary"))
      if (gap) {
        const upTo = gap.chapters[gap.chapters.length - 1]
        issues.push(
          `あらすじの「全体の流れ」が古くなっています: ${formatChapterRanges(gap.chapters, unit)}の出来事が、次の${unit}の資料に載りません` +
            `（${gap.coverage > 0 ? `全体の流れは第${gap.coverage}${unit}まで` : "全体の流れがまだ無い"}）。` +
            `novel_update(summary) に「## 全体の流れ」で始まる要約を渡し、第${upTo}${unit}まで更新してください`,
        )
      }
    }
    if (summaryRecord.kind !== "broken") {
      const recorded = new Set(summaryRecord.kind === "ok" ? summaryChapters(summaryRecord.value) : [])
      const missing = writtenChapters.filter((n) => !recorded.has(n))
      if (missing.length > 0) {
        issues.push(`あらすじの記録が無い${unit}: ${formatChapterRanges(missing, unit)}`)
      }
    }

    const allOpen: number[] = []
    const partlyOpen: string[] = []
    for (const n of writtenChapters) {
      const mine = scenes.filter((s) => sceneChapterNumber(s.id) === n)
      const open = mine.filter((s) => s.status !== "completed")
      if (open.length === 0) continue
      if (open.length === mine.length) allOpen.push(n)
      else partlyOpen.push(`第${n}${unit}（${open.map((s) => s.id).join(", ")}）`)
    }
    if (allOpen.length > 0 || partlyOpen.length > 0) {
      const p = [...(allOpen.length > 0 ? [`${formatChapterRanges(allOpen, unit)}（全シーン）`] : []), ...partlyOpen]
      issues.push(`本文はあるが、完了になっていないシーンが残っている${unit}: ${p.join("、")}（書いたシーンは状態を [x] に）`)
    }
  }
  if (extraFiles.length > 0 && summaryRecord.kind !== "broken") {
    const recorded = summaryRecord.kind === "ok" ? summarySections(summaryRecord.value) : []
    const missing = extraFiles.filter((f) => !recorded.some((r) => sameSection(r, f.section)))
    if (missing.length > 0) {
      issues.push(`あらすじの記録が無い節: ${missing.map((f) => sectionLabel(f.section, unit)).join("、")}`)
    }
  }
  if (stateRecord.kind !== "broken" && (writtenChapters.length > 0 || extraFiles.length > 0)) {
    const recorded = new Set(Object.keys(stateRecord.kind === "ok" ? stateRecord.value.sections : {}))
    const missingChapters = writtenChapters.filter((n) => !recorded.has(sectionKey({ kind: "chapter", chapter: n })))
    const missingExtras = extraFiles.filter((f) => !recorded.has(sectionKey(f.section))).map((f) => sectionLabel(f.section, unit))
    const missing = [...(missingChapters.length > 0 ? [formatChapterRanges(missingChapters, unit)] : []), ...missingExtras]
    if (missing.length > 0) {
      issues.push(`人物の状態の記録が無い${unit}・節: ${missing.join("、")}（変化が無ければ novel_update(character-state) に {"updates": []} を渡して記録済みにします）`)
    }
  }
  for (const x of brokenForeshadow) {
    issues.push(`伏線 ${x.id} の記録の形が崩れています: ${x.problems.join("、")}`)
  }

  const publishFile = await safeReadFile(getNovelPath(dir, "publish.md"))
  if (publishFile) {
    const info = parsePublishInfo(publishFile)
    const line = describePublishInfo(info)
    if (line) report += `\n📣 投稿用の情報: ${line}\n`
    issues.push(...publishIssues(info))
  }

  if (sourceWorkOf(config) && !(await hasCanonOverview(dir))) {
    issues.push("原作の資料がまだありません（.novel/canon/overview.md が雛形のまま、または無い）。基準にする範囲・分岐点・変えることを先に整えてください")
  }
  if (unreadableChapters.length > 0) {
    issues.push(`読み込めない${unit}があります: ${formatChapterRanges(unreadableChapters, unit)}`)
  }
  if (parts && "error" in parts) issues.push(parts.error)
  if (unreadableExtras.length > 0) {
    issues.push(`読み込めない節があります: ${unreadableExtras.join("、")}`)
  }
  if (config?.targetWords && phase === "completed" && !serial && totalWords < config.targetWords) {
    issues.push(`分量が目標に届いていません: ${totalWords.toLocaleString("ja-JP")} / ${config.targetWords.toLocaleString("ja-JP")}文字（${Math.round((totalWords / config.targetWords) * 100)}%）`)
  }
  if (issues.length > 0) {
    report += `\n🗂️ 記録の点検:\n`
    for (const issue of issues) report += `  ⚠️ ${issue}\n`
  }

  const hint =
    short && phase === "writing" && (config?.chapterCount ?? 1) === 1
      ? "本文を書き進めましょう。"
      : serial && phase === "writing"
        ? serialHint(Math.max(0, ...writtenChapters) + 1, unit)
        : (PHASE_HINTS[phase] ?? "")
  report += `\n💡 次の一手: ${hint}\n`

  return report
}
