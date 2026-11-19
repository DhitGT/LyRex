<script setup lang="ts">
import { extractionActive, extractionLabels, lyricTimestamp, projectTitle, projectTitleMaxLength } from '#shared/utils/lyrics'
import type { Extraction, LyricsSearchResult, SpeechTranscript } from '#shared/utils/lyrics'
import { alignSyncedLyrics, estimateWordsFromLines } from '~/utils/align-lyrics'
import BrowserSpeech from './BrowserSpeech.vue'

const props = defineProps<{ id: string }>()
const emit = defineEmits<{ updated: [job: Extraction], removed: [id: string] }>()
const route = useRoute()
const router = useRouter()
const job = shallowRef<Extraction>()
const loading = ref(true)
const error = ref('')
const titleOpen = ref(false)
const titleDraft = ref('')
const titleError = ref('')
const savingTitle = ref(false)
const referenceError = ref('')
const savingReference = ref(false)
const referenceOpen = ref(false)
const restoringReference = ref(false)
const acting = ref(false)
const speechRunning = ref(false)
const speech = useTemplateRef<InstanceType<typeof BrowserSpeech>>('speech')
const canTranscribe = computed(() => job.value?.phase === 'awaitingSpeech' || job.value?.phase === 'ready')
const active = computed(() => job.value && extractionActive(job.value.phase))
const tabs = [
  { id: 'audio', label: 'Audio', icon: 'i-lucide-audio-lines' },
  { id: 'lrclib', label: 'LRCLIB', icon: 'i-lucide-book-open' },
  { id: 'transkrip', label: 'Transkrip', icon: 'i-lucide-mic' },
  { id: 'editor', label: 'Editor', icon: 'i-lucide-square-pen' },
  { id: 'draft', label: 'Draft', icon: 'i-lucide-file-text' },
  { id: 'progres', label: 'Progres', icon: 'i-lucide-list-checks' }
] as const
type Panel = typeof tabs[number]['id']
const panel = computed<Panel>(() => tabs.find(tab => tab.id === route.query.panel)?.id ??
  (job.value?.lines ? 'draft' : canTranscribe.value ? 'transkrip' : 'progres'))
const selected = computed(() => job.value?.selectedReference)
const legacyReference = computed<LyricsSearchResult | undefined>(() => {
  const reference = job.value?.lyricReference
  const lines = job.value?.lines
  if (!reference || !lines?.length) return undefined
  const { id, trackName, artistName } = reference
  return { id, trackName, artistName, albumName: '', duration: 0, text: lines.map(line => line.text).join('\n') }
})
const displayedReference = computed(() => selected.value ?? legacyReference.value)
const synced = computed(() => selected.value && job.value?.durationMs
  ? alignSyncedLyrics(selected.value, job.value.durationMs) : undefined)
const completeTranscript = computed(() => job.value?.transcript)
const checkpoint = computed(() => job.value?.speechCheckpoint)
const legacyTranscript = computed(() =>
  job.value?.lyricReference || job.value?.draftSource === 'editor' ? undefined : job.value?.lines)
const showingCheckpoint = ref(false)
const inspectedTranscript = computed(() => showingCheckpoint.value || !completeTranscript.value ? checkpoint.value : completeTranscript.value)
const transcriptJob = computed<Extraction | undefined>(() => {
  const raw = inspectedTranscript.value
  const project = job.value
  const lines = raw?.lines ?? legacyTranscript.value
  if (!lines || !project) return undefined
  return { id: project.id, name: `${project.name.replace(/\.[^.]+$/, '')}-web-speech`, phase: 'ready',
    hasVocals: project.hasVocals, useOriginal: raw ? raw.source === 'original' : project.useOriginal,
    lines, durationMs: project.durationMs, estimatedTiming: true }
})
const hasTranscriptForDraft = computed(() => Boolean(job.value?.transcript?.lines.length ||
  legacyTranscript.value?.length))
const legacyWords = computed(() => job.value?.lyricReference && estimateWordsFromLines(job.value.lines || []))
const canRefine = computed(() => job.value?.hasVocals && !job.value.vocalTiming && Boolean(job.value.lines?.length))
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let request = 0
let attemptedReference: number | undefined

function openPanel(value: Panel) {
  return router.replace({ query: { project: props.id, panel: value } })
}

function moveTab(event: KeyboardEvent, index: number) {
  const destinations: Record<string, number> = { ArrowRight: (index + 1) % tabs.length,
    ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }
  const next = destinations[event.key]
  const tab = next === undefined ? undefined : tabs[next]
  if (!tab) return
  event.preventDefault()
  openPanel(tab.id)
  document.getElementById(`studio-tab-${tab.id}`)?.focus()
}

