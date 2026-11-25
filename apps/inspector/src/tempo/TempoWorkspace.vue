<script setup lang="ts">
import type {
  Beat,
  EditOp,
  PatchOffer,
  Range,
  Segment,
  SegmentRegime,
  SnapCandidate,
  SoundAnchor,
  Span,
  UnbeatCue,
} from "ensomi";
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import PanelSection from "../layout/PanelSection.vue";
import type { PaneSpec } from "../layout/pane-layout";
import WorkspaceFrame from "../layout/WorkspaceFrame.vue";
import {
  clampView,
  fitView,
  followView,
  formatSourceTime,
  loopReanchorDue,
  motionAt,
  msToX,
  nearestSample,
  nearSilence,
  needsResync,
  nextFollowCheckMs,
  type PlayheadMotion,
  placeAt,
  prerollStart,
  readoutIntervalMs,
  StageAudioEngine,
  type TimeRange,
  type TimeView,
  transportDelayMs,
  zoomAt,
  zoomLimits,
} from "../stage-audio";
import {
  type AuditionFilter,
  acceptOffer,
  applySongAction,
  applySongOps,
  exportSong,
  fetchAuditionAudio,
  fetchSongAudioBytes,
  fetchWorkspace,
  isAbortError,
  openSongSession,
  openWorkspaceFolder,
  recomputeSong,
  rejectOffer,
  setClientWorkspaceDir,
  setHoldOffers,
  suggestSongSnaps,
  type TempoHoldOffersResponse,
  type TempoSongSessionPayload,
  type TempoSongSummary,
  uploadAudioFiles,
} from "./client";
import {
  AUDITION_FILTER_OPTIONS,
  AuditionSliceCache,
  buildDisplayOffers,
  computeAuditionWindow,
  computeOfferBeatPreview,
  computeUnbeatCaptureRadiusSec,
  type DecodedAuditionSlice,
  findSegmentAtTime,
  formatSecSpan,
  formatShortTimeSec,
  formatSignedMs,
  isNativeActivationTarget,
  isTypingTarget,
  SEGMENT_REGIME_LABELS,
  SNAP_FAMILY_LABELS,
  SNAP_ROLE_LABELS,
  type StageVisualMode,
  sanitizeUserFacingText,
  type TempoSelection,
  type TempoSubMode,
} from "./state";
import TempoSegmentStrip from "./TempoSegmentStrip.vue";
import TempoStage, { type LocatePhase } from "./TempoStage.vue";

const leftSpec: PaneSpec = {
  id: "tempo-left",
  label: "Workspace",
  defaultSize: 248,
  min: 184,
  max: 420,
};

const rightSpec: PaneSpec = {
  id: "tempo-right",
  label: "Inspector",
  defaultSize: 308,
  min: 256,
  max: 480,
};

const playbackRates = [1, 0.75, 0.5, 0.25] as const;
const nudgeStepsMs = [-15, -5, -2, 2, 5, 15] as const;
const rangeShiftStepsMs = [-10, -2, 2, 10] as const;
const minimumPrerollMs = 120;
const fineMsPerDevicePx = 0.5;
const beatLoopHalfMs = 500;
const flamHalfSec = 0.75;

const singleShotKeys = new Set([
  " ",
  "enter",
  "escape",
  "b",
  "u",
  "n",
  "r",
  "v",
  "s",
  "m",
  "c",
  "f",
  "z",
  "l",
  "x",
  "g",
  "j",
  "[",
  "]",
  "\\",
  "tab",
  "0",
  "delete",
  "backspace",
]);

interface TempoPreferences {
  volume: number;
  clicks: boolean;
  clickVolume: number;
  cacheAuditionFilters: boolean;
}

function readPreferences(): TempoPreferences {
  try {
    const raw = JSON.parse(localStorage.getItem("lens-tempo-preferences") ?? "{}");
    return {
      volume: typeof raw.volume === "number" ? raw.volume : 0.8,
      clicks: typeof raw.clicks === "boolean" ? raw.clicks : false,
      clickVolume: typeof raw.clickVolume === "number" ? raw.clickVolume : 0.65,
      cacheAuditionFilters:
        typeof raw.cacheAuditionFilters === "boolean" ? raw.cacheAuditionFilters : true,
    };
  } catch {
    return { volume: 0.8, clicks: false, clickVolume: 0.65, cacheAuditionFilters: true };
  }
}

const preferences = ref<TempoPreferences>(readPreferences());
function savePreferences() {
  try {
    localStorage.setItem("lens-tempo-preferences", JSON.stringify(preferences.value));
  } catch {}
}

// Workspace & song session state
const workspaceDir = ref<string | null>(null);
const songs = ref<TempoSongSummary[]>([]);
const selectedSongId = ref<string | null>(null);
const loadedSongId = ref<string | null>(null);
const sessionPayload = shallowRef<TempoSongSessionPayload | null>(null);

const subMode = ref<TempoSubMode>("edit");
const visualMode = ref<StageVisualMode>("both");
const auditionFilter = ref<AuditionFilter>("mix");

// Menus & dialogs
const fileInputRef = ref<HTMLInputElement>();
const folderMenuOpen = ref(false);
const exportMenuOpen = ref(false);
const folderPathInput = ref("");

// Async lifecycle flags & notices
const loadingWorkspace = ref(false);
const openingSong = ref(false);
const inFlightEditCount = ref(0);
const updatingEdit = computed(() => inFlightEditCount.value > 0);
const recomputing = ref(false);
const auditionRendering = ref(false);
const exportingFormat = ref<string | null>(null);
const error = ref("");
const notice = ref("");
const silenceMs = ref<number | undefined>(undefined);
const cuesDirty = ref(false);

interface BoundSnapState {
  songId: string;
  beatId: string;
  beatTimeSec: number;
  generation: number;
  candidates: SnapCandidate[];
}

interface ActiveAuditionCoverage {
  songId: string;
  filter: AuditionFilter;
  startSec: number;
  endSec: number;
}

interface QueuedNudge {
  kind: "beat" | "unbeat" | "sound";
  id: string;
  timeSec: number;
}

// Selection, range, snaps, nudges, and offers
const selection = ref<TempoSelection>({ kind: "none" });
const activeRange = ref<Range | null>(null);
const rangeStartCursorSec = ref<number | null>(null);
const rangeEndCursorSec = ref<number | null>(null);
const snapState = ref<BoundSnapState | null>(null);
const snapsLoading = ref(false);
const selectedOfferId = ref<string | null>(null);
const holdingAlt = ref(false);
const activeAuditionWindow = ref<ActiveAuditionCoverage | null>(null);
const pendingEntityTimeSec = reactive(new Map<string, number>());
const inFlightPlacedBeats = reactive(
  new Map<string, { epoch: number; songId: string; id: string; timeSec: number }>(),
);
const audioLoadSettledForSongId = ref<string | null>(null);
const flamSavedState = ref<{
  rate: (typeof playbackRates)[number];
  looping: boolean;
  loopRegion: TimeRange;
  clicks: boolean;
} | null>(null);

// Stage & audio engine
const workspaceFrame = ref<InstanceType<typeof WorkspaceFrame>>();
const stageRef = ref<InstanceType<typeof TempoStage>>();
const stageWidth = ref(800);
const devicePixelRatio = ref(1);
const view = ref<TimeView>({ startMs: 0, msPerPx: 10 });
const hoverTimeMs = ref<number | undefined>(undefined);
const follow = ref(true);

const audioState = ref<"none" | "loading" | "ready">("none");
const mixBuffer = shallowRef<AudioBuffer>();
const playheadMs = ref(0);
const motion = shallowRef<PlayheadMotion>();
const playing = ref(false);
const looping = ref(false);
const loopRegion = ref<TimeRange>({ startMs: 0, endMs: 0 });
const rate = ref<(typeof playbackRates)[number]>(1);

let songEpoch = 0;
let appliedLastSeq = -1;
let holdOwnerSongId: string | null = null;
const holdChains = new Map<string, Promise<void>>();
let localSnapSeq = 0;
let editChain: Promise<void> = Promise.resolve();
const queuedEntityNudges = new Map<string, QueuedNudge>();
const activeNudgeDrains = new Map<string, Promise<void>>();
let inFlightAuditionTarget: ActiveAuditionCoverage | null = null;

function entityNudgeKey(
  epoch: number,
  songId: string,
  kind: "beat" | "unbeat" | "sound",
  id: string,
): string {
  return `${epoch}::${songId}::${kind}:${id}`;
}

let engine: StageAudioEngine | undefined;
let mixChannels: Float32Array[] | null = null;
let mixFrames = 0;
let activeEngineFilterKey = "mix";
let transportTimer: ReturnType<typeof setTimeout> | undefined;
let readoutAtMs = Number.NEGATIVE_INFINITY;
let motionPlacedAtMs = Number.NEGATIVE_INFINITY;
let fitPending = true;
let disposed = false;

interface AuditionAnchorWindow {
  songId: string;
  startSec: number;
  endSec: number;
}

const auditionSliceCache = new AuditionSliceCache();
let auditionAnchorWindow: AuditionAnchorWindow | null = null;
let workingAuditionChannels: Float32Array[] | null = null;
let patchedAuditionSpan: { startFrame: number; endFrame: number } | null = null;

// AbortControllers for clean latest-wins cancellation
let songOpenAbort: AbortController | null = null;
let snapsAbort: AbortController | null = null;
let snapDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let auditionAbort: AbortController | null = null;
let auditionPrefetchAbort: AbortController | null = null;
let auditionPrefetchTimer: ReturnType<typeof setTimeout> | undefined;
let inflightPrefetchSlice: {
  key: string;
  promise: Promise<DecodedAuditionSlice | null>;
} | null = null;
let stopPrefetchAfterCurrent = false;
let recomputeAbort: AbortController | null = null;

const isSongReadyForActions = computed(
  () =>
    loadedSongId.value !== null &&
    loadedSongId.value === selectedSongId.value &&
    sessionPayload.value !== null &&
    audioLoadSettledForSongId.value === selectedSongId.value,
);

const canUndo = computed(() => Boolean(sessionPayload.value?.canUndo));
const canRedo = computed(() => Boolean(sessionPayload.value?.canRedo));

const activeSongSummary = computed(() => {
  if (!selectedSongId.value) return sessionPayload.value?.songSummary ?? null;
  return (
    songs.value.find((s) => s.songId === selectedSongId.value) ??
    sessionPayload.value?.songSummary ??
    null
  );
});

const durationSec = computed(
  () => sessionPayload.value?.state.durationSec ?? activeSongSummary.value?.durationSec ?? 0,
);
const bounds = computed<TimeRange>(() => ({
  startMs: 0,
  endMs: Math.max(100, durationSec.value * 1000),
}));
const sourceSampleRate = computed(
  () => sessionPayload.value?.state.audio?.sampleRate ?? 44_100,
);

const segments = computed<Segment[]>(() => sessionPayload.value?.state.segments ?? []);
const spans = computed<Span[]>(() => sessionPayload.value?.state.spans ?? []);
const beats = computed<Beat[]>(() => {
  const raw = sessionPayload.value?.state.beats ?? [];
  const curSong = loadedSongId.value;
  const seenIds = new Set<string>();
  const mapped = raw.map((b) => {
    seenIds.add(b.id);
    const pending = curSong
      ? pendingEntityTimeSec.get(entityNudgeKey(songEpoch, curSong, "beat", b.id))
      : undefined;
    const optimistic = curSong
      ? inFlightPlacedBeats.get(`${songEpoch}::${curSong}::${b.id}`)
      : undefined;
    const nextSec = pending ?? optimistic?.timeSec;
    return nextSec !== undefined ? { ...b, timeSec: nextSec } : b;
  });
  if (curSong && inFlightPlacedBeats.size > 0) {
    for (const entry of inFlightPlacedBeats.values()) {
      if (entry.epoch === songEpoch && entry.songId === curSong && !seenIds.has(entry.id)) {
        mapped.push({
          id: entry.id,
          timeSec: entry.timeSec,
          source: "user",
          revision: 1,
        });
      }
    }
    mapped.sort((a, b) => a.timeSec - b.timeSec || a.id.localeCompare(b.id));
  }
  return mapped;
});
const unbeats = computed<UnbeatCue[]>(() => {
  const raw = sessionPayload.value?.state.unbeats ?? [];
  const curSong = loadedSongId.value;
  if (!curSong || pendingEntityTimeSec.size === 0) return raw;
  return raw.map((u) => {
    const pending = pendingEntityTimeSec.get(entityNudgeKey(songEpoch, curSong, "unbeat", u.id));
    return pending !== undefined ? { ...u, timeSec: pending } : u;
  });
});
const sounds = computed<SoundAnchor[]>(() => {
  const raw = sessionPayload.value?.state.sounds ?? [];
  const curSong = loadedSongId.value;
  if (!curSong || pendingEntityTimeSec.size === 0) return raw;
  return raw.map((s) => {
    const pending = pendingEntityTimeSec.get(entityNudgeKey(songEpoch, curSong, "sound", s.id));
    return pending !== undefined ? { ...s, timeSec: pending } : s;
  });
});
const gridFit = computed(() => sessionPayload.value?.gridFit ?? []);
const inboxSpans = computed<Span[]>(() => sessionPayload.value?.inboxSpans ?? []);

const displayOffers = computed(() =>
  buildDisplayOffers(sessionPayload.value?.state.offers ?? []),
);

watch(
  displayOffers,
  (items) => {
    if (items.length === 0) {
      selectedOfferId.value = null;
      return;
    }
    const cur = items.find((i) => i.offer.id === selectedOfferId.value);
    const firstValid = items.find((i) => i.offer.status === "valid");
    if (!cur || (cur.offer.status !== "valid" && firstValid !== undefined)) {
      selectedOfferId.value = (firstValid ?? items[0])?.offer.id ?? null;
    }
  },
  { immediate: true },
);

const activeOffer = computed<PatchOffer | undefined>(() => {
  const items = displayOffers.value;
  if (items.length === 0) return undefined;
  return items.find((i) => i.offer.id === selectedOfferId.value)?.offer ?? items[0]?.offer;
});

const offerPreview = computed(() => computeOfferBeatPreview(beats.value, activeOffer.value));
const abComparing = computed(() => holdingAlt.value && Boolean(activeOffer.value));

const activeBeatTimesMs = computed(() => {
  const source =
    abComparing.value && offerPreview.value ? offerPreview.value.previewBeats : beats.value;
  return source.map((b) => Math.round(b.timeSec * 1_000_000) / 1000);
});

const selectedSegment = computed<Segment | undefined>(() => {
  if (selection.value.kind === "segment") {
    const id = selection.value.id;
    const found = segments.value.find((s) => s.id === id);
    if (found) return found;
  }
  return findSegmentAtTime(segments.value, playheadMs.value / 1000);
});

const selectedSegmentId = computed(() =>
  selection.value.kind === "segment" ? selection.value.id : (selectedSegment.value?.id ?? null),
);

const selectedBeat = computed(() => {
  if (selection.value.kind !== "beat") return undefined;
  const id = selection.value.id;
  return beats.value.find((b) => b.id === id);
});

const snapCandidates = computed<SnapCandidate[]>(() => {
  const current = snapState.value;
  const beat = selectedBeat.value;
  if (
    !current ||
    !beat ||
    !isSongReadyForActions.value ||
    current.songId !== loadedSongId.value ||
    selection.value.kind !== "beat" ||
    beat.id !== current.beatId ||
    Math.abs(beat.timeSec - current.beatTimeSec) > 1e-6
  ) {
    return [];
  }
  return current.candidates;
});

const selectedUnbeat = computed(() => {
  if (selection.value.kind !== "unbeat") return undefined;
  const id = selection.value.id;
  return unbeats.value.find((u) => u.id === id);
});

const selectedSound = computed(() => {
  if (selection.value.kind !== "sound") return undefined;
  const id = selection.value.id;
  return sounds.value.find((s) => s.id === id);
});

const selectedSoundGridFit = computed(() => {
  const s = selectedSound.value;
  if (!s) return undefined;
  return gridFit.value.find((g) => g.soundId === s.id);
});

const selectionPanelTitle = computed(() => {
  if (selection.value.kind === "beat" && selectedBeat.value) return "Beat · Fine-Tune";
  if (selection.value.kind === "unbeat" && selectedUnbeat.value) return "Unbeat · Fine-Tune";
  if (selection.value.kind === "sound" && selectedSound.value) return "Sound";
  if (selection.value.kind === "range" && activeRange.value) return "Range";
  if (selectedSegment.value) {
    const idx = segments.value.findIndex((s) => s.id === selectedSegment.value?.id);
    return idx >= 0 ? `Segment ${idx + 1} of ${segments.value.length}` : "Segment";
  }
  return "Selection";
});

const devicePxMs = computed(() => view.value.msPerPx / Math.max(1, devicePixelRatio.value));
const zoomLabel = computed(() => {
  const msPerPx = devicePxMs.value;
  if (msPerPx >= 0.1) return `${msPerPx.toFixed(msPerPx < 1 ? 2 : 1)} ms/px`;
  const pxPerSample = 1000 / sourceSampleRate.value / msPerPx;
  return `${pxPerSample.toFixed(1)} px/smp`;
});

const counterSubText = computed(() => {
  if (activeRange.value && activeRange.value.t1 > activeRange.value.t0) {
    return formatSecSpan(activeRange.value.t0, activeRange.value.t1, 1);
  }
  return `n ${nearestSample(playheadMs.value, sourceSampleRate.value)}`;
});

const toolbarStatus = computed(() => {
  if (error.value) return { tone: "error", text: "Attention" };
  if (openingSong.value || loadingWorkspace.value || audioState.value === "loading") {
    return { tone: "warn", text: "Analyzing…" };
  }
  if (auditionRendering.value) {
    return { tone: "warn", text: "Rendering filter…" };
  }
  if (recomputing.value || updatingEdit.value) {
    return { tone: "warn", text: "Updating…" };
  }
  if (activeSongSummary.value?.ready) {
    return { tone: "ready", text: "Ready" };
  }
  if (sessionPayload.value) {
    return { tone: "ready", text: "Saved" };
  }
  return { tone: "idle", text: "Ready" };
});

const workspaceFolderName = computed(() => {
  if (!workspaceDir.value) return "";
  return workspaceDir.value.split(/[\\/]/).filter(Boolean).at(-1) ?? workspaceDir.value;
});

