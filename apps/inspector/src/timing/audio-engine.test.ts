import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimingAudioEngine } from "./audio-engine";

/** The Web Audio surface the engine uses, with a resume the test settles by hand. */
const audio = vi.hoisted(() => ({
  resumes: [] as (() => void)[],
  sources: [] as { started: boolean; stopped: boolean; at?: number; offset?: number }[],
  context: undefined as
    | { currentTime: number; state: string; getOutputTimestamp: () => object }
    | undefined,
  listeners: [] as (() => void)[],
}));

/** Changes the stub context's state and tells the engine, as the browser's statechange does. */
function setState(state: string) {
  if (audio.context) audio.context.state = state;
  for (const listener of audio.listeners) listener();
}

beforeEach(() => {
  audio.resumes = [];
  audio.sources = [];
  audio.listeners = [];
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
      addEventListener(type: string, listener: () => void) {
        if (type === "statechange") audio.listeners.push(listener);
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
      readonly record: { started: boolean; stopped: boolean; at?: number; offset?: number } = {
        started: false,
        stopped: false,
      };
      onended: (() => void) | null = null;
      constructor() {
        super();
        audio.sources.push(this.record);
      }
      start(at?: number, offset?: number) {
        this.record.started = true;
        if (at !== undefined) this.record.at = at;
        if (offset !== undefined) this.record.offset = offset;
      }
      stop() {
        this.record.stopped = true;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

it("gives a tap no heard time until the output has reached the start", async () => {
  const engine = loaded();
  expect(engine.heardAt(1000)).toBeUndefined();
  const play = engine.play({ fromMs: 0, endMs: 1000, rate: 1, loop: null });
  audio.resumes[0]?.();
  await play;
  // The stub's output timestamp is zero: output has not started.
  expect(engine.heardAt(1000)).toBeUndefined();
  const context = engine.context as unknown as { getOutputTimestamp: () => object };
  // Output at context 0.05 s when the page clock read 1000 ms; the start is at 0.03 s.
  context.getOutputTimestamp = () => ({ contextTime: 0.05, performanceTime: 1000 });
  expect(engine.heardAt(1000)).toBeCloseTo(20, 9);
  expect(engine.heardAt(970)).toBeUndefined();
});

it("starts a running context at once, on whole frames, and anchors the frame really played", async () => {
  const engine = loaded();
  const first = engine.play(options);
  audio.resumes[0]?.();
  await first;
  if (audio.context) audio.context.currentTime = 1280 / 44_100;
  // Running now: no resume is awaited, so the source exists as soon as play returns.
  void engine.play({ fromMs: 3.3, endMs: 10, rate: 1, loop: null });
  const music = audio.sources.at(-1);
  expect(audio.resumes).toHaveLength(1);
  expect(Math.ceil((music?.at ?? 0) * 44_100)).toBe(1280 + 1323);
  expect(Math.ceil((music?.offset ?? 0) * 44_100)).toBe(146);
});

it("moves the playhead on the clock model's line, offset for the display only", async () => {
  const engine = loaded();
  const play = engine.play({ fromMs: 0, endMs: 10_000, rate: 1, loop: null });
  audio.resumes[0]?.();
  await play;
  const context = engine.context as unknown as { getOutputTimestamp: () => object };
  context.getOutputTimestamp = () => ({ contextTime: 0.05, performanceTime: 1000 });
  engine.sampleClock();
  // The start is at 0.03 s, heard at page time 980 ms; frames show the time heard at frame − offset.
  expect(engine.motion(0)?.startPerfMs).toBeCloseTo(980, 9);
  expect(engine.shownAt(1100, 0)).toBeCloseTo(120, 9);
  expect(engine.shownAt(1100, 20)).toBeCloseTo(100, 9);
  expect(engine.heardAt(1100)).toBeCloseTo(120, 9);
  // Stopped, nothing is shown or heard.
  engine.stop();
  expect(engine.motion(0)).toBeUndefined();
  expect(engine.heardAt(1100)).toBeUndefined();
});

it("freezes where the playhead was when the context stops running mid-play, and refits after", async () => {
  const engine = loaded();
  const play = engine.play({ fromMs: 1000, endMs: 9000, rate: 1, loop: null });
  audio.resumes[0]?.();
  await play;
  const context = audio.context;
  if (!context) throw new Error("No context");
  // Heard context time (perf − 1000 ms) / 1000; the start at context 0.03 s is heard at 1030 ms.
  let stamp = (perfMs: number) => ({
    contextTime: (perfMs - 1000) / 1000,
    performanceTime: perfMs,
  });
  let nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  context.getOutputTimestamp = () => stamp(nowMs);
  // One second of transport steps as the workspace runs them: a clock sample and the motion,
  // which the workspace evaluates itself.
  for (nowMs = 1050; nowMs <= 2000; nowMs += 25) {
    engine.sampleClock();
    expect(engine.motion(0)).toBeDefined();
  }
  // The output goes away 970 ms into the source: the transport freezes there, and so does a pause.
  setState("suspended");
  nowMs = 2010;
  expect(engine.motion(0)).toBeUndefined();
  expect(engine.shownAt(nowMs, 0)).toBeCloseTo(1970, 6);
  // Running again, the old clock line is dropped: nothing moves until the output stamps again.
  context.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 0 });
  setState("running");
  nowMs = 5000;
  expect(engine.motion(0)).toBeUndefined();
  expect(engine.shownAt(nowMs, 0)).toBeCloseTo(1970, 6);
  // The context resumed where it stopped (heard context 1 s at page time 5000 ms).
  stamp = (perfMs: number) => ({
    contextTime: 1 + (perfMs - 5000) / 1000,
    performanceTime: perfMs,
  });
  context.getOutputTimestamp = () => stamp(nowMs);
  nowMs = 5100;
  expect(engine.shownAt(nowMs, 0)).toBeCloseTo(2070, 6);
  setState("suspended");
  expect(engine.stop(0)).toBeCloseTo(2070, 6);
});
