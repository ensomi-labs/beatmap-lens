import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimingAudioEngine } from "./audio-engine";

/** The Web Audio surface the engine uses, with a resume the test settles by hand. */
const audio = vi.hoisted(() => ({
  resumes: [] as (() => void)[],
  sources: [] as { started: boolean; stopped: boolean }[],
}));

beforeEach(() => {
  audio.resumes = [];
  audio.sources = [];
  class Node {
    connect<T>(next: T): T {
      return next;
    }
    disconnect() {}
  }
  vi.stubGlobal(
    "AudioContext",
    class {
      readonly sampleRate: number;
      readonly destination = new Node();
      state = "suspended";
      currentTime = 0;
      constructor(options: { sampleRate: number }) {
        this.sampleRate = options.sampleRate;
      }
      resume() {
        return new Promise<void>((resolve) => {
          audio.resumes.push(() => {
            this.state = "running";
            resolve();
          });
        });
      }
      async close() {}
    },
  );
  vi.stubGlobal(
    "GainNode",
    class extends Node {
      gain = { value: 1 };
    },
  );
  vi.stubGlobal(
    "AudioBuffer",
    class {
      readonly length: number;
      constructor(options: { length: number }) {
        this.length = options.length;
      }
      copyToChannel() {}
    },
  );
  vi.stubGlobal(
    "AudioBufferSourceNode",
    class extends Node {
      readonly record = { started: false, stopped: false };
      onended: (() => void) | null = null;
      constructor() {
        super();
        audio.sources.push(this.record);
      }
      start() {
        this.record.started = true;
      }
      stop() {
        this.record.stopped = true;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function loaded() {
  const engine = new TimingAudioEngine(44_100);
  engine.load([new Float32Array(441)], 441);
  return engine;
}

const options = { fromMs: 0, endMs: 10, rate: 1, loop: null };

it("starts only the latest of two plays made while the context resumes", async () => {
  const engine = loaded();
  const first = engine.play(options);
  const second = engine.play(options);
  expect(engine.starting).toBe(true);
  for (const resume of audio.resumes) resume();
  expect(await first).toBe(false);
  expect(await second).toBe(true);
  expect(audio.sources).toHaveLength(1);
  expect(engine.playing).toBe(true);
  expect(engine.starting).toBe(false);
});

it("lets a stop cancel a play that is still waiting, and stops idempotently", async () => {
  const engine = loaded();
  const pending = engine.play(options);
  engine.stop();
  expect(engine.starting).toBe(false);
  audio.resumes[0]?.();
  expect(await pending).toBe(false);
  expect(audio.sources).toHaveLength(0);
  expect(engine.playing).toBe(false);
  expect(engine.stop()).toBeUndefined();
});
