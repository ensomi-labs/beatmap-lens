<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import AudioVolumeControl from "./AudioVolumeControl.vue";
import { isNativeActivationTarget, isTypingTarget } from "./annotation/keyboard-targets";
import { formatTimelineRangeTime as formatTime } from "./annotation/timeline-range";
import { TimingAudioEngine } from "./timing/audio-engine";
import { timingJson, timingRequest } from "./timing/client";
import type { BlindPassage, BlindPassageRow, OpenTiming } from "./timing/contracts";
import { prerollStart } from "./timing/output-clock";
import { deinterleave } from "./timing/pcm";
import { formatSourceTime } from "./timing/time-view";
import WorkspaceModeSwitch from "./WorkspaceModeSwitch.vue";
import type { WorkspaceMode } from "./workspace-mode";

const emit = defineEmits<{ "change-mode": [mode: WorkspaceMode] }>();

const rememberedSession = "lens-timing-session";
const preferencesKey = "lens-timing-preferences";
const playbackRates = [1, 0.75, 0.5] as const;
/** At least this much real preceding audio is played before every start. */
const minimumPrerollMs = 120;
const deviceRates = [44_100, 48_000, 88_200, 96_000] as const;

interface TimingPreferences {
  volume: number;
  playheadOffsetMs: number;
  /** Context rate the offset was last set at; another rate needs a fresh check. */
  offsetRate: number | null;
  prerollMs: number;
  deviceRateHz: number | null;
  setup: string;
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

const sessionPath = ref(
  new URLSearchParams(window.location.search).get("session") ?? remembered(rememberedSession) ?? "",
);
const opened = shallowRef<OpenTiming>();
const blind = shallowRef<BlindPassage>();
const passageIndex = ref(0);
const busy = ref(false);
const error = ref("");

// Playback
const audioState = ref<"none" | "loading" | "ready">("none");
const playheadMs = ref(0);
const playing = ref(false);
const looping = ref(false);
const loopRegion = ref<{ startMs: number; endMs: number }>({ startMs: 0, endMs: 0 });
const rate = ref<(typeof playbackRates)[number]>(1);
const loudnessMatch = ref(false);
const latencies = ref<{ base_latency_ms: number | null; output_latency_ms: number | null }>({
  base_latency_ms: null,
  output_latency_ms: null,
});
const contextRate = ref<number>();
const deviceChanged = ref(false);

let engine: TimingAudioEngine | undefined;
let loadedHandle = "";
let frame = 0;
let disposed = false;

const passage = computed(() => opened.value?.passages[passageIndex.value]);
const status = computed(() => {
  if (error.value) return { tone: "error", text: "Needs attention" };
  if (busy.value || audioState.value === "loading") return { tone: "warn", text: "Loading" };
  return { tone: "idle", text: "Blind" };
});
const marksFile = computed(() => opened.value?.marks_path.split(/[\\/]/).at(-1));
/** What is shown and playable: the passage plus its context, inside the recording. */
const bounds = computed(() => {
  const row = passage.value;
  if (!row) return { startMs: 0, endMs: 0 };
  const durationMs = (row.audio.frames * 1000) / row.audio.sample_rate;
  return {
    startMs: Math.max(0, row.start_ms - row.context_before_ms),
    endMs: Math.min(durationMs, row.end_ms + row.context_after_ms),
  };
});
const loudnessAppliedDb = computed(() =>
  loudnessMatch.value ? Math.min(0, passage.value?.loudness_gain_db ?? 0) : 0,
);
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
  navigator.mediaDevices?.addEventListener?.("devicechange", markDeviceChanged);
});
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("keydown", handleKeydown);
  navigator.mediaDevices?.removeEventListener?.("devicechange", markDeviceChanged);
  cancelAnimationFrame(frame);
  void engine?.close();
  engine = undefined;
});

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

function markDeviceChanged() {
  deviceChanged.value = true;
}

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function report(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : String(cause);
}

async function open() {
  busy.value = true;
  error.value = "";
  try {
    const result = await timingJson<OpenTiming>("open", { session_path: sessionPath.value });
    if (disposed) return;
    try {
      localStorage.setItem(rememberedSession, sessionPath.value);
    } catch {}
    opened.value = result;
    await select(0);
  } catch (cause) {
    report(cause);
  } finally {
    busy.value = false;
  }
}

