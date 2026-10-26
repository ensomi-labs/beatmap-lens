/**
 * Timing engine latency harness. Drives a timing bundle (or the lab page) in Chromium with
 * Playwright and writes the raw observations as JSON; `analyze.mjs` turns them into statistics.
 *
 *   node run.mjs app --app BUNDLE --label NAME --out DIR [--scenarios a,b] [--port 4190]
 *   node run.mjs lab --label NAME --out DIR [--port 4199]
 *
 * Chromium runs headless with --mute-audio: nothing reaches the speakers or headphones. A muted
 * page renders audio into Chromium's fake output stream, driven by a timer, so output latency and
 * the device clock are not CoreAudio's; the display path is headless Chromium's. Each result
 * records the browser, its flags and the machine.
 *
 * Playwright is not a repository dependency: set PLAYWRIGHT_CORE to a playwright-core package
 * directory. BENCH_BROWSER is "chrome" (the installed Google Chrome), "chromium" (Playwright's)
 * or a path to a Chromium executable.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeSession } from "./session.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    app: { type: "string" },
    label: { type: "string", default: "app" },
    out: { type: "string" },
    scenarios: {
      type: "string",
      default: "smoke,steady,positions,taps,clicks,start,presented",
    },
    port: { type: "string", default: "4190" },
  },
});
const mode = positionals[0];
if (!values.out || (mode !== "lab" && (mode !== "app" || !values.app))) {
  process.stderr.write(
    "Usage: run.mjs app --app BUNDLE --label NAME --out DIR | run.mjs lab --label NAME --out DIR\n",
  );
  process.exit(1);
}
if (!process.env.PLAYWRIGHT_CORE) {
  process.stderr.write("Set PLAYWRIGHT_CORE to a playwright-core package directory.\n");
  process.exit(1);
}
const { chromium } = createRequire(join(resolve(process.env.PLAYWRIGHT_CORE), "package.json"))(
  resolve(process.env.PLAYWRIGHT_CORE),
);
const instrument = readFileSync(join(here, "instrument.js"), "utf8");
const port = Number(values.port);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const browserChoice = process.env.BENCH_BROWSER ?? "chrome";
const browserArgs = ["--mute-audio", "--autoplay-policy=no-user-gesture-required"];
const viewport = { width: 1470, height: 920 };
const deviceScaleFactor = 2;

async function launch() {
  const options = { headless: true, args: browserArgs };
  if (browserChoice === "chrome") options.channel = "chrome";
  else if (browserChoice !== "chromium") options.executablePath = browserChoice;
  return chromium.launch(options);
}

function machine() {
  return {
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    cpus: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    node: process.version,
  };
}

/** Trace categories: frame pipeline, main-thread phases, garbage collection, animations. */
const traceCategories = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "blink.animations",
  "cc",
  "benchmark",
  "v8",
  "blink.user_timing",
  "toplevel",
];

/**
 * What the analysis needs from a Chrome trace, over the whole trace (it spans the recording):
 * frame states from the pipeline reporter, the page's main-thread tasks and garbage collections,
 * and whether animations ran on the compositor. The page's main thread is the renderer main
 * thread that fired the most animation frames.
 */
