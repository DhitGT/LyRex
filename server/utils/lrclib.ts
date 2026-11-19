import type { LyricsSearchResult } from '../../shared/utils/lyrics'

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

export const lrclibOptions = {
  headers: { 'User-Agent': 'LyRex/0.1 (lyrics alignment)' },
  timeout: 8_000,
  retry: 0
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
