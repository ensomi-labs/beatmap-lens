<script setup lang="ts">
import { type ManiaChart, projectTime } from "beatmap-lens";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { BufferedSceneController, judgmentLineRatio } from "./annotation/buffered-scene";
import { formatTimelineRangeTime as formatTime } from "./annotation/timeline-range";
import type { AudioEnvelope } from "./compare/audio-envelope";

const props = defineProps<{
  charts: [ManiaChart, ManiaChart];
  envelope?: AudioEnvelope;
  playheadMs: number;
  /** Chart indexes to draw, in A, B order. */
  shown: readonly (0 | 1)[];
  visualSpeed: number;
}>();

const labels = ["A", "B"] as const;
const stage = ref<HTMLElement>();
const size = ref({ width: 0, height: 0 });
let observer: ResizeObserver | undefined;

// Panes share one size; it changes with the stage and with the number of panes shown.
function measure() {
  const pane = stage.value?.querySelector(".compare-pane");
  if (pane) size.value = { width: pane.clientWidth, height: pane.clientHeight };
}
onMounted(() => {
  observer = new ResizeObserver(measure);
  if (stage.value) observer.observe(stage.value);
});
onBeforeUnmount(() => observer?.disconnect());
watch(
  () => props.shown.length,
  () => nextTick(measure),
);

const lineY = computed(() => size.value.height * judgmentLineRatio);
const controllers = computed(() =>
  size.value.width > 0
    ? props.charts.map(
        (chart) =>
          new BufferedSceneController(chart, {
            width: size.value.width,
            viewportHeight: size.value.height,
            pixelsPerSecond: props.visualSpeed,
          }),
      )
    : [],
);
const frames = computed(() =>
  controllers.value.map((controller) => controller.frame(props.playheadMs)),
);

/** Energy and onset rise on the notes' own time axis, so a peak meets the line with its notes. */
const envelopePaths = computed(() => {
  const projection = frames.value[0]?.scene.projection;
  if (!props.envelope || !projection) return { energy: "", onset: "" };
  const { step_ms, energy, onset } = props.envelope;
  const msPerPixel = 1000 / props.visualSpeed;
  const pastMs = (size.value.height - lineY.value) * msPerPixel;
  const first = Math.max(0, Math.floor((props.playheadMs - pastMs) / step_ms));
  const last = Math.min(
    energy.length,
    Math.ceil((props.playheadMs + lineY.value * msPerPixel) / step_ms),
  );
  const playheadY = projectTime(projection, props.playheadMs);
  let energyPath = "";
  let onsetPath = "";
  for (let i = first; i < last; i++) {
    const y = lineY.value + projectTime(projection, (i + 0.5) * step_ms) - playheadY;
    const command = i === first ? "M" : "L";
    energyPath += `${command}${4 + (energy[i] ?? 0) * 52},${y}`;
    onsetPath += `${command}${62 + (onset[i] ?? 0) * 34},${y}`;
  }
  return { energy: energyPath, onset: onsetPath };
});
</script>

<template>
  <div ref="stage" class="compare-stage" :style="{ '--panes': shown.length }">
    <section
      v-for="index in shown"
      :key="index"
      class="compare-pane"
      :aria-label="`Chart ${labels[index]}`"
    >
      <svg
        v-if="frames[index]"
        :viewBox="`0 0 ${size.width} ${size.height}`"
        role="img"
      >
        <title>Falling notes of chart {{ labels[index] }}</title>
        <g class="viewport-lanes">
          <rect
            v-for="entry in frames[index]?.keyedLanes"
            :key="entry.key"
            :x="entry.lane.x"
            y="0"
            :width="entry.lane.width"
            :height="size.height"
            :fill="entry.lane.fill"
            :stroke="entry.lane.stroke"
          />
        </g>
        <g class="moving-note-group" :transform="frames[index]?.noteGroupTransform">
          <rect
            v-for="entry in frames[index]?.keyedNotes"
            :key="entry.key"
            :x="entry.glyph.x"
            :y="entry.glyph.y"
            :width="entry.glyph.width"
            :height="entry.glyph.height"
            :rx="entry.glyph.radius"
            :fill="entry.glyph.fill"
            :stroke="entry.glyph.stroke"
          />
        </g>
        <g class="judgment-guide">
          <line x1="0" :y1="lineY" :x2="size.width" :y2="lineY" />
        </g>
      </svg>
      <span class="compare-chip compare-chip--label">{{ labels[index] }}</span>
    </section>

    <section class="compare-envelope" aria-label="Audio energy, aligned with the notes">
      <svg :viewBox="`0 0 100 ${size.height || 1}`" preserveAspectRatio="none" aria-hidden="true">
        <path class="compare-energy" :d="envelopePaths.energy" />
        <path class="compare-onset" :d="envelopePaths.onset" />
        <line class="compare-line" x1="0" :y1="lineY" x2="100" :y2="lineY" />
      </svg>
      <span class="compare-chip compare-chip--legend">
        <span class="compare-key compare-key--energy">Energy</span>
        <span class="compare-key compare-key--onset">Rise</span>
      </span>
    </section>

    <span class="compare-chip compare-chip--time">{{ formatTime(playheadMs) }}</span>
  </div>
</template>

<style scoped>
.compare-stage {
  position: relative;
  display: grid;
  flex: 1;
  grid-template-columns: repeat(var(--panes), minmax(0, 1fr)) 76px;
  gap: 1px;
  min-height: 0;
  background: rgb(255 255 255 / 0.1);
}

.compare-pane,
.compare-envelope {
  position: relative;
  min-width: 0;
  min-height: 0;
  background: #101820;
}

.compare-envelope {
  background: #0c131a;
}

svg {
  display: block;
  width: 100%;
  height: 100%;
}

.compare-energy,
.compare-onset,
.compare-line {
  fill: none;
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

.compare-energy {
  stroke: #c8d1e2;
}

.compare-onset {
  stroke: #769fff;
}

.compare-line {
  stroke: #f7fbff;
  stroke-dasharray: 12 5 2 5;
  stroke-width: 2;
}

.compare-chip {
  position: absolute;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  color: rgb(231 240 248 / 0.86);
  border: 1px solid rgb(255 255 255 / 0.11);
  border-radius: 8px;
  background: rgb(10 17 24 / 0.86);
  font-family: var(--font-data);
  font-size: 0.56rem;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  white-space: nowrap;
}

.compare-chip--label {
  top: 10px;
  left: 10px;
  min-width: 28px;
  justify-content: center;
  font-size: 0.72rem;
  font-weight: 650;
}

.compare-chip--time {
  top: 10px;
  right: 86px;
}

.compare-chip--legend {
  bottom: 10px;
  left: 50%;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  transform: translateX(-50%);
}

.compare-key::before {
  display: inline-block;
  width: 8px;
  height: 2px;
  margin-right: 5px;
  vertical-align: middle;
  content: "";
}

.compare-key--energy::before {
  background: #c8d1e2;
}

.compare-key--onset::before {
  background: #769fff;
}

@media (max-width: 920px) {
  .compare-stage {
    grid-template-columns: repeat(var(--panes), minmax(0, 1fr)) 56px;
  }

  .compare-chip--time {
    right: 66px;
  }

  .compare-chip--label {
    top: max(64px, calc(env(safe-area-inset-top) + 56px));
  }

  .compare-chip--legend {
    padding: 5px;
    font-size: 0.48rem;
  }
}
</style>
