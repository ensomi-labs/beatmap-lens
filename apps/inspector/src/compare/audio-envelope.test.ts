import { expect, it } from "vitest";
import { analyzeAudio } from "./audio-envelope";

it("preserves silence, relative energy, and the onset time of an accent", () => {
  const samples = new Float32Array(1000);
  samples.fill(0.25, 100, 200);
  samples.fill(1, 400, 500);
  const result = analyzeAudio([samples], 1000);
  expect(result.step_ms).toBe(10);
  expect(result.energy.slice(0, 10)).toEqual(Array(10).fill(0));
  expect(result.energy[10]).toBe(0.25);
  expect(result.energy[40]).toBe(1);
  expect(result.onset.indexOf(Math.max(...result.onset))).toBe(40);
  expect(result.onset[49]).toBe(0);
  expect(result.energy.slice(50)).toEqual(Array(50).fill(0));
});

it("measures stereo energy without cancelling opposite-polarity channels", () => {
  const left = new Float32Array([0, 0, 1, 1]);
  const right = new Float32Array([0, 0, -1, -1]);
  expect(analyzeAudio([left, right], 100).energy).toEqual([0, 0, 1, 1]);
  expect(analyzeAudio([new Float32Array(20)], 100).energy).toEqual(Array(20).fill(0));
});
