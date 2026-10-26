/**
 * Statistics from run.mjs output: every lab.json and <label>.json in a results directory.
 *
 *   node analyze.mjs DIR [--json SUMMARY.json]     a Markdown summary on stdout
 *
 * The reference for "what is heard when" is the page's own output clock: a robust straight line
 * through every distinct getOutputTimestamp() pair of a run, plus the music source's scheduled
 * start (from the start() calls). The drawn playhead is read in device pixels (canvas fillRect,
 * element transform, or screencast pixels) and mapped to source time through the proposal bars of
 * the base canvas (one every 250 ms of source), so the page's state is never read.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { OutputClock } from "../../src/timing/clock.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { json: { type: "string" } },
});
const dir = positionals[0];
if (!dir) {
  process.stderr.write("Usage: analyze.mjs DIR [--json SUMMARY.json]\n");
  process.exit(1);
}

// --- Statistics ---------------------------------------------------------------------------------

const sorted = (values) => values.filter(Number.isFinite).sort((a, b) => a - b);
function quantile(values, p) {
  const s = sorted(values);
  if (!s.length) return null;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const mean = (values) => {
  const s = values.filter(Number.isFinite);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
};
function sd(values) {
  const s = values.filter(Number.isFinite);
  const m = mean(s);
  return s.length > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / (s.length - 1)) : null;
}
const round = (value, digits = 3) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(digits));
function spread(values, digits = 3) {
  const s = values.filter(Number.isFinite);
  if (!s.length) return { n: 0 };
  const abs = s.map(Math.abs);
  return {
    n: s.length,
    mean: round(mean(s), digits),
    sd: round(sd(s), digits),
    p50: round(quantile(s, 0.5), digits),
    p95: round(quantile(s, 0.95), digits),
    max: round(Math.max(...s), digits),
    min: round(Math.min(...s), digits),
    p95abs: round(quantile(abs, 0.95), digits),
    maxabs: round(Math.max(...abs), digits),
  };
}
function median(values) {
  return quantile(values, 0.5);
}

/**
 * The error as seen over time: between two presented frames the picture holds while the audio
 * moves on, so the error falls by the gap (ms of source at rate 1). `rows` are presented frames
 * in order, `{ t, error }` in ms; each gap is sampled every 0.5 ms. Returns the spread of
 * |error − median| over time, and the longest gap between frames.
 */
function heldError(rows, rate = 1) {
  const samples = [];
  let longestGap = 0;
  for (let i = 0; i + 1 < rows.length; i++) {
    const gap = rows[i + 1].t - rows[i].t;
    longestGap = Math.max(longestGap, gap);
    for (let at = 0; at < gap; at += 0.5) samples.push(rows[i].error - at * rate);
  }
  const m = median(samples);
  const deviation = samples.map((value) => Math.abs(value - m));
  return {
    medianMs: round(m),
    p95Ms: round(quantile(deviation, 0.95)),
    maxMs: round(deviation.length ? Math.max(...deviation) : null),
    over8Ms: round(deviation.filter((d) => d > 8).length / Math.max(1, deviation.length), 3),
    longestGapMs: round(longestGap),
  };
}

/** Page time of the first Escape (the stop), or Infinity. */
function stopTime(run) {
  return (run.keys ?? []).find((k) => k.key === "Escape")?.timeStamp ?? Number.POSITIVE_INFINITY;
}

