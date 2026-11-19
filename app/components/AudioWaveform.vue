<script lang="ts">
import type { Waveform } from '#shared/utils/waveform'

const waveformCache = new Map<string, Promise<Waveform>>()

function fetchWaveform(src: string) {
  const cached = waveformCache.get(src)
  if (cached) return cached
  const request = $fetch<Waveform>(src, { query: { waveform: '1' }, retry: 0 }).catch(error => {
    waveformCache.delete(src)
    throw error
  })
  waveformCache.set(src, request)
  if (waveformCache.size > 12) {
    const oldest = waveformCache.keys().next().value
    if (oldest) waveformCache.delete(oldest)
  }
  return request
}
</script>

<script setup lang="ts">
import { lyricTimestamp } from '#shared/utils/lyrics'
import type { LyricWord } from '#shared/utils/lyrics'
import { waveformDetail } from '#shared/utils/waveform'
import type { WaveformDetail } from '#shared/utils/waveform'

const props = withDefaults(defineProps<{
  src: string
  label: string
  durationMs?: number
  active?: boolean
  waveform?: Waveform
  pcm?: Blob
  showPitch?: boolean
  markers?: LyricWord[]
}>(), { active: true })
const emit = defineEmits<{ position: [ms: number] }>()
const audio = useTemplateRef<HTMLAudioElement>('audio')
const track = useTemplateRef<HTMLElement>('track')
const overview = useTemplateRef<HTMLCanvasElement>('overview')
const played = useTemplateRef<HTMLCanvasElement>('played')
const pitchCanvas = useTemplateRef<HTMLCanvasElement>('pitchCanvas')
const mounted = ref(false)
const position = ref(0)
const mediaDuration = ref(0)
const playing = ref(false)
const muted = ref(false)
const volume = ref(100)
const rate = ref(1)
const zoom = ref(0)
const viewStart = ref(0)
const waveform = shallowRef<Waveform>()
const detail = shallowRef<WaveformDetail>()
const loadingPeaks = ref(false)
const peakError = ref(false)
const detailError = ref(false)
const mediaError = ref('')
let resize: ResizeObserver | undefined
let frame: number | undefined
let pointerId: number | undefined
let pending: { ms: number, play: boolean } | undefined
let loadedSource = ''
let loadVersion = 0
let followPosition = true

const duration = computed(() => Math.round(mediaDuration.value || waveform.value?.durationMs || props.durationMs || 0))
const viewLength = computed(() => Math.min(duration.value, zoom.value || duration.value))
const viewEnd = computed(() => viewStart.value + viewLength.value)
const playhead = computed(() => viewLength.value ? 100 * (position.value - viewStart.value) / viewLength.value : 0)
const fill = computed(() => Math.max(0, Math.min(100, playhead.value)))
const ticks = computed(() => [viewStart.value, Math.round((viewStart.value + viewEnd.value) / 2), viewEnd.value])
const zoomSteps = computed(() => [0, 30_000, 10_000, 3_000, 1_000, 250].filter(ms => ms < duration.value || !ms))
const zoomIndex = computed(() => Math.max(0, zoomSteps.value.indexOf(zoom.value)))
const zoomLabel = computed(() => !zoom.value ? 'Penuh' : zoom.value >= 1_000 ? `${zoom.value / 1_000} dtk` : `${zoom.value} ms`)
const visibleMarkers = computed(() => {
  if (!zoom.value || viewLength.value > 10_000) return []
  return (props.markers ?? []).filter(word => word.startMs < viewEnd.value && word.endMs > viewStart.value).map(word => ({
    text: word.text,
    start: Math.max(0, (word.startMs - viewStart.value) * 100 / viewLength.value),
    end: Math.min(100, (word.endMs - viewStart.value) * 100 / viewLength.value),
    key: word.startMs
  }))
})
const currentPitch = computed(() => detail.value?.pitch.find(point => Math.abs(point.ms - position.value) <= 10)?.hz)

