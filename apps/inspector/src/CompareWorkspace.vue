<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { MediaPlaybackClock } from "./annotation/media-playback-clock";
import { SUPPORTED_PLAYBACK_RATES } from "./annotation/playback-rate";
import CompareStage from "./CompareStage.vue";
import { type AudioEnvelope, decodeEnvelope } from "./compare/audio-envelope";
import { comparisonJson, comparisonRequest, formatComparisonTime as time } from "./compare/client";
import type { BlindExcerpt, ComparisonVerdict, OpenComparison, VerdictRecord } from "./compare/contracts";
import WorkspaceModeSwitch from "./WorkspaceModeSwitch.vue";
import type { WorkspaceMode } from "./workspace-mode";

const emit = defineEmits<{ "change-mode": [mode: WorkspaceMode] }>();
const inputMode = ref<"manifest" | "paths">("manifest");
const manifestPath = ref(new URLSearchParams(window.location.search).get("manifest") ?? localStorage.getItem("lens-compare-manifest") ?? "");
const chartOne = ref("");
const chartTwo = ref("");
const outputFolder = ref("");
const opened = shallowRef<OpenComparison>();
const blind = shallowRef<BlindExcerpt>();
const envelope = shallowRef<AudioEnvelope>();
const pairIndex = ref(0);
const excerptIndex = ref(0);
const busy = ref(false);
const saving = ref(false);
const error = ref("");
const status = ref("");
const note = ref("");
const playhead = ref(0);
const playing = ref(false);
const rate = ref(1);
const speed = ref(240);
const view = ref<"A" | "B" | "both">("both");
const mobilePanel = ref("source");
const pair = computed(() => opened.value?.pairs[pairIndex.value]);
const excerpt = computed(() => pair.value?.excerpts[excerptIndex.value]);
const verdict = computed(() => blind.value?.verdict);
const completed = computed(() => opened.value?.pairs.reduce((sum, entry) => sum + entry.excerpts.filter((part) => part.saved).length, 0) ?? 0);
const total = computed(() => opened.value?.pairs.reduce((sum, entry) => sum + entry.excerpts.length, 0) ?? 0);
const choices: { value: ComparisonVerdict; label: string }[] = [
  { value: "a_better", label: "A better" }, { value: "b_better", label: "B better" },
  { value: "no_difference", label: "No difference" }, { value: "cant_tell", label: "Can't tell" },
];
let clock: MediaPlaybackClock | undefined;
let media: HTMLAudioElement | undefined;
let audioUrl: string | undefined;
let disposed = false;

function target() { return { session_id: opened.value?.session_id, pair_index: pairIndex.value, excerpt_index: excerptIndex.value }; }
function releaseAudio() {
  clock?.dispose();
  clock = undefined;
  if (media) { media.removeAttribute("src"); media.load(); media = undefined; }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = undefined;
  envelope.value = undefined;
  playing.value = false;
}
function report(errorValue: unknown) { error.value = errorValue instanceof Error ? errorValue.message : String(errorValue); }

async function open() {
  busy.value = true;
  error.value = "";
  status.value = "Opening comparison…";
  try {
    const result = await comparisonJson<OpenComparison>("open", {
      ...(inputMode.value === "manifest" ? { manifest_path: manifestPath.value } : { chart_paths: [chartOne.value, chartTwo.value] }),
      ...(outputFolder.value.trim() ? { output_folder: outputFolder.value } : {}),
    });
    if (disposed) return;
    opened.value = result;
    if (inputMode.value === "manifest") localStorage.setItem("lens-compare-manifest", manifestPath.value);
    await selectExcerpt(0, 0);
  } catch (cause) { report(cause); }
  finally { busy.value = false; status.value = ""; }
}

