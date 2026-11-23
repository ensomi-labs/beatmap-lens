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
  nearestGridSlot,
  type OfferRole,
  type OfferScopeKind,
  type PatchOffer,
  type PatchOp,
  type RejectionSuppression,
  type SessionState,
  type SoundAnchor,
  type Span,
  type Statement,
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
  /** Current entity revision tokens (`seq:eventId`) from SessionState for stale-offer protection. */
  entityRevisions?: Record<string, string>;
  /** Existing offer IDs in the session so newly generated offer/batch IDs never collide across reloads. */
  existingOfferIds?: string[];
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
  /** Independent proposals use distinct groupKeys; mutually exclusive siblings share one. */
  groupKey: string;
  role: OfferRole;
  scopeKind: OfferScopeKind;
  optionIndex?: number;
  summary: string;
  readScope: Span | "song";
  writeScope: Span;
  ops: PatchOp;
}

interface IdAllocator {
  stem: string;
  mint(base: string): string;
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createIdAllocator(request: RecomputeRequest): IdAllocator {
  const used = new Set<string>();
  for (const beat of request.beats) used.add(beat.id);
  for (const boundary of request.boundaries) used.add(boundary.id);
  for (const sound of request.sounds) used.add(sound.id);
  for (const offerId of request.existingOfferIds ?? []) used.add(offerId);

  const basisSeq = request.basisSeq ?? 0;
  const signature = [
    basisSeq,
    request.generation,
    request.span.t0.toFixed(4),
    request.span.t1.toFixed(4),
    request.beats.length,
    request.boundaries.length,
    request.beats.map((b) => `${b.id}@${b.t.toFixed(4)}v${b.version}`).join(","),
    request.boundaries.map((b) => `${b.id}@${b.t.toFixed(4)}v${b.version}`).join(","),
  ].join("|");
  const stem = `s${basisSeq}-g${request.generation}-${fnv1aHex(signature)}`;

  return {
    stem,
    mint(base: string): string {
      let candidate = base;
      let suffix = 1;
      while (used.has(candidate)) {
        candidate = `${base}_${suffix++}`;
      }
      used.add(candidate);
      return candidate;
    },
  };
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
  if (request.entityRevisions) {
    for (const [id, rev] of Object.entries(request.entityRevisions)) {
      state.entityRevisions.set(id, rev);
    }
  }
  state.suppressions = [...(request.suppressions ?? [])];
  return state;
}

function expectedVersionsFor(beats: readonly Beat[]): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const beat of beats) versions[beat.id] = beat.version;
  return versions;
}