function clock(ms: number) {
  return lyricTimestamp(Math.max(0, ms), 'SRT').replace(/^00:0?/, '').replace(',', '.')
}

async function loadPeaks() {
  const version = ++loadVersion
  loadingPeaks.value = false
  peakError.value = false
  if (props.waveform) {
    waveform.value = props.waveform
    loadedSource = props.src
    return
  }
  if (loadedSource !== props.src) waveform.value = undefined
  if (!mounted.value || !props.active || !props.src || waveform.value) return
  const src = props.src
  loadingPeaks.value = true
  try {
    const result = await fetchWaveform(src)
    if (version !== loadVersion) return
    waveform.value = result
    loadedSource = src
  } catch {
    if (version === loadVersion) peakError.value = true
  } finally {
    if (version === loadVersion) loadingPeaks.value = false
  }
}

async function readLocalDetail(pcm: Blob, fromMs: number, toMs: number) {
  const header = new DataView(await pcm.slice(0, 44).arrayBuffer())
  const rate = header.getUint32(24, true)
  const first = Math.round(fromMs * rate / 1_000)
  const end = Math.round(toMs * rate / 1_000)
  const data = new DataView(await pcm.slice(44 + first * 2, 44 + end * 2).arrayBuffer())
  const samples = Float32Array.from({ length: data.byteLength / 2 }, (_, index) => data.getInt16(index * 2, true) / 32_768)
  return waveformDetail(samples, rate, fromMs, Boolean(props.showPitch))
}

watch([mounted, () => props.active, () => props.src, () => props.pcm, viewStart, viewLength, zoom], (_, __, cleanup) => {
  detail.value = undefined
  detailError.value = false
  if (!mounted.value || !props.active || !zoom.value || viewLength.value <= 0 || viewLength.value > 3_000) return
  const task = new AbortController()
  const { signal } = task
  const from = viewStart.value
  const to = viewEnd.value
  const timer = setTimeout(async () => {
    try {
      const result = props.pcm ? await readLocalDetail(props.pcm, from, to) :
        await $fetch<WaveformDetail>(props.src, { query: { waveform: 'detail', from, to }, signal, retry: 0 })
      if (!signal.aborted) detail.value = result
    } catch {
      if (!signal.aborted) detailError.value = true
    }
  }, 75)
  cleanup(() => {
    clearTimeout(timer)
    task.abort()
  })
})

function draw() {
  const width = track.value?.clientWidth ?? 0
  const height = track.value?.clientHeight ?? 0
  const peaks = waveform.value?.peaks
  const samples = detail.value
  if (!width || !height) return
  const scale = Math.min(window.devicePixelRatio || 1, 3)
  const spacing = zoom.value && zoom.value <= 1_000 ? 1 : zoom.value ? 2 : 3
  const barWidth = Math.max(1, spacing - 1)
  const columns = Math.max(1, Math.floor(width / spacing))
  const start = viewStart.value / duration.value * (peaks?.length ?? 0)
  const span = viewLength.value / duration.value * (peaks?.length ?? 0)
  for (const [canvas, color] of [[overview.value, '#859d88'], [played.value, '#356946']] as const) {
    if (!canvas) continue
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const context = canvas.getContext('2d')
    if (!context) continue
    context.setTransform(scale, 0, 0, scale, 0, 0)
    context.fillStyle = color
    if (!samples?.minimums.length && (!peaks?.length || !duration.value)) {
      context.fillRect(0, height / 2, width, 1)
      continue
    }
    for (let column = 0; column < columns; column++) {
      if (samples?.minimums.length) {
        const count = samples.minimums.length
        const begin = Math.floor(count * column / columns)
        const end = Math.ceil(count * (column + 1) / columns)
        let min = 127
        let max = -127
        for (let index = begin; index < end; index++) {
          min = Math.min(min, samples.minimums[index]!)
          max = Math.max(max, samples.maximums[index]!)
        }
        const amplitude = (height - 14) / 254
        context.fillRect(column * width / columns, height / 2 - max * amplitude, barWidth, Math.max(1, (max - min) * amplitude))
        continue
      }
      if (!peaks) break
      const begin = Math.floor(start + span * column / columns)
      const end = Math.min(peaks.length, Math.ceil(start + span * (column + 1) / columns))
      let peak = 0
      for (let index = begin; index < end; index++) peak = Math.max(peak, peaks[index]!)
      const barHeight = Math.max(1, peak / 255 * (height - 14))
      context.fillRect(column * width / columns, (height - barHeight) / 2, barWidth, barHeight)
    }
  }
  const pitch = pitchCanvas.value
  if (!pitch) return
  pitch.width = Math.round(width * scale)
  pitch.height = Math.round(height * scale)
  const context = pitch.getContext('2d')
  if (!context || !samples?.pitch.length) return
  context.scale(scale, scale)
  context.lineWidth = 2
  context.strokeStyle = '#8b520e'
  context.fillStyle = '#8b520e'
  let previous: number | undefined
  for (const point of samples.pitch) {
    const x = width * (point.ms - viewStart.value) / viewLength.value
    const y = height - 7 - (height - 15) * Math.log2(point.hz / 75) / Math.log2(650 / 75)
    if (previous === undefined || point.ms - previous > 40) {
      context.beginPath()
      context.moveTo(x, y)
      context.fillRect(x - 1, y - 1, 2, 2)
    } else {
      context.lineTo(x, y)
      context.stroke()
      context.beginPath()
      context.moveTo(x, y)
    }
    previous = point.ms
  }
}

