<script setup lang="ts">
import type { Range, Segment, Span } from "ensomi";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { type TimeView, xToMs } from "../stage-audio/time-view";
import { formatSecSpan, SEGMENT_REGIME_LABELS } from "./state";

const props = defineProps<{
  durationSec: number;
  segments: readonly Segment[];
  spans: readonly Span[];
  inboxSpans: readonly Span[];
  selectedSegmentId: string | null;
  activeRange: Range | null;
  view: TimeView;
  stageWidthPx: number;
  playheadMs: number;
}>();

const emit = defineEmits<{
  "select-segment": [segmentId: string, jumpToStart: boolean];
  "toggle-segment-keep": [segmentId: string, kept: boolean];
  "move-boundary": [leftSegmentId: string, rightSegmentId: string, timeSec: number];
  "update:view": [view: TimeView];
  locate: [timeMs: number];
}>();

const MIN_SEGMENT_DURATION_SEC = 0.05;

const hostRef = ref<HTMLElement>();
const stripWidth = ref(1);
const hoveredSegmentId = ref<string | null>(null);
const draggingBoundary = ref<{
  index: number;
  leftId: string;
  rightId: string;
  minSec: number;
  maxSec: number;
  previewSec: number;
} | null>(null);
const draggingLens = ref<{
  startX: number;
  initialStartMs: number;
} | null>(null);

let resizeObserver: ResizeObserver | undefined;

onMounted(() => {
  const el = hostRef.value;
  if (!el) return;
  stripWidth.value = Math.max(1, el.clientWidth);
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      if (hostRef.value) {
        stripWidth.value = Math.max(1, hostRef.value.clientWidth);
      }
    });
    resizeObserver.observe(el);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});

const safeDurationSec = computed(() => Math.max(0.001, props.durationSec));

const renderedSegments = computed(() => {
  const drag = draggingBoundary.value;
  return props.segments.map((seg, idx) => {
    let t0 = seg.t0;
    let t1 = seg.t1;
    if (drag) {
      if (idx === drag.index - 1) t1 = drag.previewSec;
      else if (idx === drag.index) t0 = drag.previewSec;
    }
    const leftPct = (t0 / safeDurationSec.value) * 100;
    const widthPct = Math.max(0, ((t1 - t0) / safeDurationSec.value) * 100);
    const widthPx = ((t1 - t0) / safeDurationSec.value) * stripWidth.value;
    return {
      seg,
      idx,
      t0,
      t1,
      leftPct,
      widthPct,
      widthPx,
      label: `Segment ${idx + 1} · ${SEGMENT_REGIME_LABELS[seg.regime]} · ${formatSecSpan(t0, t1, 1)}${seg.kept ? " · Kept" : ""}`,
    };
  });
});

interface BoundaryHandle {
  index: number;
  leftSeg: Segment;
  rightSeg: Segment;
  leftPct: number;
  timeSec: number;
  minSec: number;
  maxSec: number;
}

const boundaryHandles = computed<BoundaryHandle[]>(() => {
  const items: BoundaryHandle[] = [];
  for (let i = 1; i < props.segments.length; i += 1) {
    const leftSeg = props.segments[i - 1];
    const rightSeg = props.segments[i];
    if (!leftSeg || !rightSeg) continue;
    const timeSec =
      draggingBoundary.value?.index === i ? draggingBoundary.value.previewSec : rightSeg.t0;
    items.push({
      index: i,
      leftSeg,
      rightSeg,
      timeSec,
      minSec: leftSeg.t0 + MIN_SEGMENT_DURATION_SEC,
      maxSec: rightSeg.t1 - MIN_SEGMENT_DURATION_SEC,
      leftPct: (timeSec / safeDurationSec.value) * 100,
    });
  }
  return items;
});

const lensStyle = computed(() => {
  const durMs = safeDurationSec.value * 1000;
  const startMs = Math.max(0, props.view.startMs);
  const endMs = Math.min(durMs, xToMs(props.view, Math.max(1, props.stageWidthPx)));
  const leftPct = (startMs / durMs) * 100;
  const widthPct = Math.max(0.4, ((endMs - startMs) / durMs) * 100);
  return {
    left: `${leftPct}%`,
    width: `${Math.min(100 - leftPct, widthPct)}%`,
  };
});

