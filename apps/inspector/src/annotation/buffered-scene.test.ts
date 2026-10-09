import { type ManiaChart, type ManiaNote, projectTime } from "beatmap-lens";
import { describe, expect, it } from "vitest";
import {
  BufferedSceneController,
  projectSceneRange,
  viewportYToSourceTime,
} from "./buffered-scene";

describe("BufferedSceneController", () => {
  it("builds only a three-viewport note buffer for a dense 7K chart", () => {
    const controller = new BufferedSceneController(denseChart(10_000), {
      viewportHeight: 240,
      width: 420,
      pixelsPerSecond: 240,
    });

    const frame = controller.frame(5_000);
    const counters = controller.instrumentation();

    expect(frame.bufferRange.endMs - frame.bufferRange.startMs).toBe(3_000);
    expect(frame.scene.keyCount).toBe(7);
    expect(frame.scene.projection.direction).toBe("bottom-to-top");
    expect(frame.keyedNotes).toHaveLength(counters.lastBufferedNoteCount);
    expect(counters.lastBufferedNoteCount).toBeLessThanOrEqual(31);
    expect(counters.sceneBuildCount).toBe(1);
  });

  it.each([4, 5, 6, 7])("creates keyed lane geometry for %iK charts", (keyCount) => {
    const controller = new BufferedSceneController(denseChart(100, keyCount), {
      viewportHeight: 240,
      width: 420,
    });

    const frame = controller.frame(1_000);

    expect(frame.keyedLanes.map(({ key }) => key)).toEqual(
      Array.from({ length: keyCount }, (_, column) => `lane-${column}`),
    );
  });

  it("reuses keyed geometry until the playhead crosses a refresh threshold", () => {
    const controller = new BufferedSceneController(denseChart(1_000), {
      viewportHeight: 240,
      width: 420,
      pixelsPerSecond: 240,
    });

    const initial = controller.frame(5_000);
    const inside = controller.frame(initial.refreshThreshold.maximumPlayheadMs);
    const crossed = controller.frame(initial.refreshThreshold.maximumPlayheadMs + 1);

    expect(inside.refreshed).toBe(false);
    expect(inside.scene).toBe(initial.scene);
    expect(inside.keyedNotes).toBe(initial.keyedNotes);
    expect(inside.noteGroupTransform).not.toBe(initial.noteGroupTransform);
    expect(crossed.refreshed).toBe(true);
    expect(crossed.scene).not.toBe(initial.scene);
    expect(controller.instrumentation()).toMatchObject({
      sceneBuildCount: 2,
      reusedFrameCount: 1,
    });
  });

  it("places the playhead note on the fixed 82% judgment line", () => {
    const controller = new BufferedSceneController(denseChart(100), {
      viewportHeight: 240,
      width: 420,
    });

    const frame = controller.frame(5_000);
    const playheadNote = frame.scene.notes.find(({ startMs }) => startMs === 5_000);
    const translationY = Number(frame.noteGroupTransform.match(/translate\(0 (-?[\d.]+)\)/)?.[1]);
    const transformedCenter =
      translationY + (playheadNote?.y ?? 0) + (playheadNote?.height ?? 0) / 2;

    expect(frame.noteGroupTransform).toMatch(/^translate\(0 /);
    expect(transformedCenter).toBe(196.8);
  });

  it("rebuilds immediately when visual speed changes", () => {
    const controller = new BufferedSceneController(denseChart(1_000), {
      viewportHeight: 240,
      width: 420,
    });

    const initial = controller.frame(2_000);
    const faster = controller.setVisualSpeed(480, 2_000);

    expect(faster.refreshed).toBe(true);
    expect(faster.revision).toBe(initial.revision + 1);
    expect(faster.bufferRange.endMs - faster.bufferRange.startMs).toBe(1_500);
  });

  it("passes grouped theme metrics to buffered scenes", () => {
    const controller = new BufferedSceneController(denseChart(100), {
      viewportHeight: 240,
      width: 420,
      theme: {
        metrics: {
          laneGapPx: 6,
          noteHeightPx: 10,
        },
      },
    });

    expect(controller.frame(1_000).scene.metrics).toMatchObject({
      laneGapPx: 6,
      noteHeightPx: 10,
    });
  });
});

describe("viewport source-time projection", () => {
  const projection = {
    type: "linear" as const,
    range: { startMs: 8_000, endMs: 12_000 },
    direction: "bottom-to-top" as const,
    pixelsPerSecond: 250,
    contentTopPx: 24,
    contentHeightPx: 1_000,
  };
  const options = {
    projection,
    playheadMs: 10_000,
    viewportHeight: 500,
    sourceRange: { startMs: 0, endMs: 20_000 },
    judgmentLineRatio: 0.8,
  };

  it("maps the judgment line to the fixed playhead time", () => {
    expect(viewportYToSourceTime({ ...options, viewportY: 400 })).toBe(10_000);
  });

  it("maps the viewport top and bottom to the visible source-time bounds", () => {
    expect(viewportYToSourceTime({ ...options, viewportY: 0 })).toBe(11_600);
    expect(viewportYToSourceTime({ ...options, viewportY: 500 })).toBe(9_600);
  });

  it("clamps projected source time to the chart range", () => {
    const wideProjection = {
      ...projection,
      range: { startMs: -2_000, endMs: 22_000 },
      contentHeightPx: 6_000,
    };
    expect(
      viewportYToSourceTime({
        ...options,
        projection: wideProjection,
        playheadMs: 100,
        viewportY: 500,
      }),
    ).toBe(0);
    expect(
      viewportYToSourceTime({
        ...options,
        projection: wideProjection,
        playheadMs: 19_000,
        viewportY: 0,
      }),
    ).toBe(20_000);
  });

  it.each(["bottom-to-top", "top-to-bottom"] as const)(
    "round-trips pointer Y after a non-zero moving-group translation for %s",
    (direction) => {
      const currentProjection = { ...projection, direction };
      const judgmentY = options.viewportHeight * options.judgmentLineRatio;
      const translateY = judgmentY - projectTime(currentProjection, options.playheadMs);
      const sourceMs = 11_250;
      const viewportY = projectTime(currentProjection, sourceMs) + translateY;

      expect(translateY).not.toBe(0);
      expect(
        viewportYToSourceTime({ ...options, projection: currentProjection, viewportY }),
      ).toBeCloseTo(sourceMs, 9);
    },
  );

  it.each([
    ["bottom-to-top", { y: 774, height: 250 }],
    ["top-to-bottom", { y: 24, height: 250 }],
  ] as const)("projects clipped overlay geometry for %s", (direction, expected) => {
    expect(
      projectSceneRange({ ...projection, direction }, { startMs: 7_500, endMs: 9_000 }),
    ).toEqual(expected);
    expect(
      projectSceneRange({ ...projection, direction }, { startMs: 12_000, endMs: 13_000 }),
    ).toBeUndefined();
  });

  it.each([
    [0, 240],
    [1_000_000, 720],
  ])(
    "normalizes floating error at inclusive buffer boundaries near %ims at %ipx/s",
    (playheadMs, pixelsPerSecond) => {
      const controller = new BufferedSceneController(denseChart(100), {
        viewportHeight: 240,
        width: 420,
        pixelsPerSecond,
      });
      const initial = controller.frame(playheadMs);
      const maximum = initial.refreshThreshold.maximumPlayheadMs;
      const minimum = initial.refreshThreshold.minimumPlayheadMs;
      const maximumFrame = controller.frame(maximum);
      const minimumFrame = controller.frame(minimum);

      expect(
        viewportYToSourceTime({
          projection: maximumFrame.scene.projection,
          playheadMs: maximum,
          viewportHeight: 240,
          viewportY: 0,
        }),
      ).toBe(maximumFrame.scene.projection.range.endMs);
      expect(
        viewportYToSourceTime({
          projection: minimumFrame.scene.projection,
          playheadMs: minimum,
          viewportHeight: 240,
          viewportY: 240,
        }),
      ).toBe(minimumFrame.scene.projection.range.startMs);
    },
  );
});

function denseChart(noteCount: number, keyCount = 7): ManiaChart {
  return {
    keyCount,
    metadata: {},
    notes: Array.from({ length: noteCount }, (_, index) => note(index, keyCount)),
    range: { startMs: 0, endMs: Math.max(1, (noteCount - 1) * 100 + 1) },
    diagnostics: [],
  };
}

function note(index: number, keyCount: number): ManiaNote {
  const startMs = index * 100;
  return {
    id: `note-${index}`,
    kind: "normal",
    sourceKind: "normal",
    column: index % keyCount,
    startMs,
    endMs: startMs,
    sourceLine: index + 1,
    x: 64,
    hitSound: 0,
  };
}
