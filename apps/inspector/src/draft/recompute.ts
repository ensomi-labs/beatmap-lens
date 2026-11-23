/**
 * RuleMockRecompute: a transparent stand-in for constrained recompute, reserved for the N1 model.
 * Every offer is produced by a stated rule and badged `providerKind: "rule"`; nothing pretends to
 * be a model. Shared by the local service (which runs it) and tests.
 */
import {
  type Beat,
  type Boundary,
  type Conflict,
  computeGridFit,
  type EditOp,
  inSpan,
  lineFit,
  lowerBound,
  type OfferRole,
  type PatchOffer,
  type ScopeKind,
  type SoundAnchor,
  type Span,
  type Statement,
  summarizeConsequences,
} from "./ensomi-contract.ts";

export const ruleMockProvider = "rule mock (reserved for N1)";

export interface RecomputeRequest {
  generation: number;
  span: Span;
  durationS: number;
  beats: Beat[];
  boundaries: Boundary[];
  sounds: SoundAnchor[];
  statements: Statement[];
  suppressed: string[];
}

export type RecomputeOutcome =
  | {
      status: "ok";
      generation: number;
      providerKind: "rule";
      provider: string;
      offers: PatchOffer[];
    }
  | { status: "stale" | "superseded" | "cancelled"; generation: number };

interface Draft {
  role: OfferRole;
  scopeKind: ScopeKind;
  label: string;
  key: string;
  span: Span;
  edits: EditOp[];
  conflicts: Conflict[];
}

const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function checkAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new DOMException("The recompute was cancelled.", "AbortError");
}

/**
 * One batch of offers for `request.span`. Yields between rules and stops with an `AbortError`
 * as soon as `signal` aborts, so a newer request never waits for an older one.
 */
export async function ruleMockRecompute(
  request: RecomputeRequest,
  signal?: AbortSignal,
): Promise<PatchOffer[]> {
  const rules = [steadyRefits, extend, quickFix, alternatives];
  const drafts: Draft[] = [];
  for (const rule of rules) {
    checkAborted(signal);
    drafts.push(...rule(request));
    await yieldTurn();
  }
  checkAborted(signal);
  const batchId = `b${request.generation}-${Math.round(request.span.t0 * 1000)}`;
  const offers = drafts
    .filter((draft) => !request.suppressed.includes(draft.key))
    .map((draft, index) => ({
      id: `${batchId}:${index}`,
      batchId,
      role: draft.role,
      scopeKind: draft.scopeKind,
      providerKind: "rule" as const,
      provider: ruleMockProvider,
      semanticKey: draft.key,
      label: draft.label,
      span: draft.span,
      edits: draft.edits,
      conflicts: draft.conflicts,
      consequences: summarizeConsequences(request.beats, draft.edits),
    }));
  const alternativesIds = offers.filter((offer) => offer.role === "alternative").map((o) => o.id);
  for (const offer of offers)
    if (offer.role === "alternative")
      offer.conflicts.push({
        kind: "sibling",
        message: "Alternative readings of the same span; accepting one supersedes the other.",
        refs: alternativesIds.filter((id) => id !== offer.id),
        span: offer.span,
      });
  return offers;
}

const spanKey = (span: Span) => `${Math.round(span.t0 * 100)}-${Math.round(span.t1 * 100)}`;
const overlaps = (a: Span, b: Span) => a.t0 <= b.t1 && b.t0 <= a.t1;

