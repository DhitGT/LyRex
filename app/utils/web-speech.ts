import type { LyricLine } from '#shared/utils/lyrics'
import { waveformBinCount } from '#shared/utils/waveform'
import { speechWindows, timeSpeechPhrases } from './speech-timing'
import type { SpeechPhrase, SpeechWindow } from './speech-timing'

interface SpeechResult {
  isFinal: boolean
  0?: { transcript: string }
}

interface BrowserRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onaudiostart: (() => void) | null
  onspeechstart: (() => void) | null
  onspeechend: (() => void) | null
  onresult: ((event: { resultIndex: number, results: ArrayLike<SpeechResult> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(track: MediaStreamTrack): void
  stop(): void
  abort(): void
}

type Recognition = new () => BrowserRecognition

export const speechSampleRate = 16_000
export type SpeechChannel = 'mix' | 'left' | 'right'
export type SpeechEqPreset = 'off' | 'clarity' | 'high-register'

export function browserSpeech() {
  if (typeof window === 'undefined' || !window.isSecureContext || !window.AudioContext) return undefined
  const agent = navigator.userAgent
  const chrome = /(?:Chrome|Chromium)\/(\d+)/.exec(agent)
  const firefox = /Firefox\/(\d+)/.exec(agent)
  // Older implementations can ignore the track argument and open the microphone.
  const supportsTrack = Number(chrome?.[1] ?? 0) >= 135 || Number(firefox?.[1] ?? 0) >= 160
  if (!supportsTrack || /Android|iPhone|iPad|Mobile/i.test(agent)) return undefined
  const api = window as Window & { SpeechRecognition?: Recognition, webkitSpeechRecognition?: Recognition }
  return api.SpeechRecognition || api.webkitSpeechRecognition
}

function recognitionError(code: string) {
  switch (code) {
    case 'network': return 'Layanan Web Speech tidak dapat dihubungi. Periksa koneksi lalu coba lagi.'
    case 'not-allowed':
    case 'service-not-allowed': return 'Browser tidak mengizinkan Web Speech dari file. Coba Chrome desktop terbaru.'
    case 'language-not-supported': return 'Web Speech di browser ini tidak mendukung bahasa yang dipilih.'
    case 'audio-capture': return 'Browser gagal membaca track dari file audio.'
    default: return 'Pengenalan suara terputus. Coba jalankan kembali.'
  }
}

function speechInput(context: BaseAudioContext, destination: AudioNode, eq: SpeechEqPreset): AudioNode {
  if (eq === 'off') return destination

  const mono = context.createGain()
  mono.channelCount = 1
  mono.channelCountMode = 'explicit'
  mono.channelInterpretation = 'speakers'
  // Leave headroom for the presence boost.
  mono.gain.value = 10 ** (-3 / 20)

  const highpass = context.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = eq === 'high-register' ? 220 : 100
  highpass.Q.value = -3

  const presence = context.createBiquadFilter()
  presence.type = 'peaking'
  presence.frequency.value = 2_800
  presence.Q.value = 0.85
  presence.gain.value = 3

  mono.connect(highpass)
  if (eq === 'high-register') {
    const lowShelf = context.createBiquadFilter()
    lowShelf.type = 'lowshelf'
    lowShelf.frequency.value = 420
    lowShelf.gain.value = -5
    highpass.connect(lowShelf).connect(presence)
  } else {
    highpass.connect(presence)
  }
  presence.connect(destination)
  return mono
}

export async function loadSpeechAudio(context: BaseAudioContext, url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error('File audio tidak dapat dimuat.')
  const audio = await context.decodeAudioData(await response.arrayBuffer())
  signal.throwIfAborted()
  return audio
}

function connectSpeechChannel(context: BaseAudioContext, player: AudioBufferSourceNode, input: AudioNode,
  channel: SpeechChannel) {
  if (channel === 'mix' || (player.buffer?.numberOfChannels ?? 0) < 2) {
    player.connect(input)
    return
  }

  const splitter = context.createChannelSplitter(2)
  player.connect(splitter)
  splitter.connect(input, channel === 'left' ? 0 : 1)
  return splitter
}

export async function previewSpeechAudio(url: string, channel: SpeechChannel, eq: SpeechEqPreset, signal: AbortSignal) {
  const audio = await loadSpeechAudio(new OfflineAudioContext(1, 1, speechSampleRate), url, signal)
  const context = new OfflineAudioContext(1, audio.length, speechSampleRate)
  const player = context.createBufferSource()
  player.buffer = audio
  const splitter = connectSpeechChannel(context, player, speechInput(context, context.destination, eq), channel)
  player.start()
  const rendered = await context.startRendering().finally(() => splitter?.disconnect())
  signal.throwIfAborted()

  const samples = rendered.getChannelData(0)
  const durationMs = rendered.duration * 1_000
  const peaks = new Uint8Array(waveformBinCount(durationMs))
  const wav = new ArrayBuffer(44 + samples.length * 2)
  const bytes = new Uint8Array(wav)
  const header = new DataView(wav)
  const encoder = new TextEncoder()
  bytes.set(encoder.encode('RIFF'), 0)
  header.setUint32(4, wav.byteLength - 8, true)
  bytes.set(encoder.encode('WAVEfmt '), 8)
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, 1, true)
  header.setUint32(24, speechSampleRate, true)
  header.setUint32(28, speechSampleRate * 2, true)
  header.setUint16(32, 2, true)
  header.setUint16(34, 16, true)
  bytes.set(encoder.encode('data'), 36)
  header.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!
    const bounded = Math.max(-1, Math.min(1, sample))
    header.setInt16(44 + index * 2, Math.round(bounded * 32_767), true)
    const bin = Math.floor(index * peaks.length / samples.length)
    const peak = Math.round(Math.abs(bounded) * 255)
    if (peak > peaks[bin]!) peaks[bin] = peak
  }
  return { blob: new Blob([wav], { type: 'audio/wav' }), waveform: { durationMs, peaks: Array.from(peaks) } }
}

