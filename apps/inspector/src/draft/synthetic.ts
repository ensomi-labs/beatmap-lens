/**
 * The built-in synthetic demo: a generated track with a known answer, so the Draft workspace can
 * be tried and tested without a local file or a model. Its draft is a mock, badged as such: a
 * steady 120 BPM grid that misses the track's phase reset at 14 s and a few beats near the end.
 */
import type { Beat, DraftAudio, ProviderInfo, SoundAnchor } from "./ensomi-contract.ts";

export const demoSampleRate = 44_100;
export const demoDurationS = 24;
export const demoTitle = "Synthetic demo (generated)";

interface DemoHit {
  t: number;
  kind: "kick" | "hat" | "tick";
}

/** The track's own events: what a perfect listener would hear. */
export function demoHits(): DemoHit[] {
  const hits: DemoHit[] = [];
  for (let t = 0.5; t < 14; t += 0.5) {
    hits.push({ t, kind: "kick" });
    if (t < 9 || t >= 11) hits.push({ t: t + 0.25, kind: "hat" });
  }
  for (let beat = 9; beat < 11; beat += 0.5)
    for (const third of [1, 2]) hits.push({ t: beat + (third * 0.5) / 3, kind: "tick" });
  for (let t = 14.19; t < 20; t += 0.5) {
    hits.push({ t, kind: "kick" });
    hits.push({ t: t + 0.25, kind: "hat" });
  }
  for (let t = 20.12; t < demoDurationS - 0.3; t += 60 / 132) hits.push({ t, kind: "kick" });
  return hits.sort((a, b) => a.t - b.t);
}

export function demoPcm(sampleRate = demoSampleRate): Float32Array {
  const out = new Float32Array(Math.round(demoDurationS * sampleRate));
  let seed = 1;
  const noise = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };
  for (const hit of demoHits()) {
    const start = Math.round(hit.t * sampleRate);
    const length = Math.round((hit.kind === "kick" ? 0.18 : 0.05) * sampleRate);
    for (let i = 0; i < length && start + i < out.length; i++) {
      const s = i / sampleRate;
      const value =
        hit.kind === "kick"
          ? 0.8 * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-s / 0.02)) * s) * Math.exp(-s / 0.05)
          : (hit.kind === "hat" ? 0.25 : 0.35) * noise() * Math.exp(-s / 0.008);
      out[start + i] = (out[start + i] as number) + value;
    }
  }
  return out;
}

export function demoAudio(path: string | null = null): DraftAudio {
  return {
    path,
    title: demoTitle,
    durationS: demoDurationS,
    sampleRate: demoSampleRate,
    channels: 1,
    codec: "pcm_f32le",
  };
}

export const demoProviders: { beats: ProviderInfo; sounds: ProviderInfo } = {
  beats: { kind: "mock", name: "synthetic demo (generated, no model)" },
  sounds: { kind: "mock", name: "synthetic demo onsets", experimental: true },
};

export function demoBeats(): Beat[] {
  const beats: Beat[] = [];
  let index = 0;
  for (let t = 0.5; t < 20; t += 0.5) {
    const doubtful = t >= 14 && t < 16;
    beats.push({ id: `d${index++}`, t, source: "import", version: 1, conf: doubtful ? 0.3 : 0.9 });
  }
  const step = 60 / 132;
  for (let k = 0; 20.12 + k * step < demoDurationS - 0.3; k++) {
    if (k >= 3 && k <= 5) continue;
    beats.push({ id: `d${index++}`, t: 20.12 + k * step, source: "import", version: 1, conf: 0.8 });
  }
  return beats;
}

export function demoSounds(): SoundAnchor[] {
  const emphasis = { kick: 1, tick: 0.5, hat: 0.35 };
  return demoHits().map((hit, index) => ({
    id: `s${index}`,
    t: hit.t,
    emphasis: emphasis[hit.kind],
    source: "import",
    version: 1,
    experimental: true,
  }));
}

/** 16-bit PCM WAV bytes of the given channels. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const frames = channels[0]?.length ?? 0;
  const bytes = new Uint8Array(44 + frames * channels.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * 2, true);
  view.setUint16(32, channels.length * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * channels.length * 2, true);
  for (let frame = 0; frame < frames; frame++)
    channels.forEach((data, channel) => {
      const value = Math.max(-1, Math.min(1, data[frame] as number));
      view.setInt16(44 + (frame * channels.length + channel) * 2, Math.round(value * 32767), true);
    });
  return bytes;
}
