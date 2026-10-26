<script setup lang="ts">
import { renderDefaults } from "beatmap-lens";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, triggerRef } from "vue";
import AudioOffsetControl from "./AudioOffsetControl.vue";
import AudioVolumeControl from "./AudioVolumeControl.vue";
import { DEFAULT_AUDIO_VOLUME } from "./annotation/audio-volume";
import { defaultVisualSpeed, visualSpeedPresets } from "./annotation/buffered-scene";
import { isNativeActivationTarget, isTypingTarget } from "./annotation/keyboard-targets";
import { MediaPlaybackClock } from "./annotation/media-playback-clock";
import { type PlaybackRate, SUPPORTED_PLAYBACK_RATES } from "./annotation/playback-rate";
import { IndexedDbSessionStore, type SessionPreferences } from "./annotation/session-store";
import { formatTimelineRangeTime as formatTime } from "./annotation/timeline-range";
import CompareStage from "./CompareStage.vue";
import { type AudioEnvelope, decodeEnvelope } from "./compare/audio-envelope";
import { comparisonJson, comparisonRequest } from "./compare/client";
import type {
  BlindExcerpt,
  ComparisonVerdict,
  ExcerptTarget,
  OpenComparison,
  VerdictRecord,
} from "./compare/contracts";
import LongNoteTailControl from "./LongNoteTailControl.vue";
import PanelSection from "./layout/PanelSection.vue";
import type { PaneSpec } from "./layout/pane-layout";
import type { MobilePanel } from "./layout/WorkspaceFrame.vue";
import WorkspaceFrame from "./layout/WorkspaceFrame.vue";
import WorkspaceModeSwitch from "./WorkspaceModeSwitch.vue";
import type { WorkspaceMode } from "./workspace-mode";

const emit = defineEmits<{ "change-mode": [mode: WorkspaceMode] }>();

const rememberedManifest = "lens-compare-manifest";
const verdictChoices: { value: ComparisonVerdict; label: string }[] = [
  { value: "a_better", label: "A better" },
  { value: "b_better", label: "B better" },
  { value: "no_difference", label: "No difference" },
  { value: "cant_tell", label: "Can't tell" },
];
const views = [
  { label: "A", key: "a", shown: [0] },
  { label: "B", key: "b", shown: [1] },
  { label: "Side by side", key: "s", shown: [0, 1] },
] as const;
const excerptsPane: PaneSpec = {
  id: "compare-excerpts",
  label: "Excerpts",
  defaultSize: 248,
  min: 180,
  max: 420,
};
const verdictPane: PaneSpec = {
  id: "compare-details",
  label: "Verdict and listening",
  defaultSize: 300,
  min: 248,
  max: 480,
};

// Setup
const openFrom = ref<"manifest" | "charts">("manifest");
const manifestPath = ref(
  new URLSearchParams(window.location.search).get("manifest") ??
    localStorage.getItem(rememberedManifest) ??
    "",
);
const chartPaths = ref<[string, string]>(["", ""]);
const outputFolder = ref("");

// Session
const opened = shallowRef<OpenComparison>();
const blind = shallowRef<BlindExcerpt>();
const envelope = shallowRef<AudioEnvelope>();
const pairIndex = ref(0);
const excerptIndex = ref(0);
const note = ref("");
const view = ref<(typeof views)[number]["key"]>("s");
const playheadMs = ref(0);
const playing = ref(false);
const rate = ref<PlaybackRate>(1);
const visualSpeed = ref(defaultVisualSpeed);
const audioOffsetMs = ref(0);
const audioVolume = ref(DEFAULT_AUDIO_VOLUME);
const tailShortenMs = ref<number>(renderDefaults.scene.tailShortenMs);
const mobilePanel = ref<MobilePanel>("preview");
const busy = ref(false);
const saving = ref(false);
const error = ref("");

const sessions = new IndexedDbSessionStore();
let preferenceWrite = Promise.resolve();
const preferencesReady = sessions.getPreferences().then((preferences) => {
  audioOffsetMs.value = preferences?.audioOffsetMs ?? 0;
  audioVolume.value = preferences?.audioVolume ?? DEFAULT_AUDIO_VOLUME;
  tailShortenMs.value = preferences?.tailShortenMs ?? renderDefaults.scene.tailShortenMs;
}).catch((cause) => report(new Error(`Could not load Inspector preferences: ${String(cause)}`)));

