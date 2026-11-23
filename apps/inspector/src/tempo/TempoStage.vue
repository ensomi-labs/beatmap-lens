<script setup lang="ts">
import type {
  Beat,
  GridFitItem,
  Range,
  Segment,
  SnapCandidate,
  SoundAnchor,
  Span,
  UnbeatCue,
} from "ensomi";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { PlayheadMotion } from "../stage-audio/display";
import { createTimeViewEdgeAutoScroller } from "../stage-audio/edge-auto-scroll";
import { PlayheadLayer } from "../stage-audio/playhead-layer";
import {
  computeSpectrogram,
  createSpectrogramWorker,
  cropSamples,
  hop,
  level,
  nearestFrame,
  rowBins,
  type Spectrogram,
  type SpectrogramWorkerRequest,
  type SpectrogramWorkerResponse,
} from "../stage-audio/spectrogram";
import {
  formatSourceTime,
  lineLeft,
  msDecimals,
  msToX,
  nearestSample,
  type TimeRange,
  type TimeView,
  tickStepMs,
  ticks,
  xToMs,
} from "../stage-audio/time-view";
import { peak } from "../stage-audio/waveform";
import {
  formatSignedMs,
  type OfferBeatPreview,
  SNAP_ROLE_LABELS,
  type StageVisualMode,
  type TempoSelection,
} from "./state";

export type LocatePhase = "move" | "end" | "cancel";

const props = defineProps<{
  buffer: AudioBuffer;
  sourceSampleRate?: number;
  bounds: TimeRange;
  view: TimeView;
  visualMode: StageVisualMode;
  segments: readonly Segment[];
  spans: readonly Span[];
  beats: readonly Beat[];
  unbeats: readonly UnbeatCue[];
  sounds: readonly SoundAnchor[];
  gridFit: readonly GridFitItem[];
  selection: TempoSelection;
  activeRange: Range | null;
  snapCandidates: readonly SnapCandidate[];
  offerPreview: OfferBeatPreview | null;
  abComparing: boolean;
  playheadMs: number;
  playheadMotion?: PlayheadMotion | undefined;
  loopRegion: TimeRange;
  looping: boolean;
}>();

const emit = defineEmits<{
  "update:view": [view: TimeView];
  "manual-pan": [];
  resize: [widthPx: number, devicePixelRatio: number];
  "hover-time": [timeMs: number | undefined];
  select: [selection: TempoSelection];
  "range-select": [range: Range];
  "place-beat": [timeSec: number];
  "place-unbeat": [timeSec: number];
  "apply-snap": [candidate: SnapCandidate];
  seek: [timeMs: number];
  locate: [timeMs: number, phase: LocatePhase];
}>();

const stageBackground = "#101820";
const rulerBackground = "#21262c";
const pulseLaneBackground = "#161e27";
const soundsLaneBackground = "#131a22";
const loopRegionColour = "rgba(101, 167, 250, 0.36)";
const loopRegionIdleColour = "rgba(255, 255, 255, 0.08)";
const rangeFillColour = "rgba(101, 167, 250, 0.14)";
const rangeEdgeColour = "rgba(101, 167, 250, 0.82)";
const userBeatColour = "#ffffff";
const draftBeatColour = "rgba(130, 184, 248, 0.82)";
const candidateBeatColour = "#56e39f";
const markCasingColour = "#06090e";
const markSelectedPlate = "#2466c3";
const locateTargetColour = "rgba(255, 77, 79, 0.9)";

const rulerHeight = 22;
const pulseHeight = 22;
const soundsHeight = 22;
const dragThresholdPx = 4;
const shiftDragThresholdPx = 6;
const entityHitPx = 7;

const host = ref<HTMLDivElement>();
const base = ref<HTMLCanvasElement>();
const overlay = ref<HTMLCanvasElement>();
const playheadLine = ref<HTMLDivElement>();
const size = ref({ width: 0, height: 0, dpr: 1 });
const spectrogram = shallowRef<Spectrogram>();
const hoverX = ref<number>();
const pendingRange = ref<TimeRange>();
const pendingLocate = ref<number>();

const sampleRate = computed(() => props.buffer.sampleRate);
const channels = computed(() =>
  Array.from({ length: props.buffer.numberOfChannels }, (_, index) =>
    props.buffer.getChannelData(index),
  ),
);

const gridFitBySoundId = computed(() => {
  const map = new Map<string, GridFitItem>();
  for (const item of props.gridFit) {
    map.set(item.soundId, item);
  }
  return map;
});

const lanes = computed(() => {
  const { height } = size.value;
  const flexible = Math.max(0, height - rulerHeight - pulseHeight - soundsHeight);
  let specHeight = 0;
  let waveHeight = 0;
  if (props.visualMode === "wave") {
    waveHeight = flexible;
  } else if (props.visualMode === "spec") {
    specHeight = flexible;
  } else {
    waveHeight = Math.min(flexible, Math.max(96, Math.round(flexible * 0.42)));
    specHeight = Math.max(0, flexible - waveHeight);
  }

  let top = 0;
  const makeLane = (h: number) => {
    const lane = { top, height: h };
    top += h;
    return lane;
  };
  return {
    ruler: makeLane(rulerHeight),
    spectrogram: makeLane(specHeight),
    waveform: makeLane(waveHeight),
    pulse: makeLane(pulseHeight),
    sounds: makeLane(soundsHeight),
  };
});

type LaneName = keyof typeof lanes.value;

function laneAt(y: number): LaneName {
  for (const [name, lane] of Object.entries(lanes.value) as [
    LaneName,
    { top: number; height: number },
  ][]) {
    if (lane.height > 0 && y >= lane.top && y < lane.top + lane.height) return name;
  }
  return "waveform";
}

const selectedBeat = computed(() => {
  const sel = props.selection;
  return sel.kind === "beat" ? props.beats.find((b) => b.id === sel.id) : undefined;
});

