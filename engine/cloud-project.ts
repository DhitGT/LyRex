import { BlobPreconditionFailedError, get, put } from '@vercel/blob'
import type { Extraction } from '../shared/utils/lyrics.ts'
import type { WorkerProgress } from './protocol.ts'

export interface Project extends Extraction {
  owner: string
  requestedLanguage: string
  extension: string
  createdAt: number
  invalidAudio?: boolean
  originalAudio?: string
  vocalsAudio?: string
  run?: { id: string, expiresAt: number, sandboxName?: string, commandId?: string }
}

export const projectVersion = Symbol('projectVersion')
export type VersionedProject = Project & { [projectVersion]?: string }

export function projectPath({ owner, id }: Pick<Project, 'owner' | 'id'>) {
  return `projects/${owner}/${id}/`
}

export async function readCloudProject(owner: string, id: string): Promise<VersionedProject | undefined> {
  const blob = await get(projectPath({ owner, id }) + 'job.json', { access: 'private', useCache: false })
  if (!blob || blob.statusCode !== 200) return
  const project: Project = await new Response(blob.stream).json()
  return { ...project, [projectVersion]: blob.blob.etag }
}

export async function writeCloudProject(project: VersionedProject) {
  const version = project[projectVersion]
  const result = await put(projectPath(project) + 'job.json', JSON.stringify(project), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: Boolean(version),
    ifMatch: version,
  })
  return { ...project, [projectVersion]: result.etag }
}

export function withLog<T extends Project>(job: T, progress: WorkerProgress): T {
  const key = `${job.startedAt ?? job.createdAt}/${progress.key}`
  const logs = (job.logs || []).filter(entry => entry.key !== key)
  logs.push({ ...progress, key, at: Date.now() })
  return { ...job, logs: logs.slice(-32) }
}

export async function updateCloudRun(
  owner: string,
  id: string,
  runId: string,
  update: (project: VersionedProject) => VersionedProject,
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await readCloudProject(owner, id)
    if (!current || current.run?.id !== runId) return
    try {
      return await writeCloudProject(update(current))
    } catch (error) {
      if (!(error instanceof BlobPreconditionFailedError) || attempt === 3) throw error
    }
  }
}
