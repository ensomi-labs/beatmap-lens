import { describe, expect, it } from "vitest";
import {
  clampView,
  fitView,
  formatSourceTime,
  lineLeft,
  msDecimals,
  msToX,
  placeAt,
  tickStepMs,
  ticks,
  xToMs,
  zoomAt,
  zoomLimits,
} from "./time-view";

describe("time mapping", () => {
  it("round-trips times near 600 s at the finest zoom without losing sub-sample detail", () => {
    // Four device pixels per sample at 44.1 kHz on a 2x display.
    const view = { startMs: 599_990.123_456_7, msPerPx: (1000 / 44_100 / 4) * 2 };
    for (const timeMs of [600_000.012_345_6, 599_999.999_999, 600_010.5 + 1 / 44.1]) {
      const x = msToX(view, timeMs);
      expect(Math.abs(xToMs(view, x) - timeMs)).toBeLessThan(1e-9);
    }
    // One sample apart is several pixels apart.
    const a = msToX(view, 600_000);
    const b = msToX(view, 600_000 + 1000 / 44_100);
    expect(b - a).toBeCloseTo(2, 6);
  });

  it("keeps a fractional boundary and a non-integer tempo exact in pixel space", () => {
    const view = { startMs: 70_000.37, msPerPx: 0.25 };
    const beatMs = 60_000 / 127.3;
    const bars = Array.from({ length: 8 }, (_, index) => 70_013.605 + index * beatMs);
    const xs = bars.map((bar) => msToX(view, bar));
    xs.forEach((x, index) => {
      expect(xToMs(view, x)).toBeCloseTo(bars[index] ?? Number.NaN, 9);
    });
    expect((xs[1] ?? 0) - (xs[0] ?? 0)).toBeCloseTo(beatMs / 0.25, 9);
  });
});

describe("zoom and clamps", () => {
  const bounds = { startMs: 68_000, endMs: 89_000 };
  const limits = zoomLimits(bounds, 1000, 44_100, 2);

  it("zooms around an anchor, keeping it at the same x", () => {
    const view = { startMs: 70_000, msPerPx: 10 };
    const anchor = 73_456.789;
    const zoomed = zoomAt(view, anchor, 0.5);
    expect(zoomed.msPerPx).toBe(5);
    expect(msToX(zoomed, anchor)).toBeCloseTo(msToX(view, anchor), 9);
  });

  it("limits zoom to four device pixels per sample and to the whole bounds", () => {
    expect(limits.minMsPerPx).toBeCloseTo((1000 / 44_100 / 4) * 2, 12);
    expect(limits.maxMsPerPx).toBe(21);
    expect(clampView({ startMs: 70_000, msPerPx: 1e-6 }, bounds, 1000, limits).msPerPx).toBe(
      limits.minMsPerPx,
    );
    expect(clampView({ startMs: 70_000, msPerPx: 100 }, bounds, 1000, limits)).toEqual({
      startMs: 68_000,
      msPerPx: 21,
    });
  });

  it("keeps the view inside the bounds", () => {
    expect(clampView({ startMs: 60_000, msPerPx: 10 }, bounds, 1000, limits).startMs).toBe(68_000);
    expect(clampView({ startMs: 88_000, msPerPx: 10 }, bounds, 1000, limits).startMs).toBe(79_000);
  });

  it("fits the passage and places a time at a fraction of the width", () => {
    expect(fitView({ startMs: 70_000, endMs: 85_000 }, 1500)).toEqual({
      startMs: 70_000,
      msPerPx: 10,
    });
    const placed = placeAt({ startMs: 0, msPerPx: 2 }, 10_000, 1000, 0.15);
    expect(msToX(placed, 10_000)).toBeCloseTo(150, 9);
  });
});

describe("line placement", () => {
  it("keeps a crisp line's centre within half a pixel of its time, with no average shift", () => {
    for (const width of [1, 2, 3, 4]) {
      let sum = 0;
      for (let step = 0; step < 100; step++) {
        const x = 40 + step / 100;
        const centre = lineLeft(x, width) + width / 2;
        expect(Math.abs(centre - x)).toBeLessThanOrEqual(0.5);
        expect(Number.isInteger(lineLeft(x, width))).toBe(true);
        sum += centre - x;
      }
      expect(Math.abs(sum / 100)).toBeLessThan(0.01);
    }
  });
});

describe("ruler", () => {
  it("chooses 1-2-5 steps and integer-multiple ticks", () => {
    expect(tickStepMs(10, 80)).toBe(1000);
    expect(tickStepMs(0.006, 80)).toBe(0.5);
    expect(ticks({ startMs: 999.9, endMs: 1001.2 }, 0.5)).toEqual([1000, 1000.5, 1001]);
    expect(msDecimals(1000)).toBe(0);
    expect(msDecimals(0.5)).toBe(1);
    expect(msDecimals(0.02)).toBe(2);
  });

  it("formats source times as mm:ss.mmm with optional sub-millisecond digits", () => {
    expect(formatSourceTime(76_482.3)).toBe("01:16.482");
    expect(formatSourceTime(76_482.3, 1)).toBe("01:16.4823");
    expect(formatSourceTime(59_999.9996)).toBe("01:00.000");
    expect(formatSourceTime(0)).toBe("00:00.000");
  });
});
