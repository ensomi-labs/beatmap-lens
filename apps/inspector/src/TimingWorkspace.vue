<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, triggerRef, watch } from "vue";
import AudioVolumeControl from "./AudioVolumeControl.vue";
import { isNativeActivationTarget, isTypingTarget } from "./annotation/keyboard-targets";
import TimingStage, { type StageProposal } from "./TimingStage.vue";
import { TimingAudioEngine } from "./timing/audio-engine";
import { timingJson, timingRequest } from "./timing/client";
import {
  type BlindPassage,
  type BlindPassageRow,
  type Mark,
  type MarkKind,
  type MarkMethod,
  type OpenTiming,
  type PageProvenance,
  type PlaybackSetup,
  type RevealedName,
  type SaveResponse,
  staleSessionError,
} from "./timing/contracts";
import {
  addMark,
  adjacentMark,
  differsFrom,
  flipSelected,
  type MarksState,
  marksState,
  nudgeSelected,
  redo,
  removeSelected,
  selectedMark,
  selectMark,
  undo,
} from "./timing/marks";
import { prerollStart } from "./timing/output-clock";
import { proposalColour } from "./timing/palette";
import { deinterleave } from "./timing/pcm";
import {
  clampView,
  fitView,
  formatSourceTime,
  msToX,
  placeAt,
  type TimeRange,
  type TimeView,
  zoomAt,
  zoomLimits,
} from "./timing/time-view";
import { digitalSilence } from "./timing/waveform";
import WorkspaceModeSwitch from "./WorkspaceModeSwitch.vue";
import type { WorkspaceMode } from "./workspace-mode";

const emit = defineEmits<{ "change-mode": [mode: WorkspaceMode] }>();

const rememberedSession = "lens-timing-session";
const preferencesKey = "lens-timing-preferences";
const playbackRates = [1, 0.75, 0.5] as const;
/** At least this much real preceding audio is played before every start. */
const minimumPrerollMs = 120;
const deviceRates = [44_100, 48_000, 88_200, 96_000] as const;
/** `Z` toggles between fitting the passage and this many ms per device pixel. */
const fineMsPerDevicePx = 0.5;
const markLoopMs = 500;

interface TimingPreferences {
  volume: number;
  playheadOffsetMs: number;
  /** Context rate the offset was last set at; another rate needs a fresh check. */
  offsetRate: number | null;
  prerollMs: number;
  deviceRateHz: number | null;
  setup: string;
}

/** One passage's working marks; kept in memory across passage switches until the page closes. */
interface Draft {
  state: MarksState;
  saved: Mark[];
  saveId: string | null;
}

const preferences = ref<TimingPreferences>({
  volume: 0.5,
  playheadOffsetMs: 0,
  offsetRate: null,
  prerollMs: minimumPrerollMs,
  deviceRateHz: null,
  setup: "",
  ...readPreferences(),
});

// Setup and session
const sessionPath = ref(
  new URLSearchParams(window.location.search).get("session") ?? remembered(rememberedSession) ?? "",
);
/** Deep, so marking a row saved or revealed updates everything that reads it. */
const opened = ref<OpenTiming>();
const blind = shallowRef<BlindPassage>();
const names = shallowRef<RevealedName[]>();
const passageIndex = ref(0);
const drafts = shallowRef(new Map<string, Draft>());
const visibility = ref<Record<string, boolean>>({});
const hiddenByP = ref<string[]>();
const busy = ref(false);
const saving = ref(false);
const error = ref("");
const notice = ref("");
const silenceMs = ref<number>();
/** The path the open session was opened with, for reconnecting after a service restart. */
let openedPath = "";
/** The marks file and session id the drafts belong to; reopening the same session keeps them. */
let draftsOwner = "";

// Playback
const audioState = ref<"none" | "loading" | "ready">("none");
const audioBuffer = shallowRef<AudioBuffer>();
const playheadMs = ref(0);
const playing = ref(false);
const looping = ref(false);
const loopRegion = ref<TimeRange>({ startMs: 0, endMs: 0 });
const rate = ref<(typeof playbackRates)[number]>(1);
const loudnessMatch = ref(false);
const latencies = ref<{ base_latency_ms: number | null; output_latency_ms: number | null }>({
  base_latency_ms: null,
  output_latency_ms: null,
});
const contextRate = ref<number>();
const deviceChanged = ref(false);

// Stage
const stage = ref<InstanceType<typeof TimingStage>>();
const stageWidth = ref(0);
const devicePixelRatio = ref(1);
const view = ref<TimeView>({ startMs: 0, msPerPx: 10 });
const follow = ref(true);
let fitPending = true;

let engine: TimingAudioEngine | undefined;
let loadedHandle = "";
let frame = 0;
let disposed = false;

const passage = computed(() => opened.value?.passages[passageIndex.value]);
const span = computed<TimeRange>(() => ({
  startMs: passage.value?.start_ms ?? 0,
  endMs: passage.value?.end_ms ?? 0,
}));
/** What is shown and playable: the passage plus its context, inside the recording. */
const bounds = computed<TimeRange>(() => {
  const row = passage.value;
  if (!row) return { startMs: 0, endMs: 0 };
  const durationMs = (row.audio.frames * 1000) / row.audio.sample_rate;
  return {
    startMs: Math.max(0, row.start_ms - row.context_before_ms),
    endMs: Math.min(durationMs, row.end_ms + row.context_after_ms),
  };
});
const draft = computed(() => drafts.value.get(passage.value?.id ?? ""));
const marks = computed(() => draft.value?.state.marks ?? []);
const selected = computed(() => (draft.value ? selectedMark(draft.value.state) : undefined));
const dirty = computed(() => (draft.value ? isDirty(draft.value) : false));
const unsavedPassages = computed(() => [...drafts.value.values()].filter(isDirty).length);
const revealed = computed(() => Boolean(passage.value?.revealed));
const canReveal = computed(
  () => Boolean(draft.value?.saveId) && !dirty.value && !revealed.value && !saving.value,
);
const stageProposals = computed<StageProposal[]>(() =>
  (blind.value?.proposals ?? []).map((proposal) => ({
    ...proposal,
    visible: visibility.value[proposal.key] !== false,
  })),
);
const loudnessAppliedDb = computed(() =>
  loudnessMatch.value ? Math.min(0, passage.value?.loudness_gain_db ?? 0) : 0,
);
const devicePxMs = computed(() => view.value.msPerPx / devicePixelRatio.value);
const zoomLabel = computed(() => {
  const msPerPx = devicePxMs.value;
  if (msPerPx >= 0.1) return `${msPerPx.toFixed(msPerPx < 1 ? 2 : 1)} ms/px`;
  const pxPerSample = 1000 / (passage.value?.audio.sample_rate ?? 44_100) / msPerPx;
  return `${pxPerSample.toFixed(1)} px/sample`;
});
const status = computed(() => {
  if (error.value) return { tone: "error", text: "Needs attention" };
  if (saving.value) return { tone: "warn", text: "Saving" };
  if (busy.value || audioState.value === "loading") return { tone: "warn", text: "Loading" };
  if (dirty.value) return { tone: "warn", text: `Unsaved · ${marks.value.length} marks` };
  if (draft.value?.saveId) return { tone: "ready", text: "Saved" };
  return { tone: "idle", text: "No marks saved" };
});
const marksFile = computed(() => opened.value?.marks_path.split(/[\\/]/).at(-1));
const conversion = computed(() => {
  const source = passage.value?.audio.sample_rate;
  const device = preferences.value.deviceRateHz;
  if (!source || !device) return "Device rate not stated";
  return device === source
    ? "No rate conversion"
    : `Device converts ${source.toLocaleString()} → ${device.toLocaleString()} Hz`;
});
const offsetNeedsCheck = computed(
  () =>
    deviceChanged.value ||
    (contextRate.value !== undefined &&
      preferences.value.offsetRate !== null &&
      preferences.value.offsetRate !== contextRate.value),
);

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("beforeunload", guardUnload);
  navigator.mediaDevices?.addEventListener?.("devicechange", markDeviceChanged);
  if (new URLSearchParams(window.location.search).get("session")) void open();
});
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("beforeunload", guardUnload);
  navigator.mediaDevices?.removeEventListener?.("devicechange", markDeviceChanged);
  cancelAnimationFrame(frame);
  void engine?.close();
  engine = undefined;
});

