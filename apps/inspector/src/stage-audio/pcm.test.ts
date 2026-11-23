import { expect, it } from "vitest";
import { deinterleave } from "./pcm";

it("splits interleaved float32 bit for bit, keeping values above full scale", () => {
  const interleaved = new Float32Array([0.5, -0.25, 1.75, -1.5, 1e-38, -0, 0.1, 3]);
  const [left, right] = deinterleave(interleaved.buffer, 2, 4);
  expect(Array.from(left ?? [])).toEqual([0.5, 1.75, 1e-38, 0.1].map(Math.fround));
  expect(Array.from(right ?? [])).toEqual([-0.25, -1.5, -0, 3]);
  expect(Object.is(right?.[2], -0)).toBe(true);
});

it("keeps a mono payload as one channel", () => {
  const mono = new Float32Array([0.1, 0.2, 0.3]);
  expect(deinterleave(mono.buffer, 1, 3)).toEqual([mono]);
});

it("refuses a payload whose size disagrees with its descriptor", () => {
  expect(() => deinterleave(new ArrayBuffer(12), 2, 2)).toThrow("size");
});
