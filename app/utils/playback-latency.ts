export const minimumOffsetMs = -300
export const maximumOffsetMs = 700
export const latencyStorageKey = 'lyrex-earphone-offset-ms'
export const testClickMs = 450
const testLoopMs = 1_400

export function audioOffset(value: number) {
  return Number.isFinite(value) ? Math.max(minimumOffsetMs, Math.min(maximumOffsetMs, Math.round(value))) : 0
}

export function visualPlaybackMs(mediaMs: number, offsetMs: number, playbackRate: number) {
  return Math.max(0, mediaMs - offsetMs * playbackRate)
}

export function latencyTestFlash(mediaMs: number, offsetMs: number) {
  const position = visualPlaybackMs(mediaMs, offsetMs, 1)
  return position >= testClickMs && position < testClickMs + 100
}

export function latencyTestAudio() {
  const sampleRate = 24_000
  const frames = sampleRate * testLoopMs / 1_000
  const wav = new ArrayBuffer(44 + frames * 2)
  const header = new DataView(wav)
  const bytes = new Uint8Array(wav)
  const encoder = new TextEncoder()
  bytes.set(encoder.encode('RIFF'))
  header.setUint32(4, wav.byteLength - 8, true)
  bytes.set(encoder.encode('WAVEfmt '), 8)
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, 1, true)
  header.setUint32(24, sampleRate, true)
  header.setUint32(28, sampleRate * 2, true)
  header.setUint16(32, 2, true)
  header.setUint16(34, 16, true)
  bytes.set(encoder.encode('data'), 36)
  header.setUint32(40, frames * 2, true)

  const first = sampleRate * testClickMs / 1_000
  const clickFrames = Math.round(sampleRate * .03)
  for (let index = 0; index < clickFrames; index++) {
    const time = index / sampleRate
    const envelope = Math.min(1, time / .002) * (1 - index / clickFrames) ** 2
    const tone = Math.sin(time * 2 * Math.PI * 1_100)
    header.setInt16(44 + (first + index) * 2, Math.round(5_600 * envelope * tone), true)
  }
  return new Blob([wav], { type: 'audio/wav' })
}
