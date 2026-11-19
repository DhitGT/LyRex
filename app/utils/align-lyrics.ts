import type { LyricLine, LyricWord, LyricsSearchResult } from '#shared/utils/lyrics'

function tokenize(text: string) {
  return text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu) || []
}

function oneEditApart(a: string, b: string) {
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false
  const [short, long] = a.length > b.length ? [b, a] : [a, b]
  let i = 0
  let j = 0
  let edited = false
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++
      j++
    } else {
      if (edited) return false
      edited = true
      if (short.length === long.length) i++
      j++
    }
  }
  return long.length - j <= (edited ? 0 : 1)
}

interface WordAnchor {
  slot: number
  start: number
  end: number
}

function mapWords(text: string[], startMs: number, endMs: number, anchors: WordAnchor[], minimum = 1): LyricWord[] {
  const bySlot = new Map<number, WordAnchor>()
  for (const anchor of anchors) {
    const current = bySlot.get(anchor.slot)
    bySlot.set(anchor.slot, current
      ? { slot: anchor.slot, start: Math.min(current.start, anchor.start), end: Math.max(current.end, anchor.end) }
      : anchor)
  }

  const result: LyricWord[] = []
  let cursor = startMs
  function add(slot: number, start: number, end: number) {
    const latestEnd = endMs - (text.length - slot - 1) * minimum
    const wordStartMs = Math.max(cursor, Math.min(latestEnd - minimum, Math.round(start)))
    const wordEndMs = Math.max(wordStartMs + minimum, Math.min(latestEnd, Math.round(end)))
    result.push({ text: text[slot]!, startMs: wordStartMs, endMs: wordEndMs })
    cursor = wordEndMs
  }

  let slot = 0
  while (slot < text.length) {
    const anchor = bySlot.get(slot)
    if (anchor) {
      add(slot, anchor.start, anchor.end)
      slot++
      continue
    }
    const first = slot
    let next = first + 1
    while (next < text.length && !bySlot.has(next)) next++
    const start = cursor
    const stop = Math.min(endMs, bySlot.get(next)?.start ?? endMs)
    const step = Math.max(0, (stop - start) / (next - first))
    for (; slot < next; slot++) {
      add(slot, start + step * (slot - first), start + step * (slot - first + 1))
    }
  }
  return result
}

export function estimateWordsFromLines(lines: LyricLine[]) {
  let added = false
  const result = lines.map(line => {
    if (line.words?.length) return line
    const words = line.text.trim().split(/\s+/)
    if (!words[0] || line.endMs - line.startMs < words.length) return line
    added = true
    return { ...line, words: mapWords(words, line.startMs, line.endMs, []) }
  })
  return added ? result : undefined
}

export function alignSyncedLyrics(reference: LyricsSearchResult, durationMs: number,
  requireMatchingDuration = true): LyricLine[] | undefined {
  if (!reference.syncedLyrics || (requireMatchingDuration &&
    (!(reference.duration > 0) || Math.abs(reference.duration * 1_000 - durationMs) > 2_000))) {
    return undefined
  }
  const cues = new Map<number, string>()
  const timestamp = /\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g
  for (const row of reference.syncedLyrics.split(/\r?\n/)) {
    const tags = row.trim().match(/^(?:\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]\s*)+/)?.[0]
    if (!tags) continue
    const text = row.trim().slice(tags.length).replace(/\s+/g, ' ').trim()
    if (text.length > 1_000) return undefined
    for (const [, minute, second, fraction] of tags.matchAll(timestamp)) {
      const startMs = Number(minute) * 60_000 + Number(second) * 1_000 + Number((fraction ?? '').padEnd(3, '0'))
      if (startMs >= durationMs) {
        if (text) return undefined
        continue
      }
      const prior = cues.get(startMs)
      // Distinct sung lines at one timestamp cannot be represented on a single lyric timeline.
      if (prior && text && prior !== text) return undefined
      cues.set(startMs, prior || text)
    }
  }
  const ordered = [...cues].sort(([a], [b]) => a - b)
  const lines = ordered.flatMap(([startMs, text], index): LyricLine[] => {
    if (!tokenize(text).length) return []
    const words = text.split(' ')
    const next = ordered[index + 1]?.[0] ?? durationMs
    const endMs = Math.min(next, startMs + Math.min(8_000, Math.max(2_500, words.length * 650)))
    if (endMs - startMs < words.length) return []
    return [{ text, startMs, endMs, words: mapWords(words, startMs, endMs, []), needsReview: true }]
  })
  if (!lines.length || lines.length > 1_000 || lines.length !== ordered.filter(([, text]) => tokenize(text).length).length) {
    return undefined
  }
  return lines
}

