<script setup lang="ts">
import { DraftConflict, saveLocalDraft } from '~/utils/local-projects'
import { lyricTimestamp } from '#shared/utils/lyrics'
import type { Extraction, LyricLine, LyricReference, LyricWord } from '#shared/utils/lyrics'
import { alignLyrics, alignSyncedLyrics, estimateWordsFromLines } from '~/utils/align-lyrics'
import { retimeLyricLine, syncLyricsToWaveform } from '~/utils/editor-timing'
import AudioWaveform from './AudioWaveform.vue'

const props = defineProps<{ job: Extraction, active: boolean, disabled: boolean }>()
const emit = defineEmits<{ saved: [job: Extraction], reference: [], reload: [] }>()
const player = useTemplateRef<InstanceType<typeof AudioWaveform>>('player')
const duration = computed(() => props.job.durationMs ?? 0)
const source = computed(() => props.job.hasVocals ? 'vocals' : 'original')
const audioAsset = useLocalAudio(source)
const audioUrl = computed(() => audioAsset.value.url)
const reference = computed(() => props.job.selectedReference)
const synced = computed(() => reference.value && alignSyncedLyrics(reference.value, duration.value, false))
const version = computed(() => props.job.speechRevision ?? 0)
const revision = ref(0)
const lines = shallowRef<LyricLine[]>([])
const lyricReference = shallowRef<LyricReference>()
const scratch = ref('')
const dirty = ref(false)
const mode = ref<'auto' | 'rephrase' | 'hybrid' | 'save'>()
const notice = ref('')
const error = ref('')
const position = ref(0)
const wordLine = ref<number>()
const wordError = ref('')
const selectedWords = computed(() => wordLine.value === undefined ? undefined : lines.value[wordLine.value]?.words)
const activeWord = computed(() => selectedWords.value?.findIndex(word =>
  word.startMs <= position.value && position.value < word.endMs))
const blocked = computed(() => props.disabled || Boolean(mode.value))
const outdated = computed(() => revision.value !== version.value)
const playheadLine = computed(() => lines.value.findIndex(line =>
  line.startMs <= position.value && position.value < line.endMs))
const savedLines = computed(() => props.job.lines?.length ? props.job.lines : props.job.transcript?.lines)
const invalidRow = computed(() => lines.value.findIndex((line, index, all) => !line.text.trim() ||
  !Number.isInteger(line.startMs) || !Number.isInteger(line.endMs) ||
  line.startMs < (all[index - 1]?.endMs ?? 0) || line.startMs >= line.endMs || line.endMs > duration.value))
const markers = computed(() => invalidRow.value === -1
  ? lines.value.flatMap((line, index) => index === wordLine.value && line.words?.length ? line.words : [line])
  : undefined)

function reset(job: Extraction = props.job) {
  lines.value = job.lines?.length ? job.lines : job.transcript?.lines ?? []
  lyricReference.value = job.lines?.length ? job.lyricReference : undefined
  revision.value = job.speechRevision ?? 0
  scratch.value = ''
  dirty.value = false
  error.value = ''
  notice.value = ''
  wordLine.value = undefined
  wordError.value = ''
}

watch([savedLines, version], ([saved, currentVersion]) => {
  if (!dirty.value && !mode.value && (lines.value !== saved || revision.value !== currentVersion)) reset()
}, { immediate: true })

function rowsFrom(text: string) {
  return text.split(/\r?\n/).map(row => row.replace(/\s+/g, ' ').trim())
    .filter(row => row && !/^\[[^\]]+\]$/.test(row))
}

function accept(next: LyricLine[], message: string, from?: LyricReference) {
  lines.value = next
  lyricReference.value = from
  dirty.value = true
  notice.value = message
  wordLine.value = undefined
  wordError.value = ''
}

