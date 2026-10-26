/**
 * Timing-mode latency harness: plays a synthetic session in headless Chromium against a built
 * timing bundle and writes the raw observations as JSON. `analyze.mjs` turns them into the
 * statistics that docs/inspector/timing-latency.md reports.
 *
 *   pnpm --filter @ensomi/beatmap-lens-inspector timing:bundle -- --out /tmp/timing-app
 *   node apps/inspector/benchmarks/timing/run.mjs --app /tmp/timing-app --out raw.json \
 *     [--scenarios steady,marks,hover,taps,start,capture] [--repeat 1] [--trace on|off]
 *
 * The repository does not depend on Playwright. Point the harness at a playwright-core install
 * and a Chromium binary with --playwright DIR and --chromium PATH, or with BENCH_PLAYWRIGHT and
 * BENCH_CHROMIUM. Headless Chromium's audio output is a fake device driven by a timer, and its
 * compositor draws in software: the numbers describe this machine's Chromium, not a Mac with a
 * real output device and display.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeSession } from "./session.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    app: { type: "string" },
    out: { type: "string" },
    label: { type: "string", default: "" },
    scenarios: { type: "string", default: "steady,marks,hover,taps,start,capture" },
    repeat: { type: "string", default: "1" },
    playwright: { type: "string", default: process.env.BENCH_PLAYWRIGHT ?? "" },
    chromium: { type: "string", default: process.env.BENCH_CHROMIUM ?? "" },
    port: { type: "string", default: "4311" },
    trace: { type: "string", default: "on" },
    "browser-args": { type: "string", default: "" },
  },
});
if (!values.app || !values.out || !values.playwright || !values.chromium) {
  process.stderr.write(
    "Usage: run.mjs --app BUNDLE --out FILE --playwright DIR --chromium PATH [--scenarios ...]\n",
  );
  process.exit(1);
}
const { chromium } = createRequire(join(resolve(values.playwright), "package.json"))(
  resolve(values.playwright),
);
const instrument = readFileSync(join(here, "instrument.js"), "utf8");
const port = Number(values.port);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Trace categories: frame pipeline (presentation), main-thread phases, GC and user timing. */
const traceCategories = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "blink.user_timing",
  "cc",
  "benchmark",
];

