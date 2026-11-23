/**
 * The ensomi v0 Draft contract, kept here until the `ensomi` package can be imported: entities,
 * the two action systems (direct edits and semantic statements), first-class patch offers and
 * conflicts, the append-only trace and its fold, and the derived views. Only types and pure
 * functions, so swapping to `import … from "ensomi"` is one line per importer.
 *
 * Every time is in source-audio seconds on the original mix; an entity's `version` counts the
 * changes it went through. Nothing here triggers a recompute: edits and statements are recorded,
 * and a recompute is requested explicitly by the user.
 */

export type Source = "model" | "user" | "import" | "rule";
export type ProviderKind = "model" | "rule" | "mock";

export interface Span {
  t0: number;
  t1: number;
}

export interface Beat {
  id: string;
  t: number;
  source: Source;
  version: number;
  conf?: number;
  meta?: Record<string, unknown>;
}

export type BoundaryKind = "steady_start" | "free_start" | "reset" | "gap_start" | "gap_end";

export interface Boundary {
  id: string;
  t: number;
  kind: BoundaryKind;
  source: Source;
  version: number;
  bpm?: number;
  meta?: Record<string, unknown>;
}

/** A sound heard in the mix, independent of any beat. */
export interface SoundAnchor {
  id: string;
  t: number;
  /** 0 to 1. */
  emphasis: number;
  source: Source;
  version: number;
  conf?: number;
  experimental?: boolean;
  meta?: Record<string, unknown>;
}

/** Direct edits change entities at once; `source` says who made the change (default user). */
export type EditOp =
  | { op: "upsert_beat"; beat: Beat }
  | { op: "move_beat"; id: string; t: number; source?: Source }
  | { op: "remove_beat"; id: string }
  | { op: "shift_run_offset"; span: Span; dt: number; source?: Source }
  | { op: "upsert_boundary"; boundary: Boundary }
  | { op: "remove_boundary"; id: string }
  | { op: "upsert_sound"; sound: SoundAnchor }
  | { op: "remove_sound"; id: string };

export type SpanStatementKind =
  | "steady"
  | "free"
  | "no_pulse"
  | "keep"
  | "beat_run"
  | "forbid_beat";
export type PointStatementKind = "sound_at" | "beat_at";
export type StatementKind = SpanStatementKind | PointStatementKind;

/** Semantic constraints: they stand as recorded claims and never move a beat themselves. */
export type Statement =
  | { id: string; version: number; kind: "steady"; span: Span; bpm?: number }
  | { id: string; version: number; kind: "beat_run"; span: Span; count?: number }
  | { id: string; version: number; kind: "free" | "no_pulse" | "keep" | "forbid_beat"; span: Span }
  | { id: string; version: number; kind: PointStatementKind; t: number };

export interface Conflict {
  kind: "sibling" | "statement" | "user_edit" | "keep";
  message: string;
  /** Ids of the offers, statements or entities in conflict. */
  refs: string[];
  span?: Span;
}

export type OfferRole = "extend" | "rewrite" | "quick_fix" | "alternative" | "propagate";
export type ScopeKind = "local" | "forward_continuation" | "cross_region";

export interface Consequences {
  added: number;
  moved: number;
  removed: number;
  maxShiftMs: number;
  summary: string;
}

export interface PatchOffer {
  id: string;
  /** Offers of one batch may conflict; accepting one supersedes its siblings. */
  batchId: string;
  role: OfferRole;
  scopeKind: ScopeKind;
  /** Mandatory honesty: who produced the offer. */
  providerKind: ProviderKind;
  provider: string;
  /** A rejected offer's key suppresses the same offer later. */
  semanticKey: string;
  label: string;
  span: Span;
  edits: EditOp[];
  conflicts: Conflict[];
  consequences: Consequences;
}

export interface ProviderInfo {
  kind: ProviderKind;
  name: string;
  note?: string;
  experimental?: boolean;
}

export interface DraftAudio {
  path: string | null;
  title: string;
  durationS: number;
  sampleRate: number;
  channels: number;
  codec?: string;
}

