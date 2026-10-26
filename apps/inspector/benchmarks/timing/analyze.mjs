/**
 * Statistics from run.mjs output.
 *
 *   node analyze.mjs RAW.json [--json SUMMARY.json]       one block per scenario run
 *   node analyze.mjs A.json B.json ...                     key metrics side by side (medians)
 *
 * The reference for "what is heard when" is the browser's own output clock: a robust straight-line
 * fit of every getOutputTimestamp() sample of the run (context time against performance time),
 * plus the music source's scheduled start. The fit stands in for the true clock: stamp errors are
 * its residuals. The drawn playhead is read in device pixels and mapped to source time through
 * the proposal bars drawn on the base canvas (one every 250 ms), so the page's state is never
 * read. Click timing is measured in the captured output against the pulses in the music itself.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { clickOffsetSamples, recordings } from "./session.mjs";

const quantile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = p * (sorted.length - 1);
  const low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
};
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const sd = (values) => {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
};
const round = (value, digits = 3) =>
  value === null || value === undefined || Number.isNaN(value) ? null : Number(value.toFixed(digits));
function spread(values, digits = 3) {
  return {
    n: values.length,
    mean: round(mean(values), digits),
    sd: round(sd(values), digits),
    p50: round(quantile(values, 0.5), digits),
    p90: round(quantile(values, 0.9), digits),
    p99: round(quantile(values, 0.99), digits),
    max: round(values.length ? Math.max(...values) : null, digits),
  };
}

/**
 * Robust straight-line fit of the output clock: offset o = contextTime·1000 − performanceTime (ms)
 * against performance time, over unique stamps after the first 250 ms. Residuals are the stamps'
 * own errors against that line.
 */
export function fitClock(stamps) {
  const unique = [];
  let last = -1;
  for (const [, contextTime, performanceTime] of stamps)
    if (contextTime > 0 && performanceTime > 0 && performanceTime !== last) {
      unique.push([performanceTime, contextTime * 1000 - performanceTime]);
      last = performanceTime;
    }
  if (unique.length < 10) return null;
  const settled = unique.filter(([t]) => t > unique[0][0] + 250);
  const line = (points) => {
    const mt = mean(points.map(([t]) => t));
    const mo = mean(points.map(([, o]) => o));
    let sxy = 0;
    let sxx = 0;
    for (const [t, o] of points) {
      sxy += (t - mt) * (o - mo);
      sxx += (t - mt) ** 2;
    }
    const b = sxx ? sxy / sxx : 0;
    return { a: mo - b * mt, b };
  };
  const median = quantile(
    settled.map(([, o]) => o),
    0.5,
  );
  let fit = line(settled.filter(([, o]) => Math.abs(o - median) < 1.5));
  const residuals = () => settled.map(([t, o]) => o - (fit.a + fit.b * t));
  const mad = quantile(
    residuals().map(Math.abs),
    0.5,
  );
  const limit = Math.max(0.3, 3 * mad);
  fit = line(settled.filter(([t, o]) => Math.abs(o - (fit.a + fit.b * t)) < limit));
  const r = residuals();
  const abs = r.map(Math.abs);
  return {
    a: fit.a,
    b: fit.b,
    /** Context time (s) being output at performance time `t` (ms). */
    ctxAt: (t) => (t + fit.a + fit.b * t) / 1000,
    /** Performance time (ms) at which context time `ctxS` is output. */
    perfAt: (ctxS) => (ctxS * 1000 - fit.a) / (1 + fit.b),
    summary: {
      stamps: settled.length,
      updateIntervalMs: round(quantile(settled.slice(1).map(([t], i) => t - settled[i][0]), 0.5)),
      driftPpm: round(fit.b * 1e6, 1),
      residualSdMs: round(sd(r)),
      residualP99Ms: round(quantile(abs, 0.99)),
      residualMaxMs: round(Math.max(...abs)),
      over1ms: abs.filter((value) => value > 1).length,
      over02ms: abs.filter((value) => value > 0.2).length,
    },
  };
}

