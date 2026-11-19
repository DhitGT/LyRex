import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BlobNotFoundError, BlobPreconditionFailedError, del, head, list, setTtl } from '@vercel/blob'
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client'
import { createError, getCookie, getHeader, getRequestProtocol, getRouterParam, readBody, setCookie, setResponseHeader, setResponseStatus } from 'h3'
import type { H3Event } from 'h3'
import { extractionActive, isYouTubeUrl, projectTitleMaxLength } from '../../shared/utils/lyrics'
import type { Extraction, LyricLine, LyricReference, LyricsSearchResult, ProjectSummary, SpeechTranscript } from '../../shared/utils/lyrics'
import type { Stage, WorkerMessage, WorkerProgress, WorkerResult } from '../../engine/protocol'
import { lrclibOptions, lrclibResult } from './lrclib'
import type { LrclibRecord } from './lrclib'
import { projectPath, readCloudProject, withLog, writeCloudProject } from '../../engine/cloud-project'
import type { VersionedProject as Job } from '../../engine/cloud-project'
import { cloudUploads, launchCloudRun, refreshCloudRun, stopCloudRun } from './extraction-sandbox'

const MAX_UPLOAD = 100_000_000
const COOKIE = 'lyrex_session'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const root = resolve(process.env.LYREX_DATA_DIR || '.data/extractions')
const worker = resolve(process.env.LYREX_WORKER || 'engine/worker.ts')
const models = resolve(process.env.LYREX_MODEL_DIR || resolve(root, 'models/onnx'))
const jobs = new Map<string, Job>()
const temporaryFiles = ['transcription.json', 'transcription.tmp.json', 'original.tmp.wav', 'vocals.tmp.wav', 'whisper.tmp.pcm']
let processing = false
let activeWorker: { id: string, cancel: () => void } | undefined

export function jobDirectory(id: string) {
  return resolve(root, id)
}

function saveLocal(job: Job) {
  const directory = jobDirectory(job.id)
  const temporary = resolve(directory, 'job.next')
  writeFileSync(temporary, JSON.stringify(job))
  renameSync(temporary, resolve(directory, 'job.json'))
  jobs.set(job.id, job)
  return job
}

async function save(job: Job) {
  if (!cloudUploads) return saveLocal(job)
  try {
    return await writeCloudProject(job)
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) fail(409, 'Proyek berubah. Muat ulang dan coba lagi.')
    throw error
  }
}

function publicJob(job: Job): Extraction {
  const { id, name, title, phase, durationMs, language, youtubeUrl, hasVocals, lines, logs, startedAt, canUseOriginal, useOriginal,
    requestedLanguage, speechRevision, draftSource, estimatedTiming, vocalTiming, lyricReference, selectedReference, transcript, speechCheckpoint } = job
  const canRetry = !job.invalidAudio && (phase === 'failed' || phase === 'cancelled')
  const error = phase === 'failed' && !logs?.length && !job.invalidAudio
    ? 'Percobaan sebelumnya gagal. Klik Coba lagi untuk memakai mesin ekstraksi terbaru.'
    : job.error
  const queueAhead = phase === 'queued' && !cloudUploads
    ? Math.max(0, queuedJobs().findIndex(entry => entry.id === id) + (activeWorker ? 1 : 0))
    : undefined
  return { id, name, title, phase, durationMs, language, youtubeUrl, hasVocals, lines, logs, startedAt, queueAhead, error,
    canRetry, canUseOriginal, useOriginal, requestedLanguage, speechRevision, draftSource, estimatedTiming, vocalTiming, lyricReference,
    selectedReference, transcript, speechCheckpoint }
}

export function resumeJobs() {
  if (cloudUploads) return
  mkdirSync(root, { recursive: true })
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue
    try {
      const job: Job = JSON.parse(readFileSync(resolve(root, entry.name, 'job.json'), 'utf8'))
      if (job.id !== entry.name) continue
      if (extractionActive(job.phase)) {
        const phase = job.phase === 'cancelling' ? 'cancelled' : 'queued'
        saveLocal(withLog({ ...job, phase, startedAt: job.startedAt ?? job.createdAt }, {
          key: 'restart',
          message: phase === 'queued' ? 'Server dimulai ulang. Job dimasukkan kembali ke antrean.' : 'Ekstraksi dibatalkan.'
        }))
        if (job.phase === 'cancelling') void cleanTemporaryFiles(job.id)
      } else {
        jobs.set(job.id, job)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[LyRex] Gagal memuat job', entry.name, error)
    }
  }
  void processQueue()
}

