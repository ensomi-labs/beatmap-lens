<script setup lang="ts">
import {
  type ManiaChart,
  parseOsu,
  toManiaChart,
} from "beatmap-lens";
import { computed, nextTick, onMounted, ref } from "vue";
import { readTailShortenMs } from "./annotation/session-store";
import PanelSection from "./layout/PanelSection.vue";
import type { PaneSpec } from "./layout/pane-layout";
import type { MobilePanel } from "./layout/WorkspaceFrame.vue";
import WorkspaceFrame from "./layout/WorkspaceFrame.vue";
import { renderStaticPreviewSvg } from "./static-preview";
import type { WorkspaceMode } from "./workspace-mode";

const emit = defineEmits<{
  "change-mode": [mode: WorkspaceMode];
}>();

type Fact = {
  label: string;
  value: string;
};

type HealthTone = "ready" | "warn" | "idle" | "error";

type StatusItem = {
  label: string;
  value: string;
  tone: "ready" | "warn" | "error" | "muted";
  detail?: string;
};

type ChartSummary = {
  title: string;
  artist: string;
  version: string;
  keyCount: number;
  noteCount: number;
  longNoteCount: number;
  diagnosticCount: number;
};

const sourcePane: PaneSpec = { id: "inspect-source", label: "Source", defaultSize: 420, min: 240, max: 720 };
const detailsPane: PaneSpec = {
  id: "inspect-details",
  label: "Details",
  defaultSize: 300,
  min: 220,
  max: 480,
};

const sampleMap = `osu file format v14

[General]
AudioFilename: silent-bench.wav
Mode: 3

[Metadata]
Title: Night Switchback
Artist: beatmap-lens
Creator: inspector
Version: Original 4K smoke

[Difficulty]
HPDrainRate:6
CircleSize:4
OverallDifficulty:8
ApproachRate:5

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
64,192,250,1,0,0:0:0:0:
192,192,500,1,0,0:0:0:0:
320,192,750,128,0,1125:0:0:0:0:
448,192,1000,1,0,0:0:0:0:
192,192,1375,1,0,0:0:0:0:
64,192,1625,128,0,2050:0:0:0:0:
320,192,1875,1,0,0:0:0:0:
448,192,2250,1,0,0:0:0:0:
64,192,2500,1,0,0:0:0:0:
320,192,2750,128,0,3250:0:0:0:0:
192,192,3375,1,0,0:0:0:0:
448,192,3625,1,0,0:0:0:0:
64,192,3875,1,0,0:0:0:0:
192,192,4125,128,0,4625:0:0:0:0:
320,192,4750,1,0,0:0:0:0:
448,192,5000,1,0,0:0:0:0:
64,192,5250,1,0,0:0:0:0:
320,192,5500,1,0,0:0:0:0:
192,192,5750,1,0,0:0:0:0:
448,192,6000,128,0,6575:0:0:0:0:`;

const source = ref(sampleMap);
const sourceInput = ref<HTMLTextAreaElement | null>(null);
const svgOutput = ref<HTMLDivElement | null>(null);
const runId = ref("run 00");
const healthText = ref("Idle");
const healthTone = ref<HealthTone>("idle");
const facts = ref<Fact[]>([]);
const statuses = ref<StatusItem[]>([]);
const renderTime = ref("0.0 ms");
const activeMobilePanel = ref<MobilePanel>("preview");
const expandedStatus = ref<number | null>(null);
const chartSummary = ref<ChartSummary>({
  title: "Night Switchback",
  artist: "beatmap-lens",
  version: "Original 4K smoke",
  keyCount: 4,
  noteCount: 20,
  longNoteCount: 5,
  diagnosticCount: 0,
});
const sourceLineCount = computed(() => source.value.split(/\r\n|\n|\r/).length);
let runCount = 0;
const storedTailShortenMs = readTailShortenMs();

onMounted(() => {
  void runPipeline();
});

async function runPipeline(): Promise<void> {
  runCount += 1;
  runId.value = `run ${String(runCount).padStart(2, "0")}`;
  expandedStatus.value = null;
  setHealth("Running", "idle");
  await nextTick();

  try {
    const parseStartedAt = performance.now();
    const document = parseOsu(source.value);
    const parseDuration = performance.now() - parseStartedAt;

    const normalizeStartedAt = performance.now();
    const chart = toManiaChart(document);
    const normalizeDuration = performance.now() - normalizeStartedAt;

    const tailShortenMs = await storedTailShortenMs;
    const renderStartedAt = performance.now();
    const svg = renderStaticPreviewSvg(chart, tailShortenMs);
    const renderDuration = performance.now() - renderStartedAt;

    mountSvg(svg);
    facts.value = chartFacts(chart);
    statuses.value = statusItems(
      chart,
      document.hitObjects.length,
      parseDuration,
      normalizeDuration,
      renderDuration,
    );
    chartSummary.value = summarizeChart(chart);
    renderTime.value = `${renderDuration.toFixed(1)} ms`;
    setHealth(
      chart.diagnostics.length > 0 ? "Warnings" : "Ready",
      chart.diagnostics.length > 0 ? "warn" : "ready",
    );
  } catch (error) {
    const message = formatError(error);
    renderSvgError(message);
    facts.value = [{ label: "Pipeline error", value: message }];
    statuses.value = [{ label: "pipeline", value: message, tone: "error" }];
    chartSummary.value = {
      title: "Preview unavailable",
      artist: "Check the source and run the pipeline again",
      version: "No chart loaded",
      keyCount: 0,
      noteCount: 0,
      longNoteCount: 0,
      diagnosticCount: 1,
    };
    renderTime.value = "0.0 ms";
    setHealth("Error", "error");
  }
}

