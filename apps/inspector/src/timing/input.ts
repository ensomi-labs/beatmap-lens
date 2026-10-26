import { type ClockLine, contextAt, type PlaybackAnchor, sourceAtContext } from "./clock";

/**
 * Input path of the Timing engine: the source time heard when a key or button went down.
 *
 * An event's `timeStamp` is the operating system's time for the press, on the page clock, so the
 * time the handler runs (a few ms later, more while the main thread is busy) does not move the
 * mark. The press is mapped through the same clock model as the playhead, at the press's own time,
 * and without the playhead offset, which corrects only the drawn bar. A press before the sound has
 * reached the output gives undefined rather than the start position.
 *
 * What is not corrected: the keyboard's scan and transport latency before the operating system
 * stamps the press, and the listener's own motor timing. Both are owner measurements.
 */
export function heardSourceMs(
  anchor: PlaybackAnchor,
  line: ClockLine,
  eventMs: number,
): number | undefined {
  const ctxS = contextAt(line, eventMs);
  if (!(ctxS > anchor.startCtxS)) return undefined;
  return sourceAtContext(anchor, ctxS);
}