// While playing, the view jumps (never scrolls) to keep the playhead in sight.
watch(playheadMs, (timeMs) => {
  if (!playing.value || !follow.value || !stageWidth.value) return;
  const x = msToX(view.value, timeMs);
  // The pre-roll may start just left of the view; that alone does not move it.
  const prerollPx = preferences.value.prerollMs / view.value.msPerPx;
  if (x < -prerollPx - 1 || x > stageWidth.value)
    setView(placeAt(view.value, timeMs, stageWidth.value, 0.15));
});

function isDirty(entry: Draft): boolean {
  return differsFrom(entry.state, entry.saved);
}

function readPreferences(): Partial<TimingPreferences> {
  try {
    return JSON.parse(localStorage.getItem(preferencesKey) ?? "{}");
  } catch {
    return {};
  }
}

function setPreference<K extends keyof TimingPreferences>(key: K, value: TimingPreferences[K]) {
  preferences.value = { ...preferences.value, [key]: value };
  try {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences.value));
  } catch {}
}

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function markDeviceChanged() {
  deviceChanged.value = true;
}

function guardUnload(event: BeforeUnloadEvent) {
  if (!unsavedPassages.value) return;
  event.preventDefault();
  event.returnValue = "";
}

function changeMode(mode: WorkspaceMode) {
  if (
    unsavedPassages.value &&
    !window.confirm(`${unsavedPassages.value} passage(s) have unsaved marks. Leave timing mode?`)
  )
    return;
  emit("change-mode", mode);
}

function report(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : String(cause);
}

async function open() {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await timingJson<OpenTiming>("open", { session_path: sessionPath.value });
    if (disposed) return;
    try {
      localStorage.setItem(rememberedSession, sessionPath.value);
    } catch {}
    const owner = JSON.stringify([result.marks_path, result.id]);
    if (owner !== draftsOwner) drafts.value = new Map();
    draftsOwner = owner;
    openedPath = sessionPath.value;
    opened.value = result;
    await select(firstPassage(result));
  } catch (cause) {
    report(cause);
  } finally {
    busy.value = false;
  }
}

/** A session opens on a passage with unsaved marks, else the first unsaved passage, else 01. */
function firstPassage(session: OpenTiming): number {
  const drafted = session.passages.findIndex((row) => {
    const entry = drafts.value.get(row.id);
    return entry ? isDirty(entry) : false;
  });
  if (drafted >= 0) return drafted;
  return Math.max(0, session.passages.findIndex((row) => !row.saved));
}

function isStale(cause: unknown): boolean {
  return cause instanceof Error && cause.name === staleSessionError;
}

/**
 * Reopens the open session after the service restarted, keeping the drafts and the current
 * passage. The service replays saves, reveals and saved legends from the marks file, so this
 * reveals nothing new; an unsaved passage gets a new legend.
 */
async function reconnect() {
  const current = opened.value;
  const result = await timingJson<OpenTiming>("open", { session_path: openedPath });
  if (result.marks_path !== current?.marks_path || result.id !== current.id)
    throw new Error("The service now serves another session. Open this session again.");
  opened.value = result;
  notice.value =
    "Reconnected to the restarted service. Proposal colours of unsaved passages may have changed.";
}

/** A passage's blind view, reconnecting once if the service restarted. */
async function passageView(index: number): Promise<BlindPassage> {
  const request = () =>
    timingJson<BlindPassage>("passage", {
      session_id: opened.value?.session_id,
      passage_index: index,
    });
  try {
    return await request();
  } catch (cause) {
    if (!isStale(cause)) throw cause;
    await reconnect();
    return request();
  }
}

/**
 * Reconnects and reloads the current passage's proposals in place, keeping its marks, audio and
 * view. Returns whether the legend the listener saw changed.
 */
async function reconnectPassage(): Promise<boolean> {
  const legend = (view: BlindPassage | undefined) =>
    JSON.stringify(view?.proposals.map((p) => [p.key, p.colour_index]));
  const shown = legend(blind.value);
  await reconnect();
  const result = await passageView(passageIndex.value);
  if (disposed) return false;
  // Names are present only if the marks file already records this passage's reveal.
  names.value = result.names;
  blind.value = result;
  return legend(result) !== shown;
}

/** Choosing the current passage again reopens its audio in a new context (after a device change). */
async function select(index: number) {
  if (!opened.value?.passages[index]) return;
  stop();
  if (index === passageIndex.value && engine) await closeAudio();
  passageIndex.value = index;
  blind.value = undefined;
  names.value = undefined;
  busy.value = true;
  error.value = "";
  try {
    const result = await passageView(index);
    const row = opened.value?.passages[index];
    if (disposed || !row) return;
    await loadAudio(row);
    if (disposed) return;
    if (!drafts.value.has(row.id)) {
      const saved = result.saved?.marks ?? [];
      drafts.value.set(row.id, {
        state: marksState(saved),
        saved,
        saveId: result.saved?.save_id ?? null,
      });
      triggerRef(drafts);
    }
    if (result.saved?.setup && !preferences.value.setup)
      setPreference("setup", result.saved.setup);
    visibility.value = Object.fromEntries(result.proposals.map((p) => [p.key, true]));
    hiddenByP.value = undefined;
    names.value = result.names;
    loopRegion.value = { startMs: row.start_ms, endMs: row.end_ms };
    playheadMs.value = row.start_ms;
    const buffer = audioBuffer.value;
    silenceMs.value = buffer
      ? digitalSilence(
          Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
          buffer.sampleRate,
          row.start_ms,
          row.end_ms,
          200,
        )
      : undefined;
    fitPending = true;
    if (stageWidth.value) fitPassage();
    blind.value = result;
  } catch (cause) {
    report(cause);
  } finally {
    busy.value = false;
  }
}

