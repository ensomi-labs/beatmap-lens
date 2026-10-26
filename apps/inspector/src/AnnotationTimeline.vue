<!-- biome-ignore-all lint/a11y/noNoninteractiveTabindex: The approved timeline spec requires the controlled rail root to be keyboard-focusable for +/-/0 shortcuts. -->
<script setup lang="ts">
import type { ManiaChart } from "beatmap-lens";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { GoldAnnotationV1, TimeRangeV1 } from "./annotation/contracts";
import { createOverviewDensityPath } from "./annotation/overview-density";
import {
  beginTimelineViewportPan,
  classifyTimelineGesture,
  formatTimelineRangeLabels,
  hitTimelineRangeTarget,
  panTimelineViewportRange,
  type TimelineGestureKind,
  type TimelineViewportPanStart,
  timelineEdgeHitHeight,
  timelineRangeBodyContainsY,
  timelineRangeOutOfView,
  timelineRangeVerticalGeometry,
} from "./annotation/timeline-range";
import {
  applyTimelineEdgePan,
  fitTimelineViewRange,
  normalizeTimelineWheelZoomDelta,
  timelineSourceTimeFromClampedY,
  timelineYFromSourceTime,
  timelineZoomAnchorMs,
  zoomTimelineViewRangeAtTime,
  zoomTimelineViewRangeAtY,
} from "./annotation/timeline-view-range";

const viewBoxHeight = 1_000;
const pointerDragThresholdPx = 2;
const keyboardZoomDelta = 0.5;
const densityWidth = 20;
const savedBandX = 31;
const savedBandWidth = 9;
const selectionX = 22;
const selectionWidth = 27;
const minimumBandHeight = 1.5;
const normalLabelGap = 54;

type TimelineRangeGestureKind = Exclude<TimelineGestureKind, "noop" | "pan-viewport">;
type TimelineOutOfViewKind = "playhead" | "selection" | "viewport";

interface RangeIntent {
  readonly focusMs: number;
  readonly freePlacement: boolean;
}

interface RangeStartIntent extends RangeIntent {
  readonly anchorMs: number;
  readonly kind: TimelineRangeGestureKind;
  readonly pointerId: number;
}

interface PointerGestureState {
  readonly anchorMs: number;
  readonly controlKey: boolean;
  readonly kind: Exclude<TimelineGestureKind, "noop">;
  readonly panStart?: TimelineViewportPanStart;
  readonly pointerId: number;
  readonly shiftKey: boolean;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly freePlacement: boolean;
  lastClientX: number;
  lastClientY: number;
  lastFocusMs: number;
  moved: boolean;
  rangeStarted: boolean;
  viewRange: TimeRangeV1;
}

interface SavedBandView {
  readonly annotation: GoldAnnotationV1;
  readonly height: number;
  readonly y: number;
}

interface OutOfViewIndicator {
  readonly direction: "above" | "below";
  readonly kind: TimelineOutOfViewKind;
  readonly x: number;
}

const props = defineProps<{
  chart: ManiaChart;
  chartEndMs: number;
  disabled?: boolean;
  mainViewportRange: TimeRangeV1;
  playheadMs: number;
  savedAnnotations: readonly GoldAnnotationV1[];
  selection?: TimeRangeV1;
  viewRange: TimeRangeV1;
}>();

const emit = defineEmits<{
  "annotation-seek": [annotation: GoldAnnotationV1];
  "gesture-active": [active: boolean];
  "range-cancel": [];
  "range-commit": [intent: RangeIntent];
  "range-preview": [intent: RangeIntent];
  "range-start": [intent: RangeStartIntent];
  seek: [timeMs: number];
  "view-range-change": [range: TimeRangeV1];
  "viewport-pan": [range: TimeRangeV1];
}>();

const root = ref<HTMLElement>();
const hoverY = ref<number>();
const hoverControlKey = ref(false);
const activePointer = ref<PointerGestureState>();
let pointerFrame: number | undefined;
let lastPointerFrameTimestamp: number | undefined;
let pendingWheelFrame: number | undefined;
let pendingWheelZoomDelta = 0;
let pendingWheelAnchorY = viewBoxHeight / 2;

