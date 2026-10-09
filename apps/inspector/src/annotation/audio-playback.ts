import type { ParsedOsu } from "beatmap-lens";
import { AUDIO_VOLUME_PREFERENCE_KEY, normalizeAudioVolume } from "./audio-volume";
import type { CatalogTask } from "./catalog";
import { MediaPlaybackClock } from "./media-playback-clock";
import {
  type PlaybackClock,
  type PlaybackClockListener,
  type PlaybackClockState,
  type PlaybackFrameScheduler,
  type PlaybackSelection,
  SyntheticPlaybackClock,
} from "./playback-clock";
import { type PlaybackRate, resolvePlaybackRate } from "./playback-rate";

export const MUSIC_PREFERENCE_KEY = "beatmap-lens.inspector.music-enabled";
export const AUDIO_OFFSET_PREFERENCE_KEY = "beatmap-lens.inspector.audio-offset-ms";

export interface BeatmapAudioFileContext {
  readonly osuFile: FileSystemFileHandle;
  readonly osuDirectory: FileSystemDirectoryHandle;
  readonly audioFilename?: string;
}

export function audioFilenameFromParsedOsu(parsed: ParsedOsu): string | undefined {
  return [...parsed.properties]
    .reverse()
    .find(
      (property) =>
        property.section.toLowerCase() === "general" &&
        property.key.toLowerCase() === "audiofilename",
    )
    ?.value.trim();
}

export async function createBeatmapAudioFileContext(
  corpus: FileSystemDirectoryHandle,
  task: CatalogTask,
  parsed: ParsedOsu,
): Promise<BeatmapAudioFileContext> {
  if (task.pathSegments.length === 0) {
    throw new TypeError("Catalog task must point to a file.");
  }

  let osuDirectory = corpus;
  for (const segment of task.pathSegments.slice(0, -1)) {
    osuDirectory = await osuDirectory.getDirectoryHandle(segment);
  }
  const filename = task.pathSegments.at(-1);
  if (!filename) throw new TypeError("Catalog task must point to a file.");

  const audioFilename = audioFilenameFromParsedOsu(parsed);
  return {
    ...(audioFilename ? { audioFilename } : {}),
    osuDirectory,
    osuFile: await osuDirectory.getFileHandle(filename),
  };
}

export type AudioPlaybackStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "missing" | "unsupported" | "rejected"; readonly message: string };

export interface AudioPlaybackControllerState {
  readonly audioOffsetMs: number;
  readonly audioVolume: number;
  readonly musicEnabled: boolean;
  readonly status: AudioPlaybackStatus;
}

export type AudioPlaybackControllerListener = (state: AudioPlaybackControllerState) => void;

export interface MusicPreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AudioPlaybackControllerOptions {
  readonly scheduler?: PlaybackFrameScheduler;
  readonly preferenceStore?: MusicPreferenceStore;
  readonly createMedia?: (url: string) => HTMLAudioElement;
  readonly createObjectUrl?: (file: File) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

export async function resolveBeatmapAudioFile(
  context: BeatmapAudioFileContext,
): Promise<File | undefined> {
  if (!context.audioFilename) return undefined;

  const path = context.audioFilename.replaceAll("\\", "/").split("/").filter(Boolean);
  const filename = path.at(-1);
  if (!filename) return undefined;

  let directory = context.osuDirectory;
  for (const segment of path.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(segment);
  }

  const handle = await directory.getFileHandle(filename);
  return handle.getFile();
}

export class AudioPlaybackController implements PlaybackClock {
  readonly #syntheticClock: SyntheticPlaybackClock;
  readonly #audioListeners = new Set<AudioPlaybackControllerListener>();
  readonly #clockListeners = new Set<PlaybackClockListener>();
  readonly #preferenceStore: MusicPreferenceStore | undefined;
  readonly #createMedia: (url: string) => HTMLAudioElement;
  readonly #createObjectUrl: (file: File) => string;
  readonly #revokeObjectUrl: (url: string) => void;
  readonly #scheduler: PlaybackFrameScheduler | undefined;

  #activeClock: PlaybackClock;
  #activeState: PlaybackClockState;
  #unsubscribeClock: () => void;
  #mediaClock: MediaPlaybackClock | undefined;
  #objectUrl: string | undefined;
  #loadId = 0;
  #intentId = 0;
  #musicEnabled: boolean;
  #audioOffsetMs: number;
  #audioVolume: number;
  #playbackRate: PlaybackRate = 1;
  #status: AudioPlaybackStatus = { kind: "idle" };
  #disposed = false;