const isRangeAllKept = computed(() => {
  const r = activeRange.value;
  if (!r || segments.value.length === 0) return false;
  const overlapping = segments.value.filter((s) => s.t1 > r.t0 && s.t0 < r.t1);
  if (overlapping.length === 0) return false;
  return overlapping.every((s) => {
    if (s.kept) return true;
    const covBegin = Math.max(s.t0, r.t0);
    const covEnd = Math.min(s.t1, r.t1);
    return spans.value.some(
      (sp) =>
        sp.segmentId === s.id &&
        sp.kind === "keep" &&
        sp.t0 <= covBegin + 1e-4 &&
        sp.t1 >= covEnd - 1e-4,
    );
  });
});

const isRangeAllFree = computed(() => {
  const r = activeRange.value;
  if (!r || segments.value.length === 0) return false;
  const overlapping = segments.value.filter((s) => s.t1 > r.t0 && s.t0 < r.t1);
  if (overlapping.length === 0) return false;
  return overlapping.every((s) => {
    if (s.regime === "free") return true;
    const covBegin = Math.max(s.t0, r.t0);
    const covEnd = Math.min(s.t1, r.t1);
    return spans.value.some(
      (sp) =>
        sp.segmentId === s.id &&
        sp.kind === "free" &&
        sp.t0 <= covBegin + 1e-4 &&
        sp.t1 >= covEnd - 1e-4,
    );
  });
});

watch([activeBeatTimesMs, () => preferences.value.clicks, abComparing], syncClicks);

function syncClicks() {
  if (!engine) return;
  const shouldClick = preferences.value.clicks || abComparing.value;
  engine.setClicks(shouldClick ? activeBeatTimesMs.value : null);
}

// Switch between Mix and filtered Audition buffers seamlessly without interrupting playback!
watch(
  [subMode, auditionFilter],
  () => {
    if (subMode.value !== "audition") {
      abortAuditionPrefetch();
    }
    void syncAuditionBuffer();
  },
  { flush: "sync" },
);

function sliceCacheKey(
  epoch: number,
  songId: string,
  filter: AuditionFilter,
  t0: number,
  t1: number,
): string {
  return `${epoch}:${songId}:${filter}:${t0}:${t1}`;
}

function abortAuditionPrefetch() {
  clearTimeout(auditionPrefetchTimer);
  auditionPrefetchTimer = undefined;
  stopPrefetchAfterCurrent = false;
  inflightPrefetchSlice = null;
  auditionPrefetchAbort?.abort();
  auditionPrefetchAbort = null;
}

function clearAuditionSongMemory() {
  abortAuditionPrefetch();
  auditionSliceCache.clear();
  auditionAnchorWindow = null;
  workingAuditionChannels = null;
  patchedAuditionSpan = null;
}

function isAnchorWindowReusable(
  anchor: AuditionAnchorWindow | null,
  songId: string,
  playheadSec: number,
  forwardBias: boolean,
): anchor is AuditionAnchorWindow {
  if (!anchor || anchor.songId !== songId) return false;
  const dur = Math.max(0.1, durationSec.value);
  if (dur <= 60) {
    return Math.abs(anchor.startSec) < 1e-6 && Math.abs(anchor.endSec - dur) < 1e-3;
  }
  if (anchor.endSec <= anchor.startSec || anchor.endSec > dur + 1e-3) return false;
  if (playheadSec < anchor.startSec || playheadSec >= anchor.endSec) return false;
  const reachesEnd = anchor.endSec >= dur - 1e-3;
  if (!reachesEnd && anchor.endSec - playheadSec <= 5.0) return false;

  if (!forwardBias) {
    const r = activeRange.value;
    if (r && r.t1 > r.t0 && r.t1 - r.t0 <= 60 && playheadSec >= r.t0 && playheadSec < r.t1) {
      if (anchor.startSec > r.t0 + 1e-4 || anchor.endSec < r.t1 - 1e-4) return false;
    }
    const loopStartSec = loopRegion.value.startMs / 1000;
    const loopEndSec = loopRegion.value.endMs / 1000;
    if (
      looping.value &&
      loopEndSec > loopStartSec &&
      loopEndSec - loopStartSec <= 60 &&
      playheadSec >= loopStartSec &&
      playheadSec < loopEndSec
    ) {
      if (anchor.startSec > loopStartSec + 1e-4 || anchor.endSec < loopEndSec - 1e-4) {
        return false;
      }
    }
  }
  return true;
}

function resolveAuditionWindow(
  songId: string,
  playheadSec: number,
  forwardBias: boolean,
): Range {
  if (isAnchorWindowReusable(auditionAnchorWindow, songId, playheadSec, forwardBias)) {
    return { t0: auditionAnchorWindow.startSec, t1: auditionAnchorWindow.endSec };
  }
  const win = computeAuditionWindow({
    durationSec: durationSec.value,
    playheadSec,
    activeRange: activeRange.value,
    looping: looping.value,
    loopStartSec: loopRegion.value.startMs / 1000,
    loopEndSec: loopRegion.value.endMs / 1000,
    ...(forwardBias ? { forwardBias: true } : {}),
  });
  auditionAnchorWindow = { songId, startSec: win.t0, endSec: win.t1 };
  return win;
}

function applyDecodedAuditionSlice(
  songId: string,
  targetFilter: AuditionFilter,
  win: Range,
  slice: DecodedAuditionSlice,
  engineKey: string,
) {
  if (!engine || !mixChannels) return;
  const numCh = mixChannels.length;
  if (
    !workingAuditionChannels ||
    workingAuditionChannels.length !== numCh ||
    (workingAuditionChannels[0]?.length ?? 0) !== mixFrames
  ) {
    workingAuditionChannels = mixChannels.map((ch) => Float32Array.from(ch));
    patchedAuditionSpan = null;
  } else if (patchedAuditionSpan) {
    const { startFrame: prevStart, endFrame: prevEnd } = patchedAuditionSpan;
    for (let c = 0; c < numCh; c += 1) {
      const dst = workingAuditionChannels[c];
      const orig = mixChannels[c];
      if (!dst || !orig) continue;
      const r0 = Math.max(0, Math.min(orig.length, prevStart));
      const r1 = Math.max(r0, Math.min(orig.length, prevEnd));
      if (r1 > r0) {
        dst.set(orig.subarray(r0, r1), r0);
      }
    }
    patchedAuditionSpan = null;
  }

  const startFrame = Math.max(0, slice.startFrame);
  let maxEndFrame = startFrame;
  for (let c = 0; c < numCh; c += 1) {
    const dst = workingAuditionChannels[c];
    const src = slice.channels[Math.min(c, slice.channels.length - 1)];
    if (!dst || !src) continue;
    const copyLen = Math.min(src.length, Math.max(0, dst.length - startFrame));
    if (copyLen > 0) {
      dst.set(src.subarray(0, copyLen), startFrame);
      maxEndFrame = Math.max(maxEndFrame, startFrame + copyLen);
    }
  }
  patchedAuditionSpan = maxEndFrame > startFrame ? { startFrame, endFrame: maxEndFrame } : null;

  const splicedBuffer = engine.createBuffer(workingAuditionChannels, mixFrames);
  engine.swapBuffer(splicedBuffer);
  activeEngineFilterKey = engineKey;
  activeAuditionWindow.value = {
    songId,
    filter: targetFilter,
    startSec: win.t0,
    endSec: win.t1,
  };
  syncClicks();
}

async function fetchAndDecodeAuditionSlice(
  capturedEpoch: number,
  songId: string,
  filter: AuditionFilter,
  win: Range,
  targetEngine: StageAudioEngine,
  signal: AbortSignal,
): Promise<DecodedAuditionSlice | null> {
  const rawSlice = await fetchAuditionAudio(
    songId,
    { t0: win.t0, t1: win.t1, filter },
    signal,
  );
  if (
    signal.aborted ||
    disposed ||
    capturedEpoch !== songEpoch ||
    selectedSongId.value !== songId ||
    loadedSongId.value !== songId ||
    engine !== targetEngine
  ) {
    return null;
  }
  const decoded = await decodeBytesToChannels(rawSlice.bytes, targetEngine.context);
  if (
    signal.aborted ||
    disposed ||
    capturedEpoch !== songEpoch ||
    selectedSongId.value !== songId ||
    loadedSongId.value !== songId ||
    engine !== targetEngine
  ) {
    return null;
  }
  const startFrame =
    rawSlice.startSample !== null && rawSlice.sampleRate !== null && rawSlice.sampleRate > 0
      ? targetEngine.sampleRate === rawSlice.sampleRate
        ? rawSlice.startSample
        : Math.round((rawSlice.startSample * targetEngine.sampleRate) / rawSlice.sampleRate)
      : Math.max(0, Math.round(win.t0 * targetEngine.sampleRate));
  const byteLength = decoded.channels.reduce((sum, ch) => sum + ch.byteLength, 0);
  const entry: DecodedAuditionSlice = {
    startFrame,
    channels: decoded.channels,
    sampleRate: targetEngine.sampleRate,
    byteLength,
  };
  auditionSliceCache.set(sliceCacheKey(capturedEpoch, songId, filter, win.t0, win.t1), entry);
  return entry;
}

function scheduleAuditionPrefetch(nextWinHint?: Range) {
  if (
    disposed ||
    subMode.value !== "audition" ||
    !preferences.value.cacheAuditionFilters ||
    auditionRendering.value ||
    !isSongReadyForActions.value ||
    audioState.value !== "ready"
  ) {
    return;
  }
  if (auditionPrefetchAbort && !nextWinHint) {
    return;
  }
  if (auditionPrefetchTimer !== undefined && !nextWinHint) {
    return;
  }
  clearTimeout(auditionPrefetchTimer);
  auditionPrefetchTimer = setTimeout(() => {
    auditionPrefetchTimer = undefined;
    void runAuditionPrefetch(nextWinHint);
  }, 15);
}

async function runAuditionPrefetch(nextWinHint?: Range) {
  if (
    disposed ||
    subMode.value !== "audition" ||
    !preferences.value.cacheAuditionFilters ||
    auditionRendering.value ||
    !isSongReadyForActions.value ||
    audioState.value !== "ready" ||
    !engine ||
    !mixChannels
  ) {
    return;
  }
  if (auditionPrefetchAbort) {
    if (!nextWinHint) return;
    abortAuditionPrefetch();
  }

  const songId = loadedSongId.value;
  if (!songId || songId !== selectedSongId.value) return;
  const capturedEpoch = songEpoch;
  const targetEngine = engine;
  const curFilter = auditionFilter.value;

  const tasks: Array<{ filter: AuditionFilter; win: Range; key: string }> = [];
  if (nextWinHint && curFilter !== "mix") {
    const nextKey = sliceCacheKey(capturedEpoch, songId, curFilter, nextWinHint.t0, nextWinHint.t1);
    if (!auditionSliceCache.has(nextKey)) {
      tasks.push({ filter: curFilter, win: nextWinHint, key: nextKey });
    }
  } else {
    const curWin =
      activeAuditionWindow.value && activeAuditionWindow.value.songId === songId
        ? { t0: activeAuditionWindow.value.startSec, t1: activeAuditionWindow.value.endSec }
        : resolveAuditionWindow(songId, shownPlayheadMs() / 1000, false);
    const baseOrder: AuditionFilter[] =
      curFilter === "low" || curFilter === "mid" || curFilter === "high"
        ? ["low", "mid", "high", "percussive", "harmonic"]
        : ["percussive", "harmonic", "low", "mid", "high"];
    const orderedFilters: AuditionFilter[] =
      curFilter !== "mix"
        ? [curFilter, ...baseOrder.filter((f) => f !== curFilter)]
        : baseOrder;

    const approxSliceBytes = Math.max(
      1,
      Math.round((curWin.t1 - curWin.t0) * targetEngine.sampleRate) * mixChannels.length * 4,
    );
    const maxWarmCount = Math.min(
      orderedFilters.length,
      Math.max(1, Math.floor(auditionSliceCache.maxBytes / approxSliceBytes)),
    );
    for (const f of orderedFilters.slice(0, maxWarmCount)) {
      const key = sliceCacheKey(capturedEpoch, songId, f, curWin.t0, curWin.t1);
      if (!auditionSliceCache.has(key)) {
        tasks.push({ filter: f, win: curWin, key });
      }
    }
  }

  if (tasks.length === 0) return;

  const controller = new AbortController();
  auditionPrefetchAbort = controller;
  stopPrefetchAfterCurrent = false;

  try {
    for (const task of tasks) {
      if (
        controller.signal.aborted ||
        stopPrefetchAfterCurrent ||
        disposed ||
        capturedEpoch !== songEpoch ||
        selectedSongId.value !== songId ||
        loadedSongId.value !== songId ||
        subMode.value !== "audition" ||
        !preferences.value.cacheAuditionFilters ||
        auditionRendering.value
      ) {
        break;
      }
      if (auditionSliceCache.has(task.key)) continue;
      const slicePromise = fetchAndDecodeAuditionSlice(
        capturedEpoch,
        songId,
        task.filter,
        task.win,
        targetEngine,
        controller.signal,
      );
      inflightPrefetchSlice = { key: task.key, promise: slicePromise };
      try {
        await slicePromise;
      } finally {
        if (inflightPrefetchSlice?.promise === slicePromise) {
          inflightPrefetchSlice = null;
        }
      }
      if (stopPrefetchAfterCurrent) break;
    }
  } catch {
    // Background pre-warm errors or aborts never disturb foreground UI state.
  } finally {
    if (auditionPrefetchAbort === controller) {
      auditionPrefetchAbort = null;
      stopPrefetchAfterCurrent = false;
    }
  }
}

function toggleCacheAuditionFilters() {
  preferences.value.cacheAuditionFilters = !preferences.value.cacheAuditionFilters;
  savePreferences();
  if (preferences.value.cacheAuditionFilters) {
    scheduleAuditionPrefetch();
  } else {
    abortAuditionPrefetch();
  }
}

async function decodeBytesToChannels(
  bytes: ArrayBuffer,
  targetContext: AudioContext,
): Promise<{ channels: Float32Array[]; frames: number; sampleRate: number }> {
  const decoded = await targetContext.decodeAudioData(bytes.slice(0));
  const chs = Array.from({ length: decoded.numberOfChannels }, (_, c) =>
    Float32Array.from(decoded.getChannelData(c)),
  );
  return {
    channels: chs,
    frames: decoded.length,
    sampleRate: decoded.sampleRate,
  };
}

async function ensureEngine(preferredRate: number): Promise<StageAudioEngine> {
  if (engine && engine.sampleRate === preferredRate) return engine;
  if (engine) {
    await engine.close();
    engine = undefined;
  }
  let created: StageAudioEngine;
  try {
    created = new StageAudioEngine(preferredRate);
  } catch {
    created = new StageAudioEngine(48_000);
  }
  created.onEnded = (positionMs) => {
    clearTimeout(transportTimer);
    playing.value = false;
    motion.value = undefined;
    playheadMs.value = clampToBounds(positionMs);
  };
  created.setVolume(preferences.value.volume);
  created.setClickVolume(preferences.value.clickVolume);
  engine = created;
  return created;
}

async function loadSongAudio(
  songId: string,
  preferredRate: number,
  capturedEpoch: number,
  signal: AbortSignal,
) {
  audioState.value = "loading";
  auditionAbort?.abort();
  auditionAbort = null;
  inFlightAuditionTarget = null;
  auditionRendering.value = false;
  activeAuditionWindow.value = null;
  clearAuditionSongMemory();
  activeEngineFilterKey = "mix";
  try {
    const bytes = await fetchSongAudioBytes(songId, signal);
    if (
      signal.aborted ||
      disposed ||
      capturedEpoch !== songEpoch ||
      selectedSongId.value !== songId
    ) {
      return;
    }
    const eng = await ensureEngine(preferredRate);
    if (
      signal.aborted ||
      disposed ||
      capturedEpoch !== songEpoch ||
      selectedSongId.value !== songId
    ) {
      return;
    }
    const decoded = await decodeBytesToChannels(bytes, eng.context);
    if (
      signal.aborted ||
      disposed ||
      capturedEpoch !== songEpoch ||
      selectedSongId.value !== songId
    ) {
      return;
    }
    mixChannels = decoded.channels;
    mixFrames = decoded.frames;
    const loaded = eng.load(decoded.channels, decoded.frames);
    mixBuffer.value = loaded;
    syncClicks();
    silenceMs.value = nearSilence(
      decoded.channels,
      loaded.sampleRate,
      0,
      Math.min(bounds.value.endMs, (decoded.frames * 1000) / loaded.sampleRate),
    );
    audioState.value = "ready";
    audioLoadSettledForSongId.value = songId;
    if (subMode.value === "audition") {
      if (auditionFilter.value !== "mix") {
        void syncAuditionBuffer();
      } else if (preferences.value.cacheAuditionFilters) {
        scheduleAuditionPrefetch();
      }
    }
  } catch (cause) {
    if (isAbortError(cause) || signal.aborted || capturedEpoch !== songEpoch) return;
    audioState.value = "none";
    if (selectedSongId.value === songId) {
      audioLoadSettledForSongId.value = songId;
    }
    reportError(cause);
  }
}

function maybeRefreshAuditionWindow(anchorSec: number, forwardBias = false) {
  if (
    subMode.value !== "audition" ||
    !isSongReadyForActions.value ||
    audioState.value !== "ready"
  ) {
    return;
  }
  const songId = loadedSongId.value;
  if (!songId) return;
  if (auditionFilter.value === "mix") {
    if (
      !forwardBias &&
      preferences.value.cacheAuditionFilters &&
      !isAnchorWindowReusable(auditionAnchorWindow, songId, anchorSec, false)
    ) {
      abortAuditionPrefetch();
      resolveAuditionWindow(songId, anchorSec, false);
      scheduleAuditionPrefetch();
    }
    return;
  }
  const cur = activeAuditionWindow.value;
  const outsideCurrent =
    !cur ||
    cur.songId !== songId ||
    cur.filter !== auditionFilter.value ||
    anchorSec < cur.startSec ||
    anchorSec >= cur.endSec;
  const nearingEdge =
    forwardBias &&
    cur !== null &&
    cur.songId === songId &&
    cur.filter === auditionFilter.value &&
    anchorSec >= cur.startSec &&
    anchorSec < cur.endSec &&
    cur.endSec < durationSec.value - 1e-3 &&
    cur.endSec - anchorSec <= 5.0;

  if (!outsideCurrent && !nearingEdge) {
    if (
      forwardBias &&
      preferences.value.cacheAuditionFilters &&
      cur !== null &&
      cur.songId === songId &&
      cur.filter === auditionFilter.value &&
      cur.endSec < durationSec.value - 1e-3 &&
      cur.endSec - anchorSec <= 12.0
    ) {
      const nextWin = computeAuditionWindow({
        durationSec: durationSec.value,
        playheadSec: Math.max(anchorSec, cur.endSec - 5),
        activeRange: activeRange.value,
        looping: looping.value,
        loopStartSec: loopRegion.value.startMs / 1000,
        loopEndSec: loopRegion.value.endMs / 1000,
        forwardBias: true,
      });
      const nextKey = sliceCacheKey(songEpoch, songId, auditionFilter.value, nextWin.t0, nextWin.t1);
      if (!auditionSliceCache.has(nextKey) && inflightPrefetchSlice?.key !== nextKey) {
        scheduleAuditionPrefetch(nextWin);
      }
    }
    return;
  }

  if (
    inFlightAuditionTarget &&
    inFlightAuditionTarget.songId === songId &&
    inFlightAuditionTarget.filter === auditionFilter.value &&
    anchorSec >= inFlightAuditionTarget.startSec &&
    (anchorSec < inFlightAuditionTarget.endSec - 5.0 ||
      inFlightAuditionTarget.endSec >= durationSec.value - 1e-3)
  ) {
    return;
  }

  void syncAuditionBuffer({ anchorSec, forwardBias: forwardBias || nearingEdge });
}

