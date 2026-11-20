export type VocalWorkerMessage =
  | { type: 'progress', key: string, message: string, percent?: number }
  | { type: 'done', wav: Blob }
  | { type: 'error', message: string }

export function separateLocalVocals(wav: Blob, signal: AbortSignal,
  report: (message: Extract<VocalWorkerMessage, { type: 'progress' }>) => void) {
  signal.throwIfAborted()
  const worker = new Worker(new URL('../workers/vocals.ts', import.meta.url), { type: 'module' })
  return new Promise<Blob>((resolve, reject) => {
    const abort = () => finish(() => reject(signal.reason))
    function finish(settle: () => void) {
      signal.removeEventListener('abort', abort)
      worker.terminate()
      settle()
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = ({ data }: MessageEvent<VocalWorkerMessage>) => {
      if (data.type === 'progress') report(data)
      if (data.type === 'done') finish(() => resolve(data.wav))
      if (data.type === 'error') finish(() => reject(new Error(data.message)))
    }
    worker.onerror = () => finish(() => reject(new Error('Worker Demucs gagal. Browser mungkin kehabisan memori.')))
    worker.onmessageerror = () => finish(() => reject(new Error('Hasil dari worker Demucs tidak bisa dibaca.')))
    worker.postMessage(wav)
  })
}
