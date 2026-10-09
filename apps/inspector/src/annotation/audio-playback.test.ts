import { parseOsu } from "beatmap-lens";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_OFFSET_PREFERENCE_KEY,
  AudioPlaybackController,
  audioFilenameFromParsedOsu,
  type BeatmapAudioFileContext,
  createBeatmapAudioFileContext,
  MUSIC_PREFERENCE_KEY,
  type MusicPreferenceStore,
  resolveBeatmapAudioFile,
} from "./audio-playback";
import { AUDIO_VOLUME_PREFERENCE_KEY } from "./audio-volume";
import type { PlaybackFrameScheduler } from "./playback-clock";

describe("resolveBeatmapAudioFile", () => {
  it("resolves audio relative to the selected osu file directory", async () => {
    const audio = audioFile("song.ogg");
    const musicDirectory = directory({ "song.ogg": audio });
    const osuDirectory = directory({ music: musicDirectory });

    await expect(resolveBeatmapAudioFile(context(osuDirectory, "music\\song.ogg"))).resolves.toBe(
      audio,
    );
  });

  it("builds task-relative context from the last General AudioFilename", async () => {
    const osu = audioFile("map.osu");
    const maps = directory({ "map.osu": osu });
    const corpus = directory({ maps });
    const parsed = parseOsu(`[General]\nAudioFilename:first.mp3\naudiofilename:music/song.ogg\n`);

    const resolved = await createBeatmapAudioFileContext(
      corpus,
      { categories: [], pathSegments: ["maps", "map.osu"] },
      parsed,
    );

    expect(resolved).toMatchObject({
      audioFilename: "music/song.ogg",
      osuDirectory: maps,
    });
    await expect(resolved.osuFile.getFile()).resolves.toBe(osu);
    expect(audioFilenameFromParsedOsu(parsed)).toBe("music/song.ogg");
  });
});