/** Music starts (the long buffers) with the sample Chromium starts from: the offset, rounded. */
function musicStarts(run, sampleRate) {
  return run.starts
    .filter((start) => start.length > 100_000)
    .map((start) => ({
      ...start,
      sampleRate,
      startIndex: Math.round(start.offset * sampleRate),
      startSourceMs: (Math.round(start.offset * sampleRate) * 1000) / sampleRate,
    }));
}

/** Source ms heard at performance time `t` for a non-looping start, or null before it. */
function idealAt(clock, start, t) {
  const ctx = clock.ctxAt(t);
  if (ctx < start.when) return null;
  return start.startSourceMs + (ctx - start.when) * 1000 * start.rate;
}

/** Per frame: the drawn playhead's source time, from the proposal bars of the current view. */
function drawnPlayhead(run, clock, start) {
  const drawsByFrame = new Map();
  for (const draw of run.playhead) if (draw.overlay !== false) drawsByFrame.set(draw.frame, draw);
  const barsByFrame = new Map();
  for (const bar of run.bars) {
    if (!barsByFrame.has(bar.frame)) barsByFrame.set(bar.frame, []);
    barsByFrame.get(bar.frame).push(bar.x + bar.w / 2);
  }
  const rows = [];
  let mapping = null;
  for (const frame of run.frames) {
    const bars = barsByFrame.get(frame.frame);
    if (bars && bars.length >= 2) {
      const sorted = [...bars].sort((a, b) => a - b);
      const step = quantile(
        sorted.slice(1).map((c, i) => c - sorted[i]),
        0.5,
      );
      // Least squares of centre against bar index, so the line is not one bar's rounding.
      const index = sorted.map((c) => Math.round((c - sorted[0]) / step));
      const mi = mean(index);
      const mc = mean(sorted);
      let sxy = 0;
      let sxx = 0;
      index.forEach((i, j) => {
        sxy += (i - mi) * (sorted[j] - mc);
        sxx += (i - mi) ** 2;
      });
      const pxPerBar = sxx ? sxy / sxx : step;
      mapping = { c0: mc - pxPerBar * mi, msPerPx: 250 / pxPerBar, beat0: null };
    }
    const draw = drawsByFrame.get(frame.frame);
    if (!draw || !mapping) {
      rows.push({ frame, drawn: null });
      continue;
    }
    const centre = draw.x + draw.w / 2;
    const ideal = idealAt(clock, start, frame.ts);
    if (mapping.beat0 === null) {
      if (ideal === null) {
        rows.push({ frame, drawn: null });
        continue;
      }
      mapping.beat0 = 250 * Math.round((ideal - (centre - mapping.c0) * mapping.msPerPx) / 250);
    }
    rows.push({
      frame,
      draw,
      drawn: mapping.beat0 + (centre - mapping.c0) * mapping.msPerPx,
      msPerPx: mapping.msPerPx,
    });
  }
  return rows;
}