function keepInView(ms: number, center = false) {
  if (!viewLength.value) return
  if (center || (followPosition && (ms < viewStart.value || ms > viewEnd.value))) {
    viewStart.value = Math.round(Math.max(0, Math.min(duration.value - viewLength.value, ms - viewLength.value / 2)))
  }
}

function setZoom(ms: number) {
  zoom.value = ms
  followPosition = true
  keepInView(position.value, true)
}

function pan(direction: number) {
  followPosition = false
  const start = viewStart.value + direction * Math.round(viewLength.value * 0.8)
  viewStart.value = Math.max(0, Math.min(duration.value - viewLength.value, start))
}

function setPosition(ms: number) {
  const time = Math.round(ms)
  if (time !== position.value) {
    position.value = time
    emit('position', time)
  }
  if (pointerId === undefined) keepInView(time)
}

function syncPosition() {
  if (audio.value && !pending && pointerId === undefined) setPosition(audio.value.currentTime * 1_000)
}

function stopFrame() {
  if (frame !== undefined) cancelAnimationFrame(frame)
  frame = undefined
}

function tick() {
  syncPosition()
  if (playing.value && audio.value && !audio.value.paused) frame = requestAnimationFrame(tick)
  else frame = undefined
}

function onPlay() {
  playing.value = true
  stopFrame()
  tick()
}

function onPause() {
  playing.value = false
  stopFrame()
  syncPosition()
}

function play() {
  mediaError.value = ''
  void audio.value?.play().catch((error: DOMException) => {
    if (error.name !== 'AbortError') mediaError.value = 'Audio gagal diputar. Coba lagi.'
  })
}

function pause() {
  if (pending) pending.play = false
  audio.value?.pause()
}

function seek(ms: number) {
  const element = audio.value
  if (!element || !duration.value) return
  followPosition = true
  const next = Math.max(0, Math.min(duration.value, ms))
  if (element.readyState && !pending) element.currentTime = next / 1_000
  else {
    pending = { ms: next, play: pending?.play ?? false }
    // Load the metadata on a seek even when playback stays paused.
    element.preload = 'metadata'
  }
  setPosition(next)
}

function seekAndPlay(ms: number) {
  seek(ms)
  if (pending) pending.play = true
  play()
}

function metadata() {
  const element = audio.value
  if (!element || !Number.isFinite(element.duration)) return
  mediaDuration.value = element.duration * 1_000
  element.playbackRate = rate.value
  if (pending) {
    const { ms, play: resume } = pending
    pending = undefined
    element.currentTime = Math.min(ms / 1_000, element.duration)
    if (resume && props.active && element.paused) play()
  }
  syncPosition()
}