async function sync(kind: 'auto' | 'rephrase' | 'hybrid') {
  if (blocked.value || outdated.value) return
  const selected = reference.value
  const referenceInfo = selected && { id: selected.id, trackName: selected.trackName, artistName: selected.artistName }
  const referenceLines = synced.value
  const base = lines.value
  const text = scratch.value.trim() || selected?.text || ''
  const startVersion = version.value
  mode.value = kind
  error.value = ''
  notice.value = ''
  try {
    if (kind === 'rephrase' && selected && referenceInfo) {
      const prior = invalidRow.value === -1 ? base : []
      const aligned = alignLyrics(selected.text, prior, duration.value) ??
        alignLyrics(selected.text, props.job.transcript?.lines ?? [], duration.value)
      if (aligned) {
        accept(aligned.lines, `Teks mengikuti LRCLIB. ${aligned.matchedLines} baris cocok dengan waktu lirik yang tersedia.`,
          { ...referenceInfo, matchedLines: aligned.matchedLines })
        return
      }
      if (referenceLines) {
        accept(referenceLines, 'Teks dan timestamp awal diambil dari LRCLIB.',
          { ...referenceInfo, matchedLines: 0, timingSource: 'lrclib' })
        return
      }
    }

    const useExisting = kind === 'auto' && base.length > 0
    const rows = kind === 'hybrid' ? referenceLines?.map(line => line.text) ?? [] :
      useExisting ? base.map(line => line.text.replace(/\s+/g, ' ').trim()) : rowsFrom(kind === 'rephrase' ? selected?.text ?? '' : text)
    if (!rows.length || rows.some(row => !row)) throw new Error('Isi teks lirik sebelum menyelaraskan waveform.')
    const anchors = kind === 'hybrid' ? referenceLines : useExisting && invalidRow.value === -1 ? base : undefined
    const waveform = await player.value?.readWaveform()
    if (!waveform) throw new Error('Waveform belum siap. Coba lagi.')
    if (startVersion !== version.value) return
    const result = syncLyricsToWaveform(waveform, duration.value, rows, anchors, kind === 'hybrid')
    if (!result) throw new Error('Lirik terlalu panjang atau aktivitas audio tidak cukup jelas untuk diselaraskan.')
    const review = ' Periksa hasilnya sambil memutar audio.'
    if (kind === 'hybrid' && referenceInfo) {
      const offset = result.offsetMs
      const message = offset ? `Timestamp LRCLIB disesuaikan dengan pergeseran ${offset > 0 ? '+' : ''}${offset} ms dan transisi waveform.`
        : 'Timestamp LRCLIB dipakai sebagai acuan untuk mencari transisi waveform terdekat.'
      accept(result.lines, message + review, { ...referenceInfo, matchedLines: 0, timingSource: 'lrclib-waveform' })
    } else if (referenceInfo && !useExisting && (kind === 'rephrase' || !scratch.value.trim())) {
      accept(result.lines, 'Teks diambil dari LRCLIB dan waktunya diperkirakan dari waveform.' + review,
        { ...referenceInfo, matchedLines: 0, timingSource: 'waveform' })
    } else {
      const from = lyricReference.value
      accept(result.lines, 'Timestamp diperkirakan dari waveform.' + review,
        from && { ...from, timingSource: from.timingSource === 'lrclib' ? 'lrclib-waveform' : from.timingSource })
    }
  } catch (cause) {
    error.value = cause instanceof Error && !('statusCode' in cause) ? cause.message : 'Waveform gagal dimuat. Coba lagi.'
  } finally {
    mode.value = undefined
  }
}

function editLine(index: number, field: 'text' | 'startMs' | 'endMs', event: Event) {
  const input = event.target as HTMLInputElement
  const line = lines.value[index]!
  let next: LyricLine
  if (field === 'text') {
    const text = input.value
    const tokens = text.trim().split(/\s+/)
    const words = tokens[0] && tokens.length === line.words?.length
      ? line.words.map((word, slot) => ({ ...word, text: tokens[slot]! })) : undefined
    next = { ...line, text, words }
  } else {
    const start = field === 'startMs' ? input.valueAsNumber : line.startMs
    const end = field === 'endMs' ? input.valueAsNumber : line.endMs
    next = Number.isInteger(start) && Number.isInteger(end) && end > start
      ? retimeLyricLine(line, start, end) : { ...line, startMs: start, endMs: end, words: undefined }
  }
  if (wordLine.value === index && !next.words && Number.isInteger(next.startMs) && Number.isInteger(next.endMs)) {
    next = estimateWordsFromLines([next])?.[0] ?? next
  }
  replaceLine(index, next)
}

