import { spawn } from 'node:child_process'
import { open, readFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import ffmpegBinary from 'ffmpeg-static'
import type { ReportProgress } from './protocol.ts'

export const SAMPLE_RATE = 44_100
const MAX_SECONDS = 600
const demuxers = new Map([['mp3', 'mp3'], ['wav', 'wav'], ['m4a', 'mov']])

function runFfmpeg(args: string[], signal: AbortSignal, onTime?: (ms: number) => void) {
  const executable = process.env.LYREX_FFMPEG || ffmpegBinary
  if (typeof executable !== 'string' || !executable) throw new Error('FFmpeg executable is unavailable')
  return new Promise<{ code: number | null, stderr: string }>((resolve, reject) => {
    const child = spawn(executable, ['-nostdin', '-loglevel', 'error', ...args], { windowsHide: true, signal })
    let error: Error | undefined
    let stderr = ''
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      const match = /^out_time_us=(\d+)$/.exec(line)
      if (match) onTime?.(Number(match[1]) / 1_000)
    })
    child.stderr.setEncoding('utf8').on('data', data => { stderr = (stderr + data).slice(-4_096) })
    child.on('error', failure => { error = failure })
    child.once('close', code => error ? reject(error) : resolve({ code, stderr }))
  })
}

export async function decodeAudio(directory: string, extension: string, signal: AbortSignal, report: ReportProgress) {
  const demuxer = demuxers.get(extension)
  if (!demuxer) throw new Error('Unsupported audio extension')
  const temporary = resolve(directory, 'original.tmp.wav')
  let lastProgress = -5_000
  const result = await runFfmpeg([
    '-xerror', '-progress', 'pipe:1', '-protocol_whitelist', 'file', '-f', demuxer,
    '-i', resolve(directory, 'upload'), '-map', '0:a:0', '-map_metadata', '-1',
    '-ac', '2', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le',
    '-t', String(MAX_SECONDS + 1), '-y', temporary
  ], signal, ms => {
    if (ms - lastProgress < 5_000) return
    lastProgress = ms
    report({ key: 'decode', message: `FFmpeg sudah membaca ${Math.floor(ms / 1_000)} detik audio` })
  })
  if (result.code !== 0) {
    console.error('[LyRex] FFmpeg gagal membaca atau mendekode file audio', result.stderr)
    return { error: 'Audio rusak atau formatnya tidak sesuai dengan ekstensi file.' }
  }
  const audio = await readFile(temporary)
  const frames = wavData(audio).length / 4
  if (frames < 1) return { error: 'File tidak berisi audio yang dapat dibaca.' }
  if (frames > MAX_SECONDS * SAMPLE_RATE) return { error: 'Durasi lagu melebihi batas 10 menit.' }
  await rename(temporary, resolve(directory, 'original.wav'))
  return { durationMs: Math.max(1, Math.round(frames * 1_000 / SAMPLE_RATE)) }
}

export function wavData(wav: Buffer) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid PCM WAV header')
  }
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4)
    if (size > wav.length - offset - 8) throw new Error('Incomplete PCM WAV data')
    if (wav.toString('ascii', offset, offset + 4) === 'data') return wav.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size % 2)
  }
  throw new Error('Missing WAV data')
}

export async function openVocalWav(path: string, frames: number) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(frames * 4 + 36, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(frames * 4, 40)
  const file = await open(path, 'w')
  try {
    await file.writeFile(header)
    return file
  } catch (error) {
    await file.close()
    throw error
  }
}

