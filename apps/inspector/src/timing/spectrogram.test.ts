import { describe, expect, it } from "vitest";
import {
  computeSpectrogram,
  createFft,
  cropSamples,
  fftSize,
  frameCentreMs,
  hop,
  nearestFrame,
  rowBins,
  type Spectrogram,
} from "./spectrogram";

/** A band-limited click centred at a fractional sample position. */
function click(frames: number, atSample: number): Float32Array {
  const data = new Float32Array(frames);
  for (let n = Math.floor(atSample) - 32; n <= Math.ceil(atSample) + 32; n++) {
    if (n < 0 || n >= frames) continue;
    const d = n - atSample;
    const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
    data[n] = sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / 33)) * 0.8;
  }
  return data;
}

function frameEnergy(spectrogram: Spectrogram, index: number): number {
  let total = 0;
  for (let bin = 0; bin < spectrogram.bins; bin++)
    total += 10 ** ((spectrogram.db[index * spectrogram.bins + bin] ?? -200) / 10);
  return total;
}

function loudestFrame(spectrogram: Spectrogram): number {
  let best = 0;
  for (let index = 1; index < spectrogram.frameCount; index++)
    if (frameEnergy(spectrogram, index) > frameEnergy(spectrogram, best)) best = index;
  return spectrogram.firstFrame + best;
}

function whole(channels: Float32Array[], sampleRate: number, startMs: number, endMs: number) {
  const totalFrames = channels[0]?.length ?? 0;
  return computeSpectrogram({ channels, sliceStart: 0, totalFrames, sampleRate, startMs, endMs });
}

describe("FFT", () => {
  it("matches a direct DFT", () => {
    const size = 16;
    const input = Array.from(
      { length: size },
      (_, n) => Math.sin(n * 1.3) + 0.25 * Math.cos(n * 0.7),
    );
    const re = Float64Array.from(input);
    const im = new Float64Array(size);
    createFft(size)(re, im);
    for (let k = 0; k < size; k++) {
      let dr = 0;
      let di = 0;
      input.forEach((x, n) => {
        dr += x * Math.cos((2 * Math.PI * k * n) / size);
        di -= x * Math.sin((2 * Math.PI * k * n) / size);
      });
      expect(re[k]).toBeCloseTo(dr, 9);
      expect(im[k]).toBeCloseTo(di, 9);
    }
  });
});

describe("frame convention", () => {
  for (const sampleRate of [44_100, 48_000]) {
    it(`puts a click at a fractional sample time in its nearest frame at ${sampleRate} Hz`, () => {
      const clickMs = 1234.5678;
      const atSample = (clickMs * sampleRate) / 1000;
      expect(Number.isInteger(atSample)).toBe(false);
      const data = click(sampleRate * 2, atSample);
      const spectrogram = whole([data], sampleRate, 1000, 1500);
      const frame = loudestFrame(spectrogram);
      expect(frame).toBe(nearestFrame(clickMs, sampleRate));
      expect(Math.abs(frameCentreMs(frame, sampleRate) - clickMs)).toBeLessThanOrEqual(
        ((hop / 2) * 1000) / sampleRate,
      );
    });
  }

  it("keeps whole-file frame centres for a crop that does not start on a hop multiple", () => {
    const sampleRate = 44_100;
    const data = click(sampleRate * 2, 50_000.37);
    const reference = whole([data], sampleRate, 0, 2000);
    const startMs = 1100.123;
    expect(((startMs * sampleRate) / 1000) % hop).not.toBe(0);
    const crop = cropSamples(startMs, 1300, sampleRate, data.length);
    // The slice handed over may itself start anywhere before the samples the frames read.
    const sliceStart = crop.start - 1001;
    const cropped = computeSpectrogram({
      channels: [data.subarray(sliceStart, crop.end)],
      sliceStart,
      totalFrames: data.length,
      sampleRate,
      startMs,
      endMs: 1300,
    });
    expect(cropped.firstFrame).toBe(nearestFrame(startMs, sampleRate));
    expect(cropped.firstFrame * hop).toBe(Math.round((startMs * sampleRate) / 1000 / hop) * hop);
    const offset = (cropped.firstFrame - reference.firstFrame) * reference.bins;
    expect(Array.from(cropped.db)).toEqual(
      Array.from(reference.db.subarray(offset, offset + cropped.db.length)),
    );
  });

  it("finds a click near the file's end, with zeros beyond it", () => {
    const sampleRate = 48_000;
    const frames = sampleRate + 77;
    const atSample = frames - 40.6;
    const data = click(frames, atSample);
    const endMs = (frames * 1000) / sampleRate;
    const spectrogram = whole([data], sampleRate, endMs - 100, endMs);
    // The last frame is centred past the end, over zeros, because it is nearest to the last samples.
    expect(spectrogram.firstFrame + spectrogram.frameCount - 1).toBe(Math.round(frames / hop));
    expect(frameCentreMs(Math.round(frames / hop), sampleRate)).toBeGreaterThan(endMs);
    expect(spectrogram.db.every(Number.isFinite)).toBe(true);
    expect(loudestFrame(spectrogram)).toBe(
      nearestFrame((atSample * 1000) / sampleRate, sampleRate),
    );
  });
});

describe("levels and channels", () => {
  const sampleRate = 48_000;
  const bin = 64;
  const sine = Float32Array.from({ length: sampleRate }, (_, n) =>
    Math.sin((2 * Math.PI * bin * n) / fftSize),
  );

  it("reads a full-scale sine as 0 dB", () => {
    const spectrogram = whole([sine], sampleRate, 400, 410);
    expect(spectrogram.db[bin]).toBeCloseTo(0, 6);
  });

  it("averages channel powers, so opposite-phase stereo stays visible", () => {
    const inverted = sine.map((value) => -value);
    const stereo = whole([sine, inverted], sampleRate, 400, 410);
    const mono = whole([sine], sampleRate, 400, 410);
    expect(stereo.db[bin]).toBeCloseTo(mono.db[bin] ?? Number.NaN, 9);
  });

  it("maps rows from the top frequency down to 30 Hz", () => {
    const rows = rowBins(200, 44_100);
    expect(rows[0]?.hi).toBe(Math.round((16_000 * fftSize) / 44_100) - 1);
    expect(rows.at(-1)?.lo).toBe(Math.round((30 * fftSize) / 44_100));
    // At 22.05 kHz the top is Nyquist.
    expect(rowBins(10, 22_050)[0]?.hi).toBe(fftSize / 2 - 1);
  });
});
