<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { Mark } from "./timing/contracts";
import { nearestSample } from "./timing/format";
import { proposalColour } from "./timing/palette";
import {
  computeSpectrogram,
  cropSamples,
  level,
  nearestFrame,
  rowBins,
  type Spectrogram,
} from "./timing/spectrogram";
import {
  formatSourceTime,
  msDecimals,
  msToX,
  type TimeRange,
  type TimeView,
  tickStepMs,
  ticks,
  xToMs,
} from "./timing/time-view";
import { lowerBound, peak } from "./timing/waveform";

export interface StageProposal {
  key: string;
  colour_index: number;
  beats_ms: number[];
  visible: boolean;
}

const props = defineProps<{
  buffer: AudioBuffer;
  span: TimeRange;
  bounds: TimeRange;
  view: TimeView;
  proposals: StageProposal[];
  marks: Mark[];
  selectedId: string | null;
  playheadMs: number;
  loopRegion: TimeRange;
  looping: boolean;
}>();

const emit = defineEmits<{
  "update:view": [view: TimeView];
  resize: [widthPx: number, devicePixelRatio: number];
  place: [kind: Mark["kind"], timeMs: number];
  select: [id: string];
  seek: [timeMs: number];
  "loop-region": [region: TimeRange];
}>();

const stageBackground = "#101820";
const rulerHeight = 20;
const stripRowHeight = 6;
const marksHeight = 16;
const overviewHeight = 28;
/** A pointer that moves less than this (device pixels) clicks; more drags. */
const dragThreshold = 4;

const host = ref<HTMLDivElement>();
const base = ref<HTMLCanvasElement>();
const overlay = ref<HTMLCanvasElement>();
const size = ref({ width: 0, height: 0, dpr: 1 });
const spectrogram = shallowRef<Spectrogram>();
const hoverX = ref<number>();
const pendingLoop = ref<TimeRange>();

const sampleRate = computed(() => props.buffer.sampleRate);
const channels = computed(() =>
  Array.from({ length: props.buffer.numberOfChannels }, (_, index) =>
    props.buffer.getChannelData(index),
  ),
);
const stripRows = computed(() => Math.min(9, props.proposals.length));

/** Lane rectangles in CSS pixels, top to bottom. */
const lanes = computed(() => {
  const { height } = size.value;
  const stripHeight = stripRows.value * stripRowHeight + (stripRows.value ? 2 : 0);
  const flexible = Math.max(0, height - rulerHeight - stripHeight - marksHeight - overviewHeight);
  const waveHeight = Math.max(120, Math.round(flexible * 0.4));
  const spectrogramHeight = Math.max(0, flexible - waveHeight);
  let top = 0;
  const lane = (laneHeight: number) => {
    const result = { top, height: laneHeight };
    top += laneHeight;
    return result;
  };
  return {
    ruler: lane(rulerHeight),
    strip: lane(stripHeight),
    spectrogram: lane(spectrogramHeight),
    waveform: lane(waveHeight),
    marks: lane(marksHeight),
    overview: lane(overviewHeight),
  };
});

type LaneName = keyof typeof lanes.value;

function laneAt(y: number): LaneName {
  for (const [name, lane] of Object.entries(lanes.value) as [LaneName, { top: number; height: number }][])
    if (y >= lane.top && y < lane.top + lane.height) return name;
  return "overview";
}

const overviewView = computed<TimeView>(() => ({
  startMs: props.bounds.startMs,
  msPerPx: (props.bounds.endMs - props.bounds.startMs) / Math.max(1, size.value.width),
}));

