<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { formatTimelineRangeTime as formatTime } from "./annotation/timeline-range";
import { timingJson } from "./timing/client";
import type { BlindPassage, OpenTiming } from "./timing/contracts";
import WorkspaceModeSwitch from "./WorkspaceModeSwitch.vue";
import type { WorkspaceMode } from "./workspace-mode";

const emit = defineEmits<{ "change-mode": [mode: WorkspaceMode] }>();

const rememberedSession = "lens-timing-session";

const sessionPath = ref(
  new URLSearchParams(window.location.search).get("session") ?? remembered(rememberedSession) ?? "",
);
const opened = shallowRef<OpenTiming>();
const blind = shallowRef<BlindPassage>();
const passageIndex = ref(0);
const busy = ref(false);
const error = ref("");
let disposed = false;

const passage = computed(() => opened.value?.passages[passageIndex.value]);
const marksFile = computed(() => opened.value?.marks_path.split(/[\\/]/).at(-1));

onBeforeUnmount(() => {
  disposed = true;
});

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
    blind.value = result;
  } catch (cause) {
    report(cause);
  } finally {
    busy.value = false;
  }
}

function close() {
  opened.value = undefined;
  blind.value = undefined;
  error.value = "";
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

      <aside class="annotation-rail annotation-details-rail" aria-label="Details"></aside>
    </div>
  </main>
</template>