describe("AudioPlaybackController", () => {
  it("retains rate through music switching, loading and media failure", async () => {
    const media = new FakeAudio();
    const scheduler = new TestFrameScheduler();
    const controller = new AudioPlaybackController({
      scheduler,
      preferenceStore: new MemoryPreferenceStore(),
      createMedia: () => media as unknown as HTMLAudioElement,
    });
    controller.setPlaybackRate(0.75);
    await controller.play();
    scheduler.advance(400);
    expect(controller.currentTimeMs).toBe(300);
    await controller.loadAudioUrl("/synthetic-audio");
    expect(media.playbackRate).toBe(0.75);
    await controller.setMusicEnabled(true);
    expect(media.currentTime).toBe(0.3);
    media.currentTime = 0.6;
    scheduler.advance(400);
    expect(controller.currentTimeMs).toBe(600);
    await controller.setMusicEnabled(false);
    scheduler.advance(400);
    expect(controller.currentTimeMs).toBe(900);
    controller.setPlaybackRate(1.5);
    await controller.setMusicEnabled(true);
    expect(media.playbackRate).toBe(1.5);
    media.failPlayback(new Error("Rate fixture failure"));
    scheduler.advance(400);
    expect(controller.currentTimeMs).toBe(1500);
    expect(controller.playbackRate).toBe(1.5);
    controller.dispose();
  });

  it("streams remote audio with the existing offset and fallback clock", async () => {
    const media = new FakeAudio();
    const scheduler = new TestFrameScheduler();
    const preferenceStore = new MemoryPreferenceStore();
    preferenceStore.setItem(MUSIC_PREFERENCE_KEY, "on");
    preferenceStore.setItem(AUDIO_OFFSET_PREFERENCE_KEY, "125");
    const createMedia = vi.fn(() => media as unknown as HTMLAudioElement);
    const createObjectUrl = vi.fn();
    const revokeObjectUrl = vi.fn();
    const controller = new AudioPlaybackController({
      scheduler,
      preferenceStore,
      createMedia,
      createObjectUrl,
      revokeObjectUrl,
    });

    await controller.loadAudioUrl("/api/review/audio/source-sha");
    expect(createMedia).toHaveBeenCalledWith("/api/review/audio/source-sha");
    expect(createObjectUrl).not.toHaveBeenCalled();
    controller.seek(1_000);
    await controller.play();
    expect(media.currentTime).toBe(1.125);
    media.currentTime = 1.25;
    scheduler.advance(16);
    expect(controller.currentTimeMs).toBe(1_125);

    media.failPlayback(new Error("Network interrupted"));
    expect(controller.audioStatus).toEqual({ kind: "rejected", message: "Network interrupted" });
    scheduler.advance(100);
    expect(controller.currentTimeMs).toBe(1_225);
    controller.dispose();
    expect(media.paused).toBe(true);
    expect(revokeObjectUrl).not.toHaveBeenCalled();
  });

  it("keeps remote session changes safe from old file loads and pending playback", async () => {
    const scheduler = new TestFrameScheduler();
    const first = new FakeAudio({ deferPlay: true });
    const second = new FakeAudio();
    const createMedia = vi
      .fn()
      .mockReturnValueOnce(first as unknown as HTMLAudioElement)
      .mockReturnValueOnce(second as unknown as HTMLAudioElement);
    const createObjectUrl = vi.fn(() => "blob:obsolete");
    const revokeObjectUrl = vi.fn();
    const controller = new AudioPlaybackController({
      scheduler,
      preferenceStore: new MemoryPreferenceStore(),
      createMedia,
      createObjectUrl,
      revokeObjectUrl,
    });
    const pending = deferredFile();
    const oldLoad = controller.loadBeatmapAudio(context(directory({ "song.ogg": pending.handle })));
    await controller.loadAudioUrl("/api/review/audio/first");
    pending.resolve(audioFile("old.ogg"));
    await oldLoad;
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(createMedia).toHaveBeenCalledTimes(1);

    await controller.setMusicEnabled(true);
    const oldPlay = controller.play();
    controller.clearSession();
    await controller.loadAudioUrl("/api/review/audio/second");
    controller.seek(700);
    first.rejectPlay(new Error("Stale request failed"));
    await oldPlay;
    first.failPlayback(new Error("Old media error"));
    expect(controller.audioStatus).toEqual({ kind: "ready" });
    expect(controller.currentTimeMs).toBe(700);
    expect(controller.playing).toBe(false);

    controller.dispose();
    await controller.loadAudioUrl("/api/review/audio/after-dispose");
    expect(createMedia).toHaveBeenCalledTimes(2);
    expect(revokeObjectUrl).not.toHaveBeenCalled();
  });

  it("starts with Music off and remembers the latest preference", async () => {
    const preferenceStore = new MemoryPreferenceStore();
    const controller = controllerWith({ preferenceStore });

    expect(controller.musicEnabled).toBe(false);

    await controller.setMusicEnabled(true);
    expect(preferenceStore.getItem(MUSIC_PREFERENCE_KEY)).toBe("on");

    await controller.setMusicEnabled(false);
    expect(preferenceStore.getItem(MUSIC_PREFERENCE_KEY)).toBe("off");
  });

  it("applies 80% by default and keeps volume through playback, new audio, and reopening", async () => {
    const media = new FakeAudio();
    const scheduler = new TestFrameScheduler();
    const preferenceStore = new MemoryPreferenceStore();
    preferenceStore.setItem(MUSIC_PREFERENCE_KEY, "on");
    const controller = controllerWith({ media, preferenceStore, scheduler });
    await controller.loadAudioUrl("/first-song");
    expect(media.volume).toBe(0.8);
    await controller.loopSelection({ startMs: 1000, endMs: 2000 });
    controller.seek(1200);

    controller.setAudioVolume(0.35);
    expect(media.volume).toBe(0.35);
    expect(controller.currentTimeMs).toBe(1200);
    expect(controller.playing).toBe(true);
    expect(preferenceStore.getItem(AUDIO_VOLUME_PREFERENCE_KEY)).toBe("0.35");

    await controller.loadAudioUrl("/next-song");
    expect(media.volume).toBe(0.35);
    controller.setAudioVolume(0);
    controller.dispose();
    const reopened = controllerWith({ media, preferenceStore, scheduler });
    await reopened.loadAudioUrl("/next-song");
    expect(reopened.audioVolume).toBe(0);
    expect(media.volume).toBe(0);
    reopened.dispose();
  });

  it("persists audio offset and retimes media without moving chart time", async () => {
    const scheduler = new TestFrameScheduler();
    const media = new FakeAudio();
    const preferenceStore = new MemoryPreferenceStore();
    preferenceStore.setItem(MUSIC_PREFERENCE_KEY, "on");
    preferenceStore.setItem(AUDIO_OFFSET_PREFERENCE_KEY, "100");
    const controller = controllerWith({ media, preferenceStore, scheduler });
    await controller.loadBeatmapAudio(context(directory({ "song.ogg": audioFile("song.ogg") })));

    expect(controller.audioOffsetMs).toBe(100);

    controller.seek(1_000);
    await controller.play();
    expect(media.currentTime).toBe(1.1);

    media.currentTime = 1.25;
    scheduler.advance(16);
    expect(controller.currentTimeMs).toBe(1_150);

    controller.setAudioOffsetMs(-50);

    expect(preferenceStore.getItem(AUDIO_OFFSET_PREFERENCE_KEY)).toBe("-50");
    expect(controller.audioOffsetMs).toBe(-50);
    expect(controller.currentTimeMs).toBe(1_150);
    expect(media.currentTime).toBe(1.1);
  });

  it("does not move synthetic playback when Music is off and offset changes", async () => {
    const scheduler = new TestFrameScheduler();
    const preferenceStore = new MemoryPreferenceStore();
    const controller = controllerWith({ preferenceStore, scheduler });

    controller.seek(500);
    await controller.play();
    scheduler.advance(100);
    controller.setAudioOffsetMs(120);

    expect(controller.currentTimeMs).toBe(600);
    expect(preferenceStore.getItem(AUDIO_OFFSET_PREFERENCE_KEY)).toBe("120");
  });

  it("preserves authoritative time and resume state when Music switches", async () => {
    const scheduler = new TestFrameScheduler();
    const media = new FakeAudio();
    const controller = controllerWith({ media, scheduler });
    await controller.loadBeatmapAudio(context(directory({ "song.ogg": audioFile("song.ogg") })));

    controller.seek(1_000);
    await controller.play();
    scheduler.advance(250);
    await controller.setMusicEnabled(true);

    expect(media.currentTime).toBe(1.25);
    expect(media.paused).toBe(false);
    expect(controller.currentTimeMs).toBe(1_250);

    media.currentTime = 2.5;
    await controller.setMusicEnabled(false);

    expect(controller.currentTimeMs).toBe(2_500);
    expect(controller.playing).toBe(true);

    scheduler.advance(100);
    expect(controller.currentTimeMs).toBe(2_600);
  });

  it("honors Music on when audio resolves after a newer playback intent", async () => {
    const scheduler = new TestFrameScheduler();
    const media = new FakeAudio();
    const preferenceStore = new MemoryPreferenceStore();
    preferenceStore.setItem(MUSIC_PREFERENCE_KEY, "on");
    const controller = controllerWith({ media, preferenceStore, scheduler });
    const pendingAudio = deferredFile();

    const loading = controller.loadBeatmapAudio(
      context(directory({ "song.ogg": pendingAudio.handle })),
    );
    controller.seek(1_000);
    await controller.play();
    scheduler.advance(200);

    pendingAudio.resolve(audioFile("song.ogg"));
    await loading;

    expect(controller.audioStatus).toEqual({ kind: "ready" });
    expect(controller.currentTimeMs).toBe(1_200);
    expect(media.currentTime).toBe(1.2);
    expect(media.paused).toBe(false);
  });

  it("keeps synthetic playback available when audio is missing", async () => {
    const scheduler = new TestFrameScheduler();
    const controller = controllerWith({ scheduler });
    await controller.loadBeatmapAudio(context(directory({})));

    expect(controller.audioStatus.kind).toBe("missing");

    controller.seek(500);
    await controller.play();
    scheduler.advance(100);

    expect(controller.currentTimeMs).toBe(600);
    expect(controller.playing).toBe(true);
  });

  it("supports a chart-end subscriber clamping media before pause", async () => {
    const media = new FakeAudio();
    const controller = controllerWith({ media });
    await controller.loadBeatmapAudio(context(directory({ "song.ogg": audioFile("song.ogg") })));
    await controller.setMusicEnabled(true);
    let emissions = 0;
    const unsubscribe = controller.subscribe((state) => {
      emissions++;
      if (state.currentTimeMs <= 1_000) return;
      controller.seek(1_000);
      controller.pause();
    });

    controller.seek(1_500);

    expect(controller.currentTimeMs).toBe(1_000);
    expect(controller.playing).toBe(false);
    expect(emissions).toBeLessThan(6);
    unsubscribe();
  });

  it("falls back from media rejection without applying offset to chart time", async () => {
    const scheduler = new TestFrameScheduler();
    const media = new FakeAudio(new Error("Autoplay rejected"));
    const preferenceStore = new MemoryPreferenceStore();
    preferenceStore.setItem(AUDIO_OFFSET_PREFERENCE_KEY, "100");
    const controller = controllerWith({ media, preferenceStore, scheduler });
    await controller.loadBeatmapAudio(context(directory({ "song.ogg": audioFile("song.ogg") })));
    controller.seek(900);
    await controller.play();

    await controller.setMusicEnabled(true);

    expect(controller.audioStatus).toEqual({ kind: "rejected", message: "Autoplay rejected" });
    expect(controller.playing).toBe(true);
    expect(controller.currentTimeMs).toBe(900);
    expect(media.currentTime).toBe(1);

    scheduler.advance(100);
    expect(controller.currentTimeMs).toBe(1_000);
  });

  it("does not resume fallback playback from a stale media rejection after pause", async () => {
    const scheduler = new TestFrameScheduler();
    const media = new FakeAudio({ deferPlay: true });
    const controller = controllerWith({ media, scheduler });
    await controller.loadBeatmapAudio(context(directory({ "song.ogg": audioFile("song.ogg") })));
    await controller.setMusicEnabled(true);

    controller.seek(500);
    const playing = controller.play();
    controller.pause();
    media.rejectPlay(new Error("Autoplay rejected"));
    await playing;

    expect(controller.audioStatus).toEqual({ kind: "ready" });
    expect(controller.playing).toBe(false);
    expect(controller.currentTimeMs).toBe(500);
  });

  it("does not apply a stale media rejection after a newer seek", async () => {
    const scheduler = new TestFrameScheduler();
    const media = new FakeAudio({ deferPlay: true });
    const controller = controllerWith({ media, scheduler });
    await controller.loadBeatmapAudio(context(directory({ "song.ogg": audioFile("song.ogg") })));
    await controller.setMusicEnabled(true);

    const playing = controller.play();
    controller.seek(750);
    media.rejectPlay(new Error("Interrupted by seek"));
    await playing;

    expect(controller.audioStatus).toEqual({ kind: "ready" });
    expect(controller.playing).toBe(false);
    expect(controller.currentTimeMs).toBe(750);
  });

  it("does not let a stale Music switch revive media playback", async () => {
    const scheduler = new TestFrameScheduler();
    const media = new FakeAudio({ deferPlay: true });
    const controller = controllerWith({ media, scheduler });
    await controller.loadBeatmapAudio(context(directory({ "song.ogg": audioFile("song.ogg") })));

    await controller.play();
    scheduler.advance(250);

    const enablingMusic = controller.setMusicEnabled(true);
    await controller.setMusicEnabled(false);
    media.resolvePlay();
    await enablingMusic;

    expect(controller.musicEnabled).toBe(false);
    expect(media.paused).toBe(true);
  });

  it("does not let a stale Music switch pause a newer media selection", async () => {
    const scheduler = new TestFrameScheduler();
    const media = new FakeAudio({ deferPlay: true });
    const controller = controllerWith({ media, scheduler });
    await controller.loadBeatmapAudio(context(directory({ "song.ogg": audioFile("song.ogg") })));
    await controller.play();

    const enablingMusic = controller.setMusicEnabled(true);
    const selection = controller.playSelection({ startMs: 500, endMs: 900 });
    media.resolvePlay();
    await enablingMusic;

    expect(media.paused).toBe(false);
    expect(controller.currentTimeMs).toBe(500);

    media.resolvePlay();
    await selection;
    expect(controller.playing).toBe(true);
  });

  it("falls back to the synthetic clock after a runtime media error", async () => {
    const scheduler = new TestFrameScheduler();
    const media = new FakeAudio();
    const controller = controllerWith({ media, scheduler });
    await controller.loadBeatmapAudio(context(directory({ "song.ogg": audioFile("song.ogg") })));
    controller.seek(900);
    await controller.play();
    await controller.setMusicEnabled(true);
    media.currentTime = 1.2;

    media.failPlayback(new Error("Decode failed"));

    expect(controller.audioStatus).toEqual({ kind: "rejected", message: "Decode failed" });
    expect(controller.currentTimeMs).toBe(1_200);
    expect(controller.playing).toBe(true);
    scheduler.advance(100);
    expect(controller.currentTimeMs).toBe(1_300);
  });

  it("pauses and resets synthetic playback when the session clears", async () => {
    const scheduler = new TestFrameScheduler();
    const controller = controllerWith({ scheduler });

    await controller.play();
    scheduler.advance(250);
    controller.clearSession();
    scheduler.advance(250);

    expect(controller.playing).toBe(false);
    expect(controller.currentTimeMs).toBe(0);
  });

  it("reports object URL creation failures without rejecting the load", async () => {
    const controller = controllerWith({
      createObjectUrl: () => {
        throw new Error("Blob URLs are unavailable");
      },
    });

    await expect(
      controller.loadBeatmapAudio(context(directory({ "song.ogg": audioFile("song.ogg") }))),
    ).resolves.toBeUndefined();
    expect(controller.audioStatus).toEqual({
      kind: "unsupported",
      message: "Blob URLs are unavailable",
    });
  });

  it("revokes object URLs when the chart changes and the session clears", async () => {
    const revoked: string[] = [];
    let nextUrl = 1;
    const controller = controllerWith({
      createObjectUrl: () => `blob:${nextUrl++}`,
      revokeObjectUrl: (url) => revoked.push(url),
    });

    await controller.loadBeatmapAudio(context(directory({ "song.ogg": audioFile("one.ogg") })));
    await controller.loadBeatmapAudio(context(directory({ "song.ogg": audioFile("two.ogg") })));

    expect(revoked).toEqual(["blob:1"]);

    controller.clearSession();
    expect(revoked).toEqual(["blob:1", "blob:2"]);
  });
});

