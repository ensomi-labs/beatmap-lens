import { type ClockLine, type PlaybackAnchor, perfAt, wrapLoop } from "./clock";
import { msToX, placeAt, type TimeView } from "./time-view";

/**
 * Display path of the Timing engine: which source time the playhead shows in the frame that
 * begins at page time `frameMs` (an animation frame's time stamp, or `document.timeline` time).
 *
 * The frame is seen a display delay later, which the page cannot measure but which is constant for
 * a given browser and screen; the listener's playhead offset stands in for it. So the frame shows
 * the source time heard at `frameMs − offsetMs`. The offset is applied here and nowhere else, as
 * ensomi-runtime applies its audio offset exactly once (crates/gameplay/src/session.rs lines 16-22,
 * README lines 29-31, at edf4066). Taps never see it (`input.ts`).
 *
 * The frame time stamp, not the moment the frame's code runs, is the right clock: frames are shown
 * at a fixed cadence from their time stamps, while their callbacks start late by however long the
 * main thread was busy. A position computed from `performance.now()` inside the callback carries
 * that lateness as jitter; one computed from the time stamp does not.
 *
 * Within one play the shown time is a straight line in page time, held before the start, clamped at
 * the end or wrapping in a loop: a `PlayheadMotion`. The stage hands it to the compositor as an
 * animation, so the playhead keeps moving while the main thread is busy.
 */
export interface PlayheadMotion {
  /** Page time at which the shown position leaves `holdMs`. */
  startPerfMs: number;
  /** The source time shown before the start: the first frame played. */
  holdMs: number;
  /** Source ms per page ms: the playback rate times the audio clock's rate. */
  speed: number;
  /** Where the first pass ends: the loop end, or where a non-looping play stops. */
  firstEndMs: number;
  loop: { startMs: number; endMs: number } | null;
}

export function planMotion(
  anchor: PlaybackAnchor,
  line: ClockLine,
  offsetMs: number,
): PlayheadMotion {
  return {
    startPerfMs: perfAt(line, anchor.startCtxS) + offsetMs,
    holdMs: anchor.startSourceMs,
    speed: anchor.rate * line.ratio,
    firstEndMs: anchor.loop ? anchor.loop.endMs : anchor.endMs,
    loop: anchor.loop,
  };
}

/** The position before wrapping or clamping: a straight line through the hold. */
function unwrapped(motion: PlayheadMotion, perfMs: number): number {
  return motion.holdMs + Math.max(0, perfMs - motion.startPerfMs) * motion.speed;
}

/** The source time shown by a frame that begins at `perfMs`. */
export function motionAt(motion: PlayheadMotion, perfMs: number): number {
  const raw = unwrapped(motion, perfMs);
  if (!motion.loop) return Math.min(raw, motion.firstEndMs);
  return wrapLoop(raw, motion.loop);
}

/** One linear piece for the compositor; `iterations` is Infinity for a loop. */
export interface MotionSegment {
  startPerfMs: number;
  durationMs: number;
  fromMs: number;
  toMs: number;
  iterations: number;
  /** A non-looping play holds its end after the last piece. */
  holdEnd: boolean;
}

/** The pieces after the hold: the first pass, then the loop repeated, if there is one. */
export function motionSegments(motion: PlayheadMotion): MotionSegment[] {
  const firstMs = Math.max(0, motion.firstEndMs - motion.holdMs);
  const first: MotionSegment = {
    startPerfMs: motion.startPerfMs,
    durationMs: firstMs / motion.speed,
    fromMs: motion.holdMs,
    toMs: motion.firstEndMs,
    iterations: 1,
    holdEnd: !motion.loop,
  };
  const loop = motion.loop;
  if (!loop) return [first];
  return [
    first,
    {
      startPerfMs: first.startPerfMs + first.durationMs,
      durationMs: (loop.endMs - loop.startMs) / motion.speed,
      fromMs: loop.startMs,
      toMs: loop.endMs,
      iterations: Number.POSITIVE_INFINITY,
      holdEnd: false,
    },
  ];
}

/** A refit moving the playhead by less than this (source ms) keeps the running animation. */
export const resyncToleranceMs = 0.25;

/**
 * Whether `next` shows a different playhead from `current` over the coming `horizonMs`: a new
 * start, loop or end, or a line that has moved by more than the tolerance. The clock fit changes
 * with every output stamp; restarting the compositor's animation for each would cost frames for
 * changes far below a pixel.
 */
export function needsResync(
  current: PlayheadMotion | undefined,
  next: PlayheadMotion,
  nowMs: number,
  horizonMs = 1000,
): boolean {
  if (!current) return true;
  if (
    current.holdMs !== next.holdMs ||
    current.firstEndMs !== next.firstEndMs ||
    current.loop?.startMs !== next.loop?.startMs ||
    current.loop?.endMs !== next.loop?.endMs
  )
    return true;
  return [nowMs, nowMs + horizonMs].some(
    (at) => Math.abs(unwrapped(current, at) - unwrapped(next, at)) > resyncToleranceMs,
  );
}

/** While playing, the HUD's time readout is refreshed at most this often (page ms). */
export const readoutIntervalMs = 100;

/**
 * The view to jump to while following the playhead, or undefined to stay: the view jumps (never
 * scrolls) when the playhead leaves it. The pre-roll may start just left of the view; that alone
 * does not move it.
 */
export function followView(
  view: TimeView,
  timeMs: number,
  widthPx: number,
  prerollMs: number,
): TimeView | undefined {
  const x = msToX(view, timeMs);
  const prerollPx = prerollMs / view.msPerPx;
  if (x < -prerollPx - 1 || x > widthPx) return placeAt(view, timeMs, widthPx, 0.15);
  return undefined;
}
