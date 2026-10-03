export function measureAudioSamples(samples) {
  let squares = 0;
  let peak = 0;
  for (const sample of samples) {
    squares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return { rms: Math.sqrt(squares / samples.length), peak };
}
