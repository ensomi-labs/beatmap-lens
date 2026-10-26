import { describe, expect, it } from "vitest";
import {
  clickTimes,
  heardSourceMs,
  type PlaybackAnchor,
  prerollStart,
  wrapLoop,
} from "./output-clock";

// The output reported context time 10 s at performance time 5000 ms.
const stamp = { contextTime: 10, performanceTime: 5000 };

function anchor(patch: Partial<PlaybackAnchor> = {}): PlaybackAnchor {
  return { startCtxS: 10.05, startSourceMs: 1000, rate: 1, loop: null, endMs: 9000, ...patch };
}

describe("heardSourceMs", () => {
  it("extrapolates the output timestamp to now", () => {
    expect(heardSourceMs(anchor(), stamp, 5100, 0)).toBeCloseTo(1050, 9);
  });

  it("scales elapsed output time by the playback rate", () => {
    expect(heardSourceMs(anchor({ rate: 0.5 }), stamp, 5100, 0)).toBeCloseTo(1025, 9);
  });

  it("applies the wall-clock offset before the rate, moving the bar earlier when positive", () => {
    expect(heardSourceMs(anchor(), stamp, 5100, 12)).toBeCloseTo(1038, 9);
    // 12 wall-clock ms at half speed are 6 ms of source.
    expect(heardSourceMs(anchor({ rate: 0.5 }), stamp, 5100, 12)).toBeCloseTo(1019, 9);
    expect(heardSourceMs(anchor({ rate: 0.5 }), stamp, 5100, -8)).toBeCloseTo(1029, 9);
  });

  it("holds the start position until output starts or reaches the scheduled start", () => {
    expect(heardSourceMs(anchor(), { contextTime: 0, performanceTime: 0 }, 5100, 0)).toBe(1000);
    expect(heardSourceMs(anchor(), stamp, 5040, 0)).toBe(1000);
  });

  it("stops at the end of a non-looping source", () => {
    expect(heardSourceMs(anchor({ endMs: 1020 }), stamp, 5100, 0)).toBe(1020);
  });

  it("wraps a loop only after its first boundary, so pre-roll before it shows as played", () => {
    const loop = { startMs: 1100, endMs: 1300 };
    // Started 100 ms before the loop: at 150 ms elapsed it is inside the first pass.
    expect(heardSourceMs(anchor({ loop }), stamp, 5200, 0)).toBeCloseTo(1150, 9);
    // At 350 ms elapsed it passed the end once: 1350 wraps to 1150.
    expect(heardSourceMs(anchor({ loop }), stamp, 5400, 0)).toBeCloseTo(1150, 9);
    expect(wrapLoop(1700, loop)).toBeCloseTo(1100, 9);
    expect(wrapLoop(1050, loop)).toBe(1050);
  });
});

describe("prerollStart", () => {
  it("starts early by the pre-roll, clamped at source zero", () => {
    expect(prerollStart(72_000.5, 120)).toBe(71_880.5);
    expect(prerollStart(50, 120)).toBe(0);
  });
});

describe("clickTimes", () => {
  // Started at context 10.05 s from source 1000 ms.
  it("maps source times to context times, scaled by the rate and stopped at the end", () => {
    expect(clickTimes(anchor(), [900, 1000, 1500, 9000, 9500], 0, 100)).toEqual([10.05, 10.55]);
    const slow = clickTimes(anchor({ rate: 0.5 }), [1500], 0, 100);
    expect(slow[0]).toBeCloseTo(11.05, 12);
  });

  it("keeps only the window asked for, so a scheduler can top it up", () => {
    const beats = [1100, 1200, 1300];
    // At 10.15, 10.25 and 10.35 s.
    expect(clickTimes(anchor(), beats, 10.1, 10.2)).toHaveLength(1);
    expect(clickTimes(anchor(), beats, 10.2, 10.3)).toHaveLength(1);
    expect(clickTimes(anchor(), beats, 10.3, 10.4)).toHaveLength(1);
    expect(clickTimes(anchor(), beats, 10.4, 11)).toHaveLength(0);
  });

  it("plays the first pass from the start, then the loop region again and again", () => {
    const loop = { startMs: 1100, endMs: 1300 };
    // Beats at 1050 (pre-roll, first pass only) and 1200 (every pass).
    const times = clickTimes(anchor({ loop }), [1050, 1200], 0, 10.05 + 0.75);
    // First pass: 1050 at +0.05 s, 1200 at +0.2 s; the loop wraps at +0.3 s and lasts 0.2 s.
    const expected = [10.1, 10.25, 10.45, 10.65];
    expect(times).toHaveLength(expected.length);
    for (const [index, time] of times.entries())
      expect(time).toBeCloseTo(expected[index] as number, 12);
    // A late window starts at the right pass: 10.45 s plus 48 passes of 0.2 s.
    const late = clickTimes(anchor({ loop }), [1200], 20, 20.2);
    expect(late).toHaveLength(1);
    expect(late[0]).toBeCloseTo(20.05, 9);
  });
});
