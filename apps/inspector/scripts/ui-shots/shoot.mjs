/**
 * Screenshots and browser checks of the Inspector, on inputs from fixtures.mjs.
 *
 * Timing runs from a built timing bundle with its plain-Node server; the other modes run from a
 * Vite dev server started by the caller. Playwright is not a dependency of this repository: give
 * PLAYWRIGHT_DIR, a folder where `npm install playwright` was run.
 *
 *   node fixtures.mjs DIR
 *   PLAYWRIGHT_DIR=... node shoot.mjs --app BUNDLE --inputs DIR --out SHOTS \
 *     [--port 4191] [--dev http://127.0.0.1:4192] [--only timing,checks,fixes,modes]
 *
 * Writes JPEG screenshots and `results.json` (checks and layout measurements) into SHOTS.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    app: { type: "string" },
    inputs: { type: "string" },
    out: { type: "string" },
    port: { type: "string", default: "4191" },
    dev: { type: "string" },
    only: { type: "string", default: "timing,checks,fixes,modes" },
  },
});
if (!values.app || !values.inputs || !values.out) {
  process.stderr.write("Usage: shoot.mjs --app BUNDLE --inputs DIR --out SHOTS [--dev URL]\n");
  process.exit(1);
}
const app = resolve(values.app);
const inputs = resolve(values.inputs);
const out = resolve(values.out);
const port = Number(values.port);
const only = new Set(values.only.split(","));
mkdirSync(out, { recursive: true });

const require = createRequire(join(resolve(process.env.PLAYWRIGHT_DIR ?? "."), "index.js"));
const { chromium } = require("playwright");

const session = join(inputs, "music", "sessions", "music.timing.json");
const marksFile = join(inputs, "music", "sessions", "music.timing.marks.jsonl");
const fixtures = join(inputs, "fixtures");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const results = { checks: [], measurements: {}, errors: {} };

function record(name, ok, evidence) {
  results.checks.push({ name, ok, evidence });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} ${JSON.stringify(evidence)}`);
}

async function check(name, body) {
  try {
    const { ok, ...evidence } = await body();
    record(name, ok, evidence);
  } catch (error) {
    record(name, false, { error: String(error).slice(0, 400) });
  }
}

const shot = (page, name) =>
  page.screenshot({ path: join(out, `${name}.jpg`), type: "jpeg", quality: 88 });

const browser = await chromium.launch({
  headless: true,
  args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"],
});

async function newPage(width, height, dpr = 1) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem("lens-timing-preferences"))
      localStorage.setItem(
        "lens-timing-preferences",
        JSON.stringify({ setup: "DT 270 PRO · FineTune bypassed", deviceRateHz: 48000 }),
      );
    window.__starts = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.__starts.push({ when: args[0], offset: args[1], length: this.buffer?.length });
      return start.apply(this, args);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  return { context, page, errors };
}

// Timing ------------------------------------------------------------------------------------------

async function startTimingServer() {
  rmSync(marksFile, { force: true });
  const server = spawn(
    process.execPath,
    [join(app, "server", "timing-server.ts"), "--session", session, "--port", String(port)],
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
  if (!output.includes("Timing mode:")) throw new Error(`Timing server: ${output}`);
  return server;
}

async function openTiming(page) {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector(".timing-stage-overlay");
  await page.waitForFunction(() => !document.querySelector(".timing-stage-note"), null, {
    timeout: 20000,
  });
  await sleep(300);
  return page.locator(".timing-stage-overlay").boundingBox();
}

/** Five beats and an unbeat on the fitted passage, two of them selected by a drag. */
async function placeMarks(page, box) {
  const y = box.y + box.height * 0.6;
  await page.keyboard.press("0");
  await sleep(150);
  await page.keyboard.down("Shift");
  for (const f of [0.22, 0.31, 0.4, 0.49, 0.58]) await page.mouse.click(box.x + box.width * f, y);
  await page.keyboard.up("Shift");
  await page.mouse.click(box.x + box.width * 0.66, y, { button: "right" });
  await page.mouse.move(box.x + box.width * 0.36, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, y, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.52, y, { steps: 4 });
  await page.mouse.up();
  await page.mouse.move(box.x + box.width * 0.47, box.y + box.height * 0.3);
  await sleep(200);
}