/** Peak amplitude per overview device column, over all channels. */
const overviewEnvelope = computed(() => {
  const view = overviewView.value;
  const { dpr, width } = size.value;
  const rate = sampleRate.value;
  return Float32Array.from({ length: Math.round(width * dpr) }, (_, x) => {
    const from = Math.floor((xToMs(view, x / dpr) * rate) / 1000);
    const to = Math.floor((xToMs(view, (x + 1) / dpr) * rate) / 1000);
    let amplitude = 0;
    for (const data of channels.value) {
      const [min, max] = peak(data, from, Math.max(to, from + 1));
      amplitude = Math.max(amplitude, -min, max);
    }
    return amplitude;
  });
});

// Spectrogram: computed once per recording and bounds, in a worker.
let worker: Worker | undefined;
let generation = 0;

watch(
  () => [props.buffer, props.bounds.startMs, props.bounds.endMs] as const,
  () => {
    spectrogram.value = undefined;
    const request = ++generation;
    const crop = cropSamples(
      props.bounds.startMs,
      props.bounds.endMs,
      sampleRate.value,
      props.buffer.length,
    );
    const input = {
      channels: channels.value.map((data) => data.slice(crop.start, crop.end)),
      sliceStart: crop.start,
      totalFrames: props.buffer.length,
      sampleRate: sampleRate.value,
      startMs: props.bounds.startMs,
      endMs: props.bounds.endMs,
    };
    if (typeof Worker === "undefined") {
      spectrogram.value = computeSpectrogram(input);
      return;
    }
    worker ??= new Worker(new URL("./timing/spectrogram.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<Spectrogram>) => {
      if (request === generation) spectrogram.value = event.data;
    };
    worker.postMessage(
      input,
      input.channels.map((data) => data.buffer),
    );
  },
  { immediate: true },
);

let observer: ResizeObserver | undefined;
let baseFrame = 0;
let overlayFrame = 0;

onMounted(() => {
  observer = new ResizeObserver(() => resize());
  if (host.value) observer.observe(host.value);
  resize();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  worker?.terminate();
  cancelAnimationFrame(baseFrame);
  cancelAnimationFrame(overlayFrame);
});

function resize() {
  const element = host.value;
  if (!element) return;
  const dpr = window.devicePixelRatio || 1;
  const width = element.clientWidth;
  const height = element.clientHeight;
  size.value = { width, height, dpr };
  for (const canvas of [base.value, overlay.value]) {
    if (!canvas) continue;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  columnCache.clear();
  emit("resize", width, dpr);
  scheduleBase();
  scheduleOverlay();
}

watch(
  () => [
    props.view,
    props.proposals,
    props.marks,
    props.selectedId,
    props.loopRegion,
    props.looping,
    props.span,
    spectrogram.value,
  ],
  () => scheduleBase(),
);
watch(
  () => [props.playheadMs, hoverX.value, pendingLoop.value, props.view],
  () => scheduleOverlay(),
);
watch(spectrogram, () => columnCache.clear());

function scheduleBase() {
  cancelAnimationFrame(baseFrame);
  baseFrame = requestAnimationFrame(drawBase);
}

function scheduleOverlay() {
  cancelAnimationFrame(overlayFrame);
  overlayFrame = requestAnimationFrame(drawOverlay);
}

/** Device-pixel x of a time; rounding happens only where a line is drawn. */
function deviceX(timeMs: number, view = props.view): number {
  return msToX(view, timeMs) * size.value.dpr;
}

function crisp(x: number): number {
  return Math.round(x) + 0.5;
}

function drawBase() {
  const canvas = base.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;
  const { dpr } = size.value;
  const L = lanes.value;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = stageBackground;
  context.fillRect(0, 0, canvas.width, canvas.height);
  drawSpectrogram(context);
  drawWaveform(context);
  drawRuler(context);
  drawProposals(context);
  drawMarks(context);
  // Context outside the passage: visible and audible, but marks cannot be placed there.
  context.fillStyle = "rgba(0, 0, 0, 0.5)";
  const shadeTop = L.strip.top * dpr;
  const shadeHeight = (L.marks.top + L.marks.height - L.strip.top) * dpr;
  const left = deviceX(props.span.startMs);
  const right = deviceX(props.span.endMs);
  if (left > 0) context.fillRect(0, shadeTop, Math.min(left, canvas.width), shadeHeight);
  if (right < canvas.width) context.fillRect(Math.max(0, right), shadeTop, canvas.width, shadeHeight);
  drawOverview(context);
}

const greyLut = (() => {
  const from = [16, 24, 32];
  const to = [179, 179, 179];
  return Array.from({ length: 256 }, (_, index) =>
    from.map((value, channel) => Math.round(value + ((to[channel] as number) - value) * (index / 255))),
  );
})();
const columnCache = new Map<number, Uint8Array>();

/** Each device column shows the frame whose centre is nearest its time; no raster is stretched. */
function drawSpectrogram(context: CanvasRenderingContext2D) {
  const data = spectrogram.value;
  const lane = lanes.value.spectrogram;
  const { dpr } = size.value;
  const width = Math.round(size.value.width * dpr);
  const rows = Math.round(lane.height * dpr);
  if (!data || rows <= 0 || width <= 0) return;
  const binsForRows = rowBins(rows, data.sampleRate);
  const image = context.createImageData(width, rows);
  const pixels = image.data;
  for (let x = 0; x < width; x++) {
    const timeMs = xToMs(props.view, (x + 0.5) / dpr);
    const frame = nearestFrame(timeMs, data.sampleRate);
    const index = frame - data.firstFrame;
    if (index < 0 || index >= data.frameCount) continue;
    let column = columnCache.get(frame);
    if (!column) {
      column = new Uint8Array(rows);
      const offset = index * data.bins;
      for (let row = 0; row < rows; row++) {
        const { lo, hi } = binsForRows[row] as { lo: number; hi: number };
        let db = Number.NEGATIVE_INFINITY;
        for (let bin = lo; bin <= hi; bin++) db = Math.max(db, data.db[offset + bin] ?? -200);
        column[row] = Math.round(level(db) * 255);
      }
      columnCache.set(frame, column);
    }
    for (let row = 0; row < rows; row++) {
      const colour = greyLut[column[row] as number] as number[];
      const at = (row * width + x) * 4;
      pixels[at] = colour[0] as number;
      pixels[at + 1] = colour[1] as number;
      pixels[at + 2] = colour[2] as number;
      pixels[at + 3] = 255;
    }
  }
  context.putImageData(image, 0, Math.round(lane.top * dpr));
}

/** Peaks per device column at coarse zoom, the sample polyline when fine, dots below a pixel. */
function drawWaveform(context: CanvasRenderingContext2D) {
  const lane = lanes.value.waveform;
  const { dpr } = size.value;
  const width = Math.round(size.value.width * dpr);
  const top = lane.top * dpr;
  const height = lane.height * dpr;
  const middle = top + height / 2;
  const scale = (height / 2) * 0.96;
  const rate = sampleRate.value;
  const samplesPerPx = (props.view.msPerPx / dpr) * (rate / 1000);
  context.save();
  context.beginPath();
  context.rect(0, top, width, height);
  context.clip();
  context.fillStyle = "rgba(255, 255, 255, 0.08)";
  context.fillRect(0, Math.round(middle), width, 1);
  const colours = ["rgba(226, 232, 240, 0.8)", "rgba(148, 160, 178, 0.8)"];
  // Right first, so the lighter left channel reads on top; both stay visible.
  [...channels.value.keys()].reverse().forEach((channel) => {
    const data = channels.value[channel] as Float32Array;
    const colour = colours[Math.min(channel, 1)] as string;
    context.fillStyle = colour;
    context.strokeStyle = colour;
    if (samplesPerPx > 4) {
      for (let x = 0; x < width; x++) {
        const from = Math.floor((xToMs(props.view, x / dpr) * rate) / 1000);
        const to = Math.floor((xToMs(props.view, (x + 1) / dpr) * rate) / 1000);
        const [min, max] = peak(data, from, Math.max(to, from + 1));
        const y0 = middle - max * scale;
        const y1 = middle - min * scale;
        context.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
      return;
    }
    const first = Math.max(0, Math.floor((props.view.startMs * rate) / 1000) - 1);
    const last = Math.min(
      data.length - 1,
      Math.ceil((xToMs(props.view, size.value.width) * rate) / 1000) + 1,
    );
    context.lineWidth = Math.max(1, dpr * 0.75);
    context.beginPath();
    for (let sample = first; sample <= last; sample++) {
      const x = deviceX((sample * 1000) / rate);
      const y = middle - (data[sample] as number) * scale;
      if (sample === first) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
    if (samplesPerPx < 1) {
      const radius = Math.max(1.5, dpr * 1.25);
      for (let sample = first; sample <= last; sample++) {
        const x = deviceX((sample * 1000) / rate);
        const y = middle - (data[sample] as number) * scale;
        context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
    }
  });
  context.restore();
}

function drawRuler(context: CanvasRenderingContext2D) {
  const lane = lanes.value.ruler;
  const { dpr, width } = size.value;
  context.fillStyle = "#0b1117";
  context.fillRect(0, lane.top * dpr, width * dpr, lane.height * dpr);
  // The loop region, brighter while looping.
  const loopLeft = deviceX(props.loopRegion.startMs);
  const loopRight = deviceX(props.loopRegion.endMs);
  context.fillStyle = props.looping ? "rgba(255, 255, 255, 0.24)" : "rgba(255, 255, 255, 0.08)";
  context.fillRect(loopLeft, lane.top * dpr, loopRight - loopLeft, lane.height * dpr);
  const step = tickStepMs(props.view.msPerPx, 96);
  const minor = step / 5;
  const range = { startMs: props.view.startMs, endMs: xToMs(props.view, width) };
  context.fillStyle = "rgba(255, 255, 255, 0.28)";
  for (const tick of ticks(range, minor))
    context.fillRect(Math.round(deviceX(tick)), (lane.top + lane.height - 4) * dpr, 1, 4 * dpr);
  context.fillStyle = "rgba(255, 255, 255, 0.72)";
  context.font = `${10 * dpr}px "Azeret Mono Variable", ui-monospace, monospace`;
  context.textBaseline = "top";
  const digits = Math.max(0, msDecimals(step));
  for (const tick of ticks(range, step)) {
    const x = Math.round(deviceX(tick));
    context.fillRect(x, (lane.top + lane.height - 9) * dpr, 1, 9 * dpr);
    context.fillText(formatSourceTime(tick, digits), x + 3 * dpr, (lane.top + 3) * dpr);
  }
}

function visibleBeats(beats: number[], view = props.view) {
  const from = lowerBound(beats, view.startMs);
  const to = lowerBound(beats, xToMs(view, size.value.width));
  return beats.slice(from, to);
}

/**
 * Each proposal has its own strip row; its bars cross the spectrogram and waveform at their true
 * x, so coincident bars overlap rather than being displaced. Dense bars become a shade.
 */
function drawProposals(context: CanvasRenderingContext2D) {
  const L = lanes.value;
  const { dpr } = size.value;
  const lineTop = L.spectrogram.top * dpr;
  const lineHeight = (L.spectrogram.height + L.waveform.height) * dpr;
  props.proposals.forEach((proposal, row) => {
    if (!proposal.visible || row >= 9) return;
    const { colour } = proposalColour(proposal.colour_index);
    const beats = visibleBeats(proposal.beats_ms);
    if (!beats.length) return;
    const rowTop = (L.strip.top + 1 + row * stripRowHeight) * dpr;
    const rowHeight = (stripRowHeight - 1) * dpr;
    const first = deviceX(beats[0] as number);
    const last = deviceX(beats.at(-1) as number);
    const dense = beats.length > 1 && (last - first) / (beats.length - 1) < 3;
    context.fillStyle = colour;
    if (dense) {
      context.globalAlpha = 0.55;
      context.fillRect(first, rowTop, Math.max(1, last - first), rowHeight);
      context.globalAlpha = 0.1;
      context.fillRect(first, lineTop, Math.max(1, last - first), lineHeight);
      context.globalAlpha = 1;
      return;
    }
    for (const beat of beats) {
      const x = Math.round(deviceX(beat));
      context.globalAlpha = 1;
      context.fillRect(x - dpr, rowTop, 2 * dpr + 1, rowHeight);
      context.globalAlpha = 0.85;
      context.fillRect(x, lineTop, 1, lineHeight);
    }
    context.globalAlpha = 1;
  });
}

function drawMarks(context: CanvasRenderingContext2D) {
  const L = lanes.value;
  const { dpr } = size.value;
  const lineTop = L.spectrogram.top * dpr;
  const lineHeight = (L.spectrogram.height + L.waveform.height) * dpr;
  const glyphY = (L.marks.top + L.marks.height / 2) * dpr;
  const marks = props.marks.filter(
    (mark) => mark.time_ms >= props.view.startMs && mark.time_ms <= xToMs(props.view, size.value.width),
  );
  let groupX = Number.NEGATIVE_INFINITY;
  let groupCount = 0;
  const badge = () => {
    if (groupCount < 2) return;
    context.fillStyle = "#fff";
    context.font = `${9 * dpr}px "Azeret Mono Variable", ui-monospace, monospace`;
    context.textBaseline = "middle";
    context.fillText(String(groupCount), groupX + 7 * dpr, glyphY);
  };
  for (const mark of marks) {
    const selected = mark.id === props.selectedId;
    const x = crisp(deviceX(mark.time_ms));
    context.strokeStyle = selected ? "#8fb3ff" : "#ffffff";
    context.lineWidth = selected ? 2 * dpr : Math.max(1, dpr);
    context.setLineDash(mark.kind === "unbeat" ? [4 * dpr, 3 * dpr] : []);
    context.beginPath();
    context.moveTo(x, lineTop);
    context.lineTo(x, lineTop + lineHeight);
    context.stroke();
    context.setLineDash([]);
    if (x - groupX < dragThreshold * dpr) {
      groupCount++;
      continue;
    }
    badge();
    groupX = x;
    groupCount = 1;
    const r = 5 * dpr;
    context.fillStyle = selected ? "#8fb3ff" : "#ffffff";
    context.strokeStyle = context.fillStyle;
    context.lineWidth = 1.5 * dpr;
    if (mark.kind === "beat") {
      context.beginPath();
      context.moveTo(x - r, glyphY - r * 0.8);
      context.lineTo(x + r, glyphY - r * 0.8);
      context.lineTo(x, glyphY + r * 0.8);
      context.closePath();
      context.fill();
    } else {
      context.beginPath();
      context.arc(x, glyphY, r * 0.8, 0, Math.PI * 2);
      context.moveTo(x - r * 0.55, glyphY + r * 0.55);
      context.lineTo(x + r * 0.55, glyphY - r * 0.55);
      context.stroke();
    }
  }
  badge();
}

/** The whole bounds as a peak envelope, with the passage and the current view. */
function drawOverview(context: CanvasRenderingContext2D) {
  const lane = lanes.value.overview;
  const { dpr, width } = size.value;
  const top = lane.top * dpr;
  const height = lane.height * dpr;
  context.fillStyle = "#0b1117";
  context.fillRect(0, top, width * dpr, height);
  const view = overviewView.value;
  const columns = Math.round(width * dpr);
  context.fillStyle = "rgba(200, 210, 222, 0.55)";
  overviewEnvelope.value.forEach((amplitude, x) => {
    const h = Math.min(1, amplitude) * (height - 4);
    context.fillRect(x, top + height - 2 - h, 1, h);
  });
  const spanLeft = deviceX(props.span.startMs, view);
  const spanRight = deviceX(props.span.endMs, view);
  context.fillStyle = "rgba(0, 0, 0, 0.45)";
  context.fillRect(0, top, spanLeft, height);
  context.fillRect(spanRight, top, columns - spanRight, height);
  const viewLeft = deviceX(props.view.startMs, view);
  const viewRight = deviceX(xToMs(props.view, width), view);
  context.strokeStyle = "rgba(255, 255, 255, 0.85)";
  context.lineWidth = dpr;
  context.strokeRect(crisp(viewLeft), top + 1, Math.max(2, viewRight - viewLeft), height - 2);
}

function drawOverlay() {
  const canvas = overlay.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;
  const { dpr, width } = size.value;
  const L = lanes.value;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (pendingLoop.value) {
    const left = deviceX(pendingLoop.value.startMs);
    const right = deviceX(pendingLoop.value.endMs);
    context.fillStyle = "rgba(255, 255, 255, 0.12)";
    context.fillRect(Math.min(left, right), 0, Math.abs(right - left), L.overview.top * dpr);
  }
  if (hoverX.value !== undefined) {
    const timeMs = xToMs(props.view, hoverX.value);
    const x = crisp(hoverX.value * dpr);
    context.fillStyle = "rgba(255, 255, 255, 0.35)";
    context.fillRect(x - 0.5, L.strip.top * dpr, 1, (L.overview.top - L.strip.top) * dpr);
    const digits = props.view.msPerPx < 0.1 ? 2 : props.view.msPerPx < 1 ? 1 : 0;
    let label = formatSourceTime(timeMs, digits);
    if (props.view.msPerPx < 1) label += ` · n ${nearestSample(timeMs, sampleRate.value)}`;
    context.font = `${10 * dpr}px "Azeret Mono Variable", ui-monospace, monospace`;
    context.textBaseline = "top";
    const textWidth = context.measureText(label).width;
    const textX = Math.min(x + 6 * dpr, width * dpr - textWidth - 6 * dpr);
    const textY = (L.spectrogram.top + 4) * dpr;
    context.fillStyle = "rgba(11, 17, 23, 0.85)";
    context.fillRect(textX - 3 * dpr, textY - 2 * dpr, textWidth + 6 * dpr, 14 * dpr);
    context.fillStyle = "#fff";
    context.fillText(label, textX, textY);
  }
  const playX = crisp(deviceX(props.playheadMs));
  context.fillStyle = "#ff4d4f";
  context.fillRect(playX - dpr, 0, 2 * dpr, L.overview.top * dpr);
  const overviewX = crisp(deviceX(props.playheadMs, overviewView.value));
  context.fillRect(overviewX - dpr, L.overview.top * dpr, 2 * dpr, L.overview.height * dpr);
}

// Pointer: a press that moves beyond the threshold drags (pan, loop selection, overview jump);
// otherwise it clicks (seek on the ruler and overview, select or place on the lanes).
let press:
  | { x: number; y: number; lane: LaneName; button: number; shift: boolean; view: TimeView; dragging: boolean }
  | undefined;

function localPoint(event: PointerEvent | WheelEvent | MouseEvent) {
  const rect = overlay.value?.getBoundingClientRect();
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
}

function onPointerDown(event: PointerEvent) {
  const { x, y } = localPoint(event);
  press = {
    x,
    y,
    lane: laneAt(y),
    button: event.button,
    shift: event.shiftKey,
    view: props.view,
    dragging: false,
  };
  overlay.value?.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
  const { x } = localPoint(event);
  hoverX.value = x;
  if (!press) return;
  const dx = x - press.x;
  if (!press.dragging && Math.abs(dx) * size.value.dpr < dragThreshold) return;
  press.dragging = true;
  if (press.lane === "overview") {
    jumpTo(xToMs(overviewView.value, x));
  } else if (press.shift) {
    pendingLoop.value = {
      startMs: Math.min(xToMs(press.view, press.x), xToMs(press.view, x)),
      endMs: Math.max(xToMs(press.view, press.x), xToMs(press.view, x)),
    };
  } else {
    emit("update:view", { startMs: press.view.startMs - dx * press.view.msPerPx, msPerPx: press.view.msPerPx });
  }
}

function onPointerUp(event: PointerEvent) {
  const current = press;
  press = undefined;
  if (!current) return;
  if (current.dragging) {
    if (pendingLoop.value) emit("loop-region", pendingLoop.value);
    pendingLoop.value = undefined;
    return;
  }
  const { x } = localPoint(event);
  if (current.lane === "overview") {
    const timeMs = xToMs(overviewView.value, x);
    jumpTo(timeMs);
    emit("seek", timeMs);
    return;
  }
  const timeMs = xToMs(props.view, x);
  if (current.lane === "ruler" || current.lane === "strip") {
    emit("seek", timeMs);
    return;
  }
  const toleranceMs = (dragThreshold / size.value.dpr) * props.view.msPerPx;
  let near: Mark | undefined;
  for (const mark of props.marks) {
    const distance = Math.abs(mark.time_ms - timeMs);
    if (distance <= toleranceMs && (!near || distance < Math.abs(near.time_ms - timeMs))) near = mark;
  }
  if (near) emit("select", near.id);
  else if (timeMs < props.span.startMs || timeMs > props.span.endMs) emit("seek", timeMs);
  else emit("place", current.button === 2 ? "unbeat" : "beat", timeMs);
}

function onPointerCancel() {
  press = undefined;
  pendingLoop.value = undefined;
}

/** Centres the view on a time picked in the overview. */
function jumpTo(timeMs: number) {
  emit("update:view", {
    startMs: timeMs - (size.value.width / 2) * props.view.msPerPx,
    msPerPx: props.view.msPerPx,
  });
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.value.width : 1;
  if (event.ctrlKey) {
    const anchorMs = xToMs(props.view, localPoint(event).x);
    const factor = Math.exp(event.deltaY * unit * 0.01);
    emit("update:view", {
      startMs: anchorMs - (anchorMs - props.view.startMs) * factor,
      msPerPx: props.view.msPerPx * factor,
    });
    return;
  }
  const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit;
  emit("update:view", {
    startMs: props.view.startMs + delta * props.view.msPerPx,
    msPerPx: props.view.msPerPx,
  });
}

/** Cancels a loop-region drag; returns whether one was in progress. */
function cancelDrag(): boolean {
  const active = Boolean(press?.dragging);
  press = undefined;
  pendingLoop.value = undefined;
  return active;
}

defineExpose({ cancelDrag });
</script>

<template>
  <div ref="host" class="timing-stage">
    <canvas ref="base" class="timing-stage-canvas" aria-hidden="true"></canvas>
    <canvas
      ref="overlay"
      class="timing-stage-canvas timing-stage-overlay"
      role="img"
      aria-label="Spectrogram and waveform; click places a beat, right-click an unbeat"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @pointerleave="hoverX = undefined"
      @wheel="onWheel"
      @contextmenu.prevent
    ></canvas>
    <p v-if="!spectrogram" class="timing-stage-note">Computing spectrogram</p>
  </div>
</template>

<style scoped>
.timing-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background: #101820;
}

.timing-stage-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.timing-stage-overlay {
  cursor: crosshair;
  touch-action: none;
}

.timing-stage-note {
  position: absolute;
  top: 28px;
  right: 12px;
  margin: 0;
  color: oklch(80% 0.01 255);
  font-family: var(--font-data);
  font-size: 0.55rem;
  pointer-events: none;
}
</style>