/**
 * One context per sample rate: another recording at the same rate reuses it, a different rate
 * closes it and opens a new one, so contexts at two rates never coexist.
 */
async function loadAudio(row: BlindPassageRow) {
  const { audio } = row;
  if (engine && loadedHandle === audio.handle) return;
  audioState.value = "loading";
  audioBuffer.value = undefined;
  loadedHandle = "";
  if (engine && engine.sampleRate !== audio.sample_rate) {
    await engine.close();
    engine = undefined;
  }
  if (!engine) {
    engine = new TimingAudioEngine(audio.sample_rate);
    engine.onEnded = (positionMs) => {
      cancelAnimationFrame(frame);
      playing.value = false;
      playheadMs.value = positionMs;
    };
    contextRate.value = engine.sampleRate;
  }
  const bytes = await (
    await timingRequest("audio", { session_id: opened.value?.session_id, handle: audio.handle })
  ).arrayBuffer();
  if (disposed || !engine) return;
  audioBuffer.value = engine.load(deinterleave(bytes, audio.channels, audio.frames), audio.frames);
  engine.setVolume(preferences.value.volume);
  engine.setLoudnessDb(loudnessAppliedDb.value);
  loadedHandle = audio.handle;
  audioState.value = "ready";
}

async function closeAudio() {
  await engine?.close();
  engine = undefined;
  loadedHandle = "";
  audioBuffer.value = undefined;
  audioState.value = "none";
}

/** Drafts stay in the page, so reopening the same session brings them back. */
function close() {
  if (
    unsavedPassages.value &&
    !window.confirm(
      `${unsavedPassages.value} passage(s) have unsaved marks. They stay in this page only for reopening this session. Close it?`,
    )
  )
    return;
  stop();
  void closeAudio();
  opened.value = undefined;
  blind.value = undefined;
  error.value = "";
  notice.value = "";
}

// View
function onStageResize(width: number, dpr: number) {
  stageWidth.value = width;
  devicePixelRatio.value = dpr;
  if (fitPending) fitPassage();
  else setView(view.value);
}

function setView(next: TimeView) {
  if (!stageWidth.value || !passage.value) return;
  view.value = clampView(
    next,
    bounds.value,
    stageWidth.value,
    zoomLimits(bounds.value, stageWidth.value, passage.value.audio.sample_rate, devicePixelRatio.value),
  );
}

function fitPassage() {
  if (!stageWidth.value) return;
  fitPending = false;
  setView(fitView(span.value, stageWidth.value));
}

/** Keys zoom around the selected mark, or the playhead without one. */
function zoomAnchor(): number {
  return selected.value?.time_ms ?? playheadMs.value;
}

function zoom(factor: number) {
  setView(zoomAt(view.value, zoomAnchor(), factor));
}

function toggleFineZoom() {
  const fine = fineMsPerDevicePx * devicePixelRatio.value;
  if (view.value.msPerPx > fine * 1.01) {
    const anchor = zoomAnchor();
    setView({ startMs: anchor - (stageWidth.value / 2) * fine, msPerPx: fine });
  } else fitPassage();
}

function bringIntoView(timeMs: number) {
  const x = msToX(view.value, timeMs);
  if (x < 0 || x > stageWidth.value) setView(placeAt(view.value, timeMs, stageWidth.value, 0.5));
}

// Playback
function clampToBounds(timeMs: number): number {
  return Math.min(bounds.value.endMs, Math.max(bounds.value.startMs, timeMs));
}

/** Starts at `fromMs` minus the pre-roll; loops the region or plays to `endMs`. */
async function start(fromMs: number, endMs: number, loop: boolean) {
  if (!engine || audioState.value !== "ready") return;
  error.value = "";
  try {
    await engine.play({
      fromMs: prerollStart(fromMs, preferences.value.prerollMs),
      endMs,
      rate: rate.value,
      loop: loop ? { ...loopRegion.value } : null,
    });
    latencies.value = engine.latencies();
    playing.value = true;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
  } catch (cause) {
    report(cause);
  }
}

function tick() {
  if (!engine?.playing) return;
  const position = engine.position(preferences.value.playheadOffsetMs);
  if (position !== undefined) playheadMs.value = position;
  frame = requestAnimationFrame(tick);
}

/** Space: pause keeps the heard position; play resumes there (inside the loop when looping). */
function togglePlayback() {
  if (playing.value) {
    stop();
    return;
  }
  const region = loopRegion.value;
  if (looping.value) {
    const inside = playheadMs.value >= region.startMs && playheadMs.value < region.endMs;
    void start(inside ? playheadMs.value : region.startMs, region.endMs, true);
  } else {
    void start(playheadMs.value, bounds.value.endMs, false);
  }
}

function playRegionOnce() {
  stop();
  void start(loopRegion.value.startMs, loopRegion.value.endMs, false);
}

/** Stops at once, without a fade, and keeps the position that was being heard. */
function stop() {
  cancelAnimationFrame(frame);
  const heard = engine?.stop(preferences.value.playheadOffsetMs);
  if (playing.value && heard !== undefined) playheadMs.value = clampToBounds(heard);
  playing.value = false;
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
}

function stepPlayhead(deltaMs: number) {
  if (playing.value) return;
  playheadMs.value = clampToBounds(playheadMs.value + deltaMs);
  bringIntoView(playheadMs.value);
}

function toggleLoop() {
  restartIfPlaying(() => {
    looping.value = !looping.value;
  });
}

function setLoopRegion(region: TimeRange) {
  const clamped = {
    startMs: clampToBounds(region.startMs),
    endMs: clampToBounds(region.endMs),
  };
  if (clamped.endMs <= clamped.startMs) return;
  restartIfPlaying(() => {
    loopRegion.value = clamped;
  });
}

function setLoopEdge(edge: "startMs" | "endMs") {
  setLoopRegion({ ...loopRegion.value, [edge]: playheadMs.value });
}

function loopAroundSelected() {
  const mark = selected.value;
  if (!mark) return;
  stop();
  loopRegion.value = {
    startMs: clampToBounds(mark.time_ms - markLoopMs),
    endMs: clampToBounds(mark.time_ms + markLoopMs),
  };
  looping.value = true;
  playheadMs.value = loopRegion.value.startMs;
  togglePlayback();
}