function details(cause: unknown, fallback: string) {
  const response = cause as { data?: { data?: { message?: string } } }
  return response.data?.data?.message || fallback
}

function update(next: Extraction, preserveTitle = false) {
  if (disposed) return
  clearTimeout(timer)
  if (preserveTitle && job.value) next = { ...next, title: job.value.title }
  job.value = next
  emit('updated', next)
  if (extractionActive(next.phase)) timer = setTimeout(() => void load(), 1_200)
}

watch(titleOpen, open => {
  if (!open || !job.value) return
  titleDraft.value = projectTitle(job.value)
  titleError.value = ''
})

async function renameProject() {
  const title = titleDraft.value.trim()
  if (!title || savingTitle.value || !job.value) return
  savingTitle.value = true
  titleError.value = ''
  try {
    const saved = await $fetch<{ title: string }>(`/api/extractions/${props.id}/title`, {
      method: 'PUT', body: { title }
    })
    if (disposed || !job.value) return
    ++request
    update({ ...job.value, title: saved.title })
    titleOpen.value = false
  } catch (cause) {
    titleError.value = details(cause, 'Judul gagal disimpan. Coba lagi.')
  } finally {
    savingTitle.value = false
  }
}

async function load() {
  const version = ++request
  try {
    const next = await $fetch<Extraction>(`/api/extractions/${props.id}`)
    if (disposed || version !== request) return
    error.value = ''
    update(next)
  } catch (cause) {
    if (disposed || version !== request) return
    error.value = details(cause, 'Proyek gagal dimuat. Coba lagi.')
    if (active.value) timer = setTimeout(() => void load(), 3_000)
  } finally {
    if (!disposed) loading.value = false
  }
}

onMounted(() => void load())
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(timer)
})

watch([panel, () => job.value?.lyricReference?.id], async ([currentPanel, referenceId]) => {
  if ((currentPanel !== 'lrclib' && currentPanel !== 'editor') || selected.value || !referenceId || attemptedReference === referenceId) return
  attemptedReference = referenceId
  restoringReference.value = true
  try {
    const restored = await $fetch<LyricsSearchResult | null>(`/api/extractions/${props.id}/reference`, {
      method: 'POST', retry: 0
    })
    if (restored && !disposed && job.value && !job.value.selectedReference && job.value.lyricReference?.id === referenceId) {
      job.value = { ...job.value, selectedReference: restored }
    }
  } catch {
    // The existing draft remains visible when the original reference is unavailable.
  } finally {
    restoringReference.value = false
  }
})
watch(referenceOpen, open => { if (open) referenceError.value = '' })
watch(panel, value => { if (value !== 'lrclib') referenceOpen.value = false })

async function selectReference(reference: LyricsSearchResult) {
  if (savingReference.value || speechRunning.value) return
  savingReference.value = true
  referenceError.value = ''
  try {
    // Merge just the changed field so a worker update cannot be replaced by a late response.
    const saved = await $fetch<Extraction>(`/api/extractions/${props.id}/reference`, {
      method: 'PUT', body: { reference }
    })
    if (!disposed && job.value) {
      job.value = { ...job.value, selectedReference: saved.selectedReference }
      referenceOpen.value = false
    }
  } catch (cause) {
    referenceError.value = details(cause, 'Acuan gagal disimpan. Coba lagi.')
  } finally {
    savingReference.value = false
  }
}

function saveCheckpoint(transcript: SpeechTranscript, complete: boolean) {
  if (!job.value || disposed) return
  job.value = complete ? { ...job.value, transcript, speechCheckpoint: undefined } :
    { ...job.value, speechCheckpoint: transcript }
  showingCheckpoint.value = !complete
}

function savedDraft(next: Extraction) {
  update(next, true)
}

async function buildDraft(mode: 'synced' | 'existing' | 'words' | 'vocal') {
  const revision = job.value?.speechRevision
  await openPanel('transkrip')
  await speech.value?.start(mode)
  if (!disposed && panel.value === 'transkrip' && job.value?.speechRevision !== revision) await openPanel('draft')
}

function stopOtherAudio(event: Event) {
  const player = event.target
  if (!(player instanceof HTMLAudioElement) || !(event.currentTarget instanceof HTMLElement)) return
  for (const audio of event.currentTarget.querySelectorAll('audio')) {
    if (audio !== player) audio.pause()
  }
}

