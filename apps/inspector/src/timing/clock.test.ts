import { describe, expect, it } from "vitest";
import {
  contextAt,
  OutputClock,
  type PlaybackAnchor,
  perfAt,
  sourceAtContext,
  wrapLoop,
} from "./clock";

/** A deterministic generator in [0, 1). */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 2 ** 32;
  };
}

/** The true heard context time at page time t: offset 1234.5 ms, the audio clock 20 ppm fast. */
const ratio = 1 + 20e-6;
const trueCtx = (perfMs: number) => (1234.5 + 2000 + (perfMs - 2000) * ratio) / 1000;

/** Stamps once per 512-frame callback at 48 kHz from page time 2000 ms, with page-time noise. */
function stamps(count: number, noiseMs: number, seed = 7) {
  const next = random(seed);
  return Array.from({ length: count }, (_, index) => {
    const perfMs = 2000 + index * (512 / 48);
    return {
      contextTime: trueCtx(perfMs),
      performanceTime: perfMs + (next() * 2 - 1) * noiseMs,
    };
  });
}

describe("ClockLine", () => {
  it("maps page time to context time and back", () => {
    const line = { perfMs: 5000, ctxS: 10, ratio: 1.0001 };
    expect(contextAt(line, 5100)).toBeCloseTo(10.10001, 12);
    expect(perfAt(line, contextAt(line, 5123.25))).toBeCloseTo(5123.25, 9);
  });
});

