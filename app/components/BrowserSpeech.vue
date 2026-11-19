<script setup lang="ts">
import type { Extraction, LyricLine, LyricReference, SpeechTranscript } from '#shared/utils/lyrics'
import type { Waveform } from '#shared/utils/waveform'
import { browserSpeech, loadSpeechAudio, previewSpeechAudio, speechSampleRate, transcribeWithBrowser } from '~/utils/web-speech'
import type { SpeechChannel, SpeechEqPreset } from '~/utils/web-speech'
import { alignLyrics, alignSyncedLyrics, estimateWordsFromLines } from '~/utils/align-lyrics'
import { refineVocalTiming } from '~/utils/vocal-timing'
import AudioWaveform from './AudioWaveform.vue'

const props = defineProps<{ job: Extraction, active: boolean, hasTranscript: boolean }>()
const emit = defineEmits<{
  running: [value: boolean], complete: [result: Extraction],
  checkpoint: [transcript: SpeechTranscript, complete: boolean]
}>()
const initialSource = props.job.hasVocals && !props.job.useOriginal ? 'vocals' : 'original'
const savedSettings = [props.job.speechCheckpoint, props.job.transcript].find(item => item?.source === initialSource)
const language = ref<'id' | 'en'>(savedSettings?.language ??
  (props.job.language === 'en' || props.job.requestedLanguage === 'en' ? 'en' : 'id'))
const speechEq = ref<SpeechEqPreset>(savedSettings?.eq ?? (!props.job.hasVocals || props.job.useOriginal ? 'clarity' : 'off'))
const eqNames = { off: 'Tanpa EQ', clarity: 'Fokus vokal', 'high-register': 'Prioritas suara tinggi' }
const speechChannel = ref<SpeechChannel>(savedSettings?.channel ?? 'mix')
const channelNames = { mix: 'Campuran kiri + kanan', left: 'Kiri', right: 'Kanan' }
const supported = ref(false)
const mounted = ref(false)
const settingsOpen = ref(false)
const running = ref(false)
const error = ref('')
const activity = ref({ at: 0, message: '', percent: undefined as number | undefined })
const startedAt = ref(0)
const draft = shallowRef<{ language: 'id' | 'en', revision: number, lines: LyricLine[], lyricReference?: LyricReference, vocalTiming?: boolean }>()
const reference = computed(() => props.job.selectedReference)
const syncedReference = computed(() => reference.value && props.job.durationMs
  ? alignSyncedLyrics(reference.value, props.job.durationMs) : undefined)
const alignmentNote = ref('')
const legacyWordDraft = computed(() => props.job.lyricReference ? estimateWordsFromLines(props.job.lines || []) : undefined)
const canRefineTiming = computed(() => props.job.phase === 'ready' && props.job.hasVocals &&
  !props.job.vocalTiming && Boolean(props.job.lines?.length))
const debugOpen = ref(false)
const previewLoading = ref(false)
const previewUrl = ref('')
const previewWaveform = shallowRef<Waveform>()
const previewPcm = shallowRef<Blob>()
const previewError = ref('')
const previewPlayer = useTemplateRef<InstanceType<typeof AudioWaveform>>('previewPlayer')
const transcriptView = useTemplateRef<HTMLElement>('transcriptView')
const confirmedText = ref('')
const interimText = ref('')
const followTranscript = ref(true)
const audioSource = computed(() => props.job.hasVocals && !props.job.useOriginal ? 'vocals' : 'original')
const audioUrl = computed(() => `/api/extractions/${props.job.id}/audio/${audioSource.value}`)
const canResume = computed(() => props.job.speechCheckpoint?.source === audioSource.value)
const savedLines = computed(() => props.job.transcript?.lines ?? (!props.job.lyricReference ? props.job.lines : undefined))
let controller: AbortController | undefined
let previewRequest: AbortController | undefined

const liveJob = computed<Extraction>(() => ({
  ...props.job, phase: 'transcribing', startedAt: startedAt.value,
  logs: [...(props.job.logs || []), { key: 'live-speech', ...activity.value }]
}))

onMounted(() => {
  supported.value = Boolean(browserSpeech())
  mounted.value = true
})
onBeforeUnmount(() => {
  controller?.abort()
  previewRequest?.abort()
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})

watch([confirmedText, interimText], () => {
  const view = transcriptView.value
  if (view && followTranscript.value) view.scrollTop = view.scrollHeight
}, { flush: 'post' })

function onTranscriptScroll(event: Event) {
  const view = event.currentTarget as HTMLElement
  followTranscript.value = view.scrollHeight - view.clientHeight - view.scrollTop < 16
}