function replaceLine(index: number, line: LyricLine) {
  lines.value = lines.value.map((item, row) => row === index ? line : item)
  dirty.value = true
  error.value = ''
  notice.value = ''
  wordError.value = ''
}

function toggleWords(index: number) {
  wordError.value = ''
  if (wordLine.value === index) {
    wordLine.value = undefined
    return
  }
  const line = lines.value[index]!
  if (!line.words?.length && !blocked.value && !outdated.value) {
    const estimated = estimateWordsFromLines([line])?.[0]
    if (estimated) replaceLine(index, estimated)
  }
  wordLine.value = index
  player.value?.focusAt(line.startMs)
}

function previewWord(word: LyricWord) {
  player.value?.focusAt(word.startMs)
  player.value?.seekAndPlay(word.startMs, word.endMs)
}

function wordLimits(line: LyricLine, index: number, edge: 'startMs' | 'endMs') {
  const word = line.words![index]!
  return edge === 'startMs' ? { min: line.words![index - 1]?.endMs ?? line.startMs, max: word.endMs - 1 }
    : { min: word.startMs + 1, max: line.words![index + 1]?.startMs ?? line.endMs }
}

function changeWord(index: number, slot: number, field: 'text' | 'startMs' | 'endMs', value: string | number, input?: HTMLInputElement) {
  const line = lines.value[index]!
  const word = line.words![slot]!
  if (field === 'text') {
    value = String(value).trim()
    if (!value || /\s/.test(value)) {
      wordError.value = 'Isi satu kata. Untuk menambah atau memisahkan kata, ubah teks baris.'
    } else {
      const words = line.words!.map((item, position) => position === slot ? { ...item, text: String(value) } : item)
      const text = words.map(item => item.text).join(' ')
      if (text.length <= 1_000) {
        replaceLine(index, { ...line, words, text })
        return
      }
      wordError.value = 'Teks baris maksimal 1.000 karakter.'
    }
  } else {
    const { min, max } = wordLimits(line, slot, field)
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
      replaceLine(index, { ...line, words: line.words!.map((item, position) =>
        position === slot ? { ...item, [field]: value } : item) })
      return
    }
    wordError.value = `Masukkan waktu ${min}–${max} ms agar kata tetap berurutan di dalam baris. Jika perlu, geser kata di sebelahnya dahulu.`
  }
  if (input) input.value = String(word[field])
}

function changeWordInput(index: number, slot: number, field: 'text' | 'startMs' | 'endMs', event: Event) {
  const input = event.target as HTMLInputElement
  changeWord(index, slot, field, field === 'text' ? input.value : input.valueAsNumber, input)
}

async function save() {
  if (blocked.value || outdated.value || !dirty.value || !lines.value.length || invalidRow.value >= 0) return
  mode.value = 'save'
  error.value = ''
  notice.value = ''
  try {
    const normalized = lines.value.map(line => ({ ...line, text: line.text.replace(/\s+/g, ' ').trim() }))
    const next = await saveLocalDraft(props.job.id, {
      revision: revision.value, lines: estimateWordsFromLines(normalized) ?? normalized,
      lyricReference: lyricReference.value
    }, true)
    reset(next)
    emit('saved', next)
    notice.value = 'Perubahan tersimpan di Draft.'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Draft gagal disimpan. Coba lagi.'
    if (cause instanceof DraftConflict) emit('reload')
  } finally {
    mode.value = undefined
  }
}
</script>

