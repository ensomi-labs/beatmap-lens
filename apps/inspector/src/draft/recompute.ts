/**
 * RuleMockRecompute: a transparent stand-in for constrained recompute, reserved for the N1 model.
 * Every offer is a valid `ensomi` v0 `PatchOffer` produced by a stated rule and badged
 * `providerKind: "rule"`; nothing pretends to be a model. Shared by the local service and tests.
 */
import {
  type Beat,
  type BeatInput,
  type Boundary,
  computeConsequences,
  computeGridFit,
  computeSemanticKey,
  createInitialState,
  DRAFT_GRID_FIT_OPTIONS,
  detectSiblingConflicts,
  getRangeEntityIds,
  isOfferSuppressed,
  lineFit,
  lowerBound,
  type OfferRole,
  type OfferScopeKind,
  type PatchOffer,
  type PatchOp,
  type RejectionSuppression,
  type SessionState,
  type SoundAnchor,
  type Span,
  type Statement,
  signedGridResidualMs,
  spanContainsTime,
  spansOverlap,
  validatePatchOffer,
} from "./ensomi-contract.ts";

export const ruleMockProvider = "rule mock (reserved for N1)";

export interface RecomputeRequest {
  generation: number;
  basisSeq?: number;
  span: Span;
  durationS: number;
  beats: Beat[];
  boundaries: Boundary[];
  sounds: SoundAnchor[];
  statements: Statement[];
  suppressions?: RejectionSuppression[];
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

interface OfferDraft {
  role: OfferRole;
  scopeKind: OfferScopeKind;
  optionIndex?: number;
  summary: string;
  readScope: Span | "song";
  writeScope: Span;
  ops: PatchOp;
}

const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function checkAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new DOMException("The recompute was cancelled.", "AbortError");
}

function buildSnapshotState(request: RecomputeRequest): SessionState {
  const state = createInitialState();
  state.audio = {
    audioId: "recompute-snapshot",
    durationSec: request.durationS,
    clock: "source-audio-sec",
  };
  state.generation = request.generation;
  state.lastSeq = request.basisSeq ?? 0;
  for (const beat of request.beats) state.beats.set(beat.id, beat);
  for (const boundary of request.boundaries) state.boundaries.set(boundary.id, boundary);
  for (const sound of request.sounds) state.sounds.set(sound.id, sound);
  for (const statement of request.statements) state.statements.set(statement.id, statement);
  state.suppressions = [...(request.suppressions ?? [])];
  return state;
}

function expectedVersionsFor(beats: readonly Beat[]): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const beat of beats) versions[beat.id] = beat.version;
  return versions;
}

/**
 * One batch of `ensomi` v0 `PatchOffer`s for `request.span`. Yields between rules and stops with
 * an `AbortError` as soon as `signal` aborts, so a newer request never waits for an older one.
 */
export async function ruleMockRecompute(
  request: RecomputeRequest,
  signal?: AbortSignal,
): Promise<PatchOffer[]> {
  const snapshot = buildSnapshotState(request);
  const rules = [steadyRefits, extend, quickFix, alternatives];
  const drafts: OfferDraft[] = [];
  for (const rule of rules) {
    checkAborted(signal);
    drafts.push(...rule(request, snapshot));
    await yieldTurn();
  }
  checkAborted(signal);
  const batchId = `b${request.generation}-${Math.round(request.span.t0 * 1000)}`;
  const basisSeq = request.basisSeq ?? 0;
  const offers: PatchOffer[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index] as OfferDraft;
    const semanticKey = computeSemanticKey(draft.writeScope, draft.ops);
    if (isOfferSuppressed(snapshot, { semanticKey, writeScope: draft.writeScope, ops: draft.ops }))
      continue;
    const candidate: PatchOffer = {
      id: `${batchId}:${index}`,
      batchId,
      ...(draft.optionIndex !== undefined ? { optionIndex: draft.optionIndex } : {}),
      providerId: ruleMockProvider,
      providerKind: "rule",
      generation: request.generation,
      basisSeq,
      role: draft.role,
      scopeKind: draft.scopeKind,
      readScope: draft.readScope,
      writeScope: draft.writeScope,
      ops: draft.ops,
      summary: draft.summary,
      consequences: computeConsequences(snapshot, draft.ops),
      conflicts: [],
      semanticKey,
      status: "pending",
    };
    candidate.conflicts = validatePatchOffer(snapshot, candidate);
    offers.push(candidate);
  }
  const siblingConflicts = detectSiblingConflicts(offers);
  for (const offer of offers) {
    const extras = siblingConflicts.get(offer.id) ?? [];
    for (const conflict of extras) {
      if (!offer.conflicts.some((c) => c.id === conflict.id)) offer.conflicts.push(conflict);
    }
  }
  return offers;
}

