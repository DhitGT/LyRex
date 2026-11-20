<script setup lang="ts">
import { extractionLabels, lyricTimestamp, projectTitle } from '#shared/utils/lyrics'
import type { Extraction, ProjectSummary } from '#shared/utils/lyrics'
import EarphoneLatency from '~/components/EarphoneLatency.vue'
import { listLocalProjects } from '~/utils/local-projects'

useSeoMeta({ title: 'Studio LyRex', description: 'Kelola proyek audio, transkrip, dan draft lirik.' })

const route = useRoute()
const router = useRouter()
const projects = shallowRef<ProjectSummary[]>([])
const status = ref<'pending' | 'ready'>('pending')
const error = ref(false)
async function refresh() {
  status.value = 'pending'
  error.value = false
  try {
    projects.value = await listLocalProjects()
  } catch {
    error.value = true
  } finally {
    status.value = 'ready'
  }
}
onMounted(() => void refresh())
const projectsOpen = ref(false)
const workspace = useTemplateRef<HTMLElement>('workspace')
const explicitId = computed(() => typeof route.query.project === 'string' &&
  /^[a-f0-9-]{36}$/.test(route.query.project) ? route.query.project : undefined)
const projectId = computed(() => route.query.new ? undefined : explicitId.value ?? projects.value[0]?.id)

watch(projectId, () => { projectsOpen.value = false })

function studioLink(id: string, panel?: string) {
  return { path: '/studio', query: { project: id, ...(panel ? { panel } : {}) } }
}

function updateProject(job: Extraction) {
  const current = projects.value.find(project => project.id === job.id)
  if (!current) return
  projects.value = projects.value.map(project => project.id === job.id
    ? { ...project, title: job.title, phase: job.phase, durationMs: job.durationMs }
    : project)
}

async function created(job: Extraction) {
  projects.value = [{
    id: job.id, phase: job.phase, name: job.name, title: job.title, createdAt: Date.now(), durationMs: job.durationMs
  }, ...projects.value.filter(project => project.id !== job.id)]
  await router.push(studioLink(job.id, 'progres'))
  await nextTick()
  workspace.value?.focus()
}

async function removed(id: string) {
  projects.value = projects.value.filter(project => project.id !== id)
  const latest = projects.value[0]
  await router.replace(latest ? studioLink(latest.id) : { path: '/studio', query: { new: '1' } })
  await refresh()
}
</script>

<template>
  <div class="studio">
    <a class="skip-link" href="#studio-workspace">Langsung ke ruang kerja</a>
    <header class="studio-header">
      <div class="studio-brand">
        <NuxtLink class="brand" to="/" aria-label="LyRex, halaman utama">
          <span class="brand-mark" aria-hidden="true"><i /><i /><i /><i /><i /></span>
          <span>LyRex<span class="brand-period">.</span></span>
        </NuxtLink>
        <span class="studio-brand-label">Studio</span>
      </div>
      <div class="studio-header-actions">
        <EarphoneLatency />
        <button type="button" class="studio-mobile-projects" :aria-expanded="projectsOpen"
          aria-label="Daftar proyek" aria-controls="studio-projects" @click="projectsOpen = !projectsOpen">
          <UIcon name="i-lucide-folder-open" aria-hidden="true" /><span>Proyek</span>
        </button>
        <UButton :to="{ path: '/studio', query: { new: '1' } }" icon="i-lucide-plus" class="studio-new" aria-label="Proyek baru">
          <span class="studio-new-label">Proyek baru</span>
        </UButton>
      </div>
    </header>

    <div class="studio-layout">
      <aside id="studio-projects" class="studio-sidebar" :class="{ 'studio-sidebar-open': projectsOpen }" aria-labelledby="studio-projects-title">
        <div class="studio-sidebar-heading">
          <h2 id="studio-projects-title">Proyek kamu</h2>
          <span>{{ projects.length }}</span>
        </div>
        <p v-if="status === 'pending'" class="studio-sidebar-note">Memuat proyek…</p>
        <p v-else-if="error" class="studio-sidebar-note">Daftar proyek gagal dimuat.
          <button type="button" class="studio-link" @click="refresh()">Coba lagi</button>
        </p>
        <p v-else-if="!projects.length" class="studio-sidebar-note">Proyek yang kamu buat akan muncul di sini.</p>
        <nav v-else aria-label="Proyek tersimpan" class="studio-project-list">
          <NuxtLink v-for="project in projects" :key="project.id" :to="studioLink(project.id)"
            class="studio-project-link" :class="{ 'is-current': projectId === project.id }"
            :aria-current="projectId === project.id ? 'page' : undefined" @click="projectsOpen = false">
            <span class="studio-project-icon"><UIcon name="i-lucide-audio-lines" aria-hidden="true" /></span>
            <span class="studio-project-text">
              <strong :title="projectTitle(project)">{{ projectTitle(project) }}</strong>
              <small>{{ extractionLabels[project.phase] }}<template v-if="project.durationMs"> · {{ lyricTimestamp(project.durationMs).split('.')[0] }}</template></small>
            </span>
          </NuxtLink>
        </nav>
      </aside>

      <main id="studio-workspace" ref="workspace" tabindex="-1" class="studio-workspace">
        <StudioProject v-if="projectId" :id="projectId" :key="projectId" @updated="updateProject" @removed="removed" />
        <div v-else class="studio-create">
          <div class="studio-create-intro">
            <span class="studio-hero-icon"><UIcon name="i-lucide-audio-lines" aria-hidden="true" /></span>
            <h1>Proyek baru</h1>
            <p>Mulai dengan satu lagu. Audio, transkrip, dan lirik tersimpan di browser ini.</p>
          </div>
          <AudioUpload @created="created" />
        </div>
      </main>
    </div>
  </div>
</template>

<style src="~/assets/css/studio.css"></style>