interface ControllerTestOptions {
  readonly scheduler?: PlaybackFrameScheduler;
  readonly media?: FakeAudio;
  readonly preferenceStore?: MusicPreferenceStore;
  readonly createObjectUrl?: (file: File) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

function controllerWith(options: ControllerTestOptions = {}): AudioPlaybackController {
  return new AudioPlaybackController({
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    ...(options.preferenceStore ? { preferenceStore: options.preferenceStore } : {}),
    createMedia: () => (options.media ?? new FakeAudio()) as unknown as HTMLAudioElement,
    createObjectUrl: options.createObjectUrl ?? (() => "blob:audio"),
    revokeObjectUrl: options.revokeObjectUrl ?? (() => {}),
  });
}

function context(
  osuDirectory: FileSystemDirectoryHandle,
  audioFilename = "song.ogg",
): BeatmapAudioFileContext {
  return {
    osuFile: {} as FileSystemFileHandle,
    osuDirectory,
    audioFilename,
  };
}

function audioFile(name: string): File {
  return new File(["audio"], name, { type: "audio/ogg" });
}

function deferredFile(): {
  readonly handle: FileSystemFileHandle;
  readonly resolve: (file: File) => void;
} {
  let resolve!: (file: File) => void;
  const file = new Promise<File>((next) => {
    resolve = next;
  });
  return {
    handle: { getFile: () => file } as FileSystemFileHandle,
    resolve,
  };
}

function directory(
  entries: Record<string, File | FileSystemDirectoryHandle | FileSystemFileHandle>,
): FileSystemDirectoryHandle {
  return {
    async getDirectoryHandle(name: string) {
      const entry = entries[name];
      if (!entry || entry instanceof File) throw new DOMException("Not found", "NotFoundError");
      return entry;
    },
    async getFileHandle(name: string) {
      const entry = entries[name];
      if (entry instanceof File) return { getFile: async () => entry } as FileSystemFileHandle;
      if (entry && "getFile" in entry) return entry;
      throw new DOMException("Not found", "NotFoundError");
    },
  } as FileSystemDirectoryHandle;
}

class FakeAudio extends EventTarget {
  volume = 1;
  currentTime = 0;
  error: MediaError | null = null;
  playbackRate = 1;
  paused = true;
  readonly #playError: Error | undefined;
  readonly #deferPlay: boolean;
  readonly #pendingPlays: Array<{
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }> = [];