/** `steady` statements: a least-squares line through the beats they cover (fixed slope for a BPM). */
function steadyRefits(request: RecomputeRequest, state: SessionState): OfferDraft[] {
  return request.statements.flatMap((statement) => {
    if (
      statement.active === false ||
      statement.kind !== "steady" ||
      !statement.span ||
      !spansOverlap(statement.span, request.span)
    )
      return [];
    const span = statement.span;
    const beats = request.beats
      .filter((beat) => spanContainsTime(span, beat.t))
      .sort((a, b) => a.t - b.t);
    if (beats.length < 3) return [];
    const times = beats.map((beat) => beat.t);
    const fit = lineFit(times);
    const bpm = typeof statement.value?.bpm === "number" ? statement.value.bpm : undefined;
    const slope = bpm ? 60 / bpm : fit.slope;
    const intercept = bpm
      ? times.reduce((sum, t, k) => sum + t - slope * k, 0) / times.length
      : fit.intercept;
    const moved: Beat[] = [];
    const upsertBeats: BeatInput[] = [];
    beats.forEach((beat, k) => {
      const t = intercept + slope * k;
      if (Math.abs(t - beat.t) > 0.0005) {
        moved.push(beat);
        upsertBeats.push({ ...beat, t, source: "rule" });
      }
    });
    if (!upsertBeats.length) return [];
    return [
      {
        role: "rewrite",
        scopeKind: "local",
        summary: `Steady refit at ${(60 / slope).toFixed(2)} BPM`,
        readScope: span,
        writeScope: span,
        ops: {
          upsertBeats,
          expectedVersions: expectedVersionsFor(moved),
          expectedRangeEntityIds: getRangeEntityIds(state, span),
        },
      },
    ];
  });
}

/** Continues the span's last steady beats forward until the next beat, boundary or the end. */
function extend(request: RecomputeRequest, state: SessionState): OfferDraft[] {
  const inside = request.beats
    .filter((beat) => spanContainsTime(request.span, beat.t))
    .sort((a, b) => a.t - b.t);
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
  const upsertBeats: BeatInput[] = [];
  for (let k = 1; k <= 64; k++) {
    const t = fit.intercept + fit.slope * (anchor.length - 1 + k);
    if (t >= limit) break;
    upsertBeats.push({ id: `x${request.generation}-${k}`, t, source: "rule", version: 1 });
  }
  if (!upsertBeats.length) return [];
  const firstNew = (upsertBeats[0] as BeatInput).t;
  const lastNew = (upsertBeats.at(-1) as BeatInput).t;
  const writeScope: Span = { t0: firstNew, t1: lastNew + 0.001 };
  return [
    {
      role: "extend",
      scopeKind: "forward_continuation",
      summary: `Continue ${(60 / fit.slope).toFixed(2)} BPM forward`,
      readScope: request.span,
      writeScope,
      ops: {
        upsertBeats,
        expectedRangeEntityIds: getRangeEntityIds(state, writeScope),
      },
    },
  ];
}

/** Snaps a beat onto a strong sound 3–35 ms away. */
function quickFix(request: RecomputeRequest, state: SessionState): OfferDraft[] {
  const strong = request.sounds.filter((sound) => sound.emphasis >= 0.4).map((sound) => sound.t);
  strong.sort((a, b) => a - b);
  const moved: Beat[] = [];
  const upsertBeats: BeatInput[] = [];
  for (const beat of request.beats) {
    if (!spanContainsTime(request.span, beat.t)) continue;
    const at = lowerBound(strong, beat.t);
    const nearest = [strong[at - 1], strong[at]]
      .filter((t): t is number => t !== undefined)
      .sort((a, b) => Math.abs(a - beat.t) - Math.abs(b - beat.t))[0];
    if (nearest === undefined) continue;
    const distance = Math.abs(nearest - beat.t);
    if (distance > 0.003 && distance <= 0.035) {
      moved.push(beat);
      upsertBeats.push({ ...beat, t: nearest, source: "rule" });
    }
  }
  if (!upsertBeats.length) return [];
  return [
    {
      role: "quick_fix",
      scopeKind: "local",
      summary: "Snap beats onto strong sounds",
      readScope: request.span,
      writeScope: request.span,
      ops: {
        upsertBeats,
        expectedVersions: expectedVersionsFor(moved),
        expectedRangeEntityIds: getRangeEntityIds(state, request.span),
      },
    },
  ];
}

