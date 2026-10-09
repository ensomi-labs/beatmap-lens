import { DEFAULT_AUDIO_VOLUME, normalizeAudioVolume } from "./audio-volume";
import {
  animationFrameScheduler,
  type PlaybackClock,
  type PlaybackClockListener,
  type PlaybackClockState,
  type PlaybackFrameScheduler,
  type PlaybackSelection,
} from "./playback-clock";
import { type PlaybackRate, resolvePlaybackRate } from "./playback-rate";

type SelectionPlayback = {
  readonly range: PlaybackSelection;
  readonly loop: boolean;
};

export type MediaPlaybackErrorListener = (error: unknown) => void;

export class MediaPlaybackClock implements PlaybackClock {
  readonly #media: HTMLAudioElement;
  readonly #scheduler: PlaybackFrameScheduler;
  readonly #listeners = new Set<PlaybackClockListener>();
  readonly #onMediaProgress = () => this.#update(this.#scheduler.now());
  readonly #onPlaybackError: MediaPlaybackErrorListener;
  readonly #onMediaError = () => this.#handleMediaError();

  #audioOffsetMs: number;
  #playbackRate: PlaybackRate = 1;
  #chartTimeMs = 0;
  #frameHandle: number | undefined;
  #lastFrameTimeMs = 0;
  #mediaResumePendingCommandId: number | undefined;
  #playing = false;
  #selectionPlayback: SelectionPlayback | undefined;
  #commandId = 0;
  #pauseRequested = false;
  #disposed = false;

  constructor(
    media: HTMLAudioElement,
    scheduler: PlaybackFrameScheduler = animationFrameScheduler,
    onPlaybackError: MediaPlaybackErrorListener = () => {},
    audioOffsetMs = 0,
  ) {
    this.#media = media;
    this.setAudioVolume(DEFAULT_AUDIO_VOLUME);
    this.#media.playbackRate = this.#playbackRate;
    this.#media.preservesPitch = true;
    this.#scheduler = scheduler;
    this.#onPlaybackError = onPlaybackError;
    this.#audioOffsetMs = normalizeAudioOffsetMs(audioOffsetMs);
    this.#media.addEventListener("play", this.#onMediaProgress);
    this.#media.addEventListener("pause", this.#onMediaProgress);
    this.#media.addEventListener("timeupdate", this.#onMediaProgress);
    this.#media.addEventListener("seeking", this.#onMediaProgress);
    this.#media.addEventListener("ended", this.#onMediaProgress);
    this.#media.addEventListener("error", this.#onMediaError);
  }

  get currentTimeMs(): number {
    return this.#currentChartTimeMs();
  }

  get playing(): boolean {
    return this.#playing;
  }

  get audioOffsetMs(): number {
    return this.#audioOffsetMs;
  }

  get playbackRate(): PlaybackRate {
    return this.#playbackRate;
  }

  setAudioVolume(volume: number): void {
    this.#media.volume = normalizeAudioVolume(volume);
  }

  setPlaybackRate(rate: number): void {
    const next = resolvePlaybackRate(rate);
    this.#syncChartTime(this.#scheduler.now());
    this.#playbackRate = next;
    this.#media.playbackRate = next;
    this.#emit();
  }

  play(): Promise<void> {
    this.#selectionPlayback = undefined;
    return this.#startPlayback();
  }

  pause(): void {
    this.#commandId++;
    this.#pauseRequested = true;
    this.#chartTimeMs = this.#currentChartTimeMs();
    this.#playing = false;
    this.#mediaResumePendingCommandId = undefined;
    this.#selectionPlayback = undefined;
    this.#media.pause();
    this.#cancelFrame();
    this.#emit();
  }

  seek(timeMs: number): void {
    this.#chartTimeMs = Math.max(0, timeMs);
    this.#lastFrameTimeMs = this.#scheduler.now();
    this.#syncMediaToChartTime();
    this.#emit();
  }

  playSelection(selection: PlaybackSelection): Promise<void> {
    this.#selectionPlayback = { range: selection, loop: false };
    this.seek(selection.startMs);
    return this.#startPlayback();
  }

  loopSelection(selection: PlaybackSelection): Promise<void> {
    this.#selectionPlayback = { range: selection, loop: true };
    this.seek(selection.startMs);
    return this.#startPlayback();
  }