async function syncAuditionBuffer(options?: { anchorSec?: number; forwardBias?: boolean }) {
  const songId = loadedSongId.value;
  const capturedEpoch = songEpoch;
  if (
    !engine ||
    !mixChannels ||
    !mixBuffer.value ||
    !songId ||
    songId !== selectedSongId.value ||
    audioState.value !== "ready"
  ) {
    return;
  }

  const targetFilter: AuditionFilter =
    subMode.value === "audition" ? auditionFilter.value : "mix";

  if (targetFilter === "mix") {
    auditionAbort?.abort();
    auditionAbort = null;
    inFlightAuditionTarget = null;
    auditionRendering.value = false;
    activeAuditionWindow.value = null;
    if (activeEngineFilterKey !== "mix") {
      engine.swapBuffer(mixBuffer.value);
      activeEngineFilterKey = "mix";
      syncClicks();
    }
    if (subMode.value === "audition" && preferences.value.cacheAuditionFilters) {
      scheduleAuditionPrefetch();
    }
    return;
  }

  const playheadSec = options?.anchorSec ?? shownPlayheadMs() / 1000;
  const win = resolveAuditionWindow(songId, playheadSec, Boolean(options?.forwardBias));

  const engineKey = sliceCacheKey(capturedEpoch, songId, targetFilter, win.t0, win.t1);
  if (activeEngineFilterKey === engineKey) {
    if (preferences.value.cacheAuditionFilters) {
      scheduleAuditionPrefetch();
    }
    return;
  }

  const cachedSlice = auditionSliceCache.get(engineKey);
  if (cachedSlice && cachedSlice.sampleRate === engine.sampleRate) {
    auditionAbort?.abort();
    auditionAbort = null;
    inFlightAuditionTarget = null;
    auditionRendering.value = false;
    applyDecodedAuditionSlice(songId, targetFilter, win, cachedSlice, engineKey);
    if (preferences.value.cacheAuditionFilters) {
      scheduleAuditionPrefetch();
    }
    return;
  }

  if (
    auditionAbort &&
    !auditionAbort.signal.aborted &&
    inFlightAuditionTarget &&
    inFlightAuditionTarget.songId === songId &&
    inFlightAuditionTarget.filter === targetFilter &&
    Math.abs(inFlightAuditionTarget.startSec - win.t0) < 1e-6 &&
    Math.abs(inFlightAuditionTarget.endSec - win.t1) < 1e-6
  ) {
    return;
  }

  auditionAbort?.abort();
  const controller = new AbortController();
  auditionAbort = controller;
  inFlightAuditionTarget = {
    songId,
    filter: targetFilter,
    startSec: win.t0,
    endSec: win.t1,
  };
  auditionRendering.value = true;

  const joinedPrefetch =
    inflightPrefetchSlice?.key === engineKey ? inflightPrefetchSlice.promise : null;
  let onForegroundAbort: (() => void) | null = null;
  if (joinedPrefetch) {
    clearTimeout(auditionPrefetchTimer);
    auditionPrefetchTimer = undefined;
    stopPrefetchAfterCurrent = true;
    onForegroundAbort = () => abortAuditionPrefetch();
    controller.signal.addEventListener("abort", onForegroundAbort, { once: true });
  } else {
    abortAuditionPrefetch();
  }

  try {
    const decodedEntry = joinedPrefetch
      ? await joinedPrefetch
      : await fetchAndDecodeAuditionSlice(
          capturedEpoch,
          songId,
          targetFilter,
          win,
          engine,
          controller.signal,
        );
    if (
      !decodedEntry ||
      controller.signal.aborted ||
      disposed ||
      capturedEpoch !== songEpoch ||
      selectedSongId.value !== songId ||
      loadedSongId.value !== songId ||
      !engine ||
      !mixChannels
    ) {
      return;
    }
    const liveTargetFilter: AuditionFilter =
      subMode.value === "audition" ? auditionFilter.value : "mix";
    if (liveTargetFilter !== targetFilter) return;

    applyDecodedAuditionSlice(songId, targetFilter, win, decodedEntry, engineKey);
  } catch (cause) {
    if (isAbortError(cause) || controller.signal.aborted || capturedEpoch !== songEpoch) return;
    reportError(cause);
  } finally {
    if (onForegroundAbort) {
      controller.signal.removeEventListener("abort", onForegroundAbort);
    }
    if (auditionAbort === controller) {
      auditionAbort = null;
      inFlightAuditionTarget = null;
      auditionRendering.value = false;
      if (
        !disposed &&
        capturedEpoch === songEpoch &&
        subMode.value === "audition" &&
        preferences.value.cacheAuditionFilters
      ) {
        scheduleAuditionPrefetch();
      }
    }
  }
}

function reportError(cause: unknown) {
  const raw = cause instanceof Error ? cause.message : String(cause);
  error.value = sanitizeUserFacingText(raw);
}

function clearSnapState() {
  localSnapSeq += 1;
  clearTimeout(snapDebounceTimer);
  snapDebounceTimer = undefined;
  snapsAbort?.abort();
  snapsAbort = null;
  snapsLoading.value = false;
  snapState.value = null;
}

function enqueueHoldRequest(
  songId: string,
  hold: boolean,
  onResult?: (res: TempoHoldOffersResponse) => void,
): Promise<void> {
  const wsDir = workspaceDir.value;
  const prev = holdChains.get(songId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const res = await setHoldOffers(songId, hold, undefined, wsDir);
      onResult?.(res);
    });
  const tracked = next.catch(() => {});
  holdChains.set(songId, tracked);
  tracked.finally(() => {
    if (holdChains.get(songId) === tracked) {
      holdChains.delete(songId);
    }
  });
  return next;
}

function releaseHoldOwnerSynchronously() {
  const owner = holdOwnerSongId;
  holdingAlt.value = false;
  holdOwnerSongId = null;
  if (owner) {
    void enqueueHoldRequest(owner, false).catch(() => {});
  }
}

function resetActiveSongContext() {
  releaseHoldOwnerSynchronously();
  songEpoch += 1;
  appliedLastSeq = -1;

  songOpenAbort?.abort();
  songOpenAbort = null;
  recomputeAbort?.abort();
  recomputeAbort = null;
  auditionAbort?.abort();
  auditionAbort = null;
  inFlightAuditionTarget = null;
  auditionRendering.value = false;
  activeAuditionWindow.value = null;
  clearAuditionSongMemory();
  clearSnapState();

  stop();
  engine?.unload();
  mixBuffer.value = undefined;
  mixChannels = null;
  mixFrames = 0;
  silenceMs.value = undefined;
  audioState.value = "none";
  audioLoadSettledForSongId.value = null;
  activeEngineFilterKey = "mix";
  flamSavedState.value = null;

  loadedSongId.value = null;
  sessionPayload.value = null;
  openingSong.value = false;
  recomputing.value = false;
  exportingFormat.value = null;
  inFlightEditCount.value = 0;
  queuedEntityNudges.clear();
  pendingEntityTimeSec.clear();
  inFlightPlacedBeats.clear();

  selection.value = { kind: "none" };
  activeRange.value = null;
  rangeStartCursorSec.value = null;
  rangeEndCursorSec.value = null;
  hoverTimeMs.value = undefined;
}

function syncSummaryIntoSongsList(summary: TempoSongSummary) {
  const idx = songs.value.findIndex((s) => s.songId === summary.songId);
  if (idx >= 0) {
    const next = songs.value.slice();
    next[idx] = summary;
    songs.value = next;
  } else {
    songs.value = [...songs.value, summary];
  }
}

function applyPayload(payload: TempoSongSessionPayload, options?: { checkLocalInvalidation?: boolean }) {
  if (
    loadedSongId.value === payload.song.songId &&
    sessionPayload.value?.song.songId === payload.song.songId &&
    payload.state.lastSeq < appliedLastSeq
  ) {
    return;
  }
  appliedLastSeq = payload.state.lastSeq;

  const prevValidLocalCount =
    sessionPayload.value?.state.offers.filter(
      (o) => o.scopeKind === "local" && (o.status === "valid" || o.status === "stale"),
    ).length ?? 0;

  sessionPayload.value = payload;
  syncSummaryIntoSongsList(payload.songSummary);

  if (options?.checkLocalInvalidation) {
    const nextOffers = payload.state.offers;
    const hasInvalidLocal = nextOffers.some(
      (o) => o.scopeKind === "local" && o.status === "invalid",
    );
    const hasValidOther = nextOffers.some(
      (o) => o.scopeKind !== "local" && (o.status === "valid" || o.status === "stale"),
    );
    if ((hasInvalidLocal || prevValidLocalCount > 0) && hasValidOther) {
      const nextValidLocal = nextOffers.filter(
        (o) => o.scopeKind === "local" && (o.status === "valid" || o.status === "stale"),
      ).length;
      if (hasInvalidLocal || nextValidLocal < prevValidLocalCount) {
        notice.value =
          "Local suggestion skipped because that passage was edited; suggestions for other sections remain ready.";
      }
    }
  }
}

async function initializeWorkspace() {
  loadingWorkspace.value = true;
  error.value = "";
  try {
    const search = new URLSearchParams(window.location.search);
    const dirQuery = search.get("dir") ?? undefined;
    const stateDirQuery = search.get("stateDir") ?? undefined;
    const ws = await fetchWorkspace(
      dirQuery || stateDirQuery
        ? {
            ...(dirQuery ? { dir: dirQuery } : {}),
            ...(stateDirQuery ? { stateDir: stateDirQuery } : {}),
          }
        : undefined,
    );
    if (disposed) return;
    workspaceDir.value = ws.workspaceDir;
    setClientWorkspaceDir(ws.workspaceDir);
    folderPathInput.value = ws.workspaceDir ?? "";
    songs.value = ws.songs;
    const initialSong = ws.activeSongId ?? ws.songs[0]?.songId ?? null;
    if (initialSong) {
      await selectSong(initialSong);
    }
  } catch (cause) {
    if (!isAbortError(cause)) reportError(cause);
  } finally {
    loadingWorkspace.value = false;
  }
}

async function handleOpenFolder() {
  const dir = folderPathInput.value.trim();
  if (!dir) return;
  resetActiveSongContext();
  selectedSongId.value = null;
  loadingWorkspace.value = true;
  error.value = "";
  folderMenuOpen.value = false;
  try {
    const ws = await openWorkspaceFolder(dir);
    if (disposed) return;
    workspaceDir.value = ws.workspaceDir;
    setClientWorkspaceDir(ws.workspaceDir);
    songs.value = ws.songs;
    const url = new URL(window.location.href);
    if (ws.workspaceDir) url.searchParams.set("dir", ws.workspaceDir);
    window.history.replaceState({}, "", url.toString());
    const targetSong = ws.activeSongId ?? ws.songs[0]?.songId ?? null;
    if (targetSong) {
      await selectSong(targetSong);
    } else {
      selectedSongId.value = null;
      loadedSongId.value = null;
      sessionPayload.value = null;
    }
  } catch (cause) {
    reportError(cause);
  } finally {
    loadingWorkspace.value = false;
  }
}

function triggerImportPicker() {
  fileInputRef.value?.click();
}

async function onImportFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement | null;
  const fileList = input?.files ? Array.from(input.files) : [];
  if (input) input.value = "";
  if (fileList.length === 0) return;

  loadingWorkspace.value = true;
  error.value = "";
  try {
    // Do NOT pass `?dir=` when uploading into an already-open workspace so custom stateDir is preserved;
    // send `X-Tempo-Workspace-Dir` header when workspaceDir is non-empty to guard against multi-tab switches!
    const uploaded = await uploadAudioFiles(fileList, {
      workspaceDir: workspaceDir.value,
    });
    if (disposed) return;
    workspaceDir.value = uploaded.workspaceDir;
    setClientWorkspaceDir(uploaded.workspaceDir);
    folderPathInput.value = uploaded.workspaceDir ?? "";
    songs.value = uploaded.songs;
    const nextId = uploaded.songId ?? uploaded.activeSongId ?? uploaded.songs[0]?.songId ?? null;
    if (nextId) {
      await selectSong(nextId);
    }
  } catch (cause) {
    reportError(cause);
  } finally {
    loadingWorkspace.value = false;
  }
}

async function selectSong(songId: string) {
  resetActiveSongContext();

  const capturedEpoch = songEpoch;
  const controller = new AbortController();
  songOpenAbort = controller;
  selectedSongId.value = songId;
  openingSong.value = true;
  error.value = "";
  notice.value = "";
  cuesDirty.value = false;

  try {
    const payload = await openSongSession(songId, controller.signal);
    if (
      controller.signal.aborted ||
      disposed ||
      capturedEpoch !== songEpoch ||
      selectedSongId.value !== songId
    ) {
      return;
    }
    applyPayload(payload);
    loadedSongId.value = songId;
    playheadMs.value = 0;
    const durMs = Math.max(1000, payload.state.durationSec * 1000);
    loopRegion.value = { startMs: 0, endMs: Math.min(durMs, 16_000) };
    looping.value = false;
    fitPending = true;
    if (stageWidth.value > 0) fitWholeSong();
    const targetRate = payload.state.audio?.sampleRate ?? 44_100;
    await loadSongAudio(songId, targetRate, capturedEpoch, controller.signal);
  } catch (cause) {
    if (isAbortError(cause) || controller.signal.aborted || capturedEpoch !== songEpoch) return;
    reportError(cause);
  } finally {
    if (songOpenAbort === controller && capturedEpoch === songEpoch) {
      openingSong.value = false;
    }
  }
}

// Stage view & zoom
function onStageResize(width: number, dpr: number) {
  stageWidth.value = Math.max(1, width);
  devicePixelRatio.value = dpr || 1;
  if (fitPending && durationSec.value > 0) fitWholeSong();
  else setView(view.value);
}

function setView(next: TimeView) {
  if (stageWidth.value <= 0 || durationSec.value <= 0) {
    view.value = next;
    return;
  }
  view.value = clampView(
    next,
    bounds.value,
    stageWidth.value,
    zoomLimits(bounds.value, stageWidth.value, sourceSampleRate.value, devicePixelRatio.value),
  );
}

function fitWholeSong() {
  if (stageWidth.value <= 0 || durationSec.value <= 0) return;
  fitPending = false;
  if (activeRange.value && activeRange.value.t1 > activeRange.value.t0) {
    const padSec = Math.max(0.5, (activeRange.value.t1 - activeRange.value.t0) * 0.12);
    setView(
      fitView(
        {
          startMs: Math.max(0, (activeRange.value.t0 - padSec) * 1000),
          endMs: Math.min(bounds.value.endMs, (activeRange.value.t1 + padSec) * 1000),
        },
        stageWidth.value,
      ),
    );
    return;
  }
  // Show a comfortable initial 24s window on long songs, or full song if shorter.
  const initialEndMs = Math.min(bounds.value.endMs, 24_000);
  setView(fitView({ startMs: 0, endMs: initialEndMs }, stageWidth.value));
}

function zoomAnchorMs(): number {
  if (selectedBeat.value) return selectedBeat.value.timeSec * 1000;
  if (selectedUnbeat.value) return selectedUnbeat.value.timeSec * 1000;
  if (selectedSound.value) return selectedSound.value.timeSec * 1000;
  return shownPlayheadMs();
}

function zoom(factor: number) {
  setView(zoomAt(view.value, zoomAnchorMs(), factor));
}

function toggleFineZoom() {
  const fine = fineMsPerDevicePx * devicePixelRatio.value;
  if (view.value.msPerPx > fine * 1.05) {
    const anchor = zoomAnchorMs();
    setView({ startMs: anchor - (stageWidth.value / 2) * fine, msPerPx: fine });
  } else {
    fitWholeSong();
  }
}

function bringIntoView(timeMs: number) {
  if (stageWidth.value <= 0) return;
  const x = msToX(view.value, timeMs);
  if (x < 0 || x > stageWidth.value) {
    setView(placeAt(view.value, timeMs, stageWidth.value, 0.35));
  }
}

// Transport & playback
function clampToBounds(timeMs: number): number {
  return Math.min(bounds.value.endMs, Math.max(bounds.value.startMs, timeMs));
}

function shownPlayheadMs(): number {
  if (!playing.value || !engine) return playheadMs.value;
  return engine.shownAt(performance.now(), 0) ?? playheadMs.value;
}

async function startPlayback(fromMs: number, endMs: number, loop: boolean) {
  if (!engine || audioState.value !== "ready") return;
  error.value = "";
  try {
    const started = await engine.play({
      fromMs: prerollStart(fromMs, minimumPrerollMs),
      endMs,
      rate: rate.value,
      loop: loop ? { ...loopRegion.value } : null,
    });
    if (!started) return;
    playing.value = true;
    readoutAtMs = Number.NEGATIVE_INFINITY;
    clearTimeout(transportTimer);
    transportStep();
  } catch (cause) {
    reportError(cause);
  }
}