export type TraceBody =
  | {
      type: "init";
      audio: DraftAudio;
      beats: Beat[];
      sounds: SoundAnchor[];
      boundaries: Boundary[];
      providers: { beats: ProviderInfo; sounds: ProviderInfo };
    }
  | { type: "edit"; edit: EditOp }
  | { type: "statement"; statement: Statement }
  | { type: "remove_statement"; id: string }
  | { type: "offers"; offers: PatchOffer[] }
  | { type: "accept_offer"; offerId: string }
  | { type: "reject_offer"; offerId: string }
  /** Undoes the event `target`; retracting a retract redoes it. */
  | { type: "retract"; target: number };

export type TraceEvent = TraceBody & { seq: number; at: string };

export interface DraftState {
  audio: DraftAudio | null;
  providers: { beats: ProviderInfo; sounds: ProviderInfo } | null;
  beats: Beat[];
  boundaries: Boundary[];
  sounds: SoundAnchor[];
  statements: Statement[];
  /** The pending batch of offers. */
  offers: PatchOffer[];
  suppressed: string[];
  lastSeq: number;
}

export const undoableTypes: ReadonlySet<TraceBody["type"]> = new Set([
  "edit",
  "statement",
  "remove_statement",
  "accept_offer",
  "reject_offer",
]);

export function emptyState(): DraftState {
  return {
    audio: null,
    providers: null,
    beats: [],
    boundaries: [],
    sounds: [],
    statements: [],
    offers: [],
    suppressed: [],
    lastSeq: 0,
  };
}

const byTime = <T extends { t: number }>(a: T, b: T) => a.t - b.t;

function upsert<T extends { id: string; t: number; version: number }>(list: T[], item: T): T[] {
  const existing = list.find((entry) => entry.id === item.id);
  const next = existing
    ? { ...item, version: Math.max(item.version, existing.version + 1) }
    : { ...item };
  return [...list.filter((entry) => entry.id !== item.id), next].sort(byTime);
}

export const inSpan = (t: number, span: Span) => t >= span.t0 && t <= span.t1;

export function applyEdit(state: DraftState, edit: EditOp): DraftState {
  switch (edit.op) {
    case "upsert_beat":
      return { ...state, beats: upsert(state.beats, edit.beat) };
    case "move_beat":
      return {
        ...state,
        beats: state.beats
          .map((beat) =>
            beat.id === edit.id
              ? { ...beat, t: edit.t, source: edit.source ?? "user", version: beat.version + 1 }
              : beat,
          )
          .sort(byTime),
      };
    case "remove_beat":
      return { ...state, beats: state.beats.filter((beat) => beat.id !== edit.id) };
    case "shift_run_offset":
      return {
        ...state,
        beats: state.beats
          .map((beat) =>
            inSpan(beat.t, edit.span)
              ? {
                  ...beat,
                  t: beat.t + edit.dt,
                  source: edit.source ?? "user",
                  version: beat.version + 1,
                }
              : beat,
          )
          .sort(byTime),
      };
    case "upsert_boundary":
      return { ...state, boundaries: upsert(state.boundaries, edit.boundary) };
    case "remove_boundary":
      return { ...state, boundaries: state.boundaries.filter((entry) => entry.id !== edit.id) };
    case "upsert_sound":
      return { ...state, sounds: upsert(state.sounds, edit.sound) };
    case "remove_sound":
      return { ...state, sounds: state.sounds.filter((entry) => entry.id !== edit.id) };
  }
}

/** Applies one event that is not a retract; the incremental path of the fold. */
export function applyEvent(state: DraftState, event: TraceEvent): DraftState {
  const next = { ...state, lastSeq: event.seq };
  switch (event.type) {
    case "init":
      return {
        ...emptyState(),
        audio: event.audio,
        providers: event.providers,
        beats: [...event.beats].sort(byTime),
        sounds: [...event.sounds].sort(byTime),
        boundaries: [...event.boundaries].sort(byTime),
        lastSeq: event.seq,
      };
    case "edit":
      return applyEdit(next, event.edit);
    case "statement":
      return {
        ...next,
        statements: [
          ...next.statements.filter((entry) => entry.id !== event.statement.id),
          event.statement,
        ],
      };
    case "remove_statement":
      return { ...next, statements: next.statements.filter((entry) => entry.id !== event.id) };
    case "offers":
      return {
        ...next,
        offers: event.offers.filter((offer) => !next.suppressed.includes(offer.semanticKey)),
      };
    case "accept_offer": {
      const offer = next.offers.find((entry) => entry.id === event.offerId);
      if (!offer) return next;
      const applied = offer.edits.reduce(applyEdit, next);
      return { ...applied, offers: next.offers.filter((entry) => entry.batchId !== offer.batchId) };
    }
    case "reject_offer": {
      const offer = next.offers.find((entry) => entry.id === event.offerId);
      if (!offer) return next;
      return {
        ...next,
        offers: next.offers.filter((entry) => entry.id !== offer.id),
        suppressed: [...new Set([...next.suppressed, offer.semanticKey])],
      };
    }
    case "retract":
      return next;
  }
}