function setRate(value: (typeof playbackRates)[number]) {
  restartIfPlaying(() => {
    rate.value = value;
  });
}

function setVolume(value: number) {
  setPreference("volume", value);
  engine?.setVolume(value);
}

function setLoudnessMatch(value: boolean) {
  loudnessMatch.value = value;
  engine?.setLoudnessDb(loudnessAppliedDb.value);
}

function setPlayheadOffset(value: number) {
  if (!Number.isFinite(value)) return;
  setPreference("playheadOffsetMs", Math.round(value * 1000) / 1000);
  setPreference("offsetRate", contextRate.value ?? null);
  deviceChanged.value = false;
}

function setPreroll(value: number) {
  if (Number.isFinite(value)) setPreference("prerollMs", Math.max(minimumPrerollMs, value));
}

// Proposals
function toggleProposal(index: number) {
  const proposal = blind.value?.proposals[index];
  if (!proposal) return;
  visibility.value = { ...visibility.value, [proposal.key]: visibility.value[proposal.key] === false };
  hiddenByP.value = undefined;
}

/** `P` hides every proposal; pressed again it restores the ones that were on. */
function toggleAllProposals() {
  if (hiddenByP.value) {
    const restore = hiddenByP.value;
    visibility.value = Object.fromEntries(
      Object.keys(visibility.value).map((key) => [key, restore.includes(key)]),
    );
    hiddenByP.value = undefined;
    return;
  }
  hiddenByP.value = Object.keys(visibility.value).filter((key) => visibility.value[key] !== false);
  visibility.value = Object.fromEntries(Object.keys(visibility.value).map((key) => [key, false]));
}

function proposalName(key: string): string | undefined {
  return names.value?.find((entry) => entry.key === key)?.name;
}

// Marks
function updateMarks(change: (state: MarksState) => MarksState) {
  const row = passage.value;
  const current = draft.value;
  if (!row || !current) return;
  const next = change(current.state);
  if (next === current.state) return;
  drafts.value.set(row.id, { ...current, state: next });
  triggerRef(drafts);
}

function place(kind: MarkKind, timeMs: number, method: MarkMethod) {
  if (timeMs < span.value.startMs || timeMs > span.value.endMs) return;
  const mark: Mark = {
    id: crypto.randomUUID(),
    kind,
    time_ms: timeMs,
    placed: new Date().toISOString(),
    method,
    zoom_ms_per_px: devicePxMs.value,
    rate_at_placement: rate.value,
    blind: !revealed.value,
    nudged_ms: 0,
    snapped_to: null,
  };
  updateMarks((state) => addMark(state, mark));
}

function selectById(id: string | null) {
  updateMarks((state) => selectMark(state, id));
}

function selectAdjacent(direction: 1 | -1) {
  const state = draft.value?.state;
  if (!state) return;
  const mark = adjacentMark(state, direction, playheadMs.value);
  if (!mark) return;
  selectById(mark.id);
  if (!playing.value) playheadMs.value = mark.time_ms;
  bringIntoView(mark.time_ms);
}

/** Arrow keys nudge the selected mark, or step the playhead without one. */
function nudge(deltaMs: number) {
  if (!selected.value) {
    stepPlayhead(deltaMs);
    return;
  }
  updateMarks((state) => nudgeSelected(state, deltaMs, span.value, revealed.value));
}

function oneSampleMs(): number {
  return 1000 / (passage.value?.audio.sample_rate ?? 44_100);
}

// Save and reveal
function playbackSetup(): PlaybackSetup {
  const measured = engine?.latencies() ?? latencies.value;
  return {
    rate: rate.value,
    volume: preferences.value.volume,
    loudness_match: loudnessMatch.value,
    loudness_gain_db: passage.value?.loudness_gain_db ?? 0,
    loudness_applied_db: loudnessAppliedDb.value,
    playhead_offset_ms: preferences.value.playheadOffsetMs,
    preroll_ms: preferences.value.prerollMs,
    device_rate_hz: preferences.value.deviceRateHz,
    base_latency_ms: measured.base_latency_ms,
    output_latency_ms: measured.output_latency_ms,
  };
}

function pageProvenance(): PageProvenance {
  const brands =
    (
      navigator as Navigator & { userAgentData?: { brands: { brand: string; version: string }[] } }
    ).userAgentData?.brands.map((entry) => `${entry.brand} ${entry.version}`) ?? [];
  return {
    transport: "copyToChannel",
    context_sample_rate: engine?.sampleRate ?? 0,
    buffer_frames: audioBuffer.value?.length ?? 0,
    buffer_channels: audioBuffer.value?.numberOfChannels ?? 0,
    clock_method: "getOutputTimestamp",
    user_agent: navigator.userAgent,
    browser_brands: brands,
  };
}

async function save() {
  const row = passage.value;
  const current = draft.value;
  if (!row || !current || saving.value || !blind.value) return;
  if (!preferences.value.setup.trim()) {
    error.value = "Describe the playback setup before saving.";
    document.getElementById("timing-setup")?.focus();
    return;
  }
  const snapshot = current.state.marks;
  saving.value = true;
  error.value = "";
  const request = () =>
    timingJson<SaveResponse>("save", {
      session_id: opened.value?.session_id,
      passage_index: passageIndex.value,
      marks: snapshot,
      setup: preferences.value.setup,
      playback: playbackSetup(),
      page: pageProvenance(),
      visible_keys: stageProposals.value.filter((p) => p.visible).map((p) => p.key),
    });
  try {
    let response: SaveResponse;
    try {
      response = await request();
    } catch (cause) {
      if (!isStale(cause)) throw cause;
      // The save records the legend the listener saw, so it is retried only if that is unchanged.
      if (await reconnectPassage()) {
        error.value =
          "The service restarted and gave this passage new proposal colours. Check them, then save again.";
        return;
      }
      response = await request();
    }
    if (disposed) return;
    const latest = drafts.value.get(row.id);
    if (latest) drafts.value.set(row.id, { ...latest, saved: snapshot, saveId: response.save_id });
    triggerRef(drafts);
    const savedRow = opened.value?.passages.find((entry) => entry.id === row.id);
    if (savedRow) savedRow.saved = true;
  } catch (cause) {
    // fetch rejects with a TypeError when nothing answers.
    if (cause instanceof TypeError)
      error.value =
        "The local timing service is not answering. Start it again, then save; the marks stay in this page.";
    else report(cause);
  } finally {
    saving.value = false;
  }
}