function measure(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    const visible = [...document.querySelectorAll("button")].filter((b) => {
      const r = b.getBoundingClientRect();
      return b.offsetParent && r.bottom > 0 && r.top < innerHeight && r.width > 0;
    });
    const heights = visible
      .map((b) => Math.round(b.getBoundingClientRect().height))
      .sort((a, b) => a - b);
    const sizes = {};
    for (const element of document.querySelectorAll("body *")) {
      if (!element.offsetParent) continue;
      if (![...element.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const size = getComputedStyle(element).fontSize;
      sizes[size] = (sizes[size] ?? 0) + 1;
    }
    const save = [...document.querySelectorAll("button")].find((b) =>
      /Save marks/.test(b.textContent),
    );
    return {
      viewport: { w: innerWidth, h: innerHeight },
      stage: rect(".timing-stage-overlay"),
      toolbar: rect(".frame-toolbar"),
      status: rect(".frame-status"),
      left: rect(".frame-pane--left"),
      right: rect(".frame-pane--right"),
      visibleButtons: visible.length,
      buttonHeights: [...new Set(heights)],
      medianButtonHeight: heights[Math.floor(heights.length / 2)],
      fontSizes: sizes,
      saveRect: save ? rect(".timing-save") : null,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

async function timingShots() {
  const server = await startTimingServer();
  try {
    for (const [width, height] of [
      [1440, 900],
      [1100, 800],
    ]) {
      const { context, page, errors } = await newPage(width, height);
      try {
        const box = await openTiming(page);
        await placeMarks(page, box);
        await shot(page, `timing-${width}`);
        results.measurements[`timing-${width}`] = await measure(page);
        if (width === 1440) {
          await page.getByRole("button", { name: "Hide passages" }).click();
          await sleep(300);
          await shot(page, "timing-1440-hidden");
          await page.getByRole("button", { name: "Show passages" }).click();
          await page.focus('[role="separator"][aria-controls="timing-inspector"]');
          await page.keyboard.press("ArrowLeft");
          await page.keyboard.press("ArrowLeft");
          await sleep(200);
          await shot(page, "timing-1440-splitter-focus");
          await page.keyboard.press("Home");
          await page.mouse.click(box.x + box.width * 0.9, box.y + 8);
          await page.keyboard.press("Space");
          await sleep(900);
          await shot(page, "timing-1440-playing");
          await page.keyboard.press("Escape");
        }
        results.errors[`timing-${width}`] = errors;
      } finally {
        await context.close();
      }
    }
  } finally {
    server.kill();
  }
}

/** The checks of the Timing smoke harness, plus the resizable panes. */
async function timingChecks() {
  const server = await startTimingServer();
  const { context, page, errors } = await newPage(1440, 900, 2);
  try {
    let box = await openTiming(page);
    // The playhead is an element the compositor moves, not canvas pixels: read the presented
    // frame. A one-row screenshot through the ruler's red triangle, decoded in the page; the
    // centre of the red run, in device pixels from the stage's left edge.
    const playheadX = async () => {
      const stage = await page.locator(".timing-stage-overlay").boundingBox();
      const png = await page.screenshot({
        clip: { x: stage.x, y: stage.y + 2, width: stage.width, height: 1 },
      });
      return page.evaluate(async (data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        const row = context.getImageData(0, 0, bitmap.width, 1).data;
        const red = [];
        for (let x = 0; x < bitmap.width; x++) {
          const [r, g, b] = row.slice(x * 4, x * 4 + 3);
          if (r > 180 && g < 120 && b < 120 && r - g > 90) red.push(x);
        }
        return red.length ? (red[0] + red[red.length - 1]) / 2 : null;
      }, png.toString("base64"));
    };
    const count = () => page.locator(".timing-mark-list li").count();
    const times = () => page.locator(".timing-mark-time").allInnerTexts();
    const waveY = () => box.y + box.height * 0.55;

    await check("playhead pixels move while playing", async () => {
      await page.keyboard.press("Space");
      await sleep(300);
      const xs = [];
      for (let i = 0; i < 6; i++) {
        xs.push(await playheadX());
        await sleep(250);
      }
      await page.keyboard.press("Space");
      await sleep(200);
      const ok = xs.every((x, i) => i === 0 || (x !== null && xs[i - 1] !== null && x > xs[i - 1]));
      return { ok, xs, afterPause: await playheadX() };
    });

    await check("Shift+click places, click does not", async () => {
      await page.keyboard.press("0");
      await sleep(200);
      await page.mouse.click(box.x + box.width * 0.3, waveY());
      await page.keyboard.down("Shift");
      await page.mouse.click(box.x + box.width * 0.4, waveY());
      await page.mouse.click(box.x + box.width * 0.6, waveY());
      await page.keyboard.up("Shift");
      await sleep(100);
      return { ok: (await count()) === 2, marks: await count() };
    });

    await check("drag selects the marks in range", async () => {
      await page.mouse.move(box.x + box.width * 0.35, waveY());
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, waveY(), { steps: 4 });
      await page.mouse.move(box.x + box.width * 0.65, waveY(), { steps: 4 });
      await page.mouse.up();
      await sleep(100);
      const heading = await page.locator(".timing-marks-heading .rail-count").innerText();
      return { ok: heading.trim() === "2 of 2", heading };
    });

    await check("nudge buttons move the selection by +18 ms", async () => {
      const before = await times();
      await page.getByRole("button", { name: "+5", exact: true }).click();
      await page.getByRole("button", { name: "+15", exact: true }).click();
      await page.getByRole("button", { name: "−2", exact: true }).click();
      const after = await times();
      const seconds = (text) => {
        const [mm, ss] = text.split(":");
        return Number(mm) * 60 + Number(ss);
      };
      const moved = after.map(
        (text, i) => Math.round((seconds(text) - seconds(before[i])) * 1e6) / 1e3,
      );
      return { ok: moved.every((ms) => ms === 18), before, after, moved };
    });

    await check("Delete removes the selection", async () => {
      await page.keyboard.press("Delete");
      await sleep(100);
      return { ok: (await count()) === 0, marks: await count() };
    });

    await check("own beat clicks fall on the music's sample", async () => {
      await page.keyboard.down("Shift");
      await page.mouse.click(box.x + box.width * 0.5, waveY());
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
      return { ok: clicks.length === 1 && Math.abs(errorS) < 1e-6, beatS, errorS };
    });

    await check("Enter saves key-playing marks and mark_clicks", async () => {
      await page.keyboard.press("Enter");
      await sleep(600);
      const saved = existsSync(marksFile)
        ? readFileSync(marksFile, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .at(-1)
        : null;
      const methods = saved?.marks.map((m) => m.method);
      return {
        ok:
          Boolean(saved) && methods.includes("key-playing") && saved.playback.mark_clicks === true,
        methods,
        mark_clicks: saved?.playback.mark_clicks,
      };
    });

    await check("Save marks is on screen without scrolling", async () => {
      const save = await page.locator(".timing-save").boundingBox();
      return { ok: Boolean(save) && save.y >= 0 && save.y + save.height <= 900, save };
    });

    await check("hiding passages widens the stage", async () => {
      const before = (await page.locator(".timing-stage-overlay").boundingBox()).width;
      await page.getByRole("button", { name: "Hide passages" }).click();
      await sleep(300);
      const after = (await page.locator(".timing-stage-overlay").boundingBox()).width;
      await page.getByRole("button", { name: "Show passages" }).click();
      await sleep(300);
      return { ok: after > before + 150, before, after };
    });

    await check("a pane boundary resizes from the keyboard and the width persists", async () => {
      const splitter = page.locator('[role="separator"][aria-controls="timing-inspector"]');
      await splitter.focus();
      const start = Number(await splitter.getAttribute("aria-valuenow"));
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      const grown = Number(await splitter.getAttribute("aria-valuenow"));
      const stored = await page.evaluate(() => localStorage.getItem("lens-layout:timing"));
      await page.reload();
      box = await openTiming(page);
      const reloaded = Number(
        await page
          .locator('[role="separator"][aria-controls="timing-inspector"]')
          .getAttribute("aria-valuenow"),
      );
      const paneWidth = (await page.locator("#timing-inspector").boundingBox()).width;
      return {
        ok: grown === start + 32 && reloaded === grown && Math.abs(paneWidth - grown) <= 1,
        start,
        grown,
        reloaded,
        paneWidth,
        stored,
      };
    });

    await check("Enter on a boundary hides and restores its pane; Home and End clamp", async () => {
      const splitter = page.locator('[role="separator"][aria-controls="timing-inspector"]');
      await splitter.focus();
      await page.keyboard.press("Enter");
      await sleep(150);
      const hidden = !(await page.locator("#timing-inspector").isVisible());
      await page.keyboard.press("Enter");
      await sleep(150);
      const shown = await page.locator("#timing-inspector").isVisible();
      await page.keyboard.press("Home");
      const min = Number(await splitter.getAttribute("aria-valuenow"));
      await page.keyboard.press("End");
      const max = Number(await splitter.getAttribute("aria-valuenow"));
      await splitter.dblclick();
      const reset = Number(await splitter.getAttribute("aria-valuenow"));
      return { ok: hidden && shown && min < max && reset > min, hidden, shown, min, max, reset };
    });

    await check("dragging a boundary resizes, and the shortcuts still work after it", async () => {
      const splitter = page.locator('[role="separator"][aria-controls="timing-passages"]');
      const handle = await splitter.boundingBox();
      const before = (await page.locator("#timing-passages").boundingBox()).width;
      await page.evaluate(() => document.activeElement?.blur());
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 300);
      await page.mouse.down();
      await page.mouse.move(handle.x + 40, handle.y + 300, { steps: 4 });
      await page.mouse.move(handle.x + 80, handle.y + 300, { steps: 4 });
      await page.mouse.up();
      await sleep(200);
      const after = (await page.locator("#timing-passages").boundingBox()).width;
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("role"));
      const marks = await count();
      await page.keyboard.press("b");
      await sleep(100);
      return {
        ok:
          Math.abs(after - before - 80) <= 2 &&
          focused !== "separator" &&
          (await count()) === marks + 1,
        before,
        after,
        focused,
        marks,
      };
    });

    await check("playhead still moves after all of this", async () => {
      box = await page.locator(".timing-stage-overlay").boundingBox();
      await page.keyboard.press("Space");
      await sleep(300);
      const late = [await playheadX()];
      await sleep(400);
      late.push(await playheadX());
      await page.keyboard.press("Escape");
      return { ok: late[0] !== null && late[1] > late[0], late };
    });

    await check("no horizontal page scroll", async () => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      return { ok: overflow <= 0, overflow };
    });
    record("no page errors in the Timing checks", errors.length === 0, { errors });
  } finally {
    await context.close();
    server.kill();
  }
}

/** The passage shown, its view bar's height and the stage's top, after the stage has drawn. */
async function passageLayout(page) {
  return page.evaluate(() => {
    const bar = document.querySelector(".stage-toolbar")?.getBoundingClientRect();
    const stage = document.querySelector(".timing-stage-overlay")?.getBoundingClientRect();
    const identity = document.querySelector(".stage-identity")?.getBoundingClientRect();
    const hint = document.querySelector(".stage-hint");
    const flags = [...document.querySelectorAll(".stage-flag")].map((flag) => {
      const r = flag.getBoundingClientRect();
      return {
        text: flag.textContent.trim(),
        right: Math.round(r.right),
        left: Math.round(r.left),
      };
    });
    return {
      passage: document.querySelector(".stage-identity strong")?.textContent.trim(),
      barHeight: bar ? Math.round(bar.height) : null,
      stageTop: stage ? Math.round(stage.top) : null,
      identityRight: identity ? Math.round(identity.right) : null,
      identityTitle: document.querySelector(".stage-identity")?.getAttribute("title") ?? null,
      hintWidth:
        hint && getComputedStyle(hint).display !== "none"
          ? Math.round(hint.getBoundingClientRect().width)
          : 0,
      flags,
    };
  });
}

async function nextPassage(page) {
  const before = (await passageLayout(page)).passage;
  await page.keyboard.press("Shift+BracketRight");
  await page.waitForFunction(
    (text) =>
      document.querySelector(".stage-identity strong")?.textContent.trim() !== text &&
      document.querySelector(".timing-stage-overlay") &&
      !document.querySelector(".timing-stage-note"),
    before,
    { timeout: 20000 },
  );
  await sleep(400);
}

/** Every passage in turn, from the one open: the view bar's height and the stage's top in each. */
async function visitPassages(page) {
  const seen = [await passageLayout(page)];
  for (let i = 1; i < 6; i++) {
    await nextPassage(page);
    seen.push(await passageLayout(page));
  }
  return seen;
}

/** The boundary of the details pane at its widest: its value, the pane drawn, and one step back. */
async function widestBoundary(page, width) {
  const splitter = page.locator('[role="separator"][aria-controls="timing-inspector"]');
  const pane = () => page.locator("#timing-inspector").boundingBox();
  await splitter.focus();
  await page.keyboard.press("End");
  await sleep(150);
  const valueNow = Number(await splitter.getAttribute("aria-valuenow"));
  const valueMax = Number(await splitter.getAttribute("aria-valuemax"));
  const drawn = (await pane()).width;
  await page.keyboard.press("ArrowRight");
  await sleep(150);
  const stepValue = Number(await splitter.getAttribute("aria-valuenow"));
  const stepDrawn = (await pane()).width;
  await splitter.dblclick();
  await page.evaluate(() => document.activeElement?.blur());
  await sleep(150);
  const expected = Math.min(520, Math.floor(width * 0.38));
  return {
    ok:
      valueNow === expected &&
      valueMax === expected &&
      Math.abs(drawn - valueNow) <= 1 &&
      stepValue === valueNow - 16 &&
      Math.abs(stepDrawn - stepValue) <= 1,
    expected,
    valueNow,
    valueMax,
    drawn,
    stepValue,
    stepDrawn,
  };
}

/** Checks for the fixes of the review of 32261e7 (research note inspector-daw-ui-20261026, §7). */
async function timingFixChecks() {
  const server = await startTimingServer();
  try {
    {
      const { context, page, errors } = await newPage(1440, 900, 2);
      try {
        await openTiming(page);
        await check(
          "1440: the view bar and the stage keep their place across passages",
          async () => {
            const seen = await visitPassages(page);
            const heights = [...new Set(seen.map((entry) => entry.barHeight))];
            const tops = [...new Set(seen.map((entry) => entry.stageTop))];
            return { ok: heights.length === 1 && tops.length === 1, heights, tops, seen };
          },
        );

        await check(
          "the counter keeps its width as the sample index grows and while playing",
          async () => {
            const counter = async () =>
              page.evaluate(() => ({
                width: document.querySelector(".timing-counter").getBoundingClientRect().width,
                text: document
                  .querySelector(".timing-counter")
                  .textContent.replace(/\s+/g, " ")
                  .trim(),
                next: Math.round(
                  document.querySelector(".timing-blind").getBoundingClientRect().left,
                ),
              }));
            const seen = [];
            await page.keyboard.press("Home");
            await sleep(150);
            seen.push(await counter());
            await page.keyboard.press("End");
            await sleep(150);
            seen.push(await counter());
            await page.keyboard.press("z");
            await sleep(200);
            seen.push(await counter());
            await page.keyboard.press("z");
            await page.keyboard.press("Home");
            await page.keyboard.press("Space");
            for (let i = 0; i < 4; i++) {
              await sleep(300);
              seen.push(await counter());
            }
            await page.keyboard.press("Escape");
            const widths = [...new Set(seen.map((entry) => Math.round(entry.width * 100) / 100))];
            const next = [...new Set(seen.map((entry) => entry.next))];
            return { ok: widths.length === 1 && next.length === 1, widths, next, seen };
          },
        );

        await check("1440: a boundary's drawn width equals its value at the widest", () =>
          widestBoundary(page, 1440),
        );

        await check("the boundaries' grab areas stay off the stage", async () => {
          const stage = await page.locator(".timing-stage-overlay").boundingBox();
          const y = stage.y + stage.height / 2;
          const at = (x) =>
            page.evaluate(
              ([px, py]) => {
                const element = document.elementFromPoint(px, py);
                return element?.closest(".pane-splitter") ? "boundary" : (element?.className ?? "");
              },
              [x, y],
            );
          const probes = {
            stageLeft: await at(stage.x + 1),
            stageRight: await at(stage.x + stage.width - 2),
            paneLeft: await at(stage.x - 4),
            paneRight: await at(stage.x + stage.width + 4),
          };
          return {
            ok:
              probes.stageLeft !== "boundary" &&
              probes.stageRight !== "boundary" &&
              probes.paneLeft === "boundary" &&
              probes.paneRight === "boundary",
            ...probes,
          };
        });

        await check(
          "Space and Enter reach the shortcuts after a click on the help disclosure",
          async () => {
            const lines = () =>
              existsSync(marksFile) ? readFileSync(marksFile, "utf8").trim().split("\n").length : 0;
            await page.locator(".timing-help summary").click();
            await sleep(100);
            const focused = await page.evaluate(() => document.activeElement?.tagName);
            const open = await page.locator(".timing-help").evaluate((element) => element.open);
            await page.keyboard.press("Space");
            await sleep(500);
            const playing = await page
              .locator(".timing-transport .tool-button--play")
              .getAttribute("aria-pressed");
            await page.keyboard.press("Space");
            await sleep(150);
            await page.keyboard.press("b");
            await sleep(100);
            const before = lines();
            await page.keyboard.press("Enter");
            await sleep(700);
            const after = lines();
            await page.locator(".timing-help summary").click();
            return {
              ok: focused !== "SUMMARY" && open && playing === "true" && after === before + 1,
              focused,
              open,
              playing,
              saves: [before, after],
            };
          },
        );

        await check("a device change shows on the stage with Output and sync closed", async () => {
          const toggle = page.locator("#timing-sync .panel-section-toggle");
          if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
          const closed = (await toggle.getAttribute("aria-expanded")) === "false";
          await page.evaluate(() =>
            navigator.mediaDevices.dispatchEvent(new Event("devicechange")),
          );
          await sleep(250);
          const notice = await page.locator(".timing-hud-offset").boundingBox();
          const text = (await page.locator(".timing-hud-offset").innerText()).replace(/\s+/g, " ");
          const flagged = await page
            .locator(".frame-status .status-item.status-warning", { hasText: "Offset" })
            .innerText();
          const revealed = await toggle.getAttribute("aria-expanded");
          await shot(page, "timing-1440-device-change");
          await page.getByRole("button", { name: "Reopen audio", exact: true }).click();
          // The stage closes while the audio reopens; wait for it to be back.
          await sleep(300);
          await page.waitForFunction(
            () =>
              document.querySelector(".timing-stage-overlay") &&
              !document.querySelector(".timing-stage-note"),
            null,
            { timeout: 20000 },
          );
          await sleep(500);
          const afterReopen = await page.locator(".timing-hud-offset").count();
          await page.getByRole("button", { name: "Check offset", exact: true }).click();
          await sleep(200);
          const focused = await page.evaluate(() => document.activeElement?.id);
          await page.fill("#timing-offset", "0");
          await page.keyboard.press("Enter");
          await sleep(200);
          const cleared = (await page.locator(".timing-hud-offset").count()) === 0;
          const unflagged = await page
            .locator(".frame-status .status-item.status-warning", { hasText: "Offset" })
            .count();
          await page.evaluate(() => document.activeElement?.blur());
          return {
            ok:
              closed &&
              Boolean(notice) &&
              notice.y >= 0 &&
              notice.y + notice.height <= 900 &&
              /check/.test(flagged) &&
              revealed === "true" &&
              afterReopen === 1 &&
              focused === "timing-offset" &&
              cleared &&
              unflagged === 0,
            closed,
            notice,
            text,
            flagged,
            revealed,
            afterReopen,
            focused,
            cleared,
          };
        });
        record("no page errors in the fix checks at 1440", errors.length === 0, { errors });
      } finally {
        await context.close();
      }
    }
    {
      const { context, page, errors } = await newPage(1100, 800, 2);
      try {
        await openTiming(page);
        await check("1100: the view bar keeps one height, its flags and its hint", async () => {
          const seen = await visitPassages(page);
          const heights = [...new Set(seen.map((entry) => entry.barHeight))];
          const tops = [...new Set(seen.map((entry) => entry.stageTop))];
          const flagsWhole = seen.every((entry) =>
            entry.flags.every((flag) => flag.right <= entry.identityRight),
          );
          const hinted = seen.every(
            (entry) => entry.hintWidth > 0 && entry.identityTitle?.includes("·"),
          );
          return {
            ok: heights.length === 1 && tops.length === 1 && flagsWhole && hinted,
            heights,
            tops,
            seen,
          };
        });
        await check("1100: a boundary's drawn width equals its value at the widest", () =>
          widestBoundary(page, 1100),
        );
        record("no page errors in the fix checks at 1100", errors.length === 0, { errors });
      } finally {
        await context.close();
      }
    }
  } finally {
    server.kill();
  }
}

// Other modes -------------------------------------------------------------------------------------

async function openMode(page, base, mode) {
  await page.goto(`${base}/`);
  await page
    .getByRole("button", { name: new RegExp(`^${mode}$`, "i") })
    .first()
    .click();
  await sleep(300);
}

const modes = {
  async inspect(page, base) {
    await openMode(page, base, "inspect");
    await page
      .waitForSelector(".svg-output svg, .rendered-svg", { timeout: 10000 })
      .catch(() => {});
    await sleep(600);
  },
  async annotate(page, base) {
    await page.goto(`${base}/`);
    await page.getByLabel("Pseudonymous annotator ID").fill("expert-lantern");
    const method = page.getByLabel("Open from");
    if (await method.count()) await method.selectOption("paths");
    await page.getByLabel("Dataset directory path").fill(join(fixtures, "dataset"));
    await page.getByLabel("Catalog manifest path").fill(join(fixtures, "catalog.json"));
    await page.getByLabel("Mapped corpus directory path").fill(join(fixtures, "corpus"));
    await page.getByRole("button", { name: /Open workspace/ }).click();
    await page.waitForSelector(".workspace-frame", { timeout: 15000 });
    // Narrow windows show one view at a time; the task queue is under Source.
    const source = page.getByRole("button", { name: "Source", exact: true });
    if (await source.count()) await source.click();
    await page.waitForSelector(".task-row", { timeout: 15000 });
    await page.locator(".task-row").first().click();
    const preview = page.getByRole("button", { name: "Preview", exact: true });
    if (await preview.count()) await preview.click();
    await page.waitForSelector(".falling-note-viewport", { timeout: 15000 });
    await sleep(1200);
  },
  async review(page, base) {
    await openMode(page, base, "review");
    await page
      .locator("input[type=file][accept='.osu']")
      .first()
      .setInputFiles(join(fixtures, "corpus", "groove", "chart.osu"));
    await page.waitForSelector(".review-preview", { timeout: 15000 });
    await sleep(1200);
  },
  async compare(page, base) {
    await page.goto(
      `${base}/compare?manifest=${encodeURIComponent(join(fixtures, "comparison.json"))}`,
    );
    await page.getByRole("button", { name: /Open comparison/ }).click();
    await page.waitForSelector(".compare-stage", { timeout: 15000 });
    await sleep(1500);
  },
};

async function modeShots(base) {
  for (const [name, open] of Object.entries(modes)) {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ]) {
      const { context, page, errors } = await newPage(width, height);
      try {
        if (width === 1440 && name !== "inspect") {
          // The page before a workspace is open.
          await page.goto(name === "compare" ? `${base}/compare` : `${base}/`);
          if (name === "review") await openMode(page, base, "review");
          await sleep(500);
          await shot(page, `${name}-setup-${width}`);
        }
        await open(page, base);
        await shot(page, `${name}-${width}`);
        if (name === "review" && width === 1440) {
          await check("review: a disabled Save looks disabled; the status line has a title", () =>
            page.evaluate(() => {
              const save = [...document.querySelectorAll("button")].find(
                (button) => button.textContent.trim() === "Save section judgments",
              );
              const probe = document.createElement("div");
              probe.style.background = "var(--signal-fill)";
              document.body.append(probe);
              const fill = getComputedStyle(probe).backgroundColor;
              probe.remove();
              const status = document.querySelector(".review-status");
              const background = save ? getComputedStyle(save).backgroundColor : null;
              return {
                ok:
                  Boolean(save?.disabled) &&
                  background !== fill &&
                  Boolean(status?.title) &&
                  status.title === status.textContent.trim(),
                disabled: save?.disabled,
                background,
                fill,
                title: status?.title,
              };
            }),
          );
        }
        if (width === 1440) {
          const hide = page.getByRole("button", { name: /^Hide / });
          if (await hide.count()) {
            await check(`${name}: hiding a side pane widens the main view`, async () => {
              const before = (await page.locator(".frame-main").boundingBox()).width;
              await hide.first().click();
              await sleep(250);
              const after = (await page.locator(".frame-main").boundingBox()).width;
              await shot(page, `${name}-${width}-pane-hidden`);
              await page
                .getByRole("button", { name: /^Show / })
                .first()
                .click();
              await sleep(250);
              return { ok: after > before + 150, before, after };
            });
          }
          const splitters = page.locator('[role="separator"]');
          const found = await splitters.count();
          if (found) {
            await check(`${name}: a pane boundary resizes from the keyboard`, async () => {
              const splitter = splitters.first();
              await splitter.focus();
              const start = Number(await splitter.getAttribute("aria-valuenow"));
              await page.keyboard.press("ArrowRight");
              const after = Number(await splitter.getAttribute("aria-valuenow"));
              await page.keyboard.press("ArrowLeft");
              return { ok: after !== start, start, after, splitters: found };
            });
          }
        }
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        );
        record(`${name} at ${width}: no horizontal page scroll`, overflow <= 0, { overflow });
        results.errors[`${name}-${width}`] = errors;
      } catch (error) {
        await shot(page, `${name}-${width}-failed`).catch(() => {});
        record(`${name} at ${width} opens`, false, { error: String(error).slice(0, 400), errors });
      } finally {
        await context.close();
      }
    }
  }
}

try {
  if (only.has("timing")) await timingShots();
  if (only.has("checks")) await timingChecks();
  if (only.has("fixes")) await timingFixChecks();
  if (only.has("modes") && values.dev) await modeShots(values.dev.replace(/\/$/, ""));
} finally {
  await browser.close();
  writeFileSync(join(out, "results.json"), `${JSON.stringify(results, null, 1)}\n`);
  const failed = results.checks.filter((entry) => !entry.ok).length;
  console.log(`${results.checks.length - failed} passed, ${failed} failed; ${out}`);
}
