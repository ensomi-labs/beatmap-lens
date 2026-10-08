<script setup lang="ts">
import { type ManiaChart, projectTime } from "beatmap-lens";
import { computed } from "vue";
import { BufferedSceneController, judgmentLineRatio } from "./annotation/buffered-scene";
import type { AudioEnvelope } from "./compare/audio-envelope";

const props = defineProps<{
  charts: [ManiaChart, ManiaChart];
  envelope?: AudioEnvelope;
  playhead: number;
  speed: number;
  view: "A" | "B" | "both";
}>();

const height = 600;
const width = 320;
const controllers = computed(() => props.charts.map((chart) => new BufferedSceneController(chart, { width, viewportHeight: height, pixelsPerSecond: props.speed })));
const frames = computed(() => controllers.value.map((controller) => controller.frame(props.playhead)));
const visible = computed(() => props.view === "both" ? [0, 1] : [props.view === "A" ? 0 : 1]);
const lineY = height * judgmentLineRatio;
const envelopePoints = computed(() => {
  const projection = frames.value[0]?.scene.projection;
  if (!props.envelope || !projection) return [];
  const playheadY = projectTime(projection, props.playhead);
  const { step_ms, energy, onset } = props.envelope;
  const start = Math.max(0, Math.floor((props.playhead - (height - lineY) / props.speed * 1000) / step_ms));
  const end = Math.min(energy.length, Math.ceil((props.playhead + lineY / props.speed * 1000) / step_ms));
  return Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
    const i = start + offset;
    return { y: lineY + projectTime(projection, (i + 0.5) * step_ms) - playheadY, energy: energy[i] as number, onset: onset[i] as number };
  });
});
const energyPath = computed(() => envelopePoints.value.map((point, i) => `${i ? "L" : "M"}${8 + point.energy * 44},${point.y}`).join(" "));
const onsetPath = computed(() => envelopePoints.value.map((point, i) => `${i ? "L" : "M"}${66 + point.onset * 24},${point.y}`).join(" "));
</script>

<template>
  <div class="compare-stage" :class="{ 'is-single': view !== 'both' }">
    <section v-for="index in visible" :key="index" class="compare-chart" :aria-label="`Chart ${index === 0 ? 'A' : 'B'}`">
      <span class="compare-chart-label">{{ index === 0 ? 'A' : 'B' }}</span>
      <svg v-if="frames[index]" :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" role="img" :aria-label="`Falling notes for ${index === 0 ? 'A' : 'B'}`">
        <title>{{ index === 0 ? 'A' : 'B' }} · notes meet the horizontal playhead line</title>
        <rect width="100%" height="100%" fill="#10141e" />
        <rect v-for="entry in frames[index]?.keyedLanes" :key="entry.key" :x="entry.lane.x" y="0" :width="entry.lane.width" :height="height" :fill="entry.lane.fill" :stroke="entry.lane.stroke" />
        <g :transform="frames[index]?.noteGroupTransform">
          <rect v-for="entry in frames[index]?.keyedNotes" :key="entry.key" :x="entry.glyph.x" :y="entry.glyph.y" :width="entry.glyph.width" :height="entry.glyph.height" :rx="entry.glyph.radius" :fill="entry.glyph.fill" :stroke="entry.glyph.stroke" />
        </g>
        <line x1="0" :x2="width" :y1="lineY" :y2="lineY" stroke="#fff" stroke-opacity=".6" />
      </svg>
    </section>
    <section class="compare-energy" aria-label="Audio energy and onset strip aligned with notes">
      <span class="compare-energy-label">Energy · Rise</span>
      <svg viewBox="0 0 100 600" preserveAspectRatio="none" role="img" aria-label="Audio energy in white and onset energy rises in blue; time aligns with the notes">
        <title>RMS energy and onset energy rises on the same time scale as the charts</title>
        <rect width="100" height="600" fill="#161c29" />
        <path :d="energyPath" fill="none" stroke="#c8d1e2" stroke-width="1.5" />
        <path :d="onsetPath" fill="none" stroke="#769fff" stroke-width="1.5" />
        <line x1="0" x2="100" :y1="lineY" :y2="lineY" stroke="#fff" stroke-opacity=".6" />
      </svg>
    </section>
  </div>
</template>

<style scoped>
.compare-stage { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 100px; height: min(65vh, 680px); min-height: 340px; gap: 1px; overflow: hidden; border-radius: 14px; background: #303744; }
.compare-stage.is-single { grid-template-columns: minmax(0, 1fr) 100px; }
.compare-chart, .compare-energy { position: relative; min-width: 0; }
svg { display: block; width: 100%; height: 100%; }
.compare-chart-label, .compare-energy-label { position: absolute; top: 14px; left: 14px; color: #edf1fa; background: #161c29; padding: 6px 8px; border-radius: 6px; font: 600 14px var(--font-data); }
.compare-energy-label { left: 4px; font: 500 10px var(--font-data); padding: 6px 3px; }
@media (max-width: 600px) { .compare-stage { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 80px; } .compare-stage.is-single { grid-template-columns: minmax(0, 1fr) 80px; } .compare-energy-label { font-size: 8px; } }
</style>