const inlineSnaps = computed(() => {
  if (!selectedBeat.value || props.snapCandidates.length === 0) return [];
  return props.snapCandidates.slice(0, 4);
});

const snapStripLeftPx = computed(() => {
  const beat = selectedBeat.value;
  if (!beat || size.value.width <= 0) return 8;
  const beatX = msToX(props.view, beat.timeSec * 1000);
  const maxLeft = Math.max(8, size.value.width - 340);
  return Math.round(Math.min(maxLeft, Math.max(8, beatX - 60)));
});

const SPEC_WINDOW_MS = 600_000;
const SPEC_EDGE_MARGIN_MS = 30_000;

interface SpecCoverage {
  buffer: AudioBuffer;
  startMs: number;
  endMs: number;
  frameHop: number;
}

let worker: Worker | undefined;
let activeSpecRequestId = 0;
let coveredSpecRange: SpecCoverage | null = null;
let inFlightSpecRange: SpecCoverage | null = null;

function visibleTimeRangeMs(): { visStartMs: number; visEndMs: number } {
  const widthPx = Math.max(1, size.value.width || 800);
  const visStartMs = Math.max(props.bounds.startMs, props.view.startMs);
  const visEndMs = Math.min(
    props.bounds.endMs,
    Math.max(visStartMs + 1, props.view.startMs + props.view.msPerPx * widthPx),
  );
  return { visStartMs, visEndMs };
}

function desiredHopForSpanMs(spanMs: number): number {
  if (spanMs <= SPEC_WINDOW_MS) return hop;
  return hop * Math.max(2, Math.ceil(spanMs / SPEC_WINDOW_MS));
}

function isViewportCoveredBy(coverage: SpecCoverage | null): boolean {
  if (!coverage || coverage.buffer !== props.buffer) return false;
  const { visStartMs, visEndMs } = visibleTimeRangeMs();
  const visSpan = visEndMs - visStartMs;

  // Must always cover the entire visible [visStartMs, visEndMs] span without any blank tail.
  if (coverage.startMs > visStartMs || coverage.endMs < visEndMs) {
    return false;
  }

  // Upgrade coarse wide-view spectrogram back to full resolution when zooming back in.
  const targetHop = desiredHopForSpanMs(visSpan);
  if (coverage.frameHop > targetHop) {
    return false;
  }

  if (coverage.startMs <= props.bounds.startMs && coverage.endMs >= props.bounds.endMs) {
    return true;
  }
  if (visSpan >= SPEC_WINDOW_MS - 2 * SPEC_EDGE_MARGIN_MS) {
    return true;
  }
  const leftMargin = coverage.startMs > props.bounds.startMs ? SPEC_EDGE_MARGIN_MS : 0;
  const rightMargin = coverage.endMs < props.bounds.endMs ? SPEC_EDGE_MARGIN_MS : 0;
  return (
    visStartMs >= coverage.startMs + leftMargin && visEndMs <= coverage.endMs - rightMargin
  );
}

function computeTargetSpecWindow(): { startMs: number; endMs: number; frameHop: number } {
  const totalSpanMs = props.bounds.endMs - props.bounds.startMs;
  if (totalSpanMs <= SPEC_WINDOW_MS) {
    return { startMs: props.bounds.startMs, endMs: props.bounds.endMs, frameHop: hop };
  }
  const { visStartMs, visEndMs } = visibleTimeRangeMs();
  const visSpan = visEndMs - visStartMs;
  if (visSpan > SPEC_WINDOW_MS) {
    return {
      startMs: visStartMs,
      endMs: visEndMs,
      frameHop: desiredHopForSpanMs(visSpan),
    };
  }
  const centerMs = 0.5 * (visStartMs + visEndMs);
  const startMs = Math.max(
    props.bounds.startMs,
    Math.min(props.bounds.endMs - SPEC_WINDOW_MS, Math.round(centerMs - SPEC_WINDOW_MS / 2)),
  );
  return {
    startMs,
    endMs: Math.min(props.bounds.endMs, startMs + SPEC_WINDOW_MS),
    frameHop: hop,
  };
}

watch(
  () => props.buffer,
  () => {
    activeSpecRequestId += 1;
    coveredSpecRange = null;
    inFlightSpecRange = null;
    spectrogram.value = undefined;
    columnCache.clear();
  },
);

watch(
  () =>
    [
      props.buffer,
      props.bounds.startMs,
      props.bounds.endMs,
      props.visualMode,
      props.view.startMs,
      props.view.msPerPx,
      size.value.width,
    ] as const,
  () => {
    if (props.visualMode === "wave") return;
    if (
      (spectrogram.value && isViewportCoveredBy(coveredSpecRange)) ||
      isViewportCoveredBy(inFlightSpecRange)
    ) {
      return;
    }

    const targetBuffer = props.buffer;
    const { startMs, endMs, frameHop } = computeTargetSpecWindow();
    const requestId = ++activeSpecRequestId;
    inFlightSpecRange = { buffer: targetBuffer, startMs, endMs, frameHop };

    const crop = cropSamples(startMs, endMs, sampleRate.value, targetBuffer.length, frameHop);
    const request: SpectrogramWorkerRequest = {
      requestId,
      channels: channels.value.map((data) => data.slice(crop.start, crop.end)),
      sliceStart: crop.start,
      totalFrames: targetBuffer.length,
      sampleRate: sampleRate.value,
      startMs,
      endMs,
      ...(frameHop !== hop ? { frameHop } : {}),
    };

    if (typeof Worker === "undefined") {
      const computedSpec = computeSpectrogram(request);
      coveredSpecRange = { buffer: targetBuffer, startMs, endMs, frameHop };
      inFlightSpecRange = null;
      columnCache.clear();
      spectrogram.value = computedSpec;
      return;
    }

    worker ??= createSpectrogramWorker();
    worker.onmessage = (event: MessageEvent<SpectrogramWorkerResponse>) => {
      if (event.data.requestId !== activeSpecRequestId || props.buffer !== targetBuffer) {
        return;
      }
      coveredSpecRange = {
        buffer: targetBuffer,
        startMs,
        endMs,
        frameHop: event.data.frameHop ?? frameHop,
      };
      inFlightSpecRange = null;
      columnCache.clear();
      spectrogram.value = event.data;
    };
    worker.postMessage(
      request,
      request.channels.map((data) => data.buffer),
    );
  },
  { immediate: true },
);