function fail(statusCode: number, message: string): never {
  throw createError({ statusCode, message, data: { message } })
}

export async function createExtraction(event: H3Event) {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  if (cloudUploads) return finishCloudUpload(event)
  if (getHeader(event, 'content-type') !== 'application/octet-stream') fail(415, 'Pilih file audio.')
  const length = Number(getHeader(event, 'content-length') ?? 0)
  if (length > MAX_UPLOAD) fail(413, 'Ukuran file melebihi 100 MB.')

  const job = newJob(event, randomUUID())
  const directory = jobDirectory(job.id)
  await mkdir(directory)
  try {
    const file = await open(resolve(directory, 'upload'), 'wx')
    let size = 0
    try {
      for await (const chunk of event.node.req.iterator({ destroyOnReturn: false })) {
        size += chunk.length
        if (size > MAX_UPLOAD) {
          event.node.req.resume()
          fail(413, 'Ukuran file melebihi 100 MB.')
        }
        await file.writeFile(chunk)
      }
    } finally {
      await file.close()
    }
    if (!size) fail(400, 'File audio kosong.')
    saveLocal(job)
    void processQueue()
    setResponseStatus(event, 202)
    return publicJob(job)
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

function newJob(event: H3Event, id: string) {
  let name: string
  let youtubeUrl: string
  try {
    name = decodeURIComponent(getHeader(event, 'x-lyrex-filename') || '')
    youtubeUrl = decodeURIComponent(getHeader(event, 'x-lyrex-youtube') || '').trim()
  } catch {
    fail(400, 'Informasi file tidak valid.')
  }
  const extension = name.match(/\.(mp3|wav|m4a)$/i)?.[1]?.toLowerCase()
  if (!extension || name.length > 255 || /[\x00-\x1f]/.test(name)) fail(400, 'Pilih file MP3, WAV, atau M4A.')
  if (youtubeUrl && (youtubeUrl.length > 2_048 || !isYouTubeUrl(youtubeUrl))) fail(400, 'Tautan YouTube tidak valid.')
  const requestedLanguage = getHeader(event, 'x-lyrex-language') || 'auto'
  if (!['auto', 'id', 'en'].includes(requestedLanguage)) fail(400, 'Pilihan bahasa tidak valid.')
  const source = getHeader(event, 'x-lyrex-source') || 'vocals'
  if (source !== 'vocals' && source !== 'original') fail(400, 'Pilihan sumber transkripsi tidak valid.')

  const existingSession = getCookie(event, COOKIE) || ''
  const owner = UUID.test(existingSession) ? existingSession : randomUUID()
  if (owner !== existingSession) {
    setCookie(event, COOKIE, owner, {
      httpOnly: true, sameSite: 'strict', secure: cloudUploads || getRequestProtocol(event) === 'https', path: '/',
      maxAge: 365 * 86_400
    })
  }
  const now = Date.now()
  return withLog<Job>({
    id, owner, extension, name, requestedLanguage, youtubeUrl: youtubeUrl || undefined,
    phase: 'queued', useOriginal: source === 'original', createdAt: now, startedAt: now
  }, { key: 'upload', message: 'Unggahan diterima. Menunggu giliran pemrosesan.' })
}

export async function createCloudUpload(event: H3Event) {
  if (!cloudUploads) fail(404, 'Unggahan langsung tidak tersedia.')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const token = process.env.BLOB_READ_WRITE_TOKEN
  if (!token) fail(503, 'Penyimpanan audio belum dikonfigurasi.')
  const job = newJob(event, randomUUID())
  const pathname = projectPath(job) + 'upload'
  const clientToken = await generateClientTokenFromReadWriteToken({
    token, pathname, allowedContentTypes: ['application/octet-stream'], maximumSizeInBytes: MAX_UPLOAD,
    validUntil: Date.now() + 15 * 60_000, addRandomSuffix: false, allowOverwrite: false, ttlDays: 1,
  })
  return { id: job.id, pathname, clientToken }
}

async function finishCloudUpload(event: H3Event) {
  const id = getHeader(event, 'x-lyrex-upload-id') || ''
  const owner = getCookie(event, COOKIE) || ''
  if (!UUID.test(id) || !UUID.test(owner)) fail(400, 'Sesi unggahan tidak valid.')
  setResponseStatus(event, 202)
  const existing = await readCloudProject(owner, id)
  if (existing) return publicJob(existing)
  const job = newJob(event, id)
  const pathname = projectPath(job) + 'upload'
  const audio = await head(pathname).catch((error: unknown) => {
    if (error instanceof BlobNotFoundError) fail(400, 'Unggah file audio terlebih dahulu.')
    throw error
  })
  if (!audio.size) fail(400, 'File audio kosong.')
  if (audio.size > MAX_UPLOAD) fail(413, 'Ukuran file melebihi 100 MB.')
  await setTtl(pathname, { ttlDays: null })
  return publicJob(await startCloudJob(job))
}

async function startCloudJob(job: Job) {
  try {
    return await launchCloudRun(job)
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) fail(409, 'Proyek berubah. Muat ulang dan coba lagi.')
    throw error
  }
}

export async function ownedJob(event: H3Event) {
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  const id = getRouterParam(event, 'id') || ''
  const owner = getCookie(event, COOKIE) || ''
  if (!UUID.test(id) || !UUID.test(owner)) fail(404, 'Proyek tidak ditemukan.')
  const job = cloudUploads ? await readCloudProject(owner, id) : jobs.get(id)
  if (!job || job.owner !== owner) fail(404, 'Proyek tidak ditemukan.')
  return job
}

export async function readExtraction(event: H3Event) {
  const job = await ownedJob(event)
  return publicJob(cloudUploads && job.run ? await refreshCloudRun(job) : job)
}

export async function listExtractions(event: H3Event): Promise<ProjectSummary[]> {
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  const owner = getCookie(event, COOKIE)
  if (!owner || !UUID.test(owner)) return []
  const records: Job[] = []
  if (cloudUploads) {
    let cursor: string | undefined
    do {
      const page = await list({ prefix: `projects/${owner}/`, mode: 'folded', cursor })
      const projects = await Promise.all(page.folders.map(folder => readCloudProject(owner, folder.split('/').filter(Boolean).at(-1)!)))
      for (const project of projects) if (project) records.push(project)
      cursor = page.hasMore ? page.cursor : undefined
    } while (cursor)
  } else {
    for (const job of jobs.values()) if (job.owner === owner) records.push(job)
  }
  return records
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ id, name, title, phase, createdAt, durationMs }) => ({ id, name, title, phase, createdAt, durationMs }))
}

