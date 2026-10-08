<script setup lang="ts">
import { createRenderDocument, parseBeatmap, serializeSvgPages } from "beatmap-lens";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { type GoldenSet, goldenAssessment } from "./annotation/workflow/golden-set";
import { type RemoteSourceV2, reviewRequest } from "./annotation/workflow/remote-workspace";
import { REVIEW_TARGETS } from "./annotation/workflow/review-sampling";

const requestedTag = new URLSearchParams(window.location.search).get("tag") ?? "";
const tag = ref(requestedTag in REVIEW_TARGETS ? requestedTag : "");
const strength = ref("");
const search = ref("");
const pool = shallowRef<GoldenSet>();
const loading = ref(false);
const error = ref("");
const selectedId = ref("");
const evidence = shallowRef<RemoteSourceV2>();
const evidenceLoading = ref(false);
const evidenceError = ref("");
let stopped = false;
let selection = 0;

const labelCount = computed(() => pool.value?.cases.reduce((sum, entry) => sum + Object.keys(entry.gold).length, 0) ?? 0);
const filtered = computed(() => {
  const terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return (pool.value?.cases ?? []).filter(entry =>
    Object.entries(entry.gold).some(([id, assessment]) => (!tag.value || id === tag.value)
      && (!strength.value || goldenAssessment(assessment) === strength.value))
    && terms.every(term => [entry.source.title, entry.source.artist, entry.source.difficulty].join(" ").toLowerCase().includes(term)));
});
const selected = computed(() => filtered.value.find(entry => entry.caseId === selectedId.value));
watch(filtered, entries => {
  if (!entries.some(entry => entry.caseId === selectedId.value)) selectedId.value = entries[0]?.caseId ?? "";
});
const pages = computed(() => {
  if (!evidence.value || !selected.value) return [];
  const chart = parseBeatmap(new TextDecoder().decode(Uint8Array.from(evidence.value.sourceBytes))).chart;
  const document = createRenderDocument(chart, {
    range: selected.value.reviewContext,
    page: { size: { widthPx: 1200, heightPx: 900 }, columns: "auto" },
    panel: { playfield: { laneWidthPx: 48 }, maxNoteRows: 32 },
    scale: { type: "row-aware" },
  });
  // Keep the note layout and scale, removing unused space above short panels.
  return serializeSvgPages({ ...document, pages: document.pages.map(page => {
    const top = Math.min(...page.panels.map(panel => panel.frame.y)) - 24;
    return { ...page, size: { ...page.size, heightPx: page.size.heightPx - top },
      panels: page.panels.map(panel => ({ ...panel, frame: { ...panel.frame, y: panel.frame.y - top } })) };
  }) });
});

