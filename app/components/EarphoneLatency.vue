<script setup lang="ts">
import { audioOffset, latencyStorageKey, latencyTestAudio, latencyTestFlash,
  maximumOffsetMs, minimumOffsetMs } from '~/utils/playback-latency'
import { useLatencyTestRunning, usePlaybackLatency } from '~/composables/usePlaybackLatency'

const offset = usePlaybackLatency()
const testing = useLatencyTestRunning()
const open = ref(false)
const value = ref<number | string>(0)
const previewOffset = computed(() => audioOffset(Number(value.value)))
const estimate = ref<number>()
const flash = ref(false)
const error = ref('')
const savedInBrowser = ref(true)
let player: HTMLAudioElement | undefined
let previewUrl: string | undefined
let context: AudioContext | undefined
let frame: number | undefined

function restore(event?: StorageEvent) {
  if (event && event.key !== latencyStorageKey && event.key !== null) return
  try { offset.value = audioOffset(Number(localStorage.getItem(latencyStorageKey))) } catch {}
}

function display(ms: number) {
  return `${ms > 0 ? '+' : ''}${ms} ms`
}

function stop() {
  testing.value = false
  flash.value = false
  if (frame !== undefined) cancelAnimationFrame(frame)
  frame = undefined
  player?.pause()
  player = undefined
  if (previewUrl) URL.revokeObjectURL(previewUrl)
  previewUrl = undefined
  if (context) void context.close().catch(() => {})
  context = undefined
}

function tick() {
  if (!player) return
  flash.value = latencyTestFlash(player.currentTime * 1_000, previewOffset.value)
  frame = requestAnimationFrame(tick)
}

async function measure(test: HTMLAudioElement) {
  if (!window.AudioContext) return
  let measuring: AudioContext | undefined
  try {
    measuring = new AudioContext()
    context = measuring
    await measuring.resume()
    if (player === test && measuring.outputLatency > 0 && Number.isFinite(measuring.outputLatency)) {
      estimate.value = Math.round(measuring.outputLatency * 1_000)
    }
  } catch {
    // The listening test uses the media element and works without a browser estimate.
  } finally {
    if (measuring && context === measuring) {
      context = undefined
      void measuring.close().catch(() => {})
    }
  }
}

async function start() {
  if (testing.value) return
  error.value = ''
  estimate.value = undefined
  previewUrl = URL.createObjectURL(latencyTestAudio())
  const test = new Audio(previewUrl)
  test.loop = true
  player = test
  testing.value = true
  try {
    const playback = test.play()
    void measure(test)
    await playback
    if (player === test) tick()
  } catch {
    if (player !== test) return
    stop()
    error.value = 'Tes audio gagal diputar. Coba mulai lagi.'
  }
}

function save() {
  offset.value = previewOffset.value
  try {
    localStorage.setItem(latencyStorageKey, String(offset.value))
    savedInBrowser.value = true
  } catch {
    savedInBrowser.value = false
  }
  open.value = false
}

function onVisibility() {
  if (document.hidden) stop()
}

watch(open, visible => {
  if (visible) {
    value.value = offset.value
    error.value = ''
  } else stop()
})
onMounted(() => {
  restore()
  window.addEventListener('storage', restore)
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  window.removeEventListener('storage', restore)
  document.removeEventListener('visibilitychange', onVisibility)
  stop()
})
</script>

