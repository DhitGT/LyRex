import { randomUUID } from 'node:crypto'
import { Sandbox } from '@vercel/sandbox'
import { extractionActive } from '../../shared/utils/lyrics'
import { updateCloudRun, withLog, writeCloudProject } from '../../engine/cloud-project'
import type { VersionedProject } from '../../engine/cloud-project'

export const cloudUploads = process.env.VERCEL === '1'

const sandboxTimeout = 30 * 60_000
const sources = [
  { path: 'engine/audio.ts', mount: 'extraction-sandbox-engine', key: 'audio.ts' },
  { path: 'engine/separate.ts', mount: 'extraction-sandbox-engine', key: 'separate.ts' },
  { path: 'engine/models.ts', mount: 'extraction-sandbox-engine', key: 'models.ts' },
  { path: 'engine/protocol.ts', mount: 'extraction-sandbox-engine', key: 'protocol.ts' },
  { path: 'engine/cloud-project.ts', mount: 'extraction-sandbox-engine', key: 'cloud-project.ts' },
  { path: 'engine/cloud-worker.ts', mount: 'extraction-sandbox-engine', key: 'cloud-worker.ts' },
  { path: 'engine/cloud-package.json', mount: 'extraction-sandbox-engine', key: 'cloud-package.json' },
  { path: 'server/utils/wav-waveform.ts', mount: 'extraction-sandbox-server', key: 'wav-waveform.ts' },
  { path: 'shared/utils/waveform.ts', mount: 'extraction-sandbox-shared', key: 'waveform.ts' },
  { path: 'shared/utils/pitch.ts', mount: 'extraction-sandbox-shared', key: 'pitch.ts' },
  { path: 'shared/utils/lyrics.ts', mount: 'extraction-sandbox-shared', key: 'lyrics.ts' },
]

async function sandboxFiles() {
  return Promise.all(sources.map(async source => {
    const storage = useStorage(`assets:${source.mount}`)
    const content = await storage.getItemRaw<string | Buffer>(source.key)
    if (content == null) {
      const keys = await storage.getKeys()
      throw new Error(`Missing sandbox source: ${source.path} (available: ${keys.join(', ') || 'none'})`)
    }
    return {
      path: source.path === 'engine/cloud-package.json' ? 'package.json' : source.path,
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
      const [stdout, stderr] = await Promise.all([installed.stdout(), installed.stderr()])
      const output = [stdout, stderr].filter(Boolean).join('\n').trim().slice(-6_000)
      throw new Error(`npm install exited with code ${installed.exitCode}${output ? `\n${output}` : ''}`)
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
