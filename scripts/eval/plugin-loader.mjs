/**
 * 評価対象のプラグイン（--plugin-root）とスキルを読み込むローダー
 *
 * 新旧どちらのコミット（worktree）にも存在する個別ビルド出力パス
 * （dist/tools/*.js, dist/adapters/opencode/agents/novel-writer.js, dist/core/{prompts,records}.js）
 * を直接 import することで、dist/tools/index.js が存在しない旧コミットとも同一手順で比較できる。
 *
 * また dist/ と skills/ の全ファイル SHA-256 指紋を算出し、src/ の更新時刻が dist/ より
 * 新しい場合（ビルドし忘れ）は実行前に検知して停止する。
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"

/** Phase 3-2（no-ban-list）で表 A の代わりに差し込む固定の肯定原則文面 */
export const NO_BAN_LIST_PRINCIPLE =
  "感情や空気をできあいのラベルや定型表現で説明せず、キャラ固有の視線・手元の動き・声色・具体的な音や情景で描く。"

/**
 * novel-writing/SKILL.md から「表 A の禁止語列挙」と「書き比べの ❌ 悪文例」を除去する。
 *
 * 行番号には依存せず、見出しと ❌ 目印で範囲を特定する。
 * 目印が見つからない場合は黙って元の内容を返さず必ず例外を投げる。
 */
export function transformNovelWritingSkillNoBanList(markdown) {
  const normalized = markdown.replace(/\r\n/g, "\n")

  // 1. ### A. 〜 ### B. の範囲を特定
  const secAMatch = /^### A\.[^\n]*$/m.exec(normalized)
  const secBMatch = /^### B\.[^\n]*$/m.exec(normalized)
  if (!secAMatch || !secBMatch || secBMatch.index <= secAMatch.index) {
    throw new Error("no-ban-list 変換に失敗しました: novel-writing/SKILL.md に「### A.」と「### B.」の見出しが見つかりません")
  }

  const secAHeadingEnd = secAMatch.index + secAMatch[0].length
  const secABody = normalized.slice(secAHeadingEnd, secBMatch.index)

  // 2. 注記（> 避ける表現を毎回べつの決まり文句...）を抽出し、括弧内の語列挙のみ外す
  const noteMatch = /^> 避ける表現を毎回べつの決まり文句[^\n]*$/m.exec(secABody)
  if (!noteMatch) {
    throw new Error(
      "no-ban-list 変換に失敗しました: 「### A.」内に「> 避ける表現を毎回べつの決まり文句」の注記が見つかりません",
    )
  }
  const originalNote = noteMatch[0]
  const strippedNote = originalNote.replace(/（「[^」]+」[^）]*）/g, "")
  if (strippedNote === originalNote) {
    throw new Error(
      "no-ban-list 変換に失敗しました: 注記内の具体語列挙（「…」…）を検出できませんでした",
    )
  }

  const replacementSecA = `\n\n${NO_BAN_LIST_PRINCIPLE}\n\n${strippedNote}\n\n`
  let updated = normalized.slice(0, secAHeadingEnd) + replacementSecA + normalized.slice(secBMatch.index)

  // 3. ## 三、書き比べ 内の ❌ 悪文例（❌ 見出し＋直後の > 引用ブロック）を除去
  const sec3Match = /^## 三、[^\n]*$/m.exec(updated)
  if (!sec3Match) {
    throw new Error("no-ban-list 変換に失敗しました: 「## 三、」の見出しが見つかりません")
  }
  const afterSec3 = updated.slice(sec3Match.index + sec3Match[0].length)
  const nextSecMatch = /^## [^\n]*$/m.exec(afterSec3)
  const sec3Start = sec3Match.index
  const sec3End = nextSecMatch ? sec3Match.index + sec3Match[0].length + nextSecMatch.index : updated.length
  const sec3Text = updated.slice(sec3Start, sec3End)

  let removedBadExamples = 0
  const badExampleBlockPattern = /^❌ \*\*[^\n]*\*\*\n(?:>[^\n]*\n)+\n*/gm
  const cleanedSec3 = sec3Text.replace(badExampleBlockPattern, () => {
    removedBadExamples++
    return ""
  })
  if (removedBadExamples === 0) {
    throw new Error("no-ban-list 変換に失敗しました: 「## 三、」内に ❌ 悪文例ブロックが見つかりません")
  }

  updated = updated.slice(0, sec3Start) + cleanedSec3 + updated.slice(sec3End)
  return { text: updated, removedBadExamples }
}

