/**
 * Which source time is being heard now. The relation between the audio output and the page's
 * clock comes from `AudioContext.getOutputTimestamp()`; `outputLatency` is not subtracted again.
 * The listener's playhead offset is elapsed wall-clock milliseconds (residual audio delay minus
 * display delay, either sign). It is applied before the playback-rate multiplication, so 12 ms at
 * rate 0.5 moves the bar 6 ms of source time. A positive offset moves the bar earlier.
 */

/** `AudioTimestamp`; either field may be missing or zero before output starts. */
export interface OutputStamp {
  contextTime?: number;
  performanceTime?: number;
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
 * The heard source time at `nowMs` (performance clock). A zero or invalid timestamp means output
 * has not started, and so does a heard time before the scheduled start: both hold the start
 * position, which shows the pre-roll honestly.
 */
export function heardSourceMs(
  anchor: PlaybackAnchor,
  stamp: OutputStamp,
  nowMs: number,
  offsetMs: number,
): number {
  const { contextTime = 0, performanceTime = 0 } = stamp;
  if (!(contextTime > 0 && performanceTime > 0)) return anchor.startSourceMs;
  const heardCtx = contextTime + (nowMs - performanceTime - offsetMs) / 1000;
  const elapsedS = heardCtx - anchor.startCtxS;
  if (elapsedS <= 0) return anchor.startSourceMs;
  const raw = anchor.startSourceMs + elapsedS * anchor.rate * 1000;
  if (!anchor.loop) return Math.min(raw, anchor.endMs);
  return wrapLoop(raw, anchor.loop);
}

/**
 * The context times in [`fromCtxS`, `toCtxS`) at which the source times `beatsMs` are rendered:
 * the same mapping as `heardSourceMs`, run the other way. A non-looping source plays from its start
 * to `endMs`; a looping one plays from its start to the loop end, then the loop over and over.
 */
export function clickTimes(
  anchor: PlaybackAnchor,
  beatsMs: readonly number[],
  fromCtxS: number,
  toCtxS: number,
): number[] {
  const ctxAt = (passCtxS: number, passSourceMs: number, timeMs: number) =>
    passCtxS + (timeMs - passSourceMs) / anchor.rate / 1000;
  const times: number[] = [];
  const keep = (ctxS: number) => {
    if (ctxS >= fromCtxS && ctxS < toCtxS) times.push(ctxS);
  };
  const firstEndMs = anchor.loop ? anchor.loop.endMs : anchor.endMs;
  for (const timeMs of beatsMs)
    if (timeMs >= anchor.startSourceMs && timeMs < firstEndMs)
      keep(ctxAt(anchor.startCtxS, anchor.startSourceMs, timeMs));
  const loop = anchor.loop;
  if (!loop || !(loop.endMs > loop.startMs)) return times;
  const passS = (loop.endMs - loop.startMs) / anchor.rate / 1000;
  const wrapCtxS = ctxAt(anchor.startCtxS, anchor.startSourceMs, loop.endMs);
  for (let pass = Math.max(0, Math.floor((fromCtxS - wrapCtxS) / passS)); ; pass++) {
    const passCtxS = wrapCtxS + pass * passS;
    if (passCtxS >= toCtxS) break;
    for (const timeMs of beatsMs)
      if (timeMs >= loop.startMs && timeMs < loop.endMs)
        keep(ctxAt(passCtxS, loop.startMs, timeMs));
  }
  return times;
}

/**
 * Whether the output has reached the anchor's start by `nowMs`, so that `heardSourceMs` gives a
 * time actually heard rather than the start position it holds before then.
 */
export function outputReached(anchor: PlaybackAnchor, stamp: OutputStamp, nowMs: number): boolean {
  const { contextTime = 0, performanceTime = 0 } = stamp;
  if (!(contextTime > 0 && performanceTime > 0)) return false;
  return contextTime + (nowMs - performanceTime) / 1000 > anchor.startCtxS;
}

export function wrapLoop(rawMs: number, loop: { startMs: number; endMs: number }): number {
  if (rawMs < loop.endMs) return rawMs;
  return loop.startMs + ((rawMs - loop.endMs) % (loop.endMs - loop.startMs));
}

/** Every start begins `prerollMs` of real preceding audio early, clamped at source zero. */
export function prerollStart(requestedMs: number, prerollMs: number): number {
  return Math.max(0, requestedMs - prerollMs);
}
