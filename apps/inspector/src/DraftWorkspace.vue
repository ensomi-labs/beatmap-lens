<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { deinterleave, draftJson, draftRequest } from "./draft/client";
import {
  type Beat,
  type Boundary,
  beatsAfter,
  computeGridFit,
  DRAFT_GRID_FIT_OPTIONS,
  type DraftAudio,
  type DraftProviders,
  extractDraftMeta,
  formatConsequences,
  type GridFitItem,
  isNonBinaryDivisor,
  type PatchOffer,
  projectRedLines,
  rankTroubleSpans,
  type SessionState,
  type SoundAnchor,
  type Span,
  type Statement,
  signedGridResidualMs,
  sortedEntities,
  type TraceEvent,
} from "./draft/ensomi-contract";
import type { RecomputeOutcome } from "./draft/recompute";
import { DraftSession } from "./draft/session";
import {
  beatsCollapse,
  overviewHeat,
  runBands,
  statementLabel,
  statementSpan,
  type TimeWindow,
  tOf,
  whiskerPx,
  xOf,
} from "./draft/stage";
import {
  demoAudio,
  demoBeats,
  demoPcm,
  demoProviders,
  demoSampleRate,
  demoSounds,
  demoTitle,
} from "./draft/synthetic";
import PanelSection from "./layout/PanelSection.vue";
import type { PaneSpec } from "./layout/pane-layout";
import WorkspaceFrame from "./layout/WorkspaceFrame.vue";
import { TimingAudioEngine } from "./timing/audio-engine";
import { formatSourceTime } from "./timing/time-view";
import { peak } from "./timing/waveform";
import type { WorkspaceMode } from "./workspace-mode";

/**
 * The Draft workspace: a listener reviews a machine draft of a track's beats against the sounds
 * heard in it. Separate from Timing, whose blind protocol it never touches. Two action systems
 * stay apart: direct edits change beats at once; statements record what the listener claims about
 * a span and change nothing. A recompute runs only when the listener asks for one (Cmd+K), and
 * its offers are compared by ear in Audition mode. Every time is on the original mix.
 */
defineEmits<{ "change-mode": [mode: WorkspaceMode] }>();

const tourPane: PaneSpec = { id: "draft-tour", label: "Tour", defaultSize: 248, min: 180, max: 420 };
const inspectorPane: PaneSpec = {
  id: "draft-inspector",
  label: "Draft inspector",
  defaultSize: 320,
  min: 268,
  max: 520,
};

type DraftMode = "edit" | "audition";
const auditionViews = [
  { key: "mix", label: "Full mix" },
  { key: "percussive", label: "Percussive" },
  { key: "harmonic", label: "Harmonic" },
  { key: "low", label: "Low <250" },
  { key: "mid", label: "Mid 250–2.5k" },
  { key: "high", label: "High >2.5k" },
] as const;
type AuditionView = (typeof auditionViews)[number]["key"];

const lane = { rulerTop: 16, rulerHeight: 14, top: 36, bottom: 186, soundsBottom: 226 };
const stageHeight = lane.soundsBottom;
const clientId = `page-${Math.random().toString(36).slice(2, 10)}`;

// ---------------------------------------------------------------- trace and state

const tracePath = ref<string | null>(null);
const traceStatus = ref<"none" | "saving" | "saved" | "error">("none");
let persistChain: Promise<unknown> = Promise.resolve();

function appendToTrace(events: TraceEvent[]) {
  const path = tracePath.value;
  if (!path || !events.length) return;
  traceStatus.value = "saving";
  persistChain = persistChain
    .then(() => draftJson("trace/append", { tracePath: path, events }))
    .then(
      () => {
        if (tracePath.value === path) traceStatus.value = "saved";
      },
      (error: Error) => {
        traceStatus.value = "error";
        message.value = `Trace not saved: ${error.message}`;
      },
    );
}

const session = new DraftSession((event) => appendToTrace([event]));
const state = shallowRef<SessionState>(session.state);
const undoState = ref({ undo: false, redo: false });

const draftMeta = computed(() => extractDraftMeta(state.value));
const draftAudio = computed(() => draftMeta.value.audio);
const providers = computed(() => draftMeta.value.providers);
const beats = computed<Beat[]>(() => sortedEntities(state.value.beats));
const boundaries = computed<Boundary[]>(() => sortedEntities(state.value.boundaries));
const sounds = computed<SoundAnchor[]>(() => sortedEntities(state.value.sounds));
const statements = computed<Statement[]>(() =>
  [...state.value.statements.values()].filter((statement) => statement.active),
);

function sync() {
  state.value = session.state;
  undoState.value = { undo: session.canUndo, redo: session.canRedo };
}

let idCounter = 0;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

const audioPath = ref<string | null>(null);
const busy = ref<string | null>(null);
const message = ref("");
const error = ref("");
const trackInput = ref("");
const traceInput = ref("");

// ---------------------------------------------------------------- audio

let engine: TimingAudioEngine | undefined;
const audioReady = ref(false);
const pcm = shallowRef<Float32Array[] | null>(null);
const playing = ref(false);
const looping = ref(false);
const loopSpan = ref<Span | null>(null);
const clicksOn = ref(true);
const flamSlot = ref<number | null>(null);

async function loadPcm(channels: Float32Array[], sampleRate: number) {
  if (!engine || engine.sampleRate !== sampleRate) {
    await engine?.close();
    engine = new TimingAudioEngine(sampleRate);
    engine.onEnded = () => {
      playing.value = false;
      stopFrames();
    };
    engine.setClickVolume(0.5);
  }
  engine.load(channels, channels[0]?.length ?? 0);
  pcm.value = channels;
  audioReady.value = true;
  syncClicks();
}

// ---------------------------------------------------------------- loading

function startDraft(
  audio: DraftAudio,
  draft: { beats: Beat[]; sounds: SoundAnchor[]; boundaries: Boundary[] },
  draftProviders: DraftProviders,
  path: string | null,
) {
  stop();
  tracePath.value = null;
  traceStatus.value = "none";
  session.load([]);
  session.initDraft(audio, draft, draftProviders);
  sync();
  audioPath.value = path;
  resetSelection();
  activeOfferIndex.value = 0;
  tourIndex.value = -1;
  fitView();
}

function attachTrace(path: string) {
  tracePath.value = path;
  appendToTrace(session.events);
}

async function loadDemo() {
  error.value = "";
  startDraft(
    demoAudio(),
    { beats: demoBeats(), sounds: demoSounds(), boundaries: [] },
    demoProviders,
    null,
  );
  await loadPcm([demoPcm()], demoSampleRate);
  message.value = "Demo loaded: a mock draft that misses the phase reset at 14 s.";
  try {
    const demo = await draftJson<{ audioPath: string; tracePath: string }>("demo", {});
    audioPath.value = demo.audioPath;
    attachTrace(demo.tracePath);
  } catch {
    message.value = "Demo loaded without the local service: no trace, audition views or clips.";
  }
}

interface AnalyzeResponse {
  audio: DraftAudio & { path: string };
  beats: Beat[];
  sounds: SoundAnchor[];
  boundaries: Boundary[];
  providers: DraftProviders;
  tracePath: string;
  runtime: string;
}

async function fetchPcm(audio: DraftAudio & { path: string }) {
  const response = await draftRequest("pcm", { audioPath: audio.path });
  await loadPcm(deinterleave(await response.arrayBuffer(), audio.channels), audio.sampleRate);
}

