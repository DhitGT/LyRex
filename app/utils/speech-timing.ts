import type { LyricLine } from '#shared/utils/lyrics'

interface TimeRange {
  startMs: number
  endMs: number
}

export interface SpeechWindow extends TimeRange {
  fromMs: number
  toMs: number
}

export interface SpeechPhrase {
  text: string
  speechStartMs?: number
  speechEndMs?: number
  firstInterim?: { atMs: number, wordCount: number }
}

const frameMs = 20
const pauseFrames = 35
const preferredFrames = 250
const maximumFrames = 325
const paddingMs = 120
const eventDelayMs = 180

export async function speechWindows(audio: AudioBuffer, durationMs: number, channel: 'mix' | 'left' | 'right',
  isVocalStem: boolean, signal: AbortSignal): Promise<SpeechWindow[]> {
  const endMs = Math.min(durationMs, Math.round(audio.duration * 1_000))
  const frameSamples = Math.round(audio.sampleRate * frameMs / 1_000)
  const endSample = Math.min(audio.length, Math.round(endMs * audio.sampleRate / 1_000))
  const energy = new Float32Array(Math.ceil(endSample / frameSamples))
  const left = audio.getChannelData(0)
  const right = audio.getChannelData(Math.min(1, audio.numberOfChannels - 1))
  for (let frame = 0; frame < energy.length; frame++) {
    if (frame % 1_024 === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      signal.throwIfAborted()
    }
    let power = 0
    const start = frame * frameSamples
    const stop = Math.min(endSample, start + frameSamples)
    for (let i = start; i < stop; i++) {
      const sample = channel === 'left' ? left[i]! : channel === 'right' ? right[i]! : (left[i]! + right[i]!) / 2
      power += sample * sample
    }
    energy[frame] = 10 * Math.log10(Math.max(1e-10, power / (stop - start)))
  }
  if (!energy.length) return []

  const sorted = isVocalStem ? energy.slice().sort() : undefined
  const threshold = sorted ? Math.max(-56, Math.min(-43, sorted[Math.floor(sorted.length * 0.9)]! - 30)) : -58
  const spans: TimeRange[] = []
  let first = -1
  let last = -1
  function closeSpan() {
    if (first < 0) return
    for (let start = first; start <= last;) {
      let stop = last + 1
      if (stop - start > maximumFrames) {
        const target = start + preferredFrames
        const limit = start + maximumFrames
        let best = Infinity
        for (let cut = target - 35; cut <= limit; cut++) {
          const score = Math.max(energy[cut - 1]!, energy[cut]!, energy[cut + 1] ?? energy[cut]!) +
            Math.abs(cut - target) / 12
          if (score < best) {
            best = score
            stop = cut
          }
        }
      }
      spans.push({ startMs: start * frameMs, endMs: Math.min(endMs, stop * frameMs) })
      start = stop
    }
    first = -1
  }
  for (let frame = 0; frame < energy.length; frame++) {
    if (energy[frame]! < threshold) continue
    if (frame - last > pauseFrames) closeSpan()
    if (first < 0) first = frame
    last = frame
  }
  closeSpan()
  return spans.map((span, index) => ({
    ...span,
    fromMs: Math.max(spans[index - 1]?.endMs ?? 0, span.startMs - paddingMs),
    toMs: Math.min(spans[index + 1]?.startMs ?? endMs, span.endMs + paddingMs)
  }))
}

export function timeSpeechPhrases(phrases: SpeechPhrase[], range: TimeRange): LyricLine[] {
  const tokens = phrases.map(phrase => phrase.text.split(' '))
  const weight = (word: string) => Math.min(8, Math.max(2, word.replace(/[^\p{L}\p{N}]/gu, '').length))
  const counts = new Array<number>(phrases.length + 1).fill(0)
  const weights = new Array<number>(phrases.length + 1).fill(0)
  for (let index = phrases.length - 1; index >= 0; index--) {
    counts[index] = counts[index + 1]! + tokens[index]!.length
    weights[index] = weights[index + 1]! + tokens[index]!.reduce((sum, word) => sum + weight(word), 0)
  }
  if (range.endMs - range.startMs < counts[0]!) {
    // Ultra-short ranges can hold the transcript without timestamping each token.
    const text = phrases.map(phrase => phrase.text).join(' ')
    return text && range.endMs > range.startMs ? [{ ...range, text, needsReview: true }] : []
  }

  function onset(phrase: SpeechPhrase | undefined) {
    if (!phrase) return undefined
    const detected = phrase.speechStartMs === undefined ? undefined : phrase.speechStartMs - eventDelayMs
    if (!phrase.firstInterim) return detected
    const { atMs, wordCount } = phrase.firstInterim
    // Interim text already includes audio heard before the callback arrived.
    const estimated = atMs - 700 - Math.min(1_800, wordCount * 350)
    return detected ?? estimated
  }

  let cursor = range.startMs
  return phrases.map((phrase, index): LyricLine => {
    const words = tokens[index]!
    const latestEnd = range.endMs - counts[index + 1]!
    const startMs = Math.max(cursor, Math.min(latestEnd - words.length, onset(phrase) ?? cursor))
    const ownWeight = weights[index]! - weights[index + 1]!
    const proportionalEnd = startMs + Math.round((range.endMs - startMs) * ownWeight / weights[index]!)
    const nextStart = onset(phrases[index + 1])
    const detectedEnd = phrase.speechEndMs !== undefined && phrase.speechEndMs < range.endMs - paddingMs
      ? phrase.speechEndMs - eventDelayMs : undefined
    const earliestEnd = startMs + words.length
    let endMs = detectedEnd !== undefined && detectedEnd >= earliestEnd ? detectedEnd : proportionalEnd
    if (nextStart !== undefined && nextStart >= earliestEnd) {
      endMs = detectedEnd === undefined ? nextStart : Math.min(endMs, nextStart)
    }
    endMs = Math.max(earliestEnd, Math.min(latestEnd, endMs))
    cursor = endMs
    let passedWeight = 0
    let wordStart = startMs
    return {
      text: phrase.text, startMs, endMs, needsReview: true,
      words: words.map((text, slot) => {
        passedWeight += weight(text)
        const available = endMs - startMs - words.length
        const wordEnd = startMs + slot + 1 + Math.round(available * passedWeight / ownWeight)
        const word = { text, startMs: wordStart, endMs: wordEnd }
        wordStart = wordEnd
        return word
      })
    }
  })
}