async function action(value: 'cancel' | 'retry' | 'delete' | 'vocals', useOriginal = false) {
  if (acting.value || speechRunning.value || !job.value) return
  if (value === 'delete' && !window.confirm('Hapus proyek beserta audio, acuan, dan liriknya?')) return
  acting.value = true
  error.value = ''
  ++request
  clearTimeout(timer)
  const path = `/api/extractions/${props.id}`
  try {
    if (value === 'delete') {
      await $fetch(path, { method: 'DELETE' })
      if (!disposed) emit('removed', props.id)
    } else {
      const updated = await $fetch<Extraction>(`${path}/${value}`, {
        method: 'POST', body: value === 'retry' ? { useOriginal } : undefined
      })
      update(updated, true)
      if (!disposed && value === 'vocals') openPanel('progres')
    }
  } catch (cause) {
    error.value = details(cause, 'Aksi gagal. Coba lagi.')
    if (active.value && !disposed) timer = setTimeout(() => void load(), 1_200)
  } finally {
    acting.value = false
  }
}
</script>

<template>
  <div v-if="loading" class="studio-empty" role="status">Memuat proyek…</div>
  <div v-else-if="!job" class="studio-empty">
    <h1>Proyek belum bisa dibuka</h1>
    <p role="alert">{{ error }}</p>
    <UButton variant="outline" @click="load()">Muat ulang</UButton>
  </div>
  <article v-else class="studio-project" @play.capture="stopOtherAudio">
    <header class="studio-project-header">
      <div class="studio-project-title">
        <span class="studio-hero-icon"><UIcon name="i-lucide-music-2" aria-hidden="true" /></span>
        <div>
          <div class="studio-title-row">
            <h1>{{ projectTitle(job) }}</h1>
            <UModal v-model:open="titleOpen" title="Ubah judul proyek" :dismissible="!savingTitle" :close="!savingTitle">
              <UButton type="button" variant="ghost" color="neutral" icon="i-lucide-pencil"
                aria-label="Ubah judul proyek" title="Ubah judul proyek" />
              <template #body>
                <form class="grid gap-4" @submit.prevent="renameProject">
                  <UFormField label="Judul proyek">
                    <UInput v-model="titleDraft" class="w-full" :maxlength="projectTitleMaxLength" :disabled="savingTitle" required autofocus />
                  </UFormField>
                  <p v-if="titleError" class="form-error" role="alert">{{ titleError }}</p>
                  <div class="flex flex-wrap justify-end gap-2">
                    <UButton type="button" variant="outline" color="neutral" :disabled="savingTitle" @click="titleOpen = false">Batal</UButton>
                    <UButton type="submit" :loading="savingTitle" :disabled="!titleDraft.trim()">Simpan</UButton>
                  </div>
                </form>
              </template>
            </UModal>
          </div>
          <p>{{ job.durationMs ? lyricTimestamp(job.durationMs).split('.')[0] + ' · ' : '' }}{{ job.hasVocals ? 'Stem vokal tersedia' : 'Audio asli' }}</p>
        </div>
      </div>
      <div class="studio-status" :class="{ 'studio-status-active': active || speechRunning }" role="status">
        <UIcon :name="active || speechRunning ? 'i-lucide-loader-circle' : 'i-lucide-circle-check'" aria-hidden="true" />
        {{ speechRunning ? 'Memproses lirik' : extractionLabels[job.phase] }}
      </div>
    </header>

    <div class="studio-tabs" role="tablist" aria-label="Bagian proyek">
      <button v-for="(tab, index) in tabs" :id="`studio-tab-${tab.id}`" :key="tab.id" type="button" role="tab"
        :aria-controls="`studio-panel-${tab.id}`" :aria-selected="panel === tab.id" :tabindex="panel === tab.id ? 0 : -1"
        @click="openPanel(tab.id)" @keydown="moveTab($event, index)">
        <UIcon :name="tab.icon" aria-hidden="true" /><span>{{ tab.label }}</span>
      </button>
    </div>
    <p v-if="error" class="form-error studio-global-error" role="alert">{{ error }}</p>

    <section v-show="panel === 'audio'" id="studio-panel-audio" role="tabpanel" aria-labelledby="studio-tab-audio" class="studio-panel">
      <h2>Audio proyek</h2>
      <StudioAudio :job="job" :active="panel === 'audio'" />
      <div v-if="!job.hasVocals && canTranscribe" class="studio-callout">
        <p>Pisahkan vokal untuk mendengarkan stem dan menggunakannya di transkripsi berikutnya.</p>
        <UButton icon="i-lucide-audio-lines" :loading="acting" :disabled="speechRunning || savingReference" @click="action('vocals')">
          Pisahkan vokal
        </UButton>
      </div>
    </section>

    <section v-show="panel === 'lrclib'" id="studio-panel-lrclib" role="tabpanel" aria-labelledby="studio-tab-lrclib" class="studio-panel">
      <div class="studio-artifact-heading studio-reference-heading">
        <h2>Acuan LRCLIB</h2>
        <UModal v-model:open="referenceOpen" :title="displayedReference ? 'Ganti acuan LRCLIB' : 'Pilih acuan LRCLIB'"
          description="Cari versi lagu yang paling sesuai dengan audio proyek."
          :dismissible="!savingReference" :close="!savingReference" scrollable>
          <UButton variant="outline" color="neutral" :icon="displayedReference ? 'i-lucide-replace' : 'i-lucide-search'"
            :disabled="speechRunning">{{ displayedReference ? 'Ganti acuan' : 'Pilih acuan' }}</UButton>
          <template #body>
            <LyricsReferencePicker :duration-ms="job.durationMs" :selected="displayedReference" :disabled="savingReference || speechRunning"
              @select="selectReference" />
            <p v-if="savingReference" role="status" class="studio-description">Menyimpan acuan…</p>
            <p v-if="referenceError" class="form-error" role="alert">{{ referenceError }}</p>
          </template>
        </UModal>
      </div>
      <div v-if="displayedReference" class="studio-artifact">
        <div class="studio-artifact-heading">
          <div><h3>{{ displayedReference.trackName }}</h3><p>{{ displayedReference.artistName }}<template v-if="displayedReference.albumName"> · {{ displayedReference.albumName }}</template></p></div>
          <span v-if="selected" class="studio-saved"><UIcon name="i-lucide-check" aria-hidden="true" /> Tersimpan</span>
        </div>
        <p v-if="restoringReference && !selected" class="studio-description" role="status">Memulihkan acuan asli…</p>
        <p v-else-if="!selected" class="studio-description">Lirik dari draft tersimpan.</p>
        <div v-if="selected && canTranscribe" class="studio-actions">
          <UButton v-if="synced" :disabled="speechRunning || savingReference" @click="buildDraft('synced')">Pakai waktu baris LRCLIB</UButton>
          <UButton v-else-if="hasTranscriptForDraft" :disabled="speechRunning || savingReference" @click="buildDraft('existing')">Cocokkan dengan transkrip</UButton>
          <UButton v-else variant="outline" @click="openPanel('transkrip')">Buka transkripsi</UButton>
        </div>
        <pre class="studio-lyrics-text" aria-label="Lirik acuan">{{ displayedReference.text }}</pre>
        <details v-if="displayedReference.syncedLyrics" class="studio-timed-reference">
          <summary>Lihat timestamp acuan</summary>
          <pre class="studio-lyrics-text">{{ displayedReference.syncedLyrics }}</pre>
        </details>
      </div>
      <p v-else class="studio-description">Pilih acuan untuk mencocokkan teks lirik dengan transkrip.</p>
    </section>

    <section v-show="panel === 'transkrip'" id="studio-panel-transkrip" role="tabpanel" aria-labelledby="studio-tab-transkrip" class="studio-panel">
      <h2>Transkrip Web Speech</h2>
      <p v-if="!checkpoint && !completeTranscript && !legacyTranscript && job.lines" class="studio-description">
        Proyek lama ini menyimpan draft akhir. Transkrip mentah akan muncul setelah transkripsi berikutnya.
      </p>
      <p v-else-if="!canTranscribe && active" class="studio-callout">Transkripsi bisa dimulai setelah audio siap.</p>
      <BrowserSpeech v-if="canTranscribe" ref="speech" :job="job" :active="panel === 'transkrip'"
        :has-transcript="Boolean(checkpoint || completeTranscript || legacyTranscript)"
        @running="speechRunning = $event" @complete="savedDraft" @checkpoint="saveCheckpoint" />
      <div v-if="checkpoint || completeTranscript || legacyTranscript" class="studio-artifact studio-transcript">
        <div class="studio-artifact-heading">
          <div>
            <h3>{{ checkpoint && inspectedTranscript === checkpoint ? 'Progres tersimpan' : 'Transkrip tersimpan' }}</h3>
            <p v-if="inspectedTranscript">
              {{ inspectedTranscript.lines.length }} baris · {{ inspectedTranscript.source === 'vocals' ? 'Stem vokal' : 'Audio asli' }}
              <template v-if="inspectedTranscript === checkpoint"> · sampai {{ lyricTimestamp(inspectedTranscript.processedMs) }}</template>
            </p>
            <p v-else>{{ legacyTranscript?.length ?? 0 }} baris</p>
          </div>
          <UButton v-if="job.lines" variant="outline" color="neutral" @click="openPanel('draft')">Buka draft</UButton>
        </div>
        <div v-if="checkpoint && completeTranscript" class="studio-actions" role="group" aria-label="Transkrip yang ditampilkan">
          <UButton color="neutral" :variant="showingCheckpoint ? 'outline' : 'solid'" :aria-pressed="!showingCheckpoint"
            @click="showingCheckpoint = false">Terakhir selesai</UButton>
          <UButton color="neutral" :variant="showingCheckpoint ? 'solid' : 'outline'" :aria-pressed="showingCheckpoint"
            @click="showingCheckpoint = true">Progres sekarang</UButton>
        </div>
        <ExtractionResult v-if="transcriptJob?.lines?.length" :key="inspectedTranscript?.runId ?? 'legacy'" :job="transcriptJob"
          :active="panel === 'transkrip'" kind="transcript" />
        <p v-else class="studio-description">Belum ada kata yang dikenali di bagian ini.</p>
      </div>
    </section>

    <section v-show="panel === 'editor'" id="studio-panel-editor" role="tabpanel" aria-labelledby="studio-tab-editor" class="studio-panel">
      <h2>Editor lirik</h2>
      <LyricsEditor v-if="canTranscribe && job.durationMs" :job="job" :active="panel === 'editor'"
        :disabled="speechRunning || acting" @saved="savedDraft" @reference="openPanel('lrclib')" @reload="load" />
      <p v-else class="studio-description">Editor bisa digunakan setelah audio siap.</p>
    </section>

    <section v-show="panel === 'draft'" id="studio-panel-draft" role="tabpanel" aria-labelledby="studio-tab-draft" class="studio-panel">
      <div class="studio-artifact-heading">
        <h2>Draft lirik</h2>
        <UButton v-if="canTranscribe" color="neutral" variant="outline" icon="i-lucide-square-pen" @click="openPanel('editor')">
          Buka Editor
        </UButton>
      </div>
      <template v-if="job.lines">
        <p class="studio-description">Ketuk baris atau kata untuk memutar audio dari waktunya.</p>
        <div v-if="canTranscribe && (canRefine || legacyWords)" class="studio-actions">
          <UButton variant="outline" color="neutral" :disabled="speechRunning || savingReference" icon="i-lucide-audio-lines"
            @click="buildDraft(canRefine ? 'vocal' : 'words')">
            {{ canRefine ? 'Sesuaikan waktu kata dengan vokal' : 'Perkirakan waktu per kata' }}
          </UButton>
        </div>
        <ExtractionResult :job="job" :active="panel === 'draft'" />
      </template>
      <div v-else class="studio-callout">
        <p>Draft muncul setelah transkripsi atau setelah memakai acuan LRCLIB bertimestamp.</p>
        <UButton variant="outline" @click="openPanel('transkrip')">Buka transkripsi</UButton>
      </div>
    </section>

    <section v-show="panel === 'progres'" id="studio-panel-progres" role="tabpanel" aria-labelledby="studio-tab-progres" class="studio-panel">
      <h2>Progres proyek</h2>
      <p v-if="job.error" class="form-error" role="alert">{{ job.error }}</p>
      <div class="studio-actions">
        <UButton v-if="canTranscribe" icon="i-lucide-mic" @click="openPanel('transkrip')">
          {{ job.speechCheckpoint ? 'Lanjut ke progres transkripsi' : 'Buka transkripsi' }}
        </UButton>
        <UButton v-if="active" variant="outline" color="neutral" :disabled="acting || job.phase === 'cancelling'" @click="action('cancel')">Batalkan</UButton>
        <UButton v-if="job.canRetry" variant="outline" :loading="acting" @click="action('retry')">Coba lagi</UButton>
        <UButton v-if="job.canUseOriginal" variant="outline" :disabled="acting" @click="action('retry', true)">Gunakan audio asli</UButton>
      </div>
      <p v-if="checkpoint" class="studio-description">Web Speech tersimpan sampai {{ lyricTimestamp(checkpoint.processedMs) }}.</p>
      <ExtractionProgress :job="job" />
      <div v-if="!active" class="studio-danger">
        <UButton variant="ghost" color="error" icon="i-lucide-trash-2" :disabled="acting || speechRunning || savingReference" @click="action('delete')">Hapus proyek</UButton>
      </div>
    </section>
  </article>
</template>