const playheadLeftPct = computed(() => {
  const durMs = safeDurationSec.value * 1000;
  return `${Math.min(100, Math.max(0, (props.playheadMs / durMs) * 100))}%`;
});

const rangeStyle = computed(() => {
  if (!props.activeRange || props.activeRange.t1 <= props.activeRange.t0) return null;
  const leftPct = (props.activeRange.t0 / safeDurationSec.value) * 100;
  const widthPct = ((props.activeRange.t1 - props.activeRange.t0) / safeDurationSec.value) * 100;
  return {
    left: `${leftPct}%`,
    width: `${widthPct}%`,
  };
});

const childSpanOverlays = computed(() =>
  props.spans
    .filter((s) => s.kind === "keep" || s.kind === "free")
    .map((span) => ({
      span,
      leftPct: (span.t0 / safeDurationSec.value) * 100,
      widthPct: Math.max(0.2, ((span.t1 - span.t0) / safeDurationSec.value) * 100),
    })),
);

const inboxMarkers = computed(() =>
  props.inboxSpans.map((span) => ({
    span,
    priority: span.priority ?? "low",
    leftPct: (span.t0 / safeDurationSec.value) * 100,
    widthPct: Math.max(0.5, ((span.t1 - span.t0) / safeDurationSec.value) * 100),
  })),
);

function clientXToSec(clientX: number): number {
  const rect = hostRef.value?.getBoundingClientRect();
  if (!rect || rect.width <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return ratio * safeDurationSec.value;
}

function onSegmentClick(seg: Segment, event: MouseEvent) {
  if (event.altKey || event.button === 1) {
    event.preventDefault();
    emit("locate", clientXToSec(event.clientX) * 1000);
    return;
  }
  emit("select-segment", seg.id, event.detail >= 2);
}

function onSegmentKeydown(seg: Segment, event: KeyboardEvent) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    emit("select-segment", seg.id, false);
  }
}

function onKeepChipClick(seg: Segment, event: MouseEvent) {
  event.stopPropagation();
  emit("select-segment", seg.id, false);
  emit("toggle-segment-keep", seg.id, !seg.kept);
}

function onBoundaryPointerDown(handle: BoundaryHandle, event: PointerEvent) {
  if (event.button !== 0) return;
  event.stopPropagation();
  event.preventDefault();
  const target = event.currentTarget as HTMLElement | null;
  target?.setPointerCapture?.(event.pointerId);
  draggingBoundary.value = {
    index: handle.index,
    leftId: handle.leftSeg.id,
    rightId: handle.rightSeg.id,
    minSec: handle.minSec,
    maxSec: handle.maxSec,
    previewSec: handle.timeSec,
  };
}

function onBoundaryPointerMove(event: PointerEvent) {
  const drag = draggingBoundary.value;
  if (!drag) return;
  const rawSec = clientXToSec(event.clientX);
  drag.previewSec = Math.min(drag.maxSec, Math.max(drag.minSec, rawSec));
}

function onBoundaryPointerUp() {
  const drag = draggingBoundary.value;
  if (!drag) return;
  draggingBoundary.value = null;
  emit("move-boundary", drag.leftId, drag.rightId, Number(drag.previewSec.toFixed(6)));
}

function onBoundaryKeydown(handle: BoundaryHandle, event: KeyboardEvent) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  event.stopPropagation();
  const stepSec = event.shiftKey ? 0.5 : 0.05;
  const delta = event.key === "ArrowRight" ? stepSec : -stepSec;
  const next = Math.min(handle.maxSec, Math.max(handle.minSec, handle.timeSec + delta));
  emit("move-boundary", handle.leftSeg.id, handle.rightSeg.id, Number(next.toFixed(6)));
}

function onLensPointerDown(event: PointerEvent) {
  if (event.altKey || event.button === 1) {
    event.preventDefault();
    emit("locate", clientXToSec(event.clientX) * 1000);
    return;
  }
  if (event.button !== 0) return;
  const target = event.currentTarget as HTMLElement | null;
  target?.setPointerCapture?.(event.pointerId);
  draggingLens.value = {
    startX: event.clientX,
    initialStartMs: props.view.startMs,
  };
}

function onLensPointerMove(event: PointerEvent) {
  const drag = draggingLens.value;
  if (!drag) return;
  const dx = event.clientX - drag.startX;
  if (Math.abs(dx) < 3) return;
  const msPerStripPx = (safeDurationSec.value * 1000) / Math.max(1, stripWidth.value);
  emit("update:view", {
    startMs: drag.initialStartMs + dx * msPerStripPx,
    msPerPx: props.view.msPerPx,
  });
}