const mapping = computed(() => ({
  height: viewBoxHeight,
  viewRange: props.viewRange,
}));

const densityPath = computed(() =>
  createOverviewDensityPath(props.chart, {
    endMs: props.viewRange.endMs,
    height: viewBoxHeight,
    orientation: "vertical",
    startMs: props.viewRange.startMs,
    width: densityWidth,
  }).path,
);

const selectionGeometry = computed(() =>
  props.selection
    ? timelineRangeVerticalGeometry(props.selection, mapping.value, minimumBandHeight)
    : undefined,
);

const selectionOutOfView = computed(() =>
  props.selection ? timelineRangeOutOfView(props.selection, props.viewRange) : undefined,
);

const mainViewportGeometry = computed(() =>
  timelineRangeVerticalGeometry(props.mainViewportRange, mapping.value, minimumBandHeight),
);

const mainViewportOutOfView = computed(() =>
  timelineRangeOutOfView(props.mainViewportRange, props.viewRange),
);

const savedBands = computed<readonly SavedBandView[]>(() =>
  props.savedAnnotations.flatMap((annotation) => {
    const geometry = timelineRangeVerticalGeometry(
      annotation.range,
      mapping.value,
      minimumBandHeight,
    );
    return geometry
      ? [
          {
            annotation,
            height: geometry.height,
            y: geometry.y,
          },
        ]
      : [];
  }),
);

const playheadY = computed(() =>
  props.playheadMs >= props.viewRange.startMs && props.playheadMs <= props.viewRange.endMs
    ? timelineYFromSourceTime(props.playheadMs, mapping.value)
    : undefined,
);

const playheadOutOfView = computed<"above" | "below" | undefined>(() => {
  if (playheadY.value !== undefined) return undefined;
  if (props.playheadMs > props.viewRange.endMs) return "above";
  if (props.playheadMs < props.viewRange.startMs) return "below";
  return undefined;
});

const outOfViewIndicators = computed<readonly OutOfViewIndicator[]>(() => {
  const indicators: OutOfViewIndicator[] = [];
  pushRangeIndicator(
    indicators,
    "viewport",
    mainViewportGeometry.value,
    mainViewportOutOfView.value,
    12,
  );
  pushRangeIndicator(
    indicators,
    "selection",
    selectionGeometry.value,
    selectionOutOfView.value,
    32,
  );
  pushOutOfViewIndicator(indicators, "playhead", playheadOutOfView.value, 52);
  return indicators;
});

const selectionLabels = computed(() => {
  const range = props.selection;
  if (!range) return undefined;
  const labels = formatTimelineRangeLabels(range);
  const geometry = selectionGeometry.value;
  if (!geometry) {
    return {
      end: labels.end,
      mode: "caption" as const,
      start: labels.start,
    };
  }
  const separated = Math.abs(geometry.startY - geometry.endY) >= normalLabelGap;
  return separated
    ? {
        end: labels.end,
        endY: geometry.endY,
        mode: "edge" as const,
        start: labels.start,
        startY: geometry.startY,
      }
    : {
        end: labels.end,
        mode: "caption" as const,
        start: labels.start,
        y: Math.min(
          viewBoxHeight - 42,
          Math.max(42, (geometry.startY + geometry.endY) / 2),
        ),
      };
});

const accessibleDescription = computed(() => {
  const visibleStart = formatTimelineRangeLabels(props.viewRange).start;
  const visibleEnd = formatTimelineRangeLabels(props.viewRange).end;
  const selection = selectionLabels.value;
  const selectionText = selection
    ? `Selection starts at ${selection.start} and ends at ${selection.end}.`
    : "No active selection.";
  return `Visible timeline range starts at ${visibleStart} and ends at ${visibleEnd}. ${selectionText}`;
});

const rootClass = computed(() => ({
  "annotation-timeline": true,
  "is-disabled": Boolean(props.disabled),
  "is-dragging": Boolean(activePointer.value?.moved),
  "is-grab-hover": hoverGestureKind.value === "pan-viewport",
  "is-range-hover": isRangeGestureKind(hoverGestureKind.value),
  "is-resize-hover":
    hoverGestureKind.value === "resize-start" || hoverGestureKind.value === "resize-end",
}));

