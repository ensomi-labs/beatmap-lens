/** Waveform and overview helpers; sample values are drawn at a fixed full-scale height. */

/** Min and max of `data` over whole-file samples `[from, to)`, clipped to the data. */
export function peak(data: Float32Array, from: number, to: number): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const end = Math.min(data.length, to);
  for (let index = Math.max(0, from); index < end; index++) {
    const value = data[index] as number;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? [min, max] : [0, 0];
}

/**
 * The first run of exact digital silence (every channel zero) at least `minRunMs` long inside
 * `[startMs, endMs)`, as its start time, or undefined.
 */
export function digitalSilence(
  channels: Float32Array[],
  sampleRate: number,
  startMs: number,
  endMs: number,
  minRunMs: number,
): number | undefined {
  const from = Math.max(0, Math.floor((startMs * sampleRate) / 1000));
  const to = Math.min(channels[0]?.length ?? 0, Math.ceil((endMs * sampleRate) / 1000));
  const minRun = (minRunMs * sampleRate) / 1000;
  let runStart = -1;
  for (let index = from; index < to; index++) {
    const silent = channels.every((data) => data[index] === 0);
    if (!silent) {
      runStart = -1;
      continue;
    }
    if (runStart < 0) runStart = index;
    if (index + 1 - runStart >= minRun) return (runStart * 1000) / sampleRate;
  }
  return undefined;
}

/** Index of the first value at or after `target` in an ascending array. */
export function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((values[mid] as number) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
