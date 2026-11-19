import type { LyricLine } from '#shared/utils/lyrics'
import { estimatePitch } from '#shared/utils/pitch'

const frameMs = 10
const maximumShiftMs = 140
const transitionThreshold = 0.38

async function analyzeVocals(audio: AudioBuffer, channel: 'mix' | 'left' | 'right', signal: AbortSignal) {
  const left = audio.getChannelData(0)
  const right = audio.getChannelData(Math.min(1, audio.numberOfChannels - 1))
  const samplesPerFrame = Math.round(audio.sampleRate * frameMs / 1_000)
  const frameCount = Math.floor(audio.length / samplesPerFrame)
  const energy = new Float32Array(frameCount)
  const pitch = new Float32Array(frameCount)
  const cutoffs = [140, 300, 650, 1_400, 2_800]
  const filters = new Float32Array(cutoffs.length)
  const coefficients = cutoffs.map(frequency => 1 - Math.exp(-2 * Math.PI * frequency / audio.sampleRate))
  const bands = new Float32Array(cutoffs.length + 1)
  const spectrum = new Float32Array(frameCount * bands.length)
  const pitchStride = Math.max(1, Math.round(audio.sampleRate / 4_000))
  const pitchRate = audio.sampleRate / pitchStride
  const pitchWindow = new Float32Array(Math.round(pitchRate * 0.04))
  const correlations = new Float32Array(Math.floor(pitchRate / 75) + 1)
  const sampleAt = (i: number) => channel === 'left' ? left[i]! : channel === 'right' ? right[i]! : (left[i]! + right[i]!) / 2

  for (let frame = 0; frame < frameCount; frame++) {
    if (frame % 256 === 0) {
      signal.throwIfAborted()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    bands.fill(0)
    let power = 0
    const start = frame * samplesPerFrame
    const end = start + samplesPerFrame
    for (let i = start; i < end; i++) {
      const sample = sampleAt(i)
      power += sample * sample
      let low = 0
      for (let band = 0; band < filters.length; band++) {
        const filtered = filters[band]! + coefficients[band]! * (sample - filters[band]!)
        filters[band] = filtered
        bands[band]! += (filtered - low) ** 2
        low = filtered
      }
      bands[filters.length]! += (sample - low) ** 2
    }
    energy[frame] = 10 * Math.log10(Math.max(1e-9, power / samplesPerFrame))
    if (energy[frame]! > -60) {
      const total = bands.reduce((sum, value) => sum + value, 0)
      for (let band = 0; band < bands.length; band++) {
        spectrum[frame * bands.length + band] = bands[band]! / total
      }
      // Center the longer pitch window on this frame. Average samples before decimating.
      const pitchStart = Math.round(start + (samplesPerFrame - pitchWindow.length * pitchStride) / 2)
      if (pitchStart >= 0 && pitchStart + pitchWindow.length * pitchStride <= audio.length) {
        for (let i = 0; i < pitchWindow.length; i++) {
          let sum = 0
          for (let j = 0; j < pitchStride; j++) sum += sampleAt(pitchStart + i * pitchStride + j)
          pitchWindow[i] = sum / pitchStride
        }
        pitch[frame] = estimatePitch(pitchWindow, pitchRate, correlations)
      }
    }
  }
  signal.throwIfAborted()

  function transition(frame: number, kind: 'onset' | 'offset' | 'between') {
    const before = (energy[frame - 2]! + energy[frame - 1]!) / 2
    const after = (energy[frame]! + energy[frame + 1]!) / 2
    if (Math.max(before, after) < -55) return 0
    const rise = after - before
    // A word at a phrase edge needs a clear attack or release.
    if (kind !== 'between') return Math.max(0, (kind === 'onset' ? rise : -rise) - 5) / 18

    let spectralChange = 0
    if (Math.min(before, after) > -55) {
      for (let band = 0; band < bands.length; band++) {
        const at = (frame - 2) * bands.length + band
        const hop = bands.length
        spectralChange += Math.abs(spectrum[at]! + spectrum[at + hop]! - spectrum[at + 2 * hop]! - spectrum[at + 3 * hop]!) / 2
      }
    }
    const beforePitch = pitch[frame - 2]!
    const afterPitch = pitch[frame + 1]!
    const pitchChange = beforePitch && afterPitch ? Math.abs(Math.log2(afterPitch / beforePitch)) : 0
    // Require an energy or spectral transition before pitch can contribute.
    const energyChange = after < -55 ? 0 : Math.abs(rise)
    const acousticChange = Math.min(1, Math.max(0, energyChange - 3) / 20) + spectralChange
    return acousticChange * (1 + Math.min(0.35, pitchChange))
  }

  function refineBoundary(expected: number, min: number, max: number, kind: Parameters<typeof transition>[1]) {
    const first = Math.max(2, Math.ceil(Math.max(min, expected - maximumShiftMs) / frameMs))
    const last = Math.min(frameCount - 2, Math.floor(Math.min(max, expected + maximumShiftMs) / frameMs))
    let score = transitionThreshold
    let result = expected
    for (let frame = first; frame <= last; frame++) {
      const ms = frame * frameMs
      const candidate = transition(frame, kind) - 0.25 * Math.abs(ms - expected) / maximumShiftMs
      if (candidate > score) {
        score = candidate
        result = ms
      }
    }
    return result
  }

  function pauseBefore(start: number, minimum: number) {
    const frame = Math.round(start / frameMs)
    if (energy[frame] === undefined || energy[frame]! < -48) return start
    const quiet = Math.min(-42, energy[frame]! - 18)
    const first = Math.ceil(minimum / frameMs)
    let edge = frame
    while (edge > first && energy[edge - 1]! < quiet) edge--
    return frame - edge >= 3 ? edge * frameMs : start
  }

  return { refineBoundary, pauseBefore }
}

export async function refineVocalTiming(lines: LyricLine[], audio: AudioBuffer, channel: 'mix' | 'left' | 'right',
  signal: AbortSignal) {
  if (!lines.some(line => line.words?.length)) return { lines, changed: false }
  const { refineBoundary, pauseBefore } = await analyzeVocals(audio, channel, signal)
  let changed = false
  const refined = lines.map(line => {
    if (!line.words?.length) return line
    const words = line.words.map(word => ({ ...word }))
    for (let index = 0; index < words.length; index++) {
      const word = words[index]!
      const original = line.words[index]!
      const previous = words[index - 1]
      const touching = line.words[index - 1]?.endMs === original.startMs
      const minimum = previous
        ? touching
          ? previous.startMs + Math.min(50, original.startMs - previous.startMs)
          : previous.endMs
        : line.startMs
      const halfDuration = Math.ceil((original.endMs - original.startMs) / 2)
      const boundary = refineBoundary(original.startMs, minimum, original.endMs - halfDuration,
        touching ? 'between' : 'onset')
      if (previous && touching) previous.endMs = pauseBefore(boundary, Math.max(minimum, original.startMs - maximumShiftMs))
      word.startMs = boundary
      // A contiguous pair shares a boundary, refined when processing the next word.
      const next = line.words[index + 1]
      if (next?.startMs !== original.endMs) {
        word.endMs = refineBoundary(original.endMs, Math.max(word.startMs + 1, original.startMs + halfDuration),
          next?.startMs ?? line.endMs, 'offset')
      }
    }
    if (words.every((word, index) => word.startMs === line.words![index]!.startMs && word.endMs === line.words![index]!.endMs)) {
      return line
    }
    changed = true
    return { ...line, words }
  })
  return { lines: refined, changed }
}