/** Conflicts of moving or removing these beats: the listener's own beats and `keep` spans. */
function guardConflicts(request: RecomputeRequest, edits: EditOp[]): Conflict[] {
  const touched = new Set(
    edits.flatMap((edit) =>
      edit.op === "move_beat" || edit.op === "remove_beat" ? [edit.id] : [],
    ),
  );
  const shifted = edits.flatMap((edit) => (edit.op === "shift_run_offset" ? [edit.span] : []));
  const beats = request.beats.filter(
    (beat) => touched.has(beat.id) || shifted.some((span) => inSpan(beat.t, span)),
  );
  const conflicts: Conflict[] = [];
  const user = beats.filter((beat) => beat.source === "user");
  if (user.length)
    conflicts.push({
      kind: "user_edit",
      message: `Overrides ${user.length} beat${user.length === 1 ? "" : "s"} you placed.`,
      refs: user.map((beat) => beat.id),
    });
  for (const statement of request.statements)
    if (statement.kind === "keep" && beats.some((beat) => inSpan(beat.t, statement.span)))
      conflicts.push({
        kind: "keep",
        message: "Moves beats inside a span you asked to keep.",
        refs: [statement.id],
        span: statement.span,
      });
  return conflicts;
}

/** `steady` statements: a least-squares line through the beats they cover (fixed slope for a BPM). */
function steadyRefits(request: RecomputeRequest): Draft[] {
  return request.statements.flatMap((statement) => {
    if (statement.kind !== "steady" || !overlaps(statement.span, request.span)) return [];
    const beats = request.beats.filter((beat) => inSpan(beat.t, statement.span));
    if (beats.length < 3) return [];
    const times = beats.map((beat) => beat.t);
    const fit = lineFit(times);
    const slope = statement.bpm ? 60 / statement.bpm : fit.slope;
    const intercept = statement.bpm
      ? times.reduce((sum, t, k) => sum + t - slope * k, 0) / times.length
      : fit.intercept;
    const edits: EditOp[] = beats.flatMap((beat, k) => {
      const t = intercept + slope * k;
      return Math.abs(t - beat.t) > 0.0005
        ? [{ op: "move_beat", id: beat.id, t, source: "rule" }]
        : [];
    });
    if (!edits.length) return [];
    return [
      {
        role: "rewrite",
        scopeKind: "local",
        label: `Steady refit at ${(60 / slope).toFixed(2)} BPM`,
        key: `rewrite:steady:${spanKey(statement.span)}`,
        span: statement.span,
        edits,
        conflicts: guardConflicts(request, edits),
      },
    ];
  });
}

/** Continues the span's last steady beats forward until the next beat, boundary or the end. */
function extend(request: RecomputeRequest): Draft[] {
  const inside = request.beats.filter((beat) => inSpan(beat.t, request.span));
  if (inside.length < 3) return [];
  const anchor = inside.slice(-8).map((beat) => beat.t);
  const fit = lineFit(anchor);
  if (fit.slope <= 0.15 || fit.maxError > 0.012) return [];
  const last = anchor.at(-1) as number;
  const later = request.beats.find((beat) => beat.t > last + 0.001)?.t ?? Number.POSITIVE_INFINITY;
  const cut = request.boundaries.find((entry) => entry.t > last + 0.001)?.t;
  const limit = Math.min(
    later - 0.5 * fit.slope,
    cut ?? Number.POSITIVE_INFINITY,
    request.durationS,
  );
  const edits: EditOp[] = [];
  for (let k = 1; k <= 64; k++) {
    const t = fit.intercept + fit.slope * (anchor.length - 1 + k);
    if (t >= limit) break;
    edits.push({
      op: "upsert_beat",
      beat: { id: `x${request.generation}-${k}`, t, source: "rule", version: 1 },
    });
  }
  if (!edits.length) return [];
  const span = { t0: last, t1: (edits.at(-1) as { beat: Beat }).beat.t };
  return [
    {
      role: "extend",
      scopeKind: "forward_continuation",
      label: `Continue ${(60 / fit.slope).toFixed(2)} BPM forward`,
      key: `extend:${Math.round(last * 100)}`,
      span,
      edits,
      conflicts: [],
    },
  ];
}

