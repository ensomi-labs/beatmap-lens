import { describe, expect, it } from "vitest";
import {
  createRenderScene,
  type LinearRenderTimeProjection,
  type PiecewiseLinearRenderTimeProjection,
  parseOsu,
  projectTime,
  toManiaChart,
  unprojectTime,
} from "../src/index.js";
import { createRenderSceneFromProjection, resolveRenderSceneStyle } from "../src/render-scene.js";

const directions = ["bottom-to-top", "top-to-bottom"] as const;

function projection(direction: (typeof directions)[number]): LinearRenderTimeProjection {
  return {
    type: "linear",
    range: { startMs: -1250, endMs: 2750 },
    direction,
    pixelsPerSecond: 125,
    contentTopPx: 17.5,
    contentHeightPx: 500,
  };
}

function piecewiseProjection(
  direction: (typeof directions)[number],
): PiecewiseLinearRenderTimeProjection {
  return {
    type: "piecewise-linear",
    range: { startMs: -1_000, endMs: 5_000 },
    direction,
    contentTopPx: 17.5,
    contentHeightPx: 400,
    basePixelsPerSecond: 100,
    anchors: [
      { timeMs: -1_000, distancePx: 0 },
      { timeMs: 0, distancePx: 200 },
      { timeMs: 1_000, distancePx: 320 },
      { timeMs: 5_000, distancePx: 400 },
    ],
    compressedRanges: [{ startMs: 1_000, endMs: 5_000 }],
  };
}

