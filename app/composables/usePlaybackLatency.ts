export function usePlaybackLatency() {
  return useState('lyrex-earphone-offset', () => 0)
}

export function useLatencyTestRunning() {
  return useState('lyrex-latency-test-running', () => false)
}