async function revealNames() {
  const row = passage.value;
  const current = draft.value;
  if (!row || !current?.saveId || !canReveal.value) return;
  error.value = "";
  try {
    const result = await timingJson<{ names: RevealedName[] }>("reveal", {
      session_id: opened.value?.session_id,
      passage_index: passageIndex.value,
      save_id: current.saveId,
    });
    if (disposed) return;
    names.value = result.names;
    row.revealed = true;
  } catch (cause) {
    if (!isStale(cause)) {
      report(cause);
      return;
    }
    // Reconnecting does not reveal; the listener presses Reveal again on the reopened session.
    try {
      await reconnectPassage();
      error.value = "Reconnected to the restarted service. Press Reveal names again.";
    } catch (failure) {
      report(failure);
    }
  }
}

// Keyboard
function handleKeydown(event: KeyboardEvent) {
  if (!blind.value || event.defaultPrevented || event.altKey) return;
  const key = event.key;
  // Save works from any field, including the setup line, instead of the browser's page save.
  if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === "s") {
    event.preventDefault();
    void save();
    return;
  }
  if (isTypingTarget(event.target)) return;
  if (event.metaKey || event.ctrlKey) {
    const lower = key.toLowerCase();
    if (lower !== "z") return;
    updateMarks(event.shiftKey ? redo : undo);
    event.preventDefault();
    return;
  }
  if (key === " " || key === "Enter") {
    if (isNativeActivationTarget(event.target)) return;
    event.preventDefault();
    if (key === "Enter") void save();
    else if (event.shiftKey) playRegionOnce();
    else togglePlayback();
    return;
  }
  // Shift+[ and Shift+] move between passages, by key position so other layouts work too.
  if (event.shiftKey && (event.code === "BracketLeft" || event.code === "BracketRight")) {
    event.preventDefault();
    const next = passageIndex.value + (event.code === "BracketLeft" ? -1 : 1);
    if (next >= 0 && next < (opened.value?.passages.length ?? 0)) void select(next);
    return;
  }
  const fine = event.shiftKey ? 0.1 : 1;
  const actions: Record<string, () => void> = {
    Escape: () => {
      if (stage.value?.cancelDrag()) return;
      stop();
      selectById(null);
    },
    l: toggleLoop,
    i: () => setLoopEdge("startMs"),
    o: () => setLoopEdge("endMs"),
    x: loopAroundSelected,
    Home: () => seek(span.value.startMs),
    End: () => seek(span.value.endMs),
    ArrowLeft: () => nudge(-fine),
    ArrowRight: () => nudge(fine),
    ",": () => nudge(-oneSampleMs()),
    ".": () => nudge(oneSampleMs()),
    "+": () => zoom(0.5),
    "=": () => zoom(0.5),
    "-": () => zoom(2),
    "0": fitPassage,
    z: toggleFineZoom,
    f: () => {
      follow.value = !follow.value;
    },
    b: () => place("beat", playheadMs.value, "key-playhead"),
    n: () => place("unbeat", playheadMs.value, "key-playhead"),
    "[": () => selectAdjacent(-1),
    "]": () => selectAdjacent(1),
    k: () => updateMarks((state) => flipSelected(state, revealed.value)),
    Delete: () => updateMarks(removeSelected),
    Backspace: () => updateMarks(removeSelected),
    p: toggleAllProposals,
  };
  const action =
    actions[key.length === 1 ? key.toLowerCase() : key] ??
    (/^[1-9]$/.test(key) ? () => toggleProposal(Number(key) - 1) : undefined);
  if (!action) return;
  event.preventDefault();
  action();
}
</script>