async function resetSource(): Promise<void> {
  source.value = sampleMap;
  await runPipeline();
  await nextTick();
  sourceInput.value?.focus();
}

function handleSourceKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void runPipeline();
  }
}

function summarizeChart(chart: ManiaChart): ChartSummary {
  return {
    title: chart.metadata.title ?? "Untitled",
    artist: chart.metadata.artist ?? "Unknown artist",
    version: chart.metadata.version ?? "Unknown version",
    keyCount: chart.keyCount,
    noteCount: chart.notes.length,
    longNoteCount: chart.notes.filter((note) => note.kind === "long").length,
    diagnosticCount: chart.diagnostics.length,
  };
}

function chartFacts(chart: ManiaChart): Fact[] {
  return [
    { label: "Title", value: chart.metadata.title ?? "Untitled" },
    { label: "Artist", value: chart.metadata.artist ?? "Unknown" },
    { label: "Version", value: chart.metadata.version ?? "Unknown" },
    { label: "Notes", value: String(chart.notes.length) },
    {
      label: "Long notes",
      value: String(chart.notes.filter((note) => note.kind === "long").length),
    },
    { label: "Lanes", value: String(chart.keyCount) },
    { label: "Diagnostics", value: String(chart.diagnostics.length) },
  ];
}

function statusItems(
  chart: ManiaChart,
  sourceObjectCount: number,
  parseDuration: number,
  normalizeDuration: number,
  renderDuration: number,
): StatusItem[] {
  const items: StatusItem[] = [
    { label: "parseOsu", value: `${parseDuration.toFixed(1)} ms`, tone: "ready" },
    {
      label: "toManiaChart",
      value: `${normalizeDuration.toFixed(1)} ms`,
      tone: chart.notes.length === sourceObjectCount ? "ready" : "warn",
      detail: `${chart.notes.length} normalized objects from ${sourceObjectCount} source rows`,
    },
    { label: "renderSvg", value: `${renderDuration.toFixed(1)} ms`, tone: "ready" },
  ];

  const firstDiagnostic = chart.diagnostics[0];
  if (!firstDiagnostic) {
    items.push({ label: "diagnostics", value: "none", tone: "muted" });
  } else {
    items.push({
      label: firstDiagnostic.code,
      value:
        chart.diagnostics.length === 1 ? "1 warning" : `${chart.diagnostics.length} warnings`,
      tone: firstDiagnostic.severity === "error" ? "error" : "warn",
      detail: firstDiagnostic.message,
    });
  }

  return items;
}

function mountSvg(markup: string): void {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const svg = parsed.querySelector("svg");
  if (!svg || parsed.querySelector("parsererror")) {
    throw new Error("renderSvg returned invalid SVG markup.");
  }

  const imported = document.importNode(svg, true);
  imported.classList.add("rendered-svg");
  getSvgOutput().replaceChildren(imported);
}

function renderSvgError(message: string): void {
  const element = document.createElement("div");
  element.className = "empty-state empty-state--error";
  element.textContent = message;
  getSvgOutput().replaceChildren(element);
}

function getSvgOutput(): HTMLDivElement {
  if (!svgOutput.value) {
    throw new Error("Missing SVG output mount point.");
  }
  return svgOutput.value;
}

function setHealth(text: string, tone: HealthTone): void {
  healthText.value = text;
  healthTone.value = tone;
}

