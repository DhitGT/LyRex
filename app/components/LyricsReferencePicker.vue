<script setup lang="ts">
import type { LyricsSearchResult } from '#shared/utils/lyrics'
import { searchLyricsReferences } from '~/utils/lrclib'

const props = defineProps<{ durationMs?: number, selected?: LyricsSearchResult, disabled?: boolean }>()
const emit = defineEmits<{ select: [result: LyricsSearchResult] }>()
const title = ref(props.selected?.trackName ?? '')
const artist = ref(props.selected?.artistName ?? '')
const searching = ref(false)
const searched = ref(false)
const error = ref('')
const results = shallowRef<LyricsSearchResult[]>([])
const sortedResults = computed(() => {
  const duration = props.durationMs
  if (!duration) return results.value
  const difference = (result: LyricsSearchResult) => result.duration > 0 ? Math.abs(result.duration * 1_000 - duration) : Infinity
  return [...results.value].sort((a, b) => difference(a) - difference(b))
})
let pending: AbortController | undefined

onBeforeUnmount(() => pending?.abort())

async function search() {
  const track = title.value.trim()
  if (!track || searching.value || props.disabled) return
  const request = new AbortController()
  pending = request
  searching.value = true
  searched.value = false
  error.value = ''
  results.value = []
  try {
    results.value = await searchLyricsReferences(track, artist.value.trim(), request.signal)
    searched.value = true
  } catch (cause) {
    if (!request.signal.aborted) {
      error.value = cause instanceof Error ? cause.message : 'Pencarian LRCLIB gagal. Coba lagi.'
    }
  } finally {
    if (pending === request) {
      pending = undefined
      searching.value = false
    }
  }
}

function formatDuration(seconds: number) {
  const rounded = Math.round(seconds)
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`
}
</script>

<template>
  <div class="lyric-reference">
    <form class="reference-search" @submit.prevent="search">
      <label>Judul lagu<input v-model="title" maxlength="120" required :disabled="disabled"></label>
      <label>Artis <small>(opsional)</small><input v-model="artist" maxlength="120" :disabled="disabled"></label>
      <UButton type="submit" :loading="searching" :disabled="!title.trim() || disabled">Cari lirik</UButton>
    </form>
    <p v-if="durationMs" class="reference-note">Durasi audio proyek {{ formatDuration(durationMs / 1_000) }}.</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-else-if="searched && !results.length" role="status">Lirik belum ditemukan. Coba judul atau nama artis lain.</p>
    <ul v-if="results.length" class="reference-results" aria-label="Hasil pencarian LRCLIB">
      <li v-for="result in sortedResults" :key="result.id">
        <UButton variant="outline" color="neutral" :aria-pressed="result.id === selected?.id" :disabled="disabled" @click="emit('select', result)">
          <span><strong>{{ result.trackName }}</strong><small>{{ result.artistName }}<template v-if="result.albumName"> · {{ result.albumName }}</template><template v-if="result.duration"> · {{ formatDuration(result.duration) }}</template></small></span>
        </UButton>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.lyric-reference { min-width: 0; }
.reference-search { display: flex; flex-wrap: wrap; align-items: end; gap: .65rem; }
.reference-search label { flex: 1 1 10rem; min-width: 0; }
.reference-search input { display: block; width: 100%; min-height: 44px; padding: .45rem; border: 1px solid #d5d9cf; border-radius: .5rem; }
.reference-search button, .reference-results button { min-height: 44px; }
.reference-note, .reference-results small { display: block; font-size: .875rem; color: #546256; }
.reference-note { margin-top: .4rem; }
.reference-results { display: grid; gap: .35rem; max-height: min(18rem, 40dvh); margin-top: .65rem; overflow: auto; }
.reference-results button { width: 100%; text-align: left; overflow-wrap: anywhere; }
.reference-results button[aria-pressed='true'] { background: #f9f2da; }
</style>
