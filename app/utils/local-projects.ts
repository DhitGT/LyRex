import { extractionActive, projectTitleMaxLength } from '#shared/utils/lyrics'
import type { Extraction, ExtractionLog, LyricLine, LyricReference, LyricsSearchResult, ProjectSummary, SpeechTranscript } from '#shared/utils/lyrics'
import { decodeLocalAudio, InvalidLocalAudio } from './local-wav'
import { separateLocalVocals } from './vocal-worker'

export type AudioSource = 'original' | 'vocals'
type Asset = AudioSource | 'input'
type Project = Extraction & { createdAt: number }
type AudioChange = { source: Asset, blob?: Blob }
type Activity = Omit<ExtractionLog, 'at'>
const projects = 'projects'
const audio = 'audio'
let connection: Promise<IDBDatabase> | undefined
const progress = new Map<string, Activity>()
const running = new Map<string, AbortController>()
let cancellations: BroadcastChannel | undefined

function database() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('lyrex', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(projects, { keyPath: 'id' })
      request.result.createObjectStore(audio)
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close()
        connection = undefined
      }
      resolve(request.result)
    }
    request.onerror = () => reject(request.error)
  }).catch(error => {
    connection = undefined
    throw error
  })
  return connection
}

function readRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function write<T>(id: string, update: (current: Project | undefined, assets: IDBObjectStore) => [Project | undefined, T]) {
  const db = await database()
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction([projects, audio], 'readwrite')
    const store = transaction.objectStore(projects)
    const request = store.get(id)
    let result: T
    let failure: unknown
    request.onsuccess = () => {
      try {
        const [next, value] = update(request.result, transaction.objectStore(audio))
        if (next === undefined) store.delete(id)
        else if (next !== request.result) store.put(JSON.parse(JSON.stringify(next)))
        result = value
      } catch (error) {
        failure = error
        transaction.abort()
      }
    }
    transaction.oncomplete = () => resolve(result)
    transaction.onabort = () => reject(failure ?? (transaction.error?.name === 'QuotaExceededError'
      ? new Error('Penyimpanan browser penuh. Kosongkan ruang atau hapus proyek lama.') : transaction.error))
  })
}

function projectRequired(job: Project | undefined) {
  if (!job) throw new Error('Proyek tidak ditemukan di browser ini.')
  return job
}

function change(id: string, update: (job: Project) => Project, assets: AudioChange[] = []) {
  return write(id, (current, store) => {
    const next = update(projectRequired(current))
    for (const { source, blob } of assets) {
      if (blob) store.put(blob, [id, source])
      else store.delete([id, source])
    }
    return [next, next]
  })
}

function log(job: Project, entry: Activity): Project {
  return { ...job, logs: [...(job.logs || []).filter(item => item.key !== entry.key), { ...entry, at: Date.now() }].slice(-40) }
}

function available(job: Project, phase: 'ready' | 'awaitingSpeech' = job.lines ? 'ready' : 'awaitingSpeech') {
  return { ...job, phase, canRetry: undefined, canUseOriginal: undefined, error: undefined } satisfies Project
}

function interruption(job: Project, phase: 'cancelled' | 'failed', message: string, retry = true) {
  return log({ ...job, phase, error: phase === 'failed' ? message : undefined, canRetry: retry,
    canUseOriginal: !job.useOriginal && Boolean(job.durationMs) }, { key: phase, message })
}

function projectLock(id: string) {
  return `lyrex-project-${id}`
}

function messages() {
  if (!cancellations && typeof BroadcastChannel !== 'undefined') {
    cancellations = new BroadcastChannel('lyrex-cancellations')
    cancellations.onmessage = ({ data }) => running.get(data)?.abort()
  }
  return cancellations
}

async function findProject(id: string) {
  return readRequest<Project | undefined>((await database()).transaction(projects).objectStore(projects).get(id))
}

export async function getLocalProject(id: string) {
  const job = projectRequired(await findProject(id))
  if (!extractionActive(job.phase)) return job
  const current = await navigator.locks.request(projectLock(id), { ifAvailable: true }, lock => lock
    ? change(id, latest => extractionActive(latest.phase)
      ? interruption(latest, 'cancelled', 'Pemrosesan terputus. Klik Coba lagi untuk melanjutkan.')
      : latest)
    : findProject(id))
  const live = projectRequired(current)
  const entry = progress.get(id)
  return entry && extractionActive(live.phase) ? log(live, entry) : live
}

export async function listLocalProjects(): Promise<ProjectSummary[]> {
  const rows = await readRequest<Project[]>((await database()).transaction(projects).objectStore(projects).getAll())
  const restored = await Promise.all(rows.map(job => extractionActive(job.phase) ? getLocalProject(job.id) : job))
  return restored.sort((a, b) => b.createdAt - a.createdAt)
    .map(({ id, name, title, phase, createdAt, durationMs }) => ({ id, name, title, phase, createdAt, durationMs }))
}

async function audioAsset(id: string, source: Asset) {
  return readRequest<Blob | undefined>((await database()).transaction(audio).objectStore(audio).get([id, source]))
}

