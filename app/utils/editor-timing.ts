import type { LyricLine } from '#shared/utils/lyrics'
import type { Waveform } from '#shared/utils/waveform'
import { estimateWordsFromLines } from './align-lyrics'

function waveformActivity({ peaks, durationMs }: Waveform) {
  const binMs = durationMs / peaks.length
  const step = (ms: number) => Math.max(1, Math.round(ms / binMs))
  const prefix = new Float64Array(peaks.length + 1)
  peaks.forEach((peak, index) => { prefix[index + 1] = prefix[index]! + peak })
  function mean(from: number, to: number) {
    const start = Math.max(0, from)
    const end = Math.min(peaks.length, to)
    return end > start ? (prefix[end]! - prefix[start]!) / (end - start) : 0
  }

  const sorted = [...peaks].sort((a, b) => a - b)
  const level = sorted[Math.floor(sorted.length * 0.92)] || sorted.at(-1) || 0
  const floor = Math.max(2, level * 0.12)
  const active: number[] = []
  const onsets: { ms: number, strength: number }[] = []
  const recent = step(140)
  const gap = step(25)
  const after = step(80)
  const smoothing = step(25)
  for (let index = 0; index < peaks.length; index++) {
    const ms = Math.round(index * binMs)
    if (mean(index - smoothing, index + smoothing + 1) >= floor) active.push(ms)
    const before = mean(index - recent, index - gap)
    const next = mean(index, index + after)
    const rise = next - before
    if (next < floor || rise < Math.max(3, level * 0.14, before * 0.7)) continue
    const strength = Math.min(1, rise / Math.max(1, level * 0.65))
    const previous = onsets.at(-1)
    if (!previous || ms - previous.ms >= 140) onsets.push({ ms, strength })
    else if (strength > previous.strength) onsets[onsets.length - 1] = { ms, strength }
  }
  return { active, onsets, binMs }
}

function onsetNear(onsets: ReturnType<typeof waveformActivity>['onsets'], time: number, radius: number,
  minimum = 0, maximum = Infinity) {
  let low = 0
  let high = onsets.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (onsets[middle]!.ms < Math.max(minimum, time - radius)) low = middle + 1
    else high = middle
  }
  let best = { ms: time, score: 0 }
  for (let index = low; index < onsets.length; index++) {
    const { ms, strength } = onsets[index]!
    if (ms > Math.min(maximum, time + radius)) break
    const score = strength * (1 - Math.abs(ms - time) / (radius + 1))
    if (score > best.score) best = { ms, score }
  }
  return best
}

function referenceOffset(lines: LyricLine[], onsets: ReturnType<typeof waveformActivity>['onsets']) {
  if (lines.length < 3) return 0
  function evaluate(offset: number) {
    let score = 0
    const nearby = new Set<number>()
    for (const line of lines) {
      const match = onsetNear(onsets, line.startMs + offset, 180)
      if (match.score >= 0.28) {
        score += match.score
        nearby.add(match.ms)
      }
    }
    return { score: score - Math.abs(offset) / 3_000, count: nearby.size }
  }
  let offset = 0
  const baseline = evaluate(0).score
  let best = baseline + Math.max(0.45, lines.length * 0.09)
  for (let candidate = -3_000; candidate <= 3_000; candidate += 50) {
    const { score, count } = evaluate(candidate)
    if (score <= best || count < Math.max(3, Math.ceil(lines.length * 0.45))) continue
    offset = candidate
    best = score
  }
  return offset
}

export function retimeLyricLine(line: LyricLine, startMs: number, endMs: number): LyricLine {
  const updated = { ...line, startMs, endMs }
  if (!line.words?.length || (startMs === line.startMs && endMs === line.endMs)) return updated
  if (endMs - startMs < line.words.length) return { ...updated, words: undefined }
  const scale = (ms: number) => startMs + Math.round((ms - line.startMs) * (endMs - startMs) / (line.endMs - line.startMs))
  let previousEnd = startMs
  const words = line.words.map((word, index) => {
    const latestEnd = endMs - (line.words!.length - index - 1)
    const start = Math.max(previousEnd, Math.min(latestEnd - 1, scale(word.startMs)))
    previousEnd = Math.max(start + 1, Math.min(latestEnd, scale(word.endMs)))
    return { text: word.text, startMs: start, endMs: previousEnd }
  })
  return { ...updated, words }
}

function syncWords(line: LyricLine, onsets: ReturnType<typeof waveformActivity>['onsets']): LyricLine {
  const words = line.words?.map(word => ({ ...word }))
  if (!words?.length) return line
  words.forEach((word, index) => {
    const previous = words[index - 1]
    const touching = previous?.endMs === word.startMs
    if (word.startMs === line.startMs) return
    const minimum = previous ? touching
      ? previous.startMs + Math.ceil((previous.endMs - previous.startMs) / 2) : previous.endMs
      : line.startMs
    const maximum = word.endMs - Math.ceil((word.endMs - word.startMs) / 2)
    const match = onsetNear(onsets, word.startMs, 140, minimum, maximum)
    if (match.score < 0.32) return
    word.startMs = match.ms
    if (previous && touching) previous.endMs = match.ms
  })
  return { ...line, words }
}

export function syncLyricsToWaveform(waveform: Waveform, durationMs: number, rows: string[],
  anchors?: LyricLine[], useReferenceOffset = false) {
  if (!rows.length || rows.length > Math.min(durationMs, 1_000) || rows.some(text => text.length > 1_000)) return undefined
  const activity = waveformActivity(waveform)
  if (!activity.active.length) return undefined
  const { active, onsets, binMs } = activity
  const weights = rows.map(text => text.split(/\s+/).length)
  const totalWeight = weights.reduce((sum, value) => sum + value, 0)
  const offsetMs = useReferenceOffset && anchors ? referenceOffset(anchors, onsets) : 0
  let nextWeight = 0
  const estimates = rows.map((text, index) => {
    const priorWeight = nextWeight
    nextWeight += weights[index]!
    const anchor = anchors?.[index]
    if (anchor) return { ...anchor, text }
    const first = Math.floor(priorWeight / totalWeight * active.length)
    const last = Math.max(first, Math.ceil(nextWeight / totalWeight * active.length) - 1)
    const startMs = active[first]!
    return { text, startMs, endMs: Math.min(durationMs, Math.round(active[last]! + binMs)),
      timingSource: 'interpolated' as const }
  })
  const starts: number[] = []
  const radius = anchors ? (useReferenceOffset ? 275 : 500) : 250
  for (let index = 0; index < estimates.length; index++) {
    const minimum = (starts[index - 1] ?? -1) + 1
    const maximum = Math.min(durationMs - estimates.length + index,
      Math.max(minimum, (estimates[index + 1]?.startMs ?? durationMs - offsetMs) + offsetMs - 1))
    const target = Math.max(minimum, Math.min(maximum, estimates[index]!.startMs + offsetMs))
    const onset = onsetNear(onsets, target, radius, minimum, maximum)
    starts.push(onset.score >= 0.24 ? onset.ms : target)
  }
  const lines = estimates.map((line, index) => {
    const start = starts[index]!
    const end = Math.max(start + 1, Math.min(starts[index + 1] ?? durationMs,
      line.endMs + (anchors ? start - line.startMs : 0)))
    return { ...retimeLyricLine(line, start, end), needsReview: true }
  })
  return { lines: (estimateWordsFromLines(lines) ?? lines).map(line => syncWords(line, onsets)), offsetMs }
}