async function readProjectBody<T>(event: H3Event, limit = 512 * 1024): Promise<T> {
  await ownedJob(event)
  if (getHeader(event, 'content-type')?.split(';')[0] !== 'application/json') fail(415, 'Gunakan format JSON.')
  if (Number(getHeader(event, 'content-length')) > limit) fail(413, 'Draft lirik terlalu besar.')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of event.node.req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) {
      event.node.req.resume()
      fail(413, 'Draft lirik terlalu besar.')
    }
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body && typeof body === 'object' && !Array.isArray(body)) return body
  } catch {
    // Invalid JSON is handled below.
  }
  fail(400, 'Data proyek tidak valid.')
}

export async function saveProjectTitle(event: H3Event) {
  const { title: value } = await readProjectBody<{ title?: unknown }>(event)
  const title = typeof value === 'string' ? value.trim() : ''
  if (!title || title.length > projectTitleMaxLength || /[\x00-\x1f\x7f\u2028\u2029]/.test(title)) {
    fail(400, `Masukkan judul proyek 1–${projectTitleMaxLength} karakter dalam satu baris.`)
  }
  const job = await ownedJob(event)
  await save({ ...job, title })
  return { title }
}

function checkedLines(value: unknown, durationMs: number) {
  if (!Array.isArray(value) || value.length > 1_000) fail(400, 'Draft lirik tidak valid.')
  const lines: LyricLine[] = []
  let previousEnd = 0
  for (const line of value) {
    if (!line || !Number.isInteger(line.startMs) || !Number.isInteger(line.endMs) ||
      line.startMs < previousEnd || line.endMs <= line.startMs || line.endMs > durationMs ||
      typeof line.text !== 'string') fail(400, 'Timestamp lirik tidak valid.')
    const text = line.text.replace(/\s+/g, ' ').trim()
    if (!text || text.length > 1_000) fail(400, 'Teks lirik tidak valid.')
    const result: LyricLine = { startMs: line.startMs, endMs: line.endMs, text, needsReview: true }
    if (line.timingSource === 'interpolated') result.timingSource = 'interpolated'
    if (line.words !== undefined) {
      const tokens = text.split(' ')
      const words: unknown = line.words
      if (!Array.isArray(words) || words.length !== tokens.length) fail(400, 'Data per kata tidak valid.')
      let end = line.startMs
      result.words = words.map((word, index) => {
        if (!word || word.text !== tokens[index] || !Number.isInteger(word.startMs) || !Number.isInteger(word.endMs) ||
          word.startMs < end || word.endMs <= word.startMs || word.endMs > line.endMs) {
          fail(400, 'Timestamp per kata tidak valid.')
        }
        end = word.endMs
        return { text: word.text, startMs: word.startMs, endMs: word.endMs }
      })
    }
    lines.push(result)
    previousEnd = line.endMs
  }
  return lines
}

