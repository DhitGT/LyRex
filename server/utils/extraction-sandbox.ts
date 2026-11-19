import { randomUUID } from 'node:crypto'
import { Sandbox } from '@vercel/sandbox'
import { extractionActive } from '../../shared/utils/lyrics'
import { updateCloudRun, withLog, writeCloudProject } from '../../engine/cloud-project'
import type { VersionedProject } from '../../engine/cloud-project'

export const cloudUploads = process.env.VERCEL === '1'

const sandboxTimeout = 30 * 60_000
const sources = [
  'engine/audio.ts', 'engine/separate.ts', 'engine/models.ts', 'engine/protocol.ts',
  'engine/cloud-project.ts', 'engine/cloud-worker.ts', 'engine/cloud-package.json',
  'server/utils/wav-waveform.ts', 'shared/utils/waveform.ts', 'shared/utils/pitch.ts', 'shared/utils/lyrics.ts',
]

async function sandboxFiles() {
  const storage = useStorage('assets:extraction-sandbox')
  return Promise.all(sources.map(async path => {
    const content = await storage.getItemRaw<string | Buffer>(path)
    if (content == null) throw new Error(`Missing sandbox source: ${path}`)
    return {
      path: path === 'engine/cloud-package.json' ? 'package.json' : path,
      content: Buffer.from(content),
    }
  }))
}

export async function launchCloudRun(project: VersionedProject) {
  if (project.run) await stopCloudRun(project)
  const run = { id: randomUUID(), expiresAt: Date.now() + sandboxTimeout + 60_000 }
  const job = await writeCloudProject({ ...project, run })
  let sandbox: Sandbox | undefined
  let stage = 'menyiapkan sandbox audio'
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN
    if (!token) throw new Error('Private Blob store is missing')
    const files = await sandboxFiles()
    sandbox = await Sandbox.create({
      name: `lyrex-${run.id}`,
      runtime: 'node24',
      resources: { vcpus: 4 },
      timeout: sandboxTimeout,
      persistent: false,
    })
    const sandboxName = sandbox.name
    const updateRun = (changes: { sandboxName: string, commandId?: string }) =>
      updateCloudRun(job.owner, job.id, run.id, current =>
        extractionActive(current.phase) ? { ...current, run: { ...current.run!, ...changes } } : current)
    const attached = await updateRun({ sandboxName })
    if (!attached || !extractionActive(attached.phase)) {
      await sandbox.stop()
      return attached ?? job
    }
    await sandbox.writeFiles(files)
    stage = 'menginstal FFmpeg dan dependensi audio'
    const installed = await sandbox.runCommand('npm', [
      'install', '--omit=dev', '--no-audit', '--no-fund', '--allow-scripts=ffmpeg-static,onnxruntime-node',
    ])
    if (installed.exitCode !== 0) {
      throw new Error(`npm install exited with code ${installed.exitCode}`)
    }
    stage = 'menjalankan worker audio'
    const command = await sandbox.runCommand({
      cmd: 'node',
      args: ['engine/cloud-worker.ts', job.owner, job.id, run.id],
      env: { BLOB_READ_WRITE_TOKEN: token },
      detached: true,
    })
    const launched = await updateRun({ sandboxName, commandId: command.cmdId })
    if (!launched || !extractionActive(launched.phase)) await sandbox.stop()
    return launched ?? job
  } catch (error) {
    if (sandbox) await sandbox.stop().catch(() => {})
    console.error(`[LyRex] Gagal ${stage}`, job.id, error)
    return (await updateCloudRun(job.owner, job.id, run.id, current =>
      extractionActive(current.phase)
        ? failedRun(current, 'Worker Vercel tidak bisa dimulai. Coba lagi.')
        : current)) ?? job
  }
}

function failedRun(project: VersionedProject, error: string) {
  return withLog({
    ...project,
    phase: 'failed',
    error,
    canUseOriginal: Boolean(project.durationMs && !project.useOriginal),
  }, { key: 'failed', message: error })
}

export async function stopCloudRun(project: VersionedProject) {
  const sandboxName = project.run?.sandboxName
  if (!sandboxName) return
  const sandbox = await Sandbox.get({ name: sandboxName })
  if (sandbox.status === 'running') await sandbox.stop()
}

export async function refreshCloudRun(project: VersionedProject) {
  const run = project.run!
  if (extractionActive(project.phase) && run.expiresAt > Date.now()) return project
  await stopCloudRun(project).catch(error => {
    console.error('[LyRex] Gagal menghentikan sandbox audio', project.id, error)
  })
  return (await updateCloudRun(project.owner, project.id, run.id, current => ({
    ...(extractionActive(current.phase) ? failedRun(current, 'Waktu pemrosesan di Vercel habis. Coba lagi.') : current),
    run: undefined,
  }))) ?? project
}