async function select(index: number) {
  stop();
  passageIndex.value = index;
  blind.value = undefined;
  busy.value = true;
  error.value = "";
  try {
    const result = await timingJson<BlindPassage>("passage", {
      session_id: opened.value?.session_id,
      passage_index: index,
    });
    if (disposed) return;
    const row = passage.value;
    if (!row) return;
    await loadAudio(row);
    if (disposed) return;
    blind.value = result;
    loopRegion.value = { startMs: row.start_ms, endMs: row.end_ms };
    playheadMs.value = row.start_ms;
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
  loadedHandle = "";
  if (engine && engine.sampleRate !== audio.sample_rate) {
    await engine.close();
    engine = undefined;
  }
  if (!engine) {
    engine = new TimingAudioEngine(audio.sample_rate);
    engine.onEnded = (positionMs) => {
      playing.value = false;
      playheadMs.value = positionMs;
    };
    contextRate.value = engine.sampleRate;
  }
  const bytes = await (
    await timingRequest("audio", { session_id: opened.value?.session_id, handle: audio.handle })
  ).arrayBuffer();
  if (disposed || !engine) return;
  engine.load(deinterleave(bytes, audio.channels, audio.frames), audio.frames);
  engine.setVolume(preferences.value.volume);
  engine.setLoudnessDb(loudnessAppliedDb.value);
  loadedHandle = audio.handle;
  audioState.value = "ready";
}

function close() {
  stop();
  opened.value = undefined;
  blind.value = undefined;
  error.value = "";
}

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

function seek(timeMs: number) {
  const wasPlaying = playing.value;
  stop();
  playheadMs.value = clampToBounds(timeMs);
  if (wasPlaying) togglePlayback();
}

function toggleLoop() {
  looping.value = !looping.value;
  if (playing.value) {
    stop();
    togglePlayback();
  }
}

function setLoopEdge(edge: "startMs" | "endMs") {
  const region = { ...loopRegion.value, [edge]: playheadMs.value };
  if (region.endMs > region.startMs) loopRegion.value = region;
}

function setRate(value: (typeof playbackRates)[number]) {
  rate.value = value;
  if (playing.value) {
    stop();
    togglePlayback();
  }
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

function handleKeydown(event: KeyboardEvent) {
  if (!blind.value || event.defaultPrevented || event.altKey) return;
  if (isTypingTarget(event.target)) return;
  if (event.metaKey || event.ctrlKey) return;
  const key = event.key;
  if (key === " ") {
    if (isNativeActivationTarget(event.target)) return;
    event.preventDefault();
    if (event.shiftKey) playRegionOnce();
    else togglePlayback();
    return;
  }
  const actions: Record<string, () => void> = {
    Escape: stop,
    l: toggleLoop,
    i: () => setLoopEdge("startMs"),
    o: () => setLoopEdge("endMs"),
    Home: () => seek(passage.value?.start_ms ?? 0),
    End: () => seek(passage.value?.end_ms ?? 0),
  };
  const action = actions[key.length === 1 ? key.toLowerCase() : key];
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
        @update:model-value="emit('change-mode', $event)"
      />
    </header>

    <section v-if="!opened" class="annotation-onboarding" aria-labelledby="timing-heading">
      <div class="onboarding-intro">
        <p class="section-kicker"><span class="section-number">01</span> Listening by ear</p>
        <h1 id="timing-heading">Mark where the beats are</h1>
        <p>
          Place beat and unbeat marks on the waveform of the source audio. Proposals are drawn in
          anonymous colours and stay silent; their names are shown only after you save.
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
        <p v-if="error" class="inline-message inline-message--error" role="alert">{{ error }}</p>
        <button class="button button--primary onboarding-submit" type="submit" :disabled="busy">
          {{ busy ? "Opening" : "Open session" }}
        </button>
      </form>
    </section>

    <div v-else class="annotation-workspace timing-workspace">
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
            :disabled="busy"
            @update:model-value="emit('change-mode', $event)"
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
            :disabled="busy"
            @click="select(index)"
          >
            <span
              class="task-status-mark"
              :class="{ 'task-status-mark--complete': row.saved }"
              aria-hidden="true"
            ></span>
            <span class="task-copy">
              <strong>{{ String(index + 1).padStart(2, "0") }} {{ row.title }}</strong>
              <span>{{ formatTime(row.start_ms) }}–{{ formatTime(row.end_ms) }}</span>
            </span>
            <span class="task-status-label">{{ row.saved ? "saved" : "" }}</span>
          </button>
        </nav>

        <section class="rail-section">
          <button class="button button--quiet" type="button" :disabled="busy" @click="close">
            Open another session
          </button>
        </section>
      </aside>

      <section class="annotation-stage" aria-label="Timing stage">
        <div v-if="error" class="stage-message">
          <p class="inline-message inline-message--error" role="alert">{{ error }}</p>
        </div>
        <div v-else class="stage-empty">{{ blind ? passage?.title : "Loading passage" }}</div>
      </section>

      <aside class="annotation-rail annotation-details-rail" aria-label="Details">
        <section class="details-transport" aria-label="Playback">
          <div class="details-transport-status">
            <div>
              <span>Playhead</span>
              <strong>{{ formatSourceTime(playheadMs) }}</strong>
            </div>
            <div class="details-transport-state">
              <span v-if="passage">
                {{ formatTime(passage.start_ms) }}–{{ formatTime(passage.end_ms) }}
              </span>
              <span class="health-status" :class="`health-status--${status.tone}`" aria-live="polite">
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
              Gains above 0 dB are not applied.
            </p>

            <div class="audio-offset-control">
              <div class="transport-control-label">
                <span>Playhead offset</span>
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

            <label class="field-stack timing-inline-field">
              <span>Pre-roll (ms, at least {{ minimumPrerollMs }})</span>
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
                <dd>{{ conversion }}</dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd>
                  base {{ latencies.base_latency_ms?.toFixed(1) ?? "—" }} · output
                  {{ latencies.output_latency_ms?.toFixed(1) ?? "—" }} ms
                </dd>
              </div>
            </dl>
          </div>
        </section>
      </aside>
    </div>
  </main>
</template>

<style scoped>
.details-transport .timing-transport {
  grid-template-columns: 2fr 1fr 1fr;
}

.details-transport .speed-controls {
  grid-template-columns: 72px minmax(0, 1fr);
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
  color: oklch(52% 0.14 76);
  font-size: 0.55rem;
}

.timing-inline-field input,
.timing-inline-field select {
  min-height: 40px;
}

.timing-facts dd {
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
}
</style>