async function analyzeTrack() {
  const path = trackInput.value.trim();
  if (!path) return;
  busy.value = "Analyzing";
  error.value = "";
  try {
    const result = await draftJson<AnalyzeResponse>("analyze", { audioPath: path });
    startDraft(
      result.audio,
      { beats: result.beats, sounds: result.sounds, boundaries: result.boundaries },
      result.providers,
      result.audio.path,
    );
    attachTrace(result.tracePath);
    message.value = `${result.beats.length} beats · ${result.sounds.length} sounds · ${result.runtime}`;
    await fetchPcm(result.audio);
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally {
    busy.value = null;
  }
}

async function openTrace() {
  const path = traceInput.value.trim();
  if (!path) return;
  busy.value = "Opening";
  error.value = "";
  try {
    const response = await fetch(`/api/draft/trace?path=${encodeURIComponent(path)}`, {
      headers: { "X-Beatmap-Lens-Local": "1" },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    stop();
    session.load(body.events as TraceEvent[]);
    sync();
    tracePath.value = path;
    traceStatus.value = "saved";
    const audio = draftAudio.value;
    audioPath.value = audio?.path ?? null;
    resetSelection();
    fitView();
    if (audio?.title === demoTitle) await loadPcm([demoPcm()], demoSampleRate);
    else if (audio?.path) await fetchPcm(audio as DraftAudio & { path: string });
    message.value = `Trace opened: ${body.events.length} events`;
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally {
    busy.value = null;
  }
}

// ---------------------------------------------------------------- view

const view = ref<TimeWindow>({ startS: 0, endS: 10 });
const stageWidth = ref(1000);
const stageWrap = ref<HTMLElement | null>(null);
const duration = computed(() => draftAudio.value?.durationS ?? 0);
const zoomPresets = [
  { key: "fit", label: "Fit" },
  { key: 16, label: "16 s" },
  { key: 6, label: "6 s" },
  { key: 2, label: "2 s" },
] as const;
const zoomKey = ref<(typeof zoomPresets)[number]["key"]>("fit");

function setView(centerS: number, spanS: number) {
  const total = Math.max(duration.value, 0.5);
  const span = Math.min(spanS, total);
  const startS = Math.max(0, Math.min(total - span, centerS - span / 2));
  view.value = { startS, endS: startS + span };
}

function fitView() {
  zoomKey.value = "fit";
  view.value = { startS: 0, endS: Math.max(duration.value, 0.5) };
}

function zoom(key: (typeof zoomPresets)[number]["key"]) {
  zoomKey.value = key;
  if (key === "fit") fitView();
  else setView((view.value.startS + view.value.endS) / 2, key);
}

const x = (t: number) => xOf(t, view.value, stageWidth.value);

let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  const element = stageWrap.value;
  if (element?.clientWidth) stageWidth.value = element.clientWidth;
  if (element && typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => {
      if (element.clientWidth) stageWidth.value = element.clientWidth;
    });
    resizeObserver.observe(element);
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", releaseAb);
});

// ---------------------------------------------------------------- selection and transient edits

const selectedBeatId = ref<string | null>(null);
const selectedSoundId = ref<string | null>(null);
const selectedStatementId = ref<string | null>(null);
const selection = ref<Span | null>(null);
/** The selection is a run picked on the ruler; arrows then shift its offset. */
const runSelected = ref(false);
const cursorS = ref(0);
/** Transient previews: drawn at once, committed as one edit on release or after a settle. */
const preview = ref<{ beatId: string; t: number } | null>(null);
const runShift = ref<{ span: Span; dt: number } | null>(null);
let settleTimer: ReturnType<typeof setTimeout> | undefined;
const settleMs = 400;

function resetSelection() {
  selectedBeatId.value = null;
  selectedSoundId.value = null;
  selectedStatementId.value = null;
  selection.value = null;
  runSelected.value = false;
  preview.value = null;
  runShift.value = null;
  cursorS.value = 0;
}

const displayBeats = computed<Beat[]>(() => {
  const moved = preview.value;
  const shift = runShift.value;
  if (!moved && !shift) return beats.value;
  return beats.value
    .map((beat) => {
      if (moved && beat.id === moved.beatId) return { ...beat, t: moved.t };
      if (shift && beat.t >= shift.span.t0 && beat.t < shift.span.t1)
        return { ...beat, t: beat.t + shift.dt };
      return beat;
    })
    .sort((a, b) => a.t - b.t);
});

function commitTransient() {
  clearTimeout(settleTimer);
  settleTimer = undefined;
  const moved = preview.value;
  const shift = runShift.value;
  preview.value = null;
  runShift.value = null;
  if (moved) {
    const beat = state.value.beats.get(moved.beatId);
    if (beat && Math.abs(beat.t - moved.t) > 1e-5) {
      session.applyEdit({ op: "move_beat", id: moved.beatId, t: moved.t, source: "user" });
      sync();
    }
  }
  if (shift && Math.abs(shift.dt) > 1e-5) {
    session.applyEdit({
      op: "shift_run_offset",
      span: shift.span,
      deltaSec: shift.dt,
      source: "user",
    });
    sync();
    selection.value = { t0: shift.span.t0 + shift.dt, t1: shift.span.t1 + shift.dt };
  }
}

function settleLater() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(commitTransient, settleMs);
}

function nudge(deltaS: number) {
  if (runSelected.value && selection.value) {
    const span = runShift.value?.span ?? selection.value;
    runShift.value = { span, dt: (runShift.value?.dt ?? 0) + deltaS };
    settleLater();
    return true;
  }
  const beat = selectedBeatId.value ? state.value.beats.get(selectedBeatId.value) : undefined;
  if (!beat) return false;
  preview.value = { beatId: beat.id, t: (preview.value?.t ?? beat.t) + deltaS };
  settleLater();
  return true;
}

// ---------------------------------------------------------------- derived views

const fits = computed<GridFitItem[]>(() =>
  computeGridFit(
    state.value.sounds,
    state.value.beats,
    state.value.boundaries,
    DRAFT_GRID_FIT_OPTIONS,
  ),
);
const fitById = computed(() => new Map(fits.value.map((fit) => [fit.soundId, fit])));
const beatTimes = computed(() => beats.value.map((beat) => beat.t));
const signedResidual = (t: number) => signedGridResidualMs(t, beatTimes.value);
const trouble = computed(() =>
  rankTroubleSpans(state.value, { gridFitOptions: DRAFT_GRID_FIT_OPTIONS }),
);
const bands = computed(() => runBands(displayBeats.value, boundaries.value));
const heat = computed(() =>
  duration.value ? overviewHeat(fits.value, beats.value, duration.value, 160) : [],
);
const visible = (t: number, marginS = 0) =>
  t >= view.value.startS - marginS && t <= view.value.endS + marginS;
const visibleBeats = computed(() => displayBeats.value.filter((beat) => visible(beat.t)));
const collapsed = computed(() => beatsCollapse(displayBeats.value, view.value, stageWidth.value));
const visibleSounds = computed(() =>
  sounds.value.filter((sound) => visible(sound.t)).slice(0, 4000),
);
const userBeats = computed(() => beats.value.filter((beat) => beat.source === "user").length);

// ---------------------------------------------------------------- honesty

const draftBadge = computed(() => {
  const provider = providers.value?.beats;
  if (!provider) return null;
  if (provider.kind === "model")
    return { kind: "model", text: "Draft · BeatThis (raw, un-folded)", title: provider.name };
  if (provider.kind === "rule")
    return {
      kind: "rule",
      text: "Draft · rule pulse (BeatThis unavailable)",
      title: provider.note ?? provider.name,
    };
  return { kind: "mock", text: "Draft · synthetic demo (mock)", title: provider.name };
});
const soundsBadge = computed(() => {
  const provider = providers.value?.sounds;
  if (!provider) return null;
  return provider.kind === "mock"
    ? { kind: "mock", text: "Sounds · synthetic onsets (mock / experimental)" }
    : { kind: "experimental", text: "Sounds · onset-flux (experimental / draft)" };
});
const offerBadge = "Offer · rule mock (reserved for N1)";
const statementBadge = "Statement · recorded (not honored by raw BeatThis)";

// ---------------------------------------------------------------- statements and edits

function addStatement(kind: Statement["kind"]) {
  if (kind === "sound_at" || kind === "beat_at") {
    session.upsertStatement({ id: newId("st"), kind, t: cursorS.value });
    sync();
    message.value = `Statement ${statementLabel[kind]} recorded at ${formatSourceTime(cursorS.value * 1000, 1)}`;
    return;
  }
  const span = selection.value;
  if (!span) {
    message.value = "Select a span first: Shift+drag on the stage.";
    return;
  }
  session.upsertStatement({ id: newId("st"), kind, span });
  sync();
  message.value = `Statement ${statementLabel[kind]} recorded; nothing recomputes until you ask (⌘K).`;
}

function removeStatement(id: string) {
  session.deactivateStatement(id);
  sync();
  if (selectedStatementId.value === id) selectedStatementId.value = null;
}

function addBeat(t: number) {
  const id = newId("u");
  session.applyEdit({ op: "upsert_beat", beat: { id, t, source: "user" } });
  sync();
  selectedBeatId.value = id;
}

function removeSelected() {
  if (selectedBeatId.value) {
    session.applyEdit({ op: "remove_beat", id: selectedBeatId.value });
    sync();
    selectedBeatId.value = null;
  } else if (selectedStatementId.value) {
    removeStatement(selectedStatementId.value);
  }
}

function addReset() {
  const beat = selectedBeatId.value ? state.value.beats.get(selectedBeatId.value) : undefined;
  const t = beat?.t ?? cursorS.value;
  session.applyEdit({
    op: "upsert_boundary",
    boundary: { id: newId("bd"), t, kind: "reset", source: "user" },
  });
  sync();
  message.value = `Reset boundary at ${formatSourceTime(t * 1000, 1)}`;
}

function undo() {
  commitTransient();
  if (session.undo()) sync();
}

function redo() {
  if (session.redo()) sync();
}

// ---------------------------------------------------------------- recompute and offers

const generation = ref(0);
const recomputing = ref<{ span: Span; provider: string } | null>(null);
let recomputeAbort: AbortController | null = null;
const activeOfferIndex = ref(0);
const offers = computed<PatchOffer[]>(() =>
  [...state.value.offers.values()].filter((offer) => offer.status === "pending"),
);
const activeOffer = computed<PatchOffer | null>(() =>
  offers.value.length ? (offers.value[activeOfferIndex.value % offers.value.length] ?? null) : null,
);
const offerBeats = computed(() =>
  activeOffer.value ? beatsAfter(state.value, activeOffer.value) : null,
);
const ghostBeats = computed(() => {
  if (mode.value !== "audition" || !offerBeats.value) return [];
  const current = new Map(beats.value.map((beat) => [beat.id, beat.t]));
  return offerBeats.value.filter(
    (beat) => visible(beat.t) && Math.abs((current.get(beat.id) ?? -1) - beat.t) > 1e-6,
  );
});

async function requestOffer() {
  if (!draftAudio.value) return;
  commitTransient();
  const span = selection.value ?? { t0: view.value.startS, t1: view.value.endS };
  const current = ++generation.value;
  recomputeAbort?.abort();
  const controller = new AbortController();
  recomputeAbort = controller;
  recomputing.value = { span, provider: "rule mock" };
  session.recordSignal(span, "user_recompute", current);
  sync();
  try {
    const outcome = await draftJson<RecomputeOutcome>(
      "recompute",
      {
        client: clientId,
        request: {
          generation: current,
          basisSeq: state.value.lastSeq,
          span,
          durationS: duration.value,
          beats: beats.value,
          boundaries: boundaries.value,
          sounds: sounds.value,
          statements: statements.value,
          suppressions: state.value.suppressions,
        },
      },
      controller.signal,
    );
    if (current !== generation.value) return;
    if (outcome.status === "ok") {
      session.recordOfferBatch(outcome.offers, {
        kind: outcome.providerKind,
        id: outcome.provider,
      });
      sync();
      activeOfferIndex.value = 0;
      const surfaced = offers.value.length;
      message.value = surfaced
        ? `${surfaced} offer${surfaced === 1 ? "" : "s"} from the rule mock; compare them in Audition (2).`
        : "The rule mock has no offer for this span.";
    } else message.value = `Recompute ${outcome.status}.`;
  } catch (failure) {
    if ((failure as Error).name === "AbortError") message.value = "Recompute cancelled.";
    else error.value = (failure as Error).message;
  } finally {
    if (current === generation.value) {
      recomputing.value = null;
      recomputeAbort = null;
    }
  }
}

function cancelRecompute() {
  if (!recomputeAbort) return false;
  recomputeAbort.abort();
  generation.value++;
  recomputing.value = null;
  recomputeAbort = null;
  message.value = "Recompute cancelled.";
  return true;
}

/** While Alt is held the offer being heard must not change under the listener. */
function guardAb(): boolean {
  if (!abHeld.value) return false;
  message.value = "Release Alt before changing the offer you are hearing.";
  return true;
}

function cycleOffer() {
  if (guardAb() || offers.value.length < 2) return;
  activeOfferIndex.value = (activeOfferIndex.value + 1) % offers.value.length;
}

function acceptOffer(offer = activeOffer.value) {
  if (guardAb() || !offer) return;
  const consequenceSummary = formatConsequences(offer, state.value);
  const outcome = session.acceptOffer(offer.id);
  sync();
  if (!outcome.ok) {
    error.value = `Blocked by conflict: ${outcome.conflicts.map((conflict) => conflict.message).join(" · ")}`;
    return;
  }
  error.value = "";
  activeOfferIndex.value = 0;
  message.value = `Accepted: ${offer.summary} (${consequenceSummary}); siblings superseded.`;
}

function rejectOffer(offer = activeOffer.value) {
  if (guardAb() || !offer) return;
  session.rejectOffer(offer.id);
  sync();
  activeOfferIndex.value = 0;
  message.value = `Rejected and suppressed: ${offer.summary}`;
}

// ---------------------------------------------------------------- audition

const mode = ref<DraftMode>("edit");
const abHeld = ref(false);
const auditionView = ref<AuditionView>("mix");
const bandState = ref<"idle" | "loading" | "playing" | "error">("idle");
let bandAudio: HTMLAudioElement | null = null;
let bandUrl: string | null = null;

function setMode(next: DraftMode) {
  commitTransient();
  releaseAb();
  mode.value = next;
}

function pressAb() {
  if (mode.value !== "audition" || !offerBeats.value || abHeld.value) return;
  abHeld.value = true;
  syncClicks();
}

function releaseAb() {
  if (!abHeld.value) return;
  abHeld.value = false;
  syncClicks();
}

function syncClicks() {
  if (!engine) return;
  if (flamSlot.value !== null) {
    engine.setClicks([flamSlot.value * 1000]);
    return;
  }
  const beats = abHeld.value && offerBeats.value ? offerBeats.value : displayBeats.value;
  engine.setClicks(clicksOn.value ? beats.map((beat) => beat.t * 1000) : null);
}

watch([clicksOn, flamSlot, beats], syncClicks);

function auditionSpan(): Span {
  const span = selection.value ?? loopSpan.value ?? { t0: view.value.startS, t1: view.value.endS };
  return { t0: span.t0, t1: Math.min(span.t1, span.t0 + 30) };
}

function stopBand() {
  bandAudio?.pause();
  bandAudio = null;
  if (bandUrl) URL.revokeObjectURL(bandUrl);
  bandUrl = null;
  if (bandState.value !== "error") bandState.value = "idle";
}

async function setAuditionView(next: AuditionView) {
  auditionView.value = next;
  stopBand();
  bandState.value = "idle";
  if (next === "mix") return;
  if (!audioPath.value) {
    message.value = "Audition views need the local service and a track on disk.";
    return;
  }
  const span = auditionSpan();
  bandState.value = "loading";
  try {
    const response = await draftRequest("audition-view", {
      audioPath: audioPath.value,
      startSec: span.t0,
      endSec: span.t1,
      view: next,
    });
    if (auditionView.value !== next) return;
    stop();
    bandUrl = URL.createObjectURL(await response.blob());
    bandAudio = new Audio(bandUrl);
    bandAudio.loop = true;
    await bandAudio.play();
    bandState.value = "playing";
    message.value = `Listening to ${next} ${formatSourceTime(span.t0 * 1000)}–${formatSourceTime(span.t1 * 1000)} (listening only; times stay on the mix).`;
  } catch (failure) {
    bandState.value = "error";
    error.value = (failure as Error).message;
  }
}

function flamCheck() {
  const unexplained = fits.value.filter((fit) => fit.status === "unexplained");
  const selected = unexplained.find((fit) => fit.soundId === selectedSoundId.value);
  const target =
    selected ??
    unexplained
      .filter((fit) => visible(fit.t))
      .sort((a, b) => Math.abs(a.t - cursorS.value) - Math.abs(b.t - cursorS.value))[0];
  if (!target) {
    message.value = "No off-grid sound in view to check.";
    return;
  }
  const signedMs = signedResidual(target.t);
  const slot = target.t - signedMs / 1000;
  flamSlot.value = slot;
  selectedSoundId.value = target.soundId;
  loopSpan.value = { t0: Math.max(0, slot - 0.4), t1: slot + 0.4 };
  looping.value = true;
  message.value = `Flam check: the click marks the nearest grid slot; the sound is ${Math.abs(signedMs).toFixed(1)} ms ${signedMs > 0 ? "late" : "early"}.`;
  void play();
}

// ---------------------------------------------------------------- transport

const playheadLine = ref<SVGLineElement | null>(null);
const counterMain = ref<HTMLElement | null>(null);
let frame: number | undefined;

function stopFrames() {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
}

function drawFrame() {
  const ms = engine?.shownAt(performance.now(), 0);
  if (ms !== undefined) {
    const t = ms / 1000;
    if (playheadLine.value) playheadLine.value.style.transform = `translateX(${x(t)}px)`;
    if (counterMain.value) counterMain.value.textContent = formatSourceTime(ms, 1);
    if (!looping.value && (t > view.value.endS || t < view.value.startS))
      setView(t + (view.value.endS - view.value.startS) * 0.4, view.value.endS - view.value.startS);
  }
  frame = requestAnimationFrame(drawFrame);
}

async function play() {
  if (!engine || !audioReady.value) return;
  stopBand();
  const loop =
    looping.value && loopSpan.value
      ? { startMs: loopSpan.value.t0 * 1000, endMs: loopSpan.value.t1 * 1000 }
      : null;
  const started = await engine.play({
    fromMs: loop ? loop.startMs : cursorS.value * 1000,
    endMs: duration.value * 1000,
    rate: 1,
    loop,
  });
  if (!started) return;
  playing.value = true;
  syncClicks();
  stopFrames();
  frame = requestAnimationFrame(drawFrame);
}

function stop() {
  stopFrames();
  stopBand();
  if (engine?.playing) {
    const shown = engine.stop();
    if (shown !== undefined && !looping.value) cursorS.value = shown / 1000;
  }
  playing.value = false;
}

function togglePlay() {
  if (bandAudio) {
    if (bandAudio.paused) void bandAudio.play();
    else bandAudio.pause();
    return;
  }
  if (playing.value) stop();
  else void play();
}

function toggleLoop() {
  looping.value = !looping.value;
  if (looping.value) loopSpan.value = selection.value ?? { t0: view.value.startS, t1: view.value.endS };
  if (playing.value) void play();
}

// ---------------------------------------------------------------- tour

const tourIndex = ref(-1);

function tour(step: 1 | -1) {
  const spans = trouble.value;
  if (!spans.length) {
    message.value = "Nothing on the listening tour.";
    return;
  }
  tourIndex.value =
    tourIndex.value < 0
      ? step === 1
        ? 0
        : spans.length - 1
      : (tourIndex.value + step + spans.length) % spans.length;
  goToTrouble(tourIndex.value);
}

function goToTrouble(index: number) {
  const entry = trouble.value[index];
  if (!entry) return;
  tourIndex.value = index;
  flamSlot.value = null;
  selection.value = entry.span;
  runSelected.value = false;
  loopSpan.value = { t0: Math.max(0, entry.span.t0 - 0.5), t1: Math.min(duration.value, entry.span.t1 + 0.5) };
  looping.value = true;
  clicksOn.value = true;
  cursorS.value = loopSpan.value.t0;
  setView((entry.span.t0 + entry.span.t1) / 2, Math.max(4, (entry.span.t1 - entry.span.t0) * 2));
  zoomKey.value = "fit";
  message.value = `Tour ${index + 1}/${trouble.value.length}: ${entry.reasons.join(", ")}`;
  void play();
}

// ---------------------------------------------------------------- exports

const clipPath = ref<string | null>(null);

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

const titleStem = computed(() =>
  (draftAudio.value?.title ?? "draft").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_"),
);

function exportRedLines() {
  const projection = projectRedLines(state.value.beats, state.value.boundaries);
  const text = [
    `// ${projection.barPolicy}: ${projection.losses[0] ?? "meter is a placeholder"}`,
    "[TimingPoints]",
    projection.osuTimingPoints,
    "",
  ].join("\n");
  download(`${titleStem.value}.redlines.osu.txt`, text);
  message.value = `${projection.redLines.length} red lines exported (${projection.barPolicy}).`;
}

function exportTrace() {
  download(`${titleStem.value}.draft.jsonl`, session.exportNdjson());
}

async function exportClip() {
  if (!audioPath.value) {
    message.value = "Clips need the local service and a track on disk.";
    return;
  }
  const span = auditionSpan();
  busy.value = "Rendering clip";
  try {
    const exportedBeats = (abHeld.value && offerBeats.value ? offerBeats.value : beats.value).map(
      (beat) => beat.t,
    );
    const result = await draftJson<{ outputPath: string }>("export-clip", {
      audioPath: audioPath.value,
      startSec: span.t0,
      endSec: span.t1,
      beats: exportedBeats,
      format: "wav",
    });
    clipPath.value = result.outputPath;
    message.value = "Clip written; give its path to Gemini to read_file it.";
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally {
    busy.value = null;
  }
}

async function copyClipPath() {
  if (clipPath.value) await navigator.clipboard?.writeText(clipPath.value);
}

// ---------------------------------------------------------------- stage pointer

const stageSvg = ref<SVGSVGElement | null>(null);
let gesture:
  | { kind: "drag"; beatId: string; startX: number; moved: boolean }
  | { kind: "select"; startT: number }
  | null = null;
let pendingMove: (() => void) | null = null;
let moveFrame: number | undefined;

function pointerX(event: MouseEvent): number {
  const rect = stageSvg.value?.getBoundingClientRect();
  return event.clientX - (rect?.left ?? 0);
}

function scheduleMove(apply: () => void) {
  pendingMove = apply;
  if (moveFrame !== undefined) return;
  moveFrame = requestAnimationFrame(() => {
    moveFrame = undefined;
    pendingMove?.();
    pendingMove = null;
  });
}

function flushMove() {
  if (moveFrame !== undefined) cancelAnimationFrame(moveFrame);
  moveFrame = undefined;
  pendingMove?.();
  pendingMove = null;
}

function onStagePointerDown(event: PointerEvent) {
  if (event.button !== 0 || !state.value.audio) return;
  const target = event.target as Element;
  const px = pointerX(event);
  const t = tOf(px, view.value, stageWidth.value);
  try {
    stageSvg.value?.setPointerCapture?.(event.pointerId);
  } catch {}
  const beatId = target.getAttribute?.("data-beat-id");
  const soundId = target.getAttribute?.("data-sound-id");
  const statementId = target.getAttribute?.("data-statement-id");
  if (statementId) {
    selectedStatementId.value = statementId;
    selectedBeatId.value = null;
    return;
  }
  if (beatId) {
    commitTransient();
    selectedBeatId.value = beatId;
    selectedSoundId.value = null;
    selectedStatementId.value = null;
    runSelected.value = false;
    if (mode.value === "edit") gesture = { kind: "drag", beatId, startX: px, moved: false };
    return;
  }
  if (soundId) {
    selectedSoundId.value = soundId;
    selectedBeatId.value = null;
    return;
  }
  if (event.shiftKey) {
    gesture = { kind: "select", startT: t };
    selection.value = { t0: t, t1: t };
    runSelected.value = false;
    return;
  }
  commitTransient();
  cursorS.value = Math.max(0, t);
  selectedBeatId.value = null;
  selectedSoundId.value = null;
  selectedStatementId.value = null;
  if (!runSelected.value) selection.value = null;
  runSelected.value = false;
}

function onStagePointerMove(event: PointerEvent) {
  if (!gesture) return;
  const px = pointerX(event);
  const t = tOf(px, view.value, stageWidth.value);
  if (gesture.kind === "drag") {
    const drag = gesture;
    if (!drag.moved && Math.abs(px - drag.startX) < 2) return;
    drag.moved = true;
    scheduleMove(() => {
      preview.value = { beatId: drag.beatId, t };
    });
  } else {
    const startT = gesture.startT;
    scheduleMove(() => {
      selection.value = { t0: Math.min(startT, t), t1: Math.max(startT, t) };
    });
  }
}

function onStagePointerUp() {
  if (!gesture) return;
  flushMove();
  const finished = gesture;
  gesture = null;
  if (finished.kind === "drag" && finished.moved) commitTransient();
  if (finished.kind === "select" && selection.value && selection.value.t1 - selection.value.t0 < 0.005)
    selection.value = null;
}

function onStageDoubleClick(event: MouseEvent) {
  if (mode.value !== "edit" || !state.value.audio) return;
  const target = event.target as Element;
  if (target.getAttribute?.("data-beat-id") || target.getAttribute?.("data-sound-id")) return;
  const px = pointerX(event);
  const y = event.clientY - (stageSvg.value?.getBoundingClientRect().top ?? 0);
  const t = tOf(px, view.value, stageWidth.value);
  const band = bands.value.find((entry) => t >= entry.t0 && t <= entry.t1);
  if (target.getAttribute?.("data-band") && band) {
    selection.value = { t0: band.t0 - 0.0005, t1: band.t1 + 0.0005 };
    runSelected.value = true;
    message.value = "Run selected: arrows shift its offset (Shift: 10 ms).";
    return;
  }
  if (y > lane.top && y < lane.bottom) addBeat(t);
}

function onOverviewClick(event: MouseEvent) {
  const element = event.currentTarget as Element;
  const rect = element.getBoundingClientRect();
  const fraction = (event.clientX - rect.left) / (rect.width || stageWidth.value);
  setView(fraction * duration.value, view.value.endS - view.value.startS);
}

// ---------------------------------------------------------------- keys

function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element &&
      (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)),
  );
}