let observer: ResizeObserver | undefined;
let baseFrame = 0;
let overlayFrame = 0;
let lineLayer: PlayheadLayer | undefined;

let rangeAnchorMs: number | undefined;

const edgeAutoScroller = createTimeViewEdgeAutoScroller({
  edgeZonePx: 40,
  getContext: () =>
    size.value.width > 0
      ? {
          view: props.view,
          widthPx: size.value.width,
          bounds: props.bounds,
        }
      : undefined,
  onScroll: ({ view: nextView, pointerTimeMs }) => {
    emit("update:view", nextView);
    if (rangeAnchorMs !== undefined) {
      const clampedMs = Math.min(props.bounds.endMs, Math.max(props.bounds.startMs, pointerTimeMs));
      pendingRange.value = {
        startMs: Math.min(rangeAnchorMs, clampedMs),
        endMs: Math.max(rangeAnchorMs, clampedMs),
      };
    }
  },
});

onMounted(() => {
  if (playheadLine.value) lineLayer = new PlayheadLayer(playheadLine.value);
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => resize());
    if (host.value) observer.observe(host.value);
  }
  resize();
});

onBeforeUnmount(() => {
  edgeAutoScroller.stop();
  observer?.disconnect();
  worker?.terminate();
  cancelAnimationFrame(baseFrame);
  cancelAnimationFrame(overlayFrame);
  lineLayer?.cancel();
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
    props.visualMode,
    props.segments,
    props.spans,
    props.beats,
    props.unbeats,
    props.sounds,
    props.gridFit,
    props.selection,
    props.activeRange,
    props.snapCandidates,
    props.offerPreview,
    props.abComparing,
    props.loopRegion,
    props.looping,
    spectrogram.value,
  ],
  () => scheduleBase(),
);

watch(
  () => [hoverX.value, pendingRange.value, pendingLocate.value, props.view],
  () => {
    if (!baseFrame) drawOverlay();
  },
  { flush: "post" },
);

watch(
  () => [
    props.playheadMotion,
    props.playheadMotion ? 0 : props.playheadMs,
    props.view,
    size.value,
    lanes.value,
  ],
  () => {
    if (!baseFrame) placePlayhead();
  },
  { flush: "post" },
);

watch(spectrogram, () => columnCache.clear());

function scheduleBase() {
  baseFrame ||= requestAnimationFrame(() => {
    baseFrame = 0;
    drawBase();
  });
}

function scheduleOverlay() {
  overlayFrame ||= requestAnimationFrame(() => {
    overlayFrame = 0;
    drawOverlay();
  });
}

function deviceX(timeMs: number, view = props.view): number {
  return msToX(view, timeMs) * size.value.dpr;
}

function vline(
  context: CanvasRenderingContext2D,
  x: number,
  top: number,
  height: number,
  width = 1,
) {
  context.fillRect(lineLeft(x, width), top, width, height);
}

function dashedVline(
  context: CanvasRenderingContext2D,
  x: number,
  top: number,
  height: number,
  width: number,
  dash: number,
  gap: number,
) {
  for (let y = top; y < top + height; y += dash + gap) {
    vline(context, x, y, Math.min(dash, top + height - y), width);
  }
}

const greyLut = Uint32Array.from({ length: 256 }, (_, index) => {
  const [r, g, b] = [16, 24, 32].map((from) => Math.round(from + (179 - from) * (index / 255)));
  return ((255 << 24) | ((b as number) << 16) | ((g as number) << 8) | (r as number)) >>> 0;
});
const columnCache = new Map<number, Uint32Array>();

function drawBase() {
  const canvas = base.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = stageBackground;
  context.fillRect(0, 0, canvas.width, canvas.height);

  drawSpectrogram(context);
  drawSegmentBackdrops(context);
  drawWaveform(context);
  drawRuler(context);
  drawPulseAndSnaps(context);
  drawSoundsLane(context);
  drawActiveRange(context);
  drawOverlay();
  placePlayhead();
}

function drawSpectrogram(context: CanvasRenderingContext2D) {
  const data = spectrogram.value;
  const lane = lanes.value.spectrogram;
  const { dpr } = size.value;
  const width = Math.round(size.value.width * dpr);
  const rows = Math.round(lane.height * dpr);
  if (!data || rows <= 0 || width <= 0) return;
  const binsForRows = rowBins(rows, data.sampleRate);
  const dataHop = data.frameHop ?? hop;
  const image = context.createImageData(width, rows);
  const pixels = new Uint32Array(image.data.buffer);
  for (let x = 0; x < width; x++) {
    const timeMs = xToMs(props.view, (x + 0.5) / dpr);
    const frame = nearestFrame(timeMs, data.sampleRate, dataHop);
    const index = frame - data.firstFrame;
    if (index < 0 || index >= data.frameCount) continue;
    let column = columnCache.get(frame);
    if (!column || column.length !== rows) {
      column = new Uint32Array(rows);
      const offset = index * data.bins;
      for (let row = 0; row < rows; row++) {
        const { lo, hi } = binsForRows[row] as { lo: number; hi: number };
        let db = Number.NEGATIVE_INFINITY;
        for (let bin = lo; bin <= hi; bin++) db = Math.max(db, data.db[offset + bin] ?? -200);
        column[row] = greyLut[Math.round(level(db) * 255)] as number;
      }
      columnCache.set(frame, column);
    }
    for (let row = 0, at = x; row < rows; row++, at += width) pixels[at] = column[row] as number;
  }
  context.putImageData(image, 0, Math.round(lane.top * dpr));
}