async function selectExcerpt(song: number, index: number) {
  const audioChanged = song !== pairIndex.value || !clock;
  busy.value = true;
  error.value = "";
  clock?.pause();
  blind.value = undefined;
  note.value = "";
  pairIndex.value = song;
  excerptIndex.value = index;
  try {
    const result = await comparisonJson<BlindExcerpt>("excerpt", target());
    if (disposed) return;
    blind.value = result;
    note.value = result.verdict?.note ?? "";
    if (audioChanged) {
      releaseAudio();
      status.value = "Loading audio and measuring energy…";
      const bytes = await (await comparisonRequest("audio", target())).arrayBuffer();
      const analyzed = await decodeEnvelope(bytes.slice(0));
      if (disposed) return;
      envelope.value = analyzed;
      audioUrl = URL.createObjectURL(new Blob([bytes]));
      media = new Audio(audioUrl);
      await new Promise<void>((resolve, reject) => {
        media?.addEventListener("loadedmetadata", () => resolve(), { once: true });
        media?.addEventListener("error", () => reject(new Error("The browser could not load this audio.")), { once: true });
        media?.load();
      });
      if (disposed) return;
      clock = new MediaPlaybackClock(media, undefined, (cause) => { clock?.pause(); report(cause); });
      clock.subscribe((state) => { playhead.value = state.currentTimeMs; playing.value = state.playing; });
      clock.setPlaybackRate(rate.value);
    }
    clock?.seek(excerpt.value?.start_ms ?? 0);
    mobilePanel.value = "preview";
  } catch (cause) { report(cause); }
  finally { busy.value = false; status.value = ""; }
}

async function togglePlayback() {
  if (!clock || !excerpt.value) return;
  if (playing.value) { clock.pause(); return; }
  const position = playhead.value;
  error.value = "";
  try {
    const started = clock.loopSelection({ startMs: excerpt.value.start_ms, endMs: excerpt.value.end_ms });
    if (position >= excerpt.value.start_ms && position < excerpt.value.end_ms) clock.seek(position);
    await started;
  } catch (cause) { report(cause); }
}

function setRate(value: number) { rate.value = value; clock?.setPlaybackRate(value); }
async function save(value: ComparisonVerdict) {
  if (!blind.value || verdict.value || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const saved = await comparisonJson<VerdictRecord>("verdict", { ...target(), verdict: value, note: note.value, playback_rate: rate.value });
    if (disposed) return;
    blind.value = { ...blind.value, verdict: saved };
    if (opened.value && excerpt.value) {
      excerpt.value.saved = true;
      opened.value = { ...opened.value };
    }
  } catch (cause) { report(cause); }
  finally { saving.value = false; }
}

function nextExcerpt() {
  const pairs = opened.value?.pairs;
  if (!pairs) return;
  const positions = pairs.flatMap((song, i) => song.excerpts.map((part, j) => ({ song: i, index: j, saved: part.saved })));
  const current = positions.findIndex((entry) => entry.song === pairIndex.value && entry.index === excerptIndex.value);
  const next = [...positions.slice(current + 1), ...positions.slice(0, current)].find((entry) => !entry.saved);
  if (next) void selectExcerpt(next.song, next.index);
}

function close() { releaseAudio(); opened.value = undefined; blind.value = undefined; error.value = ""; mobilePanel.value = "source"; }
onBeforeUnmount(() => { disposed = true; releaseAudio(); });
</script>