export async function saveSelectedReference(event: H3Event) {
  const { reference } = await readProjectBody<{ reference?: LyricsSearchResult | null }>(event, 384 * 1024)
  const job = await ownedJob(event)
  if (reference === null) return publicJob(await save({ ...job, selectedReference: undefined }))
  if (!reference || !Number.isSafeInteger(reference.id) || reference.id <= 0 ||
    typeof reference.trackName !== 'string' || !reference.trackName.trim() || reference.trackName.length > 200 ||
    typeof reference.artistName !== 'string' || reference.artistName.length > 200 ||
    typeof reference.albumName !== 'string' || reference.albumName.length > 500 ||
    typeof reference.duration !== 'number' || !Number.isFinite(reference.duration) || reference.duration < 0 ||
    typeof reference.text !== 'string' || !reference.text.trim() || reference.text.length > 30_000 ||
    (reference.syncedLyrics !== undefined && (typeof reference.syncedLyrics !== 'string' || reference.syncedLyrics.length > 30_000))) {
    fail(400, 'Acuan LRCLIB tidak valid.')
  }
  const { id, trackName, artistName, albumName, duration, text, syncedLyrics } = reference
  return publicJob(await save({ ...job, selectedReference: { id, trackName, artistName, albumName, duration, text, syncedLyrics } }))
}

export async function restoreSelectedReference(event: H3Event) {
  const job = await ownedJob(event)
  const id = job.lyricReference?.id
  if (job.selectedReference || !id) return job.selectedReference ?? null
  let reference: LyricsSearchResult | undefined
  try {
    const record = await $fetch<LrclibRecord>(`https://lrclib.net/api/get/${id}`, lrclibOptions)
    reference = lrclibResult(record)
  } catch {
    return null
  }
  if (reference?.id !== id) return null
  const latest = await ownedJob(event)
  if (latest.selectedReference || latest.lyricReference?.id !== id) return latest.selectedReference ?? null
  return (await save({ ...latest, selectedReference: reference })).selectedReference
}

export async function saveTranscript(event: H3Event) {
  const body = await readProjectBody<{
    runId?: string, previousRunId?: string | null, resume?: boolean, language?: SpeechTranscript['language'],
    channel?: SpeechTranscript['channel'], eq?: SpeechTranscript['eq'], processedMs?: number, lines?: unknown, complete?: boolean
  }>(event)
  const job = await ownedJob(event)
  const duration = job.durationMs
  if (!duration || (job.phase !== 'awaitingSpeech' && job.phase !== 'ready')) fail(409, 'Audio belum siap ditranskripsi.')
  if (typeof body.runId !== 'string' || !UUID.test(body.runId)) fail(400, 'Sesi transkripsi tidak valid.')
  const checkpoint = job.speechCheckpoint
  const now = Date.now()
  if (body.previousRunId !== undefined) {
    if (body.previousRunId !== (checkpoint?.runId ?? null)) fail(409, 'Progres berubah. Buka ulang proyek.')
    const source = job.hasVocals && !job.useOriginal ? 'vocals' : 'original'
    if (body.resume) {
      if (!checkpoint || checkpoint.source !== source) fail(409, 'Progres belum bisa dilanjutkan.')
      const next = { ...checkpoint, runId: body.runId, updatedAt: now }
      await save({ ...job, speechCheckpoint: next })
      return next
    }
    const { language, channel, eq } = body
    if ((language !== 'id' && language !== 'en') ||
      (channel !== 'mix' && channel !== 'left' && channel !== 'right') ||
      (eq !== 'off' && eq !== 'clarity' && eq !== 'high-register')) fail(400, 'Pengaturan Web Speech tidak valid.')
    const next: SpeechTranscript = { runId: body.runId, language, channel, eq, source, lines: [], processedMs: 0, updatedAt: now }
    await save({ ...job, speechCheckpoint: next })
    return next
  }
  if (!checkpoint || checkpoint.runId !== body.runId) fail(409, 'Sesi transkripsi sudah berubah. Buka ulang proyek.')
  const { processedMs } = body
  if (typeof processedMs !== 'number' || !Number.isInteger(processedMs) || processedMs < checkpoint.processedMs ||
    processedMs > duration || (body.complete && processedMs !== duration)) fail(400, 'Posisi transkripsi tidak valid.')
  const lines = checkedLines(body.lines, processedMs)
  const next = { ...checkpoint, lines, processedMs, updatedAt: now }
  await save(body.complete ? withLog({ ...job, transcript: next, speechCheckpoint: undefined }, {
    key: 'transcript-ready', message: `Transkrip Web Speech tersimpan · ${lines.length} baris.`
  }) : { ...job, speechCheckpoint: next })
  return next
}

