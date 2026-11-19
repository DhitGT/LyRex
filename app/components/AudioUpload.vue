<script setup lang="ts">
import { isYouTubeUrl } from '#shared/utils/lyrics'
import type { Extraction } from '#shared/utils/lyrics'

const emit = defineEmits<{ created: [job: Extraction] }>()
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const replaceButton = useTemplateRef<HTMLButtonElement>('replaceButton')
const youtubeInput = useTemplateRef<HTMLInputElement>('youtubeInput')
const selectedFile = shallowRef<File>()
const source = ref<'original' | 'vocals'>('vocals')
const youtubeUrl = ref('')
const settingsOpen = ref(false)
const dragging = ref(false)
const checking = ref(false)
const uploadedBytes = ref(0)
const fileError = ref('')
const youtubeError = ref('')
const busy = computed(() => checking.value)

const sizeFormatter = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 })
function formatBytes(bytes: number) {
  return bytes < 1_000_000
    ? `${sizeFormatter.format(bytes / 1_000)} KB`
    : `${sizeFormatter.format(bytes / 1_000_000)} MB`
}
const fileSize = computed(() => formatBytes(selectedFile.value?.size ?? 0))

function selectFile(file?: File) {
  if (!file || busy.value) return

  fileError.value = ''
  selectedFile.value = undefined

  if (!/\.(mp3|wav|m4a)$/i.test(file.name)) {
    fileError.value = 'Pilih file MP3, WAV, atau M4A.'
    return
  }

  if (file.size > 100_000_000 || file.size === 0) {
    fileError.value = file.size === 0 ? 'File audio kosong.' : 'Ukuran file melebihi 100 MB.'
    return
  }

  selectedFile.value = file
}

async function onFileChange(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  selectFile(input.files?.[0])
  input.value = ''

  if (selectedFile.value) {
    await nextTick()
    replaceButton.value?.focus()
  }
}

function onDragLeave(event: DragEvent) {
  const zone = event.currentTarget as HTMLElement
  if (!(event.relatedTarget instanceof Node) || !zone.contains(event.relatedTarget)) {
    dragging.value = false
  }
}

function onDrop(event: DragEvent) {
  dragging.value = false
  if (busy.value) return
  const files = event.dataTransfer?.files
  if (files && files.length > 1) {
    fileError.value = 'Pilih satu lagu untuk setiap proyek.'
    return
  }
  selectFile(files?.[0])
}

function upload(file: File) {
  return new Promise<Extraction>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', '/api/extractions')
    request.responseType = 'json'
    request.setRequestHeader('Content-Type', 'application/octet-stream')
    request.setRequestHeader('X-LyRex-Filename', encodeURIComponent(file.name))
    request.setRequestHeader('X-LyRex-Source', source.value)
    request.setRequestHeader('X-LyRex-YouTube', encodeURIComponent(youtubeUrl.value.trim()))
    request.upload.onprogress = event => { uploadedBytes.value = Math.min(file.size, event.loaded) }
    request.upload.onload = () => { uploadedBytes.value = file.size }
    request.onload = () => {
      if (request.status === 202 && request.response?.id) resolve(request.response)
      else reject(new Error(request.response?.data?.message || 'Audio gagal diunggah. Coba lagi.'))
    }
    request.onerror = () => reject(new Error('Koneksi unggahan terputus. Coba lagi.'))
    request.send(file)
  })
}

