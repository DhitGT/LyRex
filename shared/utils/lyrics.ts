export interface LyricWord {
  startMs: number
  endMs: number
  text: string
}

export interface LyricLine extends LyricWord {
  needsReview?: boolean
  timingSource?: 'interpolated'
  words?: LyricWord[]
}

export interface LyricReference {
  id: number
  trackName: string
  artistName: string
  matchedLines: number
  timingSource?: 'lrclib'
}

export interface LyricsSearchResult extends Omit<LyricReference, 'matchedLines' | 'timingSource'> {
  albumName: string
  duration: number
  text: string
  syncedLyrics?: string
}

export type ExtractionPhase = 'queued' | 'validating' | 'separating' | 'transcribing' |
  'assembling' | 'awaitingSpeech' | 'cancelling' | 'cancelled' | 'failed' | 'ready'

export interface ExtractionLog {
  key: string
  at: number
  message: string
  percent?: number
}

export interface SpeechTranscript {
  runId: string
  language: 'id' | 'en'
  channel: 'mix' | 'left' | 'right'
  eq: 'off' | 'clarity' | 'high-register'
  source: 'original' | 'vocals'
  lines: LyricLine[]
  processedMs: number
  updatedAt: number
}

export interface ProjectSummary {
  id: string
  name: string
  phase: ExtractionPhase
  createdAt: number
  durationMs?: number
}

export interface Extraction {
  id: string
  name: string
  phase: ExtractionPhase
  durationMs?: number
  language?: string
  youtubeUrl?: string
  hasVocals?: boolean
  lines?: LyricLine[]
  error?: string
  canRetry?: boolean
  canUseOriginal?: boolean
  useOriginal: boolean
  logs?: ExtractionLog[]
  startedAt?: number
  queueAhead?: number
  requestedLanguage?: string
  speechRevision?: number
  estimatedTiming?: boolean
  vocalTiming?: boolean
  lyricReference?: LyricReference
  selectedReference?: LyricsSearchResult
  transcript?: SpeechTranscript
  speechCheckpoint?: SpeechTranscript
}

export const extractionActive = (phase: ExtractionPhase) =>
  phase !== 'ready' && phase !== 'failed' && phase !== 'cancelled' && phase !== 'awaitingSpeech'

export const extractionLabels: Record<ExtractionPhase, string> = {
  queued: 'Dalam antrean',
  validating: 'Menyiapkan audio',
  separating: 'Memisahkan vokal',
  transcribing: 'Mentranskripsikan lirik',
  assembling: 'Menyusun draft',
  awaitingSpeech: 'Siap ditranskripsi',
  cancelling: 'Membatalkan proses',
  cancelled: 'Dibatalkan',
  failed: 'Perlu dicoba lagi',
  ready: 'Draft siap'
}

export const lyricFormats = ['LRC', 'SRT', 'JSON'] as const
export type LyricFormat = typeof lyricFormats[number]

export function lyricTimestamp(ms: number, format: 'LRC' | 'SRT' = 'LRC') {
  const seconds = String(Math.floor(ms / 1_000) % 60).padStart(2, '0')
  if (format === 'LRC') {
    const minutes = String(Math.floor(ms / 60_000)).padStart(2, '0')
    const fraction = String(Math.floor(ms % 1_000 / 10)).padStart(2, '0')
    return `${minutes}:${seconds}.${fraction}`
  }
  const hours = String(Math.floor(ms / 3_600_000)).padStart(2, '0')
  const minutes = String(Math.floor(ms / 60_000) % 60).padStart(2, '0')
  return `${hours}:${minutes}:${seconds},${String(ms % 1_000).padStart(3, '0')}`
}

export function exportLyrics(lines: LyricLine[], format: LyricFormat) {
  if (format === 'JSON') return JSON.stringify(lines, null, 2)
  if (format === 'SRT') {
    return lines.map(({ startMs, endMs, text }, index) =>
      `${index + 1}\n${lyricTimestamp(startMs, 'SRT')} --> ${lyricTimestamp(endMs, 'SRT')}\n${text}`
    ).join('\n\n')
  }
  return lines.map(({ startMs, text }) => `[${lyricTimestamp(startMs)}]${text}`).join('\n')
}

export function isYouTubeUrl(value: string) {
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return false

    const [, first, second] = url.pathname.split('/')
    const validId = (id?: string | null) => /^[\w-]{11}$/.test(id ?? '')
    if (url.hostname === 'youtu.be') return validId(first)
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) return false
    if (first === 'watch') return validId(url.searchParams.get('v'))
    return ['shorts', 'live', 'embed'].includes(first ?? '') && validId(second)
  } catch {
    return false
  }
}