const pair = computed(() => opened.value?.pairs[pairIndex.value]);
const excerpt = computed(() => pair.value?.excerpts[excerptIndex.value]);
const verdict = computed(() => blind.value?.verdict);
const verdictLabel = computed(
  () => verdictChoices.find((choice) => choice.value === verdict.value?.verdict)?.label,
);
const queue = computed(() =>
  (opened.value?.pairs ?? []).flatMap((song, songIndex) =>
    song.excerpts.map((part, index) => ({ songIndex, index, saved: part.saved })),
  ),
);
const judged = computed(() => queue.value.filter((entry) => entry.saved).length);
/** The next excerpt without a verdict after the current one, wrapping across songs. */
const nextUnjudged = computed(() => {
  const at = queue.value.findIndex(
    (entry) => entry.songIndex === pairIndex.value && entry.index === excerptIndex.value,
  );
  return [...queue.value.slice(at + 1), ...queue.value.slice(0, at)].find((entry) => !entry.saved);
});
const status = computed(() => {
  if (error.value) return { tone: "error", text: "Needs attention" };
  if (saving.value) return { tone: "warn", text: "Saving verdict" };
  if (busy.value) return { tone: "warn", text: "Loading" };
  if (verdict.value) return { tone: "ready", text: "Verdict saved" };
  return { tone: "idle", text: "Blind" };
});
const shownCharts = computed(() => views.find((entry) => entry.key === view.value)?.shown ?? views[2].shown);
const verdictFile = computed(() => opened.value?.verdict_path.split(/[\\/]/).at(-1));

let clock: MediaPlaybackClock | undefined;
let media: HTMLAudioElement | undefined;
let mediaUrl: string | undefined;
let disposed = false;

onMounted(() => window.addEventListener("keydown", handleKeydown));
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("keydown", handleKeydown);
  releaseAudio();
});

function target(): ExcerptTarget {
  return {
    session_id: opened.value?.session_id ?? "",
    pair_index: pairIndex.value,
    excerpt_index: excerptIndex.value,
  };
}

function report(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : String(cause);
}

async function open() {
  busy.value = true;
  error.value = "";
  try {
    await preferencesReady;
    const result = await comparisonJson<OpenComparison>("open", {
      ...(openFrom.value === "manifest"
        ? { manifest_path: manifestPath.value }
        : { chart_paths: chartPaths.value }),
      ...(outputFolder.value.trim() ? { output_folder: outputFolder.value } : {}),
    });
    if (disposed) return;
    if (openFrom.value === "manifest") localStorage.setItem(rememberedManifest, manifestPath.value);
    opened.value = result;
    await select(0, 0);
  } catch (cause) {
    report(cause);
  } finally {
    busy.value = false;
  }
}

async function select(songIndex: number, index: number) {
  const songChanged = songIndex !== pairIndex.value || !clock;
  clock?.pause();
  pairIndex.value = songIndex;
  excerptIndex.value = index;
  blind.value = undefined;
  note.value = "";
  error.value = "";
  busy.value = true;
  try {
    const result = await comparisonJson<BlindExcerpt>("excerpt", target());
    if (disposed) return;
    blind.value = result;
    note.value = result.verdict?.note ?? "";
    if (songChanged) await loadAudio();
    clock?.seek(excerpt.value?.start_ms ?? 0);
    mobilePanel.value = "preview";
  } catch (cause) {
    report(cause);
  } finally {
    busy.value = false;
  }
}

/** One audio element per song; both charts follow its clock, so switching views never seeks. */
async function loadAudio() {
  releaseAudio();
  const bytes = await (await comparisonRequest("audio", target())).arrayBuffer();
  // Decoding detaches the buffer it is given, and the media element still needs the bytes.
  const analyzed = await decodeEnvelope(bytes.slice(0));
  if (disposed) return;
  envelope.value = analyzed;
  mediaUrl = URL.createObjectURL(new Blob([bytes]));
  const element = new Audio(mediaUrl);
  media = element;
  await new Promise<void>((resolve, reject) => {
    element.addEventListener("loadedmetadata", () => resolve(), { once: true });
    element.addEventListener(
      "error",
      () => reject(new Error("The browser could not load this audio.")),
      { once: true },
    );
    element.load();
  });
  if (disposed) return;
  const songClock = new MediaPlaybackClock(
    element,
    undefined,
    (cause) => {
      songClock.pause();
      report(cause);
    },
    audioOffsetMs.value,
  );
  songClock.subscribe((state) => {
    playheadMs.value = state.currentTimeMs;
    playing.value = state.playing;
  });
  songClock.setAudioVolume(audioVolume.value);
  songClock.setPlaybackRate(rate.value);
  clock = songClock;
}

