import { describe, expect, it } from "vitest";
import { type ClockLine, contextAt, type PlaybackAnchor, sourceAtContext } from "./clock";
import {
  followView,
  motionAt,
  nextFollowCheckMs,
  motionSegments,
  needsResync,
  type PlayheadMotion,
  planMotion,
} from "./display";

// The output reported context time 10 s at page time 5000 ms; the audio clock runs 30 ppm slow.
const line: ClockLine = { perfMs: 5000, ctxS: 10, ratio: 1 - 30e-6 };

function anchor(patch: Partial<PlaybackAnchor> = {}): PlaybackAnchor {
  return { startCtxS: 10.05, startSourceMs: 1000, rate: 1, loop: null, endMs: 9000, ...patch };
}

/** What the frame at `frameMs` shows, straight from the clock model. */
function direct(a: PlaybackAnchor, frameMs: number, offsetMs: number) {
  return sourceAtContext(a, contextAt(line, frameMs - offsetMs));
}

describe("planMotion", () => {
  it("shows what the clock model says was heard at the frame time minus the offset", () => {
    const cases = [
      anchor(),
      anchor({ rate: 0.5 }),
      anchor({ endMs: 1120 }),
      anchor({ loop: { startMs: 1100, endMs: 1300 } }),
      anchor({ rate: 0.75, loop: { startMs: 1000.0208, endMs: 1013.3542 } }),
    ];
    for (const a of cases)
      for (const offsetMs of [0, 12, -8])
        for (let frameMs = 4990; frameMs < 6500; frameMs += 7.31)
          expect(motionAt(planMotion(a, line, offsetMs), frameMs)).toBeCloseTo(
            direct(a, frameMs, offsetMs),
            6,
          );
  });

  it("applies the offset in page ms before the rate: positive moves the bar earlier", () => {
    const at = (a: PlaybackAnchor, offsetMs: number) =>
      motionAt(planMotion(a, { perfMs: 5000, ctxS: 10, ratio: 1 }, offsetMs), 5100);
    expect(at(anchor(), 0)).toBeCloseTo(1050, 9);
    expect(at(anchor(), 12)).toBeCloseTo(1038, 9);
    // 12 page ms at half speed are 6 ms of source.
    expect(at(anchor({ rate: 0.5 }), 12)).toBeCloseTo(1019, 9);
    expect(at(anchor({ rate: 0.5 }), -8)).toBeCloseTo(1029, 9);
  });

  it("depends only on the frame time, so it is a straight line at any frame cadence", () => {
    // Borrowed from ensomi-runtime's tick-independence tests (crates/gameplay/tests/conformance.rs,
    // fixtures_do_not_depend_on_the_advance_schedule, at edf4066): the same answer under any
    // schedule. Here the schedule is the frame cadence and how late each frame's code runs.
    const motion = planMotion(anchor(), line, 0);
    for (const intervalMs of [1000 / 60, 1000 / 120, 1000 / 47]) {
      const frames = Array.from({ length: 120 }, (_, index) => 5100 + index * intervalMs);
      const shown = frames.map((frameMs) => motionAt(motion, frameMs));
      for (const [index, timeMs] of shown.entries()) {
        const expected = 1000 + ((frames[index] as number) - motion.startPerfMs) * motion.speed;
        expect(timeMs).toBeCloseTo(expected, 9);
      }
    }
  });
});

