/**
 * The playback setup a save records, and where each value came from. Nothing here blocks a save:
 * the setup line is carried from the latest statement, the output device rate is detected, and
 * each save says how both were known (docs/inspector/timing-sessions.md).
 */
import type { DeviceRateSource, LastSetup, SaveRef, SetupSource } from "./contracts";

/** A value this browser remembers, with when it was typed or chosen (null: before that was kept). */
export interface Remembered<T> {
  value: T;
  at: string | null;
}

export interface SetupLine {
  text: string;
  source: SetupSource;
  from: SaveRef | null;
}

export interface DeviceRate {
  hz: number | null;
  source: DeviceRateSource;
  from: SaveRef | null;
}

/** A default context's rate, which is the output device's nominal rate, and when it was read. */
export interface Detection {
  hz: number;
  at: string;
}

/** Whether a remembered value is newer than a save; one kept without a time is older than any. */
function newerThanSave(at: string | null, save: SaveRef): boolean {
  return at !== null && at > save.time;
}

/**
 * The setup line a session opens with: the latest of the folder's last save and this browser's
 * value, by when each was saved or typed. The same text as the save counts as the save.
 */
export function initialSetup(last: LastSetup, browser: Remembered<string>): SetupLine {
  const saved = last.setup;
  const typed = browser.value.trim() ? browser : undefined;
  if (saved && (!typed || typed.value === saved.text || !newerThanSave(typed.at, saved.from)))
    return { text: saved.text, source: "last-save", from: saved.from };
  if (typed) return { text: typed.value, source: "browser", from: null };
  return { text: "", source: "none", from: null };
}

/** The setup as a save records it: an empty line is `none` whatever its history. */
export function recordedSetup(line: SetupLine): SetupLine {
  if (!line.text.trim()) return { text: "", source: "none", from: null };
  return { ...line, from: line.source === "last-save" ? line.from : null };
}

/**
 * The output device rate in force: one chosen since the session opened, else the detected rate,
 * else the latest carried rate (the folder's last save or this browser's, by time). A carried rate
 * is wrong after a change of device rate, so detection ranks above it.
 */
export function deviceRate(
  chosen: number | null,
  detected: Detection | null,
  last: LastSetup,
  browser: Remembered<number | null>,
): DeviceRate {
  if (chosen !== null) return { hz: chosen, source: "typed", from: null };
  if (detected) return { hz: detected.hz, source: "detected", from: null };
  const saved = last.device_rate;
  const remembered = browser.value !== null ? browser : undefined;
  if (saved && (!remembered || !newerThanSave(remembered.at, saved.from)))
    return { hz: saved.hz, source: "last-save", from: saved.from };
  if (remembered) return { hz: remembered.value, source: "browser", from: null };
  return { hz: null, source: "none", from: null };
}

/** A chosen rate that the detection contradicts. */
export function rateConflict(chosen: number | null, detected: Detection | null): boolean {
  return chosen !== null && detected !== null && chosen !== detected.hz;
}

type ProbeContext = { readonly sampleRate: number; close(): Promise<void> };

/**
 * Reads the output device's nominal rate from a short-lived default context, closed at once. A
 * context made without `sampleRate` takes the default output device's rate; a silent one
 * (`sinkId: { type: "none" }`) does not, so it is not used. Null when no context can be made.
 */
export function probeDeviceRate(
  create: () => ProbeContext = () => new AudioContext(),
  now: () => Date = () => new Date(),
): Detection | null {
  let context: ProbeContext;
  try {
    context = create();
  } catch {
    return null;
  }
  const hz = context.sampleRate;
  try {
    context.close().catch(() => {});
  } catch {}
  return Number.isFinite(hz) && hz > 0 ? { hz, at: now().toISOString() } : null;
}
