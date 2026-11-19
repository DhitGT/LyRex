export function estimatePitch(samples: Float32Array, sampleRate: number, correlations: Float32Array) {
  const firstLag = Math.ceil(sampleRate / 650)
  const lastLag = Math.floor(sampleRate / 75)
  let best = 0.65
  for (let lag = firstLag; lag <= lastLag; lag++) {
    let product = 0
    let leftEnergy = 0
    let rightEnergy = 0
    for (let i = 0; i < samples.length - lastLag; i += 2) {
      const left = samples[i]!
      const right = samples[i + lag]!
      product += left * right
      leftEnergy += left * left
      rightEnergy += right * right
    }
    const similarity = product / Math.max(1e-9, Math.sqrt(leftEnergy * rightEnergy))
    correlations[lag] = similarity
    best = Math.max(best, similarity)
  }
  for (let lag = firstLag + 1; lag < lastLag; lag++) {
    const peak = correlations[lag]!
    if (peak >= best * 0.92 && peak >= 0.65 && peak >= correlations[lag - 1]! && peak > correlations[lag + 1]!) {
      const left = correlations[lag - 1]!
      const right = correlations[lag + 1]!
      return sampleRate / (lag + 0.5 * (right - left) / (2 * peak - left - right))
    }
  }
  return 0
}