  constructor(options: Error | { readonly deferPlay?: boolean; readonly playError?: Error } = {}) {
    super();
    if (options instanceof Error) {
      this.#playError = options;
      this.#deferPlay = false;
      return;
    }

    this.#playError = options.playError;
    this.#deferPlay = options.deferPlay ?? false;
  }

  canPlayType(): CanPlayTypeResult {
    return "probably";
  }

  play(): Promise<void> {
    if (this.#playError) return Promise.reject(this.#playError);
    if (this.#deferPlay) {
      return new Promise((resolve, reject) => {
        this.#pendingPlays.push({
          resolve: () => {
            this.#startPlayback();
            resolve();
          },
          reject,
        });
      });
    }

    this.#startPlayback();
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  resolvePlay(): void {
    const pending = this.#pendingPlays.shift();
    pending?.resolve();
  }

  rejectPlay(error: Error): void {
    const pending = this.#pendingPlays.shift();
    pending?.reject(error);
  }

  failPlayback(error: Error): void {
    this.error = { message: error.message } as MediaError;
    this.paused = true;
    this.dispatchEvent(new Event("error"));
  }

  #startPlayback(): void {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }
}

class TestFrameScheduler implements PlaybackFrameScheduler {
  #timeMs = 0;
  #nextHandle = 1;
  #callbacks = new Map<number, (timeMs: number) => void>();

  now(): number {
    return this.#timeMs;
  }

  requestFrame(callback: (timeMs: number) => void): number {
    const handle = this.#nextHandle++;
    this.#callbacks.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.#callbacks.delete(handle);
  }

  advance(elapsedMs: number): void {
    this.#timeMs += elapsedMs;
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback(this.#timeMs);
  }
}

class MemoryPreferenceStore implements MusicPreferenceStore {
  readonly #values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}