async function extractLyrics() {
  const file = selectedFile.value
  if (!file || busy.value) return

  fileError.value = ''
  youtubeError.value = ''

  if (youtubeUrl.value.trim() && !isYouTubeUrl(youtubeUrl.value.trim())) {
    youtubeError.value = 'Masukkan tautan video YouTube yang valid.'
    settingsOpen.value = true
    await nextTick()
    youtubeInput.value?.focus()
    return
  }

  uploadedBytes.value = 0
  checking.value = true
  try {
    const extraction = await upload(file)
    emit('created', extraction)
  } catch (error) {
    fileError.value = error instanceof Error ? error.message : 'Audio gagal diunggah. Coba lagi.'
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <section id="mulai" class="upload-card" aria-labelledby="upload-title">
    <form novalidate @submit.prevent="extractLyrics">
      <div class="upload-heading">
        <span class="upload-heading-icon" aria-hidden="true">
          <UIcon name="i-pixelarticons-audio-waveform" />
        </span>
        <div>
          <h2 id="upload-title">Unggah lagumu</h2>
          <p>Satu lagu per proyek. Maks. 10 menit dan 100 MB.</p>
        </div>
      </div>

      <input
        ref="fileInput"
        type="file"
        accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a"
        hidden
        :disabled="busy"
        @change="onFileChange"
      >
      <div
        class="upload-zone"
        :class="{ 'is-dragging': dragging, 'has-file': selectedFile }"
        @dragover.prevent="dragging = !busy"
        @dragleave="onDragLeave"
        @drop.prevent="onDrop"
      >
        <div v-if="selectedFile" class="selected-audio">
          <span class="file-icon" aria-hidden="true">
            <UIcon name="i-pixelarticons-music" />
          </span>
          <div class="selected-audio-name" aria-live="polite">
            <strong>{{ selectedFile.name }}</strong>
            <small>{{ fileSize }}</small>
          </div>
          <button ref="replaceButton" type="button" class="replace-button" :disabled="busy" @click="fileInput?.click()">
            Ganti file
          </button>
        </div>
        <button v-else type="button" class="upload-zone-button" :disabled="busy" @click="fileInput?.click()">
          <span class="file-icon" aria-hidden="true">
            <UIcon name="i-pixelarticons-upload" />
          </span>
          <strong><span>Pilih file audio</span> atau seret ke sini</strong>
          <span class="upload-formats">MP3, WAV, atau M4A</span>
        </button>
      </div>

      <p v-if="fileError" class="form-error" role="alert">{{ fileError }}</p>

      <div class="upload-controls">
        <fieldset class="extraction-mode" :disabled="busy">
          <legend>Mode ekstraksi</legend>
          <label>
            <input v-model="source" type="radio" value="vocals" name="extraction-source">
            <span><strong>Vokal saja</strong><small>Pisahkan vokal sebelum Web Speech.</small></span>
          </label>
          <label>
            <input v-model="source" type="radio" value="original" name="extraction-source">
            <span><strong>Audio asli</strong><small>Langsung siapkan audio untuk Web Speech.</small></span>
          </label>
        </fieldset>
        <button
          type="button"
          class="settings-toggle"
          :aria-expanded="settingsOpen"
          aria-controls="upload-settings"
          @click="settingsOpen = !settingsOpen"
        >
          <UIcon name="i-pixelarticons-sliders-horizontal" aria-hidden="true" />
          Pengaturan tambahan
          <UIcon name="i-pixelarticons-chevron-down" class="settings-chevron" aria-hidden="true" />
        </button>
        <div v-show="settingsOpen" id="upload-settings" class="settings-fields">
          <label for="youtube-reference">Tautan video YouTube <span>(opsional)</span></label>
          <input
            id="youtube-reference"
            ref="youtubeInput"
            v-model="youtubeUrl"
            type="url"
            :disabled="busy"
            placeholder="https://www.youtube.com/watch?v=…"
            :aria-invalid="youtubeError ? 'true' : undefined"
            :aria-describedby="youtubeError ? 'youtube-hint youtube-error' : 'youtube-hint'"
            @input="youtubeError = ''"
          >
          <p id="youtube-hint">Gunakan video sebagai referensi sinkronisasi.</p>
          <p v-if="youtubeError" id="youtube-error" class="form-error" role="alert">{{ youtubeError }}</p>
        </div>

        <UButton
          type="submit"
          class="action-button extract-button"
          :disabled="!selectedFile || busy"
          :loading="checking"
          icon="i-pixelarticons-zap"
        >
          Buat proyek
        </UButton>
      </div>

      <div v-if="checking && selectedFile" class="form-status upload-progress">
        <label for="upload-progress">
          {{ uploadedBytes < selectedFile.size ? 'Mengunggah audio' : 'Menunggu konfirmasi server' }}
        </label>
        <span>{{ formatBytes(uploadedBytes) }} / {{ fileSize }}</span>
        <progress id="upload-progress" :value="uploadedBytes" :max="selectedFile.size" />
      </div>
    </form>

  </section>
</template>

<style scoped>
.upload-progress { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .25rem .75rem; }
.upload-progress progress { width: 100%; accent-color: #587548; }
.extraction-mode { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: .45rem; min-width: 0; }
.extraction-mode legend { margin-bottom: .35rem; font-weight: 700; }
.extraction-mode label { display: flex; align-items: flex-start; gap: .5rem; min-height: 44px; padding: .5rem; border: 1px solid #dfd4b7; border-radius: .55rem; cursor: pointer; }
.extraction-mode label:has(input:checked) { background: #f9f2da; border-color: #a38b46; }
.extraction-mode input { margin-top: .25rem; accent-color: #587548; }
.extraction-mode small { display: block; font-size: .85rem; }
</style>