/** ディレクトリ配下のファイルを再帰収集する（相対パス POSIX 昇順） */
function collectFilesSorted(baseDir, extFilter = null) {
  if (!existsSync(baseDir)) return []
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        if (extFilter && !extFilter(entry.name)) continue
        const rel = relative(baseDir, full).split(sep).join("/")
        out.push({ full, rel })
      }
    }
  }
  walk(baseDir)
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/** ディレクトリ配下の全ファイルの決定論的 SHA-256 指紋を算出する */
export function computeDirectoryFingerprint(dirPath, extFilter = null) {
  const files = collectFilesSorted(dirPath, extFilter)
  const hash = createHash("sha256")
  for (const f of files) {
    hash.update(`FILE:${f.rel}\n`, "utf-8")
    hash.update(readFileSync(f.full))
    hash.update("\n", "utf-8")
  }
  return {
    hash: files.length > 0 ? hash.digest("hex") : null,
    fileCount: files.length,
  }
}

/** src/ と dist/ の更新時刻を比べ、ビルドし忘れ（src/ > dist/）を検知する */
export function checkDistFreshness(rootDir) {
  const srcDir = join(rootDir, "src")
  const distDir = join(rootDir, "dist")
  const srcFiles = collectFilesSorted(srcDir, (n) => n.endsWith(".ts"))
  const distFiles = collectFilesSorted(distDir, (n) => n.endsWith(".js"))

  if (distFiles.length === 0) {
    return {
      stale: true,
      reason: `dist/ にビルド済み .js ファイルがありません（${rootDir} で pnpm build を実行してください）`,
      newestSrcPath: srcFiles[0]?.rel ?? null,
      newestSrcMtimeMs: null,
      newestDistMtimeMs: null,
    }
  }
  if (srcFiles.length === 0) {
    return { stale: false, reason: null, newestSrcPath: null, newestSrcMtimeMs: null, newestDistMtimeMs: null }
  }

  let newestSrcMtimeMs = 0
  let newestSrcPath = null
  for (const f of srcFiles) {
    const mtime = statSync(f.full).mtimeMs
    if (mtime > newestSrcMtimeMs) {
      newestSrcMtimeMs = mtime
      newestSrcPath = f.rel
    }
  }

  let newestDistMtimeMs = 0
  for (const f of distFiles) {
    const mtime = statSync(f.full).mtimeMs
    if (mtime > newestDistMtimeMs) newestDistMtimeMs = mtime
  }

  // 1秒の余裕（ファイルシステム時刻粒度の微小揺れ対策）
  const stale = newestSrcMtimeMs > newestDistMtimeMs + 1000
  return {
    stale,
    reason: stale
      ? `src/${newestSrcPath}（${new Date(newestSrcMtimeMs).toISOString()}）が dist/（${new Date(newestDistMtimeMs).toISOString()}）より新しいため、ビルドが古い可能性があります`
      : null,
    newestSrcPath,
    newestSrcMtimeMs,
    newestDistMtimeMs,
  }
}

