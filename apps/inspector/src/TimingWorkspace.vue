<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, triggerRef, watch } from "vue";
import AudioVolumeControl from "./AudioVolumeControl.vue";
import { isNativeActivationTarget, isTypingTarget } from "./annotation/keyboard-targets";
import DraftNumberInput from "./DraftNumberInput.vue";
import PanelSection from "./layout/PanelSection.vue";
import type { PaneSpec } from "./layout/pane-layout";
import WorkspaceFrame from "./layout/WorkspaceFrame.vue";
import TimingStage, { type LocatePhase, type StageProposal } from "./TimingStage.vue";
import { TimingAudioEngine } from "./timing/audio-engine";
import { timingJson, timingRequest } from "./timing/client";
import {
  type BlindPassage,
  type BlindPassageRow,
  type LastSetup,
  type Mark,
  type MarkKind,
  type MarkMethod,
  noteMaxLength,
  type OpenTiming,
  type PageProvenance,
  type PassageNote,
  type PlaybackSetup,
  type RevealedName,
  type SaveResponse,
  type SessionNote,
  type SessionNoteResponse,
  staleSessionError,
} from "./timing/contracts";
import {
  followView,
  loopReanchorDue,
  motionAt,
  needsResync,
  nextFollowCheckMs,
  type PlayheadMotion,
  readoutIntervalMs,
  transportDelayMs,
} from "./timing/display";
import { nearestSample } from "./timing/format";
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
  type SelectMode,
  selectedMark,
  selectedMarks,
  selectMark,
  selectMarks,
  undo,
} from "./timing/marks";
import { proposalColour } from "./timing/palette";
import { deinterleave } from "./timing/pcm";
import {
  type Detection,
  deviceRate,
  initialSetup,
  probeDeviceRate,
  rateConflict,
  recordedSetup,
  type SetupLine,
} from "./timing/setup";
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
import { prerollStart } from "./timing/transport";
import { nearSilence } from "./timing/waveform";
import WorkspaceModeSwitch from "./WorkspaceModeSwitch.vue";
import type { WorkspaceMode } from "./workspace-mode";

const emit = defineEmits<{ "change-mode": [mode: WorkspaceMode] }>();

const rememberedSession = "lens-timing-session";
const preferencesKey = "lens-timing-preferences";
const playbackRates = [1, 0.75, 0.5, 0.25] as const;
/** At least this much real preceding audio is played before every start. */
const minimumPrerollMs = 120;
const deviceRates = [44_100, 48_000, 88_200, 96_000] as const;
/** `Z` toggles between fitting the passage and this many ms per device pixel. */
const fineMsPerDevicePx = 0.5;
const markLoopMs = 500;
/** Keys whose action a held key must not repeat. */
const singleShotKeys = new Set([
  " ",
  "enter",
  "escape",
  "b",
  "n",
  "c",
  "k",
  "x",
  "l",
  "i",
  "o",
  "f",
  "z",
  "p",
  "0",
  "delete",
  "backspace",
  "home",
  "end",
]);
/** Milliseconds the nudge buttons move the selected marks. */
const nudgeStepsMs = [-15, -5, -2, 2, 5, 15] as const;
const passagesPane: PaneSpec = {
  id: "timing-passages",
  label: "Passages",
  defaultSize: 232,
  min: 168,
  max: 420,
};
const detailsPane: PaneSpec = {
  id: "timing-inspector",
  label: "Marks and settings",
  defaultSize: 320,
  min: 268,
  max: 520,
};

interface TimingPreferences {
  volume: number;
  playheadOffsetMs: number;
  /** Context rate the offset was last set at; another rate needs a fresh check. */
  offsetRate: number | null;
  prerollMs: number;
  /** The output device rate last chosen in this browser, and when (null: before that was kept). */
  deviceRateHz: number | null;
  deviceRateAt: string | null;
  /** The setup line last typed in this browser, and when. */
  setup: string;
  setupAt: string | null;
  /** A click at each of the listener's own beat marks while playing. */
  markClicks: boolean;
  /** The click's peak as a fraction of full scale, before the volume. */
  clickVolume: number;
  passagesHidden: boolean;
}

/** One passage's working marks; kept in memory across passage switches until the page closes. */
interface Draft {
  state: MarksState;
  saved: Mark[];
  saveId: string | null;
  /** Some playback of this passage in this page ran with clicks on the listener's beats. */
  clicksHeard: boolean;
  /** The passage note as typed, and as last saved (trimmed; "" for none). */
  note: string;
  savedNote: string;
  /** When the note's text last changed, and whether every change came before the reveal. */
  noteEdited: string | null;
  noteBlind: boolean;
}