export function localAudio(id: string, source: AudioSource) {
  return audioAsset(id, source)
}

function run(id: string, prepare: () => Promise<Project>) {
  return new Promise<Project>((resolve, reject) => {
    void navigator.locks.request(projectLock(id), { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Proyek sedang diproses di tab lain.')
      const controller = new AbortController()
      const { signal } = controller
      messages()
      running.set(id, controller)
      let prepared = false
      try {
        const start = await prepare()
        prepared = true
        resolve(start)
        let job = start
        if (!job.durationMs) {
          const input = await audioAsset(id, 'input')
          if (!input) throw new Error('File sumber proyek tidak tersedia.')
          const { wav, durationMs } = await decodeLocalAudio(input, signal)
          await change(id, latest => {
            signal.throwIfAborted()
            if (!extractionActive(latest.phase)) throw new DOMException('Dibatalkan', 'AbortError')
            return log({ ...latest, durationMs }, { key: 'decode', message: 'Audio asli siap.' })
          }, [{ source: 'original', blob: wav }, { source: 'input' }])
          job = projectRequired(await findProject(id))
        }
        if (job.useOriginal) {
          await change(id, latest => {
            signal.throwIfAborted()
            if (!extractionActive(latest.phase)) throw new DOMException('Dibatalkan', 'AbortError')
            return log(available(latest), { key: 'ready', message: 'Audio siap diputar dan ditranskripsi.' })
          })
          return
        }
        progress.set(id, { key: 'vocal-queue', message: 'Menunggu pemisahan vokal di browser.' })
        await navigator.locks.request('lyrex-demucs', { signal }, async () => {
          const wav = await localAudio(id, 'original')
          if (!wav) throw new Error('Audio asli tidak ditemukan.')
          await change(id, latest => {
            signal.throwIfAborted()
            if (!extractionActive(latest.phase)) throw new DOMException('Dibatalkan', 'AbortError')
            return { ...latest, phase: 'separating' }
          })
          const vocals = await separateLocalVocals(wav, signal, ({ key, message, percent }) => {
            progress.set(id, { key, message, percent })
          })
          await change(id, latest => {
            signal.throwIfAborted()
            if (!extractionActive(latest.phase)) throw new DOMException('Dibatalkan', 'AbortError')
            return log(available({ ...latest, hasVocals: true }), { key: 'vocals-ready', message: 'Stem vokal tersimpan di browser.', percent: 100 })
          }, [{ source: 'vocals', blob: vocals }])
        })
      } catch (error) {
        if (!prepared) throw error
        await write(id, (current, store) => {
          if (!current || !extractionActive(current.phase)) return [current, undefined]
          const message = error instanceof Error ? error.message : 'Pemrosesan audio gagal.'
          const invalid = !signal.aborted && error instanceof InvalidLocalAudio
          if (invalid) store.delete([id, 'input'])
          return [signal.aborted ? interruption(current, 'cancelled', 'Pemrosesan dibatalkan.') :
            interruption(current, 'failed', message, !invalid), undefined]
        }).catch(error => console.error('[LyRex] Status pemrosesan gagal diperbarui', error))
      } finally {
        progress.delete(id)
        running.delete(id)
      }
    }).catch(reject)
  })
}

export function createLocalProject(file: File, source: AudioSource, youtubeUrl: string) {
  const id = crypto.randomUUID()
  const now = Date.now()
  const job = log({ id, name: file.name, phase: 'validating', createdAt: now, startedAt: now,
    useOriginal: source === 'original', youtubeUrl: youtubeUrl || undefined },
  { key: 'decode', message: 'Menyiapkan audio di browser.' })
  return run(id, () => write(id, (_, store) => {
    store.add(file, [id, 'input'])
    return [job, job]
  }))
}

export function restartLocalProject(id: string, action: 'retry' | 'vocals', useOriginal: boolean) {
  return run(id, () => change(id, job => {
    if (action === 'retry' ? !job.canRetry : !job.durationMs || job.hasVocals || extractionActive(job.phase)) {
      throw new Error('Pemrosesan audio belum bisa dimulai.')
    }
    const next = { ...job, useOriginal: action === 'retry' && (useOriginal || job.useOriginal) }
    return log({ ...available(next), phase: 'validating', startedAt: Date.now() },
      { key: 'restart', message: 'Menyiapkan audio di browser.' })
  }))
}

export async function cancelLocalProject(id: string) {
  const cancelled = await change(id, job => extractionActive(job.phase)
    ? interruption(job, 'cancelled', 'Pemrosesan dibatalkan.') : job)
  running.get(id)?.abort()
  messages()?.postMessage(id)
  await navigator.locks.request(projectLock(id), () => undefined)
  return cancelled
}

export function deleteLocalProject(id: string) {
  return write(id, (current, store) => {
    if (extractionActive(projectRequired(current).phase)) throw new Error('Batalkan pemrosesan sebelum menghapus proyek.')
    for (const source of ['input', 'original', 'vocals']) store.delete([id, source])
    return [undefined, undefined]
  })
}