/** 対象リポジトリの git commit と未コミット変更有無を取得する */
export function readGitInfo(rootDir) {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    const statusOut = execFileSync("git", ["status", "--porcelain"], {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return {
      commit,
      shortCommit: commit.slice(0, 7),
      dirty: statusOut.length > 0,
    }
  } catch {
    return { commit: null, shortCommit: null, dirty: null }
  }
}

async function importBuiltModule(rootDir, relPath) {
  const full = join(rootDir, relPath)
  if (!existsSync(full)) {
    throw new Error(
      `ビルド済みモジュールが見つかりません: ${full}\n対象ディレクトリ（${rootDir}）で \`pnpm build\` を実行してから再試行してください。`,
    )
  }
  return import(pathToFileURL(full).href)
}

/**
 * 指定された pluginRoot（作業ツリーまたは旧コミットの worktree）から
 * ツール実行関数・書き手エージェント定義・記録更新プロンプト／スキーマ例・スキル・指紋を読み込む。
 */
export async function loadPluginFromRoot(pluginRoot, opts = {}) {
  const rootDir = resolve(pluginRoot)
  const skillsDir = opts.skillsDir ? resolve(opts.skillsDir) : join(rootDir, "skills")
  const skillVariant = opts.skillVariant ?? "default"
  const allowStaleDist = Boolean(opts.allowStaleDist)

  if (skillVariant !== "default" && skillVariant !== "no-ban-list") {
    throw new Error(`未対応の skill-variant です: ${skillVariant}（default または no-ban-list を指定してください）`)
  }

  const freshness = checkDistFreshness(rootDir)
  if (freshness.stale && !allowStaleDist) {
    throw new Error(
      `${freshness.reason}。対象ディレクトリ（${rootDir}）で \`pnpm build\` を実行してから再試行してください（意図的にそのまま測る場合のみ --allow-stale-dist を指定）。`,
    )
  }

  const distFp = computeDirectoryFingerprint(join(rootDir, "dist"))
  const skillsFp = computeDirectoryFingerprint(skillsDir)
  const combinedHash = createHash("sha256")
    .update(`dist:${distFp.hash ?? "none"}\nskills:${skillsFp.hash ?? "none"}\nvariant:${skillVariant}`, "utf-8")
    .digest("hex")

  const [contextMod, saveMod, trackMod, statusMod, writerMod, promptsMod, recordsMod] = await Promise.all([
    importBuiltModule(rootDir, "dist/tools/context.js"),
    importBuiltModule(rootDir, "dist/tools/save.js"),
    importBuiltModule(rootDir, "dist/tools/track.js"),
    importBuiltModule(rootDir, "dist/tools/status.js"),
    importBuiltModule(rootDir, "dist/adapters/opencode/agents/novel-writer.js"),
    importBuiltModule(rootDir, "dist/core/prompts.js"),
    importBuiltModule(rootDir, "dist/core/records.js"),
  ])

  const writerAgent = writerMod.createNovelWriterAgent()

  function readSkill(skillName) {
    const path = join(skillsDir, skillName, "SKILL.md")
    if (!existsSync(path)) {
      throw new Error(`スキルファイルが見つかりません: ${path}`)
    }
    const raw = readFileSync(path, "utf-8")
    if (skillName === "novel-writing" && skillVariant === "no-ban-list") {
      return transformNovelWritingSkillNoBanList(raw).text
    }
    return raw
  }

  return {
    rootDir,
    skillsDir,
    skillVariant,
    git: readGitInfo(rootDir),
    artifacts: {
      distHash: distFp.hash,
      distFileCount: distFp.fileCount,
      skillsHash: skillsFp.hash,
      skillsFileCount: skillsFp.fileCount,
      combinedHash,
      staleDistBypassed: freshness.stale && allowStaleDist,
    },
    tools: {
      novelContextExecute: contextMod.novelContextExecute,
      novelSaveChapterExecute: saveMod.novelSaveChapterExecute,
      novelUpdateExecute: trackMod.novelUpdateExecute,
      novelStatusExecute: statusMod.novelStatusExecute,
    },
    writerAgent: {
      prompt: String(writerAgent.prompt ?? ""),
      temperature: typeof writerAgent.temperature === "number" ? writerAgent.temperature : 0.75,
    },
    prompts: {
      CHARACTER_STATE_UPDATE_PROMPT: promptsMod.CHARACTER_STATE_UPDATE_PROMPT,
      SUMMARY_UPDATE_PROMPT: promptsMod.SUMMARY_UPDATE_PROMPT,
    },
    records: {
      CHARACTER_STATE_KEYS: recordsMod.CHARACTER_STATE_KEYS,
      CHARACTER_STATE_EXAMPLE: recordsMod.CHARACTER_STATE_EXAMPLE,
      FORESHADOW_KEYS: recordsMod.FORESHADOW_KEYS,
      FORESHADOW_EXAMPLE: recordsMod.FORESHADOW_EXAMPLE,
    },
    readSkill,
  }
}
