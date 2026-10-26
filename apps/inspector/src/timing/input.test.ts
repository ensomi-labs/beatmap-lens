import { expect, it } from "vitest";
import type { PlaybackAnchor } from "./clock";
import { heardSourceMs } from "./input";

// The output reported context time 10 s at page time 5000 ms; the source started at 10.05 s.
const line = { perfMs: 5000, ctxS: 10, ratio: 1 };
const anchor: PlaybackAnchor = {
  startCtxS: 10.05,
  startSourceMs: 1000,
  rate: 0.5,
  loop: null,
  endMs: 9000,
};

it("maps a press to the source time heard at its own time stamp, scaled by the rate", () => {
  expect(heardSourceMs(anchor, line, 5100)).toBeCloseTo(1025, 9);
  // A press the handler sees 30 ms later still goes where it was heard.
  expect(heardSourceMs(anchor, line, 5130)).toBeCloseTo(1040, 9);
});

it("ignores a press before the sound reached the output", () => {
  expect(heardSourceMs(anchor, line, 5040)).toBeUndefined();
  expect(heardSourceMs(anchor, line, 5050)).toBeUndefined();
});
