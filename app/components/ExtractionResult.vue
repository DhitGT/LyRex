<script setup lang="ts">
import { exportLyrics, lyricFormats, lyricTimestamp } from '#shared/utils/lyrics'
import type { Extraction, LyricFormat } from '#shared/utils/lyrics'
import AudioWaveform from './AudioWaveform.vue'

const props = defineProps<{ job: Extraction, active?: boolean, kind?: 'transcript' }>()
const player = useTemplateRef<InstanceType<typeof AudioWaveform>>('player')
const source = ref<'original' | 'vocals'>(props.job.hasVocals && !props.job.useOriginal ? 'vocals' : 'original')
const position = ref(0)
const showWordTimes = ref(false)
const lines = computed(() => props.job.lines || [])
const markers = computed(() => lines.value.flatMap(line => line.words?.length ? line.words : [line]))
const activeLine = computed(() => lines.value.findIndex(line => line.startMs <= position.value && position.value < line.endMs))
const hasWordTimes = computed(() => lines.value.some(line => line.words?.length))
const activeWord = computed(() => lines.value[activeLine.value]?.words?.find(word =>
  word.startMs <= position.value && position.value < word.endMs))
const audioUrl = computed(() => `/api/extractions/${props.job.id}/audio/${source.value}`)

function wordTimestamp(ms: number) {
  return lyricTimestamp(ms, 'SRT').replace(/^00:/, '').replace(',', '.')
}