function expectedRevisionsFor(
  beats: readonly Beat[],
  state: SessionState,
): Record<string, string> | undefined {
  const revisions: Record<string, string> = {};
  let count = 0;
  for (const beat of beats) {
    const rev = state.entityRevisions.get(beat.id);
    if (rev !== undefined) {
      revisions[beat.id] = rev;
      count += 1;
    }
  }
  return count > 0 ? revisions : undefined;
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
  const ids = createIdAllocator(request);
  const rules = [steadyRefits, extend, quickFix, alternatives];
  const drafts: OfferDraft[] = [];
  for (const rule of rules) {
    checkAborted(signal);
    drafts.push(...rule(request, snapshot, ids));
    await yieldTurn();
  }
  checkAborted(signal);
  const basisSeq = request.basisSeq ?? 0;
  const batchIds = new Map<string, string>();
  const groupCounts = new Map<string, number>();
  const offers: PatchOffer[] = [];
  for (const draft of drafts) {
    const semanticKey = computeSemanticKey(draft.writeScope, draft.ops);
    if (isOfferSuppressed(snapshot, { semanticKey, writeScope: draft.writeScope, ops: draft.ops }))
      continue;
    let batchId = batchIds.get(draft.groupKey);
    if (!batchId) {
      batchId = ids.mint(`b-${ids.stem}-${draft.groupKey}`);
      batchIds.set(draft.groupKey, batchId);
    }
    const slotIndex = groupCounts.get(draft.groupKey) ?? 0;
    groupCounts.set(draft.groupKey, slotIndex + 1);
    const id = ids.mint(`${batchId}:${slotIndex}`);
    const candidate: PatchOffer = {
      id,
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
function steadyRefits(
  request: RecomputeRequest,
  state: SessionState,
  _ids: IdAllocator,
): OfferDraft[] {
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
      const t = Math.max(0, intercept + slope * k);
      if (Math.abs(t - beat.t) > 0.0005) {
        moved.push(beat);
        upsertBeats.push({ ...beat, t, source: "rule" });
      }
    });
    if (!upsertBeats.length) return [];
    const touchedTimes = [...moved.map((beat) => beat.t), ...upsertBeats.map((beat) => beat.t)];
    const writeScope: Span = {
      t0: Math.min(span.t0, ...touchedTimes),
      t1: Math.max(span.t1, Math.max(...touchedTimes) + 0.001),
    };
    const expectedRevisions = expectedRevisionsFor(moved, state);
    return [
      {
        groupKey: `steady-${statement.id}`,
        role: "rewrite",
        scopeKind: "local",
        summary: `Steady refit at ${(60 / slope).toFixed(2)} BPM`,
        readScope: span,
        writeScope,
        ops: {
          upsertBeats,
          expectedVersions: expectedVersionsFor(moved),
          ...(expectedRevisions ? { expectedRevisions } : {}),
          expectedRangeEntityIds: getRangeEntityIds(state, writeScope),
        },
      },
    ];
  });
}

