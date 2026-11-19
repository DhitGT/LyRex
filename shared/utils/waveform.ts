import { estimatePitch } from './pitch'

export interface Waveform {
  durationMs: number
  peaks: number[]
}

export interface WaveformDetail {
  minimums: number[]
  maximums: number[]
  pitch: { ms: number, hz: number }[]
}

export function waveformBinCount(durationMs: number) {
  return Math.max(1, Math.min(30_000, Math.ceil(durationMs / 10)))
}

export function waveformDetail(samples: Float32Array, sampleRate: number, startMs: number, withPitch: boolean): WaveformDetail {
  const count = Math.min(1_200, samples.length)
  const minimums = new Array<number>(count)
  const maximums = new Array<number>(count)
  for (let bin = 0; bin < count; bin++) {
    const start = Math.floor(bin * samples.length / count)
    const end = Math.floor((bin + 1) * samples.length / count)
    let min = 1
    let max = -1
    for (let index = start; index < end; index++) {
      min = Math.min(min, samples[index]!)
      max = Math.max(max, samples[index]!)
    }
    minimums[bin] = Math.round(min * 127)
    maximums[bin] = Math.round(max * 127)
  }

  const pitch: WaveformDetail['pitch'] = []
  if (withPitch) {
    const stride = Math.max(1, Math.round(sampleRate / 4_000))
    const pitchRate = sampleRate / stride
    const window = new Float32Array(Math.round(pitchRate * 0.04))
    const correlations = new Float32Array(Math.floor(pitchRate / 75) + 1)
    const step = Math.round(sampleRate * 0.02)
    const length = window.length * stride
    for (let from = 0; from + length <= samples.length; from += step) {
      let power = 0
      for (let index = 0; index < window.length; index++) {
        let sum = 0
        const offset = from + index * stride
        for (let inner = 0; inner < stride; inner++) sum += samples[offset + inner]!
        const value = sum / stride
        window[index] = value
        power += value * value
      }
      if (power / window.length < 0.00004) continue
      const hz = estimatePitch(window, pitchRate, correlations)
      if (hz >= 75 && hz <= 650) pitch.push({ ms: Math.round(startMs + (from + length / 2) * 1_000 / sampleRate), hz: Math.round(hz) })
    }
  }
  return { minimums, maximums, pitch }
}