function drawSegmentBackdrops(context: CanvasRenderingContext2D) {
  const { dpr, width } = size.value;
  const L = lanes.value;
  const bodyTop = (L.spectrogram.height > 0 ? L.spectrogram.top : L.waveform.top) * dpr;
  const bodyHeight = (L.pulse.top - (L.spectrogram.height > 0 ? L.spectrogram.top : L.waveform.top)) * dpr;
  if (bodyHeight <= 0) return;

  const startSec = props.view.startMs / 1000;
  const endSec = xToMs(props.view, width) / 1000;

  for (let i = 0; i < props.segments.length; i += 1) {
    const seg = props.segments[i];
    if (!seg || seg.t1 < startSec || seg.t0 > endSec) continue;
    const x0 = Math.max(0, deviceX(seg.t0 * 1000));
    const x1 = Math.min(width * dpr, deviceX(seg.t1 * 1000));
    if (x1 > x0) {
      if (seg.kept) {
        context.fillStyle = "rgba(62, 184, 128, 0.08)";
        context.fillRect(x0, bodyTop, x1 - x0, bodyHeight);
      } else if (seg.regime === "break") {
        context.fillStyle = "rgba(0, 0, 0, 0.28)";
        context.fillRect(x0, bodyTop, x1 - x0, bodyHeight);
      } else if (seg.regime === "free") {
        context.fillStyle = "rgba(101, 167, 250, 0.06)";
        context.fillRect(x0, bodyTop, x1 - x0, bodyHeight);
      }
    }
    if (i > 0 && seg.t0 >= startSec && seg.t0 <= endSec) {
      const bx = deviceX(seg.t0 * 1000);
      context.fillStyle = "rgba(255, 255, 255, 0.22)";
      dashedVline(context, bx, bodyTop, bodyHeight, Math.max(1, Math.round(dpr)), 4 * dpr, 4 * dpr);
    }
  }
}

function drawWaveform(context: CanvasRenderingContext2D) {
  const lane = lanes.value.waveform;
  if (lane.height <= 0) return;
  const { dpr } = size.value;
  const width = Math.round(size.value.width * dpr);
  const top = lane.top * dpr;
  const height = lane.height * dpr;
  const middle = top + height / 2;
  const scale = (height / 2) * 0.94;
  const rate = sampleRate.value;
  const samplesPerPx = (props.view.msPerPx / dpr) * (rate / 1000);

  context.save();
  context.beginPath();
  context.rect(0, top, width, height);
  context.clip();
  context.fillStyle = "rgba(255, 255, 255, 0.08)";
  context.fillRect(0, Math.round(middle), width, 1);

  const colours = ["rgba(226, 232, 240, 0.82)", "rgba(148, 160, 178, 0.78)"];
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
  context.fillStyle = rulerBackground;
  context.fillRect(0, lane.top * dpr, width * dpr, lane.height * dpr);

  if (props.loopRegion.endMs > props.loopRegion.startMs) {
    const loopLeft = deviceX(props.loopRegion.startMs);
    const loopRight = deviceX(props.loopRegion.endMs);
    context.fillStyle = props.looping ? loopRegionColour : loopRegionIdleColour;
    context.fillRect(loopLeft, lane.top * dpr, loopRight - loopLeft, lane.height * dpr);
  }

  const step = tickStepMs(props.view.msPerPx, 96);
  const minor = step / 5;
  const range = { startMs: props.view.startMs, endMs: xToMs(props.view, width) };
  context.fillStyle = "rgba(255, 255, 255, 0.26)";
  for (const tick of ticks(range, minor)) {
    vline(context, deviceX(tick), (lane.top + lane.height - 4) * dpr, 4 * dpr);
  }
  context.fillStyle = "rgba(255, 255, 255, 0.74)";
  context.font = `${10 * dpr}px "Azeret Mono Variable", ui-monospace, monospace`;
  context.textBaseline = "top";
  const digits = Math.max(0, msDecimals(step));
  for (const tick of ticks(range, step)) {
    const x = deviceX(tick);
    vline(context, x, (lane.top + lane.height - 9) * dpr, 9 * dpr);
    context.fillText(formatSourceTime(tick, digits), x + 3 * dpr, (lane.top + 3) * dpr);
  }
}