/** Snaps a beat onto a strong sound 3–35 ms away. */
function quickFix(request: RecomputeRequest): Draft[] {
  const strong = request.sounds.filter((sound) => sound.emphasis >= 0.4).map((sound) => sound.t);
  strong.sort((a, b) => a - b);
  const edits: EditOp[] = request.beats.flatMap((beat) => {
    if (!inSpan(beat.t, request.span)) return [];
    const at = lowerBound(strong, beat.t);
    const nearest = [strong[at - 1], strong[at]]
      .filter((t): t is number => t !== undefined)
      .sort((a, b) => Math.abs(a - beat.t) - Math.abs(b - beat.t))[0];
    if (nearest === undefined) return [];
    const distance = Math.abs(nearest - beat.t);
    return distance > 0.003 && distance <= 0.035
      ? [{ op: "move_beat", id: beat.id, t: nearest, source: "rule" }]
      : [];
  });
  if (!edits.length) return [];
  return [
    {
      role: "quick_fix",
      scopeKind: "local",
      label: "Snap beats onto strong sounds",
      key: `quick_fix:snap:${spanKey(request.span)}`,
      span: request.span,
      edits,
      conflicts: guardConflicts(request, edits),
    },
  ];
}

/**
 * Two exclusive readings of unexplained sounds: a phase reset at the first one (later beats move
 * by its residual), or a free run from it (each nearby beat snaps onto its sound).
 */
function alternatives(request: RecomputeRequest): Draft[] {
  const fits = computeGridFit(request.sounds, request.beats, request.boundaries).filter(
    (fit) => fit.status === "unexplained" && inSpan(fit.t, request.span),
  );
  if (fits.length < 2) return [];
  const first = fits[0] as (typeof fits)[number];
  const next = request.boundaries.find((entry) => entry.t > first.t)?.t ?? request.span.t1;
  const resetSpan = { t0: first.t - 0.0005, t1: Math.max(next, request.span.t1) };
  const resetEdits: EditOp[] = [
    {
      op: "upsert_boundary",
      boundary: {
        id: `r${request.generation}`,
        t: first.t,
        kind: "reset",
        source: "rule",
        version: 1,
      },
    },
    {
      op: "shift_run_offset",
      span: { t0: first.t - (0.5 * Math.abs(first.residualMs)) / 1000, t1: resetSpan.t1 },
      dt: first.residualMs / 1000,
      source: "rule",
    },
  ];
  const beatTimes = request.beats.map((beat) => beat.t);
  const freeEdits: EditOp[] = [
    {
      op: "upsert_boundary",
      boundary: {
        id: `f${request.generation}`,
        t: first.t,
        kind: "free_start",
        source: "rule",
        version: 1,
      },
    },
    ...fits.flatMap((fit): EditOp[] => {
      const at = lowerBound(beatTimes, fit.t);
      const index = [at - 1, at]
        .filter((i) => i >= 0 && i < beatTimes.length)
        .sort(
          (a, b) =>
            Math.abs((beatTimes[a] as number) - fit.t) - Math.abs((beatTimes[b] as number) - fit.t),
        )[0];
      const beat = index === undefined ? undefined : request.beats[index];
      return beat && Math.abs(beat.t - fit.t) < 0.12
        ? [{ op: "move_beat", id: beat.id, t: fit.t, source: "rule" }]
        : [];
    }),
  ];
  return [
    {
      role: "alternative",
      scopeKind: "local",
      label: `Phase reset at ${first.t.toFixed(3)} s`,
      key: `alternative:reset:${Math.round(first.t * 100)}`,
      span: resetSpan,
      edits: resetEdits,
      conflicts: guardConflicts(request, resetEdits),
    },
    {
      role: "alternative",
      scopeKind: "local",
      label: `Free run from ${first.t.toFixed(3)} s`,
      key: `alternative:free:${Math.round(first.t * 100)}`,
      span: request.span,
      edits: freeEdits,
      conflicts: guardConflicts(request, freeEdits),
    },
  ];
}
