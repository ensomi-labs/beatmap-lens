/** Geometry and derived drawing data for the Draft stage; pure, so the stage stays thin. */
import type { Beat, Boundary, GridFit, Span, Statement } from "./ensomi-contract";

export interface TimeWindow {
  startS: number;
  endS: number;
}

export const xOf = (t: number, view: TimeWindow, width: number) =>
  ((t - view.startS) / (view.endS - view.startS)) * width;

export const tOf = (x: number, view: TimeWindow, width: number) =>
  view.startS + (x / width) * (view.endS - view.startS);

/** Beats closer than this on screen collapse into their run band. */
export const collapsePx = 6;

export function beatsCollapse(beats: readonly Beat[], view: TimeWindow, width: number): boolean {
  const visible = beats.filter((beat) => beat.t >= view.startS && beat.t <= view.endS);
  if (visible.length < 2) return false;
  const gaps = visible.slice(1).map((beat, index) => beat.t - (visible[index] as Beat).t);
  gaps.sort((a, b) => a - b);
  const median = gaps[gaps.length >> 1] as number;
  return (median / (view.endS - view.startS)) * width < collapsePx;
}

export type RunKind = "steady" | "free" | "gap";

export interface RunBand extends Span {
  kind: RunKind;
  bpm?: number;
}

/**
 * Runs along the ruler: boundaries cut the beats into segments; a gap boundary opens a gap; a
 * `free_start` segment is free; otherwise a segment is steady when its intervals stay within
 * 1.5 % of their median (labelled with that BPM), else free.
 */
export function runBands(beats: readonly Beat[], boundaries: readonly Boundary[]): RunBand[] {
  const cuts = [...boundaries].sort((a, b) => a.t - b.t);
  const bands: RunBand[] = [];
  let segment: number[] = [];
  let forcedFree = false;
  let gapFrom: number | undefined;
  const flush = (end?: number) => {
    if (segment.length >= 2) {
      const intervals = segment.slice(1).map((t, index) => t - (segment[index] as number));
      const sorted = [...intervals].sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1] as number;
      const steady =
        !forcedFree && intervals.every((value) => Math.abs(value / median - 1) < 0.015);
      bands.push({
        t0: segment[0] as number,
        t1: end ?? (segment.at(-1) as number),
        kind: steady ? "steady" : "free",
        ...(steady ? { bpm: 60 / median } : {}),
      });
    }
    segment = [];
  };
  let cut = 0;
  const times = beats.map((beat) => beat.t).sort((a, b) => a - b);
  for (const t of times) {
    while (cut < cuts.length && (cuts[cut] as Boundary).t <= t + 1e-9) {
      const boundary = cuts[cut++] as Boundary;
      flush();
      if (boundary.kind === "gap_start") gapFrom = boundary.t;
      if (boundary.kind === "gap_end" && gapFrom !== undefined) {
        bands.push({ t0: gapFrom, t1: boundary.t, kind: "gap" });
        gapFrom = undefined;
      }
      forcedFree = boundary.kind === "free_start" || (forcedFree && boundary.kind === "reset");
    }
    if (gapFrom === undefined) segment.push(t);
  }
  flush();
  return bands;
}

export const statementLabel: Record<Statement["kind"], string> = {
  steady: "steady",
  free: "free",
  no_pulse: "no pulse",
  keep: "keep",
  beat_run: "beat run",
  forbid_beat: "no beat",
  sound_at: "sound",
  beat_at: "beat",
};

export function statementSpan(statement: Statement): Span {
  return "span" in statement ? statement.span : { t0: statement.t, t1: statement.t };
}

/** Per-bin heat for the overview bar: unexplained sounds and beat uncertainty, each 0 to 1. */
export function overviewHeat(
  fits: readonly GridFit[],
  beats: readonly Beat[],
  durationS: number,
  bins: number,
): { unexplained: number; uncertainty: number }[] {
  const heat = Array.from({ length: bins }, () => ({ unexplained: 0, uncertainty: 0 }));
  const bin = (t: number) => Math.min(bins - 1, Math.max(0, Math.floor((t / durationS) * bins)));
  for (const fit of fits)
    if (fit.status === "unexplained") (heat[bin(fit.t)] as (typeof heat)[0]).unexplained++;
  for (const beat of beats)
    if (beat.conf !== undefined && beat.source !== "user")
      (heat[bin(beat.t)] as (typeof heat)[0]).uncertainty += 1 - beat.conf;
  const maxU = Math.max(1, ...heat.map((entry) => entry.unexplained));
  const maxC = Math.max(0.5, ...heat.map((entry) => entry.uncertainty));
  return heat.map((entry) => ({
    unexplained: entry.unexplained / maxU,
    uncertainty: entry.uncertainty / maxC,
  }));
}

/** Whisker scale: 1 px per ms, capped, so residuals read the same at every zoom. */
export const whiskerPx = (residualMs: number) =>
  Math.sign(residualMs) * Math.min(48, Math.abs(residualMs));