function drawPulseAndSnaps(context: CanvasRenderingContext2D) {
  const L = lanes.value;
  const { dpr, width } = size.value;
  const startMs = props.view.startMs;
  const endMs = xToMs(props.view, width);

  const pulseTop = L.pulse.top * dpr;
  const pulseH = L.pulse.height * dpr;
  context.fillStyle = pulseLaneBackground;
  context.fillRect(0, pulseTop, width * dpr, pulseH);
  context.fillStyle = "rgba(6, 9, 14, 0.9)";
  context.fillRect(0, pulseTop, width * dpr, 1);

  const lineTop = (L.spectrogram.height > 0 ? L.spectrogram.top : L.waveform.top) * dpr;
  const lineHeight = pulseTop - lineTop;
  const glyphY = pulseTop + pulseH * 0.52;

  // Draw snap candidates subtly when a Beat is selected.
  if (props.selection.kind === "beat" && props.snapCandidates.length > 0) {
    for (const cand of props.snapCandidates.slice(0, 4)) {
      const cMs = cand.targetSec * 1000;
      if (cMs < startMs || cMs > endMs) continue;
      const cx = deviceX(cMs);
      context.fillStyle = "rgba(101, 167, 250, 0.55)";
      dashedVline(context, cx, lineTop, lineHeight, Math.max(1, Math.round(dpr)), 3 * dpr, 3 * dpr);
    }
  }

  const removedIds = props.offerPreview?.removedBeatIds ?? new Set<string>();
  const isComparingOffer = props.abComparing && props.offerPreview !== null;

  const visibleBeats = props.beats.filter((b) => {
    const ms = b.timeSec * 1000;
    return ms >= startMs - 20 && ms <= endMs + 20;
  });

  // Dense guard when zoomed very far out on a 5-minute track.
  const avgBeatPx =
    visibleBeats.length > 1
      ? (((visibleBeats.at(-1)?.timeSec ?? 0) - (visibleBeats[0]?.timeSec ?? 0)) * 1000) /
        props.view.msPerPx /
        (visibleBeats.length - 1)
      : 999;

  for (const beat of visibleBeats) {
    const ms = beat.timeSec * 1000;
    const x = deviceX(ms);
    const isSelected = props.selection.kind === "beat" && props.selection.id === beat.id;
    const isRemovedInPreview = isComparingOffer && removedIds.has(beat.id);
    const isUser = beat.source === "user";

    if (isSelected) {
      context.fillStyle = rangeFillColour;
      context.fillRect(x - 4.5 * dpr, lineTop, 9 * dpr, lineHeight);
      const casing = Math.max(1, Math.round(dpr)) * 4;
      context.fillStyle = markCasingColour;
      vline(context, x, lineTop, lineHeight, casing);
    }

    const lineW = Math.max(1, Math.round(dpr)) * (isSelected ? 2 : 1);
    if (isRemovedInPreview) {
      context.fillStyle = "rgba(255, 255, 255, 0.24)";
      dashedVline(context, x, lineTop, lineHeight, lineW, 3 * dpr, 4 * dpr);
      continue;
    }

    context.fillStyle = isSelected || isUser ? userBeatColour : draftBeatColour;
    if (avgBeatPx >= 2.5 || isSelected || isUser) {
      vline(context, x, lineTop, lineHeight, lineW);
    } else {
      vline(context, x, pulseTop + 3 * dpr, pulseH - 6 * dpr, lineW);
    }

    if (avgBeatPx >= 4 || isSelected || isUser) {
      const r = (isSelected || isUser ? 4.6 : 3.6) * dpr;
      if (isSelected) {
        context.fillStyle = markSelectedPlate;
        context.fillRect(x - r * 1.5, glyphY - r * 1.4, r * 3, r * 2.8);
      }
      context.fillStyle = isSelected || isUser ? userBeatColour : draftBeatColour;
      context.beginPath();
      context.moveTo(x - r, glyphY - r * 0.75);
      context.lineTo(x + r, glyphY - r * 0.75);
      context.lineTo(x, glyphY + r * 0.85);
      context.closePath();
      context.fill();
    }
  }

  // Draw candidate / ghost beats when an offer exists (brighter while holding Alt A/B).
  if (props.offerPreview) {
    for (const cand of props.offerPreview.candidateBeats) {
      const ms = cand.timeSec * 1000;
      if (ms < startMs - 20 || ms > endMs + 20) continue;
      const x = deviceX(ms);
      context.fillStyle = props.abComparing
        ? candidateBeatColour
        : "rgba(86, 227, 159, 0.42)";
      const w = Math.max(1, Math.round(dpr)) * (props.abComparing ? 2 : 1);
      if (props.abComparing) {
        vline(context, x, lineTop, lineHeight, w);
      } else {
        dashedVline(context, x, lineTop, lineHeight, w, 5 * dpr, 4 * dpr);
      }
      const r = 4 * dpr;
      context.beginPath();
      context.moveTo(x, glyphY - r);
      context.lineTo(x + r * 0.85, glyphY);
      context.lineTo(x, glyphY + r);
      context.lineTo(x - r * 0.85, glyphY);
      context.closePath();
      context.fill();
    }
  }

  // Standalone Unbeat cues rendered as subtle muted `×` ticks along the Pulse baseline.
  for (const unbeat of props.unbeats) {
    const ms = unbeat.timeSec * 1000;
    if (ms < startMs - 20 || ms > endMs + 20) continue;
    const x = deviceX(ms);
    const isSelected = props.selection.kind === "unbeat" && props.selection.id === unbeat.id;
    const r = 4.2 * dpr;
    if (isSelected) {
      context.fillStyle = markSelectedPlate;
      context.fillRect(x - r * 1.6, glyphY - r * 1.5, r * 3.2, r * 3);
      context.fillStyle = rangeFillColour;
      context.fillRect(x - 3.5 * dpr, lineTop, 7 * dpr, lineHeight);
      context.fillStyle = "rgba(255, 255, 255, 0.65)";
      dashedVline(context, x, lineTop, lineHeight, Math.max(1, Math.round(dpr)), 3 * dpr, 4 * dpr);
    } else {
      context.fillStyle = "rgba(203, 213, 225, 0.3)";
      vline(context, x, pulseTop, 4 * dpr, Math.max(1, Math.round(dpr)));
    }
    context.strokeStyle = isSelected ? "#ffffff" : "rgba(176, 190, 206, 0.82)";
    context.lineWidth = (isSelected ? 1.8 : 1.35) * dpr;
    context.beginPath();
    context.moveTo(x - r * 0.8, glyphY - r * 0.8);
    context.lineTo(x + r * 0.8, glyphY + r * 0.8);
    context.moveTo(x - r * 0.8, glyphY + r * 0.8);
    context.lineTo(x + r * 0.8, glyphY - r * 0.8);
    context.stroke();
  }
}