function playbackStats(run) {
  const sampleRate = run.contexts.at(-1)?.sampleRate;
  const clock = fitClock(run.stamps);
  const [start] = musicStarts(run, sampleRate);
  if (!clock || !start) return { error: "no clock or no start" };
  const startPerf = clock.perfAt(start.when);
  const endPerf = run.frames.at(-1).ts;
  // Steady state: from 300 ms after the first sample is heard to 300 ms before the stop.
  const inside = (t) => t > startPerf + 300 && t < endPerf - 300;
  const frames = run.frames.filter((f) => inside(f.ts));
  const rows = drawnPlayhead(run, clock, start).filter((row) => inside(row.frame.ts));
  const drawn = rows.filter((row) => row.drawn !== null);
  const error = drawn.map((row) => row.drawn - idealAt(clock, start, row.frame.ts));
  const errorAtDraw = drawn.map((row) => row.drawn - idealAt(clock, start, row.draw.at));
  const centred = (values) => {
    const m = quantile(values, 0.5);
    return values.map((value) => Math.abs(value - m));
  };
  const steps = [];
  for (let i = 1; i < drawn.length; i++) {
    const a = drawn[i - 1];
    const b = drawn[i];
    if (b.frame.frame !== a.frame.frame + 1) continue;
    steps.push(
      b.drawn - a.drawn - (idealAt(clock, start, b.frame.ts) - idealAt(clock, start, a.frame.ts)),
    );
  }
  const intervals = frames.slice(1).map((f, i) => f.ts - frames[i].ts);
  const out = {
    clock: clock.summary,
    frames: {
      n: frames.length,
      seconds: round((frames.at(-1).ts - frames[0].ts) / 1000, 2),
      fps: round(frames.length / ((frames.at(-1).ts - frames[0].ts) / 1000), 1),
      intervalMs: spread(intervals, 2),
      over25ms: intervals.filter((value) => value > 25).length,
      mainThreadMs: spread(
        frames.map((f) => f.after - f.start),
        2,
      ),
      callbackStartLagMs: spread(
        frames.map((f) => f.start - f.ts),
        2,
      ),
      over50msFromFrameStart: frames.filter((f) => f.after - f.ts > 50).length,
    },
    playhead: {
      drawnFrames: drawn.length,
      heldFrames: rows.length - drawn.length,
      msPerDevicePx: round(drawn[0]?.msPerPx ?? null, 4),
      quantisationSdMs: round(((drawn[0]?.msPerPx ?? 0) * 1) / Math.sqrt(12)),
      errorAtFrameMs: spread(error),
      errorAtFrameAbsDevMs: spread(centred(error)),
      errorAtDrawMs: spread(errorAtDraw),
      stepJitterMs: spread(steps),
    },
  };
  const trace = run.trace;
  if (trace && !trace.error) {
    const presented = trace.frames.filter((f) => f.state?.startsWith("STATE_PRESENTED"));
    const inWindow = trace.frames.filter((f) => inside(f.begin));
    out.presentation = {
      reporters: inWindow.length,
      presented: inWindow.filter((f) => f.state?.startsWith("STATE_PRESENTED")).length,
      dropped: inWindow.filter((f) => f.state === "STATE_DROPPED").length,
    };
    const latency = [];
    const delay = [];
    for (const row of drawn) {
      const match = presented.find((f) => Math.abs(f.begin - row.frame.ts) < 1.5);
      if (!match) continue;
      delay.push(match.end - row.frame.ts);
      latency.push(idealAt(clock, start, match.end) - row.drawn);
    }
    out.presentation.frameToPresentMs = spread(delay, 2);
    out.presentation.heardMinusDrawnAtPresentMs = spread(latency);
    out.presentation.heardMinusDrawnAbsDevMs = spread(centred(latency));
    const phases = trace.phases.filter((p) => inside(p.start));
    const sum = (name) => phases.filter((p) => p.name === name).reduce((a, p) => a + p.dur, 0);
    const count = (name) => phases.filter((p) => p.name === name).length;
    out.mainThread = {
      beginMainFrameMs: spread(
        phases.filter((p) => p.name === "ProxyMain::BeginMainFrame").map((p) => p.dur),
        2,
      ),
      paintMsPerSecond: round(sum("Paint") / out.frames.seconds, 1),
      layoutMsPerSecond: round(sum("Layout") / out.frames.seconds, 1),
      layouts: count("Layout"),
      minorGc: count("MinorGC"),
      majorGc: count("MajorGC"),
      gcMs: round(sum("MinorGC") + sum("MajorGC"), 1),
    };
  }
  return out;
}