async function loadPreview() {
  const request = new AbortController()
  previewRequest = request
  previewLoading.value = true
  previewError.value = ''
  try {
    const { blob, waveform } = await previewSpeechAudio(audioUrl.value, speechChannel.value, speechEq.value, request.signal)
    if (!request.signal.aborted) {
      previewWaveform.value = waveform
      previewPcm.value = blob
      previewUrl.value = URL.createObjectURL(blob)
    }
  } catch (cause) {
    if (!request.signal.aborted) {
      previewError.value = cause instanceof Error ? cause.message : 'Pratinjau EQ gagal dibuat.'
    }
  } finally {
    if (previewRequest === request) {
      previewRequest = undefined
      previewLoading.value = false
    }
  }
}

function cancelPreview() {
  previewPlayer.value?.pause()
  previewRequest?.abort()
  previewRequest = undefined
  previewLoading.value = false
}

function toggleDebug() {
  debugOpen.value = !debugOpen.value
  if (!debugOpen.value) cancelPreview()
  else if (!previewUrl.value) void loadPreview()
}

watch([speechChannel, speechEq, audioUrl], () => {
  cancelPreview()
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  previewWaveform.value = undefined
  previewPcm.value = undefined
  if (debugOpen.value) void loadPreview()
})
watch(() => props.active, active => {
  if (!active) cancelPreview()
  else if (debugOpen.value && (settingsOpen.value || (!props.hasTranscript && !props.job.lines)) && !previewUrl.value) void loadPreview()
})
watch(settingsOpen, open => { if (!open) cancelPreview() })

function update(message: string, percent?: number) {
  if (activity.value.message === message && activity.value.percent === percent) return
  activity.value = { at: Date.now(), message, percent }
}

