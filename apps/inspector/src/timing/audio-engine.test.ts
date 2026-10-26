import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimingAudioEngine } from "./audio-engine";

/** The Web Audio surface the engine uses, with a resume the test settles by hand. */
const audio = vi.hoisted(() => ({
  resumes: [] as (() => void)[],
  sources: [] as { started: boolean; stopped: boolean; at?: number }[],
  context: undefined as { currentTime: number } | undefined,
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
        audio.context = this;
      }
      resume() {
        return new Promise<void>((resolve) => {
          audio.resumes.push(() => {
            this.state = "running";
            resolve();
          });
        });
      }
      getOutputTimestamp() {
        return { contextTime: 0, performanceTime: 0 };
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
      readonly record: { started: boolean; stopped: boolean; at?: number } = {
        started: false,
        stopped: false,
      };
      onended: (() => void) | null = null;
      constructor() {
        super();
        audio.sources.push(this.record);
      }
      start(at?: number) {
        this.record.started = true;
        if (at !== undefined) this.record.at = at;
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

it("clicks at the listener's beats while playing, and reschedules or stops them on a change", async () => {
  vi.useFakeTimers();
  try {
    const engine = loaded();
    engine.setClicks([2, 5]);
    const play = engine.play({ fromMs: 0, endMs: 10, rate: 1, loop: null });
    audio.resumes[0]?.();
    expect(await play).toBe(true);
    // The music source, then a click per beat at its context time (start lead 30 ms).
    const clicks = () => audio.sources.slice(1);
    expect(clicks()).toHaveLength(2);
    expect(clicks()[0]?.at).toBeCloseTo(0.032, 12);
    expect(clicks()[1]?.at).toBeCloseTo(0.035, 12);
    // A changed beat cancels the clicks still to come and schedules the new one.
    engine.setClicks([7]);
    expect(
      clicks()
        .slice(0, 2)
        .every((click) => click.stopped),
    ).toBe(true);
    expect(clicks().at(-1)?.at).toBeCloseTo(0.037, 12);
    // Off: nothing more is scheduled; stop silences what was.
    engine.setClicks(null);
    expect(clicks().every((click) => click.stopped)).toBe(true);
    const count = audio.sources.length;
    if (audio.context) audio.context.currentTime = 0.1;
    vi.advanceTimersByTime(100);
    expect(audio.sources).toHaveLength(count);
    engine.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("schedules no clicks while they are off", async () => {
  const engine = loaded();
  const play = engine.play({ fromMs: 0, endMs: 10, rate: 1, loop: null });
  audio.resumes[0]?.();
  await play;
  expect(audio.sources).toHaveLength(1);
});
