import { expect, it } from "vitest";
import { nearSilence } from "./waveform";

/** One second at 1 kHz: full-scale noise-like values with a quiet stretch in [from, to) ms. */
function channel(from: number, to: number, level: number): Float32Array {
  return Float32Array.from({ length: 1000 }, (_, index) =>
    index >= from && index < to ? level * (index % 2 ? 1 : -1) : 0.5,
  );
}

it("finds a run quiet enough to arm the EQ app's onset gate, not only exact zeros", () => {
  expect(nearSilence([channel(300, 600, 0)], 1000, 0, 1000)).toBe(300);
  expect(nearSilence([channel(300, 600, 5e-5)], 1000, 0, 1000)).toBe(300);
  // Louder than about −80 dBFS, or shorter than 200 ms, does not arm it.
  expect(nearSilence([channel(300, 600, 2e-4)], 1000, 0, 1000)).toBeUndefined();
  expect(nearSilence([channel(300, 450, 0)], 1000, 0, 1000)).toBeUndefined();
});

it("needs every channel quiet, and looks only inside the range", () => {
  expect(nearSilence([channel(300, 600, 0), channel(0, 0, 0)], 1000, 0, 1000)).toBeUndefined();
  expect(nearSilence([channel(300, 600, 0)], 1000, 0, 450)).toBeUndefined();
  expect(nearSilence([channel(300, 600, 0)], 1000, 350, 1000)).toBe(350);
});
