import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { get, put } from '@vercel/blob'
import { extractionActive } from '../shared/utils/lyrics.ts'
import { readWavWaveform } from '../server/utils/wav-waveform.ts'
import { projectPath, readCloudProject, updateCloudRun, withLog } from './cloud-project.ts'
import type { VersionedProject } from './cloud-project.ts'
import type { WorkerProgress } from './protocol.ts'

const [owner, id, runId] = process.argv.slice(2)
if (!owner || !id || !runId) throw new Error('Missing project arguments')
const prefix = projectPath({ owner, id })
const directory = resolve('work')
const controller = new AbortController()
process.once('SIGTERM', () => controller.abort())
const signal = controller.signal

async function download(pathname: string, localFile: string) {
  const blob = await get(pathname, { access: 'private', abortSignal: signal })
  if (!blob || blob.statusCode !== 200) throw new Error('Audio is missing from Blob')
  await pipeline(blob.stream, createWriteStream(localFile), { signal })
}

async function publish(source: 'original' | 'vocals') {
  const file = resolve(directory, source + '.wav')
  const pathname = `${prefix}${runId}/${source}.wav`
  await put(pathname, createReadStream(file), {
    access: 'private', contentType: 'audio/wav', multipart: true, abortSignal: signal,
  })
  const waveform = await readWavWaveform(file)
  await put(pathname + '.waveform.json', JSON.stringify(waveform), {
    access: 'private', contentType: 'application/json', abortSignal: signal,
  })
  return pathname
}

async function change(patch: Partial<VersionedProject>, log: WorkerProgress) {
  const job = await updateCloudRun(owner!, id!, runId!, current =>
    extractionActive(current.phase) ? withLog({ ...current, ...patch }, log) : current)
  if (!job || job.phase === 'cancelled') {
    controller.abort()
    signal.throwIfAborted()
  }
  return job
}

let progress = Promise.resolve()
let lastProgress = 0
function report(log: WorkerProgress) {
  if (Date.now() - lastProgress < 3_000) return
  lastProgress = Date.now()
  progress = progress.then(async () => { await change({}, log) }).catch(error => {
    if (!signal.aborted) console.error('[LyRex] Gagal menyimpan progres', error)
  })
}

async function run() {
  let job = await readCloudProject(owner!, id!)
  if (!job || job.run?.id !== runId || !extractionActive(job.phase)) return
  await mkdir(directory, { recursive: true })
  try {
    if (!job.originalAudio || !job.durationMs) {
      job = await change({ phase: 'validating' }, { key: 'decode', message: 'Memeriksa audio lewat FFmpeg.' })
      await download(prefix + 'upload', resolve(directory, 'upload'))
      const { decodeAudio } = await import('./audio.ts')
      const result = await decodeAudio(directory, job.extension, signal, report)
      await progress
      if (!result.durationMs) {
        const error = result.error || 'Durasi audio tidak dapat dibaca.'
        await change({ phase: 'failed', invalidAudio: true, error }, { key: 'failed', message: error })
        return
      }
      const originalAudio = await publish('original')
      job = await change({ durationMs: result.durationMs, originalAudio }, {
        key: 'validated', message: 'Audio asli siap digunakan.',
      })
    } else if (!job.useOriginal && !job.hasVocals) {
      await download(job.originalAudio, resolve(directory, 'original.wav'))
    }
    if (!job.useOriginal && !job.hasVocals) {
      job = await change({ phase: 'separating' }, { key: 'separation', message: 'Memisahkan vokal dengan Demucs.' })
      const { separateVocals } = await import('./separate.ts')
      await separateVocals(directory, resolve('models'), signal, report)
      await progress
      const vocalsAudio = await publish('vocals')
      job = await change({ hasVocals: true, vocalsAudio }, { key: 'vocals', message: 'Stem vokal tersimpan.' })
    }
    await change({ phase: job.lines ? 'ready' : 'awaitingSpeech' }, {
      key: 'audio-ready', message: 'Audio siap digunakan di Studio.',
    })
  } catch (cause) {
    if (signal.aborted) return
    console.error('[LyRex] Gagal memproses audio', cause)
    await progress
    const error = job.phase === 'separating'
      ? 'Pemisahan vokal gagal. Coba lagi atau transkripsikan audio asli.'
      : 'Audio gagal diproses. Coba lagi.'
    await change({ phase: 'failed', error, canUseOriginal: Boolean(job.originalAudio && !job.useOriginal) }, {
      key: 'failed', message: error,
    })
  }
}

await run()