function releaseAudio() {
  clock?.dispose();
  clock = undefined;
  if (media) {
    media.removeAttribute("src");
    media.load();
    media = undefined;
  }
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = undefined;
  envelope.value = undefined;
  playing.value = false;
}

async function togglePlayback() {
  const range = excerpt.value;
  if (!clock || !range || busy.value) return;
  if (playing.value) {
    clock.pause();
    return;
  }
  const position = playheadMs.value;
  error.value = "";
  try {
    const started = clock.loopSelection({ startMs: range.start_ms, endMs: range.end_ms });
    // Resume where the listener paused inside the excerpt, not from its start.
    if (position >= range.start_ms && position < range.end_ms) clock.seek(position);
    await started;
  } catch (cause) {
    report(cause);
  }
}

function seek(timeMs: number) {
  clock?.seek(timeMs);
}

function setRate(value: PlaybackRate) {
  rate.value = value;
  clock?.setPlaybackRate(value);
}

function setAudioOffset(value: number) {
  audioOffsetMs.value = value;
  clock?.setAudioOffsetMs(value);
  savePreferences({ audioOffsetMs: value });
}

function setAudioVolume(value: number) {
  audioVolume.value = value;
  clock?.setAudioVolume(value);
  savePreferences({ audioVolume: value });
}

function setTailShortenMs(value: number) {
  tailShortenMs.value = value;
  savePreferences({ tailShortenMs: value });
}

function savePreferences(patch: Partial<SessionPreferences>) {
  preferenceWrite = preferenceWrite.then(async () => {
    const previous = await sessions.getPreferences();
    await sessions.setPreferences({
      annotatorId: "",
      visualSpeed: defaultVisualSpeed,
      musicEnabled: false,
      ...previous,
      ...patch,
    });
  }).catch((cause) => report(new Error(`Could not save Inspector preferences: ${String(cause)}`)));
}

async function save(value: ComparisonVerdict) {
  const current = blind.value;
  if (!current || current.verdict || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const record = await comparisonJson<VerdictRecord>("verdict", {
      ...target(),
      verdict: value,
      note: note.value,
      playback_rate: rate.value,
    });
    if (disposed) return;
    blind.value = { ...current, verdict: record };
    if (excerpt.value) {
      excerpt.value.saved = true;
      triggerRef(opened);
    }
  } catch (cause) {
    report(cause);
  } finally {
    saving.value = false;
  }
}

function close() {
  releaseAudio();
  opened.value = undefined;
  blind.value = undefined;
  error.value = "";
}