export function saveBrowserSpeech(event: H3Event) {
  return saveDraft(event, false)
}

export function saveEditedLyrics(event: H3Event) {
  return saveDraft(event, true)
}

async function saveDraft(event: H3Event, edited: boolean) {
  const body = await readProjectBody<{
    revision?: unknown, language?: unknown, lines?: unknown, vocalTiming?: unknown, lyricReference?: Partial<LyricReference>
  }>(event)
  const job = await ownedJob(event)
  if (!job.durationMs || (job.phase !== 'awaitingSpeech' && job.phase !== 'ready')) {
    fail(409, 'Audio belum siap untuk disimpan.')
  }
  if (body.revision !== (job.speechRevision ?? 0)) fail(409, 'Draft sudah berubah. Muat ulang proyek.')
  const language = edited ? job.language ?? job.transcript?.language : body.language
  if (!edited && language !== 'id' && language !== 'en') fail(400, 'Bahasa draft tidak valid.')
  const lines = checkedLines(body.lines, job.durationMs)
  if (edited && !lines.length) fail(400, 'Tambahkan setidaknya satu baris lirik.')
  let lyricReference: LyricReference | undefined
  if (body.lyricReference !== undefined) {
    const reference = body.lyricReference
    if (!reference || typeof reference.id !== 'number' || !Number.isSafeInteger(reference.id) || reference.id <= 0 ||
      typeof reference.trackName !== 'string' || !reference.trackName || reference.trackName.length > 200 ||
      typeof reference.artistName !== 'string' || reference.artistName.length > 200 ||
      (reference.timingSource !== undefined && reference.timingSource !== 'lrclib' &&
        reference.timingSource !== 'lrclib-waveform' && reference.timingSource !== 'waveform') ||
      typeof reference.matchedLines !== 'number' || !Number.isInteger(reference.matchedLines) ||
      reference.matchedLines < (reference.timingSource ? 0 : 1) ||
      reference.matchedLines > lines.length || !lines.length) fail(400, 'Data acuan lirik tidak valid.')
    lyricReference = { id: reference.id, trackName: reference.trackName, artistName: reference.artistName,
      matchedLines: reference.matchedLines, timingSource: reference.timingSource }
  }
  const message = edited ? `Draft dari Editor tersimpan · ${lines.length} baris.`
    : lyricReference?.timingSource === 'lrclib' ? `Draft tersimpan dengan timestamp baris LRCLIB · ${lines.length} baris.`
    : lyricReference?.timingSource === 'lrclib-waveform' || lyricReference?.timingSource === 'waveform'
      ? `Draft LRCLIB tersimpan dengan penyesuaian waveform · ${lines.length} baris.`
    : lyricReference ? `Draft LRCLIB tersimpan · ${lyricReference.matchedLines} dari ${lines.length} baris punya acuan waktu dari transkripsi.`
    : `Draft Web Speech tersimpan · ${lines.length} baris bertimestamp perkiraan.`
  return publicJob(await save(withLog({
    ...job, phase: 'ready', language: typeof language === 'string' ? language : undefined,
    lines, estimatedTiming: true, draftSource: edited ? 'editor' : undefined,
    vocalTiming: body.vocalTiming === true && job.hasVocals && lines.some(line => line.words?.length) || undefined,
    speechRevision: (job.speechRevision ?? 0) + 1, lyricReference
  }, { key: edited ? 'editor-ready' : 'speech-ready', message })))
}