<template>
  <main class="compare-workspace" :data-panel="mobilePanel">
    <header class="compare-header">
      <a href="/" class="compare-brand">BEATMAP LENS</a>
      <h1>Compare by listening</h1>
      <WorkspaceModeSwitch model-value="compare" :disabled="busy || saving" @update:model-value="emit('change-mode', $event)" />
    </header>
    <nav v-if="opened" class="compare-mobile-switch" aria-label="Comparison panels">
      <button v-for="panel in ['source', 'preview', 'details']" :key="panel" type="button" :aria-pressed="mobilePanel === panel" @click="mobilePanel = panel">{{ panel }}</button>
    </nav>
    <div v-if="error" class="compare-message compare-error" role="alert">{{ error }}<button v-if="opened && !busy" type="button" @click="selectExcerpt(pairIndex, excerptIndex)">Reload excerpt</button></div>
    <p v-if="status" class="compare-message" role="status">{{ status }}</p>
    <form v-if="!opened" class="compare-setup" @submit.prevent="open">
      <h2>Listen where the charts differ</h2>
      <p>Short excerpts, one shared audio track, and a blind A/B choice. Each verdict saves as soon as you choose it.</p>
      <div class="compare-actions">
        <button type="button" :aria-pressed="inputMode === 'manifest'" @click="inputMode = 'manifest'">Manifest</button>
        <button type="button" :aria-pressed="inputMode === 'paths'" @click="inputMode = 'paths'">Two chart paths</button>
      </div>
      <label v-if="inputMode === 'manifest'">Manifest path<input v-model="manifestPath" name="manifest" placeholder="~/ensomi/ensomi-model/artifacts/…/comparison.json" required :disabled="busy"></label>
      <template v-else>
        <label>First chart path<input v-model="chartOne" name="chart-one" placeholder="/full/path/to/first.osu" required :disabled="busy"></label>
        <label>Second chart path<input v-model="chartTwo" name="chart-two" placeholder="/full/path/to/second.osu" required :disabled="busy"></label>
        <p>Choose charts of the same song, difficulty, and seed. Audio comes from the first chart's AudioFilename. A and B are randomized for each excerpt.</p>
      </template>
      <label>Verdict output folder {{ inputMode === 'manifest' ? '(optional)' : '' }}<input v-model="outputFolder" name="output-folder" :required="inputMode === 'paths'" :placeholder="inputMode === 'manifest' ? 'Leave blank to save beside the manifest' : '/full/path/to/verdicts'" :disabled="busy"></label>
      <button type="submit" class="compare-primary" :disabled="busy">{{ busy ? 'Opening…' : 'Open comparison' }}</button>
    </form>
    <div v-else class="compare-body">
      <aside class="compare-source">
        <div class="compare-rail-heading"><h2>Listening queue</h2><span>{{ completed }} / {{ total }}</span></div>
        <label>Song<select aria-label="Song" :value="pairIndex" :disabled="busy || saving" @change="selectExcerpt(Number(($event.target as HTMLSelectElement).value), 0)"><option v-for="(song, i) in opened.pairs" :key="i" :value="i">{{ song.title }}</option></select></label>
        <p v-if="pair" class="compare-meta">{{ pair.difficulty_band !== undefined ? `Band ${pair.difficulty_band} · ` : '' }}{{ pair.seed !== undefined ? `Seed ${pair.seed}` : '' }}</p>
        <ol class="compare-excerpts">
          <li v-for="(part, i) in pair?.excerpts" :key="part.id"><button type="button" :aria-current="excerptIndex === i ? 'step' : undefined" :disabled="busy || saving" @click="selectExcerpt(pairIndex, i)"><span>{{ time(part.start_ms) }}–{{ time(part.end_ms) }} <small>{{ part.saved ? 'Saved' : `${Math.round((part.end_ms - part.start_ms) / 1000)} s` }}</small></span><span>{{ part.hint }}</span></button></li>
        </ol>
        <p class="compare-copy">A and B are randomized separately for each excerpt. Identities appear after your verdict.</p>
        <button type="button" :disabled="busy || saving" @click="close">Open another comparison</button>
      </aside>
      <section class="compare-preview" aria-label="Comparison preview">
        <div class="compare-preview-heading"><h2>{{ pair?.title }}</h2><span v-if="excerpt">{{ time(excerpt.start_ms) }}–{{ time(excerpt.end_ms) }}</span></div>
        <fieldset class="compare-actions compare-view-switch" aria-label="Chart view">
          <button v-for="option in (['A', 'B', 'both'] as const)" :key="option" type="button" :aria-pressed="view === option" @click="view = option">{{ option === 'both' ? 'Side by side' : `Show ${option}` }}</button>
        </fieldset>
        <div class="compare-stage-gutter"><CompareStage v-if="blind" :charts="blind.charts" v-bind="envelope ? { envelope } : {}" :playhead="playhead" :speed="speed" :view="view" /><div v-else class="compare-stage-placeholder">Loading excerpt…</div></div>
        <div class="compare-transport">
          <button type="button" class="compare-primary" :disabled="busy || !blind" @click="togglePlayback">{{ playing ? 'Pause' : 'Loop excerpt' }}</button>
          <button type="button" :disabled="busy || !blind" @click="clock?.seek(excerpt?.start_ms ?? 0)">Restart</button>
          <output aria-label="Playhead">{{ time(playhead) }}</output>
          <label>Speed<select aria-label="Playback speed" :value="rate" @change="setRate(Number(($event.target as HTMLSelectElement).value))"><option v-for="value in SUPPORTED_PLAYBACK_RATES" :key="value" :value="value">{{ value }}×</option></select></label>
          <label>Zoom<select v-model.number="speed" aria-label="Chart zoom"><option :value="120">Wide</option><option :value="240">Normal</option><option :value="480">Close</option></select></label>
        </div>
        <label v-if="excerpt" class="compare-seek">Excerpt position<input aria-label="Excerpt position" type="range" :min="excerpt.start_ms" :max="excerpt.end_ms - 1" step="1" :value="playhead" :disabled="busy" @input="clock?.seek(Number(($event.target as HTMLInputElement).value))"></label>
        <p class="compare-copy">White: audio energy. Blue: onset energy rises. Read across to the notes at the same moment. Pitch is kept when slowing down.</p>
      </section>
      <aside class="compare-details">
        <h2>Which follows the music?</h2>
        <p class="compare-hint">{{ excerpt?.hint }}</p>
        <p class="compare-copy">Listen for accents, meaningful note starts, and rests where the music breathes.</p>
        <label>Optional note<textarea v-model="note" rows="3" placeholder="A few words, if useful" :disabled="busy || saving || !!verdict" /></label>
        <div class="compare-verdicts"><button v-for="choice in choices" :key="choice.value" type="button" :aria-pressed="verdict?.verdict === choice.value" :disabled="busy || saving || !blind || !!verdict" @click="save(choice.value)">{{ choice.label }}</button></div>
        <p v-if="saving" role="status">Saving verdict…</p>
        <div v-if="verdict" class="compare-reveal" role="status"><strong>Saved · {{ choices.find(choice => choice.value === verdict?.verdict)?.label }}</strong><p>A · {{ verdict.shown_a.model }}<br>B · {{ verdict.shown_b.model }}</p><button v-if="completed < total" type="button" :disabled="busy" class="compare-primary" @click="nextExcerpt">Next unheard excerpt →</button><p v-else>All excerpts saved.</p></div>
        <p class="compare-copy">{{ verdict ? 'Saved to' : 'Verdicts will save to' }}<br><span class="compare-output">{{ opened.verdict_path }}</span></p>
      </aside>
    </div>
  </main>