function transportStep() {
  transportTimer = undefined;
  if (!engine?.playing) return;
  const nowMs = performance.now();
  engine.sampleClock();
  const next = engine.motion(0);
  if (!next) motion.value = undefined;
  else if (
    needsResync(motion.value, next, nowMs) ||
    loopReanchorDue(motion.value, motionPlacedAtMs, nowMs)
  ) {
    motion.value = next;
    motionPlacedAtMs = nowMs;
  }
  const current = motion.value;
  const shownMs = current ? motionAt(current, nowMs) : engine.shownAt(nowMs, 0);
  if (shownMs !== undefined) {
    if (follow.value && stageWidth.value > 0) {
      const jump = followView(view.value, shownMs, stageWidth.value, minimumPrerollMs);
      if (jump) setView(jump);
    }
    if (!current || nowMs - readoutAtMs >= readoutIntervalMs) {
      playheadMs.value = shownMs;
      readoutAtMs = nowMs;
    }
    maybeRefreshAuditionWindow(shownMs / 1000, true);
  }
  const followAt =
    current && follow.value && stageWidth.value > 0
      ? nextFollowCheckMs(current, view.value, stageWidth.value, nowMs) + 0.5
      : Number.POSITIVE_INFINITY;
  transportTimer = setTimeout(transportStep, transportDelayMs(nowMs, followAt));
}

function stop() {
  clearTimeout(transportTimer);
  const shown = engine?.stop(0);
  if (playing.value && shown !== undefined) playheadMs.value = clampToBounds(shown);
  motion.value = undefined;
  playing.value = false;
}

function togglePlayback() {
  if (playing.value || engine?.starting) {
    stop();
    return;
  }
  const region = loopRegion.value;
  if (looping.value && region.endMs > region.startMs) {
    const inside = playheadMs.value >= region.startMs && playheadMs.value < region.endMs;
    void startPlayback(inside ? playheadMs.value : region.startMs, region.endMs, true);
  } else {
    const startFrom =
      playheadMs.value >= bounds.value.endMs - 20 ? bounds.value.startMs : playheadMs.value;
    void startPlayback(startFrom, bounds.value.endMs, false);
  }
}

function restartIfPlaying(change: () => void) {
  const wasPlaying = playing.value;
  stop();
  change();
  if (wasPlaying) togglePlayback();
}

function seek(timeMs: number) {
  restartIfPlaying(() => {
    playheadMs.value = clampToBounds(timeMs);
  });
  maybeRefreshAuditionWindow(playheadMs.value / 1000, false);
}

let locateFromMs: number | undefined;
function onLocate(timeMs: number, phase: LocatePhase) {
  const moving = playing.value || Boolean(engine?.starting);
  if (phase === "cancel") {
    if (locateFromMs !== undefined && !moving) playheadMs.value = locateFromMs;
    locateFromMs = undefined;
  } else if (phase === "move") {
    if (moving) return;
    locateFromMs ??= playheadMs.value;
    playheadMs.value = clampToBounds(timeMs);
  } else {
    locateFromMs = undefined;
    seek(timeMs);
  }
}

function toggleLoop() {
  if (!looping.value && activeRange.value && activeRange.value.t1 > activeRange.value.t0) {
    loopRegion.value = {
      startMs: activeRange.value.t0 * 1000,
      endMs: activeRange.value.t1 * 1000,
    };
  } else if (!looping.value && loopRegion.value.endMs <= loopRegion.value.startMs) {
    const seg = selectedSegment.value;
    if (seg) {
      loopRegion.value = { startMs: seg.t0 * 1000, endMs: seg.t1 * 1000 };
    }
  }
  restartIfPlaying(() => {
    looping.value = !looping.value;
  });
}

function setRate(nextRate: (typeof playbackRates)[number]) {
  restartIfPlaying(() => {
    rate.value = nextRate;
  });
}

function toggleClicks() {
  preferences.value.clicks = !preferences.value.clicks;
  savePreferences();
  syncClicks();
}

function setClickVolume(val: number) {
  preferences.value.clickVolume = Math.min(1, Math.max(0, val));
  savePreferences();
  engine?.setClickVolume(preferences.value.clickVolume);
}

function loopAroundEntity(timeSec: number) {
  const centerMs = timeSec * 1000;
  stop();
  loopRegion.value = {
    startMs: clampToBounds(centerMs - beatLoopHalfMs),
    endMs: clampToBounds(centerMs + beatLoopHalfMs),
  };
  looping.value = true;
  playheadMs.value = loopRegion.value.startMs;
  togglePlayback();
}

function toggleFlamCheck() {
  if (flamSavedState.value) {
    const prev = flamSavedState.value;
    flamSavedState.value = null;
    stop();
    rate.value = prev.rate;
    loopRegion.value = prev.loopRegion;
    looping.value = prev.looping;
    preferences.value.clicks = prev.clicks;
    savePreferences();
    syncClicks();
    return;
  }
  const anchorSec =
    selectedBeat.value?.timeSec ??
    selectedSound.value?.timeSec ??
    shownPlayheadMs() / 1000;
  flamSavedState.value = {
    rate: rate.value,
    looping: looping.value,
    loopRegion: { ...loopRegion.value },
    clicks: preferences.value.clicks,
  };
  stop();
  rate.value = 0.25;
  loopRegion.value = {
    startMs: clampToBounds((anchorSec - flamHalfSec) * 1000),
    endMs: clampToBounds((anchorSec + flamHalfSec) * 1000),
  };
  looping.value = true;
  preferences.value.clicks = true;
  savePreferences();
  syncClicks();
  playheadMs.value = loopRegion.value.startMs;
  maybeRefreshAuditionWindow(playheadMs.value / 1000, false);
  togglePlayback();
}

// Micro-assist snaps (`suggestSongSnaps` — selection-bound & zero `.jsonl` trace writes!)
function requestSnapsForBeat(beatId: string, beatTimeSec: number, debounced = true) {
  clearSnapState();
  if (!isSongReadyForActions.value) return;
  const capturedSongId = loadedSongId.value;
  const capturedEpoch = songEpoch;
  const reqSeq = ++localSnapSeq;
  if (!capturedSongId || capturedSongId !== selectedSongId.value) return;

  const run = async () => {
    if (
      disposed ||
      reqSeq !== localSnapSeq ||
      capturedEpoch !== songEpoch ||
      loadedSongId.value !== capturedSongId ||
      selection.value.kind !== "beat" ||
      selection.value.id !== beatId
    ) {
      return;
    }
    const controller = new AbortController();
    snapsAbort = controller;
    snapsLoading.value = true;
    try {
      const res = await suggestSongSnaps(
        capturedSongId,
        { timeSec: beatTimeSec, windowSec: 0.12, immediate: true },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        disposed ||
        reqSeq !== localSnapSeq ||
        capturedEpoch !== songEpoch ||
        loadedSongId.value !== capturedSongId ||
        selectedSongId.value !== capturedSongId
      ) {
        return;
      }
      const liveBeat = selectedBeat.value;
      if (
        res.status === "ok" &&
        selection.value.kind === "beat" &&
        liveBeat &&
        liveBeat.id === beatId &&
        Math.abs(liveBeat.timeSec - beatTimeSec) <= 1e-6
      ) {
        snapState.value = {
          songId: capturedSongId,
          beatId,
          beatTimeSec,
          generation: res.generation,
          candidates: res.candidates,
        };
      }
    } catch (cause) {
      if (!isAbortError(cause) && !controller.signal.aborted && reqSeq === localSnapSeq) {
        snapState.value = null;
      }
    } finally {
      if (snapsAbort === controller && reqSeq === localSnapSeq) {
        snapsLoading.value = false;
      }
    }
  };

  if (debounced) {
    snapDebounceTimer = setTimeout(() => {
      snapDebounceTimer = undefined;
      void run();
    }, 35);
  } else {
    void run();
  }
}

function handleStageSelect(next: TempoSelection) {
  clearSnapState();
  selection.value = next;
  if (next.kind !== "range") {
    activeRange.value = null;
  }
  if (next.kind === "beat" && isSongReadyForActions.value) {
    const beat = beats.value.find((b) => b.id === next.id);
    if (beat) requestSnapsForBeat(beat.id, beat.timeSec, true);
  }
}

function handleRangeSelect(range: Range) {
  clearSnapState();
  activeRange.value = range;
  selection.value = { kind: "range", t0: range.t0, t1: range.t1 };
  loopRegion.value = { startMs: range.t0 * 1000, endMs: range.t1 * 1000 };
  if (subMode.value === "audition" && auditionFilter.value !== "mix") {
    void syncAuditionBuffer();
  }
}

function setRangeCursorPoint(edge: "start" | "end") {
  if (!isSongReadyForActions.value) return;
  const cursorMs =
    !playing.value && hoverTimeMs.value !== undefined ? hoverTimeMs.value : shownPlayheadMs();
  const cursorSec = Number(
    Math.min(durationSec.value, Math.max(0, cursorMs / 1000)).toFixed(6),
  );

  if (edge === "start") {
    rangeStartCursorSec.value = cursorSec;
    const other =
      rangeEndCursorSec.value ??
      (activeRange.value && activeRange.value.t1 > cursorSec ? activeRange.value.t1 : null);
    if (other !== null && Math.abs(other - cursorSec) >= 0.005) {
      const t0 = Math.min(cursorSec, other);
      const t1 = Math.max(cursorSec, other);
      handleRangeSelect({ t0, t1 });
    }
  } else {
    rangeEndCursorSec.value = cursorSec;
    const other =
      rangeStartCursorSec.value ??
      (activeRange.value && activeRange.value.t0 < cursorSec ? activeRange.value.t0 : 0);
    if (Math.abs(cursorSec - other) >= 0.005) {
      const t0 = Math.min(other, cursorSec);
      const t1 = Math.max(other, cursorSec);
      handleRangeSelect({ t0, t1 });
    }
  }
}

let editChainPendingCount = 0;

function enqueueOnEditChain(task: () => Promise<void>): Promise<void> {
  if (editChainPendingCount === 0) {
    editChainPendingCount += 1;
    const direct = task().finally(() => {
      editChainPendingCount = Math.max(0, editChainPendingCount - 1);
    });
    editChain = direct.catch(() => {});
    return direct;
  }
  editChainPendingCount += 1;
  const chained = editChain.catch(() => {}).then(() =>
    task().finally(() => {
      editChainPendingCount = Math.max(0, editChainPendingCount - 1);
    }),
  );
  editChain = chained.catch(() => {});
  return chained;
}

function scheduleEntityNudge(kind: "beat" | "unbeat" | "sound", id: string, nextTimeSec: number) {
  if (!isSongReadyForActions.value) return;
  const capturedSongId = loadedSongId.value;
  const capturedEpoch = songEpoch;
  if (!capturedSongId) return;

  if (kind === "beat") {
    clearSnapState();
  }
  const entityKey = entityNudgeKey(capturedEpoch, capturedSongId, kind, id);
  pendingEntityTimeSec.set(entityKey, nextTimeSec);
  queuedEntityNudges.set(entityKey, { kind, id, timeSec: nextTimeSec });
  cuesDirty.value = true;

  if (activeNudgeDrains.has(entityKey)) {
    return;
  }

  let drainPromise: Promise<void> | undefined;
  drainPromise = (async () => {
    try {
      while (queuedEntityNudges.has(entityKey)) {
        if (
          disposed ||
          capturedEpoch !== songEpoch ||
          selectedSongId.value !== capturedSongId ||
          loadedSongId.value !== capturedSongId
        ) {
          queuedEntityNudges.delete(entityKey);
          pendingEntityTimeSec.delete(entityKey);
          return;
        }
        const item = queuedEntityNudges.get(entityKey);
        queuedEntityNudges.delete(entityKey);
        if (!item) break;

        const op: EditOp =
          item.kind === "beat"
            ? { op: "move_beat", id: item.id, timeSec: item.timeSec, source: "user" }
            : item.kind === "unbeat"
              ? { op: "move_unbeat", id: item.id, timeSec: item.timeSec }
              : { op: "move_sound", id: item.id, timeSec: item.timeSec, source: "user" };

        let failed = false;
        await enqueueOnEditChain(async () => {
          if (
            disposed ||
            capturedEpoch !== songEpoch ||
            selectedSongId.value !== capturedSongId ||
            loadedSongId.value !== capturedSongId
          ) {
            return;
          }
          inFlightEditCount.value += 1;
          error.value = "";
          try {
            const payload = await applySongOps(capturedSongId, op);
            if (
              !disposed &&
              capturedEpoch === songEpoch &&
              selectedSongId.value === capturedSongId &&
              loadedSongId.value === capturedSongId
            ) {
              applyPayload(payload, { checkLocalInvalidation: true });
            }
          } catch (cause) {
            failed = true;
            if (
              !disposed &&
              capturedEpoch === songEpoch &&
              selectedSongId.value === capturedSongId
            ) {
              queuedEntityNudges.delete(entityKey);
              pendingEntityTimeSec.delete(entityKey);
              reportError(cause);
            }
          } finally {
            if (capturedEpoch === songEpoch) {
              inFlightEditCount.value = Math.max(0, inFlightEditCount.value - 1);
            }
          }
        });
        if (failed) return;
      }

      if (
        !disposed &&
        capturedEpoch === songEpoch &&
        selectedSongId.value === capturedSongId &&
        loadedSongId.value === capturedSongId &&
        !queuedEntityNudges.has(entityKey)
      ) {
        const finalSec = pendingEntityTimeSec.get(entityKey);
        pendingEntityTimeSec.delete(entityKey);
        if (
          kind === "beat" &&
          finalSec !== undefined &&
          selection.value.kind === "beat" &&
          selection.value.id === id
        ) {
          requestSnapsForBeat(id, finalSec, true);
        }
      }
    } finally {
      if (activeNudgeDrains.get(entityKey) === drainPromise) {
        activeNudgeDrains.delete(entityKey);
      }
    }
  })();

  activeNudgeDrains.set(entityKey, drainPromise);
}

// Edits & Undo/Redo
async function commitOps(
  ops: EditOp | EditOp[],
  options?: {
    markCuesDirty?: boolean;
    afterSelect?: TempoSelection;
    snapBeat?: { id: string; timeSec: number };
  },
) {
  if (!isSongReadyForActions.value) return;
  const capturedSongId = loadedSongId.value;
  const capturedEpoch = songEpoch;
  if (!capturedSongId) return;

  if (activeNudgeDrains.size > 0) {
    await Promise.allSettled(Array.from(activeNudgeDrains.values()));
  }
  await enqueueOnEditChain(async () => {
    if (
      disposed ||
      capturedEpoch !== songEpoch ||
      selectedSongId.value !== capturedSongId ||
      loadedSongId.value !== capturedSongId
    ) {
      return;
    }
    inFlightEditCount.value += 1;
    error.value = "";
    try {
      const payload = await applySongOps(capturedSongId, ops);
      if (
        disposed ||
        capturedEpoch !== songEpoch ||
        selectedSongId.value !== capturedSongId ||
        loadedSongId.value !== capturedSongId
      ) {
        return;
      }
      applyPayload(payload, { checkLocalInvalidation: true });
      if (options?.markCuesDirty) cuesDirty.value = true;
      if (options?.afterSelect) {
        selection.value = options.afterSelect;
      }
      if (options?.snapBeat) {
        requestSnapsForBeat(options.snapBeat.id, options.snapBeat.timeSec, false);
      }
    } catch (cause) {
      if (!disposed && capturedEpoch === songEpoch && selectedSongId.value === capturedSongId) {
        reportError(cause);
      }
    } finally {
      if (capturedEpoch === songEpoch) {
        inFlightEditCount.value = Math.max(0, inFlightEditCount.value - 1);
      }
    }
  });
}

async function performUndoRedo(action: "undo" | "redo") {
  if (!isSongReadyForActions.value) return;
  if (activeNudgeDrains.size > 0) {
    await Promise.allSettled(Array.from(activeNudgeDrains.values()));
  }
  if (action === "undo" && !canUndo.value) return;
  if (action === "redo" && !canRedo.value) return;

  const capturedSongId = loadedSongId.value;
  const capturedEpoch = songEpoch;
  if (!capturedSongId) return;

  clearSnapState();
  await enqueueOnEditChain(async () => {
    if (
      disposed ||
      capturedEpoch !== songEpoch ||
      selectedSongId.value !== capturedSongId ||
      loadedSongId.value !== capturedSongId
    ) {
      return;
    }
    inFlightEditCount.value += 1;
    error.value = "";
    try {
      const payload = await applySongAction(capturedSongId, action);
      if (
        disposed ||
        capturedEpoch !== songEpoch ||
        selectedSongId.value !== capturedSongId ||
        loadedSongId.value !== capturedSongId
      ) {
        return;
      }
      applyPayload(payload);
      clearSnapState();
    } catch (cause) {
      if (!disposed && capturedEpoch === songEpoch && selectedSongId.value === capturedSongId) {
        reportError(cause);
      }
    } finally {
      if (capturedEpoch === songEpoch) {
        inFlightEditCount.value = Math.max(0, inFlightEditCount.value - 1);
      }
    }
  });
}

/**
 * Live-tap cursor for `Beat` (`B`), `Unbeat` (`U`), and `Sound` (`N`):
 * while playing, strictly uses `engine.heardAt(eventTimeStamp)` and ignores taps
 * (`null`) if audible output has not started yet instead of falling back to visual playhead!
 */
function liveTapCursorSec(eventTimeStamp: number): number | null {
  if (!isSongReadyForActions.value || durationSec.value <= 0) return null;
  if (playing.value || engine?.starting) {
    const heardMs = engine?.heardAt(eventTimeStamp);
    if (heardMs === undefined) return null;
    return Number(Math.min(durationSec.value, Math.max(0, heardMs / 1000)).toFixed(6));
  }
  const targetMs = hoverTimeMs.value ?? playheadMs.value;
  return Number(Math.min(durationSec.value, Math.max(0, targetMs / 1000)).toFixed(6));
}

function structuralCursorSec(): number | null {
  if (!isSongReadyForActions.value || durationSec.value <= 0) return null;
  const targetMs = playing.value ? shownPlayheadMs() : (hoverTimeMs.value ?? playheadMs.value);
  return Number(Math.min(durationSec.value, Math.max(0, targetMs / 1000)).toFixed(6));
}

