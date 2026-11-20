import { waveformBinCount, waveformDetail } from '#shared/utils/waveform'

export const sampleRate = 44_100
const headerSize = 44

export function wavHeader(frames: number, channels: number) {
  const bytes = new Uint8Array(headerSize)
  const header = new DataView(bytes.buffer)
  bytes.set([82, 73, 70, 70])
  bytes.set([87, 65, 86, 69, 102, 109, 116, 32], 8)
  bytes.set([100, 97, 116, 97], 36)
  header.setUint32(4, 36 + frames * channels * 2, true)
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, channels, true)
  header.setUint32(24, sampleRate, true)
  header.setUint32(28, sampleRate * channels * 2, true)
  header.setUint16(32, channels * 2, true)
  header.setUint16(34, 16, true)
  header.setUint32(40, frames * channels * 2, true)
  return bytes
}

export function pcm16(value: number) {
  return Math.round(Math.max(-1, Math.min(1, value)) * 32_767)
}

export class InvalidLocalAudio extends Error {}

export async function decodeLocalAudio(file: Blob, signal: AbortSignal) {
  signal.throwIfAborted()
  const context = new OfflineAudioContext(2, 1, sampleRate)
  const audio = await context.decodeAudioData(await file.arrayBuffer()).catch(() => {
    throw new InvalidLocalAudio('Browser gagal membaca audio. Periksa file atau coba format WAV.')
  })
  signal.throwIfAborted()
  if (audio.duration > 600) throw new InvalidLocalAudio('Durasi lagu melebihi batas 10 menit.')
  if (!audio.length) throw new InvalidLocalAudio('File tidak berisi audio yang dapat dibaca.')
  let stereo = audio
  if (audio.numberOfChannels > 2) {
    const mixer = new OfflineAudioContext(2, audio.length, sampleRate)
    const source = mixer.createBufferSource()
    source.buffer = audio
    source.connect(mixer.destination)
    source.start()
    stereo = await mixer.startRendering()
  }
  const left = stereo.getChannelData(0)
  const right = stereo.numberOfChannels > 1 ? stereo.getChannelData(1) : left
  const parts: BlobPart[] = [wavHeader(audio.length, 2)]
  for (let from = 0; from < audio.length; from += sampleRate) {
    signal.throwIfAborted()
    const frames = Math.min(sampleRate, audio.length - from)
    const pcm = new DataView(new ArrayBuffer(frames * 4))
    for (let frame = 0; frame < frames; frame++) {
      pcm.setInt16(frame * 4, pcm16(left[from + frame]!), true)
      pcm.setInt16(frame * 4 + 2, pcm16(right[from + frame]!), true)
    }
    parts.push(pcm.buffer)
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return { wav: new Blob(parts, { type: 'audio/wav' }), durationMs: Math.max(1, Math.round(audio.duration * 1_000)) }
}

export async function readPcm(wav: Blob, first: number, end: number, channels = 2) {
  return new DataView(await wav.slice(headerSize + first * channels * 2, headerSize + end * channels * 2).arrayBuffer())
}

async function wavLayout(wav: Blob) {
  const header = new DataView(await wav.slice(0, headerSize).arrayBuffer())
  const channels = header.getUint16(22, true)
  const rate = header.getUint32(24, true)
  const frames = header.getUint32(40, true) / (channels * 2)
  return { channels, rate, frames }
}

export async function localWaveform(wav: Blob) {
  const { channels, rate, frames } = await wavLayout(wav)
  const durationMs = frames * 1_000 / rate
  const peaks = new Uint8Array(waveformBinCount(durationMs))
  for (let first = 0; first < frames; first += rate) {
    const pcm = await readPcm(wav, first, Math.min(frames, first + rate), channels)
    for (let frame = 0; frame < pcm.byteLength / (channels * 2); frame++) {
      const offset = frame * channels * 2
      const left = Math.abs(pcm.getInt16(offset, true))
      const right = channels === 2 ? Math.abs(pcm.getInt16(offset + 2, true)) : left
      const bin = Math.floor((first + frame) * peaks.length / frames)
      peaks[bin] = Math.max(peaks[bin]!, Math.round(Math.max(left, right) * 255 / 32_768))
    }
  }
  return { durationMs, peaks: Array.from(peaks) }
}

export async function localWaveformDetail(wav: Blob, fromMs: number, toMs: number, withPitch: boolean) {
  const { channels, rate, frames } = await wavLayout(wav)
  const first = Math.min(frames - 1, Math.round(fromMs * rate / 1_000))
  const end = Math.min(frames, Math.max(first + 1, Math.round(toMs * rate / 1_000)))
  const pcm = await readPcm(wav, first, end, channels)
  const samples = new Float32Array(end - first)
  for (let frame = 0; frame < samples.length; frame++) {
    const offset = frame * channels * 2
    const left = pcm.getInt16(offset, true)
    const right = channels === 2 ? pcm.getInt16(offset + 2, true) : left
    samples[frame] = (left + right) / 65_536
  }
  return waveformDetail(samples, rate, first * 1_000 / rate, withPitch)
}
