import type {
  Beat,
  OfferScopeKind,
  PatchOffer,
  Range,
  Segment,
  SegmentRegime,
  SnapFamily,
  SnapRole,
} from "ensomi";
import type { AuditionFilter } from "./client";

export type TempoSubMode = "edit" | "audition";
export type StageVisualMode = "wave" | "spec" | "both";

export type TempoSelection =
  | { kind: "none" }
  | { kind: "beat"; id: string }
  | { kind: "unbeat"; id: string }
  | { kind: "sound"; id: string }
  | { kind: "segment"; id: string }
  | { kind: "range"; t0: number; t1: number };

export const SNAP_ROLE_LABELS: Record<SnapRole, string> = {
  transient_attack: "Attack",
  p_center: "Swell",
  harmonic_change: "Harmony",
  release: "Release",
};

export const SNAP_FAMILY_LABELS: Record<SnapFamily, string> = {
  percussion: "Percussion",
  piano_keys: "Keys",
  strings_winds: "Strings",
  vocal: "Vocal",
  bass_synth: "Bass",
  other: "Mix",
};

export const SEGMENT_REGIME_LABELS: Record<SegmentRegime, string> = {
  auto: "Auto",
  free: "Free",
  break: "Break",
};

export const OFFER_SCOPE_LABELS: Record<OfferScopeKind, string> = {
  local: "Local",
  forward: "Forward",
  cross_region: "Cross-section",
};

export const AUDITION_FILTER_OPTIONS: readonly {
  readonly id: AuditionFilter;
  readonly label: string;
  readonly title: string;
}[] = [
  { id: "mix", label: "Mix", title: "Original stereo mix" },
  { id: "percussive", label: "Perc", title: "Percussive component (audition only)" },
  { id: "harmonic", label: "Harm", title: "Harmonic component (audition only)" },
  { id: "low", label: "Low", title: "Low frequency band (< 200 Hz, audition only)" },
  { id: "mid", label: "Mid", title: "Mid frequency band (200 Hz – 4 kHz, audition only)" },
  { id: "high", label: "High", title: "High frequency band (> 4 kHz, audition only)" },
];

/** Keys typed into form fields stay in the field rather than firing workspace shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
  );
}

/** Space and Enter activate focused buttons/links natively unless handled explicitly. */
export function isNativeActivationTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("button, a, summary, [role='button'], [role='link']"))
  );
}

/** Formats seconds as compact `m:ss.d` (e.g. `0:14.0`). */
export function formatShortTimeSec(timeSec: number, decimals = 1): string {
  const clamped = Math.max(0, Number.isFinite(timeSec) ? timeSec : 0);
  const scale = 10 ** decimals;
  const rounded = Math.round(clamped * scale) / scale;
  const minutes = Math.floor(rounded / 60);
  const rem = rounded - minutes * 60;
  const secFixed = rem.toFixed(decimals);
  const [wholeSec = "0", frac] = secFixed.split(".");
  const paddedSec = wholeSec.padStart(2, "0");
  return decimals > 0 ? `${minutes}:${paddedSec}.${frac ?? ""}` : `${minutes}:${paddedSec}`;
}

/** Formats `[t0, t1)` in seconds as `0:14.0–0:18.2`. */
export function formatSecSpan(t0: number, t1: number, decimals = 1): string {
  return `${formatShortTimeSec(t0, decimals)}–${formatShortTimeSec(t1, decimals)}`;
}

/** Formats signed milliseconds using a typographic minus sign (`+3.2 ms` / `−1.8 ms`). */
export function formatSignedMs(ms: number, decimals = 1): string {
  if (!Number.isFinite(ms)) return "—";
  const rounded = Number(ms.toFixed(decimals));
  if (Object.is(rounded, -0) || rounded === 0) {
    return `${(0).toFixed(decimals)} ms`;
  }
  return rounded > 0
    ? `+${rounded.toFixed(decimals)} ms`
    : `−${Math.abs(rounded).toFixed(decimals)} ms`;
}

/**
 * Zoom-scaled capture radius in seconds for standalone `apply_unbeat_cue`:
 * `[15 ms, 35 ms]` when stopped (`6 * view.msPerPx / 1000`), and `35 ms` during live playback taps.
 */
export function computeUnbeatCaptureRadiusSec(msPerPx: number, isLivePlaying: boolean): number {
  if (isLivePlaying) return 0.035;
  return Math.min(0.035, Math.max(0.015, (6 * msPerPx) / 1000));
}

