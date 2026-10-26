/**
 * Clock model of the Timing engine. Four time bases meet here:
 *
 * - context time, seconds: the `AudioContext` clock, on which sources start, loop and stop;
 * - page time, ms: the performance clock, shared by `performance.now()`, an event's `timeStamp`,
 *   an animation frame's time stamp and `document.timeline`;
 * - source time, ms: the recording's own clock (osu clock, float64), what marks are placed in;
 * - display time: the page time at which a frame is seen. It is the frame's time stamp plus a
 *   display delay the page cannot measure; the listener's playhead offset stands in for it (see
 *   `display.ts`).
 *
 * `OutputClock` relates page time to the context time being heard at the output, from the pairs
 * `AudioContext.getOutputTimestamp()` reports. A `PlaybackAnchor` relates context time to source
 * time for one scheduled source. Both are pure; the audio engine feeds them.
 */

/** `AudioTimestamp`; either field may be missing or zero before output starts. */
export interface OutputStamp {
  contextTime?: number;
  performanceTime?: number;
}

/**
 * The context time heard at page time `t` is `ctxS + (t − perfMs) · ratio / 1000`. `ratio` is the
 * audio clock's rate against the page clock: 1 within the device's drift (tens of ppm).
 */
export interface ClockLine {
  perfMs: number;
  ctxS: number;
  ratio: number;
}

export function contextAt(line: ClockLine, perfMs: number): number {
  return line.ctxS + ((perfMs - line.perfMs) * line.ratio) / 1000;
}

export function perfAt(line: ClockLine, ctxS: number): number {
  return line.perfMs + ((ctxS - line.ctxS) * 1000) / line.ratio;
}

/** Stamps older than this, in page ms behind the newest, leave the fit. */
const windowMs = 1000;
/**
 * Fewer stamps than this (about 150 ms of the workspace's 25 ms samples) and the newest stamp is
 * used alone.
 */
const minimumPoints = 6;
/** A first pass keeps stamps within this many ms of the median offset. */
const gateMs = 5;
/** The residual bound never goes below this (performance time is coarsened to 0.1 ms). */
const floorMs = 0.1;
/** A ratio further than this from 1 is not a device clock; the fit then keeps ratio 1. */
const maximumSkew = 1e-3;
/** This many consecutive stamps off the line by more than `stepMs`, on one side, are a step. */
const stepPoints = 3;
const stepMs = 1;

interface Point {
  perfMs: number;
  /** Context time minus page time, ms: constant for a perfect clock pair. */
  offsetMs: number;
}

/**
 * A robust straight line through the recent output stamps: page time against the offset between
 * the clocks. Borrowed from ensomi-runtime's beat-grid drift fit (`drift` in
 * crates/generate/src/fitter/mel_phase.rs, lines 101-120 at edf4066, reimplemented): keep points
 * near the median, then twice fit least squares and keep points within
 * `max(floor, 3 · 1.4826 · MAD)` of the line. A step (device change, glitch) is followed after
 * `stepPoints` stamps instead of being averaged away. The output reports a new stamp once per
 * device callback (5-20 ms); the workspace reads one every 25 ms while playing and at each key, so
 * the fit runs about forty times a second on about forty points.
 */
export class OutputClock {
  private points: Point[] = [];
  private fitted: ClockLine | undefined;
  private lastCtxS = 0;
  /** Consecutive stamps off the current line, with the side they are on. */
  private outliers = 0;
  private outlierSide = 0;

  /** Takes a stamp if it is new and valid; returns whether it did. */
  observe(stamp: OutputStamp): boolean {
    const { contextTime = 0, performanceTime = 0 } = stamp;
    if (!(contextTime > 0 && performanceTime > 0)) return false;
    if (contextTime === this.lastCtxS) return false;
    if (contextTime < this.lastCtxS) this.reset();
    this.lastCtxS = contextTime;
    const point = { perfMs: performanceTime, offsetMs: contextTime * 1000 - performanceTime };
    this.followStep(point);
    this.points.push(point);
    const oldest = performanceTime - windowMs;
    let drop = 0;
    while (drop < this.points.length && (this.points[drop] as Point).perfMs < oldest) drop++;
    if (drop) this.points.splice(0, drop);
    this.fitted = fit(this.points);
    return true;
  }