function onLensPointerUp(event: PointerEvent) {
  const drag = draggingLens.value;
  draggingLens.value = null;
  if (!drag) return;
  if (Math.abs(event.clientX - drag.startX) < 3) {
    const sec = clientXToSec(event.clientX);
    const hit = props.segments.find((s) => sec >= s.t0 && sec < s.t1) ?? props.segments.at(-1);
    if (hit) {
      emit("select-segment", hit.id, event.detail >= 2);
    }
  }
}
</script>

<template>
  <section
    ref="hostRef"
    class="tempo-segment-strip"
    aria-label="Whole-song segment partition"
    @mouseleave="hoveredSegmentId = null"
  >
    <!-- biome-ignore lint/a11y/useSemanticElements: Segment cells sit on an absolute time axis and can contain an inner Keep button. -->
    <div
      v-for="item in renderedSegments"
      :key="item.seg.id"
      class="tempo-seg-cell"
      :class="{
        'is-selected': item.seg.id === selectedSegmentId,
        'is-kept': item.seg.kept,
        'is-free': item.seg.regime === 'free',
        'is-break': item.seg.regime === 'break',
      }"
      role="button"
      tabindex="0"
      :style="{ left: `${item.leftPct}%`, width: `${item.widthPct}%` }"
      :title="item.label"
      @mouseenter="hoveredSegmentId = item.seg.id"
      @click="onSegmentClick(item.seg, $event)"
      @keydown="onSegmentKeydown(item.seg, $event)"
    >
      <span v-if="item.widthPx >= 52" class="tempo-seg-tag">
        {{ item.seg.kept ? "Kept" : SEGMENT_REGIME_LABELS[item.seg.regime] }}
      </span>
      <button
        v-if="
          item.widthPx >= 96 &&
          (hoveredSegmentId === item.seg.id || selectedSegmentId === item.seg.id || item.seg.kept)
        "
        type="button"
        class="tempo-seg-keep-toggle"
        :class="{ 'is-on': item.seg.kept }"
        :aria-pressed="item.seg.kept"
        title="Toggle segment Keep (V)"
        @click="onKeepChipClick(item.seg, $event)"
      >
        {{ item.seg.kept ? "✓ Keep" : "Keep" }}
      </button>
    </div>

    <div
      v-for="(overlay, idx) in childSpanOverlays"
      :key="`span-${idx}`"
      class="tempo-span-overlay"
      :class="`tempo-span-overlay--${overlay.span.kind}`"
      :style="{ left: `${overlay.leftPct}%`, width: `${overlay.widthPct}%` }"
      aria-hidden="true"
    ></div>

    <div
      v-for="(marker, idx) in inboxMarkers"
      :key="`inbox-${idx}`"
      class="tempo-inbox-pip"
      :class="`tempo-inbox-pip--${marker.priority}`"
      :style="{ left: `${marker.leftPct}%`, width: `${marker.widthPct}%` }"
      :title="marker.span.reason ?? 'Needs review'"
      aria-hidden="true"
    ></div>

    <div
      v-if="rangeStyle"
      class="tempo-strip-range"
      :style="rangeStyle"
      aria-hidden="true"
    ></div>

    <div
      class="tempo-strip-lens"
      :style="lensStyle"
      title="Viewport lens (drag to pan)"
      @pointerdown="onLensPointerDown"
      @pointermove="onLensPointerMove"
      @pointerup="onLensPointerUp"
      @pointercancel="draggingLens = null"
    ></div>

    <!-- biome-ignore lint/a11y/useSemanticElements: Draggable vertical boundary splitter requires focusable separator semantics and pointer capture. -->
    <div
      v-for="handle in boundaryHandles"
      :key="`bound-${handle.index}`"
      class="tempo-seg-boundary"
      :class="{ 'is-dragging': draggingBoundary?.index === handle.index }"
      :style="{ left: `${handle.leftPct}%` }"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      :aria-label="`Boundary between segment ${handle.index} and ${handle.index + 1}`"
      :aria-valuemin="Number(handle.minSec.toFixed(2))"
      :aria-valuemax="Number(handle.maxSec.toFixed(2))"
      :aria-valuenow="Number(handle.timeSec.toFixed(2))"
      title="Drag to move segment boundary"
      @pointerdown="onBoundaryPointerDown(handle, $event)"
      @pointermove="onBoundaryPointerMove"
      @pointerup="onBoundaryPointerUp"
      @pointercancel="draggingBoundary = null"
      @keydown="onBoundaryKeydown(handle, $event)"
    ></div>

    <div
      class="tempo-strip-playhead"
      :style="{ left: playheadLeftPct }"
      aria-hidden="true"
    ></div>
  </section>
