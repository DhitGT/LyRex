import type { LyricsSearchResult } from '#shared/utils/lyrics'

export interface LrclibRecord {
  id: number
  trackName: string
  artistName: string
  albumName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

async function query<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(8_000)
  const response = await fetch(`https://lrclib.net/api/${path}`, {
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout
  }).catch(() => { throw new Error('LRCLIB belum bisa dihubungi. Coba lagi sebentar.') })
  if (response.status === 429) throw new Error('LRCLIB membatasi pencarian. Tunggu sebentar sebelum mencoba lagi.')
  if (!response.ok) throw new Error('LRCLIB belum bisa dihubungi. Coba lagi sebentar.')
  return response.json()
}

export async function searchLyricsReferences(track: string, artist: string, signal: AbortSignal) {
  const queryParams = new URLSearchParams({ track_name: track })
  if (artist) queryParams.set('artist_name', artist)
  const records = await query<LrclibRecord[]>(`search?${queryParams}`, signal)
  return records.flatMap(record => {
    const result = lrclibResult(record)
    return result ? [result] : []
  }).slice(0, 12)
}

export async function getLyricsReference(id: number) {
  return lrclibResult(await query<LrclibRecord>(`get/${id}`))
}

export function lrclibResult(record: LrclibRecord): LyricsSearchResult | undefined {
  if (!record || record.instrumental || !Number.isSafeInteger(record.id) || record.id <= 0 ||
    typeof record.trackName !== 'string' || typeof record.artistName !== 'string') return undefined
  const syncedLyrics = typeof record.syncedLyrics === 'string' && record.syncedLyrics.length <= 30_000
    ? record.syncedLyrics : undefined
  const text = (typeof record.plainLyrics === 'string' ? record.plainLyrics.trim() : '') || syncedLyrics?.split(/\r?\n/)
    .filter(line => /^\[\d{1,3}:\d{2}/.test(line.trim()))
    .map(line => line.replace(/^(?:\s*\[\d{1,3}:\d{2}(?:[.:]\d+)?\])+\s*/, '')).join('\n').trim()
  if (!text || text.length > 30_000) return undefined
  return {
    id: record.id, trackName: record.trackName.slice(0, 200), artistName: record.artistName.slice(0, 200),
    albumName: typeof record.albumName === 'string' ? record.albumName.slice(0, 500) : '',
    duration: typeof record.duration === 'number' && Number.isFinite(record.duration) ? Math.max(0, record.duration) : 0,
    text, syncedLyrics
  }
}