function onKeyDown(event: KeyboardEvent) {
  if (typing(event.target) || event.isComposing) return;
  if (event.key === "Alt") {
    pressAb();
    return;
  }
  const key = event.key.toLowerCase();
  const command = event.metaKey || event.ctrlKey;
  if (command && key === "k") {
    event.preventDefault();
    void requestOffer();
    return;
  }
  if (command && key === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (command || !state.value.audio) return;
  if (handleKey(event, key)) event.preventDefault();
}

/** The window-wide keys; true when the key was used. */
function handleKey(event: KeyboardEvent, key: string): boolean {
  if (key === " ") togglePlay();
  else if (key === "escape") {
    if (!cancelRecompute()) {
      flamSlot.value = null;
      stop();
      selection.value = null;
      runSelected.value = false;
    }
  } else if (key === "1") setMode("edit");
  else if (key === "2") setMode("audition");
  else if (key === "j") tour(event.shiftKey ? -1 : 1);
  else if (key === "l") toggleLoop();
  else if (key === "c") clicksOn.value = !clicksOn.value;
  else if (mode.value === "audition") return handleAuditionKey(event, key);
  else return handleEditKey(event, key);
  return true;
}

function handleAuditionKey(event: KeyboardEvent, key: string): boolean {
  if (event.code === "Backslash") cycleOffer();
  else if (key === "tab" && offers.value.length) {
    if (event.shiftKey) rejectOffer();
    else acceptOffer();
  } else if (event.code === "KeyG") flamCheck();
  else return false;
  return true;
}

function handleEditKey(event: KeyboardEvent, key: string): boolean {
  const verbs: Record<string, Statement["kind"]> = {
    e: event.shiftKey ? "free" : "steady",
    q: "no_pulse",
    v: "keep",
    t: "beat_run",
    m: "sound_at",
  };
  const verb = verbs[key];
  if (verb) addStatement(verb);
  else if (key === "r") addReset();
  else if (key === "a") addBeat(cursorS.value);
  else if (key === "delete" || key === "backspace") removeSelected();
  else if (key === "arrowleft" || key === "arrowright")
    return nudge((event.shiftKey ? 0.01 : 0.001) * (key === "arrowleft" ? -1 : 1));
  else return false;
  return true;
}

function onKeyUp(event: KeyboardEvent) {
  if (event.key === "Alt") releaseAb();
}

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
  window.removeEventListener("blur", releaseAb);
  resizeObserver?.disconnect();
  clearTimeout(settleTimer);
  stop();
  void engine?.close();
});

