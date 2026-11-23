import { describe, expect, it } from "vitest";
import {
  advanceHorizontalEdgeScroll,
  advanceTimeViewEdgeScroll,
  createEdgeAutoScrollController,
  createTimeViewEdgeAutoScroller,
  edgeAutoScrollZonePx,
  horizontalClientEdgePenetration,
  horizontalEdgePenetration,
  horizontalEdgeVelocityMsPerSecond,
  horizontalPointerX,
} from "./edge-auto-scroll";
import type { TimeView } from "./time-view";

describe("horizontal edge auto-scroll math", () => {
  const rect = { left: 100, right: 900, width: 800 };

  it("clamps captured clientX to the stage rect before projecting to local coordinates", () => {
    expect(horizontalPointerX({ clientX: 300, rect })).toEqual({
      clampedClientX: 300,
      localX: 200,
    });
    expect(horizontalPointerX({ clientX: 40, rect })).toEqual({
      clampedClientX: 100,
      localX: 0,
    });
    expect(horizontalPointerX({ clientX: 980, rect, stageWidthPx: 1600 })).toEqual({
      clampedClientX: 900,
      localX: 1600,
    });
  });

  it("uses a 40 px edge zone on both sides and clamps outside coordinates to full penetration", () => {
    expect(edgeAutoScrollZonePx).toBe(40);
    expect(horizontalEdgePenetration({ localX: 20, widthPx: 800 })).toEqual({
      edge: "left",
      penetrationPx: 20,
      penetrationRatio: 0.5,
    });
    expect(horizontalEdgePenetration({ localX: -15, widthPx: 800 })).toEqual({
      edge: "left",
      penetrationPx: 40,
      penetrationRatio: 1,
    });
    expect(horizontalEdgePenetration({ localX: 780, widthPx: 800 })).toEqual({
      edge: "right",
      penetrationPx: 20,
      penetrationRatio: 0.5,
    });
    expect(horizontalClientEdgePenetration({ clientX: 925, rect })).toEqual({
      edge: "right",
      penetrationPx: 40,
      penetrationRatio: 1,
    });
    expect(horizontalEdgePenetration({ localX: 40, widthPx: 800 })).toBeUndefined();
    expect(horizontalEdgePenetration({ localX: 760, widthPx: 800 })).toBeUndefined();
    expect(horizontalEdgePenetration({ localX: 400, widthPx: 800 })).toBeUndefined();
  });

  it("computes quadratic signed velocity p * p * visibleDurationMs", () => {
    expect(
      horizontalEdgeVelocityMsPerSecond(
        { edge: "right", penetrationPx: 20, penetrationRatio: 0.5 },
        4_000,
      ),
    ).toBe(1_000);
    expect(
      horizontalEdgeVelocityMsPerSecond(
        { edge: "left", penetrationPx: 20, penetrationRatio: 0.5 },
        4_000,
      ),
    ).toBe(-1_000);
    expect(
      horizontalEdgeVelocityMsPerSecond(
        { edge: "right", penetrationPx: 40, penetrationRatio: 1 },
        4_000,
      ),
    ).toBe(4_000);
    expect(horizontalEdgeVelocityMsPerSecond(undefined, 4_000)).toBe(0);
  });

  it("advances and clamps horizontal windows and TimeViews against track bounds", () => {
    expect(
      advanceHorizontalEdgeScroll({
        startMs: 2_000,
        visibleDurationMs: 4_000,
        bounds: { startMs: 0, endMs: 10_000 },
        elapsedMs: 250,
        penetration: { edge: "right", penetrationPx: 20, penetrationRatio: 0.5 },
      }),
    ).toEqual({
      startMs: 2_250,
      deltaMs: 250,
      velocityMsPerSecond: 1_000,
      atBoundary: false,
    });

    expect(
      advanceTimeViewEdgeScroll({
        view: { startMs: 5_900, msPerPx: 4 },
        widthPx: 1_000,
        bounds: { startMs: 0, endMs: 10_000 },
        elapsedMs: 500,
        penetration: { edge: "right", penetrationPx: 40, penetrationRatio: 1 },
      }),
    ).toEqual({
      view: { startMs: 6_000, msPerPx: 4 },
      deltaMs: 100,
      velocityMsPerSecond: 4_000,
      atBoundary: true,
    });
  });
});