function summariseTrace(buffer) {
  const events = JSON.parse(buffer.toString()).traceEvents;
  const mains = new Set(
    events
      .filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain")
      .map((e) => `${e.pid}:${e.tid}`),
  );
  const fired = new Map();
  for (const e of events)
    if (e.name === "FireAnimationFrame" && mains.has(`${e.pid}:${e.tid}`))
      fired.set(`${e.pid}:${e.tid}`, (fired.get(`${e.pid}:${e.tid}`) ?? 0) + 1);
  const main = [...fired.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!main) return { error: "no renderer main thread with animation frames" };
  const [pid, tid] = main.split(":").map(Number);
  const frameStates = {};
  const gc = [];
  let taskMs = 0;
  let tasks = 0;
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;
  const animations = {};
  for (const e of events) {
    if (e.pid !== pid) continue;
    if (e.name === "PipelineReporter" && (e.ph === "b" || e.ph === "X")) {
      const state =
        e.args?.chrome_frame_reporter?.state ?? e.args?.frame_reporter?.state ?? "unknown";
      frameStates[state] = (frameStates[state] ?? 0) + 1;
    }
    if (e.tid === tid && e.ph === "X") {
      firstTs = Math.min(firstTs, e.ts);
      lastTs = Math.max(lastTs, e.ts + (e.dur ?? 0));
      if (
        /^(MinorGC|MajorGC|V8\.GC_SCAVENGER|V8\.GCScavenger|V8\.GCFinalizeMC|V8\.GC_MARK_COMPACTOR|V8\.GCIncrementalMarking)$/.test(
          e.name,
        )
      )
        gc.push({ name: e.name, dur: (e.dur ?? 0) / 1000 });
      if (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask") {
        taskMs += (e.dur ?? 0) / 1000;
        tasks++;
      }
    }
    if (e.name === "Animation" && e.args?.data) {
      const key = JSON.stringify({
        compositeFailed: e.args.data.compositeFailed ?? null,
        unsupportedProperties: e.args.data.unsupportedProperties ?? null,
      });
      animations[key] = (animations[key] ?? 0) + 1;
    }
  }
  return {
    frameStates,
    gc,
    mainThread: { tasks, taskMs, spanMs: (lastTs - firstTs) / 1000 },
    animations,
  };
}

// --- Pixels -----------------------------------------------------------------------------------

/**
 * Finds the playhead red (#ff4d4f, possibly translucent over the dark stage) in one row of each
 * PNG, decoded in a helper page; returns the red centroid in image px, or null, and the width.
 */
async function redCentroids(decoder, pngs, row) {
  const results = [];
  for (let i = 0; i < pngs.length; i += 16) {
    const batch = pngs
      .slice(i, i + 16)
      .map((png) => (typeof png === "string" ? png : png.toString("base64")));
    results.push(
      ...(await decoder.evaluate(
        async ({ batch, row }) => {
          const out = [];
          for (const data of batch) {
            const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
            const bitmap = await createImageBitmap(blob);
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext("2d");
            context.drawImage(bitmap, 0, 0);
            const y = Math.min(bitmap.height - 1, Math.round(row * bitmap.height));
            const pixels = context.getImageData(0, y, bitmap.width, 1).data;
            let sum = 0;
            let weight = 0;
            for (let x = 0; x < bitmap.width; x++) {
              const r = pixels[x * 4];
              const g = pixels[x * 4 + 1];
              const b = pixels[x * 4 + 2];
              const redness = r - Math.max(g, b);
              if (r > 60 && redness > 30) {
                sum += x * redness;
                weight += redness;
              }
            }
            out.push({
              x: weight ? sum / weight : null,
              width: bitmap.width,
              height: bitmap.height,
            });
          }
          return out;
        },
        { batch, row },
      )),
    );
  }
  return results;
}

