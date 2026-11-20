import { env, InferenceSession, Tensor } from 'onnxruntime-web/wasm'
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import wasmModule from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import { pcm16, readPcm, sampleRate, wavHeader } from '../utils/local-wav'
import type { VocalWorkerMessage } from '../utils/vocal-worker'

const modelUrl = 'https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx/resolve/2ef0d757d3e226d0da85fb8c71514f464fcabdd0/htdemucs_ft_vocals_fp16weights.onnx'
const modelSize = 165_612_636
const checksum = '0cbe651f535415c9d26a7bb614f7d322dd5a080fa0298f2e50f478030a994dce'
const segment = Math.round(7.8 * sampleRate)
const overlap = Math.floor(segment / 4)
const stride = segment - overlap

function send(message: VocalWorkerMessage) {
  self.postMessage(message)
}

function progress(key: string, message: string, percent?: number) {
  send({ type: 'progress', key, message, percent })
}

async function loadModel() {
  const cache = await caches.open('lyrex-vocals-v1').catch(() => undefined)
  const cached = await cache?.match(modelUrl).catch(() => undefined)
  if (cached) {
    progress('model', 'Membaca model Demucs dari cache.')
    const bytes = await cached.arrayBuffer().catch(() => undefined)
    if (bytes?.byteLength === modelSize) return bytes
  }
  progress('model', 'Mengunduh Demucs (~166 MB).', 0)
  const response = await fetch(modelUrl).catch(() => {
    throw new Error('Model Demucs gagal diunduh. Periksa koneksi dan coba lagi.')
  })
  if (!response.ok || !response.body) throw new Error(`Model Demucs gagal diunduh (HTTP ${response.status}).`)
  const reader = response.body.getReader()
  const bytes = new Uint8Array(modelSize)
  let loaded = 0
  let last = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.length > bytes.length - loaded) throw new Error('Ukuran model Demucs tidak valid.')
      bytes.set(value, loaded)
      loaded += value.length
      if (Date.now() - last >= 700) {
        last = Date.now()
        progress('model', 'Mengunduh Demucs (~166 MB).', Math.min(99, Math.floor(loaded * 100 / modelSize)))
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  if (loaded !== modelSize) throw new Error('Unduhan model Demucs belum lengkap.')
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  if (Array.from(hash, value => value.toString(16).padStart(2, '0')).join('') !== checksum) {
    throw new Error('Checksum model Demucs tidak cocok.')
  }
  await cache?.put(modelUrl, new Response(bytes)).catch(() => {})
  return bytes.buffer
}

async function separate(wav: Blob) {
  const model = await loadModel()
  progress('demucs-init', 'Menyiapkan Demucs di browser.')
  env.wasm.wasmPaths = { wasm: new URL(wasm, self.location.href).href, mjs: new URL(wasmModule, self.location.href).href }
  env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1
  // The default graph optimizer exhausts the WASM heap for this Demucs export.
  const session = await InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'disabled' })
  try {
    const frames = (wav.size - 44) / 4
    const count = 1 + Math.ceil(Math.max(0, frames - segment) / stride)
    const input = new Float32Array(segment * 2)
    const tail = new Float32Array(overlap * 2)
    const output: BlobPart[] = [wavHeader(frames, 2)]
    for (let index = 0; index < count; index++) {
      progress('separate', `Memisahkan vokal · bagian ${index + 1} dari ${count}`, Math.floor(index * 100 / count))
      const first = index * stride
      const length = Math.min(segment, frames - first)
      const pcm = await readPcm(wav, first, first + length)
      input.fill(0)
      let audible = false
      for (let frame = 0; frame < length; frame++) {
        const left = pcm.getInt16(frame * 4, true)
        const right = pcm.getInt16(frame * 4 + 2, true)
        input[frame] = left / 32_768
        input[segment + frame] = right / 32_768
        audible ||= Math.abs(left) > 1 || Math.abs(right) > 1
      }
      const tensor = new Tensor('float32', input, [1, 2, segment])
      let stems: Tensor | undefined
      try {
        if (audible) stems = (await session.run({ mix: tensor })).stems
        if (audible && (!stems || stems.dims.join(',') !== `1,4,2,${segment}`)) throw new Error('Output Demucs tidak valid.')
        const samples = stems?.data as Float32Array | undefined
        const writeFrames = index === count - 1 ? length : stride
        const part = new DataView(new ArrayBuffer(writeFrames * 4))
        for (let channel = 0; channel < 2; channel++) {
          const offset = (6 + channel) * segment
          for (let frame = 0; frame < writeFrames; frame++) {
            let value = samples?.[offset + frame] ?? 0
            if (index > 0 && frame < overlap) {
              const weight = (frame + 1) / (overlap + 1)
              value = value * weight + tail[channel * overlap + frame]! * (1 - weight)
            }
            if (!Number.isFinite(value)) throw new Error('Sampel vokal Demucs tidak valid.')
            part.setInt16(frame * 4 + channel * 2, pcm16(value), true)
          }
          if (index < count - 1) {
            for (let frame = 0; frame < overlap; frame++) {
              tail[channel * overlap + frame] = samples?.[offset + stride + frame] ?? 0
            }
          }
        }
        output.push(part.buffer)
      } finally {
        stems?.dispose()
        tensor.dispose()
      }
    }
    return new Blob(output, { type: 'audio/wav' })
  } finally {
    await session.release()
  }
}

self.addEventListener('message', async ({ data }: MessageEvent<Blob>) => {
  try {
    send({ type: 'done', wav: await separate(data) })
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : 'Pemisahan vokal gagal.' })
  }
})