function placeBeatAt(timeSec: number) {
  if (!isSongReadyForActions.value) return;
  const curSong = loadedSongId.value;
  const capturedEpoch = songEpoch;
  if (!curSong) return;
  const clamped = Number(Math.min(durationSec.value, Math.max(0, timeSec)).toFixed(6));
  clearSnapState();

  let coincidentId: string | undefined;
  let nearestDist = Number.POSITIVE_INFINITY;
  for (const b of beats.value) {
    const dist = Math.abs(b.timeSec - clamped);
    if (dist <= 0.0005 && dist < nearestDist) {
      coincidentId = b.id;
      nearestDist = dist;
    }
  }
  for (const entry of inFlightPlacedBeats.values()) {
    if (entry.epoch !== capturedEpoch || entry.songId !== curSong) continue;
    const dist = Math.abs(entry.timeSec - clamped);
    if (dist <= 0.0005 && dist < nearestDist) {
      coincidentId = entry.id;
      nearestDist = dist;
    }
  }

  if (coincidentId) {
    const targetId = coincidentId;
    const optKey = `${capturedEpoch}::${curSong}::${targetId}`;
    inFlightPlacedBeats.set(optKey, {
      epoch: capturedEpoch,
      songId: curSong,
      id: targetId,
      timeSec: clamped,
    });
    selection.value = { kind: "beat", id: targetId };
    void commitOps(
      {
        op: "move_beat",
        id: targetId,
        timeSec: clamped,
        source: "user",
      },
      {
        markCuesDirty: true,
        afterSelect: { kind: "beat", id: targetId },
        snapBeat: { id: targetId, timeSec: clamped },
      },
    ).finally(() => {
      const cur = inFlightPlacedBeats.get(optKey);
      if (cur && cur.timeSec === clamped) {
        inFlightPlacedBeats.delete(optKey);
      }
    });
    return;
  }

  const id = crypto.randomUUID();
  const optKey = `${capturedEpoch}::${curSong}::${id}`;
  inFlightPlacedBeats.set(optKey, {
    epoch: capturedEpoch,
    songId: curSong,
    id,
    timeSec: clamped,
  });
  selection.value = { kind: "beat", id };
  void commitOps(
    {
      op: "upsert_beat",
      beat: { id, timeSec: clamped, source: "user" },
    },
    {
      markCuesDirty: true,
      afterSelect: { kind: "beat", id },
      snapBeat: { id, timeSec: clamped },
    },
  ).finally(() => {
    const cur = inFlightPlacedBeats.get(optKey);
    if (cur && cur.timeSec === clamped) {
      inFlightPlacedBeats.delete(optKey);
    }
  });
}

function placeUnbeatAt(timeSec: number, isLivePlaying = false) {
  if (!isSongReadyForActions.value) return;
  const clamped = Number(Math.min(durationSec.value, Math.max(0, timeSec)).toFixed(6));
  const id = crypto.randomUUID();
  const captureRadiusSec = computeUnbeatCaptureRadiusSec(view.value.msPerPx, isLivePlaying);
  clearSnapState();
  void commitOps(
    {
      op: "apply_unbeat_cue",
      id,
      timeSec: clamped,
      captureRadiusSec,
      removeUserBeats: true,
    },
    {
      markCuesDirty: true,
      afterSelect: { kind: "unbeat", id },
    },
  );
}

function placeSoundAt(timeSec: number) {
  if (!isSongReadyForActions.value) return;
  const clamped = Number(Math.min(durationSec.value, Math.max(0, timeSec)).toFixed(6));
  const id = crypto.randomUUID();
  clearSnapState();
  void commitOps(
    {
      op: "upsert_sound",
      sound: { id, timeSec: clamped, source: "user" },
    },
    {
      markCuesDirty: true,
      afterSelect: { kind: "sound", id },
    },
  );
}

function onToolbarCuePress(kind: "beat" | "unbeat" | "sound", event: MouseEvent) {
  if (!isSongReadyForActions.value) return;
  if (event.type === "pointerdown" && event.button !== 0) return;
  if (event.type === "click" && event.detail !== 0) return;
  const sec = liveTapCursorSec(event.timeStamp);
  if (sec === null) return;
  if (kind === "beat") placeBeatAt(sec);
  else if (kind === "unbeat") placeUnbeatAt(sec, playing.value || Boolean(engine?.starting));
  else placeSoundAt(sec);
}

function applySnapCandidate(candidate: SnapCandidate) {
  if (!isSongReadyForActions.value) return;
  const bound = snapState.value;
  const beat = selectedBeat.value;
  if (
    !bound ||
    !beat ||
    bound.songId !== loadedSongId.value ||
    bound.beatId !== beat.id ||
    Math.abs(bound.beatTimeSec - beat.timeSec) > 1e-6
  ) {
    return;
  }
  clearSnapState();
  void commitOps(
    {
      op: "snap_beat",
      id: beat.id,
      timeSec: candidate.targetSec,
      snapEventId: candidate.eventId,
      snapFamily: candidate.family,
      snapRole: candidate.role,
      source: "user",
    },
    {
      markCuesDirty: true,
      afterSelect: { kind: "beat", id: beat.id },
    },
  );
}

function nudgeSelection(deltaMs: number) {
  if (!isSongReadyForActions.value) return;
  const deltaSec = deltaMs / 1000;
  if (selectedBeat.value) {
    const b = selectedBeat.value;
    const nextSec = Math.min(
      durationSec.value,
      Math.max(0, Number((b.timeSec + deltaSec).toFixed(9))),
    );
    scheduleEntityNudge("beat", b.id, nextSec);
    return;
  }
  if (selectedUnbeat.value) {
    const u = selectedUnbeat.value;
    const nextSec = Math.min(
      durationSec.value,
      Math.max(0, Number((u.timeSec + deltaSec).toFixed(9))),
    );
    scheduleEntityNudge("unbeat", u.id, nextSec);
    return;
  }
  if (selectedSound.value) {
    const s = selectedSound.value;
    const nextSec = Math.min(
      durationSec.value,
      Math.max(0, Number((s.timeSec + deltaSec).toFixed(9))),
    );
    scheduleEntityNudge("sound", s.id, nextSec);
    return;
  }
  if (!playing.value) {
    playheadMs.value = clampToBounds(playheadMs.value + deltaMs);
    bringIntoView(playheadMs.value);
    maybeRefreshAuditionWindow(playheadMs.value / 1000, false);
  }
}

function nudgeSelectionFrames(deltaFrames: number) {
  if (!isSongReadyForActions.value) return;
  const sr = sourceSampleRate.value;
  const maxFrames = Math.max(0, Math.round(durationSec.value * sr));

  if (selectedBeat.value) {
    const b = selectedBeat.value;
    const nextFrame = Math.min(maxFrames, Math.max(0, Math.round(b.timeSec * sr) + deltaFrames));
    const nextTimeSec = Math.min(durationSec.value, Math.max(0, nextFrame / sr));
    scheduleEntityNudge("beat", b.id, nextTimeSec);
    return;
  }
  if (selectedUnbeat.value) {
    const u = selectedUnbeat.value;
    const nextFrame = Math.min(maxFrames, Math.max(0, Math.round(u.timeSec * sr) + deltaFrames));
    const nextTimeSec = Math.min(durationSec.value, Math.max(0, nextFrame / sr));
    scheduleEntityNudge("unbeat", u.id, nextTimeSec);
    return;
  }
  if (selectedSound.value) {
    const s = selectedSound.value;
    const nextFrame = Math.min(maxFrames, Math.max(0, Math.round(s.timeSec * sr) + deltaFrames));
    const nextTimeSec = Math.min(durationSec.value, Math.max(0, nextFrame / sr));
    scheduleEntityNudge("sound", s.id, nextTimeSec);
    return;
  }
  if (!playing.value) {
    playheadMs.value = clampToBounds(playheadMs.value + (deltaFrames * 1000) / sr);
    bringIntoView(playheadMs.value);
    maybeRefreshAuditionWindow(playheadMs.value / 1000, false);
  }
}

function deleteSelectedEntity() {
  if (!isSongReadyForActions.value) return;
  const curSong = loadedSongId.value;
  if (!curSong) return;
  clearSnapState();
  if (selectedBeat.value) {
    const id = selectedBeat.value.id;
    const key = entityNudgeKey(songEpoch, curSong, "beat", id);
    pendingEntityTimeSec.delete(key);
    queuedEntityNudges.delete(key);
    inFlightPlacedBeats.delete(`${songEpoch}::${curSong}::${id}`);
    selection.value = { kind: "none" };
    void commitOps({ op: "remove_beat", id }, { markCuesDirty: true });
    return;
  }
  if (selectedUnbeat.value) {
    const id = selectedUnbeat.value.id;
    const key = entityNudgeKey(songEpoch, curSong, "unbeat", id);
    pendingEntityTimeSec.delete(key);
    queuedEntityNudges.delete(key);
    selection.value = { kind: "none" };
    void commitOps({ op: "remove_unbeat", id }, { markCuesDirty: true });
    return;
  }
  if (selectedSound.value) {
    const id = selectedSound.value.id;
    const key = entityNudgeKey(songEpoch, curSong, "sound", id);
    pendingEntityTimeSec.delete(key);
    queuedEntityNudges.delete(key);
    selection.value = { kind: "none" };
    void commitOps({ op: "remove_sound", id }, { markCuesDirty: true });
    return;
  }
  if (activeRange.value) {
    deleteBeatsInRange();
  }
}

function toggleKeepSelection() {
  if (activeRange.value && activeRange.value.t1 > activeRange.value.t0) {
    void commitOps({
      op: "set_range_keep",
      t0: activeRange.value.t0,
      t1: activeRange.value.t1,
      kept: !isRangeAllKept.value,
      source: "user",
    });
    return;
  }
  const seg = selectedSegment.value;
  if (!seg) return;
  void commitOps({
    op: "set_segment_keep",
    segmentId: seg.id,
    kept: !seg.kept,
    source: "user",
  });
}

function toggleFreeSelection() {
  if (activeRange.value && activeRange.value.t1 > activeRange.value.t0) {
    void commitOps(
      {
        op: "set_range_free",
        t0: activeRange.value.t0,
        t1: activeRange.value.t1,
        free: !isRangeAllFree.value,
        source: "user",
      },
      { markCuesDirty: true },
    );
    return;
  }
  const seg = selectedSegment.value;
  if (!seg) return;
  const nextRegime: SegmentRegime = seg.regime === "free" ? "auto" : "free";
  void commitOps(
    {
      op: "set_segment_regime",
      segmentId: seg.id,
      regime: nextRegime,
      source: "user",
    },
    { markCuesDirty: true },
  );
}

function setSegmentRegime(seg: Segment, regime: SegmentRegime) {
  if (seg.regime === regime) return;
  void commitOps(
    {
      op: "set_segment_regime",
      segmentId: seg.id,
      regime,
      source: "user",
    },
    { markCuesDirty: true },
  );
}

function onSelectSegmentFromStrip(segmentId: string, jumpToStart: boolean) {
  if (!isSongReadyForActions.value) return;
  clearSnapState();
  activeRange.value = null;
  selection.value = { kind: "segment", id: segmentId };
  const seg = segments.value.find((s) => s.id === segmentId);
  if (seg && jumpToStart) {
    seek(seg.t0 * 1000);
    bringIntoView(seg.t0 * 1000);
  }
}

function onToggleSegmentKeep(segmentId: string, kept: boolean) {
  void commitOps({
    op: "set_segment_keep",
    segmentId,
    kept,
    source: "user",
  });
}

function onMoveSegmentBoundary(leftSegmentId: string, rightSegmentId: string, timeSec: number) {
  void commitOps(
    {
      op: "move_segment_boundary",
      leftSegmentId,
      rightSegmentId,
      timeSec,
      source: "user",
    },
    { markCuesDirty: true },
  );
}

function splitActiveSegment() {
  const sec = structuralCursorSec();
  if (sec === null) return;
  const seg = findSegmentAtTime(segments.value, sec);
  if (!seg || sec <= seg.t0 + 0.05 || sec >= seg.t1 - 0.05) return;
  clearSnapState();
  const newSegmentId = crypto.randomUUID();
  void commitOps(
    {
      op: "split_segment",
      segmentId: seg.id,
      newSegmentId,
      timeSec: sec,
      source: "user",
    },
    {
      markCuesDirty: true,
      afterSelect: { kind: "segment", id: newSegmentId },
    },
  );
}

function mergeSelectedSegment(direction: "prev" | "next" = "next") {
  if (!isSongReadyForActions.value) return;
  const seg = selectedSegment.value;
  if (!seg || segments.value.length < 2) return;
  const idx = segments.value.findIndex((s) => s.id === seg.id);
  if (idx < 0) return;
  const pairIdx =
    direction === "next"
      ? idx < segments.value.length - 1
        ? idx
        : idx - 1
      : idx > 0
        ? idx - 1
        : idx;
  const left = segments.value[pairIdx];
  const right = segments.value[pairIdx + 1];
  if (!left || !right) return;
  clearSnapState();
  void commitOps(
    {
      op: "merge_segments",
      leftSegmentId: left.id,
      rightSegmentId: right.id,
      source: "user",
    },
    {
      markCuesDirty: true,
      afterSelect: { kind: "segment", id: left.id },
    },
  );
}

function shiftBeatsInRange(deltaMs: number) {
  if (!isSongReadyForActions.value) return;
  const r = activeRange.value;
  if (!r) return;
  clearSnapState();
  void commitOps(
    {
      op: "shift_beats",
      range: { t0: r.t0, t1: r.t1 },
      deltaSec: deltaMs / 1000,
      source: "user",
    },
    { markCuesDirty: true },
  );
}

function deleteBeatsInRange() {
  if (!isSongReadyForActions.value) return;
  const r = activeRange.value;
  if (!r) return;
  const inRange = beats.value.filter((b) => b.timeSec >= r.t0 && b.timeSec < r.t1);
  if (inRange.length === 0) return;
  clearSnapState();
  void commitOps(
    inRange.map((b) => ({ op: "remove_beat" as const, id: b.id })),
    { markCuesDirty: true },
  );
}

function promoteRangeToSegment() {
  if (!isSongReadyForActions.value) return;
  const r = activeRange.value;
  if (!r) return;
  clearSnapState();
  const idA = crypto.randomUUID();
  const idB = crypto.randomUUID();
  void commitOps(
    {
      op: "promote_range_to_segments",
      t0: r.t0,
      t1: r.t1,
      newSegmentIds: [idA, idB],
      source: "user",
    },
    { markCuesDirty: true },
  );
}

// Inbox navigation (`J` / `⇧J`)
function focusInboxSpan(span: Span) {
  if (!isSongReadyForActions.value) return;
  clearSnapState();
  const range: Range = { t0: span.t0, t1: span.t1 };
  activeRange.value = range;
  selection.value = { kind: "range", t0: range.t0, t1: range.t1 };
  loopRegion.value = { startMs: span.t0 * 1000, endMs: span.t1 * 1000 };
  looping.value = true;
  const padSec = Math.max(0.6, (span.t1 - span.t0) * 0.18);
  if (stageWidth.value > 0) {
    setView(
      fitView(
        {
          startMs: Math.max(0, (span.t0 - padSec) * 1000),
          endMs: Math.min(bounds.value.endMs, (span.t1 + padSec) * 1000),
        },
        stageWidth.value,
      ),
    );
  }
  seek(span.t0 * 1000);
}

function stepInbox(delta: 1 | -1) {
  if (!isSongReadyForActions.value) return;
  const items = inboxSpans.value;
  if (items.length === 0) return;
  const curRange = activeRange.value;
  const curIdx = curRange
    ? items.findIndex(
        (s) => Math.abs(s.t0 - curRange.t0) < 1e-3 && Math.abs(s.t1 - curRange.t1) < 1e-3,
      )
    : -1;
  const nextIdx =
    curIdx < 0
      ? delta > 0
        ? 0
        : items.length - 1
      : (curIdx + delta + items.length) % items.length;
  const target = items[nextIdx];
  if (target) focusInboxSpan(target);
}

// Heavy Recompute (`⌘K`) & Offers (`Alt`, `\`, `Tab`, `⇧Tab`)
async function triggerRecompute() {
  if (!isSongReadyForActions.value) return;
  const capturedSongId = loadedSongId.value;
  const capturedEpoch = songEpoch;
  if (!capturedSongId) return;

  if (activeNudgeDrains.size > 0) {
    await Promise.allSettled(Array.from(activeNudgeDrains.values()));
  }
  if (
    disposed ||
    capturedEpoch !== songEpoch ||
    selectedSongId.value !== capturedSongId ||
    loadedSongId.value !== capturedSongId
  ) {
    return;
  }

  recomputeAbort?.abort();
  const controller = new AbortController();
  recomputeAbort = controller;
  recomputing.value = true;
  error.value = "";
  try {
    const scope: Range | "song" =
      activeRange.value && activeRange.value.t1 > activeRange.value.t0
        ? { t0: activeRange.value.t0, t1: activeRange.value.t1 }
        : "song";
    const res = await recomputeSong(
      capturedSongId,
      {
        scope,
        reason: scope === "song" ? "Song recompute" : "Range recompute",
      },
      controller.signal,
    );
    if (
      controller.signal.aborted ||
      disposed ||
      capturedEpoch !== songEpoch ||
      selectedSongId.value !== capturedSongId ||
      loadedSongId.value !== capturedSongId
    ) {
      return;
    }
    cuesDirty.value = false;
    applyPayload(res);
    if (res.suppressedOffers.length > 0 && res.offers.length > 0) {
      notice.value =
        "Some local suggestions were skipped due to newer edits; valid suggestions are shown in the Inspector.";
    }
    if (buildDisplayOffers(res.state.offers).length > 0) {
      workspaceFrame.value?.showPane("right");
    }
  } catch (cause) {
    if (!isAbortError(cause) && !controller.signal.aborted && capturedEpoch === songEpoch) {
      reportError(cause);
    }
  } finally {
    if (recomputeAbort === controller && capturedEpoch === songEpoch) {
      recomputing.value = false;
    }
  }
}

async function beginHoldCompare(offerId?: string) {
  if (!isSongReadyForActions.value) return;
  const capturedSongId = loadedSongId.value;
  const capturedEpoch = songEpoch;
  if (!capturedSongId) return;

  if (offerId) selectedOfferId.value = offerId;
  if (holdingAlt.value) return;
  holdingAlt.value = true;
  holdOwnerSongId = capturedSongId;

  try {
    await enqueueHoldRequest(capturedSongId, true, (res) => {
      if (
        !disposed &&
        holdingAlt.value &&
        holdOwnerSongId === capturedSongId &&
        capturedEpoch === songEpoch &&
        selectedSongId.value === capturedSongId &&
        loadedSongId.value === capturedSongId
      ) {
        applyPayload(res);
      }
    });
  } catch {}
}

