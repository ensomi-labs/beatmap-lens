/**
 * Thin Draft-workspace adapter over the real `ensomi` v0 contract package.
 *
 * All entities, trace events/fold/NDJSON, PatchOffer validation/semantic keys/consequences,
 * constraint compilation, and derived views (`computeGridFit`, `projectRedLines`,
 * `rankTroubleSpans`) are imported from and delegated directly to `"ensomi"`.
 * Only Draft-workspace UI conveniences live here.
 */

import type {
  AudioDescriptor,
  Beat,
  GridFitOptions,
  PatchOffer,
  ProviderKind,
  SessionState,
  TraceEventType,
} from "ensomi";

export {
  type AudioDescriptor,
  type AuthorKind,
  applyEvent,
  type Beat,
  type BeatInput,
  type Boundary,
  type BoundaryInput,
  type BoundaryKind,
  type Conflict,
  type ConflictKind,
  type Constraint,
  type ConstraintForm,
  compileConstraints,
  computeConsequences,
  computeGridFit,
  computeSemanticKey,
  createInitialState,
  detectSiblingConflicts,
  type EditOp,
  type EditOpKind,
  type EntitySource,
  foldTrace,
  type GridFitItem,
  type GridFitOptions,
  type GridFitStatus,
  getRangeEntityIds,
  isOfferSuppressed,
  type OfferConsequences,
  type OfferRole,
  type OfferScopeKind,
  type OfferStatus,
  type PatchOffer,
  type PatchOp,
  type ProviderKind,
  parseTraceNdjson,
  projectRedLines,
  type RedLine,
  type RedLineOptions,
  type RedLineProjection,
  type RejectionSuppression,
  rankTroubleSpans,
  resolveActiveRetractions,
  type SessionState,
  type SignalPayload,
  type SoundAnchor,
  type SoundAnchorInput,
  type Span,
  type Statement,
  type StatementInput,
  type StatementKind,
  serializeTraceNdjson,
  spanContainsTime,
  spansOverlap,
  TRACE_SCHEMA_VERSION,
  type TraceAuthor,
  type TraceEvent,
  type TraceEventType,
  type TroubleSpan,
  type TroubleSpanBreakdown,
  type TroubleSpanOptions,
  validatePatchOffer,
} from "ensomi";

/**
 * Calibrated Draft workspace defaults for `computeGridFit`: excludes 1/8 with a tight 12 ms
 * tolerance so off-grid sounds are not hidden by a dense subdivision grid.
 */
export const DRAFT_GRID_FIT_OPTIONS: GridFitOptions = {
  divisors: [1, 2, 3, 4, 6],
  tolMs: 12,
};

export interface ProviderInfo {
  kind: ProviderKind;
  name: string;
  note?: string;
  experimental?: boolean;
}

export interface DraftProviders {
  beats: ProviderInfo;
  sounds: ProviderInfo;
}

export interface DraftAudio {
  path: string | null;
  title: string;
  durationS: number;
  sampleRate: number;
  channels: number;
  codec?: string;
}

export const undoableTypes: ReadonlySet<TraceEventType> = new Set([
  "edit",
  "statement",
  "offer_accept",
  "offer_reject",
]);

export function toAudioDescriptor(audio: DraftAudio): AudioDescriptor {
  return {
    audioId: audio.path ?? `draft:${audio.title}`,
    durationSec: audio.durationS,
    sampleRate: audio.sampleRate,
    clock: "source-audio-sec",
    ...(audio.codec ? { decoder: audio.codec } : {}),
  };
}

/**
 * Recovers Draft UI metadata (`DraftAudio` and `DraftProviders`) from the latest active
 * `audio_bound` trace event, falling back cleanly to `state.audio` for externally created traces.
 */