  constructor(options: AudioPlaybackControllerOptions = {}) {
    this.#scheduler = options.scheduler;
    this.#preferenceStore = options.preferenceStore ?? browserPreferenceStore();
    this.#createMedia = options.createMedia ?? ((url) => new Audio(url));
    this.#createObjectUrl = options.createObjectUrl ?? ((file) => URL.createObjectURL(file));
    this.#revokeObjectUrl = options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    this.#musicEnabled = this.#preferenceStore?.getItem(MUSIC_PREFERENCE_KEY) === "on";
    this.#audioOffsetMs = parseAudioOffsetMs(
      this.#preferenceStore?.getItem(AUDIO_OFFSET_PREFERENCE_KEY) ?? null,
    );
    const volume = this.#preferenceStore?.getItem(AUDIO_VOLUME_PREFERENCE_KEY);
    this.#audioVolume = normalizeAudioVolume(volume == null ? undefined : Number(volume));
    this.#syntheticClock = new SyntheticPlaybackClock(options.scheduler);
    this.#activeClock = this.#syntheticClock;
    this.#activeState = clockState(this.#syntheticClock);
    this.#unsubscribeClock = this.#activeClock.subscribe((state) => {
      this.#activeState = state;
      this.#emitClock();
    });
  }

  get currentTimeMs(): number {
    return this.#activeClock.currentTimeMs;
  }

  get playing(): boolean {
    return this.#activeClock.playing;
  }

  get playbackRate(): PlaybackRate {
    return this.#playbackRate;
  }

  setPlaybackRate(rate: number): void {
    this.#playbackRate = resolvePlaybackRate(rate);
    this.#syntheticClock.setPlaybackRate(this.#playbackRate);
    this.#mediaClock?.setPlaybackRate(this.#playbackRate);
  }

  get musicEnabled(): boolean {
    return this.#musicEnabled;
  }

  get audioStatus(): AudioPlaybackStatus {
    return this.#status;
  }

  get audioVolume(): number {
    return this.#audioVolume;
  }

  get audioOffsetMs(): number {
    return this.#audioOffsetMs;
  }

  async loadBeatmapAudio(context: BeatmapAudioFileContext): Promise<void> {
    if (this.#disposed) return;
    const intentId = this.#nextIntent();
    const loadId = ++this.#loadId;
    this.#releaseMedia({ intentId, preservePlayback: true });

    if (!context.audioFilename) {
      this.#setStatus({ kind: "missing", message: "This beatmap has no AudioFilename." });
      return;
    }

    this.#setStatus({ kind: "loading" });

    let file: File;
    try {
      const resolved = await resolveBeatmapAudioFile(context);
      if (loadId !== this.#loadId || this.#disposed) return;
      if (!resolved) {
        this.#setStatus({ kind: "missing", message: "The beatmap audio file is missing." });
        return;
      }
      file = resolved;
    } catch (error) {
      if (loadId !== this.#loadId) return;
      this.#setStatus({ kind: "missing", message: errorMessage(error, "Audio file not found.") });
      return;
    }

    if (loadId !== this.#loadId || this.#disposed) return;

    let objectUrl: string;
    try {
      objectUrl = this.#createObjectUrl(file);
    } catch (error) {
      this.#setStatus({
        kind: "unsupported",
        message: errorMessage(error, "The browser cannot create an audio URL."),
      });
      return;
    }

    let media: HTMLAudioElement;
    try {
      media = this.#createMedia(objectUrl);
    } catch (error) {
      this.#revokeObjectUrl(objectUrl);
      this.#setStatus({
        kind: "unsupported",
        message: errorMessage(error, "The browser cannot load this audio file."),
      });
      return;
    }

    if (file.type && media.canPlayType(file.type) === "") {
      media.pause();
      this.#revokeObjectUrl(objectUrl);
      this.#setStatus({
        kind: "unsupported",
        message: `The browser does not support ${file.type} audio.`,
      });
      return;
    }

    this.#objectUrl = objectUrl;
    await this.#attachMedia(media);
  }

  async loadAudioUrl(url: string): Promise<void> {
    if (this.#disposed) return;
    const intentId = this.#nextIntent();
    this.#loadId++;
    this.#releaseMedia({ intentId, preservePlayback: true });
    this.#setStatus({ kind: "loading" });

    let media: HTMLAudioElement;
    try {
      media = this.#createMedia(url);
    } catch (error) {
      this.#setStatus({
        kind: "unsupported",
        message: errorMessage(error, "The browser cannot load this audio URL."),
      });
      return;
    }
    await this.#attachMedia(media);
  }

  async #attachMedia(media: HTMLAudioElement): Promise<void> {
    this.#mediaClock = new MediaPlaybackClock(
      media,
      this.#scheduler,
      (error) => {
        this.#handleMediaFailure(error);
      },
      this.#audioOffsetMs,
    );
    this.#mediaClock.setAudioVolume(this.#audioVolume);
    this.#mediaClock.setPlaybackRate(this.#playbackRate);
    this.#setStatus({ kind: "ready" });

    if (this.#musicEnabled) {
      const switchIntentId = this.#nextIntent();
      await this.#switchToMedia(switchIntentId);
    }
  }

  clearSession(): void {
    const intentId = this.#nextIntent();
    this.#loadId++;
    this.#releaseMedia({ intentId, preservePlayback: false });
    this.#syntheticClock.pause();
    this.#syntheticClock.seek(0);
    this.#followClock(this.#syntheticClock);
    this.#setStatus({ kind: "idle" });
  }

  async setMusicEnabled(enabled: boolean): Promise<void> {
    const intentId = this.#nextIntent();
    this.#musicEnabled = enabled;
    this.#preferenceStore?.setItem(MUSIC_PREFERENCE_KEY, enabled ? "on" : "off");
    this.#emitAudio();

    if (!enabled) {
      if (this.#activeClock === this.#mediaClock) {
        await this.#switchToSynthetic(
          {
            ...this.#activeState,
            currentTimeMs: this.#activeClock.currentTimeMs,
            playing: this.#activeClock.playing,
          },
          intentId,
        );
      }
      return;
    }

    if (this.#mediaClock) {
      this.#setStatus({ kind: "ready" });
      await this.#switchToMedia(intentId);
    }
  }

  setAudioVolume(volume: number): void {
    this.#audioVolume = normalizeAudioVolume(volume);
    this.#preferenceStore?.setItem(AUDIO_VOLUME_PREFERENCE_KEY, String(this.#audioVolume));
    this.#mediaClock?.setAudioVolume(this.#audioVolume);
    this.#emitAudio();
  }

  setAudioOffsetMs(audioOffsetMs: number): void {
    this.#audioOffsetMs = normalizeAudioOffsetMs(audioOffsetMs);
    this.#preferenceStore?.setItem(AUDIO_OFFSET_PREFERENCE_KEY, String(this.#audioOffsetMs));
    this.#mediaClock?.setAudioOffsetMs(this.#audioOffsetMs);
    this.#emitAudio();
  }

  async play(): Promise<void> {
    const intentId = this.#nextIntent();
    const intent: PlaybackClockState = {
      currentTimeMs: this.currentTimeMs,
      playing: true,
      looping: false,
    };
    await this.#runWithAudioFallback(() => this.#activeClock.play(), intent, intentId);
  }

  pause(): void {
    this.#nextIntent();
    this.#activeClock.pause();
  }

  seek(timeMs: number): void {
    this.#nextIntent();
    this.#activeClock.seek(timeMs);
  }

  async playSelection(selection: PlaybackSelection): Promise<void> {
    const intentId = this.#nextIntent();
    const intent: PlaybackClockState = {
      currentTimeMs: selection.startMs,
      playing: true,
      looping: false,
      selection,
    };
    await this.#runWithAudioFallback(
      () => this.#activeClock.playSelection(selection),
      intent,
      intentId,
    );
  }

  async loopSelection(selection: PlaybackSelection): Promise<void> {
    const intentId = this.#nextIntent();
    const intent: PlaybackClockState = {
      currentTimeMs: selection.startMs,
      playing: true,
      looping: true,
      selection,
    };
    await this.#runWithAudioFallback(
      () => this.#activeClock.loopSelection(selection),
      intent,
      intentId,
    );
  }

  subscribe(listener: PlaybackClockListener): () => void {
    this.#clockListeners.add(listener);
    listener(this.#activeState);
    return () => this.#clockListeners.delete(listener);
  }

  subscribeAudio(listener: AudioPlaybackControllerListener): () => void {
    this.#audioListeners.add(listener);
    listener(this.#audioState());
    return () => this.#audioListeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;

    const intentId = this.#nextIntent();
    this.#disposed = true;
    this.#loadId++;
    this.#releaseMedia({ intentId, preservePlayback: false });
    this.#unsubscribeClock();
    this.#syntheticClock.dispose();
    this.#clockListeners.clear();
    this.#audioListeners.clear();
  }

  async #runWithAudioFallback(
    operation: () => Promise<void>,
    intent: PlaybackClockState,
    intentId: number,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (!this.#isCurrentIntent(intentId)) return;
      if (this.#activeClock !== this.#mediaClock) throw error;

      const fallbackState = { ...intent, currentTimeMs: this.#activeClock.currentTimeMs };
      this.#setStatus({
        kind: "rejected",
        message: errorMessage(error, "The browser rejected audio playback."),
      });
      await this.#switchToSynthetic(fallbackState, intentId);
    }
  }

  async #switchToMedia(intentId: number): Promise<void> {
    const mediaClock = this.#mediaClock;
    if (!mediaClock || this.#activeClock === mediaClock || !this.#isCurrentIntent(intentId)) return;

    const state = this.#activeState;
    this.#activeClock.pause();
    const currentTimeMs = this.#activeClock.currentTimeMs;
    mediaClock.pause();
    mediaClock.seek(currentTimeMs);
    if (!this.#isCurrentIntent(intentId) || this.#mediaClock !== mediaClock) return;

    this.#followClock(mediaClock);

    if (!state.playing) return;

    await this.#runWithAudioFallback(
      () => resumeClock(mediaClock, { ...state, currentTimeMs }),
      {
        ...state,
        currentTimeMs,
      },
      intentId,
    );
  }

  async #switchToSynthetic(state: PlaybackClockState, intentId: number): Promise<void> {
    if (!this.#isCurrentIntent(intentId)) return;

    if (this.#mediaClock) this.#mediaClock.pause();
    this.#syntheticClock.pause();
    this.#syntheticClock.seek(state.currentTimeMs);
    if (!this.#isCurrentIntent(intentId)) return;

    this.#followClock(this.#syntheticClock);

    if (!state.playing) return;

    await resumeClock(this.#syntheticClock, state);
    if (!this.#isCurrentIntent(intentId)) this.#syntheticClock.pause();
  }

  #followClock(clock: PlaybackClock): void {
    this.#unsubscribeClock();
    this.#activeClock = clock;
    this.#activeState = clockState(clock);
    this.#unsubscribeClock = clock.subscribe((state) => {
      this.#activeState = state;
      this.#emitClock();
    });
  }

  #releaseMedia(options: { readonly intentId: number; readonly preservePlayback: boolean }): void {
    const mediaClock = this.#mediaClock;
    if (mediaClock && this.#activeClock === mediaClock) {
      const state = { ...this.#activeState, currentTimeMs: mediaClock.currentTimeMs };
      mediaClock.pause();
      this.#syntheticClock.pause();
      this.#syntheticClock.seek(state.currentTimeMs);
      this.#followClock(this.#syntheticClock);

      if (options.preservePlayback && state.playing && this.#isCurrentIntent(options.intentId)) {
        void resumeClock(this.#syntheticClock, state).then(() => {
          if (!this.#isCurrentIntent(options.intentId)) this.#syntheticClock.pause();
        });
      }
    }

    mediaClock?.dispose();
    this.#mediaClock = undefined;

    if (this.#objectUrl) {
      this.#revokeObjectUrl(this.#objectUrl);
      this.#objectUrl = undefined;
    }
  }

  #handleMediaFailure(error: unknown): void {
    if (this.#disposed || !this.#mediaClock) return;

    const intentId = this.#nextIntent();
    this.#setStatus({
      kind: "rejected",
      message: errorMessage(error, "Audio playback failed."),
    });
    this.#releaseMedia({ intentId, preservePlayback: true });
  }

  #nextIntent(): number {
    this.#intentId++;
    return this.#intentId;
  }

  #isCurrentIntent(intentId: number): boolean {
    return !this.#disposed && intentId === this.#intentId;
  }

  #setStatus(status: AudioPlaybackStatus): void {
    this.#status = status;
    this.#emitAudio();
  }

  #audioState(): AudioPlaybackControllerState {
    return {
      audioOffsetMs: this.#audioOffsetMs,
      audioVolume: this.#audioVolume,
      musicEnabled: this.#musicEnabled,
      status: this.#status,
    };
  }

  #emitAudio(): void {
    const state = this.#audioState();
    for (const listener of this.#audioListeners) listener(state);
  }

  #emitClock(): void {
    for (const listener of this.#clockListeners) listener(this.#activeState);
  }
}

async function resumeClock(clock: PlaybackClock, state: PlaybackClockState): Promise<void> {
  let started: Promise<void>;
  if (!state.selection) started = clock.play();
  else if (state.looping) started = clock.loopSelection(state.selection);
  else started = clock.playSelection(state.selection);

  clock.seek(state.currentTimeMs);
  await started;
}

function clockState(clock: PlaybackClock): PlaybackClockState {
  return {
    currentTimeMs: clock.currentTimeMs,
    playing: clock.playing,
    looping: false,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function parseAudioOffsetMs(value: string | null): number {
  return normalizeAudioOffsetMs(Number(value));
}

function normalizeAudioOffsetMs(audioOffsetMs: number): number {
  return Number.isFinite(audioOffsetMs) ? audioOffsetMs : 0;
}

function browserPreferenceStore(): MusicPreferenceStore | undefined {
  if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") {
    return undefined;
  }
  return localStorage;
}