// ---------------------------------------------------------------- waveform

const waveCanvas = ref<HTMLCanvasElement | null>(null);

function drawWaveform() {
  const canvas = waveCanvas.value;
  const channels = pcm.value;
  const context = canvas?.getContext?.("2d");
  if (!canvas || !context) return;
  const ratio = window.devicePixelRatio || 1;
  const width = stageWidth.value;
  const height = lane.bottom - lane.top;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!channels?.length || !draftAudio.value) return;
  const rate = draftAudio.value.sampleRate;
  const data = channels[0] as Float32Array;
  context.fillStyle = "oklch(58% 0.03 240 / 0.75)";
  for (let px = 0; px < width; px++) {
    const from = Math.floor(tOf(px, view.value, width) * rate);
    const to = Math.max(from + 1, Math.floor(tOf(px + 1, view.value, width) * rate));
    const [min, max] = peak(data, from, to);
    const top = height / 2 - max * (height / 2) * 0.95;
    const bottom = height / 2 - min * (height / 2) * 0.95;
    context.fillRect(px, top, 1, Math.max(1, bottom - top));
  }
}

watch([pcm, view, stageWidth], drawWaveform);

// ---------------------------------------------------------------- labels

const selectedBeat = computed(() =>
  displayBeats.value.find((beat) => beat.id === selectedBeatId.value) ?? null,
);
const selectedSound = computed(() =>
  selectedSoundId.value ? (state.value.sounds.get(selectedSoundId.value) ?? null) : null,
);
const span = (value: Span) =>
  `${formatSourceTime(value.t0 * 1000, 1)}–${formatSourceTime(value.t1 * 1000, 1)}`;
