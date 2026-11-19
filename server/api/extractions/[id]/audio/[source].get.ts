import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readWavWaveform } from '../../../../utils/wav-waveform'

export default defineEventHandler(async (event) => {
  const job = ownedJob(event)
  const source = getRouterParam(event, 'source')
  if ((source !== 'original' && source !== 'vocals') || !job.durationMs || (source === 'vocals' && !job.hasVocals)) {
    throw createError({ statusCode: 404, message: 'Audio belum tersedia.' })
  }
  const path = resolve(jobDirectory(job.id), `${source}.wav`)
  const query = getQuery(event)
  if (query.waveform === 'detail') {
    const fromMs = typeof query.from === 'string' ? Number(query.from) : NaN
    const toMs = typeof query.to === 'string' ? Number(query.to) : NaN
    if (!Number.isInteger(fromMs) || !Number.isInteger(toMs) || fromMs < 0 || toMs <= fromMs ||
      toMs > job.durationMs + 1 || toMs - fromMs > 3_000) {
      throw createError({ statusCode: 400, message: 'Rentang zoom waveform tidak valid.' })
    }
    return readWavWaveform(path, { fromMs, toMs, pitch: source === 'vocals' })
  }
  if (query.waveform === '1') {
    return readWavWaveform(path)
  }
  const size = (await stat(path)).size
  setResponseHeaders(event, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' })
  const range = getHeader(event, 'range')
  if (!range) {
    setResponseHeader(event, 'Content-Length', size)
    return sendStream(event, createReadStream(path))
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  const [, first, last] = match || []
  const start = first ? Number(first) : Math.max(0, size - Number(last))
  const end = first && last ? Math.min(size - 1, Number(last)) : size - 1
  if ((!first && !last) || !Number.isSafeInteger(start) || start < 0 || start > end) {
    setResponseHeader(event, 'Content-Range', `bytes */${size}`)
    throw createError({ statusCode: 416, message: 'Rentang audio tidak valid.' })
  }
  setResponseStatus(event, 206)
  setResponseHeaders(event, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
  return sendStream(event, createReadStream(path, { start, end }))
})
