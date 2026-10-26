import { describe, expect, it, vi } from "vitest";
import type { LastSetup } from "./contracts";
import { deviceRate, initialSetup, probeDeviceRate, rateConflict, recordedSetup } from "./setup";

const saveRef = { session_id: "session-01", save_id: "s1", time: "2026-10-26T08:37:00.000Z" };
const last: LastSetup = {
  setup: { text: "DT270pro 3%", from: saveRef },
  device_rate: { hz: 44_100, from: saveRef },
};
const none: LastSetup = { setup: null, device_rate: null };
const before = "2026-10-26T08:00:00.000Z";
const after = "2026-10-26T09:00:00.000Z";

describe("the setup line a session opens with", () => {
  it.each([
    ["nothing anywhere", none, "", null, { text: "", source: "none", from: null }],
    ["only a save", last, "", null, { text: "DT270pro 3%", source: "last-save", from: saveRef }],
    ["only the browser", none, "HD 600", after, { text: "HD 600", source: "browser", from: null }],
    ["a save newer than the browser", last, "HD 600", before, { source: "last-save" }],
    ["a browser value kept without a time", last, "HD 600", null, { source: "last-save" }],
    [
      "a browser value typed after the save",
      last,
      "HD 600",
      after,
      { text: "HD 600", source: "browser" },
    ],
    ["the browser's value is the saved text", last, "DT270pro 3%", after, { source: "last-save" }],
  ] as const)("%s", (_, carried, text, at, expected) => {
    expect(initialSetup(carried, { value: text, at })).toMatchObject(expected);
  });

  it("records an empty line as none and names a save only for a carried line", () => {
    expect(recordedSetup({ text: "  ", source: "typed", from: null })).toEqual({
      text: "",
      source: "none",
      from: null,
    });
    expect(recordedSetup({ text: "HD 600", source: "typed", from: saveRef })).toEqual({
      text: "HD 600",
      source: "typed",
      from: null,
    });
  });
});

describe("the output device rate", () => {
  const detected = { hz: 48_000, at: after };
  it.each([
    ["a rate chosen now wins", 96_000, detected, last, 88_200, { hz: 96_000, source: "typed" }],
    ["then the detected rate", null, detected, last, 88_200, { hz: 48_000, source: "detected" }],
    [
      "then the last save",
      null,
      null,
      last,
      null,
      { hz: 44_100, source: "last-save", from: saveRef },
    ],
    ["or a later browser choice", null, null, last, 88_200, { hz: 88_200, source: "browser" }],
    ["nothing known", null, null, none, null, { hz: null, source: "none", from: null }],
  ] as const)("%s", (_, chosen, detection, carried, browser, expected) => {
    const at = browser === null ? null : after;
    expect(deviceRate(chosen, detection, carried, { value: browser, at })).toMatchObject(expected);
  });

  it("an older browser choice gives way to the last save", () => {
    expect(deviceRate(null, null, last, { value: 88_200, at: before })).toMatchObject({
      hz: 44_100,
      source: "last-save",
    });
  });

  it("flags a chosen rate the detection contradicts", () => {
    expect(rateConflict(44_100, detected)).toBe(true);
    expect(rateConflict(48_000, detected)).toBe(false);
    expect(rateConflict(null, detected)).toBe(false);
    expect(rateConflict(44_100, null)).toBe(false);
  });
});

describe("the probe", () => {
  it("reads a default context's rate and closes the context at once", () => {
    const close = vi.fn(async () => {});
    const create = vi.fn(() => ({ sampleRate: 48_000, close }));
    const detection = probeDeviceRate(create, () => new Date(after));
    expect(create).toHaveBeenCalledWith();
    expect(close).toHaveBeenCalledOnce();
    expect(detection).toEqual({ hz: 48_000, at: after });
  });

  it("gives null when no context can be made", () => {
    expect(
      probeDeviceRate(() => {
        throw new Error("no audio");
      }),
    ).toBeNull();
  });
});
