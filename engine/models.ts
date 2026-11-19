import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ReportProgress } from './protocol.ts'

interface Asset {
  name: string
  path: string
  size: number
  sha256?: string
}

interface Model {
  name: string
  repo: string
  revision: string
  assets: Asset[]
}

const demucs: Model = {
  name: 'Demucs',
  repo: 'StemSplitio/htdemucs-ft-vocals-onnx',
  revision: '2ef0d757d3e226d0da85fb8c71514f464fcabdd0',
  assets: [{
    name: 'bobot vokal',
    path: 'htdemucs_ft_vocals_fp16weights.onnx',
    size: 165_612_636,
    sha256: '0cbe651f535415c9d26a7bb614f7d322dd5a080fa0298f2e50f478030a994dce'
  }]
}


function fileSize(bytes: number) {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`
    : `${(bytes / 1_000).toFixed(1).replace('.', ',')} KB`
}

async function download(model: Model, asset: Asset, target: string, signal: AbortSignal, report: ReportProgress) {
  const key = `${model.name}/${asset.path}`
  const partSize = asset.sha256 ? 8 * 1024 * 1024 : asset.size
  const parts = Math.ceil(asset.size / partSize)
  const sizes = new Array<number>(parts).fill(0)
  const temporary = target + '.download'
  const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${asset.path}`
  await mkdir(dirname(target), { recursive: true })
  const file = await open(temporary, 'w')
  let lastUpdate = -Infinity
  let part = 0
  const controller = new AbortController()
  const downloadSignal = AbortSignal.any([signal, controller.signal])

  function update(final = false) {
    if (!final && Date.now() - lastUpdate < 700) return
    lastUpdate = Date.now()
    const loaded = sizes.reduce((a, b) => a + b, 0)
    report({
      key,
      message: final
        ? `${model.name} · ${asset.name} tersimpan (${fileSize(asset.size)})`
        : `Mengunduh ${model.name} · ${asset.name} (${fileSize(loaded)} / ${fileSize(asset.size)})`,
      percent: final ? 100 : Math.min(99, Math.floor(loaded * 100 / asset.size))
    })
  }

  async function fetchParts() {
    try {
      while (part < parts) {
        const index = part++
        const start = index * partSize
        const end = Math.min(asset.size, start + partSize) - 1
        for (let attempt = 1; ; attempt++) {
          try {
            sizes[index] = 0
            const response = await fetch(`${url}?download=true&lyrexPart=${index}`, {
              headers: parts > 1 ? { Range: `bytes=${start}-${end}` } : {},
              signal: AbortSignal.any([downloadSignal, AbortSignal.timeout(120_000)])
            })
            const correctRange = response.status === 206 &&
              response.headers.get('content-range') === `bytes ${start}-${end}/${asset.size}`
            if (!response.body || (parts > 1 ? !correctRange : !response.ok)) {
              await response.body?.cancel()
              throw new Error(`Unduhan model ditolak (HTTP ${response.status})`)
            }
            for await (const chunk of response.body) {
              if (start + sizes[index] + chunk.length > end + 1) throw new Error('Ukuran bagian model melebihi batas')
              for (let offset = 0; offset < chunk.length;) {
                const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, start + sizes[index] + offset)
                if (!bytesWritten) throw new Error('Gagal menulis bobot model')
                offset += bytesWritten
              }
              sizes[index] += chunk.length
              update()
            }
            if (start + sizes[index] !== end + 1) throw new Error('Bagian model belum lengkap')
            break
          } catch (error) {
            if (downloadSignal.aborted || attempt >= 3) throw error
            report({ key: key + '/retry', message: `Koneksi unduhan ${model.name} terputus. Mengulangi bagian ${index + 1}.` })
            await sleep(attempt * 1_000, undefined, { signal: downloadSignal })
          }
        }
      }
    } catch (error) {
      controller.abort(error)
      throw error
    }
  }

  update()
  try {
    const results = await Promise.allSettled(Array.from({ length: Math.min(parts, 4) }, fetchParts))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw controller.signal.reason || failure.reason
  } finally {
    await file.close()
  }

  if (asset.sha256) {
    report({ key, message: `Memeriksa checksum ${model.name} · ${asset.name}` })
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(temporary, { signal })) hash.update(chunk)
    if (hash.digest('hex') !== asset.sha256) throw new Error(`Checksum bobot ${model.name} tidak cocok`)
  }
  await rename(temporary, target)
  update(true)
}

async function prepare(model: Model, root: string, signal: AbortSignal, report: ReportProgress) {
  const folder = resolve(root, model.name.toLowerCase(), model.revision)
  let cached = 0
  for (const asset of model.assets) {
    const target = resolve(folder, asset.path)
    const size = await stat(target).then(file => file.size, () => undefined)
    if (size === asset.size) {
      cached++
      continue
    }
    try {
      await download(model, asset, target, signal, report)
    } catch (error) {
      await rm(target + '.download', { force: true }).catch(() => {})
      throw error
    }
  }
  if (cached === model.assets.length) {
    report({ key: 'model-cache', message: `Memakai model ${model.name} dari cache lokal` })
  }
  return folder
}

export async function demucsModel(root: string, signal: AbortSignal, report: ReportProgress) {
  return resolve(await prepare(demucs, root, signal, report), demucs.assets[0]!.path)
}