function tapStats(run) {
  const sampleRate = run.contexts.at(-1)?.sampleRate;
  const clock = fitClock(run.stamps);
  const [start] = musicStarts(run, sampleRate);
  const keys = run.keys.filter((k) => k.key === "b" && !k.repeat);
  const marks = run.savedMarks.filter((m) => m.method === "key-playing").map((m) => m.time_ms);
  marks.sort((a, b) => a - b);
  if (!clock || !start || marks.length !== keys.length)
    return { error: `keys ${keys.length}, key-playing marks ${marks.length}` };
  const rows = keys.map((key, i) => ({
    busy: i % 2 === 1,
    error: marks[i] - idealAt(clock, start, key.timeStamp),
    dispatch: key.at - key.timeStamp,
  }));
  const pick = (busy, field) => rows.filter((r) => r.busy === busy).map((r) => r[field]);
  return {
    clock: clock.summary,
    markMinusHeardMs: { calm: spread(pick(false, "error")), busy: spread(pick(true, "error")) },
    dispatchDelayMs: { calm: spread(pick(false, "dispatch"), 2), busy: spread(pick(true, "dispatch"), 2) },
  };
}

function startStats(run) {
  const sampleRate = run.contexts.at(-1)?.sampleRate;
  const clock = fitClock(run.stamps);
  const starts = musicStarts(run, sampleRate);
  const spaces = run.keys.filter((k) => k.key === " " && !k.repeat);
  const rows = [];
  for (const start of starts) {
    const key = spaces.filter((k) => k.at <= start.at).at(-1);
    if (!key) continue;
    const heard = clock.perfAt(start.when);
    const lead = (start.when - start.ctxNow) * 1000;
    rows.push({
      total: heard - key.timeStamp,
      handling: start.at - key.timeStamp,
      lead,
      output: heard - start.at - lead,
    });
  }
  const pick = (field) => rows.map((r) => r[field]);
  return {
    clock: clock?.summary,
    keyToHeardMs: spread(pick("total"), 2),
    keyToStartCallMs: spread(pick("handling"), 2),
    scheduleLeadMs: spread(pick("lead"), 2),
    startCallToOutputMs: spread(pick("output"), 2),
  };
}

/** The captured output as one array, in context-frame order. */
function captured(part, sampleRate) {
  const chunks = [...part.capture].sort((a, b) => a.playbackTime - b.playbackTime);
  if (!chunks.length) return { samples: new Float32Array(0), gaps: 0, firstFrame: 0 };
  const firstFrame = Math.round(chunks[0].playbackTime * sampleRate);
  const lastFrame = Math.round(chunks.at(-1).playbackTime * sampleRate) + chunks.at(-1).left.length;
  const samples = new Float32Array(lastFrame - firstFrame);
  let gaps = 0;
  let expected = firstFrame;
  for (const chunk of chunks) {
    const frame = Math.round(chunk.playbackTime * sampleRate);
    if (frame !== expected) gaps++;
    const left = Float32Array.from(Object.values(chunk.left));
    samples.set(left, frame - firstFrame);
    expected = frame + left.length;
  }
  return { samples, gaps, firstFrame };
}

/** Left channel of a recording at the page's volume (0.5, exact in float32). */
function leftAtVolume(name, volume) {
  const data = recordings[name].make();
  const left = new Float32Array(data.length / 2);
  for (let i = 0; i < left.length; i++) left[i] = Math.fround(data[2 * i] * volume);
  return left;
}

/**
 * Whether the captured music equals the buffer sample for sample: every non-zero captured sample
 * is looked up by value (almost all noise values are unique) and must continue the run of buffer
 * indexes; a loop wraps from its end frame to its start frame.
 */
function exactness(part, sampleRate, volume) {
  const { samples, gaps } = captured(part, sampleRate);
  const left = leftAtVolume("noise48", volume);
  const index = new Map();
  left.forEach((value, i) => index.set(value, index.has(value) ? -1 : i));
  const [start] = musicStarts(part, sampleRate);
  let first = -1;
  let inexact = 0;
  let total = 0;
  let wraps = 0;
  let firstInexact = null;
  let previous = null;
  for (let n = 0; n < samples.length; n++) {
    const value = samples[n];
    if (value === 0) continue;
    total++;
    const i = index.get(value);
    if (i === undefined) {
      inexact++;
      firstInexact ??= total;
      previous = null;
      continue;
    }
    if (i < 0) {
      previous = previous === null ? null : previous + 1;
      continue;
    }
    if (first < 0) first = i;
    if (previous !== null && i !== previous + 1) wraps++;
    previous = i;
  }
  return {
    gaps,
    captured: total,
    inexact,
    firstInexactAt: firstInexact,
    wraps,
    firstIndex: first,
    expectedFirstIndex: start?.startIndex,
    loopFrames: start?.loop
      ? [round(start.loopStart * sampleRate, 4), round(start.loopEnd * sampleRate, 4)]
      : null,
  };
}