const hoverGestureKind = computed<TimelineGestureKind | undefined>(() => {
  if (hoverY.value === undefined || activePointer.value || props.disabled) return undefined;
  return classifyTimelineGesture(
    timelineGestureSnapshot(hoverY.value, {
      controlKey: hoverControlKey.value,
      shiftKey: false,
    }),
  );
});

watch(
  () => props.viewRange,
  (range) => {
    if (!activePointer.value) return;
    activePointer.value.viewRange = range;
  },
);

watch(
  () => props.disabled,
  (disabled) => {
    if (!disabled) return;
    cancelPointerGesture();
    cancelWheelFrame();
  },
);

watch(
  () => props.chart,
  () => {
    cancelPointerGesture();
    cancelWheelFrame();
  },
);

onMounted(() => {
  root.value?.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("keydown", handleWindowKeydown);
});

onBeforeUnmount(() => {
  root.value?.removeEventListener("wheel", handleWheel);
  window.removeEventListener("keydown", handleWindowKeydown);
  cancelPointerGesture();
  cancelPointerFrame();
  cancelWheelFrame();
});

function handlePointerDown(event: PointerEvent): void {
  if (props.disabled || event.button !== 0) return;

  const y = localTimelineY(event);
  const kind = classifyTimelineGesture(
    timelineGestureSnapshot(y, {
      controlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
    }),
  );

  if (kind === "noop") return;
  if (event.cancelable) event.preventDefault();

  root.value?.focus({ preventScroll: true });
  root.value?.setPointerCapture(event.pointerId);

  const anchorMs = timelineSourceTimeFromClampedY(y, mapping.value);
  activePointer.value = {
    anchorMs,
    controlKey: event.ctrlKey,
    freePlacement: event.altKey,
    kind,
    ...(kind === "pan-viewport"
      ? {
          panStart: beginTimelineViewportPan(
            anchorMs,
            props.mainViewportRange,
            props.chartEndMs,
          ),
        }
      : {}),
    lastClientX: event.clientX,
    lastClientY: event.clientY,
    lastFocusMs: anchorMs,
    moved: false,
    pointerId: event.pointerId,
    rangeStarted: false,
    shiftKey: event.shiftKey,
    startClientX: event.clientX,
    startClientY: event.clientY,
    viewRange: props.viewRange,
  };
  lastPointerFrameTimestamp = undefined;
  emit("gesture-active", true);
}

function handlePointerMove(event: PointerEvent): void {
  const active = activePointer.value;
  if (!active) {
    hoverY.value = localTimelineY(event);
    hoverControlKey.value = event.ctrlKey;
    return;
  }
  if (active.pointerId !== event.pointerId) return;

  active.lastClientX = event.clientX;
  active.lastClientY = event.clientY;
  if (
    Math.hypot(
      event.clientX - active.startClientX,
      event.clientY - active.startClientY,
    ) >= pointerDragThresholdPx
  ) {
    active.moved = true;
  }
  if (active.moved) queuePointerFrame();
}

function handlePointerUp(event: PointerEvent): void {
  const active = activePointer.value;
  if (!active || active.pointerId !== event.pointerId) return;

  active.lastClientX = event.clientX;
  active.lastClientY = event.clientY;
  if (
    Math.hypot(
      event.clientX - active.startClientX,
      event.clientY - active.startClientY,
    ) >= pointerDragThresholdPx
  ) {
    active.moved = true;
  }

  if (active.moved) flushPointerFrame(performance.now());
  if (active.moved && isRangeGestureKind(active.kind)) {
    emit("range-commit", {
      focusMs: active.lastFocusMs,
      freePlacement: active.freePlacement,
    });
  } else if (!active.moved && !active.controlKey && !active.shiftKey) {
    emit("seek", timelineSourceTimeFromClampedY(localTimelineY(event), mapping.value));
  }
  finishPointerGesture();
}

function handlePointerCancel(event: PointerEvent): void {
  const active = activePointer.value;
  if (!active || active.pointerId !== event.pointerId) return;
  cancelPointerGesture();
}