/** Least squares y = a + b x. */
function lineFit(xs, ys) {
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/** Robust line through points (x, y), rejecting residuals beyond 3 · 1.4826 · MAD twice. */
function robustFit(xs, ys) {
  let keep = xs.map((_, i) => i);
  let fit = lineFit(xs, ys);
  for (let pass = 0; pass < 3; pass++) {
    const residuals = keep.map((i) => ys[i] - fit.a - fit.b * xs[i]);
    const centre = median(residuals);
    const mad = median(residuals.map((r) => Math.abs(r - centre)));
    const bound = Math.max(1e-6, 3 * 1.4826 * mad);
    const next = xs
      .map((_, i) => i)
      .filter((i) => Math.abs(ys[i] - fit.a - fit.b * xs[i]) <= bound);
    if (next.length < 8) break;
    keep = next;
    fit = lineFit(
      keep.map((i) => xs[i]),
      keep.map((i) => ys[i]),
    );
  }
  const residuals = xs.map((x, i) => ys[i] - fit.a - fit.b * x);
  return { ...fit, residuals, kept: keep.length };
}

// --- Clock reference ----------------------------------------------------------------------------

/** Distinct (performanceTime, contextTime) pairs of a run's stamps, in order. */
function distinctStamps(stamps) {
  const out = [];
  let last = 0;
  for (const [, contextTime, performanceTime] of stamps ?? []) {
    if (!(contextTime > 0 && performanceTime > 0) || contextTime === last) continue;
    last = contextTime;
    out.push({ perfMs: performanceTime, ctxS: contextTime });
  }
  return out;
}

/**
 * The run's output clock as a robust line: offset (context ms − page ms) against page time.
 * Returns ctxAt(perfMs) and perfAt(ctxS), and the stamps' residuals.
 */
function clockReference(stamps) {
  const points = distinctStamps(stamps);
  if (points.length < 8) return null;
  const x0 = points[0].perfMs;
  const fit = robustFit(
    points.map((p) => p.perfMs - x0),
    points.map((p) => p.ctxS * 1000 - p.perfMs),
  );
  const ratio = 1 + fit.b;
  return {
    ctxAt: (perfMs) => (perfMs + fit.a + fit.b * (perfMs - x0)) / 1000,
    perfAt: (ctxS) => (ctxS * 1000 - fit.a + fit.b * x0) / ratio,
    ratio,
    residualsMs: fit.residuals,
    points,
  };
}

/** The music start (the long buffer) closest before `at`, as an anchor in source ms. */
function musicStarts(starts) {
  return (starts ?? [])
    .filter((s) => s.length > 20_000)
    .map((s) => ({
      at: s.at,
      ctxNow: s.ctxNow,
      whenS: s.when,
      offsetMs: s.offset * 1000,
      rate: s.rate,
      loop: s.loop,
    }));
}

/** Source ms heard at page time t for a non-looping start; the start position before it. */
function heardAt(clock, start, t) {
  const ctx = clock.ctxAt(t);
  return start.offsetMs + Math.max(0, ctx - start.whenS) * 1000 * start.rate;
}

// --- Device x to source time --------------------------------------------------------------------

/**
 * Per base-canvas draw: device px per ms and the device x of some multiple of 250 ms, from the
 * proposal bars (each drawn at floor(x), so its centre is within half a pixel).
 */
function barMappings(baseDraws) {
  const out = [];
  for (const draw of baseDraws ?? []) {
    const bars = [...(draw.bars ?? [])].sort((a, b) => a - b);
    if (bars.length < 2) continue;
    const gaps = bars.slice(1).map((x, i) => x - bars[i]);
    const pxPer250 = median(gaps);
    if (!(pxPer250 > 0)) continue;
    // Each bar's x minus its index times the spacing: their mean is the first bar's x.
    const first = mean(bars.map((x) => x - Math.round((x - bars[0]) / pxPer250) * pxPer250));
    out.push({ frame: draw.frame, pxPerMs: pxPer250 / 250, firstX: first });
  }
  return out;
}

/**
 * Source time of device x under a mapping, choosing the multiple of 250 ms for the first bar that
 * puts the result nearest `nearMs` (the audio clock's time, within ±125 ms by construction).
 */
function sourceOf(mapping, x, nearMs) {
  const offsetMs = (x - mapping.firstX) / mapping.pxPerMs;
  const k = Math.round((nearMs - offsetMs) / 250);
  return k * 250 + offsetMs;
}

// --- Lab ------------------------------------------------------------------------------------------

function labSummary(lab) {
  const out = { browser: lab.browser, userAgent: lab.userAgent, machine: lab.machine };
  const offline = lab.experiments?.offline;
  out.offline = Array.isArray(offline)
    ? offline.map((r) => ({
        rate: r.rate,
        name: r.name,
        firstNonZero: r.firstNonZero,
        ...(r.exact && {
          exactMismatches: r.exact.mismatches,
          exactMaxAbs: r.exact.maxAbs,
          frames: r.exact.frames,
        }),
        ...(r.exactRounded && {
          roundedMismatches: r.exactRounded.mismatches,
          interpolatedMismatches: r.interpolated.mismatches,
          interpolatedMaxAbs: r.interpolated.maxAbs,
        }),
        ...(r.linear && { linearMaxAbs: r.linear.maxAbs }),
        ...(r.onsetErrorSamples !== undefined && {
          onsetErrorSamples: round(r.onsetErrorSamples, 3),
        }),
        ...(r.passes && { passes: round(r.passes, 1) }),
      }))
    : offline;
  const options = lab.experiments?.contextOptions;
  out.contextOptions = Array.isArray(options)
    ? options.map((o) => {
        const points = distinctStamps(o.stamps);
        const cadence = points.slice(1).map((p, i) => (p.ctxS - points[i].ctxS) * 1000);
        const reference = clockReference(o.stamps);
        // Online comparison at each stamp arrival + 5 ms: the newest stamp alone vs the model.
        const clock = new OutputClock();
        const latestErr = [];
        const modelErr = [];
        for (const p of points) {
          clock.observe({ contextTime: p.ctxS, performanceTime: p.perfMs });
          const t = p.perfMs + 5;
          const truth = reference?.ctxAt(t);
          const line = clock.line();
          if (truth === undefined || !line) continue;
          latestErr.push((p.ctxS + (t - p.perfMs) / 1000 - truth) * 1000);
          modelErr.push((line.ctxS + ((t - line.perfMs) * line.ratio) / 1000 - truth) * 1000);
        }
        return {
          latencyHint: o.latencyHint,
          baseLatencyMs: round(o.baseLatency * 1000),
          outputLatencyMs: round(o.outputLatency * 1000),
          resumeRunningMs: spread(o.resumeRunningMs ?? []),
          stampCadenceMs: spread(cadence),
          stampResidualMs: reference ? spread(reference.residualsMs) : null,
          ratioPpm: reference ? round((reference.ratio - 1) * 1e6, 1) : null,
          latestStampErrorMs: spread(latestErr.slice(10)),
          clockModelErrorMs: spread(modelErr.slice(10)),
        };
      })
    : options;
  const display = lab.experiments?.display;
  out.display = Array.isArray(display) ? display.map(displaySummary) : display;
  return out;
}

/** Presented positions against x(t) = speed · (t − t0 − D), with D fitted. */
function displaySummary(run) {
  const intervals = run.frames.slice(1).map((f, i) => f.ts - run.frames[i].ts);
  const typical = median(intervals);
  const presented = run.presented.filter((p) => p.x !== null && p.swapMs !== null);
  const scale = presented[0] ? presented[0].imageWidth / 1470 : 2;
  // Within the run, once the line has started: from 50 ms after t0 to 250 ms before the end.
  const moving = presented
    .map((p) => ({ swapMs: p.swapMs, xCss: p.x / scale }))
    .filter((p) => p.swapMs > run.t0 + 50 && p.swapMs < run.t0 + 2350);
  const delays = moving.map((p) => p.swapMs - run.t0 - p.xCss / run.speedPxPerMs);
  const D = median(delays);
  let stale = 0;
  for (let i = 1; i < moving.length; i++) {
    const modelMoved = (moving[i].swapMs - moving[i - 1].swapMs) * run.speedPxPerMs;
    if (modelMoved > 4 && Math.abs(moving[i].xCss - moving[i - 1].xCss) < 0.1) stale++;
  }
  return {
    variant: run.variant,
    load: run.load,
    desynchronized: run.attributes?.desynchronized ?? null,
    rafIntervalMs: spread(intervals),
    longFrames: intervals.filter((i) => i > 1.5 * typical).length,
    callbackDelayMs: spread(run.frames.map((f) => f.start - f.ts)),
    presentedFrames: moving.length,
    swapDelayMs: round(D),
    presentedErrorMs: spread(delays.map((d) => d - D)),
    staleFrames: stale,
    held: heldError(
      moving.map((p) => ({ t: p.swapMs, error: p.xCss / run.speedPxPerMs - (p.swapMs - run.t0) })),
    ),
  };
}

// --- App ------------------------------------------------------------------------------------------

function framesSummary(frames) {
  const intervals = frames.slice(1).map((f, i) => f.ts - frames[i].ts);
  const typical = median(intervals);
  return {
    frames: frames.length,
    rafIntervalMs: spread(intervals),
    longFrames: intervals.filter((i) => i > 1.5 * typical).length,
    callbackMs: spread(frames.map((f) => f.cbMs)),
    callbackDelayMs: spread(frames.map((f) => f.start - f.ts)),
    mainThreadPerFrameMs: spread(frames.filter((f) => f.after).map((f) => f.after - f.start)),
  };
}

function steadySummary(run) {
  const trace = run.trace ?? {};
  const gcMs = (trace.gc ?? []).reduce((a, g) => a + g.dur, 0);
  return {
    ...framesSummary(run.frames ?? []),
    baseDraws: {
      count: (run.baseDraws ?? []).length,
      ms: spread((run.baseDraws ?? []).map((d) => d.end - d.start)),
    },
    loafs: run.loafs ? run.loafs.length : null,
    loafMs: run.loafs ? spread(run.loafs.map((l) => l.duration)) : null,
    gc: {
      count: (trace.gc ?? []).length,
      totalMs: round(gcMs),
      maxMs: round(Math.max(0, ...(trace.gc ?? []).map((g) => g.dur))),
    },
    mainThreadBusy: trace.mainThread
      ? round(trace.mainThread.taskMs / trace.mainThread.spanMs, 4)
      : null,
    frameStates: trace.frameStates ?? null,
    animations: trace.animations ?? null,
    contexts: run.contexts,
    traceError: trace.error ?? null,
  };
}

/**
 * Per frame: the drawn playhead's source time against the audio clock at the frame time.
 * A sample's `frame` is the instrument's count of the page's own animation frames, so it names
 * the last page frame (and base draw) before the sample. Samples in the display frame right
 * before a base draw, or in the draw's frame ahead of the page's callback, are skipped (a view
 * jump may move the element before the bars). That frame is found by time stamp: a build with no
 * frame loop runs a page frame only to draw, so the count stands still between draws.
 */
function positionsSummary(run) {
  const clock = clockReference(run.stamps);
  const start = musicStarts(run.starts)[0];
  const mappings = barMappings(run.baseDraws);
  if (!clock || !start || !mappings.length) return { error: "missing clock, start or bars" };
  const drawFrames = new Set(mappings.map((m) => m.frame));
  const frameTs = new Map((run.frames ?? []).map((f) => [f.frame, f.ts]));
  // One display frame: the page's frame interval, or 60 Hz when it runs frames only to draw.
  const frameMs = Math.min(
    median((run.frames ?? []).slice(1).map((f, i) => f.ts - run.frames[i].ts)) ?? Infinity,
    1000 / 60,
  );
  const beforeDraw = (p) => {
    if (!drawFrames.has(p.frame + 1)) return false;
    const drawTs = frameTs.get(p.frame + 1);
    return drawTs === undefined || drawTs - p.ts <= 1.5 * frameMs;
  };
  const stopAt = stopTime(run);
  const rows = [];
  for (const p of run.playhead ?? []) {
    if (beforeDraw(p) || p.ts >= stopAt) continue;
    const mapping = mappings.filter((m) => m.frame <= p.frame).at(-1);
    if (!mapping) continue;
    const audioMs = heardAt(clock, start, p.ts);
    if (audioMs <= start.offsetMs + 1) continue;
    rows.push({ ts: p.ts, shownMs: sourceOf(mapping, p.x, audioMs), audioMs });
  }
  // One sample per display frame (the canvas may draw the playhead twice in a frame).
  const byFrame = [...new Map(rows.map((r) => [r.ts, r])).values()];
  const fit = lineFit(
    byFrame.map((r) => r.ts),
    byFrame.map((r) => r.shownMs),
  );
  return {
    frames: byFrame.length,
    mappings: mappings.length,
    msPerDevicePx: round(1 / median(mappings.map((m) => m.pxPerMs)), 4),
    shownMinusAudioMs: spread(byFrame.map((r) => r.shownMs - r.audioMs)),
    straightLineResidualMs: spread(byFrame.map((r) => r.shownMs - fit.a - fit.b * r.ts)),
    slope: round(fit.b, 6),
  };
}

function tapsSummary(run) {
  const clock = clockReference(run.stamps);
  const start = musicStarts(run.starts)[0];
  const keys = (run.keys ?? []).filter((k) => k.key === "b" && !k.repeat);
  const marks = (run.savedMarks ?? [])
    .filter((m) => m.method === "key-playing")
    .map((m) => m.time_ms);
  marks.sort((a, b) => a - b);
  if (!clock || !start)
    return { error: "missing clock or start", keys: keys.length, marks: marks.length };
  const errors = keys.map((k, i) => (marks[i] ?? Number.NaN) - heardAt(clock, start, k.timeStamp));
  const handlerDelay = keys.map((k) => k.at - k.timeStamp);
  // Key to the base draw that first shows one more mark line.
  const draws = run.baseDraws ?? [];
  const visible = [];
  let marksShown = draws.length ? Math.min(...draws.map((d) => d.marks)) : 0;
  for (const k of keys) {
    const draw = draws.find((d) => d.start >= k.at && d.marks > marksShown);
    if (!draw) continue;
    visible.push(draw.end - k.timeStamp);
    marksShown = draw.marks;
  }
  return {
    keys: keys.length,
    marks: marks.length,
    markMinusHeardMs: spread(errors),
    markMinusHeardJankMs: spread(errors.filter((_, i) => i % 2)),
    handlerDelayMs: spread(handlerDelay),
    keyToMarkDrawnMs: spread(visible),
  };
}

function clicksSummary(run) {
  const start = musicStarts(run.starts)[0];
  if (!start) return { error: "missing start" };
  const clicks = (run.starts ?? []).filter((s) => s.length > 0 && s.length < 2000);
  const lastCtx = Math.max(...(run.stamps ?? []).map((s) => s[3] ?? 0));
  const expected = (run.beatsMs ?? [])
    .filter((ms) => ms >= start.offsetMs)
    .map((ms) => start.whenS + (ms - start.offsetMs) / start.rate / 1000)
    .filter((ctx) => ctx < lastCtx - 0.05);
  let onTime = 0;
  let late = 0;
  let missing = 0;
  const errors = [];
  const leads = [];
  for (const ctx of expected) {
    const match = clicks.filter((c) => Math.abs(c.when - ctx) < 1e-4 && c.length);
    const last = match.at(-1);
    if (!last) {
      missing++;
      continue;
    }
    errors.push((last.when - ctx) * 1e6);
    leads.push((last.when - last.ctxNow) * 1000);
    // A start under one render quantum ahead of the context's current time may already be late.
    if (last.when - last.ctxNow < 128 / 48_000) late++;
    else onTime++;
  }
  return {
    expected: expected.length,
    onTime,
    late,
    missing,
    scheduled: clicks.length,
    clickTimeErrorUs: spread(errors),
    scheduledAheadMs: spread(leads),
  };
}

function startSummary(run) {
  const clock = clockReference(run.stamps);
  const starts = musicStarts(run.starts);
  const keys = (run.keys ?? []).filter((k) => k.key === " " && !k.repeat);
  const rows = [];
  for (const k of keys) {
    const s = starts.find((s) => s.at >= k.at);
    if (!s) continue;
    rows.push({
      handler: s.at - k.timeStamp,
      lead: (s.whenS - s.ctxNow) * 1000,
      heard: clock ? clock.perfAt(s.whenS) - k.timeStamp : null,
    });
  }
  return {
    starts: rows.length,
    keyToStartCallMs: spread(rows.map((r) => r.handler)),
    scheduledLeadMs: spread(rows.map((r) => r.lead)),
    keyToFirstSampleHeardMs: spread(rows.map((r) => r.heard)),
    outputLatencyMs: run.contexts?.at(-1)?.outputLatency * 1000,
    baseLatencyMs: run.contexts?.at(-1)?.baseLatency * 1000,
  };
}

function presentedSummary(part) {
  const clock = clockReference(part.stamps);
  const start = musicStarts(part.starts)[0];
  const mappings = barMappings(part.baseDraws);
  if (!clock || !start || !mappings.length) return { error: "missing clock, start or bars" };
  const mapping = mappings.at(-1);
  const dpr = part.dpr ?? 2;
  const stopAt = stopTime(part);
  const rows = [];
  for (const p of part.presented ?? []) {
    if (p.x === null || p.swapMs === null || p.swapMs >= stopAt) continue;
    const scale = p.imageWidth / 1470;
    const deviceX = (p.x / scale - part.stage.x) * dpr;
    const audioMs = heardAt(clock, start, p.swapMs);
    if (audioMs <= start.offsetMs + 20) continue;
    rows.push({
      swapMs: p.swapMs,
      error: sourceOf(mapping, deviceX, audioMs) - audioMs,
      x: deviceX,
    });
  }
  const errors = rows.map((r) => r.error);
  const m = median(errors);
  let stale = 0;
  for (let i = 1; i < rows.length; i++)
    if (rows[i].swapMs - rows[i - 1].swapMs > 8 && Math.abs(rows[i].x - rows[i - 1].x) < 0.2)
      stale++;
  return {
    presentedFrames: rows.length,
    msPerDevicePx: round(1 / mapping.pxPerMs, 4),
    shownMinusHeardAtSwapMs: spread(errors),
    deviationFromMedianMs: spread(errors.map((e) => e - m)),
    staleFrames: stale,
    held: heldError(rows.map((r) => ({ t: r.swapMs, error: r.error }))),
  };
}

function appSummary(result) {
  const s = result.scenarios ?? {};
  const guard = (fn, value) => {
    if (!value) return null;
    if (value.error) return { error: value.error };
    try {
      return fn(value);
    } catch (error) {
      return { analysisError: String(error?.stack ?? error) };
    }
  };
  return {
    label: result.label,
    browser: result.browser,
    machine: result.machine,
    smoke: s.smoke?.checks?.map((c) => ({ name: c.name, ok: c.ok })) ?? s.smoke,
    steady: guard(steadySummary, s.steady),
    positions: guard(positionsSummary, s.positions),
    taps: guard(tapsSummary, s.taps),
    clicks: guard(clicksSummary, s.clicks),
    start: guard(startSummary, s.start),
    presented: s.presented && {
      none: guard(presentedSummary, s.presented.none),
      burst: guard(presentedSummary, s.presented.burst),
      error: s.presented.error,
    },
  };
}

// --- Report ---------------------------------------------------------------------------------------

const files = readdirSync(dir).filter(
  (name) => name.endsWith(".json") && !["summary.json", "environment.json"].includes(name),
);
const summary = { dir, apps: [], labs: [] };
for (const name of files.sort()) {
  const result = JSON.parse(readFileSync(join(dir, name), "utf8"));
  if (result.mode === "lab" && result.owner) summary.owner = labSummary(result);
  else if (result.mode === "lab") summary.labs.push({ label: name, ...labSummary(result) });
  else if (result.mode === "app") summary.apps.push(appSummary(result));
}
try {
  summary.environment = JSON.parse(readFileSync(join(dir, "environment.json"), "utf8"));
} catch {}
if (values.json) writeFileSync(values.json, `${JSON.stringify(summary, null, 1)}\n`);

const fmt = (s, key = "p50") => (s && s[key] !== undefined && s[key] !== null ? s[key] : "–");
const lines = [`# Timing engine latency: ${dir}`, ""];
if (summary.environment)
  lines.push("```json", JSON.stringify(summary.environment, null, 1), "```", "");
if (summary.apps.length) {
  const header = ["metric", ...summary.apps.map((a) => a.label)];
  const row = (name, pick) => [
    name,
    ...summary.apps.map((a) => {
      try {
        const value = pick(a);
        return value === undefined || value === null
          ? "–"
          : typeof value === "object"
            ? JSON.stringify(value)
            : value;
      } catch {
        return "–";
      }
    }),
  ];
  const rows = [
    row("smoke failures", (a) =>
      Array.isArray(a.smoke)
        ? a.smoke
            .filter((c) => !c.ok)
            .map((c) => c.name)
            .join("; ") || "none"
        : "error",
    ),
    row(
      "steady: rAF interval p50/p95/max ms",
      (a) =>
        `${fmt(a.steady.rafIntervalMs)}/${fmt(a.steady.rafIntervalMs, "p95")}/${fmt(a.steady.rafIntervalMs, "max")}`,
    ),
    row("steady: animation frames recorded", (a) => a.steady.frames),
    row("steady: long frames (>1.5× median)", (a) => a.steady.longFrames),
    row(
      "steady: rAF callbacks per frame p50/p95/max ms",
      (a) =>
        `${fmt(a.steady.callbackMs)}/${fmt(a.steady.callbackMs, "p95")}/${fmt(a.steady.callbackMs, "max")}`,
    ),
    row(
      "steady: main thread per frame p50/p95/max ms",
      (a) =>
        `${fmt(a.steady.mainThreadPerFrameMs)}/${fmt(a.steady.mainThreadPerFrameMs, "p95")}/${fmt(a.steady.mainThreadPerFrameMs, "max")}`,
    ),
    row("steady: main thread busy fraction", (a) => a.steady.mainThreadBusy),
    row(
      "steady: GC count / total ms / max ms",
      (a) => `${a.steady.gc.count}/${a.steady.gc.totalMs}/${a.steady.gc.maxMs}`,
    ),
    row(
      "steady: base draws / p50 / max ms",
      (a) =>
        `${a.steady.baseDraws.count}/${fmt(a.steady.baseDraws.ms)}/${fmt(a.steady.baseDraws.ms, "max")}`,
    ),
    row("steady: frame states", (a) => a.steady.frameStates),
    row("steady: animations", (a) => a.steady.animations),
    row(
      "positions: shown − heard mean/sd ms",
      (a) =>
        `${fmt(a.positions.shownMinusAudioMs, "mean")}/${fmt(a.positions.shownMinusAudioMs, "sd")}`,
    ),
    row(
      "positions: straight-line residual sd/p95abs/maxabs ms",
      (a) =>
        `${fmt(a.positions.straightLineResidualMs, "sd")}/${fmt(a.positions.straightLineResidualMs, "p95abs")}/${fmt(a.positions.straightLineResidualMs, "maxabs")}`,
    ),
    row(
      "taps: mark − heard mean/sd/maxabs ms",
      (a) =>
        `${fmt(a.taps.markMinusHeardMs, "mean")}/${fmt(a.taps.markMinusHeardMs, "sd")}/${fmt(a.taps.markMinusHeardMs, "maxabs")}`,
    ),
    row(
      "taps: key → mark drawn p50/max ms",
      (a) => `${fmt(a.taps.keyToMarkDrawnMs)}/${fmt(a.taps.keyToMarkDrawnMs, "max")}`,
    ),
    row(
      "clicks: expected / on time / late / missing",
      (a) => `${a.clicks.expected}/${a.clicks.onTime}/${a.clicks.late}/${a.clicks.missing}`,
    ),
    row("clicks: time error max abs µs", (a) => fmt(a.clicks.clickTimeErrorUs, "maxabs")),
    row("start: key → start() p50 ms", (a) => fmt(a.start.keyToStartCallMs)),
    row(
      "start: key → first sample heard p50/max ms",
      (a) =>
        `${fmt(a.start.keyToFirstSampleHeardMs)}/${fmt(a.start.keyToFirstSampleHeardMs, "max")}`,
    ),
    row(
      "presented (no load): shown − heard at swap median, deviation sd/maxabs ms",
      (a) =>
        `${fmt(a.presented.none.shownMinusHeardAtSwapMs)}, ${fmt(a.presented.none.deviationFromMedianMs, "sd")}/${fmt(a.presented.none.deviationFromMedianMs, "maxabs")}`,
    ),
    row(
      "presented (no load): frames / stale",
      (a) => `${a.presented.none.presentedFrames}/${a.presented.none.staleFrames}`,
    ),
    row(
      "presented (no load): held error p95/max ms, longest gap ms",
      (a) =>
        `${a.presented.none.held.p95Ms}/${a.presented.none.held.maxMs}, ${a.presented.none.held.longestGapMs}`,
    ),
    row(
      "presented (80 ms stalls): median, deviation sd/maxabs ms",
      (a) =>
        `${fmt(a.presented.burst.shownMinusHeardAtSwapMs)}, ${fmt(a.presented.burst.deviationFromMedianMs, "sd")}/${fmt(a.presented.burst.deviationFromMedianMs, "maxabs")}`,
    ),
    row(
      "presented (80 ms stalls): frames / stale",
      (a) => `${a.presented.burst.presentedFrames}/${a.presented.burst.staleFrames}`,
    ),
    row(
      "presented (80 ms stalls): held error p95/max ms, longest gap ms",
      (a) =>
        `${a.presented.burst.held.p95Ms}/${a.presented.burst.held.maxMs}, ${a.presented.burst.held.longestGapMs}`,
    ),
  ];
  lines.push(`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`);
  for (const r of rows) lines.push(`| ${r.join(" | ")} |`);
  lines.push("");
}
for (const lab of summary.labs) {
  lines.push(
    `## Lab (${lab.label})`,
    "",
    "Offline exactness:",
    "",
    "```json",
    JSON.stringify(lab.offline, null, 1),
    "```",
    "",
  );
  lines.push(
    "AudioContext options:",
    "",
    "```json",
    JSON.stringify(lab.contextOptions, null, 1),
    "```",
    "",
  );
  if (Array.isArray(lab.display)) {
    lines.push(
      "| variant | load | desync | rAF p95 ms | long frames | callback delay p50/p95 ms | presented | swap delay ms | presented error sd/p95abs/maxabs ms | held error p95/max ms | longest gap ms |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const d of lab.display)
      lines.push(
        `| ${d.variant} | ${d.load} | ${d.desynchronized} | ${fmt(d.rafIntervalMs, "p95")} | ${d.longFrames} | ${fmt(d.callbackDelayMs)}/${fmt(d.callbackDelayMs, "p95")} | ${d.presentedFrames} | ${d.swapDelayMs} | ${fmt(d.presentedErrorMs, "sd")}/${fmt(d.presentedErrorMs, "p95abs")}/${fmt(d.presentedErrorMs, "maxabs")} | ${d.held.p95Ms}/${d.held.maxMs} | ${d.held.longestGapMs} |`,
      );
  } else lines.push("Display:", "```json", JSON.stringify(lab.display), "```");
}
if (summary.owner)
  lines.push(
    "",
    "## Owner's output clock (owner-stamps.js)",
    "",
    `User agent: ${summary.owner.userAgent}`,
    "",
    "```json",
    JSON.stringify(summary.owner.contextOptions, null, 1),
    "```",
  );
process.stdout.write(`${lines.join("\n")}\n`);