export async function retryExtraction(event: H3Event) {
  const body = await readBody<{ useOriginal?: boolean }>(event)
  const job = await ownedJob(event)
  if ((job.phase !== 'failed' && job.phase !== 'cancelled') || job.invalidAudio) {
    fail(409, 'Job ini tidak dapat diulang.')
  }
  if (body?.useOriginal === true && !job.canUseOriginal && !job.useOriginal) {
    fail(409, 'Audio asli belum tersedia untuk transkripsi.')
  }
  const queued = withLog({
    ...job, phase: 'queued', error: undefined, canUseOriginal: undefined,
    startedAt: Date.now(), useOriginal: body?.useOriginal === true || job.useOriginal
  }, { key: 'retry', message: 'Percobaan baru dimasukkan ke antrean.' })
  if (cloudUploads) return publicJob(await startCloudJob(queued))
  saveLocal(queued)
  void processQueue()
  return publicJob(queued)
}

export async function prepareVocals(event: H3Event) {
  const job = await ownedJob(event)
  if (!job.durationMs || job.hasVocals || (job.phase !== 'ready' && job.phase !== 'awaitingSpeech')) {
    fail(409, 'Pemisahan vokal belum bisa dimulai.')
  }
  const queued = withLog<Job>({ ...job, phase: 'queued', useOriginal: false, startedAt: Date.now() }, {
    key: 'prepare-vocals', message: 'Pemisahan vokal masuk antrean.'
  })
  if (cloudUploads) return publicJob(await startCloudJob(queued))
  saveLocal(queued)
  void processQueue()
  return publicJob(queued)
}

export async function cancelExtraction(event: H3Event) {
  const job = await ownedJob(event)
  if (!extractionActive(job.phase)) return publicJob(job)
  const phase = cloudUploads || job.phase === 'queued' ? 'cancelled' : 'cancelling'
  const cancelled = await save(withLog({ ...job, phase }, {
    key: phase, message: phase === 'cancelled' ? 'Job dikeluarkan dari antrean.' : 'Menghentikan proses aktif.'
  }))
  if (cloudUploads && job.run) await stopCloudRun(cancelled)
  if (activeWorker?.id === job.id) activeWorker.cancel()
  return publicJob(cancelled)
}

export async function deleteExtraction(event: H3Event) {
  const job = await ownedJob(event)
  if (extractionActive(job.phase)) fail(409, 'Tunggu pemrosesan selesai atau batalkan job sebelum menghapus.')
  if (cloudUploads) {
    if (job.run) await stopCloudRun(job)
    const prefix = projectPath(job)
    let cursor: string | undefined
    do {
      const page = await list({ prefix, cursor })
      const assets = page.blobs.filter(blob => blob.pathname !== prefix + 'job.json').map(blob => blob.pathname)
      if (assets.length) await del(assets)
      cursor = page.hasMore ? page.cursor : undefined
    } while (cursor)
    await del(prefix + 'job.json')
    return { deleted: true }
  }
  jobs.delete(job.id)
  try {
    await rm(jobDirectory(job.id), { recursive: true, force: true, maxRetries: 3 })
  } catch (error) {
    jobs.set(job.id, job)
    throw error
  }
  return { deleted: true }
}

async function runWorker(job: Job, stage: Stage, value = '') {
  const child = fork(worker, [stage, jobDirectory(job.id), value, models], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
  })
  let killTimer: ReturnType<typeof setTimeout> | undefined
  function cancel() {
    if (child.connected) child.send('cancel', () => {})
    killTimer ??= setTimeout(() => child.kill(), 5_000)
  }
  activeWorker = { id: job.id, cancel }
  const timeout = setTimeout(cancel, stage === 'decode' ? 150_000 : 60 * 60_000)
  try {
    return await new Promise<WorkerResult>((resolve, reject) => {
      let result: WorkerResult | undefined
      let failure = ''
      let stderr = ''
      child.stderr?.setEncoding('utf8').on('data', data => { stderr = (stderr + data).slice(-8_192) })
      child.on('error', error => { failure = error.message })
      child.on('message', (message: WorkerMessage) => {
        if ('result' in message) result = message.result
        if ('failure' in message) failure = message.failure
        if ('progress' in message) {
          const current = jobs.get(job.id)
          if (!current || current.phase === 'cancelling') return
          try {
            saveLocal(withLog(current, { ...message.progress, key: `${stage}/${message.progress.key}` }))
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error)
            cancel()
          }
        }
      })
      child.once('close', code => {
        if (code === 0 && result && !failure) resolve(result)
        else reject(new Error(stderr || failure || `Worker stopped during ${stage}`))
      })
    })
  } finally {
    clearTimeout(timeout)
    clearTimeout(killTimer)
    activeWorker = undefined
  }
}