type TranscriptUpdate = (confirmed: string, interim: string) => void

function recognizeSegment(Recognition: Recognition, context: AudioContext, buffer: AudioBuffer, language: string, eq: SpeechEqPreset,
  channel: SpeechChannel, window: SpeechWindow, signal: AbortSignal,
  onProgress: (ms: number) => void, onTranscript: TranscriptUpdate) {
  return new Promise<{ lines: LyricLine[], playedMs: number, noSpeech: boolean }>((resolve, reject) => {
    const { fromMs, toMs } = window
    const destination = context.createMediaStreamDestination()
    destination.channelCount = 1
    const track = destination.stream.getAudioTracks()[0]
    if (!track) {
      reject(new Error('Track audio gagal disiapkan.'))
      return
    }
    const player = context.createBufferSource()
    player.buffer = buffer
    const input = speechInput(context, destination, eq)
    const splitter = connectSpeechChannel(context, player, input, channel)
    const recognition = new Recognition()
    recognition.lang = language
    recognition.continuous = true
    recognition.interimResults = true
    const phrases: SpeechPhrase[] = []
    const interimStarts = new Map<number, NonNullable<SpeechPhrase['firstInterim']>>()
    let started: number | undefined
    let speechStartMs: number | undefined
    let speechEndMs: number | undefined
    let finished = false
    let sourceEnded = false
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    let noSpeech = false

    const position = () => started === undefined ? fromMs : Math.min(toMs, fromMs + Math.round((context.currentTime - started) * 1_000))
    const ticker = setInterval(() => onProgress(position()), 300)
    const deadline = setTimeout(() => finish(new Error('Web Speech terlalu lama merespons. Coba lagi.')), toMs - fromMs + 25_000)
    const cancel = () => finish(new DOMException('Dibatalkan', 'AbortError'))

    function finish(error?: Error) {
      if (finished) return
      finished = true
      const playedMs = sourceEnded ? toMs : position()
      clearInterval(ticker)
      clearTimeout(deadline)
      clearTimeout(stopTimer)
      signal.removeEventListener('abort', cancel)
      recognition.onend = null
      recognition.onerror = null
      player.onended = null
      if (error) {
        try { recognition.abort() } catch {}
      }
      if (started !== undefined && !sourceEnded) player.stop()
      player.disconnect()
      splitter?.disconnect()
      if (input !== destination) input.disconnect()
      track!.stop()
      if (error) reject(error)
      else resolve({
        lines: timeSpeechPhrases(phrases, { startMs: Math.max(fromMs, window.startMs), endMs: Math.min(playedMs, window.endMs) }),
        playedMs, noSpeech
      })
    }

    recognition.onaudiostart = () => {
      if (finished || started !== undefined) return
      try {
        const now = context.currentTime
        player.start(now, fromMs / 1_000, (toMs - fromMs) / 1_000)
        started = now
      } catch {
        finish(new Error('Track audio gagal diputar di browser.'))
      }
    }
    recognition.onspeechstart = () => {
      speechStartMs = position()
      speechEndMs = undefined
    }
    recognition.onspeechend = () => { speechEndMs = position() }
    recognition.onresult = event => {
      if (finished || started === undefined) return
      for (const index of interimStarts.keys()) {
        if (index >= event.results.length) interimStarts.delete(index)
      }
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]
        const text = result?.[0]?.transcript.replace(/\s+/g, ' ').trim()
        if (!text) continue
        if (!result?.isFinal) {
          if (!interimStarts.has(index)) {
            interimStarts.set(index, { atMs: position(), wordCount: text.split(' ').length })
          }
          continue
        }
        phrases.push({ text, speechStartMs, speechEndMs, firstInterim: interimStarts.get(index) })
        interimStarts.delete(index)
        speechStartMs = undefined
        speechEndMs = undefined
      }
      const interim: string[] = []
      for (let index = 0; index < event.results.length; index++) {
        const result = event.results[index]
        const text = result?.[0]?.transcript.trim()
        if (!result?.isFinal && text) interim.push(text)
      }
      onTranscript(phrases.map(phrase => phrase.text).join('\n'), interim.join(' '))
    }
    recognition.onerror = event => {
      if (event.error === 'no-speech') {
        noSpeech = true
        return
      }
      finish(new Error(recognitionError(event.error)))
    }
    recognition.onend = () => {
      if (started === undefined && !noSpeech) finish(new Error('Browser tidak menerima track audio dari file.'))
      else finish()
    }
    player.onended = () => {
      sourceEnded = true
      stopTimer = setTimeout(() => { if (!finished) recognition.stop() }, 800)
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      recognition.start(track)
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Web Speech gagal dimulai.'))
    }
  })
}