const INTERNAL_UI_TOKEN_RE =
  /\b(?:sk:[A-Za-z0-9_-]+|\d+:(?:edit|draft_loaded|offer_accept|offer_reject|audio_bound|retract|ready)_[A-Za-z0-9_-]+|(?:offer_b|seg|span|beat|snd|sound|unbeat|offer|batch|evt|snap|ub|kb)[_-][A-Za-z0-9_-]+|b[_-][A-Za-z0-9_-]{2,}|(?:audio_bound|draft_loaded|offer_batch|offer_accept|offer_reject|listen_effort|retract|signal|edit|ready)_\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/** Strips internal entity/trace identifiers so human-facing banners and conflict notes stay clean. */
export function sanitizeUserFacingText(text: string): string {
  return text
    .replace(/"[^"]*"/g, (quoted) => {
      const inner = quoted.slice(1, -1);
      if (INTERNAL_UI_TOKEN_RE.test(inner)) {
        INTERNAL_UI_TOKEN_RE.lastIndex = 0;
        return "this item";
      }
      INTERNAL_UI_TOKEN_RE.lastIndex = 0;
      return quoted;
    })
    .replace(INTERNAL_UI_TOKEN_RE, "item")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface DisplayOfferItem {
  offer: PatchOffer;
  optionLabel: string | null;
  scopeLabel: string;
  spanLabel: string;
}

/**
 * Filters offers to human-actionable `valid` and `stale` entries, sorts `valid` offers
 * ahead of `stale` offers, and computes clean 1-based `Option X of Y` labels.
 */
export function buildDisplayOffers(offers: readonly PatchOffer[]): DisplayOfferItem[] {
  const actionable = offers.filter((o) => o.status === "valid" || o.status === "stale");
  const byBatch = new Map<string, PatchOffer[]>();
  for (const offer of actionable) {
    const list = byBatch.get(offer.batchId) ?? [];
    list.push(offer);
    byBatch.set(offer.batchId, list);
  }
  for (const list of byBatch.values()) {
    list.sort((a, b) => (a.optionIndex ?? 0) - (b.optionIndex ?? 0));
  }

  const ordered = actionable
    .map((offer, originalIdx) => ({ offer, originalIdx }))
    .sort((a, b) => {
      const aRank = a.offer.status === "valid" ? 0 : 1;
      const bRank = b.offer.status === "valid" ? 0 : 1;
      return aRank - bRank || a.originalIdx - b.originalIdx;
    })
    .map((entry) => entry.offer);

  return ordered.map((offer) => {
    const siblings = byBatch.get(offer.batchId) ?? [offer];
    const totalOptions = Math.max(offer.optionCount ?? 1, siblings.length);
    let optionLabel: string | null = null;
    if (totalOptions > 1) {
      const hasZeroIndex = siblings.some((s) => s.optionIndex === 0);
      const posInSiblings = siblings.findIndex((s) => s.id === offer.id);
      const oneBased =
        offer.optionIndex !== undefined
          ? hasZeroIndex
            ? offer.optionIndex + 1
            : offer.optionIndex
          : posInSiblings + 1;
      const clampedIdx = Math.min(totalOptions, Math.max(1, oneBased));
      optionLabel = `Option ${clampedIdx} of ${totalOptions}`;
    }

    const scopeLabel = OFFER_SCOPE_LABELS[offer.scopeKind] ?? "Local";
    let spanLabel = "Whole song";
    if (offer.writeScopes.length > 0) {
      const minT0 = Math.min(...offer.writeScopes.map((w) => w.t0));
      const maxT1 = Math.max(...offer.writeScopes.map((w) => w.t1));
      spanLabel = formatSecSpan(minT0, maxT1, 1);
    }

    return {
      offer,
      optionLabel,
      scopeLabel,
      spanLabel,
    };
  });
}

export interface OfferBeatPreview {
  /** Resulting beats in ascending `timeSec` order if the offer were applied. */
  previewBeats: Beat[];
  /** Beat IDs removed or moved away by the offer. */
  removedBeatIds: Set<string>;
  /** Candidate beats added or moved by the offer, in ascending `timeSec` order. */
  candidateBeats: Beat[];
}

