/**
 * Assistant-message content parsing (ticket 07) — the small markdown subset
 * the planner's replies use (PRD AI 对话栏: 标题、加粗、列表、行内 POI 链接)
 * plus POI-link segmentation.
 *
 * Pure domain, no React: `parseAssistantContent` returns typed blocks/spans
 * the ChatPanel renders, so Node tests can assert the parse without a
 * browser. Deliberately NOT a full markdown engine — the model is prompted
 * to keep replies short and structured, and anything unparseable degrades to
 * plain text (tolerant-read convention).
 */
import type { ChatPoiLink } from './chat'

export type InlineSpan =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'poi'; text: string; poi: ChatPoiLink }

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; spans: InlineSpan[] }
  | { kind: 'list-item'; ordered: boolean; marker: string; spans: InlineSpan[] }
  | { kind: 'paragraph'; spans: InlineSpan[] }

/**
 * Parse an assistant message into renderable blocks, turning occurrences of
 * the `poiLinks` names inside the text into POI spans (click → map focus).
 */
export function parseAssistantContent(content: string, poiLinks: ChatPoiLink[] = []): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed)
    if (heading) {
      const level = Math.min(3, Math.max(1, heading[1]?.length ?? 1)) as 1 | 2 | 3
      blocks.push({ kind: 'heading', level, spans: parseInline(heading[2] ?? '', poiLinks) })
      continue
    }
    const unordered = /^[-*•]\s+(.*)$/.exec(trimmed)
    if (unordered) {
      blocks.push({ kind: 'list-item', ordered: false, marker: '•', spans: parseInline(unordered[1] ?? '', poiLinks) })
      continue
    }
    const ordered = /^(\d{1,2})[.、]\s*(.*)$/.exec(trimmed)
    if (ordered) {
      blocks.push({
        kind: 'list-item',
        ordered: true,
        marker: `${ordered[1]}.`,
        spans: parseInline(ordered[2] ?? '', poiLinks),
      })
      continue
    }
    blocks.push({ kind: 'paragraph', spans: parseInline(trimmed, poiLinks) })
  }
  return blocks
}

/**
 * Split one line into inline spans: `**bold**` runs and POI names
 * (longest-first so "海拉尔国家森林公园" wins over "海拉尔"; earliest
 * occurrence wins when candidates overlap the same stretch of text).
 */
function parseInline(text: string, poiLinks: ChatPoiLink[]): InlineSpan[] {
  const spans: InlineSpan[] = []
  for (const segment of splitPoiSegments(text, poiLinks)) {
    if (segment.poi) {
      spans.push({ kind: 'poi', text: segment.text, poi: segment.poi })
      continue
    }
    spans.push(...splitBold(segment.text))
  }
  return spans.filter((span) => span.text !== '')
}

/** Non-overlapping POI name segments, earliest match first. */
function splitPoiSegments(
  text: string,
  poiLinks: ChatPoiLink[],
): { text: string; poi?: ChatPoiLink }[] {
  if (poiLinks.length === 0 || text === '') return [{ text }]
  const names = [...new Set(poiLinks.map((poi) => poi.name))].sort((a, b) => b.length - a.length)
  const matches: { start: number; end: number; poi: ChatPoiLink }[] = []
  for (const name of names) {
    let searchFrom = 0
    for (;;) {
      const at = text.indexOf(name, searchFrom)
      if (at === -1) break
      const end = at + name.length
      const overlapped = matches.some((m) => at < m.end && end > m.start)
      if (!overlapped) matches.push({ start: at, end, poi: poiLinks.find((poi) => poi.name === name) as ChatPoiLink })
      searchFrom = end
    }
  }
  if (matches.length === 0) return [{ text }]
  matches.sort((a, b) => a.start - b.start)
  const segments: { text: string; poi?: ChatPoiLink }[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start) })
    segments.push({ text: text.slice(match.start, match.end), poi: match.poi })
    cursor = match.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments
}

/** Split plain text on `**bold**` runs. */
function splitBold(text: string): InlineSpan[] {
  const spans: InlineSpan[] = []
  const pattern = /\*\*(.+?)\*\*/g
  let cursor = 0
  for (;;) {
    const match = pattern.exec(text)
    if (match === null) break
    if (match.index > cursor) spans.push({ kind: 'text', text: text.slice(cursor, match.index) })
    spans.push({ kind: 'bold', text: match[1] ?? '' })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) spans.push({ kind: 'text', text: text.slice(cursor) })
  return spans
}