function download(format: LyricFormat) {
  const blob = new Blob([exportLyrics(lines.value, format) + '\n'], {
    type: format === 'JSON' ? 'application/json' : 'text/plain;charset=utf-8'
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${props.job.name.replace(/\.[^.]+$/, '') || 'lirik'}.${format.toLowerCase()}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
</script>

<template>
  <div class="extraction-result">
    <div v-if="job.hasVocals" class="result-controls" role="group" aria-label="Sumber pemutaran">
      <UButton color="neutral" :variant="source === 'original' ? 'solid' : 'outline'" :aria-pressed="source === 'original'" @click="source = 'original'">
        Audio asli
      </UButton>
      <UButton color="neutral" :variant="source === 'vocals' ? 'solid' : 'outline'" :aria-pressed="source === 'vocals'" @click="source = 'vocals'">
        Vokal saja
      </UButton>
    </div>
    <p v-else-if="kind !== 'transcript'">Draft dibuat dari audio asli.</p>
    <p v-if="job.estimatedTiming">
      {{ job.vocalTiming ? 'Perkiraan waktu kata disesuaikan dengan stem vokal.'
        : job.lyricReference?.timingSource === 'lrclib' ? 'Waktu kata diperkirakan dari timestamp baris LRCLIB.'
          : hasWordTimes ? 'Timestamp baris dan kata adalah perkiraan dari hasil Web Speech.'
          : 'Web Speech menghasilkan perkiraan timestamp per baris.' }}
    </p>
    <p v-if="job.lyricReference">
      Acuan LRCLIB · {{ job.lyricReference.trackName }} — {{ job.lyricReference.artistName }}.
      <template v-if="job.lyricReference.timingSource === 'lrclib'">Timestamp baris dari LRCLIB.</template>
      <template v-else>{{ job.lyricReference.matchedLines }} dari {{ lines.length }} baris cocok dengan hasil transkripsi.</template>
    </p>
    <AudioWaveform
      ref="player"
      :src="audioUrl"
      :label="source === 'vocals' ? 'Stem vokal' : 'Audio asli'"
      :duration-ms="job.durationMs"
      :active="active"
      :markers="markers"
      :show-pitch="source === 'vocals'"
      @position="position = $event"
    />
    <div v-if="hasWordTimes" class="result-controls">
      <UButton color="neutral" variant="outline" :aria-pressed="showWordTimes" @click="showWordTimes = !showWordTimes">
        {{ showWordTimes ? 'Sembunyikan waktu per kata' : 'Tampilkan waktu per kata' }}
      </UButton>
    </div>
    <p v-if="!lines.length">Belum ada lirik yang terdeteksi.</p>
    <ol v-else class="result-lines" :aria-label="kind === 'transcript' ? 'Transkrip Web Speech' : 'Draft lirik'">
      <li v-for="(line, index) in lines" :key="line.startMs" :class="{ current: index === activeLine }">
        <button type="button" class="line-seek" :aria-current="index === activeLine ? 'true' : undefined" @click="player?.seekAndPlay(line.startMs)">
          <span class="line-time">{{ lyricTimestamp(line.startMs) }} – {{ lyricTimestamp(line.endMs) }}</span>
          <span v-if="line.words?.length" class="line-words">
            <span v-for="(word, wordIndex) in line.words" :key="wordIndex" :class="{ 'current-word': word === activeWord }">
              {{ word.text }}
            </span>
            <small v-if="line.timingSource === 'interpolated'">Waktu diperkirakan dari baris sekitar</small>
            <small v-else-if="line.needsReview">Perlu dicek</small>
          </span>
          <span v-else>{{ line.text }} <small v-if="line.needsReview">Perlu dicek</small></span>
        </button>
        <ul v-if="showWordTimes && line.words?.length" class="word-timings" aria-label="Waktu per kata">
          <li v-for="(word, wordIndex) in line.words" :key="wordIndex">
            <button type="button" :class="{ 'current-word': word === activeWord }" @click="player?.seekAndPlay(word.startMs)">
              <strong>{{ word.text }}</strong>
              <span class="word-time">{{ wordTimestamp(word.startMs) }} – {{ wordTimestamp(word.endMs) }} · {{ word.endMs - word.startMs }} ms</span>
            </button>
          </li>
        </ul>
      </li>
    </ol>
    <div v-if="lines.length" class="result-controls" role="group" aria-label="Unduh lirik bertimestamp">
      <UButton v-for="format in lyricFormats" :key="format" color="neutral" variant="outline" @click="download(format)">
        Unduh {{ format }}
      </UButton>
    </div>
    <a v-if="job.youtubeUrl" class="reference" :href="job.youtubeUrl" target="_blank" rel="noopener noreferrer">
      Buka video referensi
    </a>
  </div>
</template>

<style scoped>
.extraction-result { display: grid; gap: .75rem; margin: 1rem 0; }
.result-controls { display: flex; flex-wrap: wrap; gap: .5rem; }
.result-controls button { min-height: 44px; }
.result-lines { display: grid; gap: .25rem; padding: .3rem; }
.line-seek {
  display: grid;
  gap: .15rem;
  width: 100%;
  min-height: 44px;
  padding: .5rem .65rem;
  border-inline-start: 3px solid transparent;
  border-radius: .4rem;
  background: #f9f5e8;
  text-align: left;
  overflow-wrap: anywhere;
}
.line-seek:hover { background: #f3ecd7; }
.current .line-seek { background: #e5eedb; border-inline-start-color: #507139; }
.line-time { font-size: .875rem; font-variant-numeric: tabular-nums; }
.line-words { display: flex; flex-wrap: wrap; align-items: baseline; gap: .15rem .35rem; }
.current-word { border-radius: .2rem; background: #cce1b9; box-shadow: 0 0 0 2px #cce1b9; }
.line-seek small { padding: .1rem .25rem; background: #f5d474; border-radius: .25rem; }
.word-timings { display: flex; flex-wrap: wrap; gap: .4rem; padding: .45rem; }
.word-timings button { display: grid; min-height: 44px; padding: .3rem .45rem; border: 1px solid #dfd4b7; border-radius: .35rem; text-align: left; }
.word-time { font-size: .78rem; font-variant-numeric: tabular-nums; }
.reference { width: fit-content; text-decoration: underline; }
</style>