const preferences = ref<TimingPreferences>({
  volume: 0.5,
  playheadOffsetMs: 0,
  offsetRate: null,
  prerollMs: minimumPrerollMs,
  deviceRateHz: null,
  deviceRateAt: null,
  setup: "",
  setupAt: null,
  markClicks: false,
  clickVolume: 0.6,
  passagesHidden: false,
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
/** A passage asked for by key while another was loading; visited once that load finishes. */
let queuedPassage: number | undefined;

// Playback
const audioState = ref<"none" | "loading" | "ready">("none");
const audioBuffer = shallowRef<AudioBuffer>();
/**
 * Where the playhead is. Stopped, it is exact; while playing it is refreshed for the HUD at most
 * every `readoutIntervalMs`, and the stage draws the playhead from `motion` instead.
 */
const playheadMs = ref(0);
/** How the playhead moves while playing, for the compositor; undefined when it stands still. */
const motion = shallowRef<PlayheadMotion>();
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
/** The context opened at another rate than the previous one; cleared by reopening the audio. */
const rateChanged = ref(false);
/** The device rate in force changed after the context opened; cleared by a new context. */
const reopenNeeded = ref(false);

// Playback setup: carried from the last save, the device rate detected; nothing blocks a save.
/** The latest setup line and device rate saved in the session's folder, as given at open. */
const lastSetup = shallowRef<LastSetup>({ setup: null, device_rate: null });
/** The setup line and where it came from; `typed` once edited after the session opened. */
const setupLine = ref<SetupLine>({ text: "", source: "none", from: null });
/** A device rate chosen since the session opened, or null to use the detected or carried one. */
const rateChosen = ref<number | null>(null);
/** The latest probe of the output device's rate; probes run only while stopped. */
const detection = shallowRef<Detection | null>(null);

// Stage
const workspaceFrame = ref<InstanceType<typeof WorkspaceFrame>>();
const stage = ref<InstanceType<typeof TimingStage>>();
const stageWidth = ref(0);
const devicePixelRatio = ref(1);
const view = ref<TimeView>({ startMs: 0, msPerPx: 10 });
const follow = ref(true);
let fitPending = true;

let engine: TimingAudioEngine | undefined;
let loadedHandle = "";
/** The transport's next run while playing (a timer, never an animation-frame loop). */
let transportTimer: ReturnType<typeof setTimeout> | undefined;
/** Page time of the last HUD readout while playing. */
let readoutAtMs = Number.NEGATIVE_INFINITY;
/** Page time at which the stage was last handed a motion (and started its loop piece). */
let motionPlacedAtMs = Number.NEGATIVE_INFINITY;
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
const sampleRate = computed(() => passage.value?.audio.sample_rate ?? 44_100);
const outputRate = computed(() =>
  deviceRate(rateChosen.value, detection.value, lastSetup.value, {
    value: preferences.value.deviceRateHz,
    at: preferences.value.deviceRateAt,
  }),
);
/** The setup line as the status bar and the Save section describe it. */
const setupText = computed({
  get: () => setupLine.value.text,
  set: (text: string) => {
    setupLine.value = { text, source: "typed", from: null };
    setPreference("setup", text);
    setPreference("setupAt", new Date().toISOString());
  },
});
const setupOrigin = computed(() => {
  const line = setupLine.value;
  if (!line.text.trim()) return "Not stated; the save will record that";
  if (line.source === "typed") return "Typed now";
  if (line.source === "browser") return "Remembered by this browser";
  if (line.from) return `From the last save, ${savedAt(line.from.time)} · ${line.from.session_id}`;
  return "From the last save";
});
const setupBrief = computed(() => {
  const line = setupLine.value;
  if (!line.text.trim()) return "not stated";
  const origin = { typed: "typed", "last-save": "last save", browser: "this browser", none: "" };
  return `${line.text.trim()} · ${origin[line.source]}`;
});
/** The device rate select's first entry: what applies when no rate is chosen. */
const automaticRate = computed(() => {
  const hz = (value: number) => `${value.toLocaleString()} Hz`;
  if (detection.value) return `Detected: ${hz(detection.value.hz)}`;
  const carried = deviceRate(null, null, lastSetup.value, {
    value: preferences.value.deviceRateHz,
    at: preferences.value.deviceRateAt,
  });
  if (carried.hz === null) return "Not known";
  return `${carried.source === "last-save" ? "Last save" : "This browser"}: ${hz(carried.hz)}`;
});
const draft = computed(() => drafts.value.get(passage.value?.id ?? ""));
const marks = computed(() => draft.value?.state.marks ?? []);
const selected = computed(() => (draft.value ? selectedMark(draft.value.state) : undefined));
const selection = computed(() => (draft.value ? selectedMarks(draft.value.state) : []));
const selectedIds = computed(() => new Set(draft.value?.state.selectedIds ?? []));
const beatTimes = computed(() =>
  marks.value.filter((mark) => mark.kind === "beat").map((mark) => mark.time_ms),
);
const dirty = computed(() => (draft.value ? isDirty(draft.value) : false));
const unsavedPassages = computed(() => [...drafts.value.values()].filter(isDirty).length);

// Notes: optional text about one passage (one listening) or the whole session; no key opens one.
/** The session note as typed; saved to its own file, never with a passage's marks. */
const sessionNote = ref("");
const sessionNoteSaved = shallowRef<SessionNote | null>(null);
/** When the session note last changed, and the passages revealed by then. */
let sessionNoteEdited: string | null = null;
let sessionNoteRevealed: string[] = [];
const savingSessionNote = ref(false);
const sessionNoteDirty = computed(
  () => sessionNote.value.trim() !== (sessionNoteSaved.value?.text ?? ""),
);
const passageNote = computed({
  get: () => draft.value?.note ?? "",
  set: (text: string) => {
    const row = passage.value;
    const current = draft.value;
    if (!row || !current) return;
    drafts.value.set(row.id, {
      ...current,
      note: text,
      noteEdited: new Date().toISOString(),
      noteBlind: current.noteBlind && !revealed.value,
    });
    triggerRef(drafts);
  },
});
const sessionNoteText = computed({
  get: () => sessionNote.value,
  set: (text: string) => {
    sessionNote.value = text;
    sessionNoteEdited = new Date().toISOString();
    const revealedNow = opened.value?.passages.filter((row) => row.revealed).map((row) => row.id);
    sessionNoteRevealed = [...new Set([...sessionNoteRevealed, ...(revealedNow ?? [])])];
  },
});
const passageNoteState = computed(() => {
  const current = draft.value;
  if (!current) return "";
  if (current.note.trim() !== current.savedNote) return "Unsaved: saved with the marks";
  if (!current.savedNote) return "";
  return current.noteBlind ? "Saved with the marks" : "Saved with the marks · written after the reveal";
});
const sessionNoteState = computed(() => {
  if (savingSessionNote.value) return "Saving";
  if (sessionNoteDirty.value) return "Unsaved";
  const saved = sessionNoteSaved.value;
  if (!saved?.text) return "";
  return `Saved ${savedAt(saved.time)}`;
});
/** What would be lost by leaving: passages with unsaved marks or notes, and the session note. */
const unsavedSummary = computed(() => {
  const parts = [
    ...(unsavedPassages.value
      ? [`${unsavedPassages.value} passage(s) have unsaved marks or notes`]
      : []),
    ...(sessionNoteDirty.value ? ["the session note is unsaved"] : []),
  ];
  const text = parts.join(", and ");
  return text ? `${text[0]?.toUpperCase()}${text.slice(1)}.` : "";
});
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
const notesFile = computed(() => opened.value?.notes_path.split(/[\\/]/).at(-1));
/** The view bar's identity in full, for when a narrow stage truncates it. */
const passageSummary = computed(() => {
  const row = passage.value;
  if (!row || !opened.value) return "";
  return [
    `Passage ${String(passageIndex.value + 1).padStart(2, "0")} of ${opened.value.passages.length}`,
    `${formatSourceTime(row.start_ms)}–${formatSourceTime(row.end_ms)}`,
    ...row.flags,
    row.hint,
  ]
    .filter(Boolean)
    .join(" · ");
});
const conversion = computed(() => {
  const source = passage.value?.audio.sample_rate;
  const device = outputRate.value.hz;
  if (!source || !device) return "Device rate not known";
  const detected = outputRate.value.source === "detected" ? " (detected)" : "";
  return device === source
    ? `No rate conversion${detected}`
    : `Device converts ${source.toLocaleString()} → ${device.toLocaleString()} Hz${detected}`;
});
/** The output-rate condition to fix before listening, shown in the stage HUD. */
const rateWarning = computed(() => {
  const source = passage.value?.audio.sample_rate;
  if (!source) return "";
  const hz = (value: number) => `${value.toLocaleString()} Hz`;
  const device = outputRate.value.hz;
  if (!device)
    return `Output device rate not known. This recording is ${hz(source)}; set the output device to it in Audio MIDI Setup.`;
  if (rateConflict(rateChosen.value, detection.value) && detection.value)
    return `The browser reports the output device at ${hz(detection.value.hz)}; ${hz(device)} is chosen.`;
  if (device !== source) {
    const choose = outputRate.value.source === "typed" ? ", choose it under Output device rate" : "";
    return `The output device is at ${hz(device)} and this recording at ${hz(source)}, so the system resamples. Set the output device to ${hz(source)} in Audio MIDI Setup${choose}, then Reopen audio.`;
  }
  if (reopenNeeded.value) return "The output device rate changed. Reopen audio before listening.";
  if (rateChanged.value)
    return `The recording rate changed to ${hz(source)}. Check that the output device is at ${hz(source)}, then Reopen audio.`;
  return "";
});
const offsetNeedsCheck = computed(
  () =>
    deviceChanged.value ||
    (contextRate.value !== undefined &&
      preferences.value.offsetRate !== null &&
      preferences.value.offsetRate !== contextRate.value),
);
/** Why the playhead offset needs a fresh check, on the stage until the offset is set again. */
const offsetNotice = computed(() => {
  if (!offsetNeedsCheck.value) return "";
  if (deviceChanged.value)
    return "The output device changed: reopen the audio, then check the playhead offset.";
  const hz = (value: number | null | undefined) => `${value?.toLocaleString()} Hz`;
  return `The playhead offset was set with the audio at ${hz(preferences.value.offsetRate)}, and it now runs at ${hz(contextRate.value)}: check the offset.`;
});

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("pointerdown", notePress, true);
  window.addEventListener("click", releasePressed);
  window.addEventListener("change", releasePressed);
  window.addEventListener("beforeunload", guardUnload);
  navigator.mediaDevices?.addEventListener?.("devicechange", markDeviceChanged);
  if (new URLSearchParams(window.location.search).get("session")) void open();
});
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("pointerdown", notePress, true);
  window.removeEventListener("click", releasePressed);
  window.removeEventListener("change", releasePressed);
  window.removeEventListener("beforeunload", guardUnload);
  navigator.mediaDevices?.removeEventListener?.("devicechange", markDeviceChanged);
  clearTimeout(transportTimer);
  void engine?.close();
  engine = undefined;
});

// The gain is per passage, and consecutive passages can share a loaded recording.
watch(loudnessAppliedDb, (db) => engine?.setLoudnessDb(db));
watch([beatTimes, () => preferences.value.markClicks], syncClicks);

/** Only the listener's own beats click; proposals are never heard. */
function syncClicks() {
  engine?.setClicks(preferences.value.markClicks ? beatTimes.value : null);
}