async function endHoldCompare() {
  if (!holdingAlt.value && !holdOwnerSongId) return;
  const ownerSongId = holdOwnerSongId;
  const capturedEpoch = songEpoch;
  holdingAlt.value = false;
  holdOwnerSongId = null;
  if (!ownerSongId) return;

  try {
    await enqueueHoldRequest(ownerSongId, false, (res) => {
      if (
        !disposed &&
        capturedEpoch === songEpoch &&
        selectedSongId.value === ownerSongId &&
        loadedSongId.value === ownerSongId
      ) {
        applyPayload(res);
      }
    });
  } catch {}
}

function cycleOfferOption() {
  if (!isSongReadyForActions.value) return;
  const items = displayOffers.value;
  if (items.length <= 1) return;
  const curIdx = items.findIndex((i) => i.offer.id === selectedOfferId.value);
  const nextIdx = (curIdx + 1) % items.length;
  const next = items[nextIdx]?.offer;
  if (next) {
    selectedOfferId.value = next.id;
    if (next.writeScopes[0]) {
      bringIntoView(next.writeScopes[0].t0 * 1000);
    }
  }
}

async function handleAcceptOffer(offerId?: string) {
  if (!isSongReadyForActions.value) return;
  const capturedSongId = loadedSongId.value;
  const capturedEpoch = songEpoch;
  const targetOffer = offerId
    ? displayOffers.value.find((i) => i.offer.id === offerId)?.offer
    : activeOffer.value;
  if (!capturedSongId || !targetOffer || targetOffer.status !== "valid") return;

  if (activeNudgeDrains.size > 0) {
    await Promise.allSettled(Array.from(activeNudgeDrains.values()));
  }
  clearSnapState();
  await enqueueOnEditChain(async () => {
    if (
      disposed ||
      capturedEpoch !== songEpoch ||
      selectedSongId.value !== capturedSongId ||
      loadedSongId.value !== capturedSongId
    ) {
      return;
    }
    inFlightEditCount.value += 1;
    error.value = "";
    try {
      const res = await acceptOffer(capturedSongId, targetOffer.id);
      if (
        disposed ||
        capturedEpoch !== songEpoch ||
        selectedSongId.value !== capturedSongId ||
        loadedSongId.value !== capturedSongId
      ) {
        return;
      }
      applyPayload(res);
      if (!res.ok && res.conflicts?.length) {
        notice.value = sanitizeUserFacingText(
          res.conflicts[0]?.message ?? "Suggestion conflicted with a protected Keep lock.",
        );
      }
    } catch (cause) {
      if (!disposed && capturedEpoch === songEpoch && selectedSongId.value === capturedSongId) {
        reportError(cause);
      }
    } finally {
      if (capturedEpoch === songEpoch) {
        inFlightEditCount.value = Math.max(0, inFlightEditCount.value - 1);
      }
    }
  });
}

async function handleRejectOffer(offerId?: string) {
  if (!isSongReadyForActions.value) return;
  const capturedSongId = loadedSongId.value;
  const capturedEpoch = songEpoch;
  const targetId = offerId ?? activeOffer.value?.id;
  if (!capturedSongId || !targetId) return;

  if (activeNudgeDrains.size > 0) {
    await Promise.allSettled(Array.from(activeNudgeDrains.values()));
  }
  await enqueueOnEditChain(async () => {
    if (
      disposed ||
      capturedEpoch !== songEpoch ||
      selectedSongId.value !== capturedSongId ||
      loadedSongId.value !== capturedSongId
    ) {
      return;
    }
    inFlightEditCount.value += 1;
    error.value = "";
    try {
      const res = await rejectOffer(capturedSongId, targetId);
      if (
        disposed ||
        capturedEpoch !== songEpoch ||
        selectedSongId.value !== capturedSongId ||
        loadedSongId.value !== capturedSongId
      ) {
        return;
      }
      applyPayload(res);
    } catch (cause) {
      if (!disposed && capturedEpoch === songEpoch && selectedSongId.value === capturedSongId) {
        reportError(cause);
      }
    } finally {
      if (capturedEpoch === songEpoch) {
        inFlightEditCount.value = Math.max(0, inFlightEditCount.value - 1);
      }
    }
  });
}

// Export actions
function downloadTextFile(fileName: string, content: string, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function handleExport(action: "osu-copy" | "osu-download" | "jsonl" | "clip") {
  if (!isSongReadyForActions.value) return;
  const songId = loadedSongId.value;
  const capturedEpoch = songEpoch;
  if (!songId) return;
  exportMenuOpen.value = false;
  exportingFormat.value = action;
  error.value = "";
  try {
    if (action === "osu-copy" || action === "osu-download") {
      const res = await exportSong(songId, { format: "osu" });
      if (disposed || capturedEpoch !== songEpoch) return;
      if (res.format === "osu") {
        if (action === "osu-copy" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(res.content);
        } else {
          downloadTextFile(res.fileName, res.content);
        }
      }
      return;
    }
    if (action === "jsonl") {
      const res = await exportSong(songId, { format: "jsonl" });
      if (disposed || capturedEpoch !== songEpoch) return;
      if (res.format === "jsonl") {
        downloadTextFile(res.fileName, res.content, "application/x-ndjson;charset=utf-8");
      }
      return;
    }
    const t0 = activeRange.value
      ? activeRange.value.t0
      : Math.max(0, view.value.startMs / 1000);
    const t1 = activeRange.value
      ? activeRange.value.t1
      : Math.min(
          durationSec.value || 15,
          (view.value.startMs + view.value.msPerPx * stageWidth.value) / 1000,
        );
    const res = await exportSong(songId, {
      format: "clip",
      t0,
      t1: Math.max(t0 + 0.25, t1),
      filter: subMode.value === "audition" ? auditionFilter.value : "mix",
    });
    if (disposed || capturedEpoch !== songEpoch) return;
    if (res.format === "clip") {
      const anchor = document.createElement("a");
      anchor.href = res.downloadUrl;
      anchor.download = res.fileName;
      anchor.click();
    }
  } catch (cause) {
    if (!disposed && capturedEpoch === songEpoch) reportError(cause);
  } finally {
    exportingFormat.value = null;
  }
}

// Keyboard & focus discipline
let pressedControl: Element | null = null;
function notePress(event: Event) {
  pressedControl =
    event.target instanceof Element
      ? event.target.closest("button, summary, select, input[type='range'], input[type='checkbox']")
      : null;
}

function releasePressed(event: Event) {
  const kinds =
    event.type === "change"
      ? "select, input[type='range']"
      : "button, summary, input[type='range'], input[type='checkbox']";
  const control = event.target instanceof Element ? event.target.closest(kinds) : null;
  if (!control || control !== pressedControl) return;
  pressedControl = null;
  if (control instanceof HTMLElement) control.blur();
}

function handleKeyup(event: KeyboardEvent) {
  if (event.key === "Alt") {
    void endHoldCompare();
  }
}

function handleWindowBlur() {
  releaseHoldOwnerSynchronously();
}

function handleKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return;

  if (event.key === "Alt" && !event.repeat && !isTypingTarget(event.target)) {
    void beginHoldCompare();
    return;
  }

  if (isTypingTarget(event.target)) {
    if (event.key === "Escape") {
      (event.target as HTMLElement | null)?.blur();
      folderMenuOpen.value = false;
    }
    return;
  }

  const key = event.key;
  const lower = key.toLowerCase();

  if (event.metaKey || event.ctrlKey) {
    if (lower === "k") {
      event.preventDefault();
      if (!event.repeat && isSongReadyForActions.value) void triggerRecompute();
      return;
    }
    if (lower === "z") {
      event.preventDefault();
      if (!event.repeat && isSongReadyForActions.value) {
        void performUndoRedo(event.shiftKey ? "redo" : "undo");
      }
      return;
    }
    return;
  }

  if (event.altKey) return;

  if (event.repeat && (singleShotKeys.has(lower) || /^[1-4]$/.test(key))) {
    event.preventDefault();
    return;
  }

  if (key === "Tab" && activeOffer.value && isSongReadyForActions.value) {
    event.preventDefault();
    if (event.shiftKey) {
      void handleRejectOffer();
    } else if (activeOffer.value.status === "valid") {
      void handleAcceptOffer();
    }
    return;
  }

  if (key === " ") {
    if (isNativeActivationTarget(event.target)) return;
    event.preventDefault();
    togglePlayback();
    return;
  }

  if (
    /^[1-4]$/.test(key) &&
    isSongReadyForActions.value &&
    selection.value.kind === "beat" &&
    snapCandidates.value.length > 0
  ) {
    const candidate = snapCandidates.value[Number(key) - 1];
    if (candidate) {
      event.preventDefault();
      applySnapCandidate(candidate);
      return;
    }
  }

  const fineMs = event.shiftKey ? 0.1 : 1;

  const actions: Record<string, () => void> = {
    Escape: () => {
      if (folderMenuOpen.value || exportMenuOpen.value) {
        folderMenuOpen.value = false;
        exportMenuOpen.value = false;
        return;
      }
      if (stageRef.value?.cancelDrag()) return;
      clearSnapState();
      if (activeRange.value) {
        activeRange.value = null;
        selection.value = { kind: "none" };
        return;
      }
      stop();
      selection.value = { kind: "none" };
    },
    l: toggleLoop,
    c: toggleClicks,
    f: () => {
      follow.value = !follow.value;
    },
    z: toggleFineZoom,
    "+": () => zoom(0.5),
    "=": () => zoom(0.5),
    "-": () => zoom(2),
    "0": fitWholeSong,
    b: () => {
      const sec = liveTapCursorSec(event.timeStamp);
      if (sec !== null) placeBeatAt(sec);
    },
    u: () => {
      const sec = liveTapCursorSec(event.timeStamp);
      if (sec !== null) placeUnbeatAt(sec, playing.value || Boolean(engine?.starting));
    },
    n: () => {
      const sec = liveTapCursorSec(event.timeStamp);
      if (sec !== null) placeSoundAt(sec);
    },
    r: () => {
      if (isSongReadyForActions.value) toggleFreeSelection();
    },
    v: () => {
      if (isSongReadyForActions.value) toggleKeepSelection();
    },
    s: () => {
      if (isSongReadyForActions.value) splitActiveSegment();
    },
    m: () => {
      if (isSongReadyForActions.value) mergeSelectedSegment("next");
    },
    "[": () => setRangeCursorPoint("start"),
    "]": () => setRangeCursorPoint("end"),
    j: () => stepInbox(event.shiftKey ? -1 : 1),
    g: () => {
      if (isSongReadyForActions.value) toggleFlamCheck();
    },
    x: () => {
      if (!isSongReadyForActions.value) return;
      const sec =
        selectedBeat.value?.timeSec ??
        selectedUnbeat.value?.timeSec ??
        selectedSound.value?.timeSec;
      if (sec !== undefined) loopAroundEntity(sec);
    },
    "\\": cycleOfferOption,
    ArrowLeft: () => nudgeSelection(-fineMs),
    ArrowRight: () => nudgeSelection(fineMs),
    ",": () => nudgeSelectionFrames(-1),
    ".": () => nudgeSelectionFrames(1),
    Delete: deleteSelectedEntity,
    Backspace: deleteSelectedEntity,
  };

  const action = actions[key.length === 1 ? lower : key];
  if (!action) return;
  event.preventDefault();
  action();
}

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("keyup", handleKeyup);
  window.addEventListener("blur", handleWindowBlur);
  window.addEventListener("pointerdown", notePress, true);
  window.addEventListener("click", releasePressed);
  window.addEventListener("change", releasePressed);
  void initializeWorkspace();
});

onBeforeUnmount(() => {
  disposed = true;
  releaseHoldOwnerSynchronously();
  setClientWorkspaceDir(null);
  songEpoch += 1;
  songOpenAbort?.abort();
  snapsAbort?.abort();
  recomputeAbort?.abort();
  auditionAbort?.abort();
  clearAuditionSongMemory();
  clearTimeout(snapDebounceTimer);
  clearTimeout(transportTimer);
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("keyup", handleKeyup);
  window.removeEventListener("blur", handleWindowBlur);
  window.removeEventListener("pointerdown", notePress, true);
  window.removeEventListener("click", releasePressed);
  window.removeEventListener("change", releasePressed);
  void engine?.close();
  engine = undefined;
});
</script>