describe("OutputClock", () => {
  it("uses a lone stamp as it is, and ignores empty and repeated stamps", () => {
    const clock = new OutputClock();
    expect(clock.observe({ contextTime: 0, performanceTime: 0 })).toBe(false);
    expect(clock.observe({})).toBe(false);
    expect(clock.line()).toBeUndefined();
    expect(clock.observe({ contextTime: 10, performanceTime: 5000 })).toBe(true);
    expect(clock.observe({ contextTime: 10, performanceTime: 5016 })).toBe(false);
    expect(clock.line()).toEqual({ perfMs: 5000, ctxS: 10, ratio: 1 });
  });

  it("averages away stamp noise and rejects an outlier that the newest stamp alone would show", () => {
    const clock = new OutputClock();
    const all = stamps(90, 0.4);
    all[60] = { ...(all[60] as { contextTime: number; performanceTime: number }) };
    (all[60] as { performanceTime: number }).performanceTime += 4;
    for (const stamp of all) clock.observe(stamp);
    const line = clock.line();
    if (!line) throw new Error("No line");
    for (const t of [2500, 2900, 2960, 3000])
      expect(Math.abs(contextAt(line, t) - trueCtx(t)) * 1000).toBeLessThan(0.1);
  });

  it("tracks the audio clock's rate against the page clock", () => {
    const clock = new OutputClock();
    for (const stamp of stamps(90, 0)) clock.observe(stamp);
    expect(Math.abs((clock.line()?.ratio ?? 0) - ratio)).toBeLessThan(1e-6);
  });

  it("follows a step after three stamps instead of averaging it away", () => {
    const clock = new OutputClock();
    const before = stamps(60, 0.05);
    for (const stamp of before) clock.observe(stamp);
    // The output jumps 5 ms later in context time (a glitch or a device change).
    const after = stamps(64, 0.05, 9)
      .slice(60)
      .map((stamp) => ({ ...stamp, contextTime: stamp.contextTime - 0.005 }));
    clock.observe(after[0] as object);
    clock.observe(after[1] as object);
    const t = (after[1] as { performanceTime: number }).performanceTime;
    const line = () => clock.line() as NonNullable<ReturnType<OutputClock["line"]>>;
    // Two stamps off the line are outliers to it.
    expect(Math.abs(contextAt(line(), t) - trueCtx(t)) * 1000).toBeLessThan(0.2);
    clock.observe(after[2] as object);
    clock.observe(after[3] as object);
    const u = (after[3] as { performanceTime: number }).performanceTime;
    expect(Math.abs(contextAt(line(), u) - (trueCtx(u) - 0.005)) * 1000).toBeLessThan(0.2);
  });

  it("keeps only the last second of stamps", () => {
    const clock = new OutputClock();
    // A first second at another offset, then 1.2 s at the true one.
    for (const stamp of stamps(100, 0))
      clock.observe({ ...stamp, contextTime: stamp.contextTime - 0.003 });
    const later = stamps(220, 0).slice(100);
    for (const stamp of later) clock.observe(stamp);
    const t = (later.at(-1) as { performanceTime: number }).performanceTime;
    expect(Math.abs(contextAt(clock.line() as never, t) - trueCtx(t)) * 1000).toBeLessThan(1e-6);
  });

  it("gives the same line however often it is sampled", () => {
    const all = stamps(90, 0.3);
    // Read every animation frame or every few ms, one device callback's stamp is seen several
    // times; only its first reading counts.
    const once = new OutputClock();
    const often = new OutputClock();
    for (const stamp of all) {
      once.observe(stamp);
      for (let read = 0; read < 3; read++) often.observe(stamp);
    }
    expect(often.line()).toEqual(once.line());
  });

  it("keeps the newest stamp's offset with ratio 1 when the fitted rate is no device clock's", () => {
    // 2000 ppm is beyond any device's drift: the line keeps ratio 1 at the median offset.
    const clock = new OutputClock();
    for (const stamp of stamps(90, 0))
      clock.observe({ ...stamp, contextTime: stamp.contextTime * 1.002 });
    expect(clock.line()?.ratio).toBe(1);
  });

  it("starts over when the context time goes backwards (a new context's clock)", () => {
    const clock = new OutputClock();
    for (const stamp of stamps(40, 0.1)) clock.observe(stamp);
    expect(clock.observe({ contextTime: 0.5, performanceTime: 9000 })).toBe(true);
    expect(clock.line()).toEqual({ perfMs: 9000, ctxS: 0.5, ratio: 1 });
  });

  it("gates out scattered stamps far off the line, and does not take them for a step", () => {
    const clock = new OutputClock();
    // One stamp in four reads 8 ms late, beyond the 5 ms gate: never three in a row.
    const all = stamps(90, 0.05).map((stamp, index) =>
      index % 4 === 3 ? { ...stamp, performanceTime: stamp.performanceTime + 8 } : stamp,
    );
    for (const stamp of all) clock.observe(stamp);
    const line = clock.line();
    if (!line) throw new Error("No line");
    for (const t of [2600, 2900, 2950])
      expect(Math.abs(contextAt(line, t) - trueCtx(t)) * 1000).toBeLessThan(0.05);
  });

  it("starts over after a reset", () => {
    const clock = new OutputClock();
    for (const stamp of stamps(20, 0)) clock.observe(stamp);
    clock.reset();
    expect(clock.line()).toBeUndefined();
    expect(clock.observe({ contextTime: 1, performanceTime: 100 })).toBe(true);
  });
});

describe("sourceAtContext", () => {
  function anchor(patch: Partial<PlaybackAnchor> = {}): PlaybackAnchor {
    return { startCtxS: 10.05, startSourceMs: 1000, rate: 1, loop: null, endMs: 9000, ...patch };
  }

  it("holds the start position before the start, then runs at the playback rate", () => {
    expect(sourceAtContext(anchor(), 10)).toBe(1000);
    expect(sourceAtContext(anchor(), 10.1)).toBeCloseTo(1050, 9);
    expect(sourceAtContext(anchor({ rate: 0.5 }), 10.1)).toBeCloseTo(1025, 9);
  });

  it("stops at the end of a non-looping source", () => {
    expect(sourceAtContext(anchor({ endMs: 1020 }), 10.1)).toBe(1020);
  });

  it("wraps a loop only after its first boundary, so pre-roll before it shows as played", () => {
    const loop = { startMs: 1100, endMs: 1300 };
    expect(sourceAtContext(anchor({ loop }), 10.2)).toBeCloseTo(1150, 9);
    expect(sourceAtContext(anchor({ loop }), 10.4)).toBeCloseTo(1150, 9);
    expect(wrapLoop(1700, loop)).toBeCloseTo(1100, 9);
    expect(wrapLoop(1050, loop)).toBe(1050);
  });
});