</template>

<style scoped>
.tempo-segment-strip {
  position: relative;
  height: 30px;
  flex: 0 0 auto;
  overflow: hidden;
  border-bottom: 1px solid var(--seam);
  background: var(--well-raised, #141b23);
  user-select: none;
}

.tempo-seg-cell {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 0 6px;
  overflow: hidden;
  border-right: 1px solid var(--line);
  cursor: pointer;
}

.tempo-seg-cell:last-of-type {
  border-right: 0;
}

.tempo-seg-cell.is-kept {
  background: oklch(48% 0.12 153 / 0.2);
  box-shadow: inset 0 2px 0 var(--success);
}

.tempo-seg-cell.is-free {
  background-image: repeating-linear-gradient(
    -45deg,
    oklch(72% 0.14 255 / 0.12) 0 4px,
    transparent 4px 8px
  );
}

.tempo-seg-cell.is-break {
  background: rgb(0 0 0 / 0.36);
}

.tempo-seg-cell.is-selected {
  box-shadow: inset 0 0 0 1px var(--signal);
}

.tempo-seg-cell.is-selected.is-kept {
  box-shadow:
    inset 0 2px 0 var(--success),
    inset 0 0 0 1px var(--signal);
}

.tempo-seg-tag {
  min-width: 0;
  overflow: hidden;
  color: var(--ink-secondary);
  font-size: var(--text-2xs);
  font-weight: 560;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}

.tempo-seg-keep-toggle {
  position: relative;
  z-index: 3;
  flex: 0 0 auto;
  min-height: var(--control-h-sm);
  padding: 0 6px;
  border: 0;
  border-radius: 3px;
  color: var(--ink-secondary);
  background: var(--surface-3);
  box-shadow: var(--shadow-control);
  font-size: var(--text-2xs);
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}

.tempo-seg-keep-toggle.is-on {
  color: oklch(100% 0 0);
  background: var(--success-fill);
}

.tempo-span-overlay {
  position: absolute;
  top: 0;
  bottom: 0;
  pointer-events: none;
}

.tempo-span-overlay--keep {
  background: oklch(48% 0.12 153 / 0.18);
  border-top: 2px solid var(--success);
}

.tempo-span-overlay--free {
  background-image: repeating-linear-gradient(
    -45deg,
    oklch(72% 0.14 255 / 0.14) 0 3px,
    transparent 3px 6px
  );
}

.tempo-inbox-pip {
  position: absolute;
  bottom: 0;
  height: 2px;
  pointer-events: none;
}

.tempo-inbox-pip--high {
  background: var(--danger);
}

.tempo-inbox-pip--medium {
  background: var(--warning);
}

.tempo-inbox-pip--low {
  background: var(--signal);
}

.tempo-strip-range {
  position: absolute;
  top: 0;
  bottom: 0;
  background: oklch(72% 0.14 255 / 0.18);
  border-left: 1px solid var(--signal);
  border-right: 1px solid var(--signal);
  pointer-events: none;
}

.tempo-strip-lens {
  position: absolute;
  top: 1px;
  bottom: 1px;
  z-index: 2;
  border: 1px solid rgb(255 255 255 / 0.65);
  border-radius: 2px;
  background: rgb(255 255 255 / 0.04);
  cursor: grab;
  touch-action: none;
}

.tempo-strip-lens:active {
  cursor: grabbing;
}

.tempo-seg-boundary {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 4;
  width: 9px;
  margin-left: -4px;
  cursor: col-resize;
  touch-action: none;
}

.tempo-seg-boundary::after {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 4px;
  width: 1px;
  background: var(--line-strong);
  content: "";
}

.tempo-seg-boundary:hover::after,
.tempo-seg-boundary.is-dragging::after {
  width: 2px;
  background: var(--signal);
}

.tempo-strip-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 5;
  width: 1.5px;
  background: #ff4d4f;
  pointer-events: none;
}
</style>