/** Continues the span's last steady beats forward until the next beat, boundary or the end. */
function extend(request: RecomputeRequest, state: SessionState, ids: IdAllocator): OfferDraft[] {
  const sortedBeats = [...request.beats].sort((a, b) => a.t - b.t);
  const sortedBoundaries = [...request.boundaries].sort((a, b) => a.t - b.t);
  const inside = sortedBeats.filter((beat) => spanContainsTime(request.span, beat.t));
  if (inside.length < 3) return [];
  const anchor = inside.slice(-8).map((beat) => beat.t);
  const fit = lineFit(anchor);
  if (fit.slope <= 0.15 || fit.maxError > 0.012) return [];
  const last = anchor.at(-1) as number;
  const later = sortedBeats.find((beat) => beat.t > last + 0.001)?.t ?? Number.POSITIVE_INFINITY;
  const cut = sortedBoundaries.find((entry) => entry.t > last + 0.001)?.t;
  const limit = Math.min(
    later - 0.5 * fit.slope,
    cut ?? Number.POSITIVE_INFINITY,
    request.durationS,
  );
  const upsertBeats: BeatInput[] = [];
  for (let k = 1; k <= 64; k++) {
    const t = fit.intercept + fit.slope * (anchor.length - 1 + k);
    if (t >= limit) break;
    upsertBeats.push({ id: ids.mint(`x-${ids.stem}-${k}`), t, source: "rule", version: 1 });
  }
  if (!upsertBeats.length) return [];
  const firstNew = (upsertBeats[0] as BeatInput).t;
  const lastNew = (upsertBeats.at(-1) as BeatInput).t;
  const writeScope: Span = { t0: firstNew, t1: lastNew + 0.001 };
  return [
    {
      groupKey: "extend",
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
function quickFix(request: RecomputeRequest, state: SessionState, _ids: IdAllocator): OfferDraft[] {
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
    if (nearest === undefined || !spanContainsTime(request.span, nearest)) continue;
    const distance = Math.abs(nearest - beat.t);
    if (distance > 0.003 && distance <= 0.035) {
      moved.push(beat);
      upsertBeats.push({ ...beat, t: nearest, source: "rule" });
    }
  }
  if (!upsertBeats.length) return [];
  const expectedRevisions = expectedRevisionsFor(moved, state);
  return [
    {
      groupKey: "quick_fix",
      role: "quick_fix",
      scopeKind: "local",
      summary: "Snap beats onto strong sounds",
      readScope: request.span,
      writeScope: request.span,
      ops: {
        upsertBeats,
        expectedVersions: expectedVersionsFor(moved),
        ...(expectedRevisions ? { expectedRevisions } : {}),
        expectedRangeEntityIds: getRangeEntityIds(state, request.span),
      },
    },
  ];
}

/**
 * Two exclusive readings of unexplained sounds: a phase reset at the first one (later beats move
 * by its residual, stopping at the earliest boundary or selection end), or a free run from it
 * (each nearby beat in the selection snaps onto its sound).
 */
function alternatives(
  request: RecomputeRequest,
  state: SessionState,
  ids: IdAllocator,
): OfferDraft[] {
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
  const nearestSlot = nearestGridSlot(first.t, beatTimes);
  if (!nearestSlot) return [];
  const deltaSec = nearestSlot.residualMs / 1000;
  const sortedBoundaries = [...request.boundaries].sort((a, b) => a.t - b.t);
  const nextBoundary = sortedBoundaries.find((entry) => entry.t > first.t + 1e-6)?.t;
  const upperBound = Math.min(nextBoundary ?? request.span.t1, request.span.t1);
  const shiftT0 = Math.max(0, request.span.t0, first.t - 0.5 * Math.abs(deltaSec));
  const shiftedBeats = sortedBeats.filter(
    (beat) =>
      beat.t >= shiftT0 &&
      beat.t < upperBound &&
      beat.t + deltaSec >= request.span.t0 &&
      beat.t + deltaSec < upperBound,
  );
  const touchedTimes = [first.t, ...shiftedBeats.flatMap((beat) => [beat.t, beat.t + deltaSec])];
  const resetT0 = Math.max(request.span.t0, Math.min(...touchedTimes) - 0.0005);
  const resetT1 = Math.min(upperBound, Math.max(...touchedTimes) + 0.0005);
  const resetSpan: Span = { t0: resetT0, t1: Math.max(resetT0, resetT1) };
  const resetRevisions = expectedRevisionsFor(shiftedBeats, state);
  const resetOps: PatchOp = {
    upsertBoundaries: [
      { id: ids.mint(`r-${ids.stem}`), t: first.t, kind: "reset", source: "rule", version: 1 },
    ],
    upsertBeats: shiftedBeats.map((beat) => ({
      ...beat,
      t: beat.t + deltaSec,
      source: "rule",
    })),
    expectedVersions: expectedVersionsFor(shiftedBeats),
    ...(resetRevisions ? { expectedRevisions: resetRevisions } : {}),
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
    if (!beat || !spanContainsTime(request.span, beat.t)) continue;
    const dist = Math.abs(beat.t - fit.t);
    if (dist < 0.12) {
      const prev = freeMoves.get(beat.id);
      if (!prev || dist < prev.dist) freeMoves.set(beat.id, { beat, t: fit.t, dist });
    }
  }
  const freeMovedList = [...freeMoves.values()];
  const freeMovedBeats = freeMovedList.map(({ beat }) => beat);
  const freeRevisions = expectedRevisionsFor(freeMovedBeats, state);
  const freeOps: PatchOp = {
    upsertBoundaries: [
      {
        id: ids.mint(`f-${ids.stem}`),
        t: first.t,
        kind: "free_start",
        source: "rule",
        version: 1,
      },
    ],
    upsertBeats: freeMovedList.map(({ beat, t }) => ({ ...beat, t, source: "rule" })),
    expectedVersions: expectedVersionsFor(freeMovedBeats),
    ...(freeRevisions ? { expectedRevisions: freeRevisions } : {}),
    expectedRangeEntityIds: getRangeEntityIds(state, request.span),
  };

  return [
    {
      groupKey: "alternative",
      role: "alternative",
      scopeKind: "local",
      optionIndex: 0,
      summary: `Phase reset at ${first.t.toFixed(3)} s`,
      readScope: request.span,
      writeScope: resetSpan,
      ops: resetOps,
    },
    {
      groupKey: "alternative",
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
