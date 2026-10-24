/**
 * The stage's horizontal time axis. Times are float64 milliseconds on the session clock; pixels
 * are CSS pixels measured from the stage's left edge. The view start is subtracted before scaling,
 * so a time near 600 s keeps sub-microsecond precision at any zoom. Nothing here rounds a time;
 * rounding a line to a device pixel is drawing only.
 */

export interface TimeView {
  startMs: number;
  msPerPx: number;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function msToX(view: TimeView, timeMs: number): number {
  return (timeMs - view.startMs) / view.msPerPx;
}

export function xToMs(view: TimeView, x: number): number {
  return view.startMs + x * view.msPerPx;
}

export interface ZoomLimits {
  /** Finest zoom: four device pixels per sample. */
  minMsPerPx: number;
  /** Coarsest zoom: the whole bounds fill the width. */
  maxMsPerPx: number;
}

export function zoomLimits(
  bounds: TimeRange,
  widthPx: number,
  sampleRate: number,
  devicePixelRatio: number,
): ZoomLimits {
  const maxMsPerPx = (bounds.endMs - bounds.startMs) / Math.max(1, widthPx);
  const minMsPerPx = Math.min(maxMsPerPx, (1000 / sampleRate / 4) * devicePixelRatio);
  return { minMsPerPx, maxMsPerPx };
}

/** Keeps the zoom inside its limits and the view inside the bounds. */
export function clampView(
  view: TimeView,
  bounds: TimeRange,
  widthPx: number,
  limits: ZoomLimits,
): TimeView {
  const msPerPx = Math.min(limits.maxMsPerPx, Math.max(limits.minMsPerPx, view.msPerPx));
  const spanMs = msPerPx * widthPx;
  const startMs = Math.min(Math.max(view.startMs, bounds.startMs), bounds.endMs - spanMs);
  return { startMs: Math.max(bounds.startMs, startMs), msPerPx };
}

/** The passage fills the width; the context stays reachable by panning. */
export function fitView(passage: TimeRange, widthPx: number): TimeView {
  return {
    startMs: passage.startMs,
    msPerPx: (passage.endMs - passage.startMs) / Math.max(1, widthPx),
  };
}

/** Zooms by `factor` (2 zooms out one step) and keeps `anchorMs` at the same x. */
export function zoomAt(view: TimeView, anchorMs: number, factor: number): TimeView {
  const msPerPx = view.msPerPx * factor;
  return { startMs: anchorMs - (anchorMs - view.startMs) * factor, msPerPx };
}

/** Centres `timeMs` at a fraction of the width, used to jump to the playhead or a mark. */
export function placeAt(
  view: TimeView,
  timeMs: number,
  widthPx: number,
  fraction: number,
): TimeView {
  return { startMs: timeMs - widthPx * fraction * view.msPerPx, msPerPx: view.msPerPx };
}

const niceSteps = [1, 2, 5];

/** The smallest 1-2-5 step in ms whose ticks are at least `minSpacingPx` apart. */
export function tickStepMs(msPerPx: number, minSpacingPx: number): number {
  const target = msPerPx * minSpacingPx;
  let magnitude = 10 ** Math.floor(Math.log10(target));
  for (;;) {
    for (const step of niceSteps) if (step * magnitude >= target) return step * magnitude;
    magnitude *= 10;
  }
}

/** Ticks on multiples of `stepMs` inside the range, computed as integer multiples (no drift). */
export function ticks(range: TimeRange, stepMs: number): number[] {
  const first = Math.ceil(range.startMs / stepMs);
  const last = Math.floor(range.endMs / stepMs);
  return Array.from(
    { length: Math.max(0, last - first + 1) },
    (_, index) => (first + index) * stepMs,
  );
}

/** Decimal places of a millisecond needed to tell ticks `stepMs` apart. */
export function msDecimals(stepMs: number): number {
  return Math.max(0, Math.min(4, Math.ceil(-Math.log10(stepMs) - 1e-9)));
}

/** `mm:ss.mmm`, with extra digits of a millisecond when `msDigits` is above 0. */
export function formatSourceTime(timeMs: number, msDigits = 0): string {
  const sign = timeMs < 0 ? "−" : "";
  const absolute = Math.abs(timeMs);
  const fixed = absolute.toFixed(msDigits);
  const [whole = "0", fraction] = fixed.split(".");
  const totalMs = Number(whole);
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${sign}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(
    ms,
  ).padStart(3, "0")}${fraction ?? ""}`;
}