<template>
  <AudioWaveform ref="player" :src="audioUrl" :pcm="audioAsset.blob" :label="source === 'vocals' ? 'Stem vokal' : 'Audio asli'"
    :duration-ms="duration" :active="active" :show-pitch="source === 'vocals'"
    :markers="markers" @position="position = $event" />

  <div class="studio-actions">
    <UButton icon="i-lucide-audio-lines" :loading="mode === 'auto'"
      :disabled="blocked || outdated || (!lines.length && !scratch.trim() && !reference)" @click="sync('auto')">
      Auto-sync waveform
    </UButton>
    <template v-if="reference">
      <UButton color="neutral" variant="outline" icon="i-lucide-text-cursor-input" :loading="mode === 'rephrase'"
        :disabled="blocked || outdated" @click="sync('rephrase')">Rephrase dari LRCLIB</UButton>
      <UButton v-if="reference.syncedLyrics" color="neutral" variant="outline" icon="i-lucide-list-music" :loading="mode === 'hybrid'"
        :disabled="blocked || outdated || !synced" @click="sync('hybrid')">Sesuaikan LRCLIB + waveform</UButton>
    </template>
    <UButton v-else color="neutral" variant="outline" icon="i-lucide-book-open" @click="emit('reference')">Pilih acuan LRCLIB</UButton>
  </div>
  <p v-if="reference?.syncedLyrics && !synced" class="studio-description">Timestamp acuan tidak cocok dengan durasi atau format audio proyek.</p>
  <p v-else-if="synced && reference?.duration && Math.abs(reference.duration * 1_000 - duration) > 2_000" class="studio-description">
    Durasi acuan berbeda dari audio proyek. Periksa versi lagu dan hasil sinkronisasi.
  </p>

  <label v-if="!lines.length" class="editor-scratch">
    Teks lirik (satu baris per frasa)
    <textarea v-model="scratch" rows="5" maxlength="30000" :disabled="blocked || outdated"
      @input="dirty = true" />
  </label>
  <ol v-else class="editor-lines" aria-label="Baris lirik">
    <li v-for="(line, index) in lines" :key="index" class="editor-line"
      :class="{ 'editor-line-current': index === playheadLine }" :aria-current="index === playheadLine ? 'true' : undefined">
      <UButton color="neutral" variant="ghost" icon="i-lucide-play" :aria-label="`Putar dari baris ${index + 1}`"
        :disabled="!Number.isInteger(line.startMs) || line.startMs < 0 || line.startMs >= duration"
        @click="player?.seekAndPlay(line.startMs)" />
      <input class="editor-lyric" :value="line.text" :aria-label="`Teks baris ${index + 1}`" maxlength="1000"
        :disabled="blocked || outdated" @input="editLine(index, 'text', $event)">
      <label>Mulai (ms)
        <input type="number" :value="Number.isNaN(line.startMs) ? '' : line.startMs" min="0" :max="duration - 1"
          :aria-label="`Mulai baris ${index + 1} dalam milidetik`" :disabled="blocked || outdated" @input="editLine(index, 'startMs', $event)">
      </label>
      <label>Selesai (ms)
        <input type="number" :value="Number.isNaN(line.endMs) ? '' : line.endMs" min="1" :max="duration"
          :aria-label="`Selesai baris ${index + 1} dalam milidetik`" :disabled="blocked || outdated" @input="editLine(index, 'endMs', $event)">
      </label>
      <UButton color="neutral" variant="outline" icon="i-lucide-scan-line" size="sm"
        :aria-label="`Rincian kata baris ${index + 1}`" :aria-expanded="wordLine === index"
        :aria-controls="wordLine === index ? 'editor-words' : undefined"
        :disabled="invalidRow >= 0 || blocked || outdated" @click="toggleWords(index)">Per kata</UButton>
      <div v-if="wordLine === index" id="editor-words" class="editor-words">
        <p v-if="!line.words?.length" class="studio-description">Perpanjang durasi baris untuk memberi waktu pada setiap kata.</p>
        <template v-else>
          <p class="editor-word-help">Klik waveform untuk menggeser posisi. Gunakan ikon bidik untuk menandai awal atau akhir kata.</p>
          <ol aria-label="Waktu per kata">
            <li v-for="(word, slot) in line.words" :key="slot" class="editor-word"
              :class="{ 'editor-word-current': activeWord === slot }">
              <UButton color="neutral" variant="ghost" icon="i-lucide-play" :aria-label="`Putar kata ${word.text}`"
                :disabled="invalidRow >= 0" @click="previewWord(word)" />
              <input class="editor-word-text" :value="word.text" :aria-label="`Teks kata ${slot + 1}`"
                maxlength="1000" :disabled="blocked || outdated" @change="changeWordInput(index, slot, 'text', $event)">
              <div v-for="edge in ['startMs', 'endMs'] as const" :key="edge" class="editor-word-time">
                <label>{{ edge === 'startMs' ? 'Mulai (ms)' : 'Selesai (ms)' }}
                  <input type="number" :value="word[edge]" :min="wordLimits(line, slot, edge).min"
                    :max="wordLimits(line, slot, edge).max" :disabled="blocked || outdated || invalidRow >= 0"
                    :aria-label="`${edge === 'startMs' ? 'Mulai' : 'Selesai'} kata ${slot + 1} dalam milidetik`"
                    @change="changeWordInput(index, slot, edge, $event)">
                </label>
                <UButton color="neutral" variant="ghost" icon="i-lucide-crosshair"
                  :aria-label="`Tandai ${edge === 'startMs' ? 'awal' : 'akhir'} kata ${slot + 1} dari posisi waveform`"
                  :disabled="blocked || outdated || invalidRow >= 0" @click="changeWord(index, slot, edge, position)" />
              </div>
            </li>
          </ol>
        </template>
        <p v-if="wordError" class="form-error" role="alert">{{ wordError }}</p>
      </div>
    </li>
  </ol>
  <p v-if="invalidRow >= 0" class="form-error" role="alert">
    Periksa teks dan timestamp baris {{ invalidRow + 1 }}. Waktu harus berurutan dalam durasi {{ lyricTimestamp(duration) }}.
  </p>
  <p v-if="outdated" class="form-error" role="alert">Draft berubah sejak Editor dibuka. Muat draft terbaru untuk melanjutkan.</p>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <p v-if="notice" class="studio-description" role="status">{{ notice }}</p>
  <div v-if="dirty || outdated" class="studio-actions">
    <UButton icon="i-lucide-save" :loading="mode === 'save'"
      :disabled="blocked || outdated || !lines.length || invalidRow >= 0" @click="save">Simpan ke Draft</UButton>
    <UButton color="neutral" variant="outline" :disabled="blocked" @click="reset()">
      {{ outdated ? 'Muat draft terbaru' : 'Batalkan perubahan' }}
    </UButton>
  </div>