<template>
  <main id="main-content" class="bench tempo-bench has-active-workspace" tabindex="-1">
    <input
      ref="fileInputRef"
      class="sr-only"
      type="file"
      multiple
      accept=".mp3,.ogg,.wav,.flac,.m4a,.opus,audio/*"
      @change="onImportFilesSelected"
    />

    <WorkspaceFrame
      ref="workspaceFrame"
      class="tempo-workspace"
      layout-key="tempo"
      :left="leftSpec"
      :right="rightSpec"
    >
      <template #mode>
        <span class="tempo-mode-title">Tempo</span>
        <div class="tempo-file-actions">
          <button
            type="button"
            class="tool-button"
            :disabled="loadingWorkspace"
            title="Import audio files into the Tempo workspace"
            @click="triggerImportPicker"
          >
            Import
          </button>
          <div class="tempo-popover-anchor">
            <button
              type="button"
              class="tool-button"
              :aria-expanded="folderMenuOpen"
              :aria-pressed="folderMenuOpen"
              title="Open Folder…"
              @click="
                folderMenuOpen = !folderMenuOpen;
                exportMenuOpen = false;
              "
            >
              Folder…
            </button>
            <form
              v-if="folderMenuOpen"
              class="tempo-popover tempo-folder-popover"
              aria-label="Open workspace folder"
              @submit.prevent="handleOpenFolder"
            >
              <label class="field-stack">
                <span>Open Folder…</span>
                <input
                  v-model="folderPathInput"
                  type="text"
                  placeholder="~/Music/songs or /path/to/folder"
                  autocomplete="off"
                  spellcheck="false"
                />
              </label>
              <div class="tempo-popover-buttons">
                <button
                  type="button"
                  class="tool-button"
                  @click="folderMenuOpen = false"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="tool-button tool-button--primary"
                  :disabled="!folderPathInput.trim() || loadingWorkspace"
                >
                  Open
                </button>
              </div>
            </form>
          </div>
          <div class="tempo-popover-anchor">
            <button
              type="button"
              class="tool-button"
              :disabled="!isSongReadyForActions || Boolean(exportingFormat)"
              :aria-expanded="exportMenuOpen"
              :aria-pressed="exportMenuOpen"
              title="Export timing points, trace, or WAV clip"
              @click="
                exportMenuOpen = !exportMenuOpen;
                folderMenuOpen = false;
              "
            >
              Export
            </button>
            <div
              v-if="exportMenuOpen"
              class="tempo-popover tempo-export-popover"
              role="menu"
              aria-label="Export options"
            >
              <button
                type="button"
                class="tempo-menu-item"
                role="menuitem"
                @click="handleExport('osu-copy')"
              >
                Copy .osu [TimingPoints]
              </button>
              <button
                type="button"
                class="tempo-menu-item"
                role="menuitem"
                @click="handleExport('osu-download')"
              >
                Download .osu [TimingPoints]
              </button>
              <button
                type="button"
                class="tempo-menu-item"
                role="menuitem"
                @click="handleExport('jsonl')"
              >
                Download .jsonl trace
              </button>
              <button
                type="button"
                class="tempo-menu-item"
                role="menuitem"
                @click="handleExport('clip')"
              >
                Export WAV clip ({{ activeRange ? "Range" : "Viewport" }})
              </button>
            </div>
          </div>
        </div>
      </template>

      <template #toolbar>
        <fieldset class="segmented" aria-label="Workspace sub-mode">
          <button
            type="button"
            :aria-pressed="subMode === 'edit'"
            title="Edit beats, segments, and cues"
            @click="subMode = 'edit'"
          >
            Edit
          </button>
          <button
            type="button"
            :aria-pressed="subMode === 'audition'"
            title="Audition filtered listening views without interrupting playback"
            @click="subMode = 'audition'"
          >
            Audition
          </button>
        </fieldset>

        <fieldset class="toolbar-group tempo-transport" aria-label="Transport">
          <button
            type="button"
            class="tool-button tool-button--play"
            :class="{ 'is-playing': playing }"
            :disabled="audioState !== 'ready'"
            :aria-pressed="playing"
            aria-keyshortcuts="Space"
            title="Play or stop (Space)"
            @click="togglePlayback"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect v-if="playing" class="tool-icon-fill" x="4" y="4" width="8" height="8" rx="1" />
              <path v-else class="tool-icon-fill" d="M5 3.3v9.4L12.6 8z" />
            </svg>
            {{ playing ? "Stop" : "Play" }}
          </button>
          <button
            type="button"
            class="tool-button"
            :disabled="!sessionPayload"
            :aria-pressed="looping"
            aria-keyshortcuts="L"
            title="Loop active range or segment (L)"
            @click="toggleLoop"
          >
            Loop
          </button>
          <button
            type="button"
            class="tool-button"
            :disabled="!sessionPayload"
            :aria-pressed="preferences.clicks"
            aria-keyshortcuts="C"
            title="Audible clicks on active beats (C)"
            @click="toggleClicks"
          >
            Clicks
          </button>
          <input
            v-if="preferences.clicks"
            type="range"
            class="tempo-click-slider toolbar-optional"
            min="0"
            max="100"
            step="1"
            aria-label="Click volume"
            :title="`Click volume: ${Math.round(preferences.clickVolume * 100)}%`"
            :value="Math.round(preferences.clickVolume * 100)"
            @input="setClickVolume(($event.target as HTMLInputElement).valueAsNumber / 100)"
          />
        </fieldset>

        <fieldset class="segmented" aria-label="Playback rate">
          <button
            v-for="r in playbackRates"
            :key="r"
            type="button"
            :aria-pressed="rate === r"
            :title="`Playback rate ${r}×`"
            @click="setRate(r)"
          >
            {{ r }}×
          </button>
        </fieldset>

        <button
          type="button"
          class="tool-button toolbar-optional"
          :aria-pressed="follow"
          aria-keyshortcuts="F"
          title="Follow playhead during playback (F)"
          @click="follow = !follow"
        >
          Follow
        </button>

        <fieldset class="toolbar-group" aria-label="History">
          <button
            type="button"
            class="tool-button tool-button--icon"
            :disabled="!isSongReadyForActions || !canUndo || updatingEdit"
            aria-label="Undo"
            aria-keyshortcuts="Meta+Z Control+Z"
            title="Undo (⌘Z)"
            @click="performUndoRedo('undo')"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6.5 4.2 3 7.5l3.5 3.3" />
              <path d="M3.5 7.5h6a3.5 3.5 0 0 1 0 7H8" />
            </svg>
          </button>
          <button
            type="button"
            class="tool-button tool-button--icon"
            :disabled="!isSongReadyForActions || !canRedo || updatingEdit"
            aria-label="Redo"
            aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z"
            title="Redo (⇧⌘Z)"
            @click="performUndoRedo('redo')"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M9.5 4.2 13 7.5l-3.5 3.3" />
              <path d="M12.5 7.5h-6a3.5 3.5 0 0 0 0 7H8" />
            </svg>
          </button>
        </fieldset>

        <div class="time-counter tempo-counter" title="Playhead time and sample or range">
          <span class="sr-only">Playhead</span>
          <span class="time-counter-main">
            {{ formatSourceTime(playheadMs, devicePxMs < 1 ? 1 : 0) }}
          </span>
          <span class="time-counter-sub">{{ counterSubText }}</span>
        </div>
      </template>

      <template #toolbar-end>
        <span
          class="health-status tempo-status"
          :class="`health-status--${toolbarStatus.tone}`"
          aria-live="polite"
        >
          <span class="health-dot" aria-hidden="true"></span>
          {{ toolbarStatus.text }}
        </span>
      </template>

      <template #left>
        <div class="tempo-left-pane">
          <PanelSection id="tempo-songs" class="tempo-left-section" title="Songs">
            <template #meta>{{ songs.length }}</template>
            <nav v-if="songs.length > 0" class="tempo-scroll-list" aria-label="Songs">
              <button
                v-for="song in songs"
                :key="song.songId"
                type="button"
                class="tempo-list-row"
                :class="{ 'is-active': song.songId === selectedSongId }"
                :aria-current="song.songId === selectedSongId ? 'true' : undefined"
                :title="song.title"
                @click="selectSong(song.songId)"
              >
                <span
                  class="tempo-song-dot"
                  :class="{
                    'is-ready':
                      song.ready ||
                      (song.segmentCount > 0 && song.keptSegmentCount === song.segmentCount),
                    'is-warn':
                      !song.ready &&
                      song.inboxCount > 0 &&
                      (song.highestPriority === 'high' || song.highestPriority === 'medium'),
                    'is-signal':
                      !song.ready && song.inboxCount > 0 && song.highestPriority === 'low',
                  }"
                  aria-hidden="true"
                ></span>
                <span class="tempo-row-title">{{ song.title }}</span>
                <span class="tempo-row-meta">
                  {{
                    song.ready ||
                    (song.segmentCount > 0 && song.keptSegmentCount === song.segmentCount)
                      ? "Ready"
                      : song.analyzed && song.segmentCount > 0
                        ? `${song.keptSegmentCount}/${song.segmentCount}`
                        : ""
                  }}
                </span>
              </button>
            </nav>
            <p v-else class="tempo-pane-empty">No songs loaded yet.</p>
          </PanelSection>

          <PanelSection id="tempo-inbox" class="tempo-left-section" title="Inbox">
            <template #meta>{{ inboxSpans.length }}</template>
            <nav v-if="inboxSpans.length > 0" class="tempo-scroll-list" aria-label="Inbox">
              <button
                v-for="(item, idx) in inboxSpans"
                :key="`${item.segmentId}-${item.t0}-${idx}`"
                type="button"
                class="tempo-inbox-row"
                :class="[
                  `is-priority-${item.priority ?? 'low'}`,
                  {
                    'is-active':
                      activeRange !== null &&
                      Math.abs(activeRange.t0 - item.t0) < 1e-3 &&
                      Math.abs(activeRange.t1 - item.t1) < 1e-3,
                  },
                ]"
                :title="`${formatSecSpan(item.t0, item.t1, 1)} · ${item.reason ?? 'Review passage'} (J / ⇧J)`"
                @click="focusInboxSpan(item)"
              >
                <span class="tempo-inbox-time">{{ formatSecSpan(item.t0, item.t1, 1) }}</span>
                <span class="tempo-inbox-reason">{{ item.reason ?? "Needs review" }}</span>
              </button>
            </nav>
            <p v-else class="tempo-pane-empty">
              {{ sessionPayload ? "All sections clear." : "Open a song to inspect priority spans." }}
            </p>
          </PanelSection>
        </div>
      </template>

      <template #main>
        <section v-if="!sessionPayload && songs.length === 0 && !openingSong" class="tempo-onboarding">
          <div class="tempo-onboarding-box">
            <p class="section-kicker">Tempo Workspace</p>
            <h1>Map song tempo by ear and cue</h1>
            <p>
              Open a folder of audio tracks or import songs directly. Beats, unbeat cues, segments,
              and traces save automatically in <span class="data">.ensomi-tempo/</span>.
            </p>
            <form class="tempo-onboarding-form" @submit.prevent="handleOpenFolder">
              <label class="field-stack">
                <span>Audio folder</span>
                <input
                  v-model="folderPathInput"
                  type="text"
                  placeholder="~/Downloads/songs or /path/to/folder"
                  autocomplete="off"
                  spellcheck="false"
                />
              </label>
              <div class="tempo-onboarding-actions">
                <button
                  type="submit"
                  class="tool-button tool-button--primary"
                  :disabled="!folderPathInput.trim() || loadingWorkspace"
                >
                  Open Folder
                </button>
                <button
                  type="button"
                  class="tool-button"
                  :disabled="loadingWorkspace"
                  @click="triggerImportPicker"
                >
                  Import Audio Files…
                </button>
              </div>
            </form>
            <p v-if="error" class="inline-message inline-message--error" role="alert">
              {{ error }}
            </p>
          </div>
        </section>

        <section v-else class="tempo-main" aria-label="Tempo stage">
          <header class="tempo-hud">
            <div class="stage-toolbar">
              <div
                class="stage-identity tempo-song-identity"
                :title="activeSongSummary?.title ?? ''"
              >
                <strong>{{ activeSongSummary?.title ?? "Loading…" }}</strong>
              </div>

              <template v-if="subMode === 'edit'">
                <fieldset class="toolbar-group" aria-label="Cues and locks">
                  <button
                    type="button"
                    class="tool-button"
                    :disabled="!isSongReadyForActions"
                    aria-keyshortcuts="B"
                    title="Place user beat (B)"
                    @pointerdown="onToolbarCuePress('beat', $event)"
                    @click="onToolbarCuePress('beat', $event)"
                  >
                    Beat <kbd>B</kbd>
                  </button>
                  <button
                    type="button"
                    class="tool-button"
                    :disabled="!isSongReadyForActions"
                    aria-keyshortcuts="U"
                    title="Mark standalone unbeat cue (U)"
                    @pointerdown="onToolbarCuePress('unbeat', $event)"
                    @click="onToolbarCuePress('unbeat', $event)"
                  >
                    Unbeat <kbd>U</kbd>
                  </button>
                  <button
                    type="button"
                    class="tool-button"
                    :disabled="!isSongReadyForActions"
                    aria-keyshortcuts="N"
                    title="Mark heard sound anchor (N)"
                    @pointerdown="onToolbarCuePress('sound', $event)"
                    @click="onToolbarCuePress('sound', $event)"
                  >
                    Sound <kbd>N</kbd>
                  </button>
                  <button
                    type="button"
                    class="tool-button"
                    :disabled="!isSongReadyForActions"
                    :aria-pressed="
                      activeRange ? isRangeAllFree : selectedSegment?.regime === 'free'
                    "
                    aria-keyshortcuts="R"
                    title="Toggle Free pulse interval on range or segment (R)"
                    @click="toggleFreeSelection"
                  >
                    Free <kbd>R</kbd>
                  </button>
                  <button
                    type="button"
                    class="tool-button"
                    :disabled="!isSongReadyForActions"
                    :aria-pressed="activeRange ? isRangeAllKept : Boolean(selectedSegment?.kept)"
                    aria-keyshortcuts="V"
                    title="Keep active range or whole segment (V)"
                    @click="toggleKeepSelection"
                  >
                    Keep <kbd>V</kbd>
                  </button>
                </fieldset>

                <button
                  type="button"
                  class="tool-button"
                  :class="{ 'tool-button--primary': cuesDirty }"
                  :disabled="!isSongReadyForActions || recomputing"
                  aria-keyshortcuts="Meta+K Control+K"
                  title="Recompute timing suggestions from cues (⌘K)"
                  @click="triggerRecompute"
                >
                  Recompute <kbd>⌘K</kbd>
                </button>

                <button
                  type="button"
                  class="tool-button"
                  :disabled="!sessionPayload"
                  :aria-pressed="devicePxMs <= fineMsPerDevicePx * 1.05"
                  aria-keyshortcuts="Z"
                  title="Toggle fine zoom 0.5 ms/px (Z)"
                  @click="toggleFineZoom"
                >
                  Fine <kbd>Z</kbd>
                </button>

                <fieldset class="segmented" aria-label="Stage display">
                  <button
                    type="button"
                    :aria-pressed="visualMode === 'wave'"
                    title="Waveform only"
                    @click="visualMode = 'wave'"
                  >
                    Wave
                  </button>
                  <button
                    type="button"
                    :aria-pressed="visualMode === 'spec'"
                    title="Spectrogram only"
                    @click="visualMode = 'spec'"
                  >
                    Spec
                  </button>
                  <button
                    type="button"
                    :aria-pressed="visualMode === 'both'"
                    title="Both spectrogram and waveform"
                    @click="visualMode = 'both'"
                  >
                    Both
                  </button>
                </fieldset>
              </template>

              <template v-else>
                <fieldset class="segmented" aria-label="Audition filter">
                  <button
                    v-for="opt in AUDITION_FILTER_OPTIONS"
                    :key="opt.id"
                    type="button"
                    :aria-pressed="auditionFilter === opt.id"
                    :title="opt.title"
                    @click="auditionFilter = opt.id"
                  >
                    {{ opt.label }}
                  </button>
                </fieldset>

                <button
                  type="button"
                  class="tool-button"
                  :aria-pressed="preferences.cacheAuditionFilters"
                  title="Pre-cache audition filters for the active window"
                  @click="toggleCacheAuditionFilters"
                >
                  Cache
                </button>

                <button
                  type="button"
                  class="tool-button"
                  :disabled="!activeOffer"
                  :aria-pressed="holdingAlt"
                  aria-keyshortcuts="Alt"
                  title="Hold Alt to compare current beats with suggestion A/B"
                  @pointerdown="beginHoldCompare()"
                  @pointerup="endHoldCompare()"
                  @pointerleave="endHoldCompare()"
                  @pointercancel="endHoldCompare()"
                >
                  A/B <kbd>Alt</kbd>
                </button>

                <button
                  type="button"
                  class="tool-button"
                  :disabled="!sessionPayload"
                  :aria-pressed="Boolean(flamSavedState)"
                  aria-keyshortcuts="G"
                  title="Flam check: ±750 ms at 0.25× with clicks around selection (G)"
                  @click="toggleFlamCheck"
                >
                  Flam <kbd>G</kbd>
                </button>
              </template>
            </div>

            <p v-if="error" class="notice-bar notice-bar--error" role="alert">
              <span class="health-dot" aria-hidden="true"></span>
              <span class="notice-bar-text">{{ error }}</span>
              <button type="button" class="tool-button" @click="error = ''">Dismiss</button>
            </p>
            <p v-else-if="notice" class="notice-bar" role="status">
              <span class="health-dot" aria-hidden="true"></span>
              <span class="notice-bar-text">{{ notice }}</span>
              <button type="button" class="tool-button" @click="notice = ''">Dismiss</button>
            </p>
            <p v-else-if="silenceMs !== undefined" class="notice-bar" role="status">
              <span class="health-dot" aria-hidden="true"></span>
              <span class="notice-bar-text">
                Near-silence detected at {{ formatSourceTime(silenceMs) }}; check quiet intro or break boundaries.
              </span>
            </p>
          </header>

          <TempoSegmentStrip
            v-if="sessionPayload && durationSec > 0"
            :duration-sec="durationSec"
            :segments="segments"
            :spans="spans"
            :inbox-spans="inboxSpans"
            :selected-segment-id="selectedSegmentId"
            :active-range="activeRange"
            :view="view"
            :stage-width-px="stageWidth"
            :playhead-ms="playheadMs"
            @select-segment="onSelectSegmentFromStrip"
            @toggle-segment-keep="onToggleSegmentKeep"
            @move-boundary="onMoveSegmentBoundary"
            @update:view="setView"
            @locate="(ms) => seek(ms)"
          />

          <TempoStage
            v-if="sessionPayload && mixBuffer"
            ref="stageRef"
            :buffer="mixBuffer"
            :source-sample-rate="sourceSampleRate"
            :bounds="bounds"
            :view="view"
            :visual-mode="visualMode"
            :segments="segments"
            :spans="spans"
            :beats="beats"
            :unbeats="unbeats"
            :sounds="sounds"
            :grid-fit="gridFit"
            :selection="selection"
            :active-range="activeRange"
            :snap-candidates="snapCandidates"
            :offer-preview="offerPreview"
            :ab-comparing="abComparing"
            :playhead-ms="playheadMs"
            :playhead-motion="motion"
            :loop-region="loopRegion"
            :looping="looping"
            @resize="onStageResize"
            @update:view="setView"
            @manual-pan="follow = false"
            @hover-time="hoverTimeMs = $event"
            @select="handleStageSelect"
            @range-select="handleRangeSelect"
            @place-beat="placeBeatAt"
            @place-unbeat="(sec) => placeUnbeatAt(sec, false)"
            @apply-snap="applySnapCandidate"
            @seek="seek"
            @locate="onLocate"
          />
          <div v-else class="stage-empty">
            {{ openingSong || audioState === "loading" ? "Preparing song…" : "Select a song from the workspace" }}
          </div>
        </section>
      </template>

      <template #right>
        <div class="tempo-right-pane">
          <PanelSection
            v-if="displayOffers.length > 0"
            id="tempo-suggestions"
            title="Suggestions"
            :collapsible="false"
          >
            <template #meta>{{ displayOffers.length }}</template>
            <template v-if="displayOffers.length > 1" #actions>
              <button
                type="button"
                class="tool-button"
                aria-keyshortcuts="Backslash"
                title="Cycle suggestion options (\)"
                @click="cycleOfferOption"
              >
                Cycle <kbd>\</kbd>
              </button>
            </template>

            <div class="tempo-offer-list">
              <div
                v-for="item in displayOffers"
                :key="`${item.scopeLabel}-${item.spanLabel}-${item.optionLabel ?? item.offer.title}`"
                class="tempo-offer-item"
                :class="{
                  'is-selected': activeOffer?.id === item.offer.id,
                  'is-stale': item.offer.status === 'stale',
                }"
              >
                <div class="tempo-offer-head">
                  <span v-if="item.optionLabel" class="tempo-offer-badge">
                    {{ item.optionLabel }}
                  </span>
                  <span
                    v-if="item.offer.status === 'stale'"
                    class="tempo-offer-badge tempo-offer-badge--stale"
                  >
                    Stale
                  </span>
                  <span class="tempo-offer-scope">{{ item.scopeLabel }}</span>
                  <span class="tempo-offer-span">{{ item.spanLabel }}</span>
                </div>
                <button
                  type="button"
                  class="tempo-offer-title-btn"
                  :aria-pressed="activeOffer?.id === item.offer.id"
                  @click="selectedOfferId = item.offer.id"
                >
                  {{ item.offer.title }}
                </button>
                <p class="tempo-offer-summary">{{ item.offer.consequenceSummary }}</p>
                <p v-if="item.offer.status === 'stale'" class="tempo-offer-conflict">
                  {{
                    sanitizeUserFacingText(
                      item.offer.conflicts[0]?.message ??
                        "Outdated after newer edits in this section.",
                    )
                  }}
                </p>
                <p
                  v-for="(note, nIdx) in item.offer.advisoryNotes"
                  :key="nIdx"
                  class="tempo-offer-advisory"
                >
                  {{ note }}
                </p>
                <div class="tempo-offer-actions">
                  <button
                    type="button"
                    class="tool-button"
                    :aria-pressed="holdingAlt && activeOffer?.id === item.offer.id"
                    title="Hold to ear-compare suggestion (Alt)"
                    @pointerdown.stop="beginHoldCompare(item.offer.id)"
                    @pointerup.stop="endHoldCompare()"
                    @pointerleave.stop="endHoldCompare()"
                    @pointercancel.stop="endHoldCompare()"
                  >
                    Hold A/B <kbd>Alt</kbd>
                  </button>
                  <button
                    type="button"
                    class="tool-button tool-button--primary"
                    :disabled="item.offer.status !== 'valid' || updatingEdit"
                    title="Accept suggestion (Tab)"
                    @click.stop="handleAcceptOffer(item.offer.id)"
                  >
                    Accept <kbd>Tab</kbd>
                  </button>
                  <button
                    v-if="item.offer.status === 'stale'"
                    type="button"
                    class="tool-button"
                    :disabled="recomputing"
                    title="Recompute updated suggestion (⌘K)"
                    @click.stop="triggerRecompute"
                  >
                    Recompute <kbd>⌘K</kbd>
                  </button>
                  <button
                    type="button"
                    class="tool-button"
                    title="Dismiss suggestion (⇧Tab)"
                    @click.stop="handleRejectOffer(item.offer.id)"
                  >
                    Dismiss <kbd>⇧Tab</kbd>
                  </button>
                </div>
              </div>
            </div>
          </PanelSection>

          <PanelSection id="tempo-selection" :title="selectionPanelTitle">
            <template v-if="selection.kind === 'beat' && selectedBeat">
              <div class="prop-row">
                <span>Time</span>
                <span class="data">{{ formatSourceTime(selectedBeat.timeSec * 1000, 3) }}</span>
              </div>
              <div class="prop-row">
                <span>Sample</span>
                <span class="data">
                  n {{ nearestSample(selectedBeat.timeSec * 1000, sourceSampleRate) }}
                </span>
              </div>
              <div v-if="selectedBeat.snapRole" class="prop-row">
                <span>Acoustic role</span>
                <span>
                  {{ SNAP_ROLE_LABELS[selectedBeat.snapRole] }}
                  <template v-if="selectedBeat.snapFamily">
                    · {{ SNAP_FAMILY_LABELS[selectedBeat.snapFamily] }}
                  </template>
                </span>
              </div>

              <div class="tempo-inspector-group">
                <span class="toolbar-label">Nudge, ms</span>
                <div class="segmented tempo-full-segmented">
                  <button
                    v-for="step in nudgeStepsMs"
                    :key="step"
                    type="button"
                    :title="`Move beat ${step > 0 ? `+${step}` : `−${-step}`} ms`"
                    @click="nudgeSelection(step)"
                  >
                    {{ step > 0 ? `+${step}` : `−${-step}` }}
                  </button>
                </div>
              </div>

              <div class="tempo-action-grid">
                <button
                  type="button"
                  class="tool-button"
                  title="Move beat 1 sample earlier (,)"
                  @click="nudgeSelectionFrames(-1)"
                >
                  −1 smp <kbd>,</kbd>
                </button>
                <button
                  type="button"
                  class="tool-button"
                  title="Move beat 1 sample later (.)"
                  @click="nudgeSelectionFrames(1)"
                >
                  +1 smp <kbd>.</kbd>
                </button>
                <button
                  type="button"
                  class="tool-button"
                  aria-keyshortcuts="X"
                  title="Loop ±500 ms around beat (X)"
                  @click="loopAroundEntity(selectedBeat.timeSec)"
                >
                  Loop ±500 ms <kbd>X</kbd>
                </button>
                <button
                  type="button"
                  class="tool-button"
                  aria-keyshortcuts="Delete"
                  title="Delete beat (Delete)"
                  @click="deleteSelectedEntity"
                >
                  Delete
                </button>
              </div>

              <div class="tempo-inspector-group">
                <span class="toolbar-label">
                  Snap to sound
                  <template v-if="snapsLoading"> · scanning</template>
                </span>
                <div v-if="snapCandidates.length > 0" class="tempo-snap-list">
                  <button
                    v-for="(cand, idx) in snapCandidates"
                    :key="`${cand.role}-${cand.targetSec}-${idx}`"
                    type="button"
                    class="tempo-snap-row"
                    :aria-keyshortcuts="idx < 4 ? String(idx + 1) : undefined"
                    @click="applySnapCandidate(cand)"
                  >
                    <kbd v-if="idx < 4">{{ idx + 1 }}</kbd>
                    <span class="tempo-snap-row-label">{{ cand.label }}</span>
                    <span class="tempo-snap-row-role">{{ SNAP_ROLE_LABELS[cand.role] }}</span>
                    <span class="tempo-snap-row-delta">{{ formatSignedMs(cand.deltaMs, 1) }}</span>
                  </button>
                </div>
                <p v-else class="tempo-pane-empty">No nearby acoustic onset within ±120 ms.</p>
              </div>
            </template>

            <template v-else-if="selection.kind === 'unbeat' && selectedUnbeat">
              <div class="prop-row">
                <span>Time</span>
                <span class="data">{{ formatSourceTime(selectedUnbeat.timeSec * 1000, 3) }}</span>
              </div>
              <div class="prop-row">
                <span>Sample</span>
                <span class="data">
                  n {{ nearestSample(selectedUnbeat.timeSec * 1000, sourceSampleRate) }}
                </span>
              </div>
              <div class="tempo-inspector-group">
                <span class="toolbar-label">Nudge, ms</span>
                <div class="segmented tempo-full-segmented">
                  <button
                    v-for="step in nudgeStepsMs"
                    :key="step"
                    type="button"
                    @click="nudgeSelection(step)"
                  >
                    {{ step > 0 ? `+${step}` : `−${-step}` }}
                  </button>
                </div>
              </div>
              <div class="tempo-action-grid">
                <button
                  type="button"
                  class="tool-button"
                  aria-keyshortcuts="Delete"
                  title="Remove unbeat cue (Delete)"
                  @click="deleteSelectedEntity"
                >
                  Delete
                </button>
              </div>
            </template>

            <template v-else-if="selection.kind === 'sound' && selectedSound">
              <div class="prop-row">
                <span>Time</span>
                <span class="data">{{ formatSourceTime(selectedSound.timeSec * 1000, 3) }}</span>
              </div>
              <div class="prop-row">
                <span>Grid offset</span>
                <span class="data">
                  {{
                    selectedSoundGridFit && Number.isFinite(selectedSoundGridFit.residualMs)
                      ? formatSignedMs(selectedSoundGridFit.residualMs, 1)
                      : "—"
                  }}
                </span>
              </div>
              <div class="tempo-action-grid">
                <button
                  type="button"
                  class="tool-button"
                  aria-keyshortcuts="G"
                  title="Flam check: ±750 ms at 0.25× around sound (G)"
                  @click="toggleFlamCheck"
                >
                  Flam check <kbd>G</kbd>
                </button>
                <button
                  type="button"
                  class="tool-button tool-button--primary"
                  @click="placeBeatAt(selectedSound.timeSec)"
                >
                  Place beat here
                </button>
                <button
                  v-if="selectedSound.source === 'user'"
                  type="button"
                  class="tool-button"
                  @click="deleteSelectedEntity"
                >
                  Delete
                </button>
              </div>
            </template>

            <template v-else-if="selection.kind === 'range' && activeRange">
              <div class="prop-row">
                <span>Span <kbd>[</kbd> <kbd>]</kbd></span>
                <span class="data">{{ formatSecSpan(activeRange.t0, activeRange.t1, 2) }}</span>
              </div>
              <div class="prop-row">
                <span>Duration</span>
                <span class="data">{{ (activeRange.t1 - activeRange.t0).toFixed(2) }} s</span>
              </div>

              <div class="tempo-action-grid">
                <button
                  type="button"
                  class="tool-button"
                  :aria-pressed="looping"
                  aria-keyshortcuts="L"
                  @click="toggleLoop"
                >
                  Loop <kbd>L</kbd>
                </button>
                <button
                  type="button"
                  class="tool-button"
                  :aria-pressed="isRangeAllKept"
                  aria-keyshortcuts="V"
                  @click="toggleKeepSelection"
                >
                  Keep <kbd>V</kbd>
                </button>
                <button
                  type="button"
                  class="tool-button"
                  :aria-pressed="isRangeAllFree"
                  aria-keyshortcuts="R"
                  @click="toggleFreeSelection"
                >
                  Free <kbd>R</kbd>
                </button>
                <button
                  type="button"
                  class="tool-button"
                  :class="{ 'tool-button--primary': cuesDirty }"
                  aria-keyshortcuts="Meta+K Control+K"
                  @click="triggerRecompute"
                >
                  Recompute <kbd>⌘K</kbd>
                </button>
              </div>

              <div class="tempo-inspector-group">
                <span class="toolbar-label">Shift beats in range, ms</span>
                <div class="segmented tempo-full-segmented">
                  <button
                    v-for="step in rangeShiftStepsMs"
                    :key="step"
                    type="button"
                    @click="shiftBeatsInRange(step)"
                  >
                    {{ step > 0 ? `+${step}` : `−${-step}` }}
                  </button>
                </div>
              </div>

              <div class="tempo-action-grid">
                <button type="button" class="tool-button" @click="promoteRangeToSegment">
                  Promote to Segment
                </button>
                <button type="button" class="tool-button" @click="deleteBeatsInRange">
                  Delete beats in range
                </button>
              </div>
            </template>

            <template v-else-if="selectedSegment">
              <div class="prop-row">
                <span>Span</span>
                <span class="data">
                  {{ formatSecSpan(selectedSegment.t0, selectedSegment.t1, 2) }}
                </span>
              </div>
              <div class="prop-row">
                <span>Duration</span>
                <span class="data">
                  {{ (selectedSegment.t1 - selectedSegment.t0).toFixed(2) }} s
                </span>
              </div>
              <div class="prop-row">
                <span>Regime</span>
                <fieldset class="segmented" aria-label="Segment regime">
                  <button
                    v-for="reg in (['auto', 'free', 'break'] as const)"
                    :key="reg"
                    type="button"
                    :aria-pressed="selectedSegment.regime === reg"
                    @click="setSegmentRegime(selectedSegment, reg)"
                  >
                    {{ SEGMENT_REGIME_LABELS[reg] }}
                  </button>
                </fieldset>
              </div>

              <div class="tempo-action-grid">
                <button
                  type="button"
                  class="tool-button"
                  :aria-pressed="selectedSegment.kept"
                  aria-keyshortcuts="V"
                  @click="onToggleSegmentKeep(selectedSegment.id, !selectedSegment.kept)"
                >
                  Keep <kbd>V</kbd>
                </button>
                <button
                  type="button"
                  class="tool-button"
                  :aria-pressed="selectedSegment.regime === 'free'"
                  aria-keyshortcuts="R"
                  @click="
                    setSegmentRegime(
                      selectedSegment,
                      selectedSegment.regime === 'free' ? 'auto' : 'free',
                    )
                  "
                >
                  Free <kbd>R</kbd>
                </button>
                <button
                  type="button"
                  class="tool-button"
                  aria-keyshortcuts="S"
                  @click="splitActiveSegment"
                >
                  Split at cursor <kbd>S</kbd>
                </button>
                <button
                  type="button"
                  class="tool-button"
                  :disabled="segments.length < 2 || segments[0]?.id === selectedSegment.id"
                  @click="mergeSelectedSegment('prev')"
                >
                  Merge prev
                </button>
                <button
                  type="button"
                  class="tool-button"
                  :disabled="segments.length < 2 || segments.at(-1)?.id === selectedSegment.id"
                  aria-keyshortcuts="M"
                  @click="mergeSelectedSegment('next')"
                >
                  Merge next <kbd>M</kbd>
                </button>
              </div>
            </template>

            <p v-else class="tempo-pane-empty">
              Select a beat, segment, or drag a range (<kbd>[</kbd> / <kbd>]</kbd>) to fine-tune.
            </p>
          </PanelSection>
        </div>
      </template>

      <template #status>
        <span class="status-item">
          Zoom <b>{{ zoomLabel }}</b>
        </span>
        <span class="status-item">
          Rate <b>{{ rate }}×</b>
        </span>
        <span class="status-item">
          Loop
          <b>
            {{
              looping
                ? `${formatShortTimeSec(loopRegion.startMs / 1000, 1)}–${formatShortTimeSec(loopRegion.endMs / 1000, 1)}`
                : "off"
            }}
          </b>
        </span>
        <span v-if="activeSongSummary && activeSongSummary.segmentCount > 0" class="status-item">
          Kept <b>{{ activeSongSummary.keptSegmentCount }}/{{ activeSongSummary.segmentCount }}</b>
        </span>
        <span
          v-if="workspaceFolderName"
          class="status-item status-optional status-item--end status-item--path"
          :title="workspaceDir ?? ''"
        >
          {{ workspaceFolderName }}
        </span>
      </template>
    </WorkspaceFrame>
  </main>