/** The events still in force: a retract cancels its target unless it is itself retracted. */
export function activeEvents(events: readonly TraceEvent[]): TraceEvent[] {
  const retracted = new Set<number>();
  const active: TraceEvent[] = [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as TraceEvent;
    if (retracted.has(event.seq)) continue;
    if (event.type === "retract") retracted.add(event.target);
    active.push(event);
  }
  return active.reverse();
}

/** The full re-fold, used on load and after a retract. */
export function fold(events: readonly TraceEvent[]): DraftState {
  const state = activeEvents(events).reduce(applyEvent, emptyState());
  return { ...state, lastSeq: events.at(-1)?.seq ?? 0 };
}

// ---------------------------------------------------------------- derived views

export type GridFitStatus = "on_grid" | "subdivision" | "unexplained";

export interface GridFit {
  soundId: string;
  t: number;
  status: GridFitStatus;
  /** The divisor of the beat that explains the sound, or null when none does. */
  divisor: number | null;
  /**
   * Signed ms from the explaining slot; for an unexplained sound, from the nearest quarter slot
   * (or the nearest beat outside the beats' range).
   */
  residualMs: number;
}

const isBinary = (divisor: number) => (divisor & (divisor - 1)) === 0;

/** Beat intervals longer than this, or across a gap, do not explain sounds. */
const maxFitIntervalS = 2;

export function computeGridFit(
  sounds: readonly SoundAnchor[],
  beats: readonly Beat[],
  boundaries: readonly Boundary[],
  options: { divisors?: number[]; tolMs?: number } = {},
): GridFit[] {
  const divisors = [...(options.divisors ?? [1, 2, 3, 4, 6])].sort(
    (a, b) => Number(isBinary(b)) - Number(isBinary(a)) || a - b,
  );
  const tolMs = options.tolMs ?? 12;
  const times = beats.map((beat) => beat.t).sort((a, b) => a - b);
  const gaps = boundaries.filter((entry) => entry.kind === "gap_start" || entry.kind === "reset");
  return sounds.map((sound) => {
    const after = lowerBound(times, sound.t);
    const b0 = times[after - 1];
    const b1 = times[after];
    const exact = times[after] === sound.t;
    if (exact)
      return { soundId: sound.id, t: sound.t, status: "on_grid", divisor: 1, residualMs: 0 };
    if (
      b0 === undefined ||
      b1 === undefined ||
      b1 - b0 > maxFitIntervalS ||
      gaps.some((gap) => gap.t > b0 && gap.t < b1)
    ) {
      const nearest = nearestValue(times, sound.t);
      return {
        soundId: sound.id,
        t: sound.t,
        status: "unexplained",
        divisor: null,
        residualMs: nearest === undefined ? 0 : (sound.t - nearest) * 1000,
      };
    }
    const residualAt = (divisor: number) => {
      const step = (b1 - b0) / divisor;
      return (sound.t - (b0 + Math.round((sound.t - b0) / step) * step)) * 1000;
    };
    for (const divisor of divisors) {
      const residualMs = residualAt(divisor);
      if (Math.abs(residualMs) <= tolMs)
        return {
          soundId: sound.id,
          t: sound.t,
          status: isBinary(divisor) ? "on_grid" : "subdivision",
          divisor,
          residualMs,
        };
    }
    return {
      soundId: sound.id,
      t: sound.t,
      status: "unexplained",
      divisor: null,
      residualMs: residualAt(4),
    };
  });
}

export interface RedLine {
  timeMs: number;
  beatLengthMs: number;
  /** osu! requires a meter; it is a placeholder because barlines are not inferred. */
  meter: 4;
}

export interface RedLineProjection {
  points: RedLine[];
  text: string;
  barlines_not_inferred: true;
}