function pointerSeek(event: PointerEvent) {
  const element = track.value
  if (!element) return
  const bounds = element.getBoundingClientRect()
  if (!bounds.width) return
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
  setPosition(viewStart.value + ratio * viewLength.value)
}

function startScrub(event: PointerEvent) {
  if (!duration.value || event.button !== 0 || !event.isPrimary) return
  pointerId = event.pointerId
  track.value?.setPointerCapture(event.pointerId)
  track.value?.focus({ preventScroll: true })
  pointerSeek(event)
}

function finishScrub(event: PointerEvent) {
  if (pointerId !== event.pointerId) return
  if (event.type === 'pointerup') pointerSeek(event)
  pointerId = undefined
  if (event.type === 'pointerup') seek(position.value)
  else syncPosition()
}

function applyAudioSettings() {
  if (!audio.value) return
  audio.value.volume = volume.value / 100
  audio.value.muted = muted.value
  audio.value.playbackRate = rate.value
}

function keyboardSeek(event: KeyboardEvent) {
  const step = zoom.value ? Math.min(100, Math.round(zoom.value / 25)) : 1_000
  const byKey: Record<string, number> = {
    ArrowLeft: position.value - step, ArrowDown: position.value - step,
    ArrowRight: position.value + step, ArrowUp: position.value + step,
    PageDown: position.value - step * 10, PageUp: position.value + step * 10, Home: 0, End: duration.value
  }
  const next = byKey[event.key]
  if (next === undefined || !duration.value) return
  event.preventDefault()
  seek(next)
}

watch(() => props.src, () => {
  const element = audio.value
  if (element && !pending) pending = { ms: position.value, play: !element.paused }
  mediaError.value = ''
  mediaDuration.value = 0
  playing.value = false
  stopFrame()
}, { flush: 'sync' })
watch([mounted, () => props.src, () => props.active, () => props.waveform], () => void loadPeaks())
watch(() => props.active, active => { if (!active) pause() })
watch([muted, volume, rate], applyAudioSettings)
watch([waveform, detail, duration, viewStart, viewLength], draw, { flush: 'post' })
watch(duration, () => { viewStart.value = Math.max(0, Math.min(viewStart.value, duration.value - viewLength.value)) })

onMounted(() => {
  mounted.value = true
  if (track.value) {
    resize = new ResizeObserver(draw)
    resize.observe(track.value)
  }
})
onBeforeUnmount(() => {
  ++loadVersion
  stopFrame()
  pause()
  resize?.disconnect()
})

defineExpose({ pause, seekAndPlay })
</script>