export function renameLocalProject(id: string, title: string) {
  if (!title || title.length > projectTitleMaxLength || /[\x00-\x1f\x7f\u2028\u2029]/.test(title)) {
    throw new Error(`Masukkan judul proyek 1–${projectTitleMaxLength} karakter dalam satu baris.`)
  }
  return change(id, job => ({ ...job, title }))
}

export function saveLocalReference(id: string, selectedReference: LyricsSearchResult) {
  return change(id, job => ({ ...job, selectedReference }))
}

function checkedLines(lines: LyricLine[], durationMs: number) {
  if (lines.length > 1_000) throw new Error('Draft lirik terlalu panjang.')
  let previousEnd = 0
  return lines.map(line => {
    const { startMs, endMs } = line
    if (!Number.isInteger(startMs) || !Number.isInteger(endMs) ||
      startMs < previousEnd || endMs <= startMs || endMs > durationMs) throw new Error('Timestamp lirik tidak valid.')
    const text = line.text.replace(/\s+/g, ' ').trim()
    if (!text || text.length > 1_000) throw new Error('Teks lirik tidak valid.')
    let wordEnd = startMs
    if (line.words) {
      const tokens = text.split(' ')
      if (line.words.length !== tokens.length) throw new Error('Data per kata tidak valid.')
      for (const [index, word] of line.words.entries()) {
        if (word.text !== tokens[index] || !Number.isInteger(word.startMs) || !Number.isInteger(word.endMs) ||
          word.startMs < wordEnd || word.endMs <= word.startMs || word.endMs > endMs) throw new Error('Timestamp per kata tidak valid.')
        wordEnd = word.endMs
      }
    }
    previousEnd = endMs
    return { ...line, text, needsReview: true }
  })
}

export async function saveLocalTranscript(id: string, signal: AbortSignal, update:
  | Pick<SpeechTranscript, 'runId' | 'channel' | 'language' | 'eq'> & { previousRunId: string | null, resume: boolean }
  | Pick<SpeechTranscript, 'runId' | 'lines' | 'processedMs'> & { complete: boolean }) {
  const job = await change(id, job => {
    signal.throwIfAborted()
    if (job.phase !== 'awaitingSpeech' && job.phase !== 'ready') throw new Error('Audio belum siap ditranskripsi.')
    const checkpoint = job.speechCheckpoint
    const updatedAt = Date.now()
    if ('previousRunId' in update) {
      if (update.previousRunId !== (checkpoint?.runId ?? null)) throw new Error('Progres berubah. Buka ulang proyek.')
      const { runId, language, channel, eq } = update
      const source = job.hasVocals && !job.useOriginal ? 'vocals' : 'original'
      if (update.resume && (!checkpoint || checkpoint.source !== source)) throw new Error('Progres belum bisa dilanjutkan.')
      const next: SpeechTranscript = update.resume && checkpoint ? { ...checkpoint, runId, updatedAt }
        : { runId, language, channel, eq, source, lines: [], processedMs: 0, updatedAt }
      return { ...job, speechCheckpoint: next }
    }
    if (!checkpoint || checkpoint.runId !== update.runId) throw new Error('Sesi transkripsi sudah berubah. Buka ulang proyek.')
    const { lines, processedMs, complete } = update
    if (!job.durationMs || !Number.isInteger(processedMs) || processedMs < checkpoint.processedMs || processedMs > job.durationMs ||
      (complete && processedMs !== job.durationMs)) throw new Error('Posisi transkripsi tidak valid.')
    const next = { ...checkpoint, lines: checkedLines(lines, processedMs), processedMs, updatedAt }
    return complete ? log({ ...job, transcript: next, speechCheckpoint: undefined },
      { key: 'transcript-ready', message: `Transkrip Web Speech tersimpan · ${lines.length} baris.` })
      : { ...job, speechCheckpoint: next }
  })
  return (job.speechCheckpoint ?? job.transcript)!
}

export class DraftConflict extends Error {}

export function saveLocalDraft(id: string, draft: { revision: number, language?: 'id' | 'en', lines: LyricLine[],
  lyricReference?: LyricReference, vocalTiming?: boolean }, edited: boolean, signal?: AbortSignal) {
  return change(id, job => {
    signal?.throwIfAborted()
    if (!job.durationMs || (job.phase !== 'awaitingSpeech' && job.phase !== 'ready')) throw new Error('Audio belum siap untuk disimpan.')
    if (draft.revision !== (job.speechRevision ?? 0)) throw new DraftConflict('Draft sudah berubah. Muat ulang proyek.')
    const lines = checkedLines(draft.lines, job.durationMs)
    if (edited && !lines.length) throw new Error('Tambahkan setidaknya satu baris lirik.')
    return log({
      ...available(job, 'ready'), lines, estimatedTiming: true, lyricReference: draft.lyricReference,
      language: edited ? job.language ?? job.transcript?.language : draft.language,
      draftSource: edited ? 'editor' : undefined, speechRevision: draft.revision + 1,
      vocalTiming: draft.vocalTiming && job.hasVocals && lines.some(line => line.words?.length) || undefined
    }, { key: edited ? 'editor-ready' : 'speech-ready', message: `Draft tersimpan di browser · ${lines.length} baris.` })
  })
}