const statusText = computed(() => {
  if (mode.value === "audition" && activeOffer.value) {
    const offer = activeOffer.value;
    const conflicts = offer.conflicts.length ? ` · ${offer.conflicts.length} conflict(s)` : "";
    return `${abHeld.value ? "Hearing" : "Offer"} ${activeOfferIndex.value + 1}/${offers.value.length}: ${formatConsequences(offer, state.value)}${conflicts}${abHeld.value ? " · Release Alt to change the offer" : ""}`;
  }
  return message.value;
});
const healthTone = computed(() =>
  error.value ? "error" : traceStatus.value === "error" ? "warn" : draftAudio.value ? "ready" : "idle",
);
</script>

<template>
  <WorkspaceFrame
    class="draft-workspace"
    layout-key="draft"
    mode="draft"
    :left="tourPane"
    :right="inspectorPane"
    @change-mode="$emit('change-mode', $event)"
  >
    <template #toolbar>
      <fieldset class="segmented draft-mode-switch" aria-label="Draft mode">
        <button
          type="button"
          :aria-pressed="mode === 'edit'"
          aria-keyshortcuts="1"
          title="Edit: direct edits and statements (1)"
          @click="setMode('edit')"
        >
          Edit
        </button>
        <button
          type="button"
          :aria-pressed="mode === 'audition'"
          aria-keyshortcuts="2"
          title="Audition and compare offers (2)"
          @click="setMode('audition')"
        >
          Audition
        </button>
      </fieldset>
      <fieldset class="toolbar-group" aria-label="Transport">
        <button
          class="tool-button tool-button--play"
          type="button"
          :disabled="!audioReady"
          :aria-pressed="playing"
          aria-keyshortcuts="Space"
          title="Play or stop (Space)"
          @click="togglePlay"
        >
          {{ playing ? "Stop" : "Play" }}
        </button>
        <button
          class="tool-button"
          type="button"
          :disabled="!audioReady"
          :aria-pressed="looping"
          aria-keyshortcuts="L"
          title="Loop the selection or the view (L)"
          @click="toggleLoop"
        >
          Loop <kbd>L</kbd>
        </button>
        <button
          class="tool-button"
          type="button"
          :aria-pressed="clicksOn"
          aria-keyshortcuts="C"
          title="Clicks at the beats (C)"
          @click="clicksOn = !clicksOn"
        >
          Clicks <kbd>C</kbd>
        </button>
      </fieldset>
      <button
        class="tool-button tool-button--primary draft-request"
        type="button"
        :disabled="!draftAudio"
        aria-keyshortcuts="Meta+K Control+K"
        title="Request an offer for the selection or the view; nothing recomputes otherwise (⌘K)"
        @click="requestOffer"
      >
        Request offer <kbd>⌘K</kbd>
      </button>
      <div class="time-counter" title="Playhead">
        <span class="sr-only">Playhead</span>
        <span ref="counterMain" class="time-counter-main">{{ formatSourceTime(cursorS * 1000, 1) }}</span>
        <span class="time-counter-sub">{{ draftAudio ? `${draftAudio.sampleRate} Hz` : "no track" }}</span>
      </div>
    </template>

    <template #toolbar-end>
      <span class="health-status" :class="`health-status--${healthTone}`" aria-live="polite">
        <span class="health-dot" aria-hidden="true"></span>
        {{ busy ?? (draftAudio ? (traceStatus === "saved" ? "Trace saved" : traceStatus === "saving" ? "Saving" : "Draft") : "No track") }}
      </span>
    </template>

    <template #left>
      <header class="pane-header">
        <h2 id="draft-tour-heading">Listening tour</h2>
        <span class="pane-count">{{ trouble.length }} spans · <kbd>J</kbd></span>
      </header>
      <nav class="task-list draft-tour" aria-labelledby="draft-tour-heading">
        <button
          v-for="(entry, index) in trouble.slice(0, 60)"
          :key="`${entry.span.t0}-${index}`"
          class="task-row draft-tour-row"
          :class="{ 'is-active': index === tourIndex }"
          type="button"
          :aria-current="index === tourIndex ? 'step' : undefined"
          @click="goToTrouble(index)"
        >
          <span class="draft-tour-score" :style="{ '--score': Math.min(1, entry.score / 3) }" aria-hidden="true"></span>
          <span class="task-copy">
            <strong>{{ String(index + 1).padStart(2, "0") }} {{ span(entry.span) }}</strong>
            <span>{{ entry.reasons.join(" · ") }}</span>
          </span>
        </button>
        <p v-if="!trouble.length" class="draft-empty">Nothing ranked yet.</p>
      </nav>
      <header class="pane-header">
        <h2 id="draft-statements-heading">Statements</h2>
        <span class="pane-count">{{ statements.length }}</span>
      </header>
      <ul class="draft-statements" aria-labelledby="draft-statements-heading">
        <li
          v-for="statement in statements"
          :key="statement.id"
          class="draft-statement"
          :class="{ 'is-active': statement.id === selectedStatementId }"
        >
          <button type="button" class="draft-statement-select" @click="selectedStatementId = statement.id">
            <span class="draft-chip">{{ statementLabel[statement.kind] }}</span>
            <span class="data">{{ span(statementSpan(statement)) }}</span>
          </button>
          <button
            type="button"
            class="tool-button tool-button--icon"
            :title="`Remove the ${statementLabel[statement.kind]} statement`"
            @click="removeStatement(statement.id)"
          >
            ×
          </button>
        </li>
        <li v-if="statements.length" class="draft-badge-row">
          <span class="honesty-badge honesty-badge--statement">{{ statementBadge }}</span>
        </li>
      </ul>
      <footer class="pane-footer draft-verbs">
        <button class="tool-button" type="button" :disabled="mode !== 'edit'" title="Steady (E)" @click="addStatement('steady')">Steady <kbd>E</kbd></button>
        <button class="tool-button" type="button" :disabled="mode !== 'edit'" title="Free (Shift+E)" @click="addStatement('free')">Free <kbd>⇧E</kbd></button>
        <button class="tool-button" type="button" :disabled="mode !== 'edit'" title="No pulse (Q)" @click="addStatement('no_pulse')">No pulse <kbd>Q</kbd></button>
        <button class="tool-button" type="button" :disabled="mode !== 'edit'" title="Keep (V)" @click="addStatement('keep')">Keep <kbd>V</kbd></button>
        <button class="tool-button" type="button" :disabled="mode !== 'edit'" title="Beat run (T)" @click="addStatement('beat_run')">Run <kbd>T</kbd></button>
        <button class="tool-button" type="button" :disabled="mode !== 'edit'" title="Sound at the cursor (M)" @click="addStatement('sound_at')">Sound <kbd>M</kbd></button>
        <button class="tool-button" type="button" :disabled="mode !== 'edit'" title="Beat at the cursor" @click="addStatement('beat_at')">Beat here</button>
        <button class="tool-button" type="button" :disabled="mode !== 'edit'" title="No beat in the selection" @click="addStatement('forbid_beat')">No beat</button>
      </footer>
    </template>

    <template #main>
      <section class="draft-main" aria-label="Draft stage">
        <header class="stage-toolbar draft-bar">
          <div class="stage-identity">
            <strong>{{ draftAudio?.title ?? "No track" }}</strong>
            <span v-if="draftAudio" class="data">{{ formatSourceTime(duration * 1000) }}</span>
          </div>
          <div class="draft-badges">
            <span
              v-if="draftBadge"
              class="honesty-badge"
              :class="`honesty-badge--${draftBadge.kind}`"
              :title="draftBadge.title"
            >{{ draftBadge.text }}</span>
            <span v-if="soundsBadge" class="honesty-badge" :class="`honesty-badge--${soundsBadge.kind}`">{{ soundsBadge.text }}</span>
            <span v-if="offers.length" class="honesty-badge honesty-badge--offer">{{ offerBadge }}</span>
          </div>
          <fieldset v-if="mode === 'audition'" class="segmented draft-views" aria-label="Audition view">
            <button
              v-for="option in auditionViews"
              :key="option.key"
              type="button"
              :aria-pressed="auditionView === option.key"
              :title="option.key === 'mix' ? 'The original mix' : `${option.label}: listening only; times stay on the mix`"
              @click="setAuditionView(option.key)"
            >
              {{ option.label }}
            </button>
          </fieldset>
          <fieldset class="segmented draft-zoom" aria-label="Zoom">
            <button
              v-for="preset in zoomPresets"
              :key="preset.key"
              type="button"
              :aria-pressed="zoomKey === preset.key"
              @click="zoom(preset.key)"
            >
              {{ preset.label }}
            </button>
          </fieldset>
        </header>
        <p v-if="error" class="notice-bar notice-bar--error" role="alert">
          <span class="health-dot" aria-hidden="true"></span>
          <span class="notice-bar-text">{{ error }}</span>
          <button class="tool-button" type="button" @click="error = ''">Dismiss</button>
        </p>

        <div v-if="!draftAudio" class="draft-empty-stage">
          <p>Load a local track to draft its beats with raw BeatThis, or try the synthetic demo.</p>
          <button class="tool-button tool-button--primary" type="button" @click="loadDemo">Load demo</button>
        </div>

        <div v-else ref="stageWrap" class="draft-stage-wrap">
          <button
            class="draft-overview"
            type="button"
            title="Overview: unexplained sounds (amber) and beat uncertainty (violet); click to move the view"
            @click="onOverviewClick"
          >
          <svg :width="stageWidth" height="14" aria-hidden="true">
            <g v-for="(bin, index) in heat" :key="index">
              <rect
                :x="(index / heat.length) * stageWidth"
                y="0"
                :width="stageWidth / heat.length + 0.5"
                height="7"
                class="heat-unexplained"
                :style="{ opacity: bin.unexplained }"
              />
              <rect
                :x="(index / heat.length) * stageWidth"
                y="7"
                :width="stageWidth / heat.length + 0.5"
                height="7"
                class="heat-uncertainty"
                :style="{ opacity: bin.uncertainty }"
              />
            </g>
            <rect
              class="overview-window"
              :x="(view.startS / duration) * stageWidth"
              y="0.5"
              :width="Math.max(2, ((view.endS - view.startS) / duration) * stageWidth)"
              height="13"
            />
          </svg>
          </button>
          <div class="draft-stage">
            <canvas
              ref="waveCanvas"
              class="draft-wave"
              :style="{ top: `${lane.top}px`, height: `${lane.bottom - lane.top}px`, width: `${stageWidth}px` }"
              aria-hidden="true"
            ></canvas>
            <svg
              ref="stageSvg"
              class="draft-svg"
              :class="{ 'is-audition': mode === 'audition' }"
              :width="stageWidth"
              :height="stageHeight"
              aria-label="Draft stage: beats, runs and sounds"
              @pointerdown="onStagePointerDown"
              @pointermove="onStagePointerMove"
              @pointerup="onStagePointerUp"
              @pointercancel="onStagePointerUp"
              @dblclick="onStageDoubleClick"
            >
              <defs>
                <pattern id="draft-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="6" class="hatch-line" />
                </pattern>
              </defs>
              <rect class="stage-ground" x="0" y="0" :width="stageWidth" :height="stageHeight" />
              <rect
                v-for="statement in statements.filter((entry) => entry.kind === 'keep')"
                :key="`keep-${statement.id}`"
                class="keep-tint"
                :x="x(statementSpan(statement).t0)"
                :y="lane.top"
                :width="Math.max(1, x(statementSpan(statement).t1) - x(statementSpan(statement).t0))"
                :height="lane.soundsBottom - lane.top"
              />
              <rect
                v-if="selection"
                class="selection-wash"
                :class="{ 'is-run': runSelected }"
                :x="x(selection.t0)"
                y="0"
                :width="Math.max(1, x(selection.t1) - x(selection.t0))"
                :height="stageHeight"
              />
              <!-- Ruler: runs, reset notches and statement chips. -->
              <g class="ruler">
                <rect
                  v-for="(band, index) in bands"
                  :key="`band-${index}`"
                  :class="`run run--${band.kind}`"
                  data-band="1"
                  :x="x(band.t0)"
                  :y="lane.rulerTop"
                  :width="Math.max(1, x(band.t1) - x(band.t0))"
                  :height="lane.rulerHeight"
                  :fill="band.kind === 'free' ? 'url(#draft-hatch)' : undefined"
                >
                  <title>{{ band.kind }}{{ band.bpm ? ` ${band.bpm.toFixed(2)} BPM` : "" }}</title>
                </rect>
                <template v-for="(band, index) in bands" :key="`bpm-${index}`">
                  <text
                    v-if="band.bpm && x(band.t1) - x(band.t0) > 60"
                    class="run-label"
                    :x="Math.max(x(band.t0), 0) + 4"
                    :y="lane.rulerTop + 10.5"
                  >{{ band.bpm.toFixed(2) }}</text>
                </template>
                <path
                  v-for="boundary in boundaries.filter((entry) => visible(entry.t))"
                  :key="boundary.id"
                  class="boundary-notch"
                  :class="`boundary-notch--${boundary.kind}`"
                  :d="`M${x(boundary.t) - 4},${lane.rulerTop} L${x(boundary.t) + 4},${lane.rulerTop} L${x(boundary.t)},${lane.rulerTop + 7} Z`"
                >
                  <title>{{ boundary.kind }} {{ formatSourceTime(boundary.t * 1000, 1) }}</title>
                </path>
                <g
                  v-for="statement in statements"
                  :key="`chip-${statement.id}`"
                  class="statement-chip"
                  :class="{ 'is-selected': statement.id === selectedStatementId }"
                >
                  <path
                    :data-statement-id="statement.id"
                    :d="statement.span
                      ? `M${x(statement.span.t0)},12 V4 H${x(statement.span.t1)} V12`
                      : `M${x(statement.t ?? 0) - 4},4 L${x(statement.t ?? 0) + 4},4 L${x(statement.t ?? 0)},12 Z`"
                  />
                  <text :x="x(statementSpan(statement).t0) + 3" y="11">{{ statementLabel[statement.kind] }}</text>
                </g>
              </g>
              <!-- Beats: hairlines, collapsed into the run band when dense. -->
              <g class="beats">
                <template v-if="!collapsed">
                  <g v-for="beat in visibleBeats" :key="beat.id">
                    <line
                      class="beat"
                      :class="[`beat--${beat.source}`, { 'is-selected': beat.id === selectedBeatId }]"
                      :x1="x(beat.t)"
                      :x2="x(beat.t)"
                      :y1="lane.top"
                      :y2="lane.bottom"
                      :style="beat.source !== 'user' && beat.conf !== undefined ? { opacity: 0.35 + 0.65 * beat.conf } : undefined"
                    />
                    <rect
                      class="beat-hit"
                      :data-beat-id="beat.id"
                      :x="x(beat.t) - 4"
                      :y="lane.top"
                      width="9"
                      :height="lane.bottom - lane.top"
                    />
                  </g>
                </template>
                <line
                  v-else-if="selectedBeat"
                  class="beat is-selected"
                  :x1="x(selectedBeat.t)"
                  :x2="x(selectedBeat.t)"
                  :y1="lane.top"
                  :y2="lane.bottom"
                />
                <line
                  v-for="beat in ghostBeats"
                  :key="`ghost-${beat.id}`"
                  class="beat beat--offer"
                  :class="{ 'is-heard': abHeld }"
                  :x1="x(beat.t)"
                  :x2="x(beat.t)"
                  :y1="lane.top"
                  :y2="lane.bottom"
                />
              </g>
              <!-- Sounds: independent of the beats, sized by emphasis. -->
              <g class="sounds">
                <line class="lane-rule" x1="0" :x2="stageWidth" :y1="lane.bottom + 0.5" :y2="lane.bottom + 0.5" />
                <template v-for="sound in visibleSounds" :key="sound.id">
                  <template v-if="fitById.get(sound.id)?.status === 'unexplained'">
                    <line
                      class="whisker"
                      :x1="x(sound.t)"
                      :x2="x(sound.t) - whiskerPx(signedResidual(sound.t))"
                      :y1="(lane.bottom + lane.soundsBottom) / 2"
                      :y2="(lane.bottom + lane.soundsBottom) / 2"
                    />
                    <circle
                      class="sound sound--unexplained"
                      :class="{ 'is-selected': sound.id === selectedSoundId }"
                      :data-sound-id="sound.id"
                      :cx="x(sound.t)"
                      :cy="(lane.bottom + lane.soundsBottom) / 2"
                      :r="2 + 4 * sound.emphasis"
                    >
                      <title>unexplained {{ signedResidual(sound.t).toFixed(1) }} ms</title>
                    </circle>
                  </template>
                  <text
                    v-else-if="fitById.get(sound.id)?.status === 'subdivision' && isNonBinaryDivisor(fitById.get(sound.id)?.nearestDivisor)"
                    class="sound-numeral"
                    :data-sound-id="sound.id"
                    :x="x(sound.t)"
                    :y="(lane.bottom + lane.soundsBottom) / 2 + 3.5"
                    :font-size="8 + 4 * sound.emphasis"
                  >{{ fitById.get(sound.id)?.nearestDivisor }}</text>
                  <circle
                    v-else
                    class="sound sound--on-grid"
                    :class="{ 'is-selected': sound.id === selectedSoundId }"
                    :data-sound-id="sound.id"
                    :cx="x(sound.t)"
                    :cy="(lane.bottom + lane.soundsBottom) / 2"
                    :r="2 + 4 * sound.emphasis"
                  />
                </template>
              </g>
              <line
                v-if="flamSlot !== null"
                class="flam-slot"
                :x1="x(flamSlot)"
                :x2="x(flamSlot)"
                :y1="lane.top"
                :y2="lane.soundsBottom"
              />
              <line class="cursor" :x1="x(cursorS)" :x2="x(cursorS)" y1="0" :y2="stageHeight" />
              <line
                v-show="playing"
                ref="playheadLine"
                class="playhead"
                x1="0"
                x2="0"
                y1="0"
                :y2="stageHeight"
              />
            </svg>
            <div
              v-if="recomputing"
              class="draft-progress"
              role="status"
              :style="{
                left: `${Math.max(0, x(recomputing.span.t0))}px`,
                width: `${Math.max(24, Math.min(stageWidth, x(recomputing.span.t1)) - Math.max(0, x(recomputing.span.t0)))}px`,
              }"
            >
              <span class="draft-progress-bar" aria-hidden="true"></span>
              <span class="draft-progress-label">{{ recomputing.provider }} · recomputing · Esc cancels</span>
            </div>
          </div>
        </div>
      </section>
    </template>

    <template #right>
      <div class="draft-inspector">
        <PanelSection id="draft-track" title="Track" :collapsible="false">
          <form class="draft-form" @submit.prevent="analyzeTrack">
            <label class="field-stack">
              <span>Audio file (.wav .mp3 .ogg .flac .m4a)</span>
              <input
                v-model="trackInput"
                name="audio"
                placeholder="~/Music/song.mp3"
                autocomplete="off"
                spellcheck="false"
                :disabled="Boolean(busy)"
              />
            </label>
            <div class="draft-actions">
              <button class="tool-button tool-button--primary" type="submit" :disabled="Boolean(busy) || !trackInput.trim()">
                {{ busy === "Analyzing" ? "Analyzing" : "Analyze" }}
              </button>
              <button class="tool-button" type="button" :disabled="Boolean(busy)" @click="loadDemo">Load demo</button>
            </div>
          </form>
          <form class="draft-form" @submit.prevent="openTrace">
            <label class="field-stack">
              <span>Trace (.jsonl)</span>
              <input v-model="traceInput" name="trace" placeholder="Full path to a .jsonl trace" autocomplete="off" spellcheck="false" />
            </label>
            <div class="draft-actions">
              <button class="tool-button" type="submit" :disabled="Boolean(busy) || !traceInput.trim()">Open trace</button>
              <button class="tool-button" type="button" :disabled="!draftAudio" @click="exportTrace">Download trace</button>
            </div>
          </form>
        </PanelSection>

        <PanelSection id="draft-capabilities" title="Capabilities">
          <ul class="capability-strip" aria-label="Capabilities">
            <li class="capability capability--on">draft ✓</li>
            <li class="capability capability--experimental">sounds (experimental)</li>
            <li class="capability capability--off">constrained recompute ✗ (rule mock / reserved)</li>
          </ul>
          <p class="draft-note">
            Statements are recorded and shown; raw BeatThis does not honor them. Offers come from a
            transparent rule mock until the N1 model lands.
          </p>
        </PanelSection>

        <PanelSection id="draft-facts" title="Draft">
          <div class="prop-row"><span>Beats</span><b class="data draft-beat-count">{{ beats.length }}</b></div>
          <div class="prop-row"><span>Your beats</span><b class="data">{{ userBeats }}</b></div>
          <div class="prop-row"><span>Sounds</span><b class="data">{{ sounds.length }}</b></div>
          <div class="prop-row">
            <span>Unexplained</span>
            <b class="data">{{ fits.filter((fit) => fit.status === "unexplained").length }}</b>
          </div>
          <div class="prop-row"><span>Boundaries</span><b class="data">{{ boundaries.length }}</b></div>
          <div class="draft-actions">
            <button class="tool-button" type="button" :disabled="!undoState.undo" aria-keyshortcuts="Meta+Z" title="Undo (⌘Z)" @click="undo">Undo</button>
            <button class="tool-button" type="button" :disabled="!undoState.redo" aria-keyshortcuts="Meta+Shift+Z" title="Redo (⇧⌘Z)" @click="redo">Redo</button>
          </div>
        </PanelSection>

        <PanelSection id="draft-selection" title="Selection">
          <template v-if="selectedBeat">
            <div class="prop-row"><span>Beat</span><b class="data">{{ formatSourceTime(selectedBeat.t * 1000, 3) }}</b></div>
            <div class="prop-row"><span>Source</span><b class="data">{{ selectedBeat.source }} v{{ selectedBeat.version }}</b></div>
            <div v-if="selectedBeat.conf !== undefined" class="prop-row"><span>Confidence</span><b class="data">{{ selectedBeat.conf.toFixed(3) }}</b></div>
          </template>
          <template v-else-if="selectedSound">
            <div class="prop-row"><span>Sound</span><b class="data">{{ formatSourceTime(selectedSound.t * 1000, 3) }}</b></div>
            <div class="prop-row"><span>Emphasis</span><b class="data">{{ selectedSound.emphasis.toFixed(2) }}</b></div>
            <div class="prop-row">
              <span>Grid fit</span>
              <b class="data">
                {{ fitById.get(selectedSound.id)?.status }}
                {{ fitById.get(selectedSound.id)?.nearestDivisor ? `1/${fitById.get(selectedSound.id)?.nearestDivisor}` : "" }}
                {{ Number.isFinite(fitById.get(selectedSound.id)?.residualMs) ? (fitById.get(selectedSound.id)?.residualMs ?? 0).toFixed(1) : "—" }} ms
              </b>
            </div>
          </template>
          <div v-if="selection" class="prop-row">
            <span>{{ runSelected ? "Run" : "Span" }}</span><b class="data">{{ span(selection) }}</b>
          </div>
          <p v-if="!selectedBeat && !selectedSound && !selection" class="draft-note">
            Click a beat or sound; Shift+drag for a span; double-click the ruler for a run.
          </p>
        </PanelSection>

        <PanelSection id="draft-offers" title="Offers">
          <ul class="draft-offers">
            <li
              v-for="(offer, index) in offers"
              :key="offer.id"
              class="draft-offer"
              :class="{ 'is-active': activeOffer?.id === offer.id }"
            >
              <button type="button" class="draft-offer-select" @click="!guardAb() && (activeOfferIndex = index)">
                <span class="draft-chip">{{ offer.role }} · {{ offer.scopeKind }}</span>
                <strong>{{ offer.summary }}</strong>
                <span class="draft-note">{{ formatConsequences(offer, state) }}</span>
                <span v-for="(conflict, at) in offer.conflicts" :key="at" class="draft-conflict">{{ conflict.message }}</span>
                <span class="honesty-badge honesty-badge--offer">
                  {{ offer.providerKind === "rule" ? offerBadge : `Offer · ${offer.providerId}` }}
                </span>
              </button>
              <div class="draft-actions">
                <button class="tool-button" type="button" title="Accept (Tab)" @click="acceptOffer(offer)">Accept <kbd>Tab</kbd></button>
                <button class="tool-button" type="button" title="Reject and suppress (Shift+Tab)" @click="rejectOffer(offer)">Reject</button>
              </div>
            </li>
          </ul>
          <p v-if="!offers.length" class="draft-note">No offers. Select a span and press ⌘K.</p>
          <p v-else class="draft-note">
            Audition: hold <kbd>Alt</kbd> to hear the offer, <kbd>\</kbd> cycles, <kbd>G</kbd> flam check.
          </p>
        </PanelSection>

        <PanelSection id="draft-export" title="Export">
          <div class="draft-actions">
            <button class="tool-button" type="button" :disabled="!beats.length" @click="exportRedLines">.osu red lines</button>
            <button class="tool-button" type="button" :disabled="!audioPath || Boolean(busy)" @click="exportClip">Export clip for Gemini</button>
          </div>
          <p class="draft-note">Red lines: barlines not inferred (meter is a placeholder).</p>
          <div v-if="clipPath" class="draft-clip">
            <code class="data">{{ clipPath }}</code>
            <button class="tool-button" type="button" @click="copyClipPath">Copy path</button>
          </div>
        </PanelSection>

        <PanelSection id="draft-legend" title="Legend" :default-open="false">
          <ul class="draft-legend">
            <li><span class="legend-swatch legend-swatch--model"></span> Model beat (opacity: confidence)</li>
            <li><span class="legend-swatch legend-swatch--user"></span> Your beat</li>
            <li><span class="legend-swatch legend-swatch--offer"></span> Offer preview</li>
            <li><span class="legend-dot legend-dot--grid"></span> Sound on the grid</li>
            <li><span class="legend-numeral">3</span> Sound on a 1/3 or 1/6 slot</li>
            <li><span class="legend-dot legend-dot--unexplained"></span> Unexplained; whisker 1 px = 1 ms</li>
          </ul>
        </PanelSection>
      </div>
    </template>

    <template #status>
      <span class="status-item">Mode <b>{{ mode }}</b></span>
      <span class="status-item draft-status-text" aria-live="polite">{{ statusText }}</span>
      <span class="status-item status-optional">
        View <b>{{ formatSourceTime(view.startS * 1000) }}–{{ formatSourceTime(view.endS * 1000) }}</b>
      </span>
      <span v-if="auditionView !== 'mix'" class="status-item">Listening <b>{{ auditionView }}</b> {{ bandState }}</span>
      <span class="status-item status-item--end status-item--path" :title="tracePath ?? ''">
        {{ tracePath ?? "No trace file" }}
      </span>
    </template>
  </WorkspaceFrame>
