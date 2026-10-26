import type { PlaybackAnchor } from "./output-clock";

/**
 * Transport planning: where an `AudioBufferSourceNode` starts, loops and stops, on whole sample
 * frames of the context, and the anchor that maps context time back to source time.
 *
 * Whole frames are what keep playback sample-exact at rate 1. Chromium starts a source at a
 * fractional `when` by interpolating every sample of the buffer between neighbours, and after a
 * loop of fractional length every later pass is interpolated too; it rounds the `offset` argument
 * to the nearest frame instead. (Measured in headless Chromium 139 with OfflineAudioContext and a
 * captured realtime output; see docs/inspector/timing-latency.md.) So the plan rounds the start
 * offset and loop edges to frames itself, and the anchor names the frame that is really played.
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

/** The nearest frame of a source time. */
export function frameOf(timeMs: number, sampleRate: number): number {
  return Math.round((timeMs * sampleRate) / 1000);
}

/**
 * Seconds for frame `frame` such that `seconds * sampleRate` is within a rounding error at or below
 * the integer, never above it: the browser rounds a start time up to the next frame, so a value a
 * hair above the frame would start one frame late.
 */
export function frameTime(frame: number, sampleRate: number): number {
  let seconds = frame / sampleRate;
  while (seconds * sampleRate > frame) seconds -= Number.EPSILON * Math.max(1, seconds);
  return seconds;
}

/**
 * Plans a play `leadS` after the context's `currentTimeS`, which is itself a frame boundary (the
 * end of the last rendered block). The first frame played is the source's nearest frame to
 * `fromMs`; a loop's edges are their nearest frames, at least one frame apart.
 */
export function planPlay(
  request: PlayRequest,
  context: { currentTimeS: number; sampleRate: number; leadS: number },
): PlayPlan {
  const { sampleRate } = context;
  const msOf = (frame: number) => (frame * 1000) / sampleRate;
  const startFrame = Math.ceil(context.currentTimeS * sampleRate - 1e-6);
  const whenFrame = startFrame + Math.ceil(context.leadS * sampleRate);
  const whenS = frameTime(whenFrame, sampleRate);
  const fromFrame = frameOf(request.fromMs, sampleRate);
  const offsetS = frameTime(fromFrame, sampleRate);
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
  const stopS = request.loop
    ? null
    : whenS + Math.max(0, endFrame - fromFrame) / sampleRate / request.rate;
  return {
    whenS,
    offsetS,
    stopS,
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
