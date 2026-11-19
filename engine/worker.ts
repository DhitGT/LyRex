import type { ReportProgress, Stage, WorkerMessage } from './protocol.ts'

const controller = new AbortController()
const signal = controller.signal
process.on('message', message => {
  if (message === 'cancel') controller.abort()
})
process.on('disconnect', () => controller.abort())

function send(message: WorkerMessage) {
  if (process.connected) process.send?.(message)
}

async function run() {
  const [stage, directory, value, models] = process.argv.slice(2)
  if (!directory || !models) throw new Error('Missing worker arguments')
  const report: ReportProgress = progress => send({ progress })
  switch (stage as Stage) {
    case 'decode': {
      const { decodeAudio } = await import('./audio.ts')
      return decodeAudio(directory, value || '', signal, report)
    }
    case 'separate': {
      const { separateVocals } = await import('./separate.ts')
      return separateVocals(directory, models, signal, report)
    }
    default: throw new Error('Unknown worker stage')
  }
}

try {
  send({ result: await run() })
} catch (error) {
  if (!signal.aborted) {
    console.error(error)
    send({ failure: error instanceof Error ? error.message : String(error) })
  }
  process.exitCode = 1
} finally {
  if (process.connected) process.disconnect?.()
}