/**
 * Two exclusive readings of unexplained sounds: a phase reset at the first one (later beats move
 * by its residual), or a free run from it (each nearby beat snaps onto its sound).
 */
function alternatives(request: RecomputeRequest, state: SessionState): OfferDraft[] {
  const fits = computeGridFit(
    request.sounds,
    request.beats,
    request.boundaries,
    DRAFT_GRID_FIT_OPTIONS,
  ).filter((fit) => fit.status === "unexplained" && spanContainsTime(request.span, fit.t));
  if (fits.length < 2) return [];
  const first = fits[0] as (typeof fits)[number];
  const sortedBeats = [...request.beats].sort((a, b) => a.t - b.t);
  const beatTimes = sortedBeats.map((beat) => beat.t);
  const signedResMs = signedGridResidualMs(first.t, beatTimes);
  const deltaSec = signedResMs / 1000;
  const nextBoundary = request.boundaries.find((entry) => entry.t > first.t)?.t ?? request.span.t1;
  const resetSpan: Span = {
    t0: Math.max(0, first.t - 0.0005),
    t1: Math.max(nextBoundary, request.span.t1),
  };
  const shiftSpan: Span = {
    t0: Math.max(0, first.t - 0.5 * Math.abs(deltaSec)),
    t1: resetSpan.t1,
  };
  const shiftedBeats = sortedBeats.filter((beat) => spanContainsTime(shiftSpan, beat.t));
  const resetOps: PatchOp = {
    upsertBoundaries: [
      { id: `r${request.generation}`, t: first.t, kind: "reset", source: "rule", version: 1 },
    ],
    upsertBeats: shiftedBeats.map((beat) => ({
      ...beat,
      t: beat.t + deltaSec,
      source: "rule",
    })),
    expectedVersions: expectedVersionsFor(shiftedBeats),
    expectedRangeEntityIds: getRangeEntityIds(state, resetSpan),
  };

  const freeMoves = new Map<string, { beat: Beat; t: number; dist: number }>();
  for (const fit of fits) {
    const at = lowerBound(beatTimes, fit.t);
    const index = [at - 1, at]
      .filter((i) => i >= 0 && i < beatTimes.length)
      .sort(
        (a, b) =>
          Math.abs((beatTimes[a] as number) - fit.t) - Math.abs((beatTimes[b] as number) - fit.t),
      )[0];
    const beat = index === undefined ? undefined : sortedBeats[index];
    if (!beat) continue;
    const dist = Math.abs(beat.t - fit.t);
    if (dist < 0.12) {
      const prev = freeMoves.get(beat.id);
      if (!prev || dist < prev.dist) freeMoves.set(beat.id, { beat, t: fit.t, dist });
    }
  }
  const freeMovedList = [...freeMoves.values()];
  const freeOps: PatchOp = {
    upsertBoundaries: [
      { id: `f${request.generation}`, t: first.t, kind: "free_start", source: "rule", version: 1 },
    ],
    upsertBeats: freeMovedList.map(({ beat, t }) => ({ ...beat, t, source: "rule" })),
    expectedVersions: expectedVersionsFor(freeMovedList.map(({ beat }) => beat)),
    expectedRangeEntityIds: getRangeEntityIds(state, request.span),
  };

  return [
    {
      role: "alternative",
      scopeKind: "local",
      optionIndex: 0,
      summary: `Phase reset at ${first.t.toFixed(3)} s`,
      readScope: request.span,
      writeScope: resetSpan,
      ops: resetOps,
    },
    {
      role: "alternative",
      scopeKind: "local",
      optionIndex: 1,
      summary: `Free run from ${first.t.toFixed(3)} s`,
      readScope: request.span,
      writeScope: request.span,
      ops: freeOps,
    },
  ];
}
