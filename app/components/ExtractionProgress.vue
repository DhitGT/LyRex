<script setup lang="ts">
import { extractionActive } from '#shared/utils/lyrics'
import type { Extraction } from '#shared/utils/lyrics'

const props = defineProps<{ job: Extraction }>()
const now = ref(0)
const active = computed(() => extractionActive(props.job.phase))
const logs = computed(() => [...(props.job.logs || [])].reverse())
const latest = computed(() => logs.value[0])
const progressPercent = computed(() => {
  const percent = latest.value?.percent
  return percent !== undefined && percent < 100 ? percent : undefined
})
const timeFormat = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
let clock: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  now.value = Date.now()
  clock = setInterval(() => { if (active.value) now.value = Date.now() }, 1_000)
})
onBeforeUnmount(() => clearInterval(clock))

function elapsed(since: number) {
  const seconds = Math.max(0, Math.floor((now.value - since) / 1_000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes} mnt ${seconds % 60} dtk` : `${seconds} dtk`
}
</script>

<template>
  <details v-if="latest || active" class="extraction-progress" open>
    <summary>Log ekstraksi</summary>
    <div v-if="active" class="progress-current">
      <p role="status">
        <template v-if="job.phase === 'queued' && job.queueAhead">
          {{ job.queueAhead }} job di depan.
        </template>
        <template v-else>{{ latest?.message || 'Menunggu pembaruan server…' }}</template>
      </p>
      <div class="progress-meter">
        <progress aria-label="Progres langkah aktif" :value="progressPercent" max="100" />
        <span aria-hidden="true">{{ progressPercent === undefined ? 'Sedang diproses' : `${progressPercent}%` }}</span>
      </div>
      <p v-if="now && (job.startedAt || latest)" class="progress-time">
        Berjalan {{ elapsed(job.startedAt || latest!.at) }}
        <span v-if="latest"> · Pembaruan terakhir {{ elapsed(latest.at) }} lalu</span>
      </p>
    </div>
    <ol v-if="logs.length" class="progress-log" aria-label="Riwayat ekstraksi, terbaru dahulu">
      <li v-for="entry in logs" :key="entry.key">
        <time :datetime="new Date(entry.at).toISOString()">{{ timeFormat.format(entry.at) }}</time>
        <span>{{ entry.message }}<small v-if="entry.percent !== undefined"> · {{ entry.percent }}%</small></span>
      </li>
    </ol>
  </details>
</template>

<style scoped>
.extraction-progress { margin-top: .8rem; padding: .6rem .85rem; border: 1px solid #dfd4b7; border-radius: .65rem; background: #fffdf8; }
.extraction-progress summary { min-height: 44px; padding-block: .65rem; cursor: pointer; font-weight: 700; }
.progress-current { margin-bottom: .7rem; font-size: .95rem; }
.progress-time, .progress-log time { color: #635a46; font-size: .82rem; font-variant-numeric: tabular-nums; }
.progress-time { margin-top: .3rem; }
.progress-meter { display: flex; align-items: center; gap: .65rem; font-size: .85rem; }
.progress-meter progress { flex: 1; min-width: 0; accent-color: #587548; }
.progress-log { display: grid; gap: .35rem; max-height: 13rem; overflow-y: auto; padding-bottom: .45rem; }
.progress-log li { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .65rem; align-items: baseline; font-size: .9rem; overflow-wrap: anywhere; }
</style>
