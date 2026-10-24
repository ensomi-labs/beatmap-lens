/**
 * One-layer STFT for orientation, not for placing onsets (the waveform does that).
 *
 * Frame convention: frame `k` is centred at whole-file sample `k * hop`, so at `k * hop / rate`
 * seconds, whatever crop of the recording is analysed. Each frame is a periodic Hann window of
 * `fftSize` samples whose peak sits on that centre sample; samples before the file's start or
 * after its end are zeros (no reflected padding, so no mirrored attack is invented). Stereo is
 * shown as the mean of the channel powers, so opposite-phase channels stay visible.
 */

export const fftSize = 1024;
export const hop = 256;
/** dB relative to a full-scale sine; the range is fixed per session, never normalised per view. */
export const ceilingDb = -10;
export const rangeDb = 70;
export const minFrequencyHz = 30;
export const maxFrequencyHz = 16_000;

export interface Spectrogram {
  sampleRate: number;
  firstFrame: number;
  frameCount: number;
  bins: number;
  /** `frameCount * bins` power in dB, frame-major. */
  db: Float32Array;
}

export function frameCentreMs(frame: number, sampleRate: number): number {
  return (frame * hop * 1000) / sampleRate;
}

export function nearestFrame(timeMs: number, sampleRate: number): number {
  return Math.round((timeMs * sampleRate) / 1000 / hop);
}

/**
 * The frames a crop needs (every time in it has its nearest frame, so the first and last centres
 * may lie up to half a hop outside) and the samples those frames read, clipped to the file.
 */
export function cropSamples(
  startMs: number,
  endMs: number,
  sampleRate: number,
  totalFrames: number,
) {
  const firstFrame = nearestFrame(startMs, sampleRate);
  const lastFrame = nearestFrame(endMs, sampleRate);
  return {
    firstFrame,
    frameCount: Math.max(0, lastFrame - firstFrame + 1),
    start: Math.max(0, firstFrame * hop - fftSize / 2),
    end: Math.min(totalFrames, lastFrame * hop + fftSize / 2),
  };
}

/**
 * The frames nearest to every time in `[startMs, endMs]`. `channels` hold samples from whole-file index
 * `sliceStart`; `totalFrames` is the recording's length, beyond which samples are zero.
 */
export function computeSpectrogram(input: {
  channels: Float32Array[];
  sliceStart: number;
  totalFrames: number;
  sampleRate: number;
  startMs: number;
  endMs: number;
}): Spectrogram {
  const { channels, sliceStart, totalFrames, sampleRate } = input;
  const { firstFrame, frameCount } = cropSamples(
    input.startMs,
    input.endMs,
    sampleRate,
    totalFrames,
  );
  const bins = fftSize / 2 + 1;
  const db = new Float32Array(frameCount * bins);
  const window = hann(fftSize);
  const fft = createFft(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const power = new Float64Array(bins);
  // A full-scale sine peaks at fftSize / 4 under a Hann window.
  const reference = 20 * Math.log10(fftSize / 4);
  for (let index = 0; index < frameCount; index++) {
    const origin = (firstFrame + index) * hop - fftSize / 2;
    power.fill(0);
    for (const data of channels) {
      for (let n = 0; n < fftSize; n++) {
        const sample = origin + n;
        re[n] =
          sample >= 0 && sample < totalFrames
            ? (data[sample - sliceStart] ?? 0) * (window[n] as number)
            : 0;
        im[n] = 0;
      }
      fft(re, im);
      for (let bin = 0; bin < bins; bin++)
        power[bin] = (power[bin] as number) + (re[bin] as number) ** 2 + (im[bin] as number) ** 2;
    }
    const row = index * bins;
    for (let bin = 0; bin < bins; bin++) {
      const mean = (power[bin] as number) / channels.length;
      db[row + bin] = 10 * Math.log10(mean + 1e-20) - reference;
    }
  }
  return { sampleRate, firstFrame, frameCount, bins, db };
}

/** Periodic Hann: peak exactly at index `size / 2`, the frame's centre sample. */
export function hann(size: number): Float64Array {
  return Float64Array.from(
    { length: size },
    (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / size),
  );
}

/** In-place iterative radix-2 FFT for one fixed power-of-two size. */
export function createFft(size: number) {
  const levels = Math.log2(size);
  if (!Number.isInteger(levels)) throw new Error("FFT size must be a power of two.");
  const reverse = new Uint32Array(size);
  for (let index = 0; index < size; index++) {
    let value = 0;
    for (let bit = 0; bit < levels; bit++) value |= ((index >> bit) & 1) << (levels - 1 - bit);
    reverse[index] = value;
  }
  const cos = Float64Array.from({ length: size / 2 }, (_, k) => Math.cos((2 * Math.PI * k) / size));
  const sin = Float64Array.from(
    { length: size / 2 },
    (_, k) => -Math.sin((2 * Math.PI * k) / size),
  );
  return (re: Float64Array, im: Float64Array) => {
    for (let index = 0; index < size; index++) {
      const other = reverse[index] as number;
      if (other > index) {
        [re[index], re[other]] = [re[other] as number, re[index] as number];
        [im[index], im[other]] = [im[other] as number, im[index] as number];
      }
    }
    for (let width = 2; width <= size; width *= 2) {
      const half = width / 2;
      const step = size / width;
      for (let start = 0; start < size; start += width) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step] as number;
          const wi = sin[k * step] as number;
          const a = start + k;
          const b = a + half;
          const br = re[b] as number;
          const bi = im[b] as number;
          const tr = br * wr - bi * wi;
          const ti = br * wi + bi * wr;
          re[b] = (re[a] as number) - tr;
          im[b] = (im[a] as number) - ti;
          re[a] = (re[a] as number) + tr;
          im[a] = (im[a] as number) + ti;
        }
      }
    }
  };
}

/**
 * For each display row (top row first, log frequency from 30 Hz to min(16 kHz, Nyquist)), the
 * FFT bins it covers; a row narrower than a bin reads its nearest bin.
 */
export function rowBins(rows: number, sampleRate: number): { lo: number; hi: number }[] {
  const top = Math.min(maxFrequencyHz, sampleRate / 2);
  const binHz = sampleRate / fftSize;
  const edge = (row: number) => minFrequencyHz * (top / minFrequencyHz) ** (row / rows);
  return Array.from({ length: rows }, (_, index) => {
    const row = rows - 1 - index;
    const lo = Math.round(edge(row) / binHz);
    const hi = Math.max(lo, Math.round(edge(row + 1) / binHz) - 1);
    return { lo, hi };
  });
}

/** Grey level 0..1 for a dB value on the fixed session range. */
export function level(db: number): number {
  return Math.min(1, Math.max(0, (db - (ceilingDb - rangeDb)) / rangeDb));
}