  setAudioOffsetMs(audioOffsetMs: number): void {
    const chartTimeMs = this.#currentChartTimeMs();
    this.#audioOffsetMs = normalizeAudioOffsetMs(audioOffsetMs);
    this.#chartTimeMs = chartTimeMs;
    this.#lastFrameTimeMs = this.#scheduler.now();
    this.#syncMediaToChartTime();
    this.#emit();
  }

  subscribe(listener: PlaybackClockListener): () => void {
    this.#listeners.add(listener);
    listener(this.#state());
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;

    this.#disposed = true;
    this.#commandId++;
    this.#pauseRequested = true;
    this.#playing = false;
    this.#mediaResumePendingCommandId = undefined;
    this.#selectionPlayback = undefined;
    this.#media.pause();
    this.#cancelFrame();
    this.#media.removeEventListener("play", this.#onMediaProgress);
    this.#media.removeEventListener("pause", this.#onMediaProgress);
    this.#media.removeEventListener("timeupdate", this.#onMediaProgress);
    this.#media.removeEventListener("seeking", this.#onMediaProgress);
    this.#media.removeEventListener("ended", this.#onMediaProgress);
    this.#media.removeEventListener("error", this.#onMediaError);
    this.#listeners.clear();
  }

  async #startPlayback(): Promise<void> {
    const commandId = ++this.#commandId;
    this.#pauseRequested = false;
    if (this.#disposed) return;

    this.#chartTimeMs = this.#currentChartTimeMs();
    this.#syncMediaToChartTime();
    this.#playing = true;
    this.#lastFrameTimeMs = this.#scheduler.now();

    if (this.#canPlayMediaAt(this.#chartTimeMs)) {
      this.#mediaResumePendingCommandId = commandId;
      try {
        await this.#media.play();
      } catch (error) {
        if (this.#mediaResumePendingCommandId === commandId) {
          this.#mediaResumePendingCommandId = undefined;
        }
        if (this.#disposed || commandId !== this.#commandId) return;

        this.#playing = false;
        this.#cancelFrame();
        this.#emit();
        throw error;
      }

      if (this.#disposed || commandId !== this.#commandId) {
        if (this.#disposed || this.#pauseRequested) this.#media.pause();
        this.#cancelFrame();
        return;
      }

      this.#mediaResumePendingCommandId = undefined;
      this.#chartTimeMs = this.#chartTimeFromMedia();
    }

    this.#lastFrameTimeMs = this.#scheduler.now();
    this.#syncMediaToChartTime();
    this.#scheduleFrame();
    this.#emit();
  }

  #update(frameTimeMs: number): void {
    if (this.#disposed) return;

    this.#syncChartTime(frameTimeMs);
    const playback = this.#selectionPlayback;
    if (!playback || this.#chartTimeMs < playback.range.endMs) {
      this.#syncMediaToChartTime();
      if (this.#playing) this.#scheduleFrame();
      else this.#cancelFrame();
      this.#emit();
      return;
    }

    if (playback.loop) {
      this.#chartTimeMs = playback.range.startMs;
      this.#lastFrameTimeMs = frameTimeMs;
      this.#syncMediaToChartTime();
      this.#scheduleFrame();
      this.#emit();
      return;
    }

    this.#chartTimeMs = playback.range.endMs;
    this.#playing = false;
    this.#syncMediaToChartTime();
    this.#cancelFrame();
    this.#emit();
  }

  #syncChartTime(frameTimeMs: number): void {
    if (this.#usingMediaClock()) this.#chartTimeMs = this.#chartTimeFromMedia();
    else if (this.#playing) {
      this.#chartTimeMs += Math.max(0, frameTimeMs - this.#lastFrameTimeMs) * this.#playbackRate;
    }
    this.#chartTimeMs = Math.max(0, this.#chartTimeMs);
    this.#lastFrameTimeMs = frameTimeMs;
  }

  #syncMediaToChartTime(): void {
    const mediaTimeMs = this.#clampedMediaTimeMs(this.#chartTimeMs);
    if (Math.abs(this.#media.currentTime * 1_000 - mediaTimeMs) > 0.5) {
      this.#media.currentTime = mediaTimeMs / 1_000;
    }

    if (!this.#playing || !this.#canPlayMediaAt(this.#chartTimeMs)) {
      if (!this.#media.paused) this.#media.pause();
      return;
    }

    if (!this.#media.paused || this.#mediaResumePendingCommandId !== undefined) return;
    void this.#resumeMedia(this.#commandId);
  }

  async #resumeMedia(commandId: number): Promise<void> {
    this.#mediaResumePendingCommandId = commandId;
    try {
      await this.#media.play();
    } catch (error) {
      if (this.#mediaResumePendingCommandId === commandId) {
        this.#mediaResumePendingCommandId = undefined;
      }
      if (this.#disposed || commandId !== this.#commandId) return;

      this.#cancelFrame();
      this.#onPlaybackError(error);
      if (this.#disposed || commandId !== this.#commandId) return;
      this.#playing = false;
      this.#emit();
      return;
    }

    if (this.#disposed || commandId !== this.#commandId || this.#pauseRequested) {
      if (this.#disposed || this.#pauseRequested) this.#media.pause();
      this.#cancelFrame();
      return;
    }

    this.#mediaResumePendingCommandId = undefined;
    this.#syncMediaToChartTime();
    this.#scheduleFrame();
    this.#emit();
  }

  #handleMediaError(): void {
    if (this.#disposed) return;

    this.#cancelFrame();
    const message = this.#media.error?.message;
    this.#onPlaybackError(new Error(message || "Audio playback failed."));
    if (this.#disposed) return;

    this.#playing = false;
    this.#mediaResumePendingCommandId = undefined;
    this.#emit();
  }

  #scheduleFrame(): void {
    if (this.#disposed || !this.#playing || this.#frameHandle !== undefined) return;

    this.#frameHandle = this.#scheduler.requestFrame((timeMs) => {
      this.#frameHandle = undefined;
      this.#update(timeMs);
    });
  }

  #cancelFrame(): void {
    if (this.#frameHandle === undefined) return;

    this.#scheduler.cancelFrame(this.#frameHandle);
    this.#frameHandle = undefined;
  }

  #state(): PlaybackClockState {
    const playback = this.#selectionPlayback;
    return {
      currentTimeMs: this.#currentChartTimeMs(),
      playing: this.#playing,
      looping: playback?.loop ?? false,
      ...(playback ? { selection: playback.range } : {}),
    };
  }

  #emit(): void {
    const state = this.#state();
    for (const listener of this.#listeners) listener(state);
  }

  #currentChartTimeMs(): number {
    return this.#usingMediaClock() ? this.#chartTimeFromMedia() : this.#chartTimeMs;
  }

  #chartTimeFromMedia(): number {
    return Math.max(0, this.#media.currentTime * 1_000 - this.#audioOffsetMs);
  }

  #usingMediaClock(): boolean {
    return (
      this.#playing &&
      this.#mediaResumePendingCommandId === undefined &&
      this.#canPlayMediaAt(this.#chartTimeMs) &&
      this.#mediaTimeIsInsideReadableRange(this.#media.currentTime * 1_000)
    );
  }

  #canPlayMediaAt(chartTimeMs: number): boolean {
    return this.#mediaTimeIsInsidePlaybackRange(this.#mediaTimeMs(chartTimeMs));
  }

  #mediaTimeIsInsidePlaybackRange(mediaTimeMs: number): boolean {
    return mediaTimeMs >= 0 && mediaTimeMs < this.#mediaDurationMs();
  }

  #mediaTimeIsInsideReadableRange(mediaTimeMs: number): boolean {
    return mediaTimeMs >= 0 && mediaTimeMs <= this.#mediaDurationMs();
  }

  #mediaTimeMs(chartTimeMs: number): number {
    return chartTimeMs + this.#audioOffsetMs;
  }

  #clampedMediaTimeMs(chartTimeMs: number): number {
    return Math.min(Math.max(0, this.#mediaTimeMs(chartTimeMs)), this.#mediaDurationMs());
  }

  #mediaDurationMs(): number {
    const durationMs = this.#media.duration * 1_000;
    return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : Infinity;
  }
}

function normalizeAudioOffsetMs(audioOffsetMs: number): number {
  return Number.isFinite(audioOffsetMs) ? audioOffsetMs : 0;
}