/** Screencast frames (PNG, with swap time stamps) while `act` runs. */
async function screencast(context, page, act) {
  const cdp = await context.newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", (frame) => {
    frames.push({ data: frame.data, swapS: frame.metadata?.timestamp ?? null });
    cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  try {
    await act();
  } finally {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return frames;
}

// --- Lab --------------------------------------------------------------------------------------

async function runLab() {
  const html = readFileSync(join(here, "lab.html"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  }).listen(port, "127.0.0.1");
  const browser = await launch();
  const result = {
    mode: "lab",
    when: new Date().toISOString(),
    machine: machine(),
    browser: { choice: browserChoice, version: browser.version(), args: browserArgs },
    experiments: {},
  };
  try {
    const context = await browser.newContext({
      viewport: { width: 1470, height: 420 },
      deviceScaleFactor,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/lab.html`);
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    const attempt = async (name, run) => {
      process.stderr.write(`lab ${name}\n`);
      try {
        result.experiments[name] = await run();
      } catch (error) {
        result.experiments[name] = { error: String(error?.stack ?? error) };
      }
    };
    await attempt("offline", () => page.evaluate(() => window.lab.offlineExactness()));
    await attempt("contextOptions", async () => {
      const out = [];
      for (const hint of ["interactive", "balanced", "playback", 0.003, 0.02])
        out.push(await page.evaluate(([hint]) => window.lab.contextOptions(hint, 3), [hint]));
      return out;
    });
    await attempt("display", async () => {
      const decoder = await context.newPage();
      const out = [];
      const matrix = [];
      for (const load of ["none", "steady8", "burst"])
        for (const variant of ["canvas-now", "canvas-frame", "dom-frame", "waapi", "canvas-desync"])
          matrix.push([variant, load]);
      for (const load of ["none", "burst"])
        for (const variant of [
          "waapi-noraf",
          "waapi-hud10",
          "waapi-hud60",
          "waapi-timer",
          "waapi-timer-hud10",
        ])
          matrix.push([variant, load]);
      for (const [variant, load] of matrix) {
        let run;
        const frames = await screencast(context, page, async () => {
          run = await page.evaluate(
            ([variant, load]) => window.lab.displayVariant(variant, load, 2.6),
            [variant, load],
          );
        });
        // The stage is the top 400 of 420 CSS px; read the row at 200 px.
        const centroids = await redCentroids(
          decoder,
          frames.map((f) => f.data),
          200 / 420,
        );
        out.push({
          ...run,
          presented: frames.map((frame, index) => ({
            swapMs: frame.swapS === null ? null : frame.swapS * 1000 - run.timeOrigin,
            x: centroids[index]?.x ?? null,
            imageWidth: centroids[index]?.width ?? null,
          })),
        });
      }
      await decoder.close();
      return out;
    });
    result.errors = errors;
  } finally {
    await browser.close();
    server.close();
  }
  return result;
}

// --- App --------------------------------------------------------------------------------------

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

/** A fresh session, server, context and page for one scenario. */
async function open(browser, { marks = 0, preferences = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "timing-bench-"));
  const { sessionPath, marksPath } = writeSession(dir, { marks });
  const server = await startServer(sessionPath);
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  const prefs = { setup: "latency harness", deviceRateHz: 48_000, volume: 0.5, ...preferences };
  await context.addInitScript((prefs) => {
    localStorage.setItem("lens-timing-preferences", JSON.stringify(prefs));
  }, prefs);
  await context.addInitScript({ content: instrument });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/timing?session=${encodeURIComponent(sessionPath)}`);
  await page.waitForSelector(".timing-stage-overlay", { timeout: 20_000 });
  const close = async () => {
    await context.close();
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  };
  return { page, context, marksPath, errors, close };
}

/** Moves to the passage at `index` (0-based) with Shift+[ and Shift+], and waits for it. */
async function passage(page, index) {
  const current = async () => {
    const text = await page.locator(".timing-hud").innerText();
    return Number(/Passage (\d+) of/.exec(text)?.[1] ?? 0) - 1;
  };
  for (let i = 0; i < 6; i++) {
    const at = await current();
    if (at === index) break;
    await page.keyboard.press(at < index ? "Shift+BracketRight" : "Shift+BracketLeft");
    await sleep(400);
  }
  await page.waitForSelector(".timing-stage-overlay", { timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".timing-stage-note"), null, {
    timeout: 30_000,
  });
  await sleep(400);
}

async function stageBox(page) {
  return page.locator(".timing-stage-overlay").boundingBox();
}

async function record(page, act, { browser, trace = false, samplePlayhead = false } = {}) {
  if (trace) await browser.startTracing(page, { categories: traceCategories });
  await page.evaluate((samplePlayhead) => {
    performance.mark("bench-sync");
    window.__bench.samplePlayhead = samplePlayhead;
    if (samplePlayhead) window.__bench.startSampler();
    window.__bench.recording = true;
  }, samplePlayhead);
  await act();
  await page.evaluate(() => {
    window.__bench.recording = false;
    window.__bench.samplePlayhead = false;
  });
  const bench = await page.evaluate(() => {
    const { contexts, current, baseDraw, lastBaseDraw, elementPlayheadX, startSampler, ...rest } =
      window.__bench;
    const result = {
      ...rest,
      baseDraws: [lastBaseDraw, ...rest.baseDraws].filter(Boolean),
      contexts: contexts.map((c) => ({
        sampleRate: c.sampleRate,
        baseLatency: c.baseLatency,
        outputLatency: c.outputLatency,
        state: c.state,
      })),
      dpr: window.devicePixelRatio,
    };
    for (const key of ["frames", "playhead", "baseDraws", "stamps", "starts", "keys", "loafs"])
      if (Array.isArray(window.__bench[key])) window.__bench[key] = [];
    return result;
  });
  if (trace) bench.trace = summariseTrace(await browser.stopTracing());
  return bench;
}

/** Busy main-thread work in the page: `ms` long, every `everyMs`, `count` times. */
function jank(page, ms, everyMs, count) {
  return page.evaluate(
    ([ms, everyMs, count]) => {
      let done = 0;
      const timer = setInterval(() => {
        const until = performance.now() + ms;
        while (performance.now() < until);
        if (++done >= count) clearInterval(timer);
      }, everyMs);
    },
    [ms, everyMs, count],
  );
}

/** Fine zoom (0.5 ms per device pixel) around the playhead at the passage start. */
async function fineAtStart(page) {
  await page.keyboard.press("Home");
  await page.keyboard.press("z");
  await sleep(400);
}

const scenarios = {
  /** The control-plane smoke checks, ported: playhead pixels, marks, nudges, clicks, saves. */
  async smoke(browser) {
    const run = await open(browser);
    const checks = [];
    const check = (name, ok, evidence) => checks.push({ name, ok: Boolean(ok), evidence });
    try {
      const { page, context } = run;
      await passage(page, 0);
      const decoder = await context.newPage();
      const playheadX = async () => {
        const box = await stageBox(page);
        const png = await page.screenshot({
          clip: { x: box.x, y: box.y + 12, width: box.width, height: 1 },
        });
        const [hit] = await redCentroids(decoder, [png], 0);
        return hit?.x ?? null;
      };
      await page.evaluate(() => {
        window.__starts = [];
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
          window.__starts.push({ when: args[0], offset: args[1], length: this.buffer?.length });
          return start.apply(this, args);
        };
      });
      await page.keyboard.press("Space");
      await sleep(400);
      const xs = [];
      for (let i = 0; i < 6; i++) {
        xs.push(await playheadX());
        await sleep(250);
      }
      check(
        "playhead pixels move while playing",
        xs.every((x, i) => i === 0 || (x !== null && xs[i - 1] !== null && x > xs[i - 1])),
        { xs },
      );
      await page.keyboard.press("Space");
      await sleep(250);
      const paused = [await playheadX()];
      await sleep(300);
      paused.push(await playheadX());
      check("playhead holds after pause", paused[0] !== null && paused[0] === paused[1], {
        paused,
      });

      const box = await stageBox(page);
      const waveY = box.y + box.height * 0.55;
      await page.keyboard.press("0");
      await sleep(250);
      await page.mouse.click(box.x + box.width * 0.3, waveY);
      await page.keyboard.down("Shift");
      await page.mouse.click(box.x + box.width * 0.4, waveY);
      await page.mouse.click(box.x + box.width * 0.6, waveY);
      await page.keyboard.up("Shift");
      await sleep(150);
      const count = () => page.locator(".timing-mark-list li").count();
      check("Shift+click places, click does not", (await count()) === 2, { marks: await count() });
      await page.mouse.move(box.x + box.width * 0.35, waveY);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, waveY, { steps: 4 });
      await page.mouse.move(box.x + box.width * 0.65, waveY, { steps: 4 });
      await page.mouse.up();
      await sleep(150);
      const heading = (await page.locator(".timing-marks-heading .rail-count").innerText()).trim();
      check("drag selects the marks in range", heading === "2 of 2", { heading });
      const times = () => page.locator(".timing-mark-time").allInnerTexts();
      const before = await times();
      await page.getByRole("button", { name: "+5", exact: true }).click();
      await page.getByRole("button", { name: "+15", exact: true }).click();
      await page.getByRole("button", { name: "−2", exact: true }).click();
      const after = await times();
      check("nudge buttons move the selection", before.join() !== after.join(), { before, after });
      await page.keyboard.press("Delete");
      await sleep(150);
      check("Delete removes the selection", (await count()) === 0, { marks: await count() });

      await page.keyboard.down("Shift");
      await page.mouse.click(box.x + box.width * 0.5, waveY);
      await page.keyboard.up("Shift");
      await page.keyboard.press("c");
      const [beatText] = await times();
      const [mm, ss] = beatText.split(":");
      const beatS = Number(mm) * 60 + Number(ss);
      await page.mouse.click(box.x + box.width * 0.45, box.y + 10);
      await page.evaluate(() => {
        window.__starts = [];
      });
      await page.keyboard.press("Space");
      await sleep(1500);
      await page.keyboard.press("b");
      await sleep(300);
      const starts = await page.evaluate(() => window.__starts);
      await page.keyboard.press("Escape");
      const music = starts.find((s) => s.length > 2000);
      const clicks = starts.filter((s) => s.length && s.length < 2000);
      const expected = music ? music.when + (beatS - music.offset) : null;
      const errorS = clicks[0] && expected !== null ? clicks[0].when - expected : null;
      // The list shows ms to 0.001; the click is checked to that resolution.
      check(
        "own beat clicks on the music's sample",
        clicks.length === 1 && Math.abs(errorS) < 2e-6,
        {
          beatS,
          music,
          clicks: clicks.map((s) => s.when),
          errorS,
        },
      );
      await page.keyboard.press("Enter");
      await sleep(600);
      const lines = readFileSync(run.marksPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const saved = lines.findLast((line) => line.passage_id === "p-noise48");
      check(
        "save records key-playing and mark_clicks",
        saved?.marks.some((m) => m.method === "key-playing") &&
          saved?.playback.mark_clicks === true,
        { methods: saved?.marks.map((m) => m.method), mark_clicks: saved?.playback.mark_clicks },
      );
      const stageBefore = (await stageBox(page)).width;
      await page.getByRole("button", { name: "Hide passages" }).click();
      await sleep(400);
      const stageAfter = (await stageBox(page)).width;
      check("hiding passages widens the stage", stageAfter > stageBefore + 200, {
        stageBefore,
        stageAfter,
      });
      await page.keyboard.press("Space");
      await sleep(300);
      const late = [await playheadX()];
      await sleep(400);
      late.push(await playheadX());
      await page.keyboard.press("Escape");
      check("playhead still moves", late[0] !== null && late[1] > late[0], { late });
      check("no page errors", run.errors.length === 0, { errors: run.errors });
      await decoder.close();
    } catch (error) {
      check("scenario completed", false, { error: String(error?.stack ?? error) });
    } finally {
      await run.close();
    }
    return { checks };
  },

  /** 10 s of playback at fine zoom with 200 saved marks, follow on, traced; no playhead sampling. */
  async steady(browser) {
    const run = await open(browser, { marks: 200 });
    try {
      await passage(run.page, 0);
      await fineAtStart(run.page);
      const bench = await record(
        run.page,
        async () => {
          await run.page.keyboard.press("Space");
          await sleep(10_000);
          await run.page.keyboard.press("Escape");
          await sleep(200);
        },
        { browser, trace: true },
      );
      return { ...bench, errors: run.errors };
    } finally {
      await run.close();
    }
  },

  /** 6 s of playback at fine zoom, follow on, with the playhead's position read every frame. */
  async positions(browser) {
    const run = await open(browser);
    try {
      await passage(run.page, 0);
      await fineAtStart(run.page);
      const bench = await record(
        run.page,
        async () => {
          await run.page.keyboard.press("Space");
          await sleep(6000);
          await run.page.keyboard.press("Escape");
          await sleep(200);
        },
        { samplePlayhead: true },
      );
      return { ...bench, errors: run.errors };
    } finally {
      await run.close();
    }
  },

  /**
   * Sixteen B presses while playing, every other one with 40 ms of main-thread work queued just
   * before it; then a save, whose marks are compared with the output clock at each press.
   */
  async taps(browser) {
    const run = await open(browser);
    try {
      const { page } = run;
      await passage(page, 0);
      await page.keyboard.press("Home");
      const bench = await record(page, async () => {
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
        await sleep(300);
      });
      await page.keyboard.press("Enter");
      await sleep(800);
      const lines = readFileSync(run.marksPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const save = lines.findLast((line) => line.passage_id === "p-noise48");
      bench.savedMarks = save
        ? save.marks.map((m) => ({ time_ms: m.time_ms, method: m.method }))
        : [];
      return { ...bench, errors: run.errors };
    } finally {
      await run.close();
    }
  },

  /**
   * Clicks on the saved marks of the pulse passage (one every 500 ms) while the main thread stalls
   * for 450 ms every 1.3 s, longer than the baseline's 200 ms lookahead; the period is not a
   * multiple of the beat, so the stalls meet the beats at every phase. Which clicks were
   * scheduled, on which context time, and how far ahead of their sounding.
   */
  async clicks(browser) {
    const run = await open(browser, { preferences: { markClicks: true } });
    try {
      const { page } = run;
      await passage(page, 1);
      await page.keyboard.press("Home");
      const bench = await record(page, async () => {
        await page.keyboard.press("Space");
        await sleep(500);
        await jank(page, 450, 1300, 6);
        await sleep(8500);
        await page.keyboard.press("Escape");
        await sleep(200);
      });
      const lines = readFileSync(run.marksPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const save = lines.findLast((line) => line.passage_id === "p-pulses48");
      bench.beatsMs = save ? save.marks.map((m) => m.time_ms) : [];
      return { ...bench, errors: run.errors };
    } finally {
      await run.close();
    }
  },

  /** Eight starts from a stop: key, play call, scheduled start and the start heard. */
  async start(browser) {
    const run = await open(browser);
    try {
      const { page } = run;
      await passage(page, 0);
      await page.keyboard.press("Home");
      const bench = await record(page, async () => {
        for (let i = 0; i < 8; i++) {
          await page.keyboard.press("Space");
          await sleep(700);
          await page.keyboard.press("Escape");
          await sleep(300);
        }
      });
      return { ...bench, errors: run.errors };
    } finally {
      await run.close();
    }
  },

  /**
   * The presented playhead: screencast frames during playback with follow off, at 2 ms per
   * device pixel, without and with 80 ms main-thread stalls every 500 ms. The red line is read in
   * the ruler row of each frame, with the frame's swap time.
   */
  async presented(browser) {
    const run = await open(browser);
    try {
      const { page, context } = run;
      await passage(page, 0);
      await fineAtStart(run.page);
      await page.keyboard.press("-");
      await page.keyboard.press("-");
      await page.keyboard.press("f");
      await sleep(500);
      const box = await stageBox(page);
      const decoder = await context.newPage();
      const out = {};
      for (const load of ["none", "burst"]) {
        await page.keyboard.press("Home");
        await sleep(400);
        let bench;
        const frames = await screencast(context, page, async () => {
          bench = await record(page, async () => {
            await page.keyboard.press("Space");
            if (load === "burst") await jank(page, 80, 500, 5);
            await sleep(2800);
            await page.keyboard.press("Escape");
            await sleep(200);
          });
        });
        const centroids = await redCentroids(
          decoder,
          frames.map((f) => f.data),
          (box.y + 14) / viewport.height,
        );
        out[load] = {
          ...bench,
          stage: box,
          presented: frames.map((frame, index) => ({
            swapMs: frame.swapS === null ? null : frame.swapS * 1000 - bench.timeOrigin,
            x: centroids[index]?.x ?? null,
            imageWidth: centroids[index]?.width ?? null,
          })),
        };
      }
      await decoder.close();
      return { ...out, errors: run.errors };
    } finally {
      await run.close();
    }
  },
};

async function runApp() {
  const browser = await launch();
  const result = {
    mode: "app",
    label: values.label,
    app: resolve(values.app),
    when: new Date().toISOString(),
    machine: machine(),
    browser: { choice: browserChoice, version: browser.version(), args: browserArgs },
    viewport,
    deviceScaleFactor,
    scenarios: {},
  };
  try {
    for (const name of values.scenarios.split(",")) {
      const scenario = scenarios[name];
      if (!scenario) throw new Error(`Unknown scenario ${name}`);
      process.stderr.write(`${values.label} ${name}\n`);
      const started = Date.now();
      try {
        result.scenarios[name] = await scenario(browser);
      } catch (error) {
        result.scenarios[name] = { error: String(error?.stack ?? error) };
      }
      result.scenarios[name].seconds = (Date.now() - started) / 1000;
    }
  } finally {
    await browser.close();
  }
  return result;
}

mkdirSync(values.out, { recursive: true });
const result = mode === "lab" ? await runLab() : await runApp();
const file = join(values.out, `${values.label}.json`);
writeFileSync(file, JSON.stringify(result));
process.stderr.write(`Wrote ${file}\n`);
