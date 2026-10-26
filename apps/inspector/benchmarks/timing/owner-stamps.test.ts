import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const script = readFileSync(new URL("./owner-stamps.js", import.meta.url), "utf8");

/**
 * Runs the probe as the DevTools console would, against a fake AudioContext and a page clock that
 * moves 100 ms per reading, and returns what it logged.
 */
async function probe(options: { consoleCopy: boolean; clipboard: boolean }) {
  const logged: { level: string; text: string }[] = [];
  const copied: string[] = [];
  let nowMs = 0;
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const log =
    (level: string) =>
    (...parts: unknown[]) => {
      logged.push({ level, text: parts.map(String).join(" ") });
      if (/copied|stopped/i.test(String(parts[0]))) done();
    };
  class AudioContext {
    readonly sampleRate: number;
    readonly baseLatency = 0.005;
    readonly outputLatency = 0.016;
    currentTime = 0;
    constructor(options: { sampleRate: number }) {
      this.sampleRate = options.sampleRate;
    }
    async resume() {}
    getOutputTimestamp() {
      return { contextTime: nowMs / 1000, performanceTime: nowMs };
    }
    async close() {}
  }
  const page = {
    AudioContext,
    performance: { now: () => (nowMs += 100) },
    setInterval: (callback: () => void) => setInterval(callback, 0),
    clearInterval,
    navigator: {
      userAgent: "test",
      clipboard: {
        writeText: async (text: string) => {
          if (!options.clipboard) throw new Error("Document is not focused.");
          copied.push(text);
        },
      },
    },
    console: { log: log("log"), warn: log("warn"), error: log("error") },
    ...(options.consoleCopy && { copy: (text: string) => copied.push(text) }),
  } as Record<string, unknown>;
  page.window = page;
  runInNewContext(script, page);
  await finished;
  return { logged, copied, kept: page.ownerStamps as string | undefined };
}

it("copies with the console's copy(), and says so", async () => {
  const { logged, copied } = await probe({ consoleCopy: true, clipboard: false });
  expect(copied).toHaveLength(1);
  expect(JSON.parse(copied[0] ?? "")).toMatchObject({ mode: "lab", owner: true });
  expect(logged.at(-1)).toMatchObject({ level: "log", text: expect.stringMatching(/^Copied/) });
});

it("falls back to the clipboard API without the console's copy()", async () => {
  const { logged, copied } = await probe({ consoleCopy: false, clipboard: true });
  expect(copied).toHaveLength(1);
  expect(logged.at(-1)?.text).toMatch(/^Copied/);
});

it("says plainly when nothing was copied, and keeps the result to copy by hand", async () => {
  const { logged, copied, kept } = await probe({ consoleCopy: false, clipboard: false });
  expect(copied).toHaveLength(0);
  expect(logged.some((entry) => /^Copied/.test(entry.text))).toBe(false);
  expect(logged.at(-1)).toMatchObject({
    level: "error",
    text: expect.stringMatching(/NOT copied/),
  });
  expect(JSON.parse(kept ?? "")).toMatchObject({ owner: true });
});