describe("rAF edge auto-scroll controller", () => {
  function fakeRaf() {
    let nextId = 1;
    const pending = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    return {
      pending,
      cancelled,
      requestFrame: (callback: FrameRequestCallback) => {
        const id = nextId++;
        pending.set(id, callback);
        return id;
      },
      cancelFrame: (id: number) => {
        cancelled.push(id);
        pending.delete(id);
      },
      flushNext(timestampMs: number) {
        const first = pending.entries().next().value as [number, FrameRequestCallback] | undefined;
        if (!first) return false;
        pending.delete(first[0]);
        first[1](timestampMs);
        return true;
      },
    };
  }

  it("schedules rAF only while inside the edge zone and cancels immediately on exit or stop", () => {
    const raf = fakeRaf();
    const steps: { edge: string; elapsedMs: number }[] = [];
    const controller = createEdgeAutoScrollController({
      requestFrame: raf.requestFrame,
      cancelFrame: raf.cancelFrame,
      onFrame({ penetration, elapsedMs }) {
        steps.push({ edge: penetration.edge, elapsedMs });
        return true;
      },
    });

    // Middle of stage: zero rAF scheduled.
    expect(controller.update({ localX: 300, widthPx: 800 })).toBeUndefined();
    expect(controller.active).toBe(false);
    expect(raf.pending.size).toBe(0);

    // Enter right edge zone: schedules exactly one rAF even across repeated pointermove updates.
    controller.update({ localX: 780, widthPx: 800 });
    controller.update({ localX: 790, widthPx: 800 });
    expect(controller.active).toBe(true);
    expect(raf.pending.size).toBe(1);

    // Run two frames while holding pointer in the edge zone.
    raf.flushNext(100);
    expect(steps).toEqual([{ edge: "right", elapsedMs: 16.7 }]);
    expect(raf.pending.size).toBe(1);

    raf.flushNext(120);
    expect(steps).toEqual([
      { edge: "right", elapsedMs: 16.7 },
      { edge: "right", elapsedMs: 20 },
    ]);
    expect(raf.pending.size).toBe(1);

    // Move pointer back out of the edge zone: cancels pending rAF at once.
    expect(controller.update({ localX: 500, widthPx: 800 })).toBeUndefined();
    expect(controller.active).toBe(false);
    expect(raf.pending.size).toBe(0);
    expect(raf.cancelled).toHaveLength(1);

    // Re-enter left edge zone, then stop() on pointerup.
    controller.update({ localX: 10, widthPx: 800 });
    expect(controller.active).toBe(true);
    controller.stop();
    expect(controller.active).toBe(false);
    expect(raf.pending.size).toBe(0);
  });

  it("scrolls a TimeView, reports clamped pointerTimeMs, and stops rAF at the track boundary", () => {
    const raf = fakeRaf();
    let view: TimeView = { startMs: 5_500, msPerPx: 4 };
    const updates: { startMs: number; pointerTimeMs: number }[] = [];

    const scroller = createTimeViewEdgeAutoScroller({
      requestFrame: raf.requestFrame,
      cancelFrame: raf.cancelFrame,
      getContext: () => ({
        view,
        widthPx: 1_000,
        bounds: { startMs: 0, endMs: 10_000 },
      }),
      onScroll(next) {
        view = next.view;
        updates.push({ startMs: next.view.startMs, pointerTimeMs: next.pointerTimeMs });
      },
    });

    // Pointer dragged beyond right edge (localX = 1020 -> full penetration, clampedX = 1000).
    scroller.update({ localX: 1_020, widthPx: 1_000 });
    expect(scroller.active).toBe(true);

    // First frame (16.7 ms at 4000 ms/s -> +66.8 ms).
    raf.flushNext(1_000);
    expect(view.startMs).toBeCloseTo(5_566.8, 6);
    expect(updates[0]?.pointerTimeMs).toBeCloseTo(9_566.8, 6);
    expect(scroller.active).toBe(true);

    // Large frame (clamped to 64 ms -> +256 ms) then walk to the boundary at startMs = 6000.
    for (let ts = 1_050; scroller.active && ts <= 1_500; ts += 50) {
      raf.flushNext(ts);
    }
    expect(view.startMs).toBe(6_000);
    expect(updates.at(-1)?.pointerTimeMs).toBe(10_000);
    // Boundary reached: no idle rAF remains scheduled.
    expect(scroller.active).toBe(false);
    expect(raf.pending.size).toBe(0);
  });
});