describe("motionSegments", () => {
  /** Evaluates the pieces the compositor runs, the hold before them and the end after. */
  function evaluate(motion: PlayheadMotion, perfMs: number): number {
    const segments = motionSegments(motion);
    let shown = motion.holdMs;
    for (const segment of segments) {
      const elapsed = perfMs - segment.startPerfMs;
      if (elapsed < 0) break;
      const passes = elapsed / segment.durationMs;
      if (passes >= segment.iterations) {
        if (segment.holdEnd) shown = segment.toMs;
        continue;
      }
      const fraction = passes - Math.floor(passes);
      shown = segment.fromMs + (segment.toMs - segment.fromMs) * fraction;
    }
    return shown;
  }

  it("reproduces the motion: a first pass, then the loop repeated or the end held", () => {
    for (const a of [
      anchor({ endMs: 1500 }),
      anchor({ rate: 0.5, loop: { startMs: 1100, endMs: 1300 } }),
    ]) {
      const motion = planMotion(a, line, 4);
      for (let perfMs = 5000; perfMs < 8000; perfMs += 13.7)
        expect(evaluate(motion, perfMs)).toBeCloseTo(motionAt(motion, perfMs), 6);
    }
  });

  it("starts the loop where the first pass ends", () => {
    const motion = planMotion(anchor({ loop: { startMs: 1100, endMs: 1300 } }), line, 0);
    const [first, loop] = motionSegments(motion);
    expect(loop?.startPerfMs).toBeCloseTo((first?.startPerfMs ?? 0) + (first?.durationMs ?? 0), 9);
    expect(loop?.iterations).toBe(Number.POSITIVE_INFINITY);
    expect(first?.holdEnd).toBe(false);
  });
});

describe("needsResync", () => {
  const motion = planMotion(anchor(), line, 0);

  it("restarts the animation for a new play, loop or offset", () => {
    expect(needsResync(undefined, motion, 5100)).toBe(true);
    expect(needsResync(motion, planMotion(anchor({ endMs: 8000 }), line, 0), 5100)).toBe(true);
    expect(needsResync(motion, planMotion(anchor(), line, 1), 5100)).toBe(true);
  });

  it("keeps it through refits that move the playhead by less than a quarter of a millisecond", () => {
    expect(needsResync(motion, { ...motion }, 5100)).toBe(false);
    const refit = planMotion(anchor(), { ...line, ratio: line.ratio + 2e-6, ctxS: 10.0001 }, 0);
    expect(needsResync(motion, refit, 5100)).toBe(false);
    const moved = planMotion(anchor(), { ...line, ctxS: 10.0003 }, 0);
    expect(needsResync(motion, moved, 5100)).toBe(true);
  });
});

describe("followView", () => {
  const view = { startMs: 1000, msPerPx: 2 };

  it("jumps once the playhead leaves the view, putting it near the left edge", () => {
    expect(followView(view, 1500, 500, 120)).toBeUndefined();
    expect(followView(view, 2001, 500, 120)).toEqual({ startMs: 2001 - 150, msPerPx: 2 });
  });

  it("does not move for the pre-roll just left of the view", () => {
    expect(followView(view, 900, 500, 120)).toBeUndefined();
    expect(followView(view, 800, 500, 120)).toEqual({ startMs: 800 - 150, msPerPx: 2 });
  });
});

describe("nextFollowCheckMs", () => {
  // Shown from page time 1000 ms at source 1000 ms, full speed, looping 1100-1300 after 1300.
  const motion: PlayheadMotion = {
    startPerfMs: 1000,
    holdMs: 1000,
    speed: 1,
    firstEndMs: 1300,
    loop: { startMs: 1100, endMs: 1300 },
  };
  const view = { startMs: 900, msPerPx: 1 };

  it("waits for the start, then the right edge, then each wrap", () => {
    expect(nextFollowCheckMs(motion, view, 1000, 500)).toBe(1000);
    // The edge is at 1900 ms of source, beyond the loop: only the wraps matter.
    expect(nextFollowCheckMs(motion, view, 1000, 1100)).toBe(1300);
    expect(nextFollowCheckMs(motion, view, 1000, 1350)).toBe(1500);
    // A narrow view's edge at 1150 ms of source is crossed at 1150 on the first pass, at 1350 later.
    expect(nextFollowCheckMs(motion, view, 250, 1100)).toBe(1150);
    expect(nextFollowCheckMs(motion, view, 250, 1320)).toBe(1350);
  });

  it("has nothing to wait for once a non-looping play ends inside the view", () => {
    const once = { ...motion, loop: null };
    expect(nextFollowCheckMs(once, view, 1000, 1100)).toBe(Number.POSITIVE_INFINITY);
    expect(nextFollowCheckMs(once, view, 250, 1100)).toBe(1150);
    expect(nextFollowCheckMs(once, view, 250, 1400)).toBe(Number.POSITIVE_INFINITY);
  });
});
