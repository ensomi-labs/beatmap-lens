import { describe, expect, it } from "vitest";
import { heardSourceMs, type PlaybackAnchor, prerollStart, wrapLoop } from "./output-clock";

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