  /** The current relation, or undefined before any stamp. */
  line(): ClockLine | undefined {
    return this.fitted;
  }

  /** Forgets every stamp, as when the context is suspended or its device changes. */
  reset() {
    this.points = [];
    this.fitted = undefined;
    this.lastCtxS = 0;
    this.outliers = 0;
    this.outlierSide = 0;
  }

  private followStep(point: Point) {
    const line = this.fitted;
    if (!line) return;
    const residual = point.offsetMs - offsetOf(line, point.perfMs);
    const side = Math.sign(residual);
    if (Math.abs(residual) <= stepMs) {
      this.outliers = 0;
      return;
    }
    this.outliers = side === this.outlierSide ? this.outliers + 1 : 1;
    this.outlierSide = side;
    if (this.outliers >= stepPoints) {
      this.points = this.points.slice(-(stepPoints - 1));
      this.outliers = 0;
    }
  }
}

/** The offset (context ms minus page ms) a line gives at page time `perfMs`. */
function offsetOf(line: ClockLine, perfMs: number): number {
  return contextAt(line, perfMs) * 1000 - perfMs;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Least squares `offset = a + b · (perf − x0)` over the points; `b` is 0 for one point. */
function line(points: Point[], x0: number): { a: number; b: number } {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.perfMs - x0;
    sy += p.offsetMs;
  }
  const mx = sx / points.length;
  const my = sy / points.length;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.perfMs - x0 - mx;
    sxx += dx * dx;
    sxy += dx * (p.offsetMs - my);
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/** The robust line through `points`, anchored at the newest one; see `OutputClock`. */
function fit(points: readonly Point[]): ClockLine | undefined {
  const newest = points.at(-1);
  if (!newest) return undefined;
  const x0 = newest.perfMs;
  const latest = { perfMs: x0, ctxS: (x0 + newest.offsetMs) / 1000, ratio: 1 };
  const middle = median(points.map((p) => p.offsetMs));
  let keep = points.filter((p) => Math.abs(p.offsetMs - middle) <= gateMs);
  if (keep.length < minimumPoints) return latest;
  let { a, b } = line(keep, x0);
  for (let pass = 0; pass < 2; pass++) {
    const residuals = keep.map((p) => p.offsetMs - a - b * (p.perfMs - x0));
    const centre = median(residuals);
    const mad = median(residuals.map((r) => Math.abs(r - centre)));
    const bound = Math.max(floorMs, 3 * 1.4826 * mad);
    const next = points.filter((p) => Math.abs(p.offsetMs - a - b * (p.perfMs - x0)) <= bound);
    if (next.length < minimumPoints) break;
    keep = next;
    ({ a, b } = line(keep, x0));
  }
  if (Math.abs(b) > maximumSkew) {
    b = 0;
    a = median(keep.map((p) => p.offsetMs));
  }
  // offset(perf) = a + b (perf − x0), so ctx ms = perf + offset: ratio 1 + b.
  return { perfMs: x0, ctxS: (x0 + a) / 1000, ratio: 1 + b };
}

/** One scheduled buffer source. */
export interface PlaybackAnchor {
  /** Context time at which the sample at `startSourceMs` is rendered. */
  startCtxS: number;
  startSourceMs: number;
  rate: number;
  /** A looping source wraps in source time, but only after its first pass through `endMs`. */
  loop: { startMs: number; endMs: number } | null;
  /** Where a non-looping source stops. */
  endMs: number;
}

/**
 * The source time rendered at context time `ctxS`. Before the start it holds the start position,
 * which shows the pre-roll honestly; a non-looping source holds its end.
 */
export function sourceAtContext(anchor: PlaybackAnchor, ctxS: number): number {
  const elapsedS = ctxS - anchor.startCtxS;
  if (elapsedS <= 0) return anchor.startSourceMs;
  const raw = anchor.startSourceMs + elapsedS * anchor.rate * 1000;
  if (!anchor.loop) return Math.min(raw, anchor.endMs);
  return wrapLoop(raw, anchor.loop);
}

export function wrapLoop(rawMs: number, loop: { startMs: number; endMs: number }): number {
  if (rawMs < loop.endMs) return rawMs;
  return loop.startMs + ((rawMs - loop.endMs) % (loop.endMs - loop.startMs));
}