export function extractDraftMeta(state: SessionState): {
  audio: DraftAudio | null;
  providers: DraftProviders | null;
} {
  for (let i = state.events.length - 1; i >= 0; i -= 1) {
    const event = state.events[i];
    if (event?.type !== "audio_bound" || state.retractedEventIds.has(event.id)) continue;
    const payload = event.payload as
      | { draftAudio?: DraftAudio; providers?: DraftProviders }
      | undefined;
    if (payload?.draftAudio) {
      return {
        audio: payload.draftAudio,
        providers: payload.providers ?? null,
      };
    }
  }
  if (!state.audio) return { audio: null, providers: null };
  return {
    audio: {
      path: state.audio.audioId.startsWith("/") ? state.audio.audioId : null,
      title: state.audio.audioId,
      durationS: state.audio.durationSec,
      sampleRate: state.audio.sampleRate ?? 44_100,
      channels: 1,
      ...(state.audio.decoder ? { codec: state.audio.decoder } : {}),
    },
    providers: null,
  };
}

export function sortedEntities<T extends { id: string; t: number }>(
  map: ReadonlyMap<string, T>,
): T[] {
  return [...map.values()].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
}

/** Non-binary divisors (e.g. 3, 6) draw as numerals in the Draft sounds lane. */
export function isNonBinaryDivisor(divisor: number | null | undefined): boolean {
  return divisor != null && divisor > 1 && (divisor & (divisor - 1)) !== 0;
}

/** Applies a PatchOffer's beat ops purely to current state beats, for audition previews and A/B clicks. */
export function beatsAfter(state: SessionState, offer: PatchOffer): Beat[] {
  const next = new Map(state.beats);
  for (const id of offer.ops.removeBeatIds ?? []) next.delete(id);
  for (const raw of offer.ops.upsertBeats ?? []) {
    const existing = next.get(raw.id);
    next.set(raw.id, {
      ...raw,
      version: existing ? existing.version + 1 : (raw.version ?? 1),
    });
  }
  return sortedEntities(next);
}

/** Human-readable consequence summary for the Offers inspector and status bar. */
export function formatConsequences(offer: PatchOffer, state?: SessionState): string {
  const { beatsAdded, beatsMoved, beatsRemoved } = offer.consequences;
  let maxShiftMs = 0;
  if (state) {
    for (const raw of offer.ops.upsertBeats ?? []) {
      const existing = state.beats.get(raw.id);
      if (existing) maxShiftMs = Math.max(maxShiftMs, Math.abs(raw.t - existing.t) * 1000);
    }
  }
  const boundaryEdits =
    (offer.ops.upsertBoundaries?.length ?? 0) + (offer.ops.removeBoundaryIds?.length ?? 0);
  const parts = [
    beatsMoved
      ? `moves ${beatsMoved} beat${beatsMoved === 1 ? "" : "s"}${maxShiftMs > 0 ? ` (max ${maxShiftMs.toFixed(1)} ms)` : ""}`
      : "",
    beatsAdded ? `adds ${beatsAdded}` : "",
    beatsRemoved ? `removes ${beatsRemoved}` : "",
    boundaryEdits ? `${boundaryEdits} boundary` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "no beat changes";
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

/**
 * Signed residual in ms from the nearest quarter-beat grid slot inside the enclosing beat
 * interval (or from the nearest beat outside the beat range). Used for whisker direction,
 * flam-check click placement, and phase-reset offset estimation.
 */
export function signedGridResidualMs(soundT: number, sortedBeatTimes: readonly number[]): number {
  if (!sortedBeatTimes.length) return 0;
  const after = lowerBound(sortedBeatTimes, soundT);
  const b0 = sortedBeatTimes[after - 1];
  const b1 = sortedBeatTimes[after];
  if (b0 !== undefined && b1 !== undefined && b1 > b0 && b1 - b0 <= 2) {
    const step = (b1 - b0) / 4;
    const slot = b0 + Math.round((soundT - b0) / step) * step;
    return (soundT - slot) * 1000;
  }
  const candidates = [b0, b1].filter((v): v is number => v !== undefined);
  const nearest = candidates.sort((a, b) => Math.abs(a - soundT) - Math.abs(b - soundT))[0];
  return nearest === undefined ? 0 : (soundT - nearest) * 1000;
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
