import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { get, head } from '@vercel/blob'
import type { H3Event } from 'h3'
import { readWavWaveform, readWaveform } from '../../../../utils/wav-waveform'

function byteRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  const [, first, last] = match || []
  if ((!first && !last) || (!first && Number(last) < 1)) return
  const start = first ? Number(first) : Math.max(0, size - Number(last))
  const end = first && last ? Math.min(size - 1, Number(last)) : size - 1
  if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= size) return
  return { start, end }
}

async function privateBlob(pathname: string, range?: string) {
  const blob = await get(pathname, {
    access: 'private',
    headers: range ? { range } : undefined,
  })
  if (!blob || blob.statusCode !== 200) throw createError({ statusCode: 404, message: 'Audio belum tersedia.' })
  return blob
}

async function readPrivateWaveform(pathname: string) {
  const blob = await privateBlob(pathname + '.waveform.json')
  return new Response(blob.stream).json()
}

async function readPrivateWaveformDetail(pathname: string, size: number, fromMs: number, toMs: number, pitch: boolean) {
  return readWaveform(size, async (buffer, offset, length) => {
    const blob = await privateBlob(pathname, `bytes=${offset}-${offset + length - 1}`)
    const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(blob.headers.get('content-range') || '')
    const data = Buffer.from(await new Response(blob.stream).arrayBuffer())
    if (!contentRange || Number(contentRange[1]) !== offset || Number(contentRange[2]) !== offset + length - 1 ||
      Number(contentRange[3]) !== size || data.length !== length) {
      throw new Error('Private Blob did not return the requested audio range')
    }
    data.copy(buffer)
  }, { fromMs, toMs, pitch })
}

async function sendPrivateAudio(event: H3Event, pathname: string, rangeHeader?: string) {
  const size = rangeHeader ? (await head(pathname)).size : undefined
  const range = rangeHeader && size !== undefined ? byteRange(rangeHeader, size) : undefined
  if (rangeHeader && !range) {
    setResponseHeader(event, 'Content-Range', `bytes */${size}`)
    throw createError({ statusCode: 416, message: 'Rentang audio tidak valid.' })
  }
  const blob = await privateBlob(pathname, range ? `bytes=${range.start}-${range.end}` : undefined)
  setResponseHeaders(event, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' })
  if (!range) {
    setResponseHeader(event, 'Content-Length', blob.blob.size)
    return sendStream(event, Readable.fromWeb(blob.stream))
  }
  const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(blob.headers.get('content-range') || '')
  if (!contentRange || Number(contentRange[1]) !== range.start || Number(contentRange[2]) !== range.end ||
    Number(contentRange[3]) !== size || blob.blob.size !== range.end - range.start + 1) {
    throw createError({ statusCode: 502, message: 'Penyimpanan audio tidak mendukung rentang byte yang diminta.' })
  }
  setResponseStatus(event, 206)
  setResponseHeaders(event, {
    'Content-Range': contentRange[0],
    'Content-Length': blob.blob.size,
  })
  return sendStream(event, Readable.fromWeb(blob.stream))
}

export default defineEventHandler(async (event) => {
  const job = await ownedJob(event)
  const source = getRouterParam(event, 'source')
  if ((source !== 'original' && source !== 'vocals') || !job.durationMs || (source === 'vocals' && !job.hasVocals)) {
    throw createError({ statusCode: 404, message: 'Audio belum tersedia.' })
  }
  const blobPath = source === 'original' ? job.originalAudio : job.vocalsAudio
  const path = resolve(jobDirectory(job.id), `${source}.wav`)
  const query = getQuery(event)
  if (query.waveform === 'detail') {
    const fromMs = typeof query.from === 'string' ? Number(query.from) : NaN
    const toMs = typeof query.to === 'string' ? Number(query.to) : NaN
    if (!Number.isInteger(fromMs) || !Number.isInteger(toMs) || fromMs < 0 || toMs <= fromMs ||
      toMs > job.durationMs + 1 || toMs - fromMs > 3_000) {
      throw createError({ statusCode: 400, message: 'Rentang zoom waveform tidak valid.' })
    }
    if (blobPath) {
      const { size } = await head(blobPath)
      return readPrivateWaveformDetail(blobPath, size, fromMs, toMs, source === 'vocals')
    }
    return readWavWaveform(path, { fromMs, toMs, pitch: source === 'vocals' })
  }
  if (query.waveform === '1') {
    if (blobPath) return readPrivateWaveform(blobPath)
    return readWavWaveform(path)
  }
  if (blobPath) return sendPrivateAudio(event, blobPath, getHeader(event, 'range'))
  const size = (await stat(path)).size
  setResponseHeaders(event, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' })
  const range = getHeader(event, 'range')
  if (!range) {
    setResponseHeader(event, 'Content-Length', size)
    return sendStream(event, createReadStream(path))
  }
  const bounds = byteRange(range, size)
  if (!bounds) {
    setResponseHeader(event, 'Content-Range', `bytes */${size}`)
    throw createError({ statusCode: 416, message: 'Rentang audio tidak valid.' })
  }
  setResponseStatus(event, 206)
  setResponseHeaders(event, {
    'Content-Range': `bytes ${bounds.start}-${bounds.end}/${size}`,
    'Content-Length': bounds.end - bounds.start + 1,
  })
  return sendStream(event, createReadStream(path, { start: bounds.start, end: bounds.end }))
})