function drawSoundsLane(context: CanvasRenderingContext2D) {
  const lane = lanes.value.sounds;
  const { dpr, width } = size.value;
  const top = lane.top * dpr;
  const height = lane.height * dpr;
  if (height <= 0) return;

  context.fillStyle = soundsLaneBackground;
  context.fillRect(0, top, width * dpr, height);
  context.fillStyle = "rgba(6, 9, 14, 0.95)";
  context.fillRect(0, top, width * dpr, 1);

  const midY = top + height * 0.52;
  const startMs = props.view.startMs;
  const endMs = xToMs(props.view, width);

  context.font = `${9 * dpr}px "Azeret Mono Variable", ui-monospace, monospace`;
  context.textBaseline = "middle";

  for (const sound of props.sounds) {
    const ms = sound.timeSec * 1000;
    if (ms < startMs - 20 || ms > endMs + 20) continue;
    const x = deviceX(ms);
    const fit = gridFitBySoundId.value.get(sound.id);
    const status = fit?.status ?? "on_grid";
    const isSelected = props.selection.kind === "sound" && props.selection.id === sound.id;
    const r = (isSelected ? 4.2 : 3.1) * dpr;

    if (isSelected) {
      context.fillStyle = markSelectedPlate;
      context.fillRect(x - r * 1.7, midY - r * 1.7, r * 3.4, r * 3.4);
    }

    if (status === "unexplained") {
      // Signed residual whisker from slotTimeSec to sound.timeSec.
      if (fit && fit.slotTimeSec !== null && Number.isFinite(fit.residualMs)) {
        const slotX = deviceX(fit.slotTimeSec * 1000);
        context.strokeStyle = "rgba(245, 185, 66, 0.72)";
        context.lineWidth = 1.2 * dpr;
        context.beginPath();
        context.moveTo(slotX, midY);
        context.lineTo(x, midY);
        context.stroke();
      }
      context.fillStyle = isSelected ? "#ffffff" : "#f5b942";
      context.beginPath();
      context.arc(x, midY, r, 0, Math.PI * 2);
      context.fill();
      if ((props.view.msPerPx <= 4 || isSelected) && fit && Number.isFinite(fit.residualMs)) {
        context.fillStyle = "#f5b942";
        context.fillText(formatSignedMs(fit.residualMs, 0), x + (r + 3 * dpr), midY);
      }
    } else if (status === "subdivision") {
      const div = fit?.nearestDivisor ?? 2;
      const isTernary = div === 3 || div === 6 || div === 12;
      context.strokeStyle = isSelected
        ? "#ffffff"
        : isTernary
          ? "rgba(130, 184, 248, 0.92)"
          : "rgba(176, 190, 206, 0.65)";
      context.lineWidth = 1.25 * dpr;
      context.beginPath();
      context.arc(x, midY, r * 0.9, 0, Math.PI * 2);
      context.stroke();
      if (isTernary && (props.view.msPerPx <= 8 || isSelected)) {
        context.fillStyle = "rgba(165, 208, 255, 0.95)";
        context.fillText(String(div === 12 ? 6 : div), x + (r + 2.5 * dpr), midY);
      }
    } else {
      // on_grid hollow marker
      context.strokeStyle =
        sound.source === "user" || isSelected ? "#ffffff" : "rgba(176, 190, 206, 0.62)";
      context.lineWidth = (sound.source === "user" ? 1.5 : 1.15) * dpr;
      context.beginPath();
      context.arc(x, midY, r * 0.85, 0, Math.PI * 2);
      context.stroke();
    }
  }
}

function drawActiveRange(context: CanvasRenderingContext2D) {
  const range = props.activeRange;
  if (!range || range.t1 <= range.t0) return;
  const { dpr } = size.value;
  const left = deviceX(range.t0 * 1000);
  const right = deviceX(range.t1 * 1000);
  const top = lanes.value.ruler.height * dpr;
  const height = canvasBodyHeightPx() * dpr;
  context.fillStyle = rangeFillColour;
  context.fillRect(left, top, Math.max(1, right - left), height);
  context.fillStyle = rangeEdgeColour;
  vline(context, left, 0, size.value.height * dpr, Math.max(1, Math.round(dpr)));
  vline(context, right, 0, size.value.height * dpr, Math.max(1, Math.round(dpr)));
}

function canvasBodyHeightPx(): number {
  return Math.max(0, size.value.height - lanes.value.ruler.height);
}

function drawOverlay() {
  const canvas = overlay.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;
  const { dpr, width, height } = size.value;
  const L = lanes.value;
  context.clearRect(0, 0, canvas.width, canvas.height);

  if (pendingRange.value) {
    const left = deviceX(pendingRange.value.startMs);
    const right = deviceX(pendingRange.value.endMs);
    context.fillStyle = "rgba(101, 167, 250, 0.22)";
    context.fillRect(Math.min(left, right), 0, Math.abs(right - left), height * dpr);
    context.fillStyle = rangeEdgeColour;
    vline(context, left, 0, height * dpr, Math.max(1, Math.round(dpr)));
    vline(context, right, 0, height * dpr, Math.max(1, Math.round(dpr)));
  }

  const locating = pendingLocate.value;
  if (hoverX.value !== undefined || locating !== undefined) {
    const timeMs = locating ?? xToMs(props.view, hoverX.value ?? 0);
    const x = deviceX(timeMs);
    const top = L.ruler.height * dpr;
    const lineH = (height - L.ruler.height) * dpr;
    if (locating !== undefined) {
      context.fillStyle = locateTargetColour;
      dashedVline(context, x, top, lineH, dpr, 6 * dpr, 4 * dpr);
    } else {
      context.fillStyle = "rgba(255, 255, 255, 0.32)";
      vline(context, x, top, lineH);
    }
    const digits = props.view.msPerPx < 0.1 ? 2 : props.view.msPerPx < 1 ? 1 : 0;
    let label = formatSourceTime(timeMs, digits);
    if (props.view.msPerPx < 1) {
      label += ` · n ${nearestSample(timeMs, props.sourceSampleRate ?? sampleRate.value)}`;
    }
    context.font = `${10 * dpr}px "Azeret Mono Variable", ui-monospace, monospace`;
    context.textBaseline = "top";
    const textWidth = context.measureText(label).width;
    const textX = Math.min(x + 6 * dpr, width * dpr - textWidth - 6 * dpr);
    const textY = (L.ruler.height + 4) * dpr;
    context.fillStyle = "rgba(11, 17, 23, 0.85)";
    context.fillRect(textX - 3 * dpr, textY - 2 * dpr, textWidth + 6 * dpr, 14 * dpr);
    context.fillStyle = "#fff";
    context.fillText(label, textX, textY);
  }
}