/** Computes ghost/candidate beats for momentary `Alt` A/B visual and click comparison. */
export function computeOfferBeatPreview(
  currentBeats: readonly Beat[],
  offer: PatchOffer | undefined,
): OfferBeatPreview | null {
  if (!offer) return null;
  const removedBeatIds = new Set<string>(offer.ops.removeBeatIds ?? []);
  const upserts = offer.ops.upsertBeats ?? [];
  const map = new Map<string, Beat>();
  for (const beat of currentBeats) {
    if (!removedBeatIds.has(beat.id)) {
      map.set(beat.id, beat);
    }
  }

  const candidateBeats: Beat[] = [];
  for (const raw of upserts) {
    const existing = currentBeats.find((b) => b.id === raw.id);
    if (existing && Math.abs(existing.timeSec - raw.timeSec) > 1e-6) {
      removedBeatIds.add(existing.id);
    }
    const materialized: Beat = {
      id: raw.id,
      timeSec: raw.timeSec,
      source: raw.source ?? "offer",
      revision: raw.revision ?? 1,
      ...(raw.snapEventId !== undefined ? { snapEventId: raw.snapEventId } : {}),
      ...(raw.snapFamily !== undefined ? { snapFamily: raw.snapFamily } : {}),
      ...(raw.snapRole !== undefined ? { snapRole: raw.snapRole } : {}),
      ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}),
    };
    map.set(materialized.id, materialized);
    candidateBeats.push(materialized);
  }

  const previewBeats = Array.from(map.values()).sort((a, b) => a.timeSec - b.timeSec);
  candidateBeats.sort((a, b) => a.timeSec - b.timeSec);
  return {
    previewBeats,
    removedBeatIds,
    candidateBeats,
  };
}

/** Finds the segment containing `timeSec` (falling back to the last segment at track end). */
export function findSegmentAtTime(
  segments: readonly Segment[],
  timeSec: number,
): Segment | undefined {
  if (segments.length === 0) return undefined;
  for (const seg of segments) {
    if (timeSec >= seg.t0 && timeSec < seg.t1) return seg;
  }
  return timeSec < (segments[0]?.t0 ?? 0) ? segments[0] : segments.at(-1);
}

/** Computes a bounded `<= maxSpanSec` audition render window covering the active loop/range/view. */
export function computeAuditionWindow(options: {
  durationSec: number;
  playheadSec: number;
  activeRange: Range | null;
  looping: boolean;
  loopStartSec: number;
  loopEndSec: number;
  maxSpanSec?: number;
  forwardBias?: boolean;
}): Range {
  const maxSpan = options.maxSpanSec ?? 60;
  const dur = Math.max(0.1, options.durationSec);
  if (dur <= maxSpan) {
    return { t0: 0, t1: dur };
  }
  if (
    !options.forwardBias &&
    options.activeRange &&
    options.activeRange.t1 > options.activeRange.t0 &&
    options.playheadSec >= options.activeRange.t0 &&
    options.playheadSec < options.activeRange.t1
  ) {
    const len = options.activeRange.t1 - options.activeRange.t0;
    if (len <= maxSpan) {
      const pad = Math.min(4, (maxSpan - len) / 2);
      const t0 = Math.max(0, options.activeRange.t0 - pad);
      const t1 = Math.min(dur, Math.max(t0 + 0.5, options.activeRange.t1 + pad));
      return { t0, t1: Math.min(dur, Math.min(t0 + maxSpan, t1)) };
    }
  }
  if (
    !options.forwardBias &&
    options.looping &&
    options.loopEndSec > options.loopStartSec &&
    options.playheadSec >= options.loopStartSec &&
    options.playheadSec < options.loopEndSec
  ) {
    const len = options.loopEndSec - options.loopStartSec;
    if (len <= maxSpan) {
      const pad = Math.min(4, (maxSpan - len) / 2);
      const t0 = Math.max(0, options.loopStartSec - pad);
      const t1 = Math.min(dur, Math.min(t0 + maxSpan, options.loopEndSec + pad));
      return { t0, t1 };
    }
  }
  if (options.forwardBias) {
    const t0 = Math.max(0, Math.min(Math.max(0, dur - maxSpan), options.playheadSec - 4));
    const t1 = Math.min(dur, t0 + maxSpan);
    return { t0, t1 };
  }
  const half = maxSpan / 2;
  const t0 = Math.max(0, Math.min(Math.max(0, dur - maxSpan), options.playheadSec - half));
  const t1 = Math.min(dur, t0 + maxSpan);
  return { t0, t1 };
}