async function start(mode: 'speech' | 'resume' | 'save' | 'existing' | 'words' | 'vocal' | 'synced' = 'speech') {
  const recognizing = mode === 'speech' || mode === 'resume'
  if (running.value || !props.job.durationMs || (recognizing && !supported.value)) return
  if (mode === 'save' && !draft.value) return
  if (mode === 'existing' && !savedLines.value?.length) return
  if (mode === 'resume' && !canResume.value) return
  if (mode === 'words' && !legacyWordDraft.value) return
  if (mode === 'vocal' && !canRefineTiming.value) return
  if (mode === 'synced' && !syncedReference.value) return
  const task = new AbortController()
  controller = task
  const { signal } = task
  const job = props.job
  let selectedLanguage = language.value
  let selectedEq = speechEq.value
  let selectedChannel = speechChannel.value
  const selectedReference = reference.value
  const syncedLines = syncedReference.value
  const durationMs = job.durationMs!
  startedAt.value = Date.now()
  error.value = ''
  if (mode !== 'save') alignmentNote.value = ''
  running.value = true
  if (recognizing) settingsOpen.value = false
  emit('running', true)
  let audio: AudioContext | undefined
  try {
    if (mode !== 'save') {
      draft.value = undefined
      previewPlayer.value?.pause()
      confirmedText.value = ''
      interimText.value = ''
      followTranscript.value = true
      let lines = mode === 'synced' ? syncedLines! : mode === 'words' ? legacyWordDraft.value! :
        mode === 'existing' ? savedLines.value! : job.lines || []
      let vocalAudio: AudioBuffer | undefined
      if (recognizing) {
        update(`Menyiapkan audio · ${channelNames[selectedChannel]} · ${eqNames[selectedEq]}…`)
        audio = new AudioContext({ sampleRate: speechSampleRate })
        await audio.resume()
        const path = `/api/extractions/${job.id}/transcript`
        const runId = crypto.randomUUID()
        const checkpoint = await $fetch<SpeechTranscript>(path, {
          method: 'PUT', signal, body: { runId, previousRunId: job.speechCheckpoint?.runId ?? null,
            resume: mode === 'resume', language: selectedLanguage, channel: selectedChannel, eq: selectedEq }
        })
        emit('checkpoint', checkpoint, false)
        selectedLanguage = checkpoint.language
        selectedEq = checkpoint.eq
        selectedChannel = checkpoint.channel
        async function saveCheckpoint(lines: LyricLine[], processedMs: number, complete = false) {
          const saved = await $fetch<SpeechTranscript>(path, {
            method: 'PUT', signal, body: { runId, lines, processedMs, complete }
          })
          emit('checkpoint', saved, complete)
        }
        const transcript = await transcribeWithBrowser(audio, audioUrl.value, selectedLanguage,
          durationMs, selectedEq, selectedChannel, audioSource.value === 'vocals', signal,
          (percent, message) => update(message, percent), (confirmed, interim) => {
            confirmedText.value = confirmed
            interimText.value = interim
          }, { lines: checkpoint.lines, processedMs: checkpoint.processedMs, save: saveCheckpoint })
        lines = transcript.lines
        await saveCheckpoint(lines, durationMs, true)
        if (audioSource.value === 'vocals') vocalAudio = transcript.audio
      } else {
        if (mode === 'existing' && job.transcript) {
          selectedLanguage = job.transcript.language
          selectedChannel = job.transcript.channel
        }
        confirmedText.value = lines.map(line => line.text).join('\n')
      }
      let lyricReference = mode === 'words' || mode === 'vocal' ? job.lyricReference : undefined
      if (selectedReference && (recognizing || mode === 'existing' || mode === 'synced')) {
        if (syncedLines) {
          const { id, trackName, artistName } = selectedReference
          lyricReference = { id, trackName, artistName, matchedLines: 0, timingSource: 'lrclib' }
          lines = syncedLines
        } else {
          update('Mencocokkan teks LRCLIB dengan posisi kata hasil transkripsi…')
          const aligned = alignLyrics(selectedReference.text, lines, durationMs)
          if (aligned) {
            const { id, trackName, artistName } = selectedReference
            lyricReference = { id, trackName, artistName, matchedLines: aligned.matchedLines }
            lines = aligned.lines
          } else {
            const message = 'Kecocokan kata dengan LRCLIB terlalu sedikit untuk memperkirakan waktu.'
            if (mode === 'existing') throw new Error(message)
            alignmentNote.value = `${message} Draft memakai teks Web Speech.`
          }
        }
      }
      let vocalTiming = false
      if (job.hasVocals && lines.length) {
        const estimates = estimateWordsFromLines(lines)
        lines = estimates ?? lines
        update('Menganalisis transisi bunyi pada stem vokal…')
        try {
          vocalAudio ??= await loadSpeechAudio(new OfflineAudioContext(1, 1, speechSampleRate),
            `/api/extractions/${job.id}/audio/vocals`, signal)
          const refined = await refineVocalTiming(lines, vocalAudio, selectedChannel, signal)
          lines = refined.lines
          vocalTiming = refined.changed
          if (mode === 'vocal' && !vocalTiming) {
            alignmentNote.value = 'Perkiraan awal dipakai karena transisi vokal di dekat batas kata kurang jelas.'
            if (!estimates) return
          }
        } catch (cause) {
          if (signal.aborted || mode === 'vocal') throw cause
          alignmentNote.value = [alignmentNote.value, 'Analisis stem vokal gagal. Draft memakai perkiraan waktu awal.']
            .filter(Boolean).join(' ')
        }
      }
      const draftLanguage = !recognizing && mode !== 'existing' && (job.language === 'id' || job.language === 'en')
        ? job.language : selectedLanguage
      draft.value = { language: draftLanguage, revision: job.speechRevision ?? 0, lines, lyricReference, vocalTiming }
    }
    update('Menyimpan draft lirik…')
    const result = await $fetch<Extraction>(`/api/extractions/${job.id}/speech`, {
      method: 'POST', body: draft.value, signal
    })
    draft.value = undefined
    emit('complete', result)
  } catch (cause) {
    if (!signal.aborted) {
      const response = cause as { data?: { data?: { message?: string } } }
      error.value = response.data?.data?.message || (cause instanceof Error ? cause.message : 'Web Speech gagal.')
    }
  } finally {
    await audio?.close().catch(() => {})
    interimText.value = ''
    if (controller === task) controller = undefined
    running.value = false
    emit('running', false)
  }
}
defineExpose({ start })
</script>