function handleLostPointerCapture(event: PointerEvent): void {
  const active = activePointer.value;
  if (!active || active.pointerId !== event.pointerId) return;
  cancelPointerGesture();
}

function handlePointerLeave(): void {
  if (!activePointer.value) hoverY.value = undefined;
}

function handleContextMenu(event: MouseEvent): void {
  if (!event.ctrlKey) return;
  event.preventDefault();
  event.stopPropagation();
}

function handleSavedAnnotationClick(annotation: GoldAnnotationV1): void {
  if (props.disabled || activePointer.value) return;
  emit("annotation-seek", annotation);
}

function handleRootKeydown(event: KeyboardEvent): void {
  if (props.disabled || activePointer.value || event.defaultPrevented) return;
  if (event.key === "0") {
    event.preventDefault();
    emitViewRangeChange(fitTimelineViewRange(props.chartEndMs));
    return;
  }
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    emitKeyboardZoom(keyboardZoomDelta);
    return;
  }
  if (event.key === "-") {
    event.preventDefault();
    emitKeyboardZoom(-keyboardZoomDelta);
  }
}

function handleWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !activePointer.value) return;
  event.preventDefault();
  cancelPointerGesture();
}

function handleWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return;
  if (event.cancelable) event.preventDefault();
  if (props.disabled || activePointer.value) return;

  pendingWheelAnchorY = localTimelineY(event);
  pendingWheelZoomDelta += normalizeTimelineWheelZoomDelta({
    ctrlKey: event.ctrlKey,
    deltaMode: event.deltaMode,
    deltaY: event.deltaY,
  });
  if (pendingWheelFrame !== undefined) return;
  pendingWheelFrame = requestAnimationFrame(() => {
    pendingWheelFrame = undefined;
    const zoomDelta = pendingWheelZoomDelta;
    pendingWheelZoomDelta = 0;
    emitViewRangeChange(
      zoomTimelineViewRangeAtY({
        anchorY: pendingWheelAnchorY,
        chartEndMs: props.chartEndMs,
        height: viewBoxHeight,
        viewRange: props.viewRange,
        zoomDelta,
      }),
    );
  });
}

function queuePointerFrame(): void {
  if (pointerFrame !== undefined) return;
  pointerFrame = requestAnimationFrame(applyPointerFrame);
}

function flushPointerFrame(timestamp: number): void {
  cancelPointerFrame();
  applyPointerFrame(timestamp);
}

function applyPointerFrame(timestamp: number): void {
  pointerFrame = undefined;
  const active = activePointer.value;
  if (!active?.moved) return;

  const elapsedMs =
    lastPointerFrameTimestamp === undefined
      ? 16.7
      : Math.min(64, Math.max(0, timestamp - lastPointerFrameTimestamp));
  lastPointerFrameTimestamp = timestamp;

  const pointerY = localTimelineYFromClientY(active.lastClientY);
  const nextViewRange = applyTimelineEdgePan({
    chartEndMs: props.chartEndMs,
    edgeSizePx: edgeHitHeight(),
    elapsedMs,
    height: viewBoxHeight,
    pointerY,
    viewRange: active.viewRange,
  });
  active.viewRange = nextViewRange;
  emitViewRangeChange(nextViewRange);

  const focusMs = timelineSourceTimeFromClampedY(pointerY, {
    height: viewBoxHeight,
    viewRange: active.viewRange,
  });
  active.lastFocusMs = focusMs;

  if (isRangeGestureKind(active.kind)) {
    ensureRangeGestureStarted(active);
    emit("range-preview", {
      focusMs,
      freePlacement: active.freePlacement,
    });
  } else if (active.panStart) {
    emit(
      "viewport-pan",
      panTimelineViewportRange(focusMs, active.panStart, props.chartEndMs),
    );
  }

  if (activePointer.value && shouldContinuePointerEdgePan(active)) queuePointerFrame();
}

function ensureRangeGestureStarted(active: PointerGestureState): void {
  if (active.rangeStarted || !isRangeGestureKind(active.kind)) return;
  active.rangeStarted = true;
  emit("range-start", {
    anchorMs: active.anchorMs,
    focusMs: active.lastFocusMs,
    freePlacement: active.freePlacement,
    kind: active.kind,
    pointerId: active.pointerId,
  });
}