/**
 * `.osu` red lines for the beats: one line per run of beats that a single tempo places within
 * `tolMs` (a least-squares fit), and one per interval in a free run. Boundaries split runs; a gap
 * has no line. Barlines are not inferred, so the meter field is a placeholder.
 */
export function projectRedLines(
  beats: readonly Beat[],
  boundaries: readonly Boundary[],
  options: { tolMs?: number } = {},
): RedLineProjection {
  const tolS = (options.tolMs ?? 2) / 1000;
  const times = beats.map((beat) => beat.t).sort((a, b) => a - b);
  const cuts = [...boundaries].sort(byTime);
  const points: RedLine[] = [];
  let segment: number[] = [];
  let free = false;
  const flush = () => {
    if (segment.length >= 2)
      points.push(...(free ? freeLines(segment) : steadyLines(segment, tolS)));
    segment = [];
  };
  let cut = 0;
  let gap = false;
  for (const t of times) {
    while (cut < cuts.length && (cuts[cut] as Boundary).t <= t + 1e-9) {
      const boundary = cuts[cut++] as Boundary;
      flush();
      if (boundary.kind === "gap_start") gap = true;
      if (boundary.kind === "gap_end") gap = false;
      if (boundary.kind === "free_start") free = true;
      if (boundary.kind === "steady_start") free = false;
    }
    if (!gap) segment.push(t);
  }
  flush();
  const lines = points.map(
    (point) => `${Math.round(point.timeMs)},${point.beatLengthMs.toFixed(12)},4,2,0,100,1,0`,
  );
  return {
    points,
    text: [
      "// barlines not inferred: the meter field (4) is a placeholder",
      "[TimingPoints]",
      ...lines,
      "",
    ].join("\n"),
    barlines_not_inferred: true,
  };
}

function freeLines(times: number[]): RedLine[] {
  return times.slice(0, -1).map((t, index) => ({
    timeMs: t * 1000,
    beatLengthMs: ((times[index + 1] as number) - t) * 1000,
    meter: 4,
  }));
}

function steadyLines(times: number[], tolS: number): RedLine[] {
  const lines: RedLine[] = [];
  let start = 0;
  while (start < times.length - 1) {
    let end = start + 1;
    let fit = lineFit(times.slice(start, end + 1));
    while (end + 1 < times.length) {
      const candidate = lineFit(times.slice(start, end + 2));
      if (candidate.maxError > tolS) break;
      fit = candidate;
      end++;
    }
    lines.push({ timeMs: fit.intercept * 1000, beatLengthMs: fit.slope * 1000, meter: 4 });
    start = end;
  }
  return lines;
}

/** Least-squares t = intercept + slope * k over beat indexes k = 0…n-1. */
export function lineFit(times: readonly number[]): {
  intercept: number;
  slope: number;
  maxError: number;
} {
  const n = times.length;
  const meanK = (n - 1) / 2;
  const meanT = times.reduce((sum, t) => sum + t, 0) / n;
  let num = 0;
  let den = 0;
  times.forEach((t, k) => {
    num += (k - meanK) * (t - meanT);
    den += (k - meanK) ** 2;
  });
  const slope = den ? num / den : 0;
  const intercept = meanT - slope * meanK;
  const maxError = Math.max(...times.map((t, k) => Math.abs(t - (intercept + slope * k))));
  return { intercept, slope, maxError };
}

export interface TroubleSpan {
  span: Span;
  score: number;
  reasons: string[];
}

/**
 * A listening tour ranked by where a listener's effort is most needed: low beat confidence,
 * jumps between neighbouring beat intervals, unexplained sounds (weighted by emphasis) and the
 * pending offers' conflicts. Events within `joinS` of each other form one span of at most
 * `maxSpanS`, short enough to loop. Spans the listener already edited count half.
 */
