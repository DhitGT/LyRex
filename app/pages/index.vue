<script setup lang="ts">
import { exportLyrics, lyricFormats } from '#shared/utils/lyrics'
import type { LyricFormat } from '#shared/utils/lyrics'
import cassette from '~/assets/images/lyrex-cassette.webp'
import landscape from '~/assets/images/lyrex-landscape.webp'
import mascot from '~/assets/images/lyrex-mascot.webp'

useSeoMeta({
  title: 'LyRex | Ubah lagu jadi lirik bertimestamp',
  description: 'Unggah lagu, tinjau draft lirik dengan waktu per baris, lalu gunakan hasilnya untuk lirik sinkron, subtitle, atau integrasi.'
})

const steps = [
  {
    title: 'Unggah audio',
    icon: 'i-pixelarticons-upload',
    description: 'Pilih MP3, WAV, atau M4A dari rekaman yang boleh kamu olah.'
  },
  {
    title: 'Tinjau lirik dan timing',
    icon: 'i-pixelarticons-audio-waveform',
    description: 'Dengarkan vokal, lalu koreksi teks dan waktu tiap baris.'
  },
  {
    title: 'Ekspor lirik',
    icon: 'i-pixelarticons-download',
    description: 'Simpan sebagai LRC untuk lirik sinkron, SRT untuk subtitle, atau JSON untuk integrasi.'
  }
]

const sample = [
  { startMs: 8_200, endMs: 11_680, text: 'Langit pelan berubah warna' },
  { startMs: 12_040, endMs: 15_720, text: 'Kita berjalan tanpa rencana' },
  { startMs: 16_000, endMs: 19_800, text: 'Biar malam simpan cerita' }
]

const format = ref<LyricFormat>('LRC')
const motionPaused = ref(false)
const motionAction = computed(() => motionPaused.value ? 'Lanjutkan animasi' : 'Jeda animasi')

const sampleExport = computed(() => exportLyrics(sample, format.value))

const sampleDownload = computed(() => {
  const type = format.value === 'JSON' ? 'application/json' : 'text/plain'
  return `data:${type};charset=utf-8,${encodeURIComponent(sampleExport.value + '\n')}`
})
</script>

<template>
  <a class="skip-link" href="#konten">Langsung ke konten</a>

  <header id="atas" class="site-header">
    <div class="page-width header-inner">
      <a class="brand" href="#atas" aria-label="LyRex, kembali ke atas">
        <span class="brand-mark" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span>LyRex<span class="brand-period">.</span></span>
      </a>
      <nav class="header-nav" aria-label="Navigasi utama">
        <a href="#cara-kerja">Cara kerja</a>
        <a href="#contoh">Contoh hasil</a>
      </nav>
      <UButton to="/studio" class="header-button">Buka Studio</UButton>
    </div>
  </header>

  <main id="konten" tabindex="-1">
    <section
      class="hero"
      aria-labelledby="hero-title"
      :data-motion-paused="motionPaused ? 'true' : undefined"
      :style="{ '--hero-landscape': `url(${landscape})` }"
    >
      <div class="hero-sky" aria-hidden="true">
        <span class="pixel-cloud pixel-cloud-near" />
        <span class="pixel-cloud pixel-cloud-far" />
      </div>
      <div class="hero-inner page-width">
        <div class="hero-copy">
          <h1 id="hero-title">Ubah lagu jadi <span>lirik bertimestamp</span></h1>
          <p>Mulai dari draft lirik dengan waktu per baris. Tinjau sambil mendengarkan vokal, lalu ekspor untuk lirik sinkron atau subtitle.</p>
          <UButton to="/studio" icon="i-pixelarticons-audio-waveform" class="action-button hero-cta">Buka Studio</UButton>
        </div>
        <div class="hero-art">
          <span class="sprite-shadow cassette-shadow" aria-hidden="true" />
          <span class="sprite-shadow mascot-shadow" aria-hidden="true" />
          <img :src="cassette" class="hero-cassette" width="900" height="600" alt="">
          <img :src="mascot" class="hero-mascot" width="560" height="560" alt="Maskot radio pixel LyRex" fetchpriority="high">
          <UIcon name="i-pixelarticons-music" class="pixel-note pixel-note-first" aria-hidden="true" />
          <UIcon name="i-pixelarticons-music" class="pixel-note pixel-note-second" aria-hidden="true" />
        </div>
      </div>
      <button
        type="button"
        class="hero-motion"
        :aria-label="motionAction"
        :title="motionAction"
        @click="motionPaused = !motionPaused"
      >
        <UIcon v-if="motionPaused" name="i-pixelarticons-play" aria-hidden="true" />
        <UIcon v-else name="i-pixelarticons-pause" aria-hidden="true" />
      </button>
    </section>

    <section id="cara-kerja" class="pixel-band process-section" aria-labelledby="process-title">
      <div class="page-width">
        <h2 id="process-title" class="section-title">Dari lagu ke lirik sinkron</h2>
        <ol class="step-grid">
          <li v-for="step in steps" :key="step.title" class="step-card">
            <span class="step-icon" aria-hidden="true"><UIcon :name="step.icon" /></span>
            <h3>{{ step.title }}</h3>
            <p>{{ step.description }}</p>
          </li>
        </ol>
      </div>
    </section>

    <section id="contoh" class="pixel-band example-section" aria-labelledby="example-title">
      <div class="page-width example-layout">
        <div class="example-copy">
          <h2 id="example-title" class="section-title">Lirik yang siap kamu pakai</h2>
          <p>Lihat bagaimana potongan lirik yang sama tampil sebagai LRC, SRT, dan JSON.</p>
          <a class="example-download" :href="sampleDownload" :download="`contoh-lyrex.${format.toLowerCase()}`">
            <UIcon name="i-pixelarticons-download" aria-hidden="true" />
            Unduh contoh {{ format }}
          </a>
        </div>
        <div class="example-panel">
          <div class="example-toolbar">
            <span>Contoh ekspor</span>
            <div class="format-options" role="group" aria-label="Format contoh lirik">
              <button
                v-for="option in lyricFormats"
                :key="option"
                type="button"
                :aria-pressed="format === option"
                @click="format = option"
              >{{ option }}</button>
            </div>
          </div>
          <pre aria-label="Isi contoh ekspor" tabindex="0"><code>{{ sampleExport }}</code></pre>
        </div>
      </div>
    </section>
  </main>

  <footer class="pixel-band site-footer">
    <div class="page-width footer-inner">
      <a class="brand footer-brand" href="#atas" aria-label="LyRex, kembali ke atas">
        <span class="brand-mark" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span>LyRex<span class="brand-period">.</span></span>
      </a>
      <p>Untuk kreator dan developer yang bekerja dengan audio.</p>
    </div>
  </footer>
</template>