function cancelPointerGesture(): void {
  const active = activePointer.value;
  if (!active) return;
  cancelPointerFrame();
  if (active.rangeStarted) emit("range-cancel");
  finishPointerGesture();
}

function finishPointerGesture(): void {
  const active = activePointer.value;
  if (!active) return;
  activePointer.value = undefined;
  if (root.value?.hasPointerCapture(active.pointerId)) {
    root.value.releasePointerCapture(active.pointerId);
  }
  lastPointerFrameTimestamp = undefined;
  emit("gesture-active", false);
}

function cancelPointerFrame(): void {
  if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
  pointerFrame = undefined;
}

function cancelWheelFrame(): void {
  if (pendingWheelFrame !== undefined) cancelAnimationFrame(pendingWheelFrame);
  pendingWheelFrame = undefined;
  pendingWheelZoomDelta = 0;
}

function emitKeyboardZoom(zoomDelta: number): void {
  const anchorMs = timelineZoomAnchorMs(props.viewRange, props.playheadMs);
  emitViewRangeChange(
    zoomTimelineViewRangeAtTime({
      anchorMs,
      chartEndMs: props.chartEndMs,
      viewRange: props.viewRange,
      zoomDelta,
    }),
  );
}

function emitViewRangeChange(range: TimeRangeV1): void {
  if (sameRange(range, props.viewRange)) return;
  emit("view-range-change", range);
}

function shouldContinuePointerEdgePan(active: PointerGestureState): boolean {
  if (!active.moved) return false;
  const pointerY = localTimelineYFromClientY(active.lastClientY);
  const edgeSize = edgeHitHeight();
  return pointerY <= edgeSize || pointerY >= viewBoxHeight - edgeSize;
}

function localTimelineY(event: Pick<MouseEvent, "clientY">): number {
  return localTimelineYFromClientY(event.clientY);
}

function localTimelineYFromClientY(clientY: number): number {
  const rect = root.value?.getBoundingClientRect();
  if (!rect) return viewBoxHeight / 2;
  return ((clientY - rect.top) / Math.max(1, rect.height)) * viewBoxHeight;
}

function edgeHitHeight(): number {
  const renderedHeight = root.value?.getBoundingClientRect().height ?? viewBoxHeight;
  return timelineEdgeHitHeight(Math.max(1, renderedHeight), viewBoxHeight);
}

function bandYStyle(y: number): string {
  return `${(y / viewBoxHeight) * 100}%`;
}

function edgeLabelYStyle(y: number): string {
  return `clamp(12px, ${bandYStyle(y)}, calc(100% - 12px))`;
}

function indicatorPoints(indicator: OutOfViewIndicator): string {
  if (indicator.direction === "above") {
    return `${indicator.x - 4},8 ${indicator.x + 4},8 ${indicator.x},2`;
  }
  return `${indicator.x - 4},992 ${indicator.x + 4},992 ${indicator.x},998`;
}

function pushOutOfViewIndicator(
  indicators: OutOfViewIndicator[],
  kind: TimelineOutOfViewKind,
  direction: "above" | "below" | undefined,
  x: number,
): void {
  if (!direction) return;
  indicators.push({ direction, kind, x });
}

function pushRangeIndicator(
  indicators: OutOfViewIndicator[],
  kind: Extract<TimelineOutOfViewKind, "selection" | "viewport">,
  geometry: { readonly clippedEnd: boolean; readonly clippedStart: boolean } | undefined,
  outOfView: "above" | "below" | undefined,
  x: number,
): void {
  if (outOfView) {
    pushOutOfViewIndicator(indicators, kind, outOfView, x);
    return;
  }
  if (geometry?.clippedEnd) pushOutOfViewIndicator(indicators, kind, "above", x);
  if (geometry?.clippedStart) pushOutOfViewIndicator(indicators, kind, "below", x);
}

function sameRange(left: TimeRangeV1, right: TimeRangeV1): boolean {
  return left.startMs === right.startMs && left.endMs === right.endMs;
}