</template>

<style scoped>
.tempo-bench {
  height: var(--active-viewport-height);
  min-height: 0;
  overflow: hidden;
  animation: none;
}

.tempo-mode-title {
  padding: 0 4px;
  color: var(--ink);
  font-size: var(--text-xs);
  font-weight: 650;
  letter-spacing: 0.01em;
}

.tempo-file-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tempo-popover-anchor {
  position: relative;
}

.tempo-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  display: grid;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--seam);
  border-radius: var(--radius-control);
  background: var(--surface-2);
  box-shadow: var(--shadow-control);
}

.tempo-folder-popover {
  width: 280px;
}

.tempo-export-popover {
  min-width: 210px;
  gap: 2px;
  padding: 4px;
}

.tempo-popover-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
}

.tempo-menu-item {
  display: flex;
  width: 100%;
  min-height: var(--control-h-sm);
  align-items: center;
  padding: 0 8px;
  color: var(--ink-secondary);
  border: 0;
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  font-size: var(--text-xs);
  font-weight: 560;
  text-align: left;
  white-space: nowrap;
}

.tempo-menu-item:hover {
  color: var(--ink);
  background: var(--surface-3);
}

.tempo-transport {
  margin: 0;
  padding: 0;
  border: 0;
}

.tool-button--play.is-playing {
  color: oklch(100% 0 0);
  background: var(--success-fill);
}

.tempo-click-slider {
  width: 52px;
  min-height: var(--control-h-sm);
  margin: 0;
  padding: 0;
  accent-color: var(--signal-fill);
}

.tempo-counter .time-counter-main {
  min-width: calc(9ch + 0.2em);
}

.tempo-counter .time-counter-sub {
  min-width: 10ch;
}

.tempo-status {
  font-size: var(--text-xs);
  white-space: nowrap;
}

/* Left pane split cleanly so neither Songs nor Inbox starves the other */
.tempo-left-pane {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}

.tempo-left-section {
  display: flex;
  min-height: 0;
  flex: 1 1 50%;
  flex-direction: column;
  overflow: hidden;
}

.tempo-left-section.is-closed {
  flex: 0 0 auto;
}

.tempo-scroll-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.tempo-list-row {
  display: grid;
  grid-template-columns: 7px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: var(--row-h);
  padding: 0 8px 0 10px;
  color: var(--ink-secondary);
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.tempo-list-row:hover {
  color: var(--ink);
  background: var(--surface-hover);
}

.tempo-list-row.is-active {
  color: var(--ink);
  background: var(--signal-soft);
  box-shadow: inset 2px 0 0 var(--signal);
}

.tempo-song-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-muted);
}

.tempo-song-dot.is-ready {
  background: var(--success);
}

.tempo-song-dot.is-warn {
  background: var(--warning);
}

.tempo-song-dot.is-signal {
  background: var(--signal);
}

.tempo-row-title {
  min-width: 0;
  overflow: hidden;
  font-size: var(--text-xs);
  font-weight: 560;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tempo-row-meta {
  color: var(--ink-muted);
  font-family: var(--font-data);
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.tempo-inbox-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: var(--row-h);
  padding: 0 8px 0 10px;
  color: var(--ink-secondary);
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.tempo-inbox-row.is-priority-high {
  box-shadow: inset 2px 0 0 var(--danger);
}

.tempo-inbox-row.is-priority-medium {
  box-shadow: inset 2px 0 0 var(--warning);
}

.tempo-inbox-row.is-priority-low {
  box-shadow: inset 2px 0 0 var(--signal);
}

.tempo-inbox-row:hover {
  color: var(--ink);
  background: var(--surface-hover);
}

.tempo-inbox-row.is-active {
  color: var(--ink);
  background: var(--signal-soft);
}

.tempo-inbox-time {
  color: var(--ink);
  font-family: var(--font-data);
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.tempo-inbox-reason {
  min-width: 0;
  overflow: hidden;
  color: var(--ink-secondary);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tempo-pane-empty {
  margin: 0;
  padding: 8px 10px;
  color: var(--ink-muted);
  font-size: var(--text-xs);
  line-height: 1.45;
}

/* Main view */
.tempo-main {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  background: var(--well);
}

.tempo-hud {
  flex: 0 0 auto;
}

.tempo-song-identity {
  flex: 1 1 0;
  min-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tempo-song-identity strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tempo-onboarding {
  display: grid;
  flex: 1 1 auto;
  padding: 24px;
  place-items: center;
  background: var(--well);
}

.tempo-onboarding-box {
  display: grid;
  max-width: 480px;
  width: 100%;
  gap: 12px;
  padding: 20px;
  border: 1px solid var(--seam);
  background: var(--surface-1);
}

.tempo-onboarding-box h1 {
  margin: 0;
  font-family: var(--font-data);
  font-size: var(--text-lg);
  font-weight: 650;
}

.tempo-onboarding-box > p {
  margin: 0;
  color: var(--ink-secondary);
  font-size: var(--text-sm);
  line-height: 1.5;
}

.tempo-onboarding-form {
  display: grid;
  gap: 8px;
}

.tempo-onboarding-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* Right pane contextual inspector */
.tempo-right-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.tempo-offer-list {
  display: grid;
  margin: -8px;
}

.tempo-offer-item {
  display: grid;
  gap: 5px;
  padding: 8px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
}

.tempo-offer-item:last-child {
  border-bottom: 0;
}

.tempo-offer-item.is-selected {
  background: var(--signal-soft);
  box-shadow: inset 2px 0 0 var(--signal);
}

.tempo-offer-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: var(--text-2xs);
}

.tempo-offer-badge {
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--ink);
  background: var(--surface-3);
  font-family: var(--font-data);
  font-weight: 600;
}

.tempo-offer-badge--stale {
  color: var(--warning);
  border: 1px solid var(--warning);
  background: transparent;
}

.tempo-offer-conflict {
  margin: 0;
  padding-left: 6px;
  border-left: 2px solid var(--danger);
  color: var(--ink-secondary);
  font-size: var(--text-2xs);
  line-height: 1.4;
}

.tempo-offer-scope {
  color: var(--ink-secondary);
  font-weight: 600;
}

.tempo-offer-span {
  margin-left: auto;
  color: var(--ink-muted);
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
}

.tempo-offer-title-btn {
  display: flex;
  min-height: var(--control-h-sm);
  align-items: center;
  padding: 0;
  color: var(--ink);
  border: 0;
  background: transparent;
  cursor: pointer;
  font-size: var(--text-sm);
  font-weight: 620;
  text-align: left;
}

.tempo-offer-summary {
  margin: 0;
  color: var(--ink-secondary);
  font-size: var(--text-xs);
  line-height: 1.4;
}

.tempo-offer-advisory {
  margin: 0;
  padding-left: 6px;
  border-left: 2px solid var(--warning);
  color: var(--warning);
  font-size: var(--text-2xs);
  line-height: 1.4;
}

.tempo-offer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding-top: 2px;
}

.tempo-inspector-group {
  display: grid;
  gap: 4px;
}

.tempo-full-segmented {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
}

.tempo-full-segmented button {
  min-width: 0;
  padding: 0 4px;
}

.tempo-action-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tempo-snap-list {
  display: grid;
  border-top: 1px solid var(--line);
}

.tempo-snap-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: var(--row-h);
  padding: 0 4px;
  color: var(--ink-secondary);
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  font-size: var(--text-xs);
  text-align: left;
}

.tempo-snap-row:hover {
  color: var(--ink);
  background: var(--surface-hover);
}

.tempo-snap-row kbd {
  padding: 0 4px;
  color: var(--signal);
  background: var(--field);
  font-family: var(--font-data);
  font-size: var(--text-2xs);
}

.tempo-snap-row-label {
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-weight: 560;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tempo-snap-row-role {
  color: var(--ink-secondary);
  font-size: var(--text-2xs);
}

.tempo-snap-row-delta {
  color: var(--signal);
  font-family: var(--font-data);
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
}
</style>

<style>
.tempo-left-section > .panel-section-body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}
</style>