let placed: unknown[] = [];

function placePlayhead() {
  const line = playheadLine.value;
  if (!line || !lineLayer) return;
  const motion = props.playheadMotion;
  const inputs = [
    motion,
    motion ? 0 : props.playheadMs,
    props.view,
    size.value,
    lanes.value,
  ];
  if (inputs.every((value, index) => value === placed[index])) return;
  placed = inputs;
  const { dpr, height } = size.value;
  const width = Math.max(1, Math.round(dpr));
  line.style.top = "0px";
  line.style.height = `${height}px`;
  line.style.width = `${width / dpr}px`;
  if (motion) {
    lineLayer.run(motion, (timeMs) => (deviceX(timeMs) - width / 2) / dpr);
    return;
  }
  lineLayer.hold(lineLeft(deviceX(props.playheadMs), width) / dpr);
}

let press:
  | {
      x: number;
      y: number;
      lane: LaneName;
      locate: boolean;
      secondary: boolean;
      shift: boolean;
      timeMs: number;
      view: TimeView;
      dragging: boolean;
    }
  | undefined;

function localPoint(event: PointerEvent | WheelEvent | MouseEvent) {
  const rect = overlay.value?.getBoundingClientRect();
  return {
    x: event.clientX - (rect?.left ?? 0),
    y: event.clientY - (rect?.top ?? 0),
    rect,
  };
}

function isLocate(event: MouseEvent): boolean {
  return event.button === 1 || (event.button === 0 && event.altKey);
}

function onPointerDown(event: PointerEvent) {
  const ownButton = [1, 4, 2][event.button] ?? 0;
  if (press && (event.buttons & ~ownButton) !== 0) return;
  const locate = isLocate(event);
  if (locate) event.preventDefault();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const { x, y } = localPoint(event);
  const timeMs = xToMs(props.view, x);
  press = {
    x,
    y,
    lane: laneAt(y),
    locate,
    secondary: event.button === 2 || (event.button === 0 && event.ctrlKey),
    shift: event.shiftKey,
    timeMs,
    view: props.view,
    dragging: false,
  };
  overlay.value?.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
  const { x, rect } = localPoint(event);
  hoverX.value = x;
  emit("hover-time", xToMs(props.view, x));
  if (!press) return;
  const dx = x - press.x;
  const isRangeGesture = (press.shift || press.lane === "ruler") && !press.secondary && !press.locate;
  const threshold = isRangeGesture ? shiftDragThresholdPx : dragThresholdPx;
  if (!press.dragging && Math.abs(dx) < threshold) return;
  press.dragging = true;

  if (press.locate) {
    pendingLocate.value = xToMs(props.view, x);
    emit("locate", pendingLocate.value, "move");
    return;
  }

  if (isRangeGesture) {
    rangeAnchorMs = press.timeMs;
    const clampedX = Math.min(size.value.width, Math.max(0, x));
    const currentMs = Math.min(
      props.bounds.endMs,
      Math.max(props.bounds.startMs, xToMs(props.view, clampedX)),
    );
    pendingRange.value = {
      startMs: Math.min(press.timeMs, currentMs),
      endMs: Math.max(press.timeMs, currentMs),
    };
    if (rect && rect.width > 0) {
      edgeAutoScroller.updateClient({
        clientX: event.clientX,
        rect: { left: rect.left, right: rect.right, width: rect.width },
      });
    } else {
      edgeAutoScroller.update({ localX: x, widthPx: size.value.width });
    }
    return;
  }

  // Pan view on right-drag or primary drag when not shift-dragging a range.
  emit("manual-pan");
  emit("update:view", {
    startMs: press.view.startMs - dx * press.view.msPerPx,
    msPerPx: press.view.msPerPx,
  });
}

function onPointerUp(event: PointerEvent) {
  edgeAutoScroller.stop();
  rangeAnchorMs = undefined;
  const current = press;
  press = undefined;
  if (!current) return;
  const { x } = localPoint(event);

  if (current.locate) {
    pendingLocate.value = undefined;
    emit("locate", xToMs(props.view, x), "end");
    return;
  }

  if (current.dragging) {
    if (pendingRange.value && pendingRange.value.endMs - pendingRange.value.startMs >= 5) {
      const t0 = Math.max(0, pendingRange.value.startMs / 1000);
      const t1 = Math.min(props.bounds.endMs / 1000, pendingRange.value.endMs / 1000);
      if (t1 > t0) {
        emit("range-select", { t0, t1 });
      }
    }
    pendingRange.value = undefined;
    return;
  }

  const timeMs = Math.min(props.bounds.endMs, Math.max(props.bounds.startMs, xToMs(props.view, x)));
  const tolSec = (entityHitPx * props.view.msPerPx) / 1000;
  const timeSec = timeMs / 1000;

  if (current.lane === "ruler") {
    emit("seek", timeMs);
    return;
  }

  if (current.secondary) {
    emit("place-unbeat", timeSec);
    return;
  }

  if (current.shift) {
    emit("place-beat", timeSec);
    return;
  }

  if (current.lane === "sounds") {
    let nearSound: SoundAnchor | undefined;
    for (const s of props.sounds) {
      const dist = Math.abs(s.timeSec - timeSec);
      if (dist <= tolSec && (!nearSound || dist < Math.abs(nearSound.timeSec - timeSec))) {
        nearSound = s;
      }
    }
    if (nearSound) {
      emit("select", { kind: "sound", id: nearSound.id });
      return;
    }
  }

  if (current.lane === "pulse") {
    let nearUnbeat: UnbeatCue | undefined;
    for (const u of props.unbeats) {
      const dist = Math.abs(u.timeSec - timeSec);
      if (dist <= tolSec && (!nearUnbeat || dist < Math.abs(nearUnbeat.timeSec - timeSec))) {
        nearUnbeat = u;
      }
    }
    if (nearUnbeat) {
      emit("select", { kind: "unbeat", id: nearUnbeat.id });
      return;
    }
  }

  let nearBeat: Beat | undefined;
  for (const b of props.beats) {
    const dist = Math.abs(b.timeSec - timeSec);
    if (dist <= tolSec && (!nearBeat || dist < Math.abs(nearBeat.timeSec - timeSec))) {
      nearBeat = b;
    }
  }
  if (nearBeat) {
    emit("select", { kind: "beat", id: nearBeat.id });
    return;
  }

  if (event.detail >= 2) {
    emit("place-beat", timeSec);
    return;
  }

  emit("select", { kind: "none" });
  emit("seek", timeMs);
}

