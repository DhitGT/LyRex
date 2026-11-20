<script setup lang="ts">
import type { Extraction } from '#shared/utils/lyrics'

const props = defineProps<{ job: Extraction, active: boolean }>()
const source = ref<'original' | 'vocals'>(props.job.hasVocals ? 'vocals' : 'original')
const audioAsset = useLocalAudio(source)
const audioUrl = computed(() => audioAsset.value.url)
</script>

<template>
  <p v-if="!job.durationMs" class="studio-description">Audio bisa diputar setelah selesai disiapkan.</p>
  <div v-else class="studio-audio">
    <div v-if="job.hasVocals" class="studio-actions" role="group" aria-label="Sumber audio">
      <UButton v-for="item in [{ id: 'original', label: 'Audio asli' }, { id: 'vocals', label: 'Vokal saja' }] as const"
        :key="item.id" :variant="source === item.id ? 'solid' : 'outline'" :aria-pressed="source === item.id"
        color="neutral" @click="source = item.id">{{ item.label }}</UButton>
    </div>
    <p class="studio-description">{{ job.hasVocals
      ? 'Ganti sumber untuk membandingkan audio di posisi putar yang sama.'
      : 'Dengarkan rekaman asli yang tersimpan di proyek.' }}</p>
    <AudioWaveform :src="audioUrl" :pcm="audioAsset.blob" :label="source === 'vocals' ? 'Stem vokal' : 'Audio asli'"
      :duration-ms="job.durationMs" :active="active" :show-pitch="source === 'vocals'" />
    <div class="studio-actions">
      <UButton :href="audioUrl" :download="`${job.name.replace(/\.[^.]+$/, '')}-${source}.wav`"
        variant="outline" color="neutral" icon="i-lucide-download">Unduh {{ source === 'vocals' ? 'stem vokal' : 'audio asli' }}</UButton>
      <UButton v-if="job.youtubeUrl" :href="job.youtubeUrl" target="_blank" rel="noopener noreferrer" variant="outline" color="neutral">
        Buka video referensi
      </UButton>
    </div>
  </div>
</template>