function toggleStatus(index: number): void {
  expandedStatus.value = expandedStatus.value === index ? null : index;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <main id="main-content" class="bench has-active-workspace" tabindex="-1">
    <WorkspaceFrame
      v-model:mobile-panel="activeMobilePanel"
      class="inspect-workspace"
      layout-key="inspect"
      mode="inspect"
      :left="sourcePane"
      :right="detailsPane"
      @change-mode="emit('change-mode', $event)"
    >
      <template #toolbar>
        <div class="toolbar-identity toolbar-optional">
          <strong>{{ chartSummary.title }}</strong>
          <span>{{ chartSummary.version }}</span>
        </div>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <button
          class="tool-button tool-button--primary run-button"
          type="button"
          aria-keyshortcuts="Control+Enter Meta+Enter"
          title="Parse and render the source (Cmd/Ctrl+Enter)"
          @click="runPipeline"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path class="tool-icon-fill" d="M5 3.3v9.4L12.6 8z" />
          </svg>
          Run
          <kbd aria-hidden="true">⌘↵</kbd>
        </button>
      </template>

      <template #toolbar-end>
        <span class="health-status" :class="`health-status--${healthTone}`" aria-live="polite">
          <span class="health-dot" aria-hidden="true"></span>
          {{ healthText }}
        </span>
      </template>

      <template #left>
        <header class="pane-header">
          <h2 id="source-heading">Source</h2>
          <button class="tool-button reset-button" type="button" @click="resetSource">
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path d="M13 4.75V1.9m0 2.85h-2.85M12.55 8A5 5 0 1 1 11.1 4.45" />
            </svg>
            Reset
          </button>
        </header>
        <div class="editor-shell">
          <label class="sr-only" for="source-input">osu! beatmap source</label>
          <textarea
            id="source-input"
            ref="sourceInput"
            v-model="source"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            aria-describedby="source-help"
            @keydown="handleSourceKeydown"
          ></textarea>
        </div>
        <footer id="source-help" class="source-footer">
          <span>{{ sourceLineCount }} lines</span>
          <span class="keyboard-hint"><kbd>⌘ / Ctrl</kbd><kbd>↵</kbd> to run</span>
        </footer>
      </template>

      <template #main>
        <section class="inspect-view" aria-labelledby="preview-heading">
          <div class="stage-toolbar">
            <div class="stage-identity">
              <h1 id="preview-heading">{{ chartSummary.title }}</h1>
              <span>{{ chartSummary.artist }}</span>
              <span class="data">{{ chartSummary.version }}</span>
            </div>
            <dl class="metric-strip">
              <div><dt>Keys</dt><dd>{{ chartSummary.keyCount }}K</dd></div>
              <div><dt>Objects</dt><dd>{{ chartSummary.noteCount }}</dd></div>
              <div><dt>Holds</dt><dd>{{ chartSummary.longNoteCount }}</dd></div>
              <div><dt>Warnings</dt><dd>{{ chartSummary.diagnosticCount }}</dd></div>
            </dl>
          </div>
          <div class="preview-body" :aria-busy="healthText === 'Running'">
            <div class="preview-frame">
              <div ref="svgOutput" class="svg-output" aria-live="polite"></div>
            </div>
          </div>
        </section>
      </template>

      <template #right>
        <PanelSection id="inspect-facts" title="Chart facts">
          <dl class="compact-facts">
            <div v-for="fact in facts" :key="fact.label">
              <dt>{{ fact.label }}</dt>
              <dd>{{ fact.value }}</dd>
            </div>
          </dl>
        </PanelSection>

        <PanelSection id="inspect-pipeline" title="Pipeline">
          <div class="diagnostic-list">
            <template v-for="(item, index) in statuses" :key="`${item.label}-${index}`">
              <button
                v-if="item.detail"
                class="diagnostic has-detail"
                :class="[`diagnostic--${item.tone}`, { 'is-expanded': expandedStatus === index }]"
                type="button"
                :aria-expanded="expandedStatus === index"
                @click="toggleStatus(index)"
              >
                <div class="diagnostic-main">
                  <span class="diagnostic-dot" aria-hidden="true"></span>
                  <span class="diagnostic-label">{{ item.label }}</span>
                </div>
                <span class="diagnostic-result">
                  <span class="diagnostic-value">{{ item.value }}</span>
                  <svg class="diagnostic-chevron" aria-hidden="true" viewBox="0 0 12 12">
                    <path d="m3 4.5 3 3 3-3" />
                  </svg>
                </span>
                <p v-if="expandedStatus === index" class="diagnostic-detail">
                  {{ item.detail }}
                </p>
              </button>
              <div v-else class="diagnostic" :class="`diagnostic--${item.tone}`">
                <div class="diagnostic-main">
                  <span class="diagnostic-dot" aria-hidden="true"></span>
                  <span class="diagnostic-label">{{ item.label }}</span>
                </div>
                <span class="diagnostic-result">
                  <span class="diagnostic-value">{{ item.value }}</span>
                </span>
              </div>
            </template>
          </div>
        </PanelSection>
      </template>

      <template #status>
        <span class="status-item">Run <b>{{ runId.replace("run ", "") }}</b></span>
        <span class="status-item">renderSvg <b>{{ renderTime }}</b></span>
        <span class="status-item">Source <b>{{ sourceLineCount }} lines</b></span>
      </template>
    </WorkspaceFrame>
  </main>
</template>

<style scoped>
.inspect-view {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.metric-strip {
  display: flex;
  gap: 14px;
  margin: 0;
  font-size: var(--text-xs);
}

.metric-strip > div {
  display: flex;
  align-items: baseline;
  gap: 5px;
}

.metric-strip dt {
  color: var(--ink-muted);
}

.metric-strip dd {
  margin: 0;
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
}
</style>