<template>
  <div class="waveform-player" :aria-label="label" role="group">
    <audio
      ref="audio" :src="src" :preload="active ? 'metadata' : 'none'" hidden
      @loadedmetadata="metadata" @timeupdate="syncPosition" @seeked="syncPosition"
      @play="onPlay" @pause="onPause" @ended="onPause"
      @error="pending = undefined; mediaError = 'Audio tidak dapat dimuat.'"
    />
    <div class="waveform-toolbar">
      <UButton color="neutral" class="waveform-play" :icon="playing ? 'i-lucide-pause' : 'i-lucide-play'"
        :aria-label="playing ? 'Jeda audio' : 'Putar audio'" @click="playing ? pause() : play()" />
      <p class="waveform-time" aria-label="Waktu pemutaran">
        <strong>{{ clock(position) }}</strong><span> / {{ clock(duration) }}</span>
      </p>
      <details class="waveform-settings">
        <summary class="waveform-sound" aria-label="Pengaturan suara" title="Pengaturan suara">
          <UIcon :name="muted || !volume ? 'i-lucide-volume-x' : 'i-lucide-volume-2'" aria-hidden="true" />
        </summary>
        <div class="waveform-settings-panel">
          <label>Volume <input v-model.number="volume" type="range" min="0" max="100"></label>
          <label class="waveform-rate">Kecepatan
            <select v-model.number="rate">
              <option v-for="speed in [0.5, 0.75, 1, 1.25, 1.5, 2]" :key="speed" :value="speed">{{ speed }}×</option>
            </select>
          </label>
          <button type="button" class="waveform-retry" :aria-pressed="muted" @click="muted = !muted">
            {{ muted ? 'Nyalakan suara' : 'Bisukan audio' }}
          </button>
        </div>
      </details>
      <div class="waveform-zoom" role="group" aria-label="Perbesaran waveform">
        <button type="button" aria-label="Perkecil waveform" :disabled="zoomIndex === 0" @click="setZoom(zoomSteps[zoomIndex - 1]!)">
          <UIcon name="i-lucide-zoom-out" aria-hidden="true" />
        </button>
        <button type="button" class="waveform-zoom-label" :aria-label="`Jendela ${zoomLabel}. Tampilkan seluruh audio`"
          @click="setZoom(0)">{{ zoomLabel }}</button>
        <button type="button" aria-label="Perbesar waveform" :disabled="zoomIndex === zoomSteps.length - 1" @click="setZoom(zoomSteps[zoomIndex + 1]!)">
          <UIcon name="i-lucide-zoom-in" aria-hidden="true" />
        </button>
      </div>
    </div>
    <div
      ref="track" class="waveform-track" role="slider" :tabindex="duration ? 0 : -1"
      :aria-label="`Posisi pemutaran · ${label}`" :aria-valuemin="0" :aria-valuemax="duration"
      :aria-valuenow="position" :aria-valuetext="clock(position)"
      @pointerdown="startScrub" @pointermove="pointerId === $event.pointerId && pointerSeek($event)"
      @pointerup="finishScrub" @pointercancel="finishScrub" @lostpointercapture="finishScrub" @keydown="keyboardSeek"
    >
      <canvas ref="overview" aria-hidden="true" />
      <canvas ref="played" aria-hidden="true" :style="{ clipPath: `inset(0 ${100 - fill}% 0 0)` }" />
      <canvas ref="pitchCanvas" aria-hidden="true" />
      <span v-for="marker in visibleMarkers" :key="marker.key" class="waveform-word"
        :style="{ left: `${marker.start}%`, width: `${marker.end - marker.start}%` }" aria-hidden="true">
        <span v-if="marker.end - marker.start >= 7">{{ marker.text }}</span>
      </span>
      <span v-if="playhead >= 0 && playhead <= 100" class="waveform-head" :style="{ left: `${playhead}%` }" aria-hidden="true" />
      <span v-if="loadingPeaks && !waveform" class="waveform-loading" role="status">Memuat waveform…</span>
    </div>
    <div class="waveform-ticks" aria-hidden="true">
      <time v-for="(time, index) in ticks" :key="index">{{ clock(time) }}</time>
    </div>
    <div v-if="zoom" class="waveform-detail-footer">
      <button type="button" aria-label="Geser jendela ke kiri" :disabled="viewStart === 0" @click="pan(-1)">
        <UIcon name="i-lucide-chevron-left" aria-hidden="true" />
      </button>
      <p v-if="detailError" class="waveform-error">Detail belum tersedia</p>
      <p v-else-if="showPitch && viewLength <= 3_000" class="waveform-pitch-key">
        <template v-if="detail?.pitch.length">Perkiraan nada<template v-if="currentPitch"> · {{ currentPitch }} Hz</template></template>
        <template v-else-if="detail">Nada kurang jelas</template>
        <template v-else>Memuat detail…</template>
      </p>
      <button type="button" aria-label="Geser jendela ke kanan" :disabled="viewEnd >= duration" @click="pan(1)">
        <UIcon name="i-lucide-chevron-right" aria-hidden="true" />
      </button>
    </div>
    <p v-if="mediaError" class="form-error" role="alert">{{ mediaError }}</p>
    <p v-if="peakError" class="waveform-error">Waveform gagal dimuat.
      <button class="waveform-retry" type="button" @click="loadPeaks()">Coba lagi</button>
    </p>
  </div>
