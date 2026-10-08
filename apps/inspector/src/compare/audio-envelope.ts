export interface AudioEnvelope {
  step_ms: number;
  energy: number[];
  onset: number[];
}

/** 10 ms RMS bins and positive energy rise over the preceding 50 ms. */
export function analyzeAudio(channels: readonly Float32Array[], sampleRate: number): AudioEnvelope {
  const length = channels[0]?.length ?? 0;
  const step = Math.round(sampleRate / 100);
  const energy: number[] = [];
  let peak = 0;
  for (let start = 0; start < length; start += step) {
    const end = Math.min(length, start + step);
    let squares = 0;
    for (const channel of channels) {
      for (let i = start; i < end; i++) squares += (channel[i] as number) ** 2;
    }
    const rms = Math.sqrt(squares / ((end - start) * channels.length));
    energy.push(rms);
    peak = Math.max(peak, rms);
  }
  const onset: number[] = [];
  let onsetPeak = 0;
  for (let i = 0; i < energy.length; i++) {
    let previous = 0;
    for (let j = Math.max(0, i - 5); j < i; j++) previous += energy[j] as number;
    const rise = Math.max(0, (energy[i] as number) - previous / 5);
    onset.push(rise);
    onsetPeak = Math.max(onsetPeak, rise);
  }
  return {
    step_ms: (step / sampleRate) * 1000,
    energy: energy.map((value) => (peak ? value / peak : 0)),
    onset: onset.map((value) => (onsetPeak ? value / onsetPeak : 0)),
  };
}

export async function decodeEnvelope(bytes: ArrayBuffer): Promise<AudioEnvelope> {
  const context = new OfflineAudioContext(1, 1, 44_100);
  const decoded = await context.decodeAudioData(bytes);
  return analyzeAudio(
    Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i)),
    decoded.sampleRate,
  );
}