function isDirty(entry: Draft): boolean {
  return differsFrom(entry.state, entry.saved) || entry.note.trim() !== entry.savedNote;
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

/** A save's time as the Save section shows it, such as "26 Oct, 08:37". */
function savedAt(time: string): string {
  return new Date(time).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Reads the output device's rate from a short-lived default context, only while nothing plays or
 * waits to start; while playing, the last probe stands and saves carry its time.
 */
function probeOutputRate() {
  if (playing.value || engine?.starting) return;
  const found = probeDeviceRate();
  if (found) detection.value = found;
}

function markDeviceChanged() {
  deviceChanged.value = true;
  probeOutputRate();
}

function guardUnload(event: BeforeUnloadEvent) {
  if (!unsavedSummary.value) return;
  event.preventDefault();
  event.returnValue = "";
}

function changeMode(mode: WorkspaceMode) {
  if (unsavedSummary.value && !window.confirm(`${unsavedSummary.value} Leave timing mode?`)) return;
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
    // The session note typed for this session stays, unsaved, like its passages' drafts.
    if (owner !== draftsOwner || !sessionNoteDirty.value) loadSessionNote(result.session_note);
    if (owner !== draftsOwner) drafts.value = new Map();
    draftsOwner = owner;
    openedPath = sessionPath.value;
    lastSetup.value = result.last_setup;
    setupLine.value = initialSetup(result.last_setup, {
      value: preferences.value.setup,
      at: preferences.value.setupAt,
    });
    rateChosen.value = null;
    probeOutputRate();
    opened.value = result;
    notice.value = result.marks_warning ?? "";
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

/** The proposal keys and colours a listener saw. */
function legend(view: BlindPassage | undefined): string {
  return JSON.stringify(view?.proposals.map((p) => [p.key, p.colour_index]));
}

/**
 * Whether passage `index` is on the stage with its view loaded, so a response that arrives late
 * may update what the stage shows. The listener can move on while a request is in flight.
 */
function showing(index: number): boolean {
  return index === passageIndex.value && blind.value !== undefined;
}

/**
 * Reconnects and reloads passage `index`'s proposals. They replace the stage's only while that
 * passage is still shown, keeping its marks, audio and view.
 */
async function reconnectPassage(index: number): Promise<BlindPassage> {
  await reconnect();
  const result = await passageView(index);
  if (!disposed && showing(index)) {
    // Names are present only if the marks file already records this passage's reveal.
    names.value = result.names;
    blind.value = result;
  }
  return result;
}

/** Choosing the current passage again reopens its audio in a new context (after a device change). */
async function select(index: number) {
  if (!opened.value?.passages[index]) return;
  stop();
  if (index === passageIndex.value && engine) {
    rateChanged.value = false;
    await closeAudio();
    probeOutputRate();
  }
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
      const note = result.saved?.note;
      drafts.value.set(row.id, {
        state: marksState(saved),
        saved,
        saveId: result.saved?.save_id ?? null,
        clicksHeard: false,
        note: note?.text ?? "",
        savedNote: note?.text ?? "",
        noteEdited: note?.edited ?? null,
        noteBlind: note?.blind ?? true,
      });
      triggerRef(drafts);
    }
    visibility.value = Object.fromEntries(result.proposals.map((p) => [p.key, true]));
    hiddenByP.value = undefined;
    names.value = result.names;
    loopRegion.value = { startMs: row.start_ms, endMs: row.end_ms };
    playheadMs.value = row.start_ms;
    const buffer = audioBuffer.value;
    silenceMs.value = buffer
      ? nearSilence(
          Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
          buffer.sampleRate,
          row.start_ms,
          row.end_ms,
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
  // A timer, so that an open() waiting on this load has finished too.
  setTimeout(visitQueuedPassage);
}

function visitQueuedPassage() {
  const queued = queuedPassage;
  queuedPassage = undefined;
  if (queued === undefined || disposed || busy.value || !blind.value) return;
  if (queued !== passageIndex.value) void select(queued);
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
    const previousRate = contextRate.value;
    engine = new TimingAudioEngine(audio.sample_rate);
    if (previousRate !== undefined && previousRate !== engine.sampleRate) rateChanged.value = true;
    reopenNeeded.value = false;
    // The end is the frame really played, up to half a sample past the end asked for.
    engine.onEnded = (positionMs) => {
      clearTimeout(transportTimer);
      playing.value = false;
      motion.value = undefined;
      playheadMs.value = clampToBounds(positionMs);
    };
    contextRate.value = engine.sampleRate;
  }
  const bytes = await (
    await timingRequest("audio", { session_id: opened.value?.session_id, handle: audio.handle })
  ).arrayBuffer();
  if (disposed || !engine) return;
  audioBuffer.value = engine.load(deinterleave(bytes, audio.channels, audio.frames), audio.frames);
  engine.setVolume(preferences.value.volume);
  engine.setClickVolume(preferences.value.clickVolume);
  engine.setLoudnessDb(loudnessAppliedDb.value);
  syncClicks();
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
    unsavedSummary.value &&
    !window.confirm(
      `${unsavedSummary.value} They stay in this page only for reopening this session. Close it?`,
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
  return selected.value?.time_ms ?? shownPlayheadMs();
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
    const started = await engine.play({
      fromMs: prerollStart(fromMs, preferences.value.prerollMs),
      endMs,
      rate: rate.value,
      loop: loop ? { ...loopRegion.value } : null,
    });
    if (!started) return;
    latencies.value = engine.latencies();
    playing.value = true;
    if (preferences.value.markClicks) noteClicksHeard();
    readoutAtMs = Number.NEGATIVE_INFINITY;
    clearTimeout(transportTimer);
    transportStep();
  } catch (cause) {
    report(cause);
  }
}

/**
 * The transport's bookkeeping while playing, on a timer: feeds the clock model, hands the stage a
 * new motion only when the playhead would move by more than the resync tolerance or a loop's
 * compositor piece has run `loopReanchorPasses` passes, follows the playhead and refreshes the
 * HUD readout every `readoutIntervalMs`. It runs every `transportIntervalMs`, and exactly when the
 * playhead will leave the view or wrap, so a follow jump is on time. Nothing here runs per frame:
 * the compositor moves the playhead, and an animation-frame loop would make it wait for the main
 * thread.
 */
function transportStep() {
  transportTimer = undefined;
  if (!engine?.playing) return;
  const nowMs = performance.now();
  const offsetMs = preferences.value.playheadOffsetMs;
  engine.sampleClock();
  const next = engine.motion(offsetMs);
  if (!next) motion.value = undefined;
  else if (
    needsResync(motion.value, next, nowMs) ||
    loopReanchorDue(motion.value, motionPlacedAtMs, nowMs)
  ) {
    motion.value = next;
    motionPlacedAtMs = nowMs;
  }
  const current = motion.value;
  const shownMs = current ? motionAt(current, nowMs) : engine.shownAt(nowMs, offsetMs);
  if (shownMs !== undefined) {
    if (follow.value && stageWidth.value) {
      const jump = followView(view.value, shownMs, stageWidth.value, preferences.value.prerollMs);
      if (jump) setView(jump);
    }
    if (!current || nowMs - readoutAtMs >= readoutIntervalMs) {
      playheadMs.value = shownMs;
      readoutAtMs = nowMs;
    }
  }
  const followAt =
    current && follow.value && stageWidth.value
      ? nextFollowCheckMs(current, view.value, stageWidth.value, nowMs) + 0.5
      : Number.POSITIVE_INFINITY;
  transportTimer = setTimeout(transportStep, transportDelayMs(nowMs, followAt));
}

/** The playhead's position now: exact while playing, between the HUD's readouts. */
function shownPlayheadMs(): number {
  if (!playing.value || !engine) return playheadMs.value;
  return engine.shownAt(performance.now(), preferences.value.playheadOffsetMs) ?? playheadMs.value;
}

/**
 * Space: pause keeps the heard position; play resumes there (inside the loop when looping). A
 * press while a start waits for the audio to resume cancels it.
 */
function togglePlayback() {
  if (playing.value || engine?.starting) {
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
  clearTimeout(transportTimer);
  const shown = engine?.stop(preferences.value.playheadOffsetMs);
  if (playing.value && shown !== undefined) playheadMs.value = clampToBounds(shown);
  motion.value = undefined;
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

/** The playhead before a stopped locate drag moved it, so Esc can put it back. */
let locateFrom: number | undefined;

/**
 * The middle button or Option+click on the stage. Stopped, the playhead follows the drag; playing,
 * the stage shows the target and nothing changes until the release. Esc puts a stopped playhead
 * back.
 */
function onLocate(timeMs: number, phase: LocatePhase) {
  const moving = playing.value || Boolean(engine?.starting);
  if (phase === "cancel") {
    if (locateFrom !== undefined && !moving) playheadMs.value = locateFrom;
    locateFrom = undefined;
  } else if (phase === "move") {
    if (moving) return;
    locateFrom ??= playheadMs.value;
    playheadMs.value = clampToBounds(timeMs);
  } else {
    locateFrom = undefined;
    locate(timeMs);
  }
}

/**
 * Puts the playhead at `timeMs`, inside the shown bounds. A play, or a start still waiting for the
 * audio, restarts there once through `start`, with the pre-roll; looping outside the loop region,
 * it restarts at the region's start, as Space does. The view does not move.
 */
function locate(timeMs: number) {
  const wasPlaying = playing.value || Boolean(engine?.starting);
  stop();
  playheadMs.value = clampToBounds(timeMs);
  if (wasPlaying) togglePlayback();
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
  setLoopRegion({ ...loopRegion.value, [edge]: shownPlayheadMs() });
}

/** X loops from 500 ms before the first selected mark to 500 ms after the last. */
function loopAroundSelected() {
  const first = selection.value[0];
  const last = selection.value.at(-1);
  if (!first || !last) return;
  stop();
  loopRegion.value = {
    startMs: clampToBounds(first.time_ms - markLoopMs),
    endMs: clampToBounds(last.time_ms + markLoopMs),
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
}

function setMarkClicks(value: boolean) {
  setPreference("markClicks", value);
  if (value && playing.value) noteClicksHeard();
}

function setClickVolume(value: number) {
  setPreference("clickVolume", value);
  engine?.setClickVolume(value);
}

/** Saves record whether the listener heard clicks on this passage, not the toggle at save time. */
function noteClicksHeard() {
  const row = passage.value;
  const current = draft.value;
  if (!row || !current || current.clicksHeard) return;
  drafts.value.set(row.id, { ...current, clicksHeard: true });
  triggerRef(drafts);
}

function setPlayheadOffset(value: number) {
  if (!Number.isFinite(value)) return;
  setPreference("playheadOffsetMs", Math.round(value * 1000) / 1000);
  setPreference("offsetRate", contextRate.value ?? null);
  deviceChanged.value = false;
}

/** A rate chosen in the Save section, or null to go back to the detected or carried rate. */
function setDeviceRate(value: number | null) {
  const before = outputRate.value.hz;
  rateChosen.value = value;
  if (value !== null) {
    setPreference("deviceRateHz", value);
    setPreference("deviceRateAt", new Date().toISOString());
  }
  rateChanged.value = false;
  if (engine && outputRate.value.hz !== before) reopenNeeded.value = true;
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

/**
 * B and N, and the Beat and Unbeat buttons. While the audio plays, the mark goes at the source
 * time heard when the key or button went down (the output clock at the event's time stamp, without
 * the playhead offset, which corrects only the drawn bar), so it is not up to a frame late. A tap
 * before the sound has reached the output is ignored rather than put at the start. Stopped, the
 * mark goes at the playhead.
 */
function placeAtPlayhead(kind: MarkKind, eventTimeMs = performance.now()) {
  if (playing.value || engine?.starting) {
    const heard = engine?.heardAt(eventTimeMs);
    if (heard !== undefined) place(kind, heard, "key-playing");
    return;
  }
  place(kind, playheadMs.value, "key-playhead");
}

/**
 * The mark buttons act when pressed, timed by the press, because `click` comes on release; a
 * click from the keyboard (detail 0) still places.
 */
function onMarkButton(kind: MarkKind, event: MouseEvent) {
  if (event.type === "pointerdown") {
    if (event.button === 0) placeAtPlayhead(kind, event.timeStamp);
  } else if (event.detail === 0) placeAtPlayhead(kind, event.timeStamp);
}

function selectById(id: string | null) {
  updateMarks((state) => selectMark(state, id));
}

function selectFromStage(ids: string[], mode: SelectMode) {
  updateMarks((state) => selectMarks(state, ids, mode));
}

/** A row in the mark list: a click selects the mark and seeks to it, Cmd+click toggles it. */
function selectFromList(mark: Mark, event: MouseEvent) {
  if (event.metaKey) {
    updateMarks((state) => selectMarks(state, [mark.id], "toggle"));
    return;
  }
  selectById(mark.id);
  seek(mark.time_ms);
  bringIntoView(mark.time_ms);
}

function selectAdjacent(direction: 1 | -1) {
  const state = draft.value?.state;
  if (!state) return;
  const mark = adjacentMark(state, direction, shownPlayheadMs());
  if (!mark) return;
  selectById(mark.id);
  if (!playing.value) playheadMs.value = mark.time_ms;
  bringIntoView(mark.time_ms);
}

/** Arrow keys nudge the selected marks, or step the playhead without any. */
function nudge(deltaMs: number) {
  if (!selection.value.length) {
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
    mark_clicks: Boolean(draft.value?.clicksHeard),
    click_volume: preferences.value.clickVolume,
    device_rate_hz: outputRate.value.hz,
    device_rate_source: outputRate.value.source,
    device_rate_from: outputRate.value.from,
    device_rate_detected_hz: detection.value?.hz ?? null,
    device_rate_detected_at: detection.value?.at ?? null,
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

/** Focuses a field of the details pane, showing the pane first if it is hidden. */
function focusDetailsField(id: string) {
  const focus = () => document.getElementById(id)?.focus();
  if (workspaceFrame.value?.showPane("right")) void nextTick(focus);
  else focus();
}

async function save() {
  const row = passage.value;
  const current = draft.value;
  if (!row || !current || saving.value || !blind.value) return;
  probeOutputRate();
  // The passage, marks, legend and playback are taken as they are now, since the listener can move
  // to another passage or change the playback before a retry. Only the session id is read again,
  // because reconnecting replaces it.
  const index = passageIndex.value;
  const shown = legend(blind.value);
  const snapshot = current.state.marks;
  const noteText = current.note.trim();
  const note: PassageNote | null = noteText
    ? { text: current.note, edited: current.noteEdited, blind: current.noteBlind }
    : null;
  const setup = recordedSetup(setupLine.value);
  const body = {
    passage_index: index,
    marks: snapshot,
    setup: setup.text,
    setup_source: setup.source,
    setup_from: setup.from,
    note,
    playback: playbackSetup(),
    page: pageProvenance(),
    visible_keys: stageProposals.value.filter((p) => p.visible).map((p) => p.key),
  };
  saving.value = true;
  error.value = "";
  const request = () =>
    timingJson<SaveResponse>("save", { session_id: opened.value?.session_id, ...body });
  try {
    let response: SaveResponse;
    try {
      response = await request();
    } catch (cause) {
      if (!isStale(cause)) throw cause;
      // The save records the legend the listener saw, so it is retried only if that is unchanged.
      if (legend(await reconnectPassage(index)) !== shown) {
        error.value = `The service restarted and gave passage ${String(index + 1).padStart(2, "0")} new proposal colours. Check them, then save again.`;
        return;
      }
      response = await request();
    }
    if (disposed) return;
    const latest = drafts.value.get(row.id);
    if (latest)
      drafts.value.set(row.id, {
        ...latest,
        saved: snapshot,
        saveId: response.save_id,
        savedNote: noteText,
      });
    triggerRef(drafts);
    const savedRow = opened.value?.passages.find((entry) => entry.id === row.id);
    if (savedRow) savedRow.saved = true;
    // One save keeps everything typed: the session note goes to its own file.
    if (sessionNoteDirty.value) void saveSessionNote();
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

function loadSessionNote(note: SessionNote | null) {
  sessionNoteSaved.value = note;
  sessionNote.value = note?.text ?? "";
  sessionNoteEdited = note?.edited ?? null;
  sessionNoteRevealed = note?.revealed_passages ?? [];
}

/** Saves the session note on its own; Save marks also calls it when the note changed. */
async function saveSessionNote() {
  if (!opened.value || savingSessionNote.value || !sessionNoteDirty.value) return;
  const body = {
    text: sessionNote.value,
    edited: sessionNoteEdited,
    revealed_passages: sessionNoteRevealed,
  };
  savingSessionNote.value = true;
  error.value = "";
  const request = () =>
    timingJson<SessionNoteResponse>("session-note", {
      session_id: opened.value?.session_id,
      ...body,
    });
  try {
    let response: SessionNoteResponse;
    try {
      response = await request();
    } catch (cause) {
      if (!isStale(cause)) throw cause;
      await reconnect();
      response = await request();
    }
    if (disposed) return;
    sessionNoteSaved.value = {
      id: response.note_id,
      time: response.time,
      text: body.text.trim(),
      edited: body.edited,
      revealed_passages: body.revealed_passages,
    };
  } catch (cause) {
    if (cause instanceof TypeError)
      error.value =
        "The local timing service is not answering. Start it again, then save; the note stays in this page.";
    else report(cause);
  } finally {
    savingSessionNote.value = false;
  }
}

/** Esc in a note or the setup line gives the keys back to marking, unless an IME is composing. */
function leaveField(event: KeyboardEvent) {
  if (event.isComposing) return;
  (event.target as HTMLElement | null)?.blur();
}

async function revealNames() {
  const row = passage.value;
  const current = draft.value;
  if (!row || !current?.saveId || !canReveal.value) return;
  const index = passageIndex.value;
  error.value = "";
  try {
    const result = await timingJson<{ names: RevealedName[] }>("reveal", {
      session_id: opened.value?.session_id,
      passage_index: index,
      save_id: current.saveId,
    });
    if (disposed) return;
    // The service has recorded the reveal, but the names go beside this passage's proposals only.
    const revealedRow = opened.value?.passages[index];
    if (revealedRow) revealedRow.revealed = true;
    if (showing(index)) names.value = result.names;
  } catch (cause) {
    if (!isStale(cause)) {
      report(cause);
      return;
    }
    // Reconnecting does not reveal; the listener presses Reveal again on the reopened session.
    try {
      await reconnectPassage(index);
      if (showing(index))
        error.value = "Reconnected to the restarted service. Press Reveal names again.";
    } catch (failure) {
      report(failure);
    }
  }
}

// Keyboard
/** The control the pointer last pressed; it gives the keyboard back once the mouse has used it. */
let pressedControl: Element | null = null;

function notePress(event: Event) {
  pressedControl =
    event.target instanceof Element
      ? event.target.closest(
          "button, summary, select, input[type='range'], input[type='checkbox']",
        )
      : null;
}

/**
 * A button, disclosure, slider, checkbox or select used with the mouse would keep focus and take
 * Space, Enter, the arrows or every shortcut; it is blurred once used so the shortcuts work again.
 * A control used from the keyboard keeps focus. A select is released on change only, since a click
 * can arrive while its menu is open. Text and number fields are never released.
 */
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

/** Shift+[ and Shift+] move between passages, by key position so other layouts work too. */
function passageStep(event: KeyboardEvent): number {
  if (!event.shiftKey || event.metaKey || event.ctrlKey) return 0;
  if (event.code === "BracketLeft") return -1;
  return event.code === "BracketRight" ? 1 : 0;
}

function handleKeydown(event: KeyboardEvent) {
  // A key that confirms or edits an IME composition belongs to the field.
  if (event.defaultPrevented || event.altKey || event.isComposing) return;
  if (!blind.value) {
    // While a passage loads, passage keys are kept for when it has loaded.
    const step = passageStep(event);
    const count = opened.value?.passages.length ?? 0;
    if (!step || !busy.value || !count || isTypingTarget(event.target)) return;
    event.preventDefault();
    queuedPassage = Math.min(count - 1, Math.max(0, (queuedPassage ?? passageIndex.value) + step));
    return;
  }
  const key = event.key;
  // Save works from any field, including the setup line, instead of the browser's page save.
  if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === "s") {
    event.preventDefault();
    void save();
    return;
  }
  if (isTypingTarget(event.target)) return;
  // A held key repeats only where that means something: nudges, zoom and visiting marks.
  if (event.repeat && (singleShotKeys.has(key.toLowerCase()) || /^[1-9]$/.test(key))) {
    event.preventDefault();
    return;
  }
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
  const step = passageStep(event);
  if (step) {
    event.preventDefault();
    const next = passageIndex.value + step;
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
    b: () => placeAtPlayhead("beat", event.timeStamp),
    n: () => placeAtPlayhead("unbeat", event.timeStamp),
    c: () => setMarkClicks(!preferences.value.markClicks),
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
      <span class="brand-glyph" aria-hidden="true" title="Beatmap Lens"></span>
      <span class="sr-only">Beatmap Lens</span>
      <WorkspaceModeSwitch
        model-value="timing"
        :disabled="busy"
        @update:model-value="changeMode"
      />
      <div class="annotation-chart-context">
        <span>Timing session</span>
        <strong>Not opened</strong>
      </div>
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
          and the session note to &lt;session&gt;.timing.notes.jsonl, beside the session file.
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

      <WorkspaceFrame
        ref="workspaceFrame"
        class="timing-workspace"
        :class="{ 'is-passages-hidden': preferences.passagesHidden }"
        layout-key="timing"
        mode="timing"
        :mode-disabled="busy || saving"
        :left="passagesPane"
        :right="detailsPane"
        :left-collapsed="preferences.passagesHidden"
        @update:left-collapsed="setPreference('passagesHidden', $event)"
        @change-mode="changeMode"
      >
        <template #toolbar>
          <div class="toolbar-identity toolbar-optional timing-identity" :title="opened.marks_path">
            <strong>{{ opened.id }}</strong>
            <span>{{ marksFile }}</span>
          </div>
          <span class="toolbar-divider" aria-hidden="true"></span>
          <fieldset class="toolbar-group timing-transport" aria-label="Playback controls">
            <button
              class="tool-button tool-button--play"
              type="button"
              :disabled="audioState !== 'ready'"
              :aria-pressed="playing"
              aria-keyshortcuts="Space"
              title="Play or pause (Space); Shift+Space plays the loop region once"
              @click="togglePlayback"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path v-if="playing" d="M5.5 3.5v9M10.5 3.5v9" />
                <path v-else class="tool-icon-fill" d="M5 3.3v9.4L12.6 8z" />
              </svg>
              {{ playing ? "Pause" : "Play" }}
            </button>
            <button
              class="tool-button"
              type="button"
              :disabled="audioState !== 'ready'"
              aria-keyshortcuts="Escape"
              title="Stop at once (Esc)"
              @click="stop"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect class="tool-icon-fill" x="4" y="4" width="8" height="8" rx="1" />
              </svg>
              Stop
            </button>
            <button
              class="tool-button"
              type="button"
              :disabled="audioState !== 'ready'"
              :aria-pressed="looping"
              aria-keyshortcuts="L"
              title="Loop the loop region (L)"
              @click="toggleLoop"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 8a4 4 0 0 1 4-4h5M10.5 2.2 12.5 4l-2 1.8M13 8a4 4 0 0 1-4 4H4M5.5 13.8 3.5 12l2-1.8" />
              </svg>
              Loop
            </button>
            <button
              class="tool-button toolbar-optional"
              type="button"
              :disabled="audioState !== 'ready'"
              aria-keyshortcuts="B"
              title="Place a beat at the playhead, or where it is heard while playing (B)"
              @pointerdown="onMarkButton('beat', $event)"
              @click="onMarkButton('beat', $event)"
            >
              Beat <kbd>B</kbd>
            </button>
          </fieldset>
          <div class="time-counter timing-counter" title="Playhead time and sample">
            <span class="sr-only">Playhead</span>
            <span class="time-counter-main">{{ formatSourceTime(playheadMs, devicePxMs < 1 ? 1 : 0) }}</span>
            <span class="time-counter-sub">n {{ nearestSample(playheadMs, sampleRate) }}</span>
          </div>
        </template>

        <template #toolbar-end>
          <span class="health-status timing-blind" :class="`health-status--${revealed ? 'ready' : 'idle'}`">
            <span class="health-dot" aria-hidden="true"></span>
            {{ revealed ? "Revealed" : "Blind" }}
          </span>
          <span class="health-status timing-status" :class="`health-status--${status.tone}`" aria-live="polite">
            <span class="health-dot" aria-hidden="true"></span>
            {{ status.text }}
          </span>
          <button
            class="tool-button tool-button--primary timing-save"
            type="button"
            :disabled="saving || !blind"
            aria-keyshortcuts="Meta+S Control+S Enter"
            title="Save this passage's marks (Cmd/Ctrl+S or Enter)"
            @click="save"
          >
            {{ saving ? "Saving" : "Save marks" }}
          </button>
        </template>

        <template #left>
          <header class="pane-header">
            <h2 id="passages-heading">Passages</h2>
            <span class="pane-count">
              {{ opened.passages.filter((row) => row.saved).length }} / {{ opened.passages.length }} saved
            </span>
          </header>
          <nav class="task-list timing-passage-list" aria-labelledby="passages-heading">
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
                :class="{
                  'task-status-mark--complete': row.saved,
                  'task-status-mark--draft': drafts.get(row.id) && isDirty(drafts.get(row.id) as Draft),
                }"
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
          <footer class="pane-footer">
            <button class="tool-button" type="button" :disabled="busy" @click="close">
              Open another session
            </button>
          </footer>
        </template>

        <template #main>
          <section class="timing-stage-column" aria-label="Timing stage">
            <header v-if="passage" class="timing-hud">
              <div class="stage-toolbar">
                <div class="stage-identity" :title="passageSummary">
                  <strong>
                    <span class="stage-identity-word">Passage </span
                    >{{ String(passageIndex + 1).padStart(2, "0") }} of {{ opened.passages.length }}
                  </strong>
                  <span class="data">
                    {{ formatSourceTime(passage.start_ms) }}–{{ formatSourceTime(passage.end_ms) }}
                  </span>
                  <span v-for="flag in passage.flags" :key="flag" class="stage-flag">{{ flag }}</span>
                  <span v-if="passage.hint" class="stage-hint" :title="passage.hint">
                    {{ passage.hint }}
                  </span>
                </div>
                <fieldset class="toolbar-group" aria-label="Playback rate">
                  <span class="toolbar-label" aria-hidden="true">Rate</span>
                  <div class="segmented">
                    <button
                      v-for="value in playbackRates"
                      :key="value"
                      type="button"
                      :aria-pressed="rate === value"
                      @click="setRate(value)"
                    >
                      {{ value }}×
                    </button>
                  </div>
                </fieldset>
                <fieldset class="toolbar-group" aria-label="Zoom">
                  <span class="toolbar-label" aria-hidden="true">Zoom</span>
                  <div class="segmented">
                    <button type="button" aria-label="Zoom out" aria-keyshortcuts="-" title="Zoom out (−)" @click="zoom(2)">−</button>
                    <button type="button" aria-label="Zoom in" aria-keyshortcuts="+" title="Zoom in (+)" @click="zoom(0.5)">+</button>
                    <button type="button" aria-keyshortcuts="0" title="Fit the passage (0)" @click="fitPassage">Fit</button>
                    <button type="button" aria-keyshortcuts="Z" title="0.5 ms per pixel, or back to fit (Z)" @click="toggleFineZoom">Fine</button>
                  </div>
                </fieldset>
                <button
                  class="tool-button"
                  type="button"
                  :aria-pressed="follow"
                  aria-keyshortcuts="F"
                  title="Keep the playhead in view while playing (F)"
                  @click="follow = !follow"
                >
                  Follow
                </button>
                <fieldset class="toolbar-group" aria-label="Loop region">
                  <span class="toolbar-label" aria-hidden="true">Loop</span>
                  <div class="segmented">
                    <button type="button" aria-label="Loop in" aria-keyshortcuts="I" title="Loop starts at the playhead (I)" @click="setLoopEdge('startMs')">In</button>
                    <button type="button" aria-label="Loop out" aria-keyshortcuts="O" title="Loop ends at the playhead (O)" @click="setLoopEdge('endMs')">Out</button>
                  </div>
                </fieldset>
              </div>
              <p v-if="rateWarning" class="notice-bar timing-hud-warning" role="status">
                <span class="health-dot" aria-hidden="true"></span>
                {{ rateWarning }}
              </p>
              <p v-if="offsetNotice" class="notice-bar timing-hud-offset" role="status">
                <span class="health-dot" aria-hidden="true"></span>
                <span class="notice-bar-text">{{ offsetNotice }}</span>
                <button
                  v-if="deviceChanged"
                  class="tool-button"
                  type="button"
                  :disabled="busy || saving"
                  title="Open the audio again in a new context, on the current output device"
                  @click="select(passageIndex)"
                >
                  Reopen audio
                </button>
                <button
                  class="tool-button"
                  type="button"
                  title="Show the playhead offset under Output and sync"
                  @click="focusDetailsField('timing-offset')"
                >
                  Check offset
                </button>
              </p>
              <p v-if="silenceMs !== undefined" class="notice-bar timing-hud-silence">
                <span class="health-dot" aria-hidden="true"></span>
                Digital silence at {{ formatSourceTime(silenceMs) }}; an EQ app may soften the next
                onset.
              </p>
              <p v-if="error && blind" class="notice-bar notice-bar--error timing-hud-error" role="alert">
                <span class="health-dot" aria-hidden="true"></span>
                {{ error }}
              </p>
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
              :selected-ids="draft?.state.selectedIds ?? []"
              :playhead-ms="playheadMs"
              :playhead-motion="motion"
              :loop-region="loopRegion"
              :looping="looping"
              @resize="onStageResize"
              @update:view="setView"
              @place="(kind, timeMs) => place(kind, timeMs, 'click')"
              @select="selectFromStage"
              @seek="seek"
              @locate="onLocate"
              @loop-region="setLoopRegion"
            />
            <div v-else-if="error" class="stage-message">
              <p class="inline-message inline-message--error" role="alert">{{ error }}</p>
              <button class="tool-button" type="button" @click="select(passageIndex)">
                Reload passage
              </button>
            </div>
            <div v-else class="stage-empty">
              {{ audioState === "loading" ? "Loading audio" : "Loading passage" }}
            </div>
          </section>
        </template>

        <template #right>
          <div class="timing-details">
            <PanelSection id="timing-marks" class="timing-marks-heading" title="Marks">
              <template #meta>
                <span class="rail-count" :title="selection.length ? 'Selected of all marks' : 'Marks'">
                  {{ selection.length ? `${selection.length} of ${marks.length}` : marks.length }}
                </span>
              </template>
              <fieldset class="timing-mark-actions" aria-label="Mark actions">
                <button
                  type="button"
                  class="tool-button timing-place"
                  aria-keyshortcuts="B"
                  title="Place a beat at the playhead, or where it is heard while playing (B)"
                  @pointerdown="onMarkButton('beat', $event)"
                  @click="onMarkButton('beat', $event)"
                >
                  Beat at playhead <kbd>B</kbd>
                </button>
                <button
                  type="button"
                  class="tool-button timing-place"
                  aria-keyshortcuts="N"
                  title="Place an unbeat at the playhead, or where it is heard while playing (N)"
                  @pointerdown="onMarkButton('unbeat', $event)"
                  @click="onMarkButton('unbeat', $event)"
                >
                  Unbeat at playhead <kbd>N</kbd>
                </button>
                <button
                  type="button"
                  class="tool-button"
                  :disabled="!selection.length"
                  aria-keyshortcuts="K"
                  title="Flip the selected marks between beat and unbeat (K)"
                  @click="updateMarks((state) => flipSelected(state, revealed))"
                >
                  Flip <kbd>K</kbd>
                </button>
                <button
                  type="button"
                  class="tool-button"
                  :disabled="!selection.length"
                  aria-keyshortcuts="Delete"
                  title="Delete the selected marks (Delete)"
                  @click="updateMarks(removeSelected)"
                >
                  Delete
                </button>
                <button
                  type="button"
                  class="tool-button"
                  :disabled="!draft?.state.past.length"
                  aria-keyshortcuts="Meta+Z Control+Z"
                  title="Undo (Cmd/Ctrl+Z)"
                  @click="updateMarks(undo)"
                >
                  Undo
                </button>
                <button
                  type="button"
                  class="tool-button"
                  :disabled="!draft?.state.future.length"
                  aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z"
                  title="Redo (Cmd/Ctrl+Shift+Z)"
                  @click="updateMarks(redo)"
                >
                  Redo
                </button>
              </fieldset>
              <fieldset class="timing-nudge" aria-labelledby="nudge-label">
                <span id="nudge-label" class="toolbar-label">Move selected, ms</span>
                <div class="segmented">
                  <button
                    v-for="step in nudgeStepsMs"
                    :key="step"
                    type="button"
                    :disabled="!selection.length"
                    :title="`Move the selected marks ${Math.abs(step)} ms ${step > 0 ? 'later' : 'earlier'}`"
                    @click="nudge(step)"
                  >
                    {{ step > 0 ? `+${step}` : `−${-step}` }}
                  </button>
                </div>
              </fieldset>
              <ol v-if="marks.length" class="timing-mark-list" aria-label="Marks in time order">
                <li v-for="mark in marks" :key="mark.id">
                  <button
                    type="button"
                    :class="{ 'is-active': selectedIds.has(mark.id) }"
                    :aria-pressed="selectedIds.has(mark.id)"
                    @click="selectFromList(mark, $event)"
                  >
                    <span class="timing-mark-glyph" aria-hidden="true">{{ mark.kind === "beat" ? "▼" : "⊘" }}</span>
                    <span class="timing-mark-time">{{ formatSourceTime(mark.time_ms, 3) }}</span>
                    <span class="timing-mark-sample">
                      n {{ nearestSample(mark.time_ms, sampleRate) }}
                    </span>
                    <span class="timing-mark-kind">{{ mark.kind }}{{ mark.blind ? "" : " · seen" }}</span>
                  </button>
                </li>
              </ol>
              <p v-else class="timing-mark-empty">
                No marks yet. Shift+click the waveform or press B.
              </p>
              <details class="timing-help">
                <summary>Mouse and keys</summary>
                <p>
                  Click or drag on the waveform selects marks; ⌘-click adds or removes one.
                  Shift+click places a beat, right-click an unbeat. ←/→ nudge 1 ms (Shift 0.1 ms),
                  , and . one sample. [ and ] visit marks. Delete removes the selection. Pan with
                  the wheel, by dragging the ruler, or with right- or Ctrl-drag.
                </p>
                <p>
                  The middle button or ⌥-click anywhere on the stage moves the playhead to where it
                  is released; while playing, playback restarts there once. Esc cancels the drag.
                </p>
                <p>
                  While playing, B, N and the Beat buttons mark the moment of the press as heard,
                  without the playhead offset. Taps usually land some tens of ms early; refine them
                  on the waveform.
                </p>
              </details>
            </PanelSection>

            <PanelSection id="timing-notes" title="Notes">
              <template #meta>
                <span v-if="dirty || sessionNoteDirty" class="rail-count timing-warning">unsaved</span>
              </template>
              <label class="field-stack" for="timing-passage-note">
                <span>This passage</span>
                <textarea
                  id="timing-passage-note"
                  v-model="passageNote"
                  rows="3"
                  :maxlength="noteMaxLength"
                  placeholder="Optional: about this listening of the passage"
                  @keydown.esc="leaveField"
                ></textarea>
              </label>
              <p v-if="passageNoteState" class="setup-note timing-note-state">{{ passageNoteState }}</p>
              <label class="field-stack" for="timing-session-note">
                <span>Whole session</span>
                <textarea
                  id="timing-session-note"
                  v-model="sessionNoteText"
                  rows="3"
                  :maxlength="noteMaxLength"
                  placeholder="Optional: about the whole session"
                  @keydown.esc="leaveField"
                ></textarea>
              </label>
              <div class="timing-note-actions">
                <span class="setup-note timing-note-state">{{ sessionNoteState }}</span>
                <button
                  class="tool-button"
                  type="button"
                  :disabled="!sessionNoteDirty || savingSessionNote"
                  title="Save the session note on its own; Save marks saves it too"
                  @click="saveSessionNote"
                >
                  Save session note
                </button>
              </div>
              <p class="setup-note">
                Optional. Keys typed here stay in the note; Esc gives them back to marking.
                Cmd/Ctrl+S saves the marks with both notes. The session note is kept in
                <span class="data">{{ notesFile }}</span>.
              </p>
            </PanelSection>

            <PanelSection id="timing-proposals" :title="revealed ? 'Proposals' : 'Proposals (blind)'">
              <!-- Always given, so the section's slots stay stable while the playhead redraws. -->
              <template #actions>
                <button
                  v-if="stageProposals.length"
                  type="button"
                  class="tool-button"
                  :aria-pressed="Boolean(hiddenByP)"
                  aria-keyshortcuts="P"
                  title="Hide every proposal, or bring back the ones that were on (P)"
                  @click="toggleAllProposals"
                >
                  {{ hiddenByP ? "Show again" : "Hide all" }} <kbd>P</kbd>
                </button>
              </template>
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
              <p v-if="blind?.names_error" class="setup-note timing-warning">
                Names unavailable: {{ blind.names_error }}
              </p>
            </PanelSection>

            <PanelSection id="timing-save" title="Save and reveal">
              <label class="field-stack" for="timing-setup">
                <span>Playback setup</span>
                <input
                  id="timing-setup"
                  v-model="setupText"
                  placeholder="Headphones · FineTune state · volume"
                  autocomplete="off"
                  spellcheck="false"
                  @keydown.esc="leaveField"
                />
              </label>
              <p
                class="setup-note timing-setup-source"
                :class="{ 'timing-warning': !setupLine.text.trim() }"
              >
                {{ setupOrigin }}
              </p>
              <label class="field-stack prop-field" for="timing-device-rate">
                <span>Output device rate</span>
                <select
                  id="timing-device-rate"
                  :value="rateChosen ?? 'automatic'"
                  @change="setDeviceRate(Number(($event.target as HTMLSelectElement).value) || null)"
                >
                  <option value="automatic">{{ automaticRate }}</option>
                  <option v-for="value in deviceRates" :key="value" :value="value">
                    {{ value.toLocaleString() }} Hz
                  </option>
                </select>
              </label>
              <button
                v-if="rateChosen !== null && detection"
                class="tool-button"
                type="button"
                title="Use the rate the browser reports for the output device"
                @click="setDeviceRate(null)"
              >
                Use detected ({{ detection.hz.toLocaleString() }} Hz)
              </button>
              <button
                class="tool-button timing-reveal"
                type="button"
                :disabled="!canReveal"
                title="Show the proposal names; only after this passage's marks are saved"
                @click="revealNames"
              >
                {{ revealed ? "Names revealed" : "Reveal names" }}
              </button>
              <p v-if="notice" class="inline-message" role="status">{{ notice }}</p>
              <p class="setup-note timing-output">
                Marks append to <span>{{ opened.marks_path }}</span>
              </p>
            </PanelSection>

            <PanelSection id="timing-listening" title="Listening">
              <AudioVolumeControl :model-value="preferences.volume" @update:model-value="setVolume" />
              <label class="timing-check">
                <input
                  type="checkbox"
                  :checked="loudnessMatch"
                  @change="setLoudnessMatch(($event.target as HTMLInputElement).checked)"
                />
                <span>Match loudness</span>
                <output class="data">{{ (passage?.loudness_gain_db ?? 0).toFixed(1) }} dB</output>
              </label>
              <p v-if="(passage?.loudness_gain_db ?? 0) > 0" class="setup-note">
                Gains above 0 dB are shown but not applied.
              </p>
              <label class="timing-check">
                <input
                  type="checkbox"
                  :checked="preferences.markClicks"
                  aria-keyshortcuts="C"
                  @change="setMarkClicks(($event.target as HTMLInputElement).checked)"
                />
                <span>Click on my beats</span>
                <kbd>C</kbd>
              </label>
              <AudioVolumeControl
                label="Click volume"
                :disabled="!preferences.markClicks"
                :model-value="preferences.clickVolume"
                @update:model-value="setClickVolume"
              />
              <label class="prop-row" for="timing-preroll">
                <span>Pre-roll, ms (≥ {{ minimumPrerollMs }})</span>
                <DraftNumberInput
                  id="timing-preroll"
                  class="prop-input"
                  :min="minimumPrerollMs"
                  step="10"
                  :model-value="preferences.prerollMs"
                  @update:model-value="setPreroll"
                />
              </label>
            </PanelSection>

            <PanelSection id="timing-sync" title="Output and sync" :reveal="offsetNeedsCheck">
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
                  <label for="timing-offset">
                    <span class="sr-only">Playhead offset in milliseconds</span>
                    <DraftNumberInput
                      id="timing-offset"
                      step="1"
                      :model-value="preferences.playheadOffsetMs"
                      @update:model-value="setPlayheadOffset"
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
                class="tool-button timing-wide"
                type="button"
                :disabled="busy || saving"
                @click="select(passageIndex)"
              >
                Reopen audio after a device change
              </button>
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
            </PanelSection>
          </div>
        </template>

        <template #status>
          <span class="status-item">Zoom <b>{{ zoomLabel }}</b></span>
          <span class="status-item status-optional">Follow <b>{{ follow ? "on" : "off" }}</b></span>
          <span class="status-item">
            Loop <b>{{ looping ? "on" : "off" }}</b>
            <b>{{ formatSourceTime(loopRegion.startMs) }}–{{ formatSourceTime(loopRegion.endMs) }}</b>
          </span>
          <span class="status-item">Rate <b>{{ rate }}×</b></span>
          <span v-if="passage" class="status-item status-optional">
            <b>{{ passage.audio.sample_rate.toLocaleString() }} Hz · {{ passage.audio.channels }} ch</b>
          </span>
          <span
            class="status-item"
            :class="{ 'status-warning': conversion.startsWith('Device converts') || !outputRate.hz }"
          >
            {{ conversion }}
          </span>
          <span
            class="status-item status-optional timing-setup-status"
            :class="{ 'status-warning': !setupLine.text.trim() }"
            :title="setupOrigin"
          >
            Setup <b>{{ setupBrief }}</b>
          </span>
          <span
            class="status-item"
            :class="{ 'status-warning': offsetNeedsCheck }"
            :title="offsetNeedsCheck ? 'The output changed since the offset was set; check it' : undefined"
          >
            Offset <b>{{ preferences.playheadOffsetMs }} ms</b>
            <template v-if="offsetNeedsCheck">· check</template>
          </span>
          <span class="status-item status-item--end status-item--path" :title="opened.marks_path">
            {{ opened.marks_path }}
          </span>
        </template>
      </WorkspaceFrame>
    </template>
  </main>
</template>

<style scoped>
.timing-stage-column {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  background: var(--well);
}

.timing-hud {
  flex: 0 0 auto;
}

.timing-transport {
  margin: 0;
  padding: 0;
  border: 0;
}

.timing-identity {
  max-width: 180px;
}

.timing-blind {
  color: var(--ink-muted);
  font-size: var(--text-xs);
}

.timing-status {
  min-width: 0;
  overflow: hidden;
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timing-passage-list {
  flex: 1 1 auto;
}

.timing-details {
  display: flex;
  min-height: 100%;
  flex-direction: column;
}

.timing-mark-actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
  min-inline-size: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.timing-mark-actions .tool-button {
  min-width: 0;
  padding: 0 4px;
}

.timing-place {
  grid-column: span 2;
}

.timing-nudge {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}

.timing-nudge .segmented {
  flex: 1 1 auto;
  max-width: 240px;
}

.timing-mark-list,
.timing-legend {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}

.timing-mark-list {
  max-height: min(320px, 40vh);
  overflow-y: auto;
  border-radius: var(--radius-control);
  background: var(--field);
  box-shadow: inset 0 0 0 1px var(--seam);
}

.timing-mark-list button,
.timing-legend-row {
  display: grid;
  width: 100%;
  min-height: 24px;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  color: var(--ink-secondary);
  border: 0;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  font-size: var(--text-xs);
  text-align: left;
}

.timing-mark-list button {
  grid-template-columns: 12px auto auto minmax(0, 1fr);
}

.timing-mark-list li + li button {
  box-shadow: inset 0 1px 0 oklch(100% 0 0 / 0.03);
}

.timing-mark-list button.is-active {
  color: var(--ink);
  background: var(--signal-soft);
  box-shadow: inset 2px 0 0 var(--signal);
}

.timing-nudge .segmented button {
  flex: 1 1 0;
  min-width: 0;
  padding: 0 2px;
}

.timing-mark-glyph {
  color: var(--ink-muted);
  font-size: 9px;
}

.timing-mark-list button.is-active .timing-mark-glyph {
  color: var(--ink);
}

.timing-mark-time,
.timing-mark-sample,
.timing-legend-index,
.timing-legend-state {
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
}

.timing-mark-time {
  color: var(--ink);
}

.timing-mark-sample,
.timing-mark-kind {
  color: var(--ink-muted);
}

.timing-mark-kind {
  justify-self: end;
}

.timing-mark-empty {
  padding: 8px;
  color: var(--ink-muted);
  font-size: var(--text-xs);
}

.timing-help summary {
  min-height: 22px;
  color: var(--ink-muted);
  cursor: pointer;
  font-size: var(--text-xs);
}

.timing-help p {
  margin: 4px 0 0;
  color: var(--ink-muted);
  font-size: var(--text-xs);
  line-height: 1.5;
  text-wrap: pretty;
}

.timing-legend-row {
  grid-template-columns: 12px 12px minmax(0, 1fr) auto;
  border-radius: var(--radius-control);
}

.timing-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

.timing-legend-row.is-off {
  color: var(--ink-muted);
}

.timing-legend-row.is-off .timing-swatch {
  opacity: 0.25;
}

.timing-legend-index,
.timing-legend-state {
  color: var(--ink-muted);
}

.timing-legend-name strong {
  margin-left: 6px;
  color: var(--ink);
  font-weight: 650;
}

@media (hover: hover) {
  .timing-mark-list button:hover,
  .timing-legend-row:hover {
    color: var(--ink);
    background: var(--surface-hover);
  }

  .timing-mark-list button.is-active:hover {
    background: oklch(37% 0.08 258);
  }
}

.timing-check {
  display: grid;
  min-height: var(--control-h);
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  color: var(--ink-secondary);
  font-size: var(--text-xs);
}

.timing-check input {
  margin: 0;
  accent-color: var(--signal-fill);
}

.timing-check output,
.timing-check kbd {
  color: var(--ink-muted);
  font-family: var(--font-data);
  font-size: var(--text-2xs);
}

.prop-input {
  width: 88px;
  min-height: var(--control-h);
  padding: 0 6px;
  color: var(--ink);
  border: 0;
  border-radius: var(--radius-control);
  background: var(--field);
  box-shadow: inset 0 0 0 1px var(--field-edge);
  font-family: var(--font-data);
  font-size: var(--text-xs);
  text-align: right;
}

.timing-offset-editor {
  grid-template-columns: auto minmax(64px, 1fr) auto auto;
}

.timing-warning {
  color: var(--warning);
  font-size: var(--text-xs);
}

.timing-wide,
.timing-reveal {
  width: 100%;
}

.timing-facts dd {
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
}

.timing-output {
  font-size: var(--text-2xs);
}

.timing-note-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.timing-note-state {
  margin-top: -2px;
  font-size: var(--text-2xs);
}

.timing-setup-source {
  margin-top: -2px;
  font-size: var(--text-2xs);
}

/* The setup line can be long; it gives way before the marks file does. */
.timing-setup-status {
  min-width: 0;
  max-width: 240px;
  flex: 0 1 auto;
  overflow: hidden;
}

.timing-setup-status > b {
  overflow: hidden;
  text-overflow: ellipsis;
}

.timing-output span {
  font-family: var(--font-data);
  overflow-wrap: anywhere;
}

.timing-desktop-note {
  display: none;
}

@media (max-width: 1240px) {
  .toolbar-optional {
    display: none;
  }
}

@media (max-width: 920px) {
  .timing-desktop-note {
    display: block;
    margin: 0;
    padding: 24px;
    font-size: var(--text-md);
  }

  .timing-workspace {
    display: none;
  }
}
</style>