<template>
  <div class="browser-speech">
    <template v-if="running">
      <ExtractionProgress :job="liveJob" />
      <div class="speech-transcript">
        <strong id="live-speech-title">Teks langsung</strong>
        <div ref="transcriptView" class="transcript-view" role="region" tabindex="0"
          aria-labelledby="live-speech-title" @scroll="onTranscriptScroll">
          <p v-if="confirmedText" class="transcript-final">{{ confirmedText }}</p>
          <p v-if="interimText" class="transcript-interim"><small>Sementara</small> {{ interimText }}</p>
          <p v-if="!confirmedText && !interimText" class="speech-note">Menunggu kata pertama…</p>
        </div>
      </div>
      <UButton v-if="!draft" color="neutral" variant="outline" @click="controller?.abort()">Hentikan proses</UButton>
    </template>
    <template v-else-if="mounted && supported">
      <div v-if="hasTranscript || job.lines" class="speech-controls">
        <UButton v-if="canResume" icon="i-lucide-play" @click="start('resume')">Lanjutkan transkripsi</UButton>
        <UButton variant="outline" color="neutral" icon="i-lucide-mic" :aria-expanded="settingsOpen"
          aria-controls="speech-settings" @click="settingsOpen = !settingsOpen">
          {{ settingsOpen ? 'Tutup pengaturan' : 'Transkripsi ulang' }}
        </UButton>
      </div>
      <div v-if="settingsOpen || (!hasTranscript && !job.lines)" id="speech-settings">
        <div class="speech-settings">
        <label>Bahasa lirik
        <select id="speech-language" v-model="language">
          <option value="id">Indonesia</option>
          <option value="en">Inggris</option>
        </select></label>
        <label>Kanal audio
        <select id="speech-channel" v-model="speechChannel">
          <option value="mix">Campuran kiri + kanan</option>
          <option value="left">Kiri</option>
          <option value="right">Kanan</option>
        </select></label>
        <label>Profil EQ
        <select id="speech-eq" v-model="speechEq">
          <option value="off">{{ eqNames.off }}</option>
          <option value="clarity">{{ eqNames.clarity }}</option>
          <option value="high-register">{{ eqNames['high-register'] }}</option>
        </select></label>
        </div>
        <div class="speech-controls">
          <UButton icon="i-lucide-mic" @click="start()">
            {{ hasTranscript || job.lines ? 'Mulai ulang' : 'Mulai transkripsi' }}
          </UButton>
          <UButton color="neutral" variant="outline" :aria-expanded="debugOpen" aria-controls="speech-debug-panel" @click="toggleDebug">
            {{ debugOpen ? 'Tutup pratinjau EQ' : 'Pratinjau EQ' }}
          </UButton>
        </div>
        <div v-if="debugOpen" id="speech-debug-panel" class="debug-panel">
          <p class="speech-note">{{ eqNames[speechEq] }} · {{ audioSource === 'vocals' ? 'Stem vokal' : 'Audio asli' }} · {{ channelNames[speechChannel] }}</p>
          <p v-if="previewLoading" role="status">Menyiapkan pratinjau audio…</p>
          <p v-if="previewError" class="form-error" role="alert">{{ previewError }}</p>
          <AudioWaveform v-if="previewUrl && previewWaveform" ref="previewPlayer" :src="previewUrl" :waveform="previewWaveform"
            :pcm="previewPcm" :active="active" :show-pitch="audioSource === 'vocals'" label="Pratinjau EQ Web Speech" />
        </div>
        <p class="speech-note">Progres disimpan setelah tiap potongan audio. Browser dapat mengirim audio ke layanan pengenalan suara.</p>
      </div>
      <p v-if="job.speechCheckpoint && !canResume" class="speech-note">Sumber audio berubah. Kamu masih bisa melihat transkrip parsial sebelumnya.</p>
    </template>
    <p v-else-if="mounted" class="speech-note">
      Jalankan Web Speech dari file di Chrome desktop. Transkrip tersimpan tetap bisa dibuka di Studio.
    </p>
    <template v-if="mounted && !running">
      <UButton v-if="savedLines?.length && !job.lines" class="apply-reference" variant="outline" color="neutral" @click="start('existing')">
        Buat draft dari transkrip
      </UButton>
      <UButton v-if="draft" class="apply-reference" @click="start('save')">Coba simpan lagi</UButton>
      <p v-if="alignmentNote" class="speech-note" role="status">{{ alignmentNote }}</p>
    </template>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.browser-speech { margin-top: .75rem; }
.speech-controls { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
.speech-settings { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr)); gap: .75rem; margin-block: .9rem; }
.speech-settings label { display: grid; gap: .25rem; font-weight: 700; font-size: .9rem; }
.speech-settings select { padding: .45rem; min-height: 44px; border: 1px solid #d5d9cf; border-radius: .5rem; width: 100%; background: #fff; }
.speech-controls button { min-height: 44px; }
.speech-note { margin-top: .45rem; font-size: .875rem; color: #635a46; }
.apply-reference { min-height: 44px; margin-top: .45rem; }
.debug-panel, .speech-transcript { margin-block: .65rem; padding: .6rem .75rem; border: 1px solid #dfd4b7; border-radius: .6rem; }
.transcript-view { max-height: 12rem; overflow: auto; margin-top: .3rem; overflow-wrap: anywhere; }
.transcript-final { white-space: pre-wrap; }
.transcript-interim { color: #635a46; font-style: italic; }
.transcript-interim small { font-style: normal; font-weight: 700; }
</style>