async function startServer(sessionPath) {
  const server = spawn(
    process.execPath,
    [join(values.app, "server", "timing-server.ts"), "--session", sessionPath, "--port", `${port}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  server.stdout.on("data", (data) => {
    output += data;
  });
  server.stderr.on("data", (data) => {
    output += data;
  });
  for (let i = 0; i < 100 && !output.includes("Timing mode:"); i++) await sleep(100);
  if (!output.includes("Timing mode:")) throw new Error(output);
  return server;
}

/** A fresh session, server, browser and page for one scenario run. */
async function open({ marks = 0, capture = false, preferences = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "timing-bench-"));
  const { sessionPath, marksPath } = writeSession(dir, { marks });
  const server = await startServer(sessionPath);
  const browser = await chromium.launch({
    executablePath: values.chromium,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      ...values["browser-args"].split(" ").filter(Boolean),
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1470, height: 920 },
    deviceScaleFactor: 2,
  });
  const prefs = { setup: "latency harness", deviceRateHz: 48_000, volume: 0.5, ...preferences };
  await context.addInitScript(
    ({ prefs, capture }) => {
      localStorage.setItem("lens-timing-preferences", JSON.stringify(prefs));
      if (capture) localStorage.setItem("benchCapture", "1");
      else localStorage.removeItem("benchCapture");
    },
    { prefs, capture },
  );
  await context.addInitScript({ content: instrument });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector(".timing-stage-overlay");
  const close = async () => {
    await browser.close();
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  };
  return { page, browser, marksPath, errors, close };
}

/** Opens the passage with this id from the passage list and waits for its spectrogram. */
async function passage(page, id) {
  const current = await page.locator(".task-row.is-active").innerText();
  if (!current.includes(id)) await page.locator(".task-row", { hasText: id }).click();
  await page.waitForFunction(
    (id) => document.querySelector(".task-row.is-active")?.textContent?.includes(id),
    id,
  );
  await page.waitForSelector(".timing-stage-overlay");
  await page.waitForFunction(() => !document.querySelector(".timing-stage-note"), null, {
    timeout: 20_000,
  });
  await sleep(300);
}

/** Clicks the ruler at a fraction of the stage width, which seeks there. */
async function seekRuler(page, fraction) {
  const box = await page.locator(".timing-stage-overlay").boundingBox();
  await page.mouse.click(box.x + box.width * fraction, box.y + 8);
  await page.mouse.move(box.x + box.width * 0.5, box.y - 40);
}

async function record(page, browser, trace, act) {
  if (trace) await browser.startTracing(page, { categories: traceCategories });
  await page.evaluate(() => {
    performance.mark("bench-sync");
    window.__bench.recording = true;
  });
  await act();
  await page.evaluate(() => {
    window.__bench.recording = false;
    performance.mark("bench-sync");
  });
  const bench = await page.evaluate(() => {
    const { contexts, current, ...rest } = window.__bench;
    return {
      ...rest,
      contexts: contexts.map((c) => ({
        sampleRate: c.sampleRate,
        baseLatency: c.baseLatency,
        outputLatency: c.outputLatency,
        state: c.state,
      })),
      dpr: window.devicePixelRatio,
      userAgent: navigator.userAgent,
    };
  });
  if (trace) bench.trace = summariseTrace(await browser.stopTracing());
  return bench;
}

/**
 * Keeps what the analysis needs from a Chrome trace, on the page's performance clock (ms):
 * presentation of each frame (PipelineReporter), main-thread phases, GC and long tasks.
 */
function summariseTrace(buffer) {
  const events = JSON.parse(buffer.toString()).traceEvents;
  const sync = events.find((e) => e.name === "bench-sync" && e.args?.data?.startTime !== undefined);
  if (!sync) return { error: "no sync mark" };
  const offsetUs = sync.ts - sync.args.data.startTime * 1000;
  const ms = (ts) => (ts - offsetUs) / 1000;
  const main = sync.tid;
  const pid = sync.pid;
  const open = new Map();
  const frames = [];
  for (const e of events) {
    if (e.name !== "PipelineReporter" || e.pid !== pid) continue;
    const key = JSON.stringify(e.id2 ?? e.id);
    if (e.ph === "b") open.set(key, e);
    else if (e.ph === "e" && open.has(key)) {
      const begin = open.get(key);
      open.delete(key);
      const reporter = begin.args?.frame_reporter ?? {};
      frames.push({
        begin: ms(begin.ts),
        end: ms(e.ts),
        state: reporter.state,
        sequence: reporter.frame_sequence,
        mainAnimation: reporter.has_main_animation,
      });
    }
  }
  const wanted = new Set([
    "ProxyMain::BeginMainFrame",
    "FireAnimationFrame",
    "UpdateLayoutTree",
    "Layout",
    "Paint",
    "PrePaint",
    "MinorGC",
    "MajorGC",
    "V8.GC_SCAVENGER",
    "V8.GC_MC_BACKGROUND_EVACUATE_COPY",
    "RunTask",
    "FunctionCall",
    "EventDispatch",
  ]);
  const phases = [];
  for (const e of events)
    if (e.pid === pid && e.tid === main && e.ph === "X" && wanted.has(e.name))
      phases.push({ name: e.name, start: ms(e.ts), dur: (e.dur ?? 0) / 1000 });
  return { frames, phases };
}

/** Plays 10 s at 0.5 ms per device pixel with follow on; `during` runs while it plays. */
async function steadyRun(page, browser, during = async () => sleep(10_000)) {
  await passage(page, "p-noise48");
  await page.keyboard.press("Home");
  await page.keyboard.press("z");
  await sleep(300);
  return record(page, browser, values.trace === "on", async () => {
    await page.keyboard.press("Space");
    await during();
    await page.keyboard.press("Escape");
    await sleep(200);
  });
}

const scenarios = {
  /** Steady playback, no interaction, no marks. */
  async steady() {
    const run = await open({});
    try {
      return { ...(await steadyRun(run.page, run.browser)), errors: run.errors };
    } finally {
      await run.close();
    }
  },
  /** As steady, with 1,000 saved marks on the passage and clicks on the listener's beats. */
  async marks() {
    const run = await open({ marks: 1000, preferences: { markClicks: true } });
    try {
      return { ...(await steadyRun(run.page, run.browser)), errors: run.errors };
    } finally {
      await run.close();
    }
  },
  /** As steady, with the pointer moving over the stage throughout (hover line redraws). */
  async hover() {
    const run = await open({});
    try {
      const box = await run.page.locator(".timing-stage-overlay").boundingBox();
      const result = await steadyRun(run.page, run.browser, async () => {
        const until = Date.now() + 10_000;
        for (let i = 0; Date.now() < until; i++) {
          const x = box.x + box.width * (0.2 + 0.6 * ((i % 200) / 200));
          await run.page.mouse.move(x, box.y + box.height * 0.6);
          await sleep(8);
        }
      });
      return { ...result, errors: run.errors };
    } finally {
      await run.close();
    }
  },
  /**
   * Sixteen B presses while playing, every other one after 40 ms of main-thread work queued just
   * before it; then a save, whose marks are compared with the output clock at each key's
   * timeStamp.
   */
  async taps() {
    const run = await open({});
    try {
      const { page, browser } = run;
      await passage(page, "p-noise48");
      await page.keyboard.press("Home");
      const result = await record(page, browser, false, async () => {
        await page.keyboard.press("Space");
        await sleep(800);
        for (let i = 0; i < 16; i++) {
          if (i % 2)
            await page.evaluate(() =>
              setTimeout(() => {
                const until = performance.now() + 40;
                while (performance.now() < until);
              }, 0),
            );
          await page.keyboard.press("b");
          await sleep(280 + (i % 3) * 37);
        }
        await page.keyboard.press("Escape");
        await sleep(200);
      });
      await page.keyboard.press("Enter");
      await sleep(800);
      const lines = readFileSync(run.marksPath, "utf8").trim().split("\n").map(JSON.parse);
      const save = lines.findLast((line) => line.passage_id === "p-noise48");
      result.savedMarks = save ? save.marks.map((m) => ({ time_ms: m.time_ms, method: m.method })) : [];
      return { ...result, errors: run.errors };
    } finally {
      await run.close();
    }
  },
  /** Eight starts from a stop: key to scheduled start to the first sample at the output. */
  async start() {
    const run = await open({});
    try {
      const { page, browser } = run;
      await passage(page, "p-noise48");
      await page.keyboard.press("Home");
      const result = await record(page, browser, false, async () => {
        for (let i = 0; i < 8; i++) {
          await page.keyboard.press("Space");
          await sleep(700);
          await page.keyboard.press("Escape");
          await sleep(300);
        }
      });
      return { ...result, errors: run.errors };
    } finally {
      await run.close();
    }
  },
  /**
   * The context's output, captured: music from a fractional seek (sample exactness), a loop whose
   * edges were set at fractional playhead times (exactness after the wrap), and clicks on marks
   * at known offsets from the pulses, at rates 1 and 0.5 and in a loop.
   */
  async capture() {
    const run = await open({ capture: true });
    try {
      const { page, browser } = run;
      const out = {};
      await passage(page, "p-noise48");
      await seekRuler(page, 0.4137);
      out.seek = await record(page, browser, false, async () => {
        await page.keyboard.press("Space");
        await sleep(2500);
        await page.keyboard.press("Escape");
        await sleep(300);
      });
      await seekRuler(page, 0.3021);
      await page.keyboard.press("i");
      await seekRuler(page, 0.3517);
      await page.keyboard.press("o");
      await page.keyboard.press("l");
      out.loop = await record(page, browser, false, async () => {
        await page.keyboard.press("Space");
        await sleep(4000);
        await page.keyboard.press("Escape");
        await sleep(300);
      });
      await page.keyboard.press("l");
      await passage(page, "p-pulses48");
      await page.keyboard.press("c");
      await page.keyboard.press("Home");
      out.clicks = await record(page, browser, false, async () => {
        await page.keyboard.press("Space");
        await sleep(4000);
        await page.keyboard.press("Escape");
        await sleep(300);
      });
      await page.getByRole("button", { name: "0.5×", exact: true }).click();
      await page.keyboard.press("Home");
      out.clicksHalf = await record(page, browser, false, async () => {
        await page.keyboard.press("Space");
        await sleep(4000);
        await page.keyboard.press("Escape");
        await sleep(300);
      });
      await page.getByRole("button", { name: "1×", exact: true }).click();
      await seekRuler(page, 0.2);
      await page.keyboard.press("i");
      await seekRuler(page, 0.2731);
      await page.keyboard.press("o");
      await page.keyboard.press("l");
      out.clicksLoop = await record(page, browser, false, async () => {
        await page.keyboard.press("Space");
        await sleep(4000);
        await page.keyboard.press("Escape");
        await sleep(300);
      });
      return { ...out, errors: run.errors };
    } finally {
      await run.close();
    }
  },
};

const results = { label: values.label, app: resolve(values.app), when: new Date().toISOString(), runs: [] };
for (let repeat = 0; repeat < Number(values.repeat); repeat++)
  for (const name of values.scenarios.split(",")) {
    const scenario = scenarios[name];
    if (!scenario) throw new Error(`Unknown scenario ${name}`);
    process.stderr.write(`${name} #${repeat + 1}\n`);
    results.runs.push({ scenario: name, repeat, ...(await scenario()) });
  }
writeFileSync(values.out, JSON.stringify(results));
process.stderr.write(`Wrote ${values.out}\n`);
