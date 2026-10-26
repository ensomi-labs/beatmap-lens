import { describe, expect, it } from "vitest";
import type { PlaybackAnchor } from "./clock";
import { clickTimes, clickWindow, frameOf, frameTime, planPlay, prerollStart } from "./transport";

describe("frameTime", () => {
  it("is never above its frame, so a start time rounded up lands on the frame itself", () => {
    for (const rate of [44_100, 48_000, 88_200, 96_000])
      for (let frame = 0; frame < 3_000_000; frame += 9_973) {
        const seconds = frameTime(frame, rate);
        expect(seconds * rate).toBeLessThanOrEqual(frame);
        expect(Math.ceil(seconds * rate)).toBe(frame);
        expect(Math.round(seconds * rate)).toBe(frame);
      }
  });
});

describe("planPlay", () => {
  const context = { currentTimeS: 1280 / 44_100, sampleRate: 44_100, leadS: 0.03 };

  it("starts on a whole frame after the lead, at the source's nearest frame", () => {
    const plan = planPlay({ fromMs: 1234.5678, endMs: 2000, rate: 1, loop: null }, context);
    expect(Math.ceil(plan.whenS * 44_100)).toBe(1280 + 1323);
    expect(Math.ceil(plan.offsetS * 44_100)).toBe(frameOf(1234.5678, 44_100));
    expect(plan.anchor.startCtxS).toBe(plan.whenS);
    // The anchor names the frame really played, not the time asked for.
    expect(plan.anchor.startSourceMs).toBeCloseTo((frameOf(1234.5678, 44_100) * 1000) / 44_100, 9);
    expect(plan.stopS).toBeCloseTo(
      plan.whenS + (frameOf(2000, 44_100) - frameOf(1234.5678, 44_100)) / 44_100,
      12,
    );
    expect(plan.loopStartS).toBeNull();
  });

  it("puts loop edges on whole frames, at least one frame apart, and the anchor on them", () => {
    const plan = planPlay(
      { fromMs: 1000, endMs: 3000, rate: 0.5, loop: { startMs: 1000.01, endMs: 1000.02 } },
      context,
    );
    const start = Math.ceil((plan.loopStartS ?? 0) * 44_100);
    const end = Math.ceil((plan.loopEndS ?? 0) * 44_100);
    expect(start).toBe(frameOf(1000.01, 44_100));
    expect(end).toBe(start + 1);
    expect(plan.anchor.loop?.startMs).toBeCloseTo((start * 1000) / 44_100, 9);
    expect(plan.anchor.loop?.endMs).toBeCloseTo((end * 1000) / 44_100, 9);
    expect(plan.stopS).toBeNull();
  });

  it("counts the lead from a current time that is a rounding error off its frame", () => {
    const plan = planPlay(
      { fromMs: 0, endMs: 10, rate: 1, loop: null },
      { ...context, currentTimeS: 1280 / 44_100 + 1e-12 },
    );
    expect(Math.ceil(plan.whenS * 44_100)).toBe(1280 + 1323);
  });
});

describe("prerollStart", () => {
  it("starts early by the pre-roll, clamped at source zero", () => {
    expect(prerollStart(72_000.5, 120)).toBe(71_880.5);
    expect(prerollStart(50, 120)).toBe(0);
  });
});

describe("clickTimes", () => {
  function anchor(patch: Partial<PlaybackAnchor> = {}): PlaybackAnchor {
    return { startCtxS: 10.05, startSourceMs: 1000, rate: 1, loop: null, endMs: 9000, ...patch };
  }

  it("maps source times to context times, scaled by the rate and stopped at the end", () => {
    expect(clickTimes(anchor(), [900, 1000, 1500, 9000, 9500], 0, 100)).toEqual([10.05, 10.55]);
    const slow = clickTimes(anchor({ rate: 0.5 }), [1500], 0, 100);
    expect(slow[0]).toBeCloseTo(11.05, 12);
  });

  it("keeps only the window asked for, so a scheduler can top it up", () => {
    const beats = [1100, 1200, 1300];
    expect(clickTimes(anchor(), beats, 10.1, 10.2)).toHaveLength(1);
    expect(clickTimes(anchor(), beats, 10.2, 10.3)).toHaveLength(1);
    expect(clickTimes(anchor(), beats, 10.3, 10.4)).toHaveLength(1);
    expect(clickTimes(anchor(), beats, 10.4, 11)).toHaveLength(0);
  });

  it("plays the first pass from the start, then the loop region again and again", () => {
    const loop = { startMs: 1100, endMs: 1300 };
    const times = clickTimes(anchor({ loop }), [1050, 1200], 0, 10.05 + 0.75);
    const expected = [10.1, 10.25, 10.45, 10.65];
    expect(times).toHaveLength(expected.length);
    for (const [index, time] of times.entries())
      expect(time).toBeCloseTo(expected[index] as number, 12);
    const late = clickTimes(anchor({ loop }), [1200], 20, 20.2);
    expect(late).toHaveLength(1);
    expect(late[0]).toBeCloseTo(20.05, 9);
  });
});

describe("clickWindow", () => {
  it("fills up to the lookahead, never closer to now than the margin", () => {
    expect(clickWindow(10, 0, 1, 0.02)).toEqual({ fromS: 10.02, toS: 11 });
    expect(clickWindow(10, 10.5, 1, 0.02)).toEqual({ fromS: 10.5, toS: 11 });
    expect(clickWindow(10, 11, 1, 0.02)).toBeNull();
  });

  it("drops what a stall made late instead of starting it late", () => {
    // Scheduled up to 10.5 s, then the main thread stalled until 10.9 s.
    expect(clickWindow(10.9, 10.5, 1, 0.02)?.fromS).toBeCloseTo(10.92, 12);
  });
});