<template>
  <UModal v-model:open="open" title="Sinkron earphone"
    description="Sejajarkan highlight lirik dan playhead dengan suara di earphone." scrollable>
    <UButton variant="outline" color="neutral" icon="i-lucide-headphones" class="studio-latency-trigger"
      :aria-label="`Sinkron earphone, ${display(offset)}`" title="Sinkron earphone">
      <span class="studio-latency-label">Sinkron earphone</span>
      <span v-if="offset" class="studio-latency-value">{{ display(offset) }}</span>
    </UButton>
    <template #body>
      <div class="latency-body">
        <div class="latency-test">
          <div class="latency-light" :class="{ 'latency-light-on': flash }" aria-hidden="true">
            <UIcon name="i-lucide-zap" />
          </div>
          <p>Mulai tes dan cocokkan bunyi klik dengan kilatan. Kalau kilatan muncul dulu, naikkan offset. Kalau bunyi klik dulu, turunkan.</p>
          <UButton :icon="testing ? 'i-lucide-square' : 'i-lucide-play'" :variant="testing ? 'outline' : 'solid'"
            color="neutral" @click="testing ? stop() : start()">
            {{ testing ? 'Hentikan tes' : 'Mulai tes klik' }}
          </UButton>
        </div>

        <fieldset class="latency-offset">
          <legend>Offset tampilan</legend>
          <div class="latency-entry">
            <UButton icon="i-lucide-minus" variant="outline" color="neutral" aria-label="Kurangi 10 milidetik"
              :disabled="previewOffset <= minimumOffsetMs" @click="value = audioOffset(previewOffset - 10)" />
            <label class="latency-number">
              <input v-model.number="value" type="number" :min="minimumOffsetMs" :max="maximumOffsetMs"
                aria-label="Offset dalam milidetik" @blur="value = previewOffset">
              <span>ms</span>
            </label>
            <UButton icon="i-lucide-plus" variant="outline" color="neutral" aria-label="Tambah 10 milidetik"
              :disabled="previewOffset >= maximumOffsetMs" @click="value = audioOffset(previewOffset + 10)" />
          </div>
          <input class="latency-range" type="range" :min="minimumOffsetMs" :max="maximumOffsetMs"
            :value="previewOffset" aria-label="Atur offset tampilan dalam milidetik"
            @input="value = Number(($event.target as HTMLInputElement).value)">
          <p v-if="estimate !== undefined" class="latency-estimate">
            Perkiraan output browser {{ estimate }} ms.
            <button type="button" @click="value = audioOffset(estimate!)">Gunakan sebagai awal</button>
          </p>
        </fieldset>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <p class="latency-note">{{ savedInBrowser ? 'Offset berlaku untuk semua pemutar Studio di browser ini.' : 'Penyimpanan browser tidak tersedia. Offset berlaku sampai halaman dimuat ulang.' }}</p>
      </div>
    </template>
    <template #footer>
      <div class="latency-footer">
        <UButton variant="ghost" color="neutral" @click="value = 0">Reset ke 0</UButton>
        <UButton color="neutral" @click="save()">Simpan offset</UButton>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.latency-body { display: grid; gap: 1rem; }
.latency-test { display: grid; grid-template-columns: 3rem minmax(0, 1fr); align-items: center; gap: .7rem; }
.latency-test button { grid-column: 2; justify-self: start; }
.latency-light { display: grid; place-items: center; width: 3rem; height: 3rem; border-radius: .65rem; border: 1px solid #c8d7c7; background: #e7eee5; color: #4a6650; font-size: 1.4rem; }
.latency-light-on { background: #f6d875; color: #302408; border-color: #826012; }
.latency-offset { min-width: 0; display: grid; gap: .6rem; }
.latency-offset legend { font-weight: 700; margin-bottom: .45rem; }
.latency-entry { display: flex; align-items: center; gap: .4rem; }
.latency-body button, .latency-footer button { min-height: 2.75rem; }
.latency-number { display: inline-flex; align-items: center; gap: .25rem; padding-inline: .5rem; border: 1px solid #c8d7c7; border-radius: .4rem; }
.latency-number input { width: 4.25rem; min-height: 2.75rem; font-variant-numeric: tabular-nums; }
.latency-range { width: 100%; min-height: 2rem; accent-color: #36583d; }
.latency-note, .latency-estimate { font-size: .9rem; color: #4c5a4e; }
.latency-estimate button { text-decoration: underline; text-underline-offset: .15em; }
.latency-footer { display: flex; width: 100%; flex-wrap: wrap; justify-content: space-between; gap: .5rem; }
</style>
