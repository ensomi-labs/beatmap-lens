import { type ClockLine, type PlaybackAnchor, perfAt, wrapLoop } from "./clock";
import { msToX, placeAt, type TimeView, xToMs } from "./time-view";

/**
 * Display path of the Timing engine: which source time the playhead shows in the frame that
 * begins at page time `frameMs` (an animation frame's time stamp, or `document.timeline` time).
 *
 * The frame is seen a display delay later, which the page cannot measure but which is constant for
 * a given browser and screen; the listener's playhead offset stands in for it. So the frame shows
 * the source time heard at `frameMs − offsetMs`. The offset is applied here and nowhere else, as
 * ensomi-runtime applies its audio offset exactly once (crates/gameplay/src/session.rs lines 16-22
 * and crates/gameplay/README.md lines 29-31, at edf4066). Taps never see it (`input.ts`).
 *
 * The frame time stamp, not the moment the frame's code runs, is the right clock: frames are shown
 * at a fixed cadence from their time stamps, while their callbacks start late by however long the
 * main thread was busy. A position computed from `performance.now()` inside the callback carries
 * that lateness as jitter; one computed from the time stamp does not.
 *
 * Within one play the shown time is a straight line in page time, held before the start, clamped at
 * the end or wrapping in a loop: a `PlayheadMotion`. The stage hands it to the compositor as an
 * animation, so the playhead keeps moving while the main thread is busy. Nothing on the main thread
 * runs per frame while playing: a page that runs an animation-frame loop makes the compositor wait
 * for it, so a stall there would hold the playhead too (measured: docs/inspector/timing-latency.md).
 * The workspace's bookkeeping (clock samples, resync, follow, the HUD readout) runs on a timer.
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
  /**
   * The piece holds its end after it: a non-looping play stays at its end, and the first pass of a
   * loop covers any rounding gap before the loop piece, which overrides it where it runs.
   */
  holdEnd: boolean;
}

/**
 * The compositor keeps animation time in whole microseconds, so each pass of a loop repeated
 * forever may run up to 1 µs short of the motion's (plausible from Chromium's source, not
 * measured), and the drawn playhead would drift ahead over a long loop. The loop piece therefore
 * starts at a recent wrap, and the workspace hands the stage the motion again once it has run this
 * many passes: the drift stays within tens of microseconds.
 */
export const loopReanchorPasses = 32;
/** A new loop piece starts at a wrap at least this much earlier: every frame to come is in it. */
const loopAnchorLeadMs = 100;

/** Page time at which the first pass ends and a loop first wraps. */
function firstWrapPerfMs(motion: PlayheadMotion): number {
  return motion.startPerfMs + Math.max(0, motion.firstEndMs - motion.holdMs) / motion.speed;
}

/**
 * The pieces after the hold: the first pass, then the loop repeated, if there is one, from its
 * latest wrap at least `loopAnchorLeadMs` before `nowMs` (from the first wrap if that is later).
 */
export function motionSegments(
  motion: PlayheadMotion,
  nowMs = Number.NEGATIVE_INFINITY,
): MotionSegment[] {
  const first: MotionSegment = {
    startPerfMs: motion.startPerfMs,
    durationMs: Math.max(0, motion.firstEndMs - motion.holdMs) / motion.speed,
    fromMs: motion.holdMs,
    toMs: motion.firstEndMs,
    iterations: 1,
    holdEnd: true,
  };
  const loop = motion.loop;
  if (!loop) return [first];
  const passMs = (loop.endMs - loop.startMs) / motion.speed;
  const wrapMs = firstWrapPerfMs(motion);
  const passes = Math.max(0, Math.floor((nowMs - loopAnchorLeadMs - wrapMs) / passMs));
  return [
    first,
    {
      startPerfMs: wrapMs + passes * passMs,
      durationMs: passMs,
      fromMs: loop.startMs,
      toMs: loop.endMs,
      iterations: Number.POSITIVE_INFINITY,
      holdEnd: false,
    },
  ];
}

/**
 * Whether a looping motion handed to the stage at `placedAtMs` has run `loopReanchorPasses` passes
 * by `nowMs`, so the stage should start its loop piece again from a recent wrap.
 */
export function loopReanchorDue(
  motion: PlayheadMotion | undefined,
  placedAtMs: number,
  nowMs: number,
): boolean {
  const loop = motion?.loop;
  if (!motion || !loop) return false;
  const passMs = (loop.endMs - loop.startMs) / motion.speed;
  return nowMs - Math.max(placedAtMs, firstWrapPerfMs(motion)) >= loopReanchorPasses * passMs;
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

/** While playing, the transport's bookkeeping runs at least this often (page ms). */
export const transportIntervalMs = 25;

/**
 * The next page time after `nowMs` at which following could need a jump: when the shown position
 * crosses the view's right edge, or when a loop wraps (it may land left of the view). Infinity when
 * nothing will change: a non-looping play that has ended, or one whose rest stays in view.
 */
export function nextFollowCheckMs(
  motion: PlayheadMotion,
  view: TimeView,
  widthPx: number,
  nowMs: number,
): number {
  if (nowMs < motion.startPerfMs) return motion.startPerfMs;
  const firstEndPerfMs = motion.startPerfMs + (motion.firstEndMs - motion.holdMs) / motion.speed;
  let pieceStart = motion.startPerfMs;
  let fromMs = motion.holdMs;
  let toMs = motion.firstEndMs;
  const loop = motion.loop;
  if (loop && nowMs >= firstEndPerfMs) {
    const passMs = (loop.endMs - loop.startMs) / motion.speed;
    pieceStart = firstEndPerfMs + Math.floor((nowMs - firstEndPerfMs) / passMs) * passMs;
    fromMs = loop.startMs;
    toMs = loop.endMs;
  }
  const pieceEnd = pieceStart + (toMs - fromMs) / motion.speed;
  const edgeMs = xToMs(view, widthPx);
  const crossing =
    edgeMs >= fromMs && edgeMs < toMs ? pieceStart + (edgeMs - fromMs) / motion.speed : Infinity;
  const events = [crossing, loop ? pieceEnd : Infinity].filter((at) => at > nowMs);
  return Math.min(Number.POSITIVE_INFINITY, ...events);
}

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
