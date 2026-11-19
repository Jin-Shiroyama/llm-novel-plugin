/**
 * llm-novel-plugin - 雛形から書いた文書を、節ごとに執筆用の資料へ載せる
 *
 * 企画書（concept.md）と舞台・設定（world-building.md）を「## 」見出しごとに分け、
 * novel_context が clipDocParts で枠を配れる形（DocPart）にする。
 *
 *   - 大事な節に priority を立てて先に枠を配る
 *     ・concept.md: フック・面白さ（読者体験）・トーンとNGライン・語りと文体
 *     ・world-building.md: ルール・ギミック・能力・約束ごと
 *   - 雛形から書き換えていない節は載せない
 *   - 書きかけの節からは雛形のまま残った記入欄（角括弧）だけを外す
 */

import type { DocPart } from "./utils.js"

const PLACEHOLDER = /\[[^\]\n]+\]/

const normalizeLine = (line: string) => line.replace(/\s+$/, "").trim()

interface SectionPartsOptions {
  fileLabel: string
  priority?: RegExp
  skip?: RegExp
}

/** 舞台・設定を節ごとに分ける。ルール・ギミック・能力・約束ごとに先に枠を配る */
export function worldBuildingParts(content: string, template: string): DocPart[] {
  return templateDocParts(content, template, {
    fileLabel: "world-building.md",
    priority: /ルール|ギミック|能力|約束ごと|仕組み/,
  })
}

/**
 * 企画書（concept.md）を節ごとに分ける。
 * 本文のノリ・面白さ・シリアス度暴走防止に直結する
 * 「フック」「面白さ」「トーン」「NG」「語り」「文体」に先に枠を配る。
 * 「基本情報」は作品情報（config.json）と同じなので載せない。
 */
export function conceptParts(content: string, template: string): DocPart[] {
  return templateDocParts(content, template, {
    fileLabel: "concept.md",
    priority: /フック|面白さ|トーン|NG|語り|文体/,
    skip: /^基本情報/,
  })
}

export function templateDocParts(content: string, template: string, opts: SectionPartsOptions): DocPart[] {
  const exact = new Set<string>()
  const patterns: RegExp[] = []
  for (const line of template.split("\n").map(normalizeLine)) {
    if (line.length === 0) continue
    if (/\{\w+\}/.test(line)) {
      const pattern = line.split(/\{\w+\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")
      patterns.push(new RegExp(`^${pattern}$`))
    } else {
      exact.add(line)
    }
  }
  const isTemplateLine = (line: string) => {
    const l = normalizeLine(line)
    return exact.has(l) || patterns.some((p) => p.test(l))
  }

  const sections: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }]
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) {
      sections.push({ heading: h[1], lines: [] })
      continue
    }
    if (sections.length === 1 && /^#\s/.test(line)) continue
    sections[sections.length - 1].lines.push(line)
  }

  const parts: DocPart[] = []
  for (const { heading, lines } of sections) {
    if (heading !== null && opts.skip?.test(heading)) continue
    const written = lines.filter((l) => normalizeLine(l).length > 0)
    if (written.every(isTemplateLine)) continue
    const body = tidy(lines.filter((l) => !(isTemplateLine(l) && PLACEHOLDER.test(l))))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
    if (body.length === 0) continue
    parts.push(
      heading === null
        ? { label: opts.fileLabel, content: body }
        : { label: heading, content: body, ...(opts.priority?.test(heading) ? { priority: true } : {}) },
    )
  }
  return parts
}

const isTableLine = (line: string) => line.trim().startsWith("|")
const isSeparatorRow = (line: string) => /^\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/.test(line.trim())
const headingLevel = (line: string) => line.match(/^(#{3,6})\s/)?.[1].length ?? 0

function tidy(lines: string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!isTableLine(lines[i])) {
      kept.push(lines[i])
      continue
    }
    let end = i
    while (end < lines.length && isTableLine(lines[end])) end++
    const rows = lines.slice(i, end)
    if (rows.filter((r, k) => k > 0 && !isSeparatorRow(r)).length > 0) kept.push(...rows)
    i = end - 1
  }

  const out: string[] = []
  let hasBody = false
  let nextLevel = 0
  for (let i = kept.length - 1; i >= 0; i--) {
    const level = headingLevel(kept[i])
    if (level === 0) {
      if (kept[i].trim().length > 0) hasBody = true
      out.unshift(kept[i])
      continue
    }
    const empty = !hasBody && (nextLevel === 0 || nextLevel <= level)
    if (!empty) {
      out.unshift("#" + kept[i])
      nextLevel = level
    }
    hasBody = false
  }
  return out
}