export function rankTroubleSpans(
  state: Pick<DraftState, "beats" | "boundaries" | "sounds" | "offers">,
  options: { fits?: GridFit[]; joinS?: number; maxSpanS?: number; padS?: number } = {},
): TroubleSpan[] {
  const joinS = options.joinS ?? 1;
  const maxSpanS = options.maxSpanS ?? 2;
  const padS = options.padS ?? 0.25;
  const fits = options.fits ?? computeGridFit(state.sounds, state.beats, state.boundaries);
  const events: { t: number; weight: number; reason: string }[] = [];
  for (const beat of state.beats)
    if (beat.source !== "user" && beat.conf !== undefined && beat.conf < 0.5)
      events.push({ t: beat.t, weight: (0.5 - beat.conf) * 2, reason: "low confidence" });
  const cuts = state.boundaries.map((entry) => entry.t);
  for (let index = 2; index < state.beats.length; index++) {
    const [a, b, c] = [index - 2, index - 1, index].map((at) => (state.beats[at] as Beat).t) as [
      number,
      number,
      number,
    ];
    if (cuts.some((t) => t > a && t <= c)) continue;
    const jump = Math.abs(Math.log((c - b) / (b - a)));
    if (jump > 0.06) events.push({ t: b, weight: Math.min(1, jump * 4), reason: "interval jump" });
  }
  const sounds = new Map(state.sounds.map((sound) => [sound.id, sound]));
  for (const fit of fits)
    if (fit.status === "unexplained")
      events.push({
        t: fit.t,
        weight: 0.5 * (sounds.get(fit.soundId)?.emphasis ?? 0.5),
        reason: "unexplained sound",
      });
  for (const offer of state.offers)
    for (const conflict of offer.conflicts)
      if (conflict.kind !== "sibling")
        events.push({ t: (conflict.span ?? offer.span).t0, weight: 1, reason: "conflict" });
  events.sort(byTime);
  const spans: TroubleSpan[] = [];
  let group: typeof events = [];
  const close = () => {
    if (!group.length) return;
    const span = {
      t0: Math.max(0, (group[0] as (typeof events)[number]).t - padS),
      t1: (group.at(-1) as (typeof events)[number]).t + padS,
    };
    const edited = state.beats.some((beat) => beat.source === "user" && inSpan(beat.t, span));
    const counts = new Map<string, number>();
    for (const event of group) counts.set(event.reason, (counts.get(event.reason) ?? 0) + 1);
    spans.push({
      span,
      score: group.reduce((sum, event) => sum + event.weight, 0) * (edited ? 0.5 : 1),
      reasons: [...counts].map(([reason, count]) => `${count} ${reason}`),
    });
    group = [];
  };
  for (const event of events) {
    const last = group.at(-1);
    const first = group[0];
    if (last && (event.t - last.t > joinS || event.t - (first as typeof last).t > maxSpanS))
      close();
    group.push(event);
  }
  close();
  return spans.sort((a, b) => b.score - a.score || a.span.t0 - b.span.t0);
}

export function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((values[mid] as number) < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function nearestValue(values: readonly number[], target: number): number | undefined {
  const index = lowerBound(values, target);
  const candidates = [values[index - 1], values[index]].filter(
    (value): value is number => value !== undefined,
  );
  return candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
}

/** The offer's edits applied to the beats, for previews and A/B clicks. */
export function beatsAfter(state: DraftState, offer: PatchOffer): Beat[] {
  return offer.edits.reduce(applyEdit, state).beats;
}

export function summarizeConsequences(
  before: readonly Beat[],
  edits: readonly EditOp[],
): Consequences {
  const after = edits.reduce(applyEdit, { ...emptyState(), beats: [...before] }).beats;
  const old = new Map(before.map((beat) => [beat.id, beat.t]));
  const now = new Map(after.map((beat) => [beat.id, beat.t]));
  let moved = 0;
  let maxShiftMs = 0;
  for (const [id, t] of now) {
    const was = old.get(id);
    if (was === undefined || Math.abs(was - t) < 1e-6) continue;
    moved++;
    maxShiftMs = Math.max(maxShiftMs, Math.abs(was - t) * 1000);
  }
  const added = [...now.keys()].filter((id) => !old.has(id)).length;
  const removed = [...old.keys()].filter((id) => !now.has(id)).length;
  const boundaryEdits = edits.filter((edit) => edit.op === "upsert_boundary").length;
  const parts = [
    moved ? `moves ${moved} beat${moved === 1 ? "" : "s"} (max ${maxShiftMs.toFixed(1)} ms)` : "",
    added ? `adds ${added}` : "",
    removed ? `removes ${removed}` : "",
    boundaryEdits ? `${boundaryEdits} boundary` : "",
  ].filter(Boolean);
  return {
    added,
    moved,
    removed,
    maxShiftMs,
    summary: parts.length ? parts.join(" · ") : "no beat changes",
  };
}
