import { readFile, rename } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { InferenceSession, Tensor } from 'onnxruntime-node'
import { openVocalWav, SAMPLE_RATE, wavData } from './audio.ts'
import { demucsModel } from './models.ts'
import type { ReportProgress } from './protocol.ts'

// Dimensions and stem order of the pinned StemSplit HTDemucs graph.
const segment = Math.round(7.8 * SAMPLE_RATE)
const overlap = Math.floor(segment / 4)
const stride = segment - overlap
const vocalRow = 3

export async function separateVocals(directory: string, models: string, signal: AbortSignal, report: ReportProgress) {
  const model = await demucsModel(models, signal, report)
  report({ key: 'demucs-init', message: 'Menyiapkan Demucs ONNX di CPU' })
  const session = await InferenceSession.create(model, {
    executionProviders: ['cpu'],
    intraOpNumThreads: Math.min(8, availableParallelism())
  })
  const temporary = resolve(directory, 'vocals.tmp.wav')
  try {
    const audio = wavData(await readFile(resolve(directory, 'original.wav')))
    const total = audio.length / 4
    const count = 1 + Math.ceil(Math.max(0, total - segment) / stride)
    const input = new Float32Array(2 * segment)
    const tail = new Float32Array(2 * overlap)
    const file = await openVocalWav(temporary, total)

    try {
      for (let index = 0; index < count; index++) {
        signal.throwIfAborted()
        const start = index * stride
        const frames = Math.min(segment, total - start)
        report({
          key: 'separate-chunks',
          message: `Memisahkan vokal · bagian ${index + 1} dari ${count} (${Math.round(start / SAMPLE_RATE)} detik)`,
          percent: Math.floor(index * 100 / count)
        })
        input.fill(0)
        let audible = false
        for (let sample = 0; sample < frames; sample++) {
          const from = (start + sample) * 4
          const left = audio.readInt16LE(from)
          const right = audio.readInt16LE(from + 2)
          input[sample] = left / 32_768
          input[segment + sample] = right / 32_768
          audible ||= Math.abs(left) > 1 || Math.abs(right) > 1
        }

        const output = audible ? (await session.run({
          mix: new Tensor('float32', input, [1, 2, segment])
        })).stems : undefined
        if (audible && (!output || output.dims.join(',') !== `1,4,2,${segment}`)) {
          throw new Error('Unexpected Demucs output shape')
        }
        const samples = output?.data as Float32Array | undefined
        const writeFrames = index === count - 1 ? frames : stride
        const pcm = Buffer.allocUnsafe(writeFrames * 4)
        for (let channel = 0; channel < 2; channel++) {
          const offset = (vocalRow * 2 + channel) * segment
          for (let sample = 0; sample < writeFrames; sample++) {
            let value = samples?.[offset + sample] ?? 0
            if (index > 0 && sample < overlap) {
              const weight = (sample + 1) / (overlap + 1)
              value = value * weight + tail[channel * overlap + sample]! * (1 - weight)
            }
            if (!Number.isFinite(value)) throw new Error('Invalid sample in vocal stem')
            pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32_767), sample * 4 + channel * 2)
          }
          if (index < count - 1) {
            for (let sample = 0; sample < overlap; sample++) {
              tail[channel * overlap + sample] = samples?.[offset + stride + sample] ?? 0
            }
          }
        }
        output?.dispose()
        await file.writeFile(pcm)
      }
    } finally {
      await file.close()
    }
    await rename(temporary, resolve(directory, 'vocals.wav'))
    report({ key: 'separate-chunks', message: `Stem vokal tersimpan · ${count} dari ${count} bagian`, percent: 100 })
  } finally {
    await session.release()
  }
  return {}
}
