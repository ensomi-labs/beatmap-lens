<script setup lang="ts">
import {
  type ManiaChart,
  parseOsu,
  toManiaChart,
} from "beatmap-lens";
import { computed, nextTick, onMounted, ref } from "vue";
import { readTailShortenMs } from "./annotation/session-store";
import { renderStaticPreviewSvg } from "./static-preview";
import WorkspaceModeSwitch from "./WorkspaceModeSwitch.vue";
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

type MobilePanel = "source" | "preview" | "details";

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
const detailsVisible = ref(true);
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
  <main id="main-content" class="bench" tabindex="-1">
    <header class="app-bar">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true"></span>
        <div>
          <p class="brand-name">Beatmap Lens</p>
          <p class="brand-edition">Inspector</p>
        </div>
      </div>

      <div class="chart-context">
        <span class="chart-context-label">Current chart</span>
        <strong>{{ chartSummary.title }}</strong>
        <span aria-hidden="true">·</span>
        <span>{{ chartSummary.version }}</span>
      </div>

      <WorkspaceModeSwitch
        model-value="inspect"
        @update:model-value="emit('change-mode', $event)"
      />

      <div class="app-actions">
        <div class="run-state" aria-live="polite">
          <span class="health-status" :class="`health-status--${healthTone}`">
            <span class="health-dot" aria-hidden="true"></span>
            {{ healthText }}
          </span>
          <span class="run-id">{{ runId }}</span>
        </div>

        <button
          class="button button--quiet details-toggle"
          :class="{ 'is-active': detailsVisible }"
          type="button"
          :aria-expanded="detailsVisible"
          aria-controls="details-panel"
          :aria-label="detailsVisible ? 'Hide details' : 'Show details'"
          @click="detailsVisible = !detailsVisible"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16">
            <path d="M3 3.5h10M3 8h10M3 12.5h10" />
          </svg>
          Details
        </button>

        <button
          class="button button--primary run-button"
          type="button"
          aria-keyshortcuts="Control+Enter Meta+Enter"
          @click="runPipeline"
        >
          <svg class="play-icon" aria-hidden="true" viewBox="0 0 16 16">
            <path d="m5.25 3.4 7.1 4.1a.58.58 0 0 1 0 1l-7.1 4.1a.58.58 0 0 1-.87-.5V3.9a.58.58 0 0 1 .87-.5Z" />
          </svg>
          Run
          <span class="button-shortcut" aria-hidden="true">⌘↵</span>
        </button>
      </div>
    </header>

    <nav class="mobile-view-switcher" aria-label="Workspace views">
      <button
        v-for="panel in (['source', 'preview', 'details'] as const)"
        :key="panel"
        class="mobile-view-button"
        :class="{ 'is-active': activeMobilePanel === panel }"
        type="button"
        :aria-pressed="activeMobilePanel === panel"
        @click="activeMobilePanel = panel"
      >
        {{ panel }}
      </button>
    </nav>

    <div
      class="workspace-shell"
      :class="{ 'workspace-shell--details-hidden': !detailsVisible }"
    >
      <section
        class="workspace-column source-column"
        :class="{ 'is-mobile-active': activeMobilePanel === 'source' }"
        aria-labelledby="source-heading"
      >
        <header class="column-header source-header">
          <div class="section-heading">
            <span class="section-number">01</span>
            <div>
              <h2 id="source-heading">Source</h2>
              <p>osu!mania · source text</p>
            </div>
          </div>
          <button class="button button--quiet reset-button" type="button" @click="resetSource">
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
      </section>

      <section
        class="workspace-column preview-column"
        :class="{ 'is-mobile-active': activeMobilePanel === 'preview' }"
        aria-labelledby="preview-heading"
      >
        <header class="column-header preview-header">
          <div class="preview-title">
            <p class="section-kicker"><span class="section-number">02</span> Chart preview</p>
            <h1 id="preview-heading">{{ chartSummary.title }}</h1>
            <p class="chart-byline">
              <strong>{{ chartSummary.artist }}</strong>
              <span aria-hidden="true">·</span>
              {{ chartSummary.version }}
            </p>
          </div>
          <div class="render-timing">
            <span>renderSvg</span>
            <strong>{{ renderTime }}</strong>
          </div>
        </header>

        <div class="metric-rail">
          <div class="metric-item">
            <span>Keys</span>
            <strong>{{ chartSummary.keyCount }}K</strong>
          </div>
          <div class="metric-item">
            <span>Objects</span>
            <strong>{{ chartSummary.noteCount }}</strong>
          </div>
          <div class="metric-item">
            <span>Holds</span>
            <strong>{{ chartSummary.longNoteCount }}</strong>
          </div>
          <div class="metric-item">
            <span>Warnings</span>
            <strong>{{ chartSummary.diagnosticCount }}</strong>
          </div>
        </div>

        <div class="preview-body" :aria-busy="healthText === 'Running'">
          <div class="preview-frame">
            <div
              ref="svgOutput"
              class="svg-output"
              aria-live="polite"
            ></div>
          </div>
        </div>
      </section>

      <aside
        id="details-panel"
        class="workspace-column details-column"
        :class="{ 'is-mobile-active': activeMobilePanel === 'details' }"
        aria-labelledby="details-heading"
      >
        <header class="column-header details-header">
          <div class="section-heading">
            <span class="section-number">03</span>
            <div>
              <h2 id="details-heading">Details</h2>
              <p>Facts and pipeline</p>
            </div>
          </div>
        </header>

        <section class="details-section" aria-labelledby="facts-heading">
          <h3 id="facts-heading">Chart facts</h3>
          <dl class="facts-list">
            <div v-for="fact in facts" :key="fact.label" class="fact-item">
              <dt>{{ fact.label }}</dt>
              <dd>{{ fact.value }}</dd>
            </div>
          </dl>
        </section>

        <section class="details-section pipeline-section" aria-labelledby="diagnostic-heading">
          <h3 id="diagnostic-heading">Pipeline</h3>
          <div class="diagnostic-list">
            <template
              v-for="(item, index) in statuses"
              :key="`${item.label}-${index}`"
            >
              <button
                v-if="item.detail"
                class="diagnostic has-detail"
                :class="[
                  `diagnostic--${item.tone}`,
                  { 'is-expanded': expandedStatus === index },
                ]"
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
                  <svg
                    class="diagnostic-chevron"
                    aria-hidden="true"
                    viewBox="0 0 12 12"
                  >
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
        </section>
      </aside>
    </div>
  </main>
</template>