</template>

<style scoped>
.compare-workspace { min-height: 100dvh; background: var(--surface); color: var(--ink); font-size: 13px; padding-bottom: env(safe-area-inset-bottom); }
.compare-header { display: flex; align-items: center; flex-wrap: wrap; gap: 24px; padding: 20px max(24px, env(safe-area-inset-left)); border-bottom: 1px solid var(--line); }
.compare-brand { color: var(--ink); font: 600 11px var(--font-data); text-decoration: none; }
h1 { margin: 0; flex: 1; font-size: 24px; letter-spacing: -.022em; }
h2 { font-size: 13px; font-weight: 650; margin: 0; }
p { line-height: 1.6; text-wrap: pretty; }
button, input, select, textarea { font: inherit; }
button { border: 0; border-radius: 10px; padding: 10px 14px; background: var(--surface); color: var(--ink); box-shadow: var(--shadow-control); cursor: pointer; font-weight: 600; transition: transform 120ms var(--ease-out), background-color 140ms var(--ease-out); }
button:hover { background: var(--surface-hover); }
button:active { transform: scale(.96); }
button:disabled { opacity: .5; cursor: default; }
button[aria-pressed="true"] { color: var(--signal); background: var(--surface-quiet); box-shadow: inset 0 0 0 1px var(--signal); }
button.compare-primary { background: var(--ink); color: var(--surface); }
input, select, textarea { min-width: 0; width: 100%; min-height: 40px; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; color: var(--ink); background: var(--surface-quiet); }
textarea { border: 0; border-radius: 14px; resize: vertical; }
label { display: grid; gap: 8px; font-weight: 550; }
input:focus-visible, select:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.compare-setup { max-width: 720px; margin: 64px auto; padding: 0 24px; display: grid; gap: 24px; }
.compare-setup h2 { font-size: 30px; line-height: 1.08; letter-spacing: -.022em; }
.compare-setup p { margin: 0; color: var(--ink-secondary); }
.compare-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.compare-body { display: grid; grid-template-columns: 260px minmax(0, 1fr) 280px; }
.compare-source, .compare-details { padding: 24px; min-width: 0; }
.compare-source { border-right: 1px solid var(--line); }
.compare-details { border-left: 1px solid var(--line); }
.compare-rail-heading, .compare-preview-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 24px; }
.compare-rail-heading span, .compare-preview-heading span, .compare-meta, output { font: 500 11px var(--font-data); font-variant-numeric: tabular-nums; }
.compare-excerpts { list-style: none; margin: 24px -24px; padding: 0; }
.compare-excerpts button { display: grid; gap: 8px; width: 100%; text-align: left; border-radius: 0; box-shadow: none; border-bottom: 1px solid var(--line); padding: 16px 24px; font-weight: 450; line-height: 1.5; }
.compare-excerpts button[aria-current] { background: var(--surface-quiet); color: var(--signal); }
.compare-excerpts button span:first-child { display: flex; justify-content: space-between; font: 500 10px var(--font-data); }
.compare-excerpts small { font: inherit; }
.compare-copy { color: var(--ink-secondary); font-size: 12px; line-height: 1.6; }
.compare-preview { min-width: 0; padding: 24px; }
.compare-preview-heading { margin-bottom: 16px; }
.compare-view-switch { margin: 0 0 16px; padding: 0; border: 0; min-inline-size: 0; }
.compare-stage-gutter { padding: 8px; border-radius: 22px; background: var(--surface-quiet); }
.compare-stage-placeholder { display: grid; place-items: center; min-height: 400px; }
.compare-transport { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 16px; }
.compare-transport label { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.compare-transport select { width: auto; }
.compare-transport output { margin-right: auto; padding: 8px; }
.compare-seek { margin-top: 16px; font-size: 11px; }
.compare-seek input { padding: 0; accent-color: var(--signal); }
.compare-hint { font-size: 16px; margin: 24px 0 12px; }
.compare-details label { margin-top: 24px; }
.compare-verdicts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 16px 0; }
.compare-reveal { border-top: 1px solid var(--line); padding-top: 16px; margin-top: 24px; }
.compare-reveal strong { color: var(--success); }
.compare-output { overflow-wrap: anywhere; font-family: var(--font-data); font-size: 10px; }
.compare-message { margin: 0; padding: 16px 24px; border-bottom: 1px solid var(--line); }
.compare-message button { margin-left: 16px; }
.compare-error { color: var(--danger); }
.compare-mobile-switch { display: none; }
@media (max-width: 1200px) { .compare-body { grid-template-columns: 220px minmax(0, 1fr) 240px; } .compare-source, .compare-details, .compare-preview { padding: 16px; } .compare-excerpts { margin: 24px -16px; } .compare-excerpts button { padding: 16px; } }
@media (max-width: 920px) { .compare-header { gap: 16px; padding: 16px; } h1 { font-size: 20px; } .compare-mobile-switch { display: flex; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); } .compare-body { display: block; } .compare-source, .compare-preview, .compare-details { display: none; border: 0; } [data-panel="source"] .compare-source, [data-panel="preview"] .compare-preview, [data-panel="details"] .compare-details { display: block; } .compare-verdicts { max-width: 480px; } .compare-setup { margin-top: 32px; } }
@media (max-width: 600px) { .compare-header { justify-content: space-between; } h1 { order: 3; flex-basis: 100%; } }
</style>
