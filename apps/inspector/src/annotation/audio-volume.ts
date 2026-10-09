export const DEFAULT_AUDIO_VOLUME = 0.8;
export const AUDIO_VOLUME_PREFERENCE_KEY = "beatmap-lens.inspector.audio-volume";

export function normalizeAudioVolume(volume = DEFAULT_AUDIO_VOLUME): number {
  return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : DEFAULT_AUDIO_VOLUME;
}