function onPointerCancel() {
  edgeAutoScroller.stop();
  rangeAnchorMs = undefined;
  if (press?.locate) emit("locate", press.timeMs, "cancel");
  press = undefined;
  pendingRange.value = undefined;
  pendingLocate.value = undefined;
}

function onPointerLeave() {
  hoverX.value = undefined;
  emit("hover-time", undefined);
}

function onMouseDefault(event: MouseEvent) {
  if (isLocate(event)) event.preventDefault();
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
  const delta =
    (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit;
  if (delta !== 0) {
    emit("manual-pan");
  }
  emit("update:view", {
    startMs: props.view.startMs + delta * props.view.msPerPx,
    msPerPx: props.view.msPerPx,
  });
}

function cancelDrag(): boolean {
  edgeAutoScroller.stop();
  rangeAnchorMs = undefined;
  const locate = press?.locate;
  const active = Boolean(press?.dragging || locate);
  if (locate && press) emit("locate", press.timeMs, "cancel");
  press = undefined;
  pendingRange.value = undefined;
  pendingLocate.value = undefined;
  return active;
}

defineExpose({ cancelDrag });
</script>

<template>
  <div ref="host" class="tempo-stage">
    <canvas ref="base" class="tempo-stage-canvas" aria-hidden="true"></canvas>
    <div ref="playheadLine" class="tempo-stage-playhead" aria-hidden="true"></div>
    <canvas
      ref="overlay"
      class="tempo-stage-canvas tempo-stage-overlay"
      role="img"
      aria-label="Waveform, spectrogram, pulse beats, unbeat cues, and derived sounds; Shift+drag selects a range, click selects beats or sounds, Option+click locates the playhead"
      @pointerdown="onPointerDown"
      @mousedown="onMouseDefault"
      @auxclick="onMouseDefault"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @pointerleave="onPointerLeave"
      @wheel="onWheel"
      @contextmenu.prevent
    ></canvas>

    <div
      v-if="inlineSnaps.length > 0"
      class="tempo-snap-strip"
      :style="{ left: `${snapStripLeftPx}px` }"
      role="toolbar"
      aria-label="Snap beat to nearby sound"
    >
      <button
        v-for="(cand, idx) in inlineSnaps"
        :key="cand.eventId"
        type="button"
        class="tempo-snap-chip"
        :aria-keyshortcuts="String(idx + 1)"
        :title="`Snap to ${cand.label} (${SNAP_ROLE_LABELS[cand.role]}, ${formatSignedMs(cand.deltaMs, 1)})`"
        @pointerdown.stop
        @click.stop="emit('apply-snap', cand)"
      >
        <kbd>{{ idx + 1 }}</kbd>
        <span class="tempo-snap-label">{{ cand.label }}</span>
        <span class="tempo-snap-role">{{ SNAP_ROLE_LABELS[cand.role] }}</span>
        <span class="tempo-snap-delta">{{ formatSignedMs(cand.deltaMs, 1) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.tempo-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background: var(--well, #101820);
}

.tempo-stage-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.tempo-stage-overlay {
  cursor: crosshair;
  touch-action: none;
}

.tempo-stage-playhead {
  position: absolute;
  top: 0;
  left: 0;
  width: 2px;
  z-index: 2;
  pointer-events: none;
  will-change: transform;
  background: rgb(255 77 79 / 0.78);
}

.tempo-stage-playhead::before {
  position: absolute;
  top: 0;
  left: 50%;
  width: 10px;
  height: 7px;
  margin-left: -5px;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
  background: #ff4d4f;
  content: "";
}

.tempo-snap-strip {
  position: absolute;
  top: 26px;
  z-index: 4;
  display: inline-flex;
  max-width: calc(100% - 16px);
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--seam);
  border-radius: var(--radius-control);
  background: var(--surface-2);
}

.tempo-snap-chip {
  display: inline-flex;
  min-height: var(--control-h-sm);
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  color: var(--ink-secondary);
  border: 0;
  border-radius: 3px;
  background: var(--surface-3);
  cursor: pointer;
  font-size: var(--text-2xs);
  font-weight: 600;
  white-space: nowrap;
}

.tempo-snap-chip:hover {
  color: var(--ink);
  background: var(--surface-3-hover);
}

.tempo-snap-chip kbd {
  padding: 0 3px;
  color: var(--signal);
  background: var(--field);
  font-family: var(--font-data);
  font-size: var(--text-2xs);
}

.tempo-snap-label {
  max-width: 96px;
  overflow: hidden;
  color: var(--ink);
  text-overflow: ellipsis;
}

.tempo-snap-role {
  color: var(--ink-secondary);
}

.tempo-snap-delta {
  color: var(--signal);
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
}
</style>
