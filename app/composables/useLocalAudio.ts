import { localAudio } from '~/utils/local-projects'
import type { AudioSource } from '~/utils/local-projects'
import type { Extraction } from '#shared/utils/lyrics'
import type { InjectionKey, ShallowRef } from 'vue'

type AudioAsset = { blob?: Blob, url: string }
const empty: AudioAsset = { url: '' }
const key: InjectionKey<Record<AudioSource, ShallowRef<AudioAsset>>> = Symbol('local-audio')

export function provideLocalAudio(job: ShallowRef<Extraction | undefined>) {
  const assets = { original: shallowRef(empty), vocals: shallowRef(empty) }
  provide(key, assets)
  for (const source of ['original', 'vocals'] as const) {
    watch(() => job.value && (source === 'original' ? job.value.durationMs : job.value.hasVocals) ? job.value.id : undefined,
      async (id, _, cleanup) => {
        let cancelled = false
        let url = ''
        cleanup(() => {
          cancelled = true
          if (url) URL.revokeObjectURL(url)
          assets[source].value = empty
        })
        if (!id) return
        const blob = await localAudio(id, source).catch(error => {
          console.error('[LyRex] Gagal membuka audio proyek', error)
        })
        if (cancelled || !blob) return
        url = URL.createObjectURL(blob)
        assets[source].value = { blob, url }
      })
  }
}

export function useLocalAudio(source: Ref<AudioSource>) {
  const assets = inject(key)
  return computed(() => assets?.[source.value].value ?? empty)
}