</template>

<style scoped>
.editor-scratch { display: grid; gap: .3rem; margin-top: 1rem; color: var(--studio-muted); }
.editor-lines { display: grid; gap: .4rem; margin-top: 1rem; max-height: min(42rem, 60dvh); overflow: auto; }
.editor-line {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) repeat(2, minmax(5rem, 7rem)) auto;
  align-items: end;
  gap: .4rem;
  padding: .38rem;
  background: #f3f6f1;
  border: 1px solid var(--studio-edge);
  border-radius: .5rem;
}
.editor-line-current { border-color: #8ba78a; background: #e7f0e5; }
.editor-line label { min-width: 0; color: var(--studio-muted); font-size: .8rem; }
.editor-line input, .editor-scratch textarea {
  display: block;
  width: 100%;
  padding: .42rem;
  border: 1px solid var(--studio-edge);
  border-radius: .4rem;
  background: #fff;
}
.editor-line input { min-height: 2.25rem; font-size: .9rem; }
.editor-line button { min-width: 2.25rem; min-height: 2.25rem; justify-content: center; }
.editor-scratch textarea { resize: vertical; }
.editor-words { grid-column: 1 / -1; min-width: 0; padding: .5rem; background: #fff; border-radius: .4rem; }
.editor-word-help { margin-bottom: .5rem; color: var(--studio-muted); font-size: .85rem; }
.editor-word {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) repeat(2, minmax(6rem, 9rem));
  gap: .35rem;
  align-items: end;
  padding: .3rem;
  border-radius: .35rem;
}
.editor-word-current { background: #e7f0e5; }
.editor-word-time { display: flex; min-width: 0; align-items: end; }
@media (max-width: 620px) {
  .editor-line { grid-template-columns: auto repeat(2, minmax(0, 1fr)); align-items: center; }
  .editor-lyric { grid-column: 2 / -1; }
  .editor-line > label:first-of-type { grid-column: 2; }
  .editor-line > button:last-of-type { grid-column: 2 / -1; justify-self: start; }
  .editor-word { grid-template-columns: auto repeat(2, minmax(0, 1fr)); }
  .editor-word-text { grid-column: 2 / -1; }
  .editor-word-time:first-of-type { grid-column: 2; }
}
</style>
