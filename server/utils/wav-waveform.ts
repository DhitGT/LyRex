import { open } from 'node:fs/promises'
import { waveformBinCount, waveformDetail } from '../../shared/utils/waveform.ts'
import type { Waveform, WaveformDetail } from '../../shared/utils/waveform.ts'

type DetailRange = { fromMs: number, toMs: number, pitch: boolean }
type ReadWavBytes = (buffer: Buffer, offset: number, length: number) => Promise<void>

export async function readWavWaveform(path: string, range?: DetailRange): Promise<Waveform | WaveformDetail> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    async function read(buffer: Buffer, offset: number, length: number) {
      let filled = 0
      while (filled < length) {
        const { bytesRead } = await file.read(buffer, filled, length - filled, offset + filled)
        if (!bytesRead) throw new Error('Incomplete WAV data')
        filled += bytesRead
      }
    }
    return await readWaveform(size, read, range)
  } finally {
    await file.close()
  }
}

export async function readWaveform(size: number, read: ReadWavBytes, range?: DetailRange): Promise<Waveform | WaveformDetail> {
  const header = Buffer.alloc(16)
  await read(header, 0, 12)
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV header')
  }
  let channels = 0
  let sampleRate = 0
  for (let offset = 12; offset + 8 <= size;) {
    await read(header, offset, 8)
    const kind = header.toString('ascii', 0, 4)
    const length = header.readUInt32LE(4)
    const start = offset + 8
    if (length > size - start) throw new Error('Incomplete WAV chunk')
    if (kind === 'fmt ' && length >= 16) {
      await read(header, start, 16)
      channels = header.readUInt16LE(2)
      sampleRate = header.readUInt32LE(4)
      if (header.readUInt16LE(0) !== 1 || header.readUInt16LE(14) !== 16 ||
        (channels !== 1 && channels !== 2) || !sampleRate) throw new Error('Unsupported WAV format')
    }
    if (kind === 'data' && sampleRate) {
      const frameBytes = channels * 2
      const frames = Math.floor(length / frameBytes)
      if (!frames) throw new Error('Empty WAV data')
      if (range) {
        const first = Math.min(frames - 1, Math.round(range.fromMs * sampleRate / 1_000))
        const end = Math.min(frames, Math.max(first + 1, Math.round(range.toMs * sampleRate / 1_000)))
        const pcm = Buffer.allocUnsafe((end - first) * frameBytes)
        await read(pcm, start + first * frameBytes, pcm.length)
        const samples = new Float32Array(end - first)
        for (let frame = 0; frame < samples.length; frame++) {
          const left = pcm.readInt16LE(frame * frameBytes)
          const right = channels === 2 ? pcm.readInt16LE(frame * frameBytes + 2) : left
          samples[frame] = (left + right) / 65_536
        }
        return waveformDetail(samples, sampleRate, range.fromMs, range.pitch)
      }
      const durationMs = frames * 1_000 / sampleRate
      const binCount = waveformBinCount(durationMs)
      const peaks = new Uint8Array(binCount)
      const chunk = Buffer.allocUnsafe(256 * 1024)
      for (let frame = 0; frame < frames;) {
        const count = Math.min(frames - frame, chunk.length / frameBytes)
        await read(chunk, start + frame * frameBytes, count * frameBytes)
        for (let index = 0; index < count; index++) {
          const value = Math.abs(chunk.readInt16LE(index * frameBytes))
          const amplitude = channels === 2 ? Math.max(value, Math.abs(chunk.readInt16LE(index * frameBytes + 2))) : value
          const bin = Math.floor((frame + index) * binCount / frames)
          const peak = Math.round(amplitude * 255 / 32_768)
          if (peak > peaks[bin]!) peaks[bin] = peak
        }
        frame += count
      }
      return { durationMs, peaks: Array.from(peaks) }
    }
    offset = start + length + length % 2
  }
  throw new Error('Missing WAV data')
}