function isRangeGestureKind(
  kind: TimelineGestureKind | undefined,
): kind is TimelineRangeGestureKind {
  return (
    kind === "create-range" ||
    kind === "move-range" ||
    kind === "resize-end" ||
    kind === "resize-start"
  );
}

function timelineGestureSnapshot(
  y: number,
  modifiers: { readonly controlKey: boolean; readonly shiftKey: boolean },
) {
  const rangeHit = hitTimelineRangeTarget(y, selectionGeometry.value, edgeHitHeight());
  return {
    controlKey: modifiers.controlKey,
    rangeBodyHit: timelineRangeBodyContainsY(y, selectionGeometry.value),
    ...(rangeHit ? { rangeHit } : {}),
    shiftKey: modifiers.shiftKey,
  };
}
</script>

<template>
  <fieldset
    ref="root"
    :class="rootClass"
    tabindex="0"
    :aria-disabled="disabled ? 'true' : undefined"
    aria-label="Annotation timeline. Bottom is song start, top is song end."
    aria-describedby="annotation-timeline-description"
    @contextmenu="handleContextMenu"
    @keydown="handleRootKeydown"
    @lostpointercapture="handleLostPointerCapture"
    @pointercancel="handlePointerCancel"
    @pointerdown="handlePointerDown"
    @pointerleave="handlePointerLeave"
    @pointermove="handlePointerMove"
    @pointerup="handlePointerUp"
  >
    <p id="annotation-timeline-description" class="annotation-timeline__sr-only">
      {{ accessibleDescription }}
    </p>
    <svg
      class="annotation-timeline__svg"
      viewBox="0 0 64 1000"
      preserveAspectRatio="none"
      role="img"
      aria-hidden="true"
    >
      <title>Vertical annotation timeline</title>
      <rect class="annotation-timeline__ground" width="64" height="1000" />
      <path
        class="annotation-timeline__density"
        :d="densityPath"
        :transform="`translate(5 0)`"
      />
      <rect
        v-if="mainViewportGeometry"
        class="annotation-timeline__viewport-window"
        x="0"
        :y="mainViewportGeometry.y"
        width="64"
        :height="mainViewportGeometry.height"
      />
      <!-- biome-ignore lint/a11y/noStaticElementInteractions: Saved ranges are also available in the keyboard-accessible annotation list; the timeline band is a direct seek affordance. -->
      <rect
        v-for="band in savedBands"
        :key="band.annotation.id"
        class="annotation-timeline__saved-band"
        :x="savedBandX"
        :y="band.y"
        :width="savedBandWidth"
        :height="band.height"
        @click.stop="handleSavedAnnotationClick(band.annotation)"
        @pointerdown.stop
      />
      <g v-if="selectionGeometry" class="annotation-timeline__selection">
        <rect
          class="annotation-timeline__selection-highlight"
          :x="selectionX"
          :y="selectionGeometry.y"
          :width="selectionWidth"
          :height="selectionGeometry.height"
        />
        <rect
          class="annotation-timeline__selection-hit-zone annotation-timeline__selection-hit-zone--end"
          x="0"
          :y="selectionGeometry.endY - edgeHitHeight()"
          width="64"
          :height="edgeHitHeight() * 2"
        />
        <rect
          class="annotation-timeline__selection-hit-zone annotation-timeline__selection-hit-zone--body"
          x="0"
          :y="selectionGeometry.y"
          width="64"
          :height="selectionGeometry.height"
        />
        <rect
          class="annotation-timeline__selection-hit-zone annotation-timeline__selection-hit-zone--start"
          x="0"
          :y="selectionGeometry.startY - edgeHitHeight()"
          width="64"
          :height="edgeHitHeight() * 2"
        />
      </g>
      <line
        v-if="playheadY !== undefined"
        class="annotation-timeline__playhead"
        x1="0"
        :y1="playheadY"
        x2="64"
        :y2="playheadY"
      />
      <polygon
        v-for="indicator in outOfViewIndicators"
        :key="`${indicator.kind}-${indicator.direction}`"
        class="annotation-timeline__out-of-view"
        :class="`annotation-timeline__out-of-view--${indicator.kind}`"
        :points="indicatorPoints(indicator)"
      />
    </svg>
    <div
      v-if="selectionLabels?.mode === 'edge'"
      class="annotation-timeline__selection-label-layer"
      aria-hidden="true"
    >
      <span
        class="annotation-timeline__selection-label annotation-timeline__selection-label--end"
        :style="{ top: edgeLabelYStyle(selectionLabels.endY) }"
      >
        {{ selectionLabels.end }}
      </span>
      <span
        class="annotation-timeline__selection-label annotation-timeline__selection-label--start"
        :style="{ top: edgeLabelYStyle(selectionLabels.startY) }"
      >
        {{ selectionLabels.start }}
      </span>
    </div>
    <div
      v-else-if="selectionLabels"
      class="annotation-timeline__selection-caption"
      :style="{ top: selectionLabels.y === undefined ? undefined : bandYStyle(selectionLabels.y) }"
      aria-hidden="true"
    >
      <span>{{ selectionLabels.end }}</span>
      <span>{{ selectionLabels.start }}</span>
    </div>
  </fieldset>