export function alignLyrics(reference: string, recognized: LyricLine[], durationMs: number) {
  const rows = reference.split(/\r?\n/).map(text => text.trim())
    .filter(text => text && !/^\[[^\]]+\]$/.test(text) && tokenize(text).length)
  if (!rows.length || rows.length > Math.min(durationMs, 1_000) || rows.some(text => text.length > 1_000)) return undefined

  const wordsByRow = rows.map(text => text.split(/\s+/))
  const expected = wordsByRow.flatMap((words, row) =>
    words.flatMap((text, slot) => tokenize(text).map(word => ({ word, row, slot }))))
  const heard = recognized.flatMap(line => line.words?.length ? line.words : [line]).flatMap(({ text, startMs, endMs }) => {
    const words = tokenize(text)
    const step = (endMs - startMs) / words.length
    return words.map((word, index) => ({ word, start: startMs + step * index, end: startMs + step * (index + 1) }))
  })
  if (!heard.length || expected.length > 2_500 || heard.length > 2_500) return undefined
  const wordCount = wordsByRow.reduce((count, words) => count + words.length, 0)
  if (wordCount > durationMs || wordCount > 2_500) return undefined
  const minimumWordMs = Math.min(90, Math.floor(durationMs / wordCount))
  const minimumLineMs = wordsByRow.map(words => words.length * minimumWordMs)

  // Keep matches in song order so repeated choruses can map to different occurrences.
  const width = heard.length + 1
  const trace = new Uint8Array((expected.length + 1) * width)
  let previous = new Int16Array(width)
  let current = new Int16Array(width)
  for (let i = 1; i <= expected.length; i++) {
    const token = expected[i - 1]!
    const word = token.word
    for (let j = 1; j < width; j++) {
      const candidate = heard[j - 1]!
      const exact = word === candidate.word
      const next = expected[i]
      const nextHeard = heard[j]
      const phrase = exact && next?.row === token.row && nextHeard?.word === next.word &&
        nextHeard.start - candidate.end < 900 && Math.max(word.length, next.word.length) >= 4
      const match = exact ? (word.length >= 4 ? 5 : 2) + (phrase ? 3 : 0) : oneEditApart(word, candidate.word) ? 2 : 0
      const skipExpected = previous[j]!
      const skipHeard = current[j - 1]!
      const paired = previous[j - 1]! + match
      if (match && paired > skipExpected && paired > skipHeard) {
        current[j] = paired
        trace[i * width + j] = 3
      } else if (skipExpected >= skipHeard) {
        current[j] = skipExpected
        trace[i * width + j] = 1
      } else {
        current[j] = skipHeard
        trace[i * width + j] = 2
      }
    }
    const completed = current
    current = previous
    previous = completed
  }

  const matches = rows.map((): (WordAnchor & { word: string })[] => [])
  for (let i = expected.length, j = heard.length; i > 0 && j > 0;) {
    const direction = trace[i * width + j]
    if (direction === 3) {
      const { row, slot } = expected[i - 1]!
      matches[row]!.push({ ...heard[j - 1]!, slot })
      i--
      j--
    } else if (direction === 1) i--
    else j--
  }
  const anchors = matches.flatMap((words, row) => {
    const first = words.at(-1)
    const last = words[0]
    if (!first || !last || words.length < Math.max(2, Math.ceil(tokenize(rows[row]!).length / 3)) ||
      !words.some(word => word.word.length >= 4) ||
      last.end - first.start > Math.min(12_000, Math.max(4_500, (last.slot - first.slot + 1) * 1_400))) return []
    const mean = Math.min(700, (last.end - first.start) / (last.slot - first.slot + 1))
    return [{
      row,
      start: Math.max(0, first.start - mean * first.slot),
      end: Math.min(durationMs, last.end + mean * (wordsByRow[row]!.length - 1 - last.slot)),
      words
    }]
  })
  if (anchors.length < Math.min(2, rows.length) || anchors.length < Math.ceil(rows.length * 0.2)) return undefined

  const firstAnchor = anchors[0]!
  const lastAnchor = anchors.at(-1)!
  const typicalLine = Math.min(4_000, Math.max(800,
    (lastAnchor.start - firstAnchor.start) / Math.max(1, lastAnchor.row - firstAnchor.row) || 2_000))
  let nextAnchor = 0
  const estimates = rows.map((_, row) => {
    while (nextAnchor < anchors.length && anchors[nextAnchor]!.row < row) nextAnchor++
    const next = anchors[nextAnchor]
    const prior = nextAnchor > 0 ? anchors[nextAnchor - 1] : undefined
    if (next?.row === row) return next
    if (prior) {
      const available = Math.max(0, (next?.start ?? durationMs) - prior.end)
      const slots = (next?.row ?? rows.length) - prior.row - 1
      const spacing = next ? available / slots : Math.min(typicalLine, available / slots)
      const start = prior.end + (row - prior.row - 1) * spacing
      return { row, start, end: start + Math.min(typicalLine, spacing) }
    }
    const spacing = Math.min(typicalLine, firstAnchor.start / firstAnchor.row)
    const start = firstAnchor.start - (firstAnchor.row - row) * spacing
    return { row, start, end: start + spacing }
  })

  // Reserve room for unrecognized rows before their following anchors.
  const starts = estimates.map(estimate => Math.round(estimate.start))
  let nextStart = durationMs
  for (let row = starts.length - 1; row >= 0; row--) {
    starts[row] = Math.max(0, Math.min(starts[row]!, nextStart - minimumLineMs[row]!))
    nextStart = starts[row]!
  }
  for (let row = 1; row < starts.length; row++) {
    starts[row] = Math.max(starts[row]!, starts[row - 1]! + minimumLineMs[row - 1]!)
  }
  const wordAnchors = new Map(anchors.map(anchor => [anchor.row, anchor.words]))
  const lines = rows.map((text, row): LyricLine => {
    const startMs = starts[row]!
    const endMs = Math.max(startMs + minimumLineMs[row]!,
      Math.min(starts[row + 1] ?? durationMs, Math.round(estimates[row]!.end)))
    const anchors = wordAnchors.get(row)
    return {
      text, startMs, endMs, needsReview: true,
      timingSource: anchors ? undefined : 'interpolated',
      words: mapWords(wordsByRow[row]!, startMs, endMs, anchors || [], minimumWordMs)
    }
  })
  return { lines, matchedLines: anchors.length }
}