describe("render time projection", () => {
  it("accepts fixed viewport arithmetic without accepting a different linear scale", () => {
    const startMs = 136_781.333;
    const pixelsPerSecond = 1783.9442751414892;
    const current: LinearRenderTimeProjection = {
      type: "linear",
      range: { startMs, endMs: startMs + (768 * 1000) / pixelsPerSecond },
      direction: "bottom-to-top",
      pixelsPerSecond,
      contentTopPx: 24,
      contentHeightPx: 768,
    };
    expect(projectTime(current, startMs)).toBe(792);
    expect(projectTime(current, current.range.endMs)).toBe(24);
    expect(unprojectTime(current, projectTime(current, startMs + 100))).toBeCloseTo(
      startMs + 100,
      9,
    );
    expect(() => projectTime({ ...current, contentHeightPx: 769 }, startMs)).toThrow(RangeError);
  });

  it.each([
    ["top-to-bottom", [17.5, 267.5, 517.5]],
    ["bottom-to-top", [517.5, 267.5, 17.5]],
  ] as const)("projects endpoints and midpoint %s", (direction, expected) => {
    const current = projection(direction);

    expect([-1250, 750, 2750].map((timeMs) => projectTime(current, timeMs))).toEqual(expected);
  });

  it.each(directions)("round-trips non-zero and negative source times %s", (direction) => {
    const current = projection(direction);

    for (const timeMs of [-1250, -999.75, 0, 750, 1533.33, 2750]) {
      expect(
        Math.abs(unprojectTime(current, projectTime(current, timeMs)) - timeMs),
      ).toBeLessThanOrEqual(1e-9);
    }
  });

  it.each([
    ["top-to-bottom", [17.5, 217.5, 337.5, 417.5]],
    ["bottom-to-top", [417.5, 217.5, 97.5, 17.5]],
  ] as const)("projects piecewise anchors %s", (direction, expected) => {
    const current = piecewiseProjection(direction);

    expect([-1_000, 0, 1_000, 5_000].map((timeMs) => projectTime(current, timeMs))).toEqual(
      expected,
    );
  });

  it.each(directions)("round-trips every piecewise segment %s", (direction) => {
    const current = piecewiseProjection(direction);

    for (const timeMs of [-1_000, -999.75, -500, 0, 333.33, 1_000, 3_246.5, 5_000]) {
      expect(
        Math.abs(unprojectTime(current, projectTime(current, timeMs)) - timeMs),
      ).toBeLessThanOrEqual(1e-9);
    }
    for (const distancePx of [0, 0.25, 100, 200, 250.5, 320, 390.25, 400]) {
      const yPx =
        direction === "top-to-bottom"
          ? current.contentTopPx + distancePx
          : current.contentTopPx + current.contentHeightPx - distancePx;
      expect(Math.abs(projectTime(current, unprojectTime(current, yPx)) - yPx)).toBeLessThanOrEqual(
        1e-9,
      );
    }
  });

  it.each([
    [
      "time",
      [
        { timeMs: -1_000, distancePx: 0 },
        { timeMs: 0, distancePx: 200 },
        { timeMs: 0, distancePx: 320 },
        { timeMs: 5_000, distancePx: 400 },
      ],
    ],
    [
      "distance",
      [
        { timeMs: -1_000, distancePx: 0 },
        { timeMs: 0, distancePx: 200 },
        { timeMs: 1_000, distancePx: 200 },
        { timeMs: 5_000, distancePx: 400 },
      ],
    ],
  ] as const)("rejects piecewise anchors without strictly increasing %s", (_, anchors) => {
    const current = { ...piecewiseProjection("top-to-bottom"), anchors };

    expect(() => projectTime(current, 500)).toThrowError(
      "Piecewise projection anchors must be finite and strictly increasing.",
    );
  });

  it("rejects piecewise anchors that do not match the projection boundaries", () => {
    const current = piecewiseProjection("top-to-bottom");
    const first = current.anchors[0] as (typeof current.anchors)[number];
    const last = current.anchors.at(-1) as (typeof current.anchors)[number];
    const malformed = [
      {
        ...current,
        anchors: [{ ...first, timeMs: current.range.startMs + 1 }, ...current.anchors.slice(1)],
      },
      {
        ...current,
        anchors: [{ ...first, distancePx: 1 }, ...current.anchors.slice(1)],
      },
      {
        ...current,
        anchors: [...current.anchors.slice(0, -1), { ...last, timeMs: current.range.endMs - 1 }],
      },
      {
        ...current,
        anchors: [...current.anchors.slice(0, -1), { ...last, distancePx: 399 }],
      },
    ] satisfies readonly PiecewiseLinearRenderTimeProjection[];

    for (const projection of malformed) {
      expect(() => projectTime(projection, 500)).toThrowError(
        "Render time projection must contain finite, consistent geometry.",
      );
      expect(() => unprojectTime(projection, projection.contentTopPx + 1)).toThrowError(
        "Render time projection must contain finite, consistent geometry.",
      );
    }
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid piecewise base pixels per second %s",
    (basePixelsPerSecond) => {
      const current = { ...piecewiseProjection("top-to-bottom"), basePixelsPerSecond };

      expect(() => projectTime(current, 500)).toThrowError(
        "Render time projection must contain finite, consistent geometry.",
      );
    },
  );

  it("rejects a piecewise content height that does not match the final anchor", () => {
    const current = { ...piecewiseProjection("top-to-bottom"), contentHeightPx: 401 };
    const chart = toManiaChart(
      parseOsu(`osu file format v14

[General]
Mode:3

[Difficulty]
CircleSize:4

[HitObjects]
`),
    );
    const style = resolveRenderSceneStyle(chart);

    expect(() => createRenderSceneFromProjection(chart, current, style)).toThrowError(
      "Render time projection must contain finite, consistent geometry.",
    );
  });

  it.each([136_781, 139_056, 279_101])(
    "round-trips real-corpus projection endpoints exactly for a %ims range",
    (endMs) => {
      for (const direction of directions) {
        const current: LinearRenderTimeProjection = {
          type: "linear",
          range: { startMs: 0, endMs },
          direction,
          pixelsPerSecond: 240,
          contentTopPx: 24,
          contentHeightPx: (endMs * 240) / 1_000,
        };
        const contentBottomPx = current.contentTopPx + current.contentHeightPx;

        for (const timeMs of [current.range.startMs, current.range.endMs]) {
          expect(unprojectTime(current, projectTime(current, timeMs))).toBe(timeMs);
        }
        for (const yPx of [current.contentTopPx, contentBottomPx]) {
          expect(projectTime(current, unprojectTime(current, yPx))).toBe(yPx);
        }
      }
    },
  );

  it.each(directions)("rejects non-finite and out-of-domain times %s", (direction) => {
    const current = projection(direction);

    for (const timeMs of [
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      -1250.1,
      2750.1,
    ]) {
      expect(() => projectTime(current, timeMs)).toThrowError(RangeError);
    }
  });

  it.each(directions)("rejects non-finite and out-of-domain Y coordinates %s", (direction) => {
    const current = projection(direction);

    for (const yPx of [
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      17.4,
      517.6,
    ]) {
      expect(() => unprojectTime(current, yPx)).toThrowError(RangeError);
    }
  });

  it("does not impose a minimum height on a short range", () => {
    const chart = toManiaChart(
      parseOsu(`osu file format v14

[General]
Mode:3

[Difficulty]
CircleSize:4

[HitObjects]
64,192,1000,1,0,0:0:0:0:
`),
    );
    const scene = createRenderScene(chart, {
      range: { startMs: 1000, endMs: 1001 },
      pixelsPerSecond: 240,
    });
    const { projection } = scene;

    expect(projection.contentHeightPx).toBe(0.24);
    expect(scene.lanes[0]?.height).toBe(0.24);
    expect(Math.abs(projectTime(projection, 1001) - projectTime(projection, 1000))).toBeCloseTo(
      0.24,
      12,
    );
  });

  it.each(directions)("clips a crossing long note before projecting it %s", (direction) => {
    const chart = toManiaChart(
      parseOsu(`osu file format v14

[General]
Mode:3

[Difficulty]
CircleSize:4

[HitObjects]
64,192,500,128,0,2500:0:0:0:0:
`),
    );
    const scene = createRenderScene(chart, {
      range: { startMs: 1000, endMs: 2000 },
      timeDirection: direction,
      pixelsPerSecond: 100,
    });

    expect(scene.notes[0]).toMatchObject({
      startMs: 500,
      endMs: 2500,
      continuesBefore: true,
      continuesAfter: true,
      y: 24,
      height: 100,
    });
  });

  it("builds note glyphs from a canonical piecewise projection", () => {
    const chart = toManiaChart(
      parseOsu(`osu file format v14

[General]
Mode:3

[Difficulty]
CircleSize:4

[HitObjects]
64,192,0,1,0,0:0:0:0:
192,192,1000,128,0,5000:0:0:0:0:
`),
    );
    const projection = piecewiseProjection("top-to-bottom");
    // Full-length tails: the long note spans exactly its projected interval.
    const style = resolveRenderSceneStyle(chart, undefined, { tailShortenMs: 0 });
    const scene = createRenderSceneFromProjection(
      chart,
      { ...projection, contentTopPx: style.metrics.paddingPx.top },
      style,
    );

    expect(scene.projection.type).toBe("piecewise-linear");
    expect(scene.size).toEqual({ widthPx: 640, heightPx: 448 });
    expect(scene.notes.map(({ y, height }) => [y, height])).toEqual([
      [220, 8],
      [344, 80],
    ]);
  });

  it("validates a piecewise projection once before projecting many glyphs", () => {
    const anchorCount = 1_025;
    const rawAnchors = Array.from({ length: anchorCount }, (_, timeMs) => ({
      timeMs,
      distancePx: timeMs,
    }));
    let anchorReadCount = 0;
    const anchors = new Proxy(rawAnchors, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) anchorReadCount += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const hitObjects = Array.from({ length: 128 }, (_, index) => {
      const timeMs = 896 + index;
      return `${64 + (index % 4) * 128},192,${timeMs},1,0,0:0:0:0:`;
    }).join("\n");
    const chart = toManiaChart(
      parseOsu(`osu file format v14

[General]
Mode:3

[Difficulty]
CircleSize:4

[HitObjects]
${hitObjects}
`),
    );
    const style = resolveRenderSceneStyle(chart);
    const projection: PiecewiseLinearRenderTimeProjection = {
      type: "piecewise-linear",
      range: { startMs: 0, endMs: anchorCount - 1 },
      direction: "top-to-bottom",
      contentTopPx: style.metrics.paddingPx.top,
      contentHeightPx: anchorCount - 1,
      basePixelsPerSecond: 1_000,
      anchors,
      compressedRanges: [],
    };

    const scene = createRenderSceneFromProjection(chart, projection, style);

    expect(scene.notes).toHaveLength(128);
    expect(anchorReadCount).toBeGreaterThanOrEqual(anchorCount);
    expect(anchorReadCount).toBeLessThan(anchorCount * 10);
  });
});