async function refresh(): Promise<void> {
  if (loading.value || stopped) return;
  loading.value = true;
  error.value = "";
  try {
    const current = await reviewRequest<GoldenSet>("golden-set");
    if (!stopped) pool.value = current;
  } catch (cause) {
    if (!stopped) {
      pool.value = undefined;
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  } finally { if (!stopped) loading.value = false; }
}

watch(selected, async entry => {
  const request = ++selection;
  evidence.value = undefined;
  evidenceError.value = "";
  evidenceLoading.value = !!entry;
  if (!entry) return;
  try {
    const source = await reviewRequest<RemoteSourceV2>(`source/${entry.sourceSha256}`);
    if (request !== selection || stopped) return;
    if (Object.values(entry.humans).flat().some(pin => pin.documentVersion.sha256 !== source.version.sha256))
      throw new Error("This human reference changed. Refresh the golden set to see its current judgment.");
    evidence.value = source;
  } catch (cause) {
    if (request === selection && !stopped) evidenceError.value = cause instanceof Error ? cause.message : String(cause);
  } finally { if (request === selection && !stopped) evidenceLoading.value = false; }
});

function seconds(ms: number): string { return (ms / 1000).toFixed(3); }
onMounted(() => { void refresh(); window.addEventListener("focus", refresh); });
onBeforeUnmount(() => { stopped = true; selection++; window.removeEventListener("focus", refresh); });
</script>

<template>
  <section class="golden-browser" aria-label="Agent gate golden set">
    <header class="golden-heading">
      <div><h2>Current agent gate references</h2><p>Every current High-confidence human label is protected by the agent regression gate. Each comparison freezes this set.</p></div>
      <button type="button" :disabled="loading" @click="refresh">{{ loading ? 'Loading golden set…' : 'Refresh golden set' }}</button>
    </header>
    <p v-if="error || pool?.gateError" class="golden-error" role="alert">{{ error || pool?.gateError }}</p>
    <p v-if="pool && !pool.gateError" class="golden-count" role="status">{{ labelCount }} High-confidence labels · {{ pool.cases.length }} sections · checked {{ new Date(pool.checkedAt).toLocaleTimeString() }}</p>
    <div class="golden-filters">
      <label>Golden label<select v-model="tag"><option value="">All five labels</option><option v-for="(name, id) in REVIEW_TARGETS" :key="id" :value="id">{{ name }}</option></select></label>
      <label>Golden strength<select v-model="strength"><option value="">All strengths</option><option value="absent">Absent</option><option value="supporting">Supporting</option><option value="prominent">Prominent</option></select></label>
      <label>Find a reference<input v-model="search" type="search" placeholder="Chart, artist or difficulty"></label>
    </div>
    <div v-if="pool && !pool.gateError" class="golden-layout">
      <aside class="golden-list" aria-label="Golden sections">
        <p class="golden-count">{{ filtered.length }} matching sections</p>
        <button v-for="entry in filtered" :key="entry.caseId" type="button" :aria-pressed="selectedId === entry.caseId" @click="selectedId = entry.caseId">
          <strong>{{ entry.source.title }}</strong><small>{{ entry.source.difficulty }}</small>
          <small>{{ seconds(entry.scope.startMs) }}–{{ seconds(entry.scope.endMs) }} s · {{ entry.playbackRate }}×</small>
          <span class="golden-labels"><span v-for="(assessment, id) in entry.gold" :key="id" :class="{ 'is-match': tag === id }">{{ REVIEW_TARGETS[id] ?? id }} · {{ goldenAssessment(assessment) }}</span></span>
        </button>
        <p v-if="!filtered.length" class="golden-empty">No golden sections match these filters.</p>
      </aside>
      <section v-if="selected" class="golden-reference" aria-label="Golden source evidence">
        <header><h2>{{ selected.source.title }} <span>[{{ selected.source.difficulty }}]</span></h2><p>{{ selected.source.artist }} · {{ selected.source.keyCount }}K</p></header>
        <p class="golden-range">Judged section {{ seconds(selected.scope.startMs) }}–{{ seconds(selected.scope.endMs) }} s · <strong>{{ selected.playbackRate }}×</strong><br>Shown context {{ seconds(selected.reviewContext.startMs) }}–{{ seconds(selected.reviewContext.endMs) }} s · original source time</p>
        <p v-if="evidenceLoading" role="status">Loading exact source evidence…</p>
        <p v-if="evidenceError" class="golden-error" role="alert">{{ evidenceError }}</p>
        <template v-if="evidence">
          <div class="golden-assessments">
            <section v-for="(assessment, id) in selected.gold" :key="id" :class="{ 'is-match': tag === id }">
              <h3>{{ REVIEW_TARGETS[id] ?? id }} <span>{{ goldenAssessment(assessment) }} · High</span></h3>
              <p v-for="pin in (selected.humans[id] ?? []).filter(pin => pin.comment?.trim())" :key="pin.id" class="golden-comment">{{ pin.comment }}</p>
              <p v-if="!(selected.humans[id] ?? []).some(pin => pin.comment?.trim())" class="golden-empty">No human comment saved.</p>
              <details><summary>{{ REVIEW_TARGETS[id] ?? id }} criteria</summary><template v-for="definition in evidence.document.foundation.tags.filter(definition => definition.id === id)" :key="definition.id"><p>{{ definition.definition }}</p><p>Include: {{ definition.inclusionCues.join(' · ') }}</p><p>Exclude: {{ definition.exclusionCues.join(' · ') }}</p></template></details>
            </section>
          </div>
          <p class="golden-empty">Only protected High-confidence labels are shown. A missing label is not an absence judgment.</p>
          <p class="golden-empty">Time runs upward in each panel, continuing left to right. Spacing is adjusted for readability; axis labels show source time.</p>
          <section class="golden-pages" aria-label="Read-only beatmap preview"><div v-for="(page, index) in pages" :key="`${selected.caseId}:${index}`" v-html="page.svg" /></section>
        </template>
      </section>
    </div>
  </section>
</template>

<style scoped>
.golden-browser { padding-top: 20px; font-size: 13px; }
.golden-heading { display: flex; justify-content: space-between; align-items: start; gap: 24px; }
h2, h3, p { margin: 0; }
h2 { font-size: 17px; line-height: 1.4; }
h2 span { font-size: 14px; font-weight: 450; }
p { line-height: 1.6; }
.golden-heading p, .golden-empty, .golden-count { color: var(--ink-secondary); font-size: 12px; }
.golden-heading p { max-width: 720px; margin-top: 8px; }
.golden-count { margin: 12px 0; font-variant-numeric: tabular-nums; }
.golden-error { margin: 16px 0; color: var(--danger); }
button, input, select { min-height: 40px; border: 0; border-radius: 10px; padding: 10px 12px; background: var(--surface); color: var(--ink); font: inherit; box-shadow: var(--shadow-control); }
button { cursor: pointer; transition: transform 120ms, background-color 120ms; }
button:active { transform: scale(.96); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.golden-filters { display: grid; grid-template-columns: 1fr 1fr 1.5fr; gap: 16px; margin: 20px 0; }
label { display: grid; gap: 8px; font-size: 12px; min-width: 0; }
input, select { width: 100%; min-width: 0; box-sizing: border-box; }
.golden-layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); border-top: 1px solid var(--line); }
.golden-list { max-height: 75dvh; overflow: auto; padding-right: 16px; border-right: 1px solid var(--line); }
.golden-list button { display: grid; gap: 4px; width: 100%; border-radius: 0; box-shadow: none; text-align: left; border-top: 1px solid var(--line); }
.golden-list button:hover, .golden-list button[aria-pressed=true] { background: var(--surface-quiet); }
.golden-list button[aria-pressed=true] strong, .is-match { color: var(--signal); }
.golden-list small { color: var(--ink-secondary); font-size: 11px; }
.golden-labels { display: grid; gap: 4px; margin-top: 6px; font-size: 11px; }
.golden-reference { min-width: 0; padding: 20px 0 0 24px; }
.golden-range { margin: 12px 0; font: 12px/1.8 var(--font-data); }
.golden-assessments { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 24px; }
.golden-assessments section { padding: 12px 0; border-top: 1px solid var(--line); color: var(--ink); }
h3 { font-size: 13px; line-height: 1.6; }
h3 span { display: block; font-weight: 450; }
.golden-assessments .is-match h3 { color: var(--signal); }
.golden-comment { white-space: pre-line; margin-top: 8px; }
summary { min-height: 40px; padding-top: 12px; cursor: pointer; box-sizing: border-box; }
details p { margin-bottom: 8px; color: var(--ink-secondary); font-size: 12px; }
.golden-pages { display: grid; gap: 16px; margin-top: 16px; padding: 8px; border-radius: 22px; background: var(--surface-quiet); }
.golden-pages > div { overflow-x: auto; border-radius: 14px; }
@media (max-width: 920px) {
  .golden-layout { grid-template-columns: 230px minmax(0, 1fr); }
  .golden-assessments { grid-template-columns: 1fr; }
  .golden-reference { padding-left: 16px; }
}
@media (max-width: 640px) {
  .golden-heading { flex-direction: column; gap: 12px; }
  .golden-filters { grid-template-columns: 1fr 1fr; }
  .golden-filters label:last-child { grid-column: 1 / -1; }
  .golden-layout { grid-template-columns: 1fr; }
  .golden-list { max-height: 32dvh; border-right: 0; border-bottom: 1px solid var(--line); padding-right: 0; }
  .golden-reference { padding-left: 0; }
}
</style>

<style>
.golden-pages svg { display: block; width: 100%; min-width: 700px; height: auto; }
</style>
