import type { LyricsSearchResult } from '../../../shared/utils/lyrics'
import { lrclibOptions, lrclibResult } from '../../utils/lrclib'
import type { LrclibRecord } from '../../utils/lrclib'

export default defineEventHandler(async (event): Promise<LyricsSearchResult[]> => {
  const { title, artist } = getQuery(event)
  const track = typeof title === 'string' ? title.trim() : ''
  const name = typeof artist === 'string' ? artist.trim() : ''
  if (!track || track.length > 120 || name.length > 120) {
    throw createError({ statusCode: 400, message: 'Masukkan judul lagu yang valid.' })
  }

  try {
    const records = await $fetch<LrclibRecord[]>('https://lrclib.net/api/search', {
      query: { track_name: track, ...(name ? { artist_name: name } : {}) },
      ...lrclibOptions
    })
    return records.flatMap(record => {
      const result = lrclibResult(record)
      return result ? [result] : []
    }).slice(0, 12)
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode
    throw createError({
      statusCode: status === 429 ? 429 : 502,
      message: status === 429 ? 'LRCLIB membatasi pencarian. Tunggu sebentar sebelum mencoba lagi.'
        : 'LRCLIB belum bisa dihubungi. Coba lagi sebentar.'
    })
  }
})
