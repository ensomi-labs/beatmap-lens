import type { PlaybackAnchor } from "./clock";

/**
 * Transport and scheduler of the Timing engine, in context time: where an
 * `AudioBufferSourceNode` starts, loops and stops, and when the listener's own beats click. Pure;
 * the audio engine applies the plans.
 *
 * Whole frames keep playback sample-exact at rate 1. The Web Audio playback algorithm renders a
 * source started between two frames, or looping over a fractional length, at fractional buffer
 * positions, which Chromium interpolates; a start offset off a frame is rounded or interpolated
 * depending on the browser. So the plan puts the start time, the offset and the loop edges on whole
 * frames itself, and the anchor names the frame really played. The lab's offline exactness
 * experiment (`benchmarks/timing/lab.html`) checks this in the browser.
 */

export interface PlayRequest {
  /** Source time to start from, ms (the caller has applied pre-roll). */
  fromMs: number;
  /** Where a non-looping play stops, ms. */
  endMs: number;
  rate: number;
  loop: { startMs: number; endMs: number } | null;
}

export interface PlayPlan {
  /** Context time of the first frame, on a whole frame. */
  whenS: number;
  /** Buffer offset, on a whole frame. */
  offsetS: number;
  /** Context time to stop a non-looping play, or null for a loop. */
  stopS: number | null;
  /** Loop edges on whole frames, or null. */
  loopStartS: number | null;
  loopEndS: number | null;
  anchor: PlaybackAnchor;
}

/** Every start begins `prerollMs` of real preceding audio early, clamped at source zero. */
export function prerollStart(requestedMs: number, prerollMs: number): number {
  return Math.max(0, requestedMs - prerollMs);
}

/** The nearest frame of a source time. */
export function frameOf(timeMs: number, sampleRate: number): number {
  return Math.round((timeMs * sampleRate) / 1000);
}

/**
 * Seconds for frame `frame` such that `seconds · sampleRate` is at or a rounding error below the
 * integer, never above it: a start time a hair above a frame is rounded up to the next frame.
 */
export function frameTime(frame: number, sampleRate: number): number {
  let seconds = frame / sampleRate;
  while (seconds * sampleRate > frame) seconds -= Number.EPSILON * Math.max(1, seconds);
  return seconds;
}

/**
 * Plans a play at least `leadS` after the context's `currentTimeS` (itself a frame boundary, the
 * end of the last rendered block). The first frame played is the source's nearest frame to
 * `fromMs`; a loop's edges are their nearest frames, at least one frame apart.
 */
export function planPlay(
  request: PlayRequest,
  context: { currentTimeS: number; sampleRate: number; leadS: number },
): PlayPlan {
  const { sampleRate } = context;
  const msOf = (frame: number) => (frame * 1000) / sampleRate;
  const nowFrame = Math.ceil(context.currentTimeS * sampleRate - 1e-6);
  const whenFrame = nowFrame + Math.ceil(context.leadS * sampleRate);
  const whenS = frameTime(whenFrame, sampleRate);
  const fromFrame = frameOf(request.fromMs, sampleRate);
  let loop: PlaybackAnchor["loop"] = null;
  let loopStartS: number | null = null;
  let loopEndS: number | null = null;
  if (request.loop) {
    const loopStart = frameOf(request.loop.startMs, sampleRate);
    const loopEnd = Math.max(loopStart + 1, frameOf(request.loop.endMs, sampleRate));
    loopStartS = frameTime(loopStart, sampleRate);
    loopEndS = frameTime(loopEnd, sampleRate);
    loop = { startMs: msOf(loopStart), endMs: msOf(loopEnd) };
  }
  const endFrame = frameOf(request.endMs, sampleRate);
  return {
    whenS,
    offsetS: frameTime(fromFrame, sampleRate),
    stopS: request.loop
      ? null
      : whenS + Math.max(0, endFrame - fromFrame) / sampleRate / request.rate,
    loopStartS,
    loopEndS,
    anchor: {
      startCtxS: whenS,
      startSourceMs: msOf(fromFrame),
      rate: request.rate,
      loop,
      endMs: msOf(endFrame),
    },
  };
}

/**
 * The context times in [`fromCtxS`, `toCtxS`) at which the source times `beatsMs` are rendered:
 * `sourceAtContext` run the other way. A non-looping source plays from its start to `endMs`; a
 * looping one plays from its start to the loop end, then the loop over and over. Clicks keep their
 * fractional context times: the browser starts a short buffer between frames by interpolating it,
 * which puts the click's onset at the beat to a fraction of a sample.
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
 * The window of context time the click scheduler fills on one run. Clicks start at least
 * `marginS` after the context's current time, because the audio thread may already be rendering
 * that block: a click that can no longer start on time is dropped, never played late. The window
 * reaches `lookaheadS` ahead, so the page's main thread may stall that long without losing a click.
 * Returns null when there is nothing new to schedule.
 */
export function clickWindow(
  nowS: number,
  scheduledUntilS: number,
  lookaheadS: number,
  marginS: number,
): { fromS: number; toS: number } | null {
  const fromS = Math.max(nowS + marginS, scheduledUntilS);
  const toS = nowS + lookaheadS;
  return toS > fromS ? { fromS, toS } : null;
}