</template>

<style scoped>
.draft-main {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--well);
}

.draft-bar {
  gap: 8px;
  flex-wrap: nowrap;
}

.draft-badges {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  gap: 4px;
  overflow: hidden;
}

.honesty-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 3px;
  font-size: var(--text-2xs);
  font-weight: 600;
  white-space: nowrap;
  color: var(--ink-secondary);
  background: var(--surface-3);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}

.honesty-badge--model {
  color: oklch(84% 0.08 200);
}

.honesty-badge--rule,
.honesty-badge--mock,
.honesty-badge--experimental,
.honesty-badge--offer {
  color: var(--warning);
  box-shadow: inset 0 0 0 1px oklch(83% 0.14 80 / 0.35);
}

.honesty-badge--statement {
  color: var(--ink-muted);
}

.draft-empty-stage {
  display: grid;
  place-content: center;
  gap: 12px;
  flex: 1;
  color: var(--ink-secondary);
  font-size: var(--text-md);
  text-align: center;
}

.draft-stage-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  padding-top: 4px;
  overflow: hidden;
}

.draft-overview {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
}

.draft-overview svg {
  display: block;
}

.heat-unexplained {
  fill: var(--warning);
}

.heat-uncertainty {
  fill: oklch(70% 0.12 300);
}

.overview-window {
  fill: none;
  stroke: var(--ink-secondary);
  stroke-width: 1;
}