/** The click buffer the engine plays (must match clickSamples in audio-engine.ts), at a volume. */
function clickTemplate(sampleRate, volume) {
  return Float32Array.from({ length: Math.round(sampleRate * 0.012) }, (_, n) => {
    const t = n / sampleRate;
    return volume * 0.3 * Math.cos(2 * Math.PI * 2000 * t) * Math.exp(-t / 0.002);
  });
}

/**
 * Each pulse in the captured output, and the click after it: the click's start is fitted to a
 * fraction of a sample (least squares over a linearly interpolated click template) and compared
 * with where the mark's source time is heard, offset/rate samples after the pulse.
 */
function clickStats(part, sampleRate, volume) {
  const { samples, gaps } = captured(part, sampleRate);
  const [start] = musicStarts(part, sampleRate);
  if (!start) return { error: "no music start" };
  const rate = start.rate;
  const template = clickTemplate(sampleRate, volume);
  const at = (x) => {
    if (x < 0 || x >= template.length - 1) return 0;
    const i = Math.floor(x);
    return template[i] + (template[i + 1] - template[i]) * (x - i);
  };
  const fit = (q, tau) => {
    let sxy = 0;
    let sxx = 0;
    const from = q + Math.max(3, Math.floor(tau));
    for (let n = from; n < from + 500 && n < samples.length; n++) {
      const model = at(n - q - tau);
      sxy += model * samples[n];
      sxx += model * model;
    }
    const amplitude = sxx ? sxy / sxx : 0;
    let sse = 0;
    for (let n = from; n < from + 500 && n < samples.length; n++)
      sse += (samples[n] - amplitude * at(n - q - tau)) ** 2;
    return { sse, amplitude };
  };
  const errors = [];
  const fractions = {};
  let quietSince = 0;
  for (let n = 0; n < samples.length; n++) {
    if (Math.abs(samples[n]) < 0.02) continue;
    if (n - quietSince < 20 || samples[n] < 0.1) {
      quietSince = n;
      continue;
    }
    // A pulse after quiet: its peak within two samples.
    let q = n;
    for (let m = n; m <= n + 2; m++) if (samples[m] > samples[q]) q = m;
    let best = null;
    for (const offset of clickOffsetSamples) {
      const expected = offset / rate;
      for (let tau = expected - 1.5; tau <= expected + 1.5; tau += 0.02) {
        const { sse, amplitude } = fit(q, tau);
        if (amplitude > 0 && (!best || sse < best.sse)) best = { sse, tau, expected, offset };
      }
    }
    if (best) {
      // Parabolic refinement around the best grid point.
      const a = fit(q, best.tau - 0.02).sse;
      const c = fit(q, best.tau + 0.02).sse;
      const denominator = a - 2 * best.sse + c;
      const tau = denominator > 0 ? best.tau + (0.02 * (a - c)) / (2 * denominator) : best.tau;
      const error = tau - best.expected;
      errors.push(error);
      (fractions[best.offset] ??= []).push(error);
    }
    quietSince = n + 600;
    n += 600;
  }
  return {
    gaps,
    rate,
    clicks: errors.length,
    errorSamples: spread(errors, 4),
    errorMs: spread(
      errors.map((e) => (e * 1000) / sampleRate),
      5,
    ),
    byOffset: Object.fromEntries(
      Object.entries(fractions).map(([offset, values]) => [offset, round(mean(values), 4)]),
    ),
  };
}