</template>

<style scoped>
.annotation-timeline {
  position: relative;
  inline-size: 64px;
  block-size: 100%;
  min-block-size: 0;
  min-inline-size: 0;
  margin: 0;
  padding: 0;
  color: var(--ink);
  background: var(--surface-1);
  border-block: 0;
  border-inline: 1px solid var(--seam);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.annotation-timeline:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: -2px;
}

.annotation-timeline.is-disabled {
  cursor: not-allowed;
  opacity: 0.58;
}

.annotation-timeline.is-dragging,
.annotation-timeline.is-grab-hover {
  cursor: grab;
}

.annotation-timeline.is-dragging {
  cursor: grabbing;
}

.annotation-timeline.is-range-hover {
  cursor: grab;
}

.annotation-timeline.is-resize-hover {
  cursor: ns-resize;
}

.annotation-timeline__svg {
  display: block;
  inline-size: 100%;
  block-size: 100%;
}

.annotation-timeline__ground {
  fill: var(--surface-1);
}

.annotation-timeline__density {
  fill: oklch(78% 0.01 255 / 0.3);
}

.annotation-timeline__viewport-window {
  fill: oklch(72% 0.14 255 / 0.12);
  stroke: oklch(72% 0.14 255 / 0.55);
  stroke-width: 1;
}

.annotation-timeline__saved-band {
  fill: oklch(76% 0.15 153 / 0.32);
}

.annotation-timeline__selection-highlight {
  fill: oklch(72% 0.14 255 / 0.26);
}

.annotation-timeline__selection-hit-zone {
  fill: transparent;
}

.annotation-timeline__playhead {
  stroke: var(--danger);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

.annotation-timeline__out-of-view {
  fill: oklch(78% 0.01 255 / 0.56);
}

.annotation-timeline__out-of-view--selection {
  fill: oklch(72% 0.14 255 / 0.8);
}

.annotation-timeline__out-of-view--playhead {
  fill: oklch(72% 0.17 25 / 0.85);
}

.annotation-timeline__selection-label-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.annotation-timeline__selection-label,
.annotation-timeline__selection-caption {
  position: absolute;
  inset-inline: 4px;
  border-radius: 3px;
  background: oklch(17% 0.012 255 / 0.92);
  box-shadow: 0 0 0 1px var(--line-strong);
  color: var(--ink);
  font-family: var(--font-data);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  line-height: 1;
  text-align: center;
}

.annotation-timeline__selection-label {
  padding-block: 3px;
  transform: translateY(-50%);
}

.annotation-timeline__selection-caption {
  display: grid;
  gap: 3px;
  padding-block: 4px;
  pointer-events: none;
  transform: translateY(-50%);
}

.annotation-timeline__sr-only {
  position: absolute;
  overflow: hidden;
  clip: rect(0 0 0 0);
  inline-size: 1px;
  block-size: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  white-space: nowrap;
}

@media (max-width: 1160px) {
  .annotation-timeline {
    inline-size: 56px;
  }
}

@media (max-width: 920px) {
  .annotation-timeline {
    inline-size: 48px;
  }

  .annotation-timeline__selection-label,
  .annotation-timeline__selection-caption {
    inset-inline: 3px;
    font-size: 8px;
  }
}
</style>