.draft-stage {
  position: relative;
  margin-top: 4px;
}

.draft-wave {
  position: absolute;
  left: 0;
  pointer-events: none;
}

.draft-svg {
  position: relative;
  display: block;
  touch-action: none;
  outline: none;
}

.draft-svg:focus-visible {
  box-shadow: var(--focus-ring);
}

.stage-ground {
  fill: transparent;
}

.run--steady {
  fill: oklch(45% 0.06 200 / 0.6);
}

.run--free {
  stroke: oklch(55% 0.05 200 / 0.6);
  stroke-width: 1;
}

.hatch-line {
  stroke: oklch(60% 0.05 200 / 0.6);
  stroke-width: 2;
}

.run--gap {
  fill: var(--seam);
}

.run-label {
  fill: var(--ink);
  font-family: var(--font-data);
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.boundary-notch {
  fill: var(--ink);
}

.boundary-notch--gap_start,
.boundary-notch--gap_end {
  fill: var(--ink-muted);
}

.statement-chip path {
  fill: none;
  stroke: var(--ink-secondary);
  stroke-width: 1.25;
  cursor: pointer;
}

.statement-chip text {
  fill: var(--ink-secondary);
  font-size: var(--text-2xs);
  pointer-events: none;
}

.statement-chip.is-selected path {
  stroke: var(--signal);
}

.keep-tint {
  fill: oklch(72% 0.08 150 / 0.08);
  pointer-events: none;
}

.selection-wash {
  fill: oklch(72% 0.14 255 / 0.12);
  pointer-events: none;
}

.selection-wash.is-run {
  fill: oklch(72% 0.14 255 / 0.2);
}

.beat {
  stroke-width: 1;
  pointer-events: none;
  shape-rendering: crispEdges;
}

.beat--model,
.beat--rule,
.beat--import {
  stroke: oklch(74% 0.09 200);
}

.beat--user {
  stroke: oklch(98% 0 0);
}

.beat.is-selected {
  stroke: oklch(100% 0 0);
  stroke-width: 2;
  filter: drop-shadow(0 0 1px var(--seam));
}

.beat--offer {
  stroke: oklch(78% 0.14 300);
  stroke-dasharray: 3 3;
}

.beat--offer.is-heard {
  stroke-dasharray: none;
  stroke-width: 2;
}

.beat-hit {
  fill: transparent;
  cursor: ew-resize;
}

.is-audition .beat-hit {
  cursor: pointer;
}

.lane-rule {
  stroke: var(--line);
}

.sound {
  cursor: pointer;
}

.sound--on-grid {
  fill: none;
  stroke: oklch(72% 0.01 255);
  stroke-width: 1;
}

.sound--unexplained {
  fill: var(--warning);
}

.sound.is-selected {
  stroke: oklch(100% 0 0);
  stroke-width: 1.5;
}

.whisker {
  stroke: var(--warning);
  stroke-width: 1.5;
  pointer-events: none;
}

.sound-numeral {
  fill: var(--ink-secondary);
  font-family: var(--font-data);
  text-anchor: middle;
  cursor: pointer;
}

.flam-slot {
  stroke: var(--warning);
  stroke-dasharray: 2 2;
  pointer-events: none;
}

.cursor {
  stroke: var(--ink-muted);
  stroke-dasharray: 2 3;
  pointer-events: none;
}

.playhead {
  stroke: var(--danger);
  stroke-width: 1.5;
  pointer-events: none;
}

.draft-progress {
  position: absolute;
  top: 0;
  height: 14px;
  pointer-events: none;
}

.draft-progress-bar {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 1px;
  overflow: hidden;
  background: oklch(72% 0.14 255 / 0.25);
}

.draft-progress-bar::after {
  position: absolute;
  inset: 0;
  width: 30%;
  content: "";
  background: var(--signal);
  animation: draft-progress 1.1s linear infinite;
}

@keyframes draft-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(340%);
  }
}