function advance(job: Job, changes: Partial<Job>, progress?: WorkerProgress) {
  const current = jobs.get(job.id)!
  const updated: Job = current.phase === 'cancelling'
    ? { ...current, ...changes, phase: 'cancelling' }
    : { ...current, ...changes }
  return saveLocal(progress && updated.phase !== 'cancelling' ? withLog(updated, progress) : updated)
}

async function cleanTemporaryFiles(id: string) {
  const cleanup = await Promise.allSettled(temporaryFiles.map(name => rm(resolve(jobDirectory(id), name), {
    force: true, maxRetries: 3
  })))
  for (const result of cleanup) {
    if (result.status === 'rejected') console.error('[LyRex] Gagal membersihkan file sementara', id, result.reason)
  }
}

async function processJob(job: Job) {
  let terminal: Partial<Job> = {}
  try {
    if (!job.durationMs) {
      job = advance(job, { phase: 'validating' }, { key: 'decode', message: 'Memeriksa format dan durasi lewat FFmpeg.' })
      const result = await runWorker(job, 'decode', job.extension)
      if (!result.durationMs) {
        terminal = { phase: 'failed', error: result.error || 'Durasi audio tidak dapat dibaca.', invalidAudio: true }
        return
      }
      job = advance(job, { durationMs: result.durationMs }, {
        key: 'validated', message: `Audio siap · durasi ${Math.round(result.durationMs / 1_000)} detik`
      })
    }
    if (job.phase === 'cancelling') return
    if (!job.hasVocals && !job.useOriginal) {
      job = advance(job, { phase: 'separating' }, { key: 'separation', message: 'Memeriksa model untuk pemisahan vokal.' })
      await runWorker(job, 'separate')
      job = advance(job, { hasVocals: true })
    }
    if (job.phase === 'cancelling') return
    terminal = { phase: job.lines ? 'ready' : 'awaitingSpeech' }
  } catch (error) {
    if (jobs.get(job.id)?.phase === 'cancelling') return
    console.error('[LyRex] Worker gagal', job.id, job.phase, error)
    const messages = {
      validating: 'FFmpeg gagal dijalankan. Periksa instalasi dependensi LyRex, lalu coba lagi.',
      separating: 'Pemisahan vokal gagal. Coba lagi atau transkripsikan audio asli.'
    }
    terminal = {
      phase: 'failed',
      canUseOriginal: job.phase === 'separating',
      error: messages[job.phase as keyof typeof messages] || 'Ekstraksi gagal. Coba lagi.'
    }
  } finally {
    await cleanTemporaryFiles(job.id)
    const current = jobs.get(job.id)!
    const finished: Job = current.phase === 'cancelling'
      ? { ...current, phase: 'cancelled' }
      : { ...current, ...terminal }
    const message = finished.phase === 'cancelled' ? 'Ekstraksi dibatalkan.'
      : finished.phase === 'awaitingSpeech' || finished.phase === 'ready' ? 'Audio siap digunakan di Studio.'
        : finished.error || 'Ekstraksi gagal.'
    saveLocal(withLog(finished, { key: finished.phase, message }))
  }
}

function queuedJobs() {
  return [...jobs.values()].filter(entry => entry.phase === 'queued')
    .sort((first, second) => first.createdAt - second.createdAt)
}

async function processQueue() {
  if (processing) return
  processing = true
  try {
    while (true) {
      const job = queuedJobs()[0]
      if (!job) break
      await processJob(job)
    }
  } catch (error) {
    console.error('[LyRex] Antrean ekstraksi gagal', error)
  } finally {
    processing = false
  }
}