function handleKeydown(event: KeyboardEvent) {
  if (!blind.value || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey)
    return;
  if (isTypingTarget(event.target)) return;
  if (event.key === " ") {
    if (isNativeActivationTarget(event.target)) return;
    event.preventDefault();
    void togglePlayback();
    return;
  }
  const next = views.find((entry) => entry.key === event.key.toLowerCase());
  if (next) view.value = next.key;
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
          <p class="brand-edition">Blind comparison</p>
        </div>
      </div>
      <div class="annotation-chart-context">
        <span>Comparison</span>
        <strong>Not opened</strong>
      </div>
      <WorkspaceModeSwitch
        model-value="compare"
        :disabled="busy"
        @update:model-value="emit('change-mode', $event)"
      />
    </header>

    <section v-if="!opened" class="annotation-onboarding" aria-labelledby="compare-heading">
      <div class="onboarding-intro">
        <p class="section-kicker"><span class="section-number">01</span> Blind listening</p>
        <h1 id="compare-heading">Compare two charts by ear</h1>
        <p>
          Loop short excerpts of one song and switch between A and B without stopping the audio.
          Model names stay hidden until your verdict is saved.
        </p>
        <dl class="onboarding-policies">
          <div>
            <dt>A and B</dt>
            <dd>Shuffled per excerpt</dd>
          </div>
          <div>
            <dt>Audio</dt>
            <dd>One clock for both</dd>
          </div>
          <div>
            <dt>Verdicts</dt>
            <dd>Appended, never edited</dd>
          </div>
        </dl>
      </div>

      <form class="onboarding-form" @submit.prevent="open">
        <label class="field-stack">
          <span>Open from</span>
          <select v-model="openFrom" :disabled="busy">
            <option value="manifest">Comparison manifest</option>
            <option value="charts">Two chart files</option>
          </select>
        </label>

        <label v-if="openFrom === 'manifest'" class="field-stack">
          <span>Manifest path</span>
          <input
            v-model="manifestPath"
            name="manifest"
            placeholder="Full path to comparison.json"
            autocomplete="off"
            spellcheck="false"
            required
            :disabled="busy"
          />
        </label>
        <template v-else>
          <label class="field-stack">
            <span>First chart path</span>
            <input
              v-model="chartPaths[0]"
              name="first-chart"
              placeholder="Full path to a .osu file"
              autocomplete="off"
              spellcheck="false"
              required
              :disabled="busy"
            />
          </label>
          <label class="field-stack">
            <span>Second chart path</span>
            <input
              v-model="chartPaths[1]"
              name="second-chart"
              placeholder="Full path to a .osu file"
              autocomplete="off"
              spellcheck="false"
              required
              :disabled="busy"
            />
          </label>
        </template>

        <label class="field-stack">
          <span>Verdict folder{{ openFrom === "manifest" ? " (optional)" : "" }}</span>
          <input
            v-model="outputFolder"
            name="output-folder"
            :placeholder="openFrom === 'manifest' ? 'Beside the manifest' : 'Full path to a folder'"
            autocomplete="off"
            spellcheck="false"
            :required="openFrom === 'charts'"
            :disabled="busy"
          />
        </label>
        <p class="setup-note">
          {{
            openFrom === "manifest"
              ? "Paths starting with ~/ work. Verdicts are appended to <manifest>.verdicts.jsonl."
              : "Use two exports of the same song, difficulty and seed. Audio comes from the first chart's AudioFilename."
          }}
        </p>

        <p v-if="error" class="inline-message inline-message--error" role="alert">{{ error }}</p>
        <button class="button button--primary onboarding-submit" type="submit" :disabled="busy">
          {{ busy ? "Opening" : "Open comparison" }}
        </button>
      </form>
    </section>

    <WorkspaceFrame
      v-else
      v-model:mobile-panel="mobilePanel"
      class="compare-workspace"
      layout-key="compare"
      mode="compare"
      :mode-disabled="busy || saving"
      :left="excerptsPane"
      :right="verdictPane"
      mobile-label="Comparison views"
      @change-mode="emit('change-mode', $event)"
    >
      <template #toolbar>
        <div class="toolbar-identity toolbar-optional" :title="opened.verdict_path">
          <strong>{{ pair?.title }}</strong>
          <span>{{ verdictFile }}</span>
        </div>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <fieldset class="toolbar-group compare-transport" aria-label="Playback controls">
          <button
            class="tool-button tool-button--play"
            type="button"
            :disabled="busy || !blind"
            :aria-pressed="playing"
            aria-keyshortcuts="Space"
            title="Loop the excerpt or pause (Space)"
            @click="togglePlayback"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path v-if="playing" d="M5.5 3.5v9M10.5 3.5v9" />
              <path v-else class="tool-icon-fill" d="M5 3.3v9.4L12.6 8z" />
            </svg>
            {{ playing ? "Pause" : "Loop excerpt" }}
          </button>
          <button
            class="tool-button"
            type="button"
            :disabled="busy || !blind"
            title="Back to the start of the excerpt"
            @click="seek(excerpt?.start_ms ?? 0)"
          >
            Restart
          </button>
        </fieldset>
        <div class="time-counter" title="Playhead">
          <span class="sr-only">Playhead</span>
          <span class="time-counter-main">{{ formatTime(playheadMs) }}</span>
          <span v-if="excerpt" class="time-counter-sub">
            {{ formatTime(excerpt.start_ms) }}–{{ formatTime(excerpt.end_ms) }}
          </span>
        </div>
        <fieldset class="toolbar-group" aria-label="View">
          <div class="segmented">
            <button
              v-for="option in views"
              :key="option.key"
              type="button"
              :aria-pressed="view === option.key"
              :aria-keyshortcuts="option.key.toUpperCase()"
              :title="`${option.label} (${option.key.toUpperCase()})`"
              @click="view = option.key"
            >
              {{ option.label }}
            </button>
          </div>
        </fieldset>
      </template>

      <template #toolbar-end>
        <span class="health-status compare-status" :class="`health-status--${status.tone}`" aria-live="polite">
          <span class="health-dot" aria-hidden="true"></span>
          {{ status.text }}
        </span>
      </template>

      <template #left>
        <header class="pane-header">
          <h2 id="queue-heading">Excerpts</h2>
          <span class="pane-count">{{ judged }} / {{ queue.length }} judged</span>
        </header>
        <label v-if="opened.pairs.length > 1" class="field-stack compare-song">
          <span>Song</span>
          <select
            :value="pairIndex"
            :disabled="busy || saving"
            @change="select(Number(($event.target as HTMLSelectElement).value), 0)"
          >
            <option v-for="(song, index) in opened.pairs" :key="index" :value="index">
              {{ song.title }}
            </option>
          </select>
        </label>
        <nav class="task-list" aria-labelledby="queue-heading">
          <button
            v-for="(part, index) in pair?.excerpts"
            :key="part.id"
            class="task-row"
            :class="{ 'is-active': index === excerptIndex }"
            type="button"
            :aria-current="index === excerptIndex ? 'step' : undefined"
            :disabled="busy || saving"
            @click="select(pairIndex, index)"
          >
            <span
              class="task-status-mark"
              :class="{ 'task-status-mark--complete': part.saved }"
              aria-hidden="true"
            ></span>
            <span class="task-copy">
              <strong>{{ formatTime(part.start_ms) }}–{{ formatTime(part.end_ms) }}</strong>
              <span>{{ part.hint }}</span>
            </span>
            <span class="task-status-label">{{ part.saved ? "Judged" : "Pending" }}</span>
          </button>
        </nav>
        <PanelSection v-if="pair" id="compare-pair" title="Pair">
          <dl class="compact-facts">
            <div><dt>Song</dt><dd>{{ pair.title }}</dd></div>
            <div v-if="pair.difficulty_band !== undefined">
              <dt>Band</dt><dd>{{ pair.difficulty_band }}</dd>
            </div>
            <div v-if="pair.seed !== undefined"><dt>Seed</dt><dd>{{ pair.seed }}</dd></div>
          </dl>
        </PanelSection>
        <footer class="pane-footer">
          <button class="tool-button" type="button" :disabled="busy || saving" @click="close">
            Open another comparison
          </button>
        </footer>
      </template>

      <template #main>
        <section class="compare-view" aria-label="Charts A and B">
          <div v-if="excerpt" class="stage-toolbar">
            <div class="stage-identity">
              <strong>
                Excerpt {{ excerptIndex + 1 }} of {{ pair?.excerpts.length }}
              </strong>
              <span class="data">
                {{ formatTime(excerpt.start_ms) }}–{{ formatTime(excerpt.end_ms) }}
              </span>
              <span v-if="excerpt.hint" class="stage-hint" :title="excerpt.hint">{{ excerpt.hint }}</span>
            </div>
            <fieldset class="toolbar-group" aria-label="Audio rate">
              <span class="toolbar-label" aria-hidden="true">Audio rate</span>
              <div class="segmented">
                <button
                  v-for="value in SUPPORTED_PLAYBACK_RATES"
                  :key="value"
                  type="button"
                  :aria-pressed="rate === value"
                  @click="setRate(value)"
                >
                  {{ value }}×
                </button>
              </div>
            </fieldset>
            <fieldset class="toolbar-group" aria-label="Visual speed">
              <span class="toolbar-label" aria-hidden="true">Visual speed</span>
              <div class="segmented">
                <button
                  v-for="value in visualSpeedPresets"
                  :key="value"
                  type="button"
                  :aria-pressed="visualSpeed === value"
                  @click="visualSpeed = value"
                >
                  {{ value }}
                </button>
              </div>
            </fieldset>
          </div>
          <label v-if="excerpt" class="compare-scrub">
            <span class="sr-only">Position in excerpt</span>
            <input
              type="range"
              :min="excerpt.start_ms"
              :max="excerpt.end_ms - 1"
              step="1"
              :value="playheadMs"
              :disabled="busy"
              @input="seek(Number(($event.target as HTMLInputElement).value))"
            />
          </label>
          <CompareStage
            v-if="blind"
            :charts="blind.charts"
            :playhead-ms="playheadMs"
            :shown="shownCharts"
            :tail-shorten-ms="tailShortenMs"
            :visual-speed="visualSpeed"
            v-bind="envelope ? { envelope } : {}"
          />
          <div v-else-if="error" class="stage-message">
            <p class="inline-message inline-message--error" role="alert">{{ error }}</p>
            <button class="tool-button" type="button" @click="select(pairIndex, excerptIndex)">
              Reload excerpt
            </button>
          </div>
          <div v-else class="stage-empty">Loading excerpt</div>
        </section>
      </template>

      <template #right>
        <PanelSection id="compare-verdict" title="Which chart follows the music?" :collapsible="false">
          <p v-if="excerpt?.hint" class="compare-hint">{{ excerpt.hint }}</p>
          <label class="field-stack">
            <span>Note (optional)</span>
            <textarea
              v-model="note"
              rows="3"
              placeholder="A few words, if useful"
              :disabled="busy || saving || Boolean(verdict)"
            ></textarea>
          </label>
          <div class="compare-verdicts">
            <button
              v-for="choice in verdictChoices"
              :key="choice.value"
              class="tool-button compare-verdict"
              type="button"
              :aria-pressed="verdict?.verdict === choice.value"
              :disabled="busy || saving || !blind || Boolean(verdict)"
              @click="save(choice.value)"
            >
              {{ choice.label }}
            </button>
          </div>
          <p v-if="error && blind" class="inline-message inline-message--error" role="alert">
            {{ error }}
          </p>
        </PanelSection>

        <PanelSection
          v-if="verdict"
          id="compare-reveal"
          :title="`Saved · ${verdictLabel}`"
          :collapsible="false"
          role="status"
        >
          <dl class="compact-facts">
            <div><dt>A</dt><dd>{{ verdict.shown_a.model }}</dd></div>
            <div><dt>B</dt><dd>{{ verdict.shown_b.model }}</dd></div>
          </dl>
          <button
            v-if="nextUnjudged"
            class="tool-button tool-button--primary compare-next"
            type="button"
            :disabled="busy"
            @click="select(nextUnjudged.songIndex, nextUnjudged.index)"
          >
            Next excerpt
          </button>
          <p v-else class="setup-note">Every excerpt has a verdict.</p>
        </PanelSection>

        <PanelSection id="compare-listening" title="Listening">
          <AudioOffsetControl
            :model-value="audioOffsetMs"
            :disabled="busy || !blind"
            @update:model-value="setAudioOffset"
          />
          <AudioVolumeControl
            :model-value="audioVolume"
            :disabled="busy || !blind"
            @update:model-value="setAudioVolume"
          />
          <LongNoteTailControl
            :model-value="tailShortenMs"
            :disabled="busy || !blind"
            @update:model-value="setTailShortenMs"
          />
          <p class="setup-note">
            <kbd>Space</kbd> loops or pauses; <kbd>A</kbd>, <kbd>B</kbd> and <kbd>S</kbd> switch
            the view.
          </p>
        </PanelSection>
      </template>

      <template #status>
        <span class="status-item">Rate <b>{{ rate }}×</b></span>
        <span class="status-item">Visual speed <b>{{ visualSpeed }}</b></span>
        <span class="status-item">
          View <b>{{ views.find((option) => option.key === view)?.label }}</b>
        </span>
        <span class="status-item">Judged <b>{{ judged }} / {{ queue.length }}</b></span>
        <span class="status-item status-item--end status-item--path" :title="opened.verdict_path">
          Verdicts append to {{ opened.verdict_path }}
        </span>
      </template>
    </WorkspaceFrame>
  </main>
</template>

<style scoped>
.compare-view {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  background: var(--well);
}

.compare-song {
  padding: 6px 8px;
  border-bottom: 1px solid var(--seam);
}

.compare-transport {
  margin: 0;
  padding: 0;
  border: 0;
}

.compare-status {
  font-size: var(--text-xs);
}

.compare-scrub {
  display: block;
  flex: 0 0 auto;
  padding: 0 8px;
  border-bottom: 1px solid var(--seam);
  background: var(--surface-1);
}

.compare-scrub input {
  display: block;
  width: 100%;
  height: 18px;
  margin: 0;
  accent-color: var(--signal-fill);
}

.compare-hint {
  margin: 0;
  color: var(--ink-secondary);
  font-size: var(--text-sm);
  line-height: 1.5;
  text-wrap: pretty;
}

.compare-verdicts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
}

.compare-verdict,
.compare-next {
  min-height: var(--control-h-lg);
}

.compare-next {
  width: 100%;
}
</style>