</template>

<style scoped>
.waveform-player { min-width: 0; padding: .55rem .65rem .4rem; border: 1px solid #d4dfd3; border-radius: .65rem; background: #f7faf6; }
.waveform-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .2rem .55rem; margin-bottom: .4rem; }
.waveform-play, .waveform-sound { width: 2.75rem; min-height: 2.75rem; justify-content: center; padding: 0; }
.waveform-settings { position: relative; }
.waveform-sound { display: flex; align-items: center; list-style: none; border-radius: .35rem; }
.waveform-sound::-webkit-details-marker { display: none; }
.waveform-sound:hover { background: #e1ebe1; }
.waveform-settings-panel { position: absolute; z-index: 2; inset: calc(100% + .3rem) 0 auto auto; width: 11rem; display: grid; gap: .4rem; padding: .7rem; border: 1px solid #d4dfd3; border-radius: .5rem; background: #fff; box-shadow: 0 4px 16px #202b2326; font-size: .875rem; }
.waveform-settings-panel label { display: grid; gap: .2rem; }
.waveform-settings-panel input { width: 100%; accent-color: #356946; }
.waveform-settings-panel .waveform-rate { grid-template-columns: 1fr 4.5rem; align-items: center; }
.waveform-settings-panel select { padding: .3rem; border: 1px solid #d4dfd3; border-radius: .35rem; }
.waveform-time, .waveform-ticks { font-variant-numeric: tabular-nums; }
.waveform-time { margin-right: auto; color: #475a49; white-space: nowrap; font-size: .9rem; }
.waveform-time strong { color: #20442a; }
.waveform-zoom { display: flex; flex-wrap: wrap; gap: .15rem; }
.waveform-zoom button, .waveform-detail-footer button { display: grid; place-items: center; min-width: 2.75rem; min-height: 2.75rem; padding: .15rem .35rem; border-radius: .35rem; }
.waveform-zoom button:hover, .waveform-detail-footer button:hover { background: #e1ebe1; }
.waveform-zoom .waveform-zoom-label { min-width: 3.7rem; background: #dcebdd; color: #254e30; font-size: .875rem; font-weight: 700; }
.waveform-zoom button:disabled { opacity: .48; }
.waveform-track { position: relative; height: 4.65rem; overflow: hidden; border: 1px solid #dce5da; border-radius: .4rem; background: #edf4ed; cursor: crosshair; touch-action: pan-y; }
.waveform-track canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.waveform-track:focus-visible { outline: 2px solid #356946; outline-offset: 2px; }
.waveform-head { position: absolute; inset-block: 0; width: 2px; background: #1d6338; pointer-events: none; transform: translateX(-50%); }
.waveform-word { position: absolute; inset-block: 0; border-inline-start: 1px dashed #4e74518c; color: #254e30; font-size: .7rem; overflow: hidden; pointer-events: none; }
.waveform-word span { display: block; width: fit-content; max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding-inline: .15rem; background: #eff7ed; }
.waveform-loading { position: absolute; inset: 0; display: grid; place-items: center; color: #294631; font-size: .875rem; pointer-events: none; }
.waveform-ticks { display: flex; justify-content: space-between; gap: .4rem; margin-top: .25rem; color: #465949; font-size: .8rem; }
.waveform-detail-footer { display: flex; justify-content: space-between; align-items: center; gap: .35rem; }
.waveform-detail-footer button:disabled { opacity: .45; }
.waveform-pitch-key { color: #79490e; font-size: .875rem; }
.waveform-error { color: #475a49; font-size: .875rem; }
.waveform-retry { text-decoration: underline; text-underline-offset: .15em; }
@media (max-width: 420px) {
  .waveform-toolbar { gap: .15rem .35rem; }
  .waveform-zoom button { padding-inline: .36rem; }
}
</style>