<template>
  <main
    id="main-content"
    class="bench annotation-bench"
    :class="{ 'has-active-workspace': opened }"
    tabindex="-1"
  >
    <header v-if="!opened" class="app-bar annotation-app-bar">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true"></span>
        <div>
          <p class="brand-name">Beatmap Lens</p>
          <p class="brand-edition">Beat timing</p>
        </div>
      </div>
      <div class="annotation-chart-context">
        <span>Timing session</span>
        <strong>Not opened</strong>
      </div>
      <WorkspaceModeSwitch
        model-value="timing"
        :disabled="busy"
        @update:model-value="changeMode"
      />
    </header>

    <section v-if="!opened" class="annotation-onboarding" aria-labelledby="timing-heading">
      <div class="onboarding-intro">
        <p class="section-kicker"><span class="section-number">01</span> Listening by ear</p>
        <h1 id="timing-heading">Mark where the beats are</h1>
        <p>
          Place beat and unbeat marks on the still waveform of the source audio, and confirm them by
          listening. Proposals are drawn in anonymous colours and stay silent; their names are
          shown only when you reveal them after saving.
        </p>
        <p>
          The moving playhead shows which beat is sounding to about one display frame (8 ms at
          60 Hz). Place and check marks on the still waveform.
        </p>
        <dl class="onboarding-policies">
          <div>
            <dt>Audio</dt>
            <dd>Native rate and channels</dd>
          </div>
          <div>
            <dt>Proposals</dt>
            <dd>Blind, visual only</dd>
          </div>
          <div>
            <dt>Marks</dt>
            <dd>Appended snapshots</dd>
          </div>
        </dl>
      </div>

      <form class="onboarding-form" @submit.prevent="open">
        <label class="field-stack">
          <span>Session path</span>
          <input
            v-model="sessionPath"
            name="session"
            placeholder="Full path to a .timing.json file"
            autocomplete="off"
            spellcheck="false"
            required
            :disabled="busy"
          />
        </label>
        <p class="setup-note">
          Paths starting with ~/ work. Marks are appended to &lt;session&gt;.timing.marks.jsonl
          beside the session file.
        </p>
        <p v-if="unsavedPassages" class="inline-message">
          Unsaved marks in {{ unsavedPassages }} passage(s) are kept in this page. Reopen the same
          session to save them.
        </p>
        <p v-if="error" class="inline-message inline-message--error" role="alert">{{ error }}</p>
        <button class="button button--primary onboarding-submit" type="submit" :disabled="busy">
          {{ busy ? "Opening" : "Open session" }}
        </button>
      </form>
    </section>

    <template v-else>
      <p class="timing-desktop-note">Timing mode needs a desktop window wider than 920 px.</p>

      <div class="annotation-workspace timing-workspace">
        <aside class="annotation-rail annotation-source-rail" aria-labelledby="passages-heading">
          <div class="active-workspace-identity">
            <div class="brand-lockup">
              <span class="brand-mark" aria-hidden="true"></span>
              <div>
                <p class="brand-name">Beatmap Lens</p>
                <p class="brand-edition">Beat timing</p>
              </div>
            </div>
            <WorkspaceModeSwitch
              model-value="timing"
              :disabled="busy || saving"
              @update:model-value="changeMode"
            />
            <div class="active-dataset-identity">
              <span>{{ marksFile }}</span>
              <strong>{{ opened.id }}</strong>
            </div>
          </div>

          <header class="annotation-rail-header">
            <div>
              <p class="section-kicker"><span class="section-number">01</span> Session</p>
              <h2 id="passages-heading">Passages</h2>
            </div>
            <span class="rail-count">
              {{ opened.passages.filter((row) => row.saved).length }} / {{ opened.passages.length }}
            </span>
          </header>

          <nav class="task-list" aria-label="Passages">
            <button
              v-for="(row, index) in opened.passages"
              :key="row.id"
              class="task-row"
              :class="{ 'is-active': index === passageIndex }"
              type="button"
              :aria-current="index === passageIndex ? 'step' : undefined"
              :disabled="busy || saving"
              @click="select(index)"
            >
              <span
                class="task-status-mark"
                :class="{ 'task-status-mark--complete': row.saved }"
                aria-hidden="true"
              ></span>
              <span class="task-copy">
                <strong>{{ String(index + 1).padStart(2, "0") }} {{ row.title }}</strong>
                <span>{{ formatSourceTime(row.start_ms) }}–{{ formatSourceTime(row.end_ms) }}</span>
              </span>
              <span class="task-status-label">
                {{
                  drafts.get(row.id) && isDirty(drafts.get(row.id) as Draft)
                    ? "draft"
                    : row.saved
                      ? "saved"
                      : ""
                }}
              </span>
            </button>
          </nav>

          <section v-if="passage" class="rail-section" aria-labelledby="passage-heading">
            <h3 id="passage-heading">Passage</h3>
            <dl class="compact-facts">
              <div v-if="passage.flags.length">
                <dt>Flags</dt>
                <dd>{{ passage.flags.join(", ") }}</dd>
              </div>
              <div>
                <dt>Hint</dt>
                <dd>{{ passage.hint || "—" }}</dd>
              </div>
            </dl>
          </section>

          <section class="rail-section">
            <button class="button button--quiet" type="button" :disabled="busy" @click="close">
              Open another session
            </button>
          </section>
        </aside>

        <section class="annotation-stage timing-stage-column" aria-label="Timing stage">
          <header v-if="passage" class="timing-hud">
            <div class="timing-hud-line">
              <strong>
                Passage {{ String(passageIndex + 1).padStart(2, "0") }} of
                {{ opened.passages.length }} · {{ formatSourceTime(passage.start_ms) }}–{{
                  formatSourceTime(passage.end_ms)
                }}
              </strong>
              <span class="health-status" :class="`health-status--${revealed ? 'ready' : 'idle'}`">
                <span class="health-dot" aria-hidden="true"></span>
                {{ revealed ? "Revealed" : "Blind" }}
              </span>
              <span class="health-status" :class="`health-status--${status.tone}`" aria-live="polite">
                <span class="health-dot" aria-hidden="true"></span>
                {{ status.text }}
              </span>
            </div>
            <div class="timing-hud-line timing-hud-data">
              <span>{{ formatSourceTime(playheadMs, devicePxMs < 1 ? 1 : 0) }}</span>
              <span>zoom {{ zoomLabel }}</span>
              <span>follow {{ follow ? "on" : "off" }}</span>
              <span>
                loop {{ looping ? "on" : "off" }} {{ formatSourceTime(loopRegion.startMs) }}–{{
                  formatSourceTime(loopRegion.endMs)
                }}
              </span>
              <span>{{ rate }}×</span>
              <span v-if="silenceMs !== undefined" class="timing-warning">
                silence at {{ formatSourceTime(silenceMs) }}; an EQ app may soften the next onset
              </span>
            </div>
          </header>
          <TimingStage
            v-if="blind && audioBuffer && passage"
            ref="stage"
            :buffer="audioBuffer"
            :span="span"
            :bounds="bounds"
            :view="view"
            :proposals="stageProposals"
            :marks="marks"
            :selected-id="draft?.state.selectedId ?? null"
            :playhead-ms="playheadMs"
            :loop-region="loopRegion"
            :looping="looping"
            @resize="onStageResize"
            @update:view="setView"
            @place="(kind, timeMs) => place(kind, timeMs, 'click')"
            @select="selectById"
            @seek="seek"
            @loop-region="setLoopRegion"
          />
          <div v-else-if="error" class="stage-message">
            <p class="inline-message inline-message--error" role="alert">{{ error }}</p>
            <button class="button button--quiet" type="button" @click="select(passageIndex)">
              Reload passage
            </button>
          </div>
          <div v-else class="stage-empty">
            {{ audioState === "loading" ? "Loading audio" : "Loading passage" }}
          </div>
        </section>

        <aside class="annotation-rail annotation-details-rail timing-details" aria-label="Details">
          <section class="details-transport" aria-label="Playback">
            <div class="details-transport-status">
              <div>
                <span>Playhead</span>
                <strong>{{ formatSourceTime(playheadMs) }}</strong>
              </div>
              <div class="details-transport-state">
                <span>{{ revealed ? "Revealed" : "Blind" }}</span>
                <span class="health-status" :class="`health-status--${status.tone}`">
                  <span class="health-dot" aria-hidden="true"></span>
                  {{ status.text }}
                </span>
              </div>
            </div>

            <fieldset class="transport-controls timing-transport" aria-label="Playback controls">
              <button
                class="transport-button transport-button--primary"
                type="button"
                :disabled="audioState !== 'ready'"
                :aria-pressed="playing"
                aria-keyshortcuts="Space"
                @click="togglePlayback"
              >
                {{ playing ? "Pause" : "Play" }}
              </button>
              <button
                class="transport-button"
                :class="{ 'is-active': looping }"
                type="button"
                :disabled="audioState !== 'ready'"
                :aria-pressed="looping"
                aria-keyshortcuts="L"
                @click="toggleLoop"
              >
                Loop
              </button>
              <button
                class="transport-button"
                type="button"
                :disabled="audioState !== 'ready'"
                aria-keyshortcuts="Escape"
                @click="stop"
              >
                Stop
              </button>
            </fieldset>

            <div class="transport-tuning">
              <div class="speed-controls">
                <span>Rate</span>
                <div class="speed-presets" :style="{ '--count': playbackRates.length }">
                  <button
                    v-for="value in playbackRates"
                    :key="value"
                    type="button"
                    :class="{ 'is-active': rate === value }"
                    :aria-pressed="rate === value"
                    @click="setRate(value)"
                  >
                    {{ value }}×
                  </button>
                </div>
              </div>
              <div class="speed-controls">
                <span>Zoom</span>
                <div class="speed-presets" style="--count: 4">
                  <button type="button" aria-keyshortcuts="+" @click="zoom(0.5)">In</button>
                  <button type="button" aria-keyshortcuts="-" @click="zoom(2)">Out</button>
                  <button type="button" aria-keyshortcuts="0" @click="fitPassage">Fit</button>
                  <button type="button" aria-keyshortcuts="Z" @click="toggleFineZoom">Fine</button>
                </div>
              </div>
              <div class="speed-controls">
                <span>Follow</span>
                <div class="speed-presets" style="--count: 3">
                  <button
                    type="button"
                    :class="{ 'is-active': follow }"
                    :aria-pressed="follow"
                    aria-keyshortcuts="F"
                    @click="follow = !follow"
                  >
                    {{ follow ? "On" : "Off" }}
                  </button>
                  <button type="button" aria-keyshortcuts="I" @click="setLoopEdge('startMs')">
                    Loop in
                  </button>
                  <button type="button" aria-keyshortcuts="O" @click="setLoopEdge('endMs')">
                    Loop out
                  </button>
                </div>
              </div>
              <AudioVolumeControl :model-value="preferences.volume" @update:model-value="setVolume" />
              <label class="timing-check">
                <input
                  type="checkbox"
                  :checked="loudnessMatch"
                  @change="setLoudnessMatch(($event.target as HTMLInputElement).checked)"
                />
                <span>
                  Match loudness
                  <output>{{ (passage?.loudness_gain_db ?? 0).toFixed(1) }} dB</output>
                </span>
              </label>
              <p v-if="(passage?.loudness_gain_db ?? 0) > 0" class="setup-note">
                Gains above 0 dB are shown but not applied.
              </p>
            </div>
          </section>

          <section class="editor-section" aria-labelledby="offset-heading">
            <div class="audio-offset-control">
              <div class="transport-control-label">
                <span id="offset-heading">Playhead offset</span>
                <small>Wall-clock ms; positive moves the bar earlier</small>
              </div>
              <div class="audio-offset-editor timing-offset-editor">
                <button
                  type="button"
                  title="Shift: 10 ms"
                  @click="setPlayheadOffset(preferences.playheadOffsetMs - ($event.shiftKey ? 10 : 1))"
                >
                  −1
                </button>
                <label>
                  <span class="sr-only">Playhead offset in milliseconds</span>
                  <input
                    type="number"
                    step="1"
                    :value="preferences.playheadOffsetMs"
                    @change="setPlayheadOffset(($event.target as HTMLInputElement).valueAsNumber)"
                  />
                  <small>ms</small>
                </label>
                <button
                  type="button"
                  title="Shift: 10 ms"
                  @click="setPlayheadOffset(preferences.playheadOffsetMs + ($event.shiftKey ? 10 : 1))"
                >
                  +1
                </button>
                <button
                  type="button"
                  :disabled="preferences.playheadOffsetMs === 0"
                  @click="setPlayheadOffset(0)"
                >
                  Reset
                </button>
              </div>
              <small v-if="offsetNeedsCheck" class="timing-warning">
                The output changed since the offset was set; check it again.
              </small>
            </div>
            <button
              class="button button--quiet timing-wide"
              type="button"
              :disabled="busy || saving"
              @click="select(passageIndex)"
            >
              Reopen audio after a device change
            </button>

            <div class="timing-field-pair">
              <label class="field-stack timing-inline-field">
                <span>Pre-roll ms (≥ {{ minimumPrerollMs }})</span>
                <input
                  type="number"
                  :min="minimumPrerollMs"
                  step="10"
                  :value="preferences.prerollMs"
                  @change="setPreroll(($event.target as HTMLInputElement).valueAsNumber)"
                />
              </label>
              <label class="field-stack timing-inline-field">
                <span>Output device rate</span>
                <select
                  :value="preferences.deviceRateHz ?? ''"
                  @change="
                    setPreference(
                      'deviceRateHz',
                      Number(($event.target as HTMLSelectElement).value) || null,
                    )
                  "
                >
                  <option value="">Not stated</option>
                  <option v-for="value in deviceRates" :key="value" :value="value">
                    {{ value.toLocaleString() }} Hz
                  </option>
                </select>
              </label>
            </div>

            <dl class="compact-facts timing-facts">
              <div>
                <dt>Recording</dt>
                <dd>
                  {{ passage?.audio.sample_rate.toLocaleString() }} Hz ·
                  {{ passage?.audio.channels }} ch
                </dd>
              </div>
              <div>
                <dt>Context</dt>
                <dd>{{ contextRate?.toLocaleString() ?? "—" }} Hz</dd>
              </div>
              <div>
                <dt>Conversion</dt>
                <dd :class="{ 'timing-warning': conversion.startsWith('Device converts') }">
                  {{ conversion }}
                </dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd>
                  base {{ latencies.base_latency_ms?.toFixed(1) ?? "—" }} · out
                  {{ latencies.output_latency_ms?.toFixed(1) ?? "—" }} ms
                </dd>
              </div>
            </dl>
          </section>

          <section class="editor-section" aria-labelledby="proposals-heading">
            <div class="editor-section-heading">
              <h3 id="proposals-heading">Proposals {{ revealed ? "" : "(blind)" }}</h3>
            </div>
            <ul class="timing-legend">
              <li v-for="(proposal, index) in stageProposals" :key="proposal.key">
                <button
                  type="button"
                  class="timing-legend-row"
                  :class="{ 'is-off': !proposal.visible }"
                  :aria-pressed="proposal.visible"
                  :aria-keyshortcuts="index < 9 ? String(index + 1) : undefined"
                  @click="toggleProposal(index)"
                >
                  <span class="timing-legend-index">{{ index + 1 }}</span>
                  <span
                    class="timing-swatch"
                    :style="{ background: proposalColour(proposal.colour_index).colour }"
                    aria-hidden="true"
                  ></span>
                  <span class="timing-legend-name">
                    {{ proposalColour(proposal.colour_index).name }}
                    <strong v-if="proposalName(proposal.key)">{{ proposalName(proposal.key) }}</strong>
                  </span>
                  <span class="timing-legend-state">{{ proposal.visible ? "on" : "off" }}</span>
                </button>
              </li>
              <li v-if="!stageProposals.length" class="setup-note">No proposals for this passage.</li>
            </ul>
            <button
              v-if="stageProposals.length"
              class="button button--quiet timing-wide"
              type="button"
              aria-keyshortcuts="P"
              @click="toggleAllProposals"
            >
              {{ hiddenByP ? "Show proposals again" : "Hide all proposals" }}
            </button>
          </section>

          <section class="editor-section" aria-labelledby="marks-heading">
            <div class="editor-section-heading timing-marks-heading">
              <h3 id="marks-heading">Marks</h3>
              <span class="rail-count">{{ marks.length }}</span>
            </div>
            <div class="timing-mark-actions">
              <button
                type="button"
                class="button button--quiet"
                aria-keyshortcuts="B"
                @click="place('beat', playheadMs, 'key-playhead')"
              >
                Beat at playhead
              </button>
              <button
                type="button"
                class="button button--quiet"
                aria-keyshortcuts="N"
                @click="place('unbeat', playheadMs, 'key-playhead')"
              >
                Unbeat at playhead
              </button>
              <button
                type="button"
                class="button button--quiet"
                :disabled="!selected"
                aria-keyshortcuts="K"
                @click="updateMarks((state) => flipSelected(state, revealed))"
              >
                Flip kind
              </button>
              <button
                type="button"
                class="button button--quiet"
                :disabled="!selected"
                aria-keyshortcuts="Delete"
                @click="updateMarks(removeSelected)"
              >
                Delete
              </button>
              <button
                type="button"
                class="button button--quiet"
                :disabled="!draft?.state.past.length"
                aria-keyshortcuts="Meta+Z Control+Z"
                @click="updateMarks(undo)"
              >
                Undo
              </button>
              <button
                type="button"
                class="button button--quiet"
                :disabled="!draft?.state.future.length"
                aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z"
                @click="updateMarks(redo)"
              >
                Redo
              </button>
            </div>
            <ol class="timing-mark-list">
              <li v-for="mark in marks" :key="mark.id">
                <button
                  type="button"
                  :class="{ 'is-active': mark.id === draft?.state.selectedId }"
                  :aria-pressed="mark.id === draft?.state.selectedId"
                  @click="
                    selectById(mark.id);
                    seek(mark.time_ms);
                    bringIntoView(mark.time_ms);
                  "
                >
                  <span aria-hidden="true">{{ mark.kind === "beat" ? "▼" : "⊘" }}</span>
                  <span class="timing-mark-time">{{ formatSourceTime(mark.time_ms, 1) }}</span>
                  <span>{{ mark.kind }}{{ mark.blind ? "" : " · seen" }}</span>
                </button>
              </li>
            </ol>
            <p class="setup-note">
              Click places a beat, right-click an unbeat. ←/→ nudge 1 ms (Shift 0.1 ms), , and .
              one sample. [ and ] visit marks.
            </p>
          </section>

          <section class="editor-section" aria-labelledby="save-heading">
            <div class="editor-section-heading">
              <h3 id="save-heading">Save</h3>
            </div>
            <label class="field-stack">
              <span>Playback setup</span>
              <input
                id="timing-setup"
                :value="preferences.setup"
                placeholder="DT 270 PRO · FineTune bypassed · 48 kHz device"
                autocomplete="off"
                @input="setPreference('setup', ($event.target as HTMLInputElement).value)"
              />
            </label>
            <button
              class="button button--primary timing-wide"
              type="button"
              :disabled="saving || !blind"
              aria-keyshortcuts="Meta+S Control+S Enter"
              @click="save"
            >
              {{ saving ? "Saving" : "Save marks" }}
            </button>
            <button
              class="button button--quiet timing-wide"
              type="button"
              :disabled="!canReveal"
              @click="revealNames"
            >
              {{ revealed ? "Names revealed" : "Reveal names" }}
            </button>
            <p v-if="error && blind" class="inline-message inline-message--error" role="alert">
              {{ error }}
            </p>
            <p v-if="notice" class="inline-message" role="status">{{ notice }}</p>
            <p class="setup-note timing-output">
              Marks append to <span>{{ opened.marks_path }}</span>
            </p>
          </section>
        </aside>
      </div>
    </template>
  </main>