export async function transcribeWithBrowser(context: AudioContext, url: string, language: 'id' | 'en', durationMs: number,
  eq: SpeechEqPreset, channel: SpeechChannel, isVocalStem: boolean, signal: AbortSignal,
  onProgress: (percent: number, message: string) => void, onTranscript: TranscriptUpdate,
  checkpoint?: { lines: LyricLine[], processedMs: number, save: (lines: LyricLine[], processedMs: number) => Promise<void> }) {
  const Recognition = browserSpeech()
  if (!Recognition) throw new Error('Buka LyRex di Chrome desktop terbaru untuk menyalin audio dari file.')
  const audio = await loadSpeechAudio(context, url, signal)
  onProgress(0, 'Mendeteksi jeda pada audio')
  const windows = await speechWindows(audio, durationMs, channel, isVocalStem, signal)
  const lines = [...(checkpoint?.lines ?? [])]
  const resumeAt = checkpoint?.processedMs ?? 0
  let reachedMs = resumeAt
  function progress(ms: number) {
    reachedMs = Math.max(reachedMs, ms)
    onProgress(Math.min(99, Math.floor(reachedMs * 100 / durationMs)),
      `Web Speech memproses ${Math.floor(reachedMs / 1_000)} dari ${Math.ceil(durationMs / 1_000)} detik audio`)
  }
  for (const window of windows) {
    if (window.endMs <= resumeAt) continue
    let fromMs = Math.max(window.fromMs, resumeAt)
    let stalled = 0
    while (fromMs < window.endMs) {
      signal.throwIfAborted()
      progress(fromMs)
      const confirmed = lines.map(line => line.text).join('\n')
      const result = await recognizeSegment(Recognition, context, audio, language === 'en' ? 'en-US' : 'id-ID', eq, channel,
        { ...window, fromMs }, signal, progress, (segment, interim) => {
          onTranscript([confirmed, segment].filter(Boolean).join('\n'), interim)
        })
      lines.push(...result.lines)
      onTranscript(lines.map(line => line.text).join('\n'), '')
      if (result.playedMs >= window.endMs) break
      // Browser recognition can end during a clip. Resume from the same source clock.
      if (result.playedMs >= fromMs + 150 || result.lines.length) {
        fromMs = result.playedMs
        stalled = 0
      } else if (result.noSpeech || ++stalled === 2) {
        break
      }
    }
    if (checkpoint) await checkpoint.save(lines, window.endMs)
  }
  return { lines, audio }
}