export function analyseRun(run) {
  if (run.scenario === "taps") return tapStats(run);
  if (run.scenario === "start") return startStats(run);
  if (run.scenario === "capture") {
    const sampleRate = run.seek.contexts.at(-1)?.sampleRate ?? 48_000;
    const volume = 0.5;
    return {
      seek: exactness(run.seek, sampleRate, volume),
      loop: exactness(run.loop, sampleRate, volume),
      clicks: clickStats(run.clicks, sampleRate, volume),
      clicksHalf: clickStats(run.clicksHalf, sampleRate, volume),
      clicksLoop: clickStats(run.clicksLoop, sampleRate, volume),
      errors: run.errors,
    };
  }
  return { ...playbackStats(run), errors: run.errors };
}

/** The handful of numbers compared across builds. */
function keyMetrics(scenario, s) {
  if (scenario === "taps")
    return {
      tapErrSdCalm: s.markMinusHeardMs?.calm.sd,
      tapErrSdBusy: s.markMinusHeardMs?.busy.sd,
      tapErrMeanBusy: s.markMinusHeardMs?.busy.mean,
    };
  if (scenario === "start")
    return { keyToHeardP50: s.keyToHeardMs?.p50, startLeadP50: s.scheduleLeadMs?.p50 };
  if (scenario === "capture")
    return {
      seekInexact: s.seek?.inexact,
      loopInexact: s.loop?.inexact,
      clickErrSdSamples: s.clicks?.errorSamples.sd,
      clickHalfErrSdSamples: s.clicksHalf?.errorSamples.sd,
      clickLoopMaxSamples: s.clicksLoop?.errorSamples.max,
    };
  return {
    fps: s.frames?.fps,
    mainP50: s.frames?.mainThreadMs.p50,
    mainP90: s.frames?.mainThreadMs.p90,
    over25: s.frames?.over25ms,
    held: s.playhead?.heldFrames,
    errSd: s.playhead?.errorAtFrameMs.sd,
    errDevP99: s.playhead?.errorAtFrameAbsDevMs.p99,
    stepSd: s.playhead?.stepJitterMs.sd,
    presentDelayP50: s.presentation?.frameToPresentMs.p50,
    lagSd: s.presentation?.heardMinusDrawnAtPresentMs.sd,
    lagDevP99: s.presentation?.heardMinusDrawnAbsDevMs.p99,
    stampSd: s.clock?.residualSdMs,
    stampOver1: s.clock?.over1ms,
    gcMs: s.mainThread?.gcMs,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { json: { type: "string" } },
  });
  const files = positionals.map((path) => ({ path, raw: JSON.parse(readFileSync(path, "utf8")) }));
  const summaries = files.map(({ path, raw }) => ({
    path,
    label: raw.label,
    runs: raw.runs.map((run) => ({ scenario: run.scenario, repeat: run.repeat, stats: analyseRun(run) })),
  }));
  if (values.json) writeFileSync(values.json, JSON.stringify(summaries, null, 1));
  if (summaries.length === 1) {
    for (const run of summaries[0].runs)
      console.log(`## ${run.scenario} #${run.repeat + 1}\n${JSON.stringify(run.stats, null, 1)}`);
  } else {
    const scenarios = [...new Set(summaries.flatMap((s) => s.runs.map((r) => r.scenario)))];
    for (const scenario of scenarios) {
      console.log(`## ${scenario}`);
      const table = {};
      for (const summary of summaries) {
        const runs = summary.runs.filter((r) => r.scenario === scenario);
        const metrics = runs.map((r) => keyMetrics(scenario, r.stats));
        const names = Object.keys(metrics[0] ?? {});
        table[summary.label || summary.path] = Object.fromEntries(
          names.map((name) => [name, round(quantile(metrics.map((m) => m[name]).filter((v) => v !== null && v !== undefined), 0.5))]),
        );
      }
      console.table(table);
    }
  }
}