.draft-progress-label {
  position: absolute;
  top: 2px;
  left: 0;
  color: var(--signal);
  font-size: var(--text-2xs);
  white-space: nowrap;
}

.draft-inspector {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
}

.draft-form {
  display: grid;
  gap: 8px;
  padding: 8px 0;
}

.draft-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.draft-note {
  margin: 4px 0;
  color: var(--ink-muted);
  font-size: var(--text-xs);
}

.capability-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.capability {
  padding: 2px 6px;
  border-radius: 3px;
  font-family: var(--font-data);
  font-size: var(--text-2xs);
  background: var(--field);
}

.capability--on {
  color: var(--success);
}

.capability--experimental {
  color: var(--warning);
}

.capability--off {
  color: var(--ink-muted);
}

.draft-tour-row {
  grid-template-columns: 4px minmax(0, 1fr);
}

.draft-tour-score {
  align-self: stretch;
  width: 3px;
  border-radius: 2px;
  background: var(--warning);
  opacity: calc(0.25 + 0.75 * var(--score));
}

.draft-empty {
  padding: 8px;
  color: var(--ink-muted);
  font-size: var(--text-xs);
}

.draft-statements,
.draft-offers,
.draft-legend {
  margin: 0;
  padding: 0;
  list-style: none;
}

.draft-statement {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: var(--row-h);
  padding: 0 8px;
  border-bottom: 1px solid var(--line);
}

.draft-statement.is-active,
.draft-offer.is-active {
  background: var(--signal-soft);
  box-shadow: inset 2px 0 0 var(--signal);
}

.draft-statement-select,
.draft-offer-select {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
  padding: 4px 0;
  border: 0;
  color: var(--ink);
  text-align: left;
  background: none;
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.draft-chip {
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--ink-secondary);
  background: var(--surface-3);
  font-size: var(--text-2xs);
}

.draft-badge-row {
  padding: 6px 8px;
}

.draft-offer {
  display: grid;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}

.draft-conflict {
  flex-basis: 100%;
  color: var(--warning);
  font-size: var(--text-2xs);
}

.draft-verbs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.draft-clip {
  display: grid;
  gap: 4px;
  margin-top: 6px;
}

.draft-clip code {
  overflow-wrap: anywhere;
  font-size: var(--text-2xs);
}

.draft-legend li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  color: var(--ink-secondary);
  font-size: var(--text-xs);
}

.legend-swatch {
  width: 12px;
  height: 0;
  border-top: 2px solid;
}

.legend-swatch--model {
  border-color: oklch(74% 0.09 200);
}

.legend-swatch--user {
  border-color: oklch(98% 0 0);
}

.legend-swatch--offer {
  border-top-style: dashed;
  border-color: oklch(78% 0.14 300);
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.legend-dot--grid {
  box-shadow: inset 0 0 0 1px oklch(72% 0.01 255);
}

.legend-dot--unexplained {
  background: var(--warning);
}

.legend-numeral {
  width: 8px;
  font-family: var(--font-data);
  font-size: var(--text-2xs);
}

.draft-status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
