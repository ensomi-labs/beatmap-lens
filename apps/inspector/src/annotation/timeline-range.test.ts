import type { ManiaNote } from "beatmap-lens";
import { describe, expect, it } from "vitest";
import { ManiaNoteTimeIndex } from "./note-time-index";
import {
  beginTimelineViewportPan,
  centerTimelineViewportRange,
  classifyTimelineGesture,
  createTimelineRange,
  formatTimelineRangeLabels,
  formatTimelineRangeTime,
  hitTimelineRangeTarget,
  moveTimelineRange,
  panTimelineViewportRange,
  parseTimeInput,
  resizeTimelineRange,
  timelineEdgeHitHeight,
  timelineRangeBodyContainsY,
  timelineRangeOutOfView,
  timelineRangeVerticalGeometry,
} from "./timeline-range";

describe("timeline range operations", () => {
  const index = new ManiaNoteTimeIndex([
    note("first", 100),
    note("hold", 300, 800, "long"),
    note("last", 1_000),
  ]);
  const options = { chartEndMs: 1_200 };

  it("snaps creation and resize to note onsets and long-note tails", () => {
    expect(createTimelineRange(110, 790, index, options)).toEqual({
      startMs: 100,
      endMs: 800,
    });
    expect(resizeTimelineRange({ startMs: 100, endMs: 500 }, "end", 790, index, options)).toEqual({
      startMs: 100,
      endMs: 800,
    });
  });

  it("moves a range without changing its duration and snaps its nearest edge", () => {
    expect(moveTimelineRange({ startMs: 100, endMs: 200 }, 190, index, options)).toEqual({
      startMs: 300,
      endMs: 400,
    });
  });

  it("supports modifier-assisted free millisecond placement", () => {
    expect(
      createTimelineRange(110.25, 790.75, index, {
        ...options,
        freePlacement: true,
      }),
    ).toEqual({ startMs: 110.25, endMs: 790.75 });
  });

  it("keeps forty CSS pixels of vertical edge target outside a narrow timeline body", () => {
    const hitHeight = timelineEdgeHitHeight(900, 1_000);

    expect((hitHeight / 1_000) * 900).toBe(40);
  });
});

describe("vertical timeline range geometry", () => {
  const mapping = { viewRange: { startMs: 0, endMs: 1_200 }, height: 120 };

  it("places the range end above the range start on the reversed Y axis", () => {
    expect(timelineRangeVerticalGeometry({ startMs: 300, endMs: 900 }, mapping)).toEqual({
      y: 30,
      height: 60,
      startY: 90,
      endY: 30,
      clippedStart: false,
      clippedEnd: false,
    });
  });

  it("clips ranges to the current timeline lens before creating geometry", () => {
    expect(
      timelineRangeVerticalGeometry(
        { startMs: 100, endMs: 1_100 },
        { viewRange: { startMs: 300, endMs: 900 }, height: 60 },
      ),
    ).toEqual({
      y: 0,
      height: 60,
      startY: 60,
      endY: 0,
      clippedStart: true,
      clippedEnd: true,
    });
  });

  it("reports whether a range is beyond the top or bottom of a zoomed lens", () => {
    const viewRange = { startMs: 300, endMs: 900 };

    expect(timelineRangeOutOfView({ startMs: 950, endMs: 1_000 }, viewRange)).toBe("above");
    expect(timelineRangeOutOfView({ startMs: 100, endMs: 200 }, viewRange)).toBe("below");
    expect(timelineRangeOutOfView({ startMs: 800, endMs: 1_000 }, viewRange)).toBeUndefined();
  });

  it("hits transparent start and end edge zones by nearest vertical edge", () => {
    const geometry = timelineRangeVerticalGeometry(
      { startMs: 490, endMs: 510 },
      {
        viewRange: { startMs: 0, endMs: 1_000 },
        height: 1_000,
      },
    );

    expect(hitTimelineRangeTarget(505, geometry, 40)).toBe("start-edge");
    expect(hitTimelineRangeTarget(495, geometry, 40)).toBe("end-edge");
    expect(timelineRangeBodyContainsY(500, geometry)).toBe(true);
  });

  it("locks gesture routing from the pointerdown hit and modifier snapshot", () => {
    expect(classifyTimelineGesture({ shiftKey: true })).toBe("create-range");
    expect(
      classifyTimelineGesture({
        controlKey: true,
        rangeHit: "start-edge",
        rangeBodyHit: false,
      }),
    ).toBe("resize-start");
    expect(
      classifyTimelineGesture({
        rangeHit: "start-edge",
        rangeBodyHit: false,
      }),
    ).toBe("pan-viewport");
    expect(classifyTimelineGesture({ rangeBodyHit: true })).toBe("move-range");
    expect(classifyTimelineGesture({ controlKey: true })).toBe("noop");
  });
});

describe("timeline viewport pan helpers", () => {
  it("keeps the grab offset when dragging inside the viewport window", () => {
    const panStart = beginTimelineViewportPan(250, { startMs: 200, endMs: 400 }, 1_000);

    expect(panStart).toEqual({
      viewportRange: { startMs: 200, endMs: 400 },
      grabOffsetMs: 50,
    });
    expect(panTimelineViewportRange(300, panStart, 1_000)).toEqual({
      startMs: 250,
      endMs: 450,
    });
  });

  it("recenters the viewport before dragging when the pointer starts outside the window", () => {
    const panStart = beginTimelineViewportPan(800, { startMs: 200, endMs: 400 }, 1_000);

    expect(panStart).toEqual({
      viewportRange: { startMs: 700, endMs: 900 },
      grabOffsetMs: 100,
    });
    expect(panTimelineViewportRange(950, panStart, 1_000)).toEqual({
      startMs: 800,
      endMs: 1_000,
    });
  });

  it("centers a viewport range within chart boundaries", () => {
    expect(centerTimelineViewportRange(50, 200, 1_000)).toEqual({
      startMs: 0,
      endMs: 200,
    });
  });
});

describe("manual timeline input", () => {
  it("parses integer and fractional milliseconds plus mm:ss.mmm", () => {
    expect(parseTimeInput("1250")).toEqual({ ok: true, valueMs: 1_250 });
    expect(parseTimeInput("1250.5")).toEqual({ ok: true, valueMs: 1_250.5 });
    expect(parseTimeInput("02:03.045")).toEqual({ ok: true, valueMs: 123_045 });
  });

  it("rejects a blank boundary instead of coercing it to zero", () => {
    expect(parseTimeInput("   ")).toEqual({
      error: "Use milliseconds or mm:ss.mmm.",
      ok: false,
    });
  });
});

describe("timeline display labels", () => {
  it("formats selection endpoints at tenth-second precision", () => {
    expect(formatTimelineRangeTime(0)).toBe("00:00.0");
    expect(formatTimelineRangeTime(123_456)).toBe("02:03.5");
    expect(formatTimelineRangeTime(59_950)).toBe("01:00.0");
    expect(formatTimelineRangeLabels({ startMs: 1_234, endMs: 5_678 })).toEqual({
      start: "00:01.2",
      end: "00:05.7",
    });
  });
});

function note(
  id: string,
  startMs: number,
  endMs = startMs,
  kind: ManiaNote["kind"] = "normal",
): ManiaNote {
  return {
    id,
    kind,
    sourceKind: kind === "long" ? "hold" : "normal",
    column: 0,
    startMs,
    endMs,
    sourceLine: 1,
    x: 64,
    hitSound: 0,
  };
}