</template>

<style scoped>
.timing-stage-column {
  display: flex;
  flex-direction: column;
  background: #101820;
}

.timing-hud {
  display: grid;
  flex: 0 0 auto;
  gap: 4px;
  padding: 10px 14px;
  color: oklch(92% 0.01 255);
  border-bottom: 1px solid oklch(30% 0.02 255);
  background: #0b1117;
}

.timing-hud-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  min-width: 0;
  font-size: 0.62rem;
}

.timing-hud-line strong {
  font-family: var(--font-data);
  font-weight: 620;
}

.timing-hud .health-status {
  color: oklch(85% 0.01 255);
  font-size: 0.56rem;
}

.timing-hud-data {
  color: oklch(78% 0.01 255);
  font-family: var(--font-data);
  font-size: 0.58rem;
  font-variant-numeric: tabular-nums;
}

.timing-details {
  overflow-y: auto;
  overscroll-behavior: contain;
}

.details-transport .timing-transport {
  grid-template-columns: 2fr 1fr 1fr;
}

.details-transport .speed-controls {
  grid-template-columns: 56px minmax(0, 1fr);
}

.details-transport .speed-presets {
  grid-template-columns: repeat(var(--count), minmax(0, 1fr));
}

.timing-check {
  display: flex;
  min-height: 40px;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.timing-check input {
  accent-color: var(--signal);
}

.timing-check output {
  margin-left: 6px;
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
}

.timing-offset-editor {
  grid-template-columns: auto minmax(64px, 1fr) auto auto;
}

.timing-warning {
  color: oklch(72% 0.15 76);
  font-size: 0.55rem;
}

.timing-details .timing-warning {
  color: oklch(52% 0.14 76);
}

.timing-field-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.timing-inline-field input,
.timing-inline-field select {
  min-height: 40px;
}

.timing-facts {
  margin-top: 12px;
}

.timing-facts dd {
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
}

.timing-legend,
.timing-mark-list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.timing-legend-row,
.timing-mark-list button {
  display: grid;
  width: 100%;
  min-height: 40px;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  color: var(--ink);
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  font-size: 0.66rem;
  text-align: left;
}

.timing-legend-row {
  grid-template-columns: 14px 14px minmax(0, 1fr) auto;
}

.timing-legend-row:hover,
.timing-mark-list button:hover {
  background: var(--surface-hover);
}

.timing-swatch {
  width: 12px;
  height: 12px;
  border-radius: 3px;
}

.timing-legend-row.is-off {
  color: var(--ink-muted);
}

.timing-legend-row.is-off .timing-swatch {
  opacity: 0.3;
}

.timing-legend-index,
.timing-legend-state,
.timing-mark-time {
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
}

.timing-legend-name strong {
  margin-left: 6px;
  font-weight: 650;
}

.timing-wide {
  width: 100%;
  min-height: 40px;
  margin-top: 10px;
}

.timing-marks-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.timing-mark-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin-bottom: 10px;
}

.timing-mark-actions .button {
  min-height: 40px;
  font-size: 0.6rem;
}

.timing-mark-list {
  max-height: 280px;
  overflow-y: auto;
}

.timing-mark-list button {
  grid-template-columns: 14px auto minmax(0, 1fr);
}

.timing-mark-list button.is-active {
  color: var(--signal);
  background: var(--signal-soft);
}

.timing-output span {
  font-family: var(--font-data);
  overflow-wrap: anywhere;
}

.timing-desktop-note {
  display: none;
}

@media (max-width: 920px) {
  .timing-desktop-note {
    display: block;
    margin: 0;
    padding: 24px;
    font-size: 0.8rem;
  }

  .timing-workspace {
    display: none;
  }
}
</style>
