<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";

/**
 * The boundary beside a side pane, as the WAI-ARIA window splitter: a focusable separator whose
 * value is the pane's width. Drag or Left/Right (Shift: larger steps) resize it, Home and End go to
 * its narrowest and widest, Enter collapses and restores it, and a double-click restores its
 * default width. Dragging well past the narrowest width collapses the pane. A mouse press does not
 * take keyboard focus, so the workspace shortcuts keep the arrows and Enter after a drag.
 */
const props = withDefaults(
  defineProps<{
    /** Id of the pane this boundary resizes. */
    controls: string;
    label: string;
    size: number;
    min: number;
    max: number;
    collapsed?: boolean;
    /** `start`: the pane is before the boundary (left); `end`: after it (right). */
    edge: "start" | "end";
    step?: number;
  }>(),
  { collapsed: false, step: 16 },
);

const emit = defineEmits<{
  resize: [size: number];
  collapse: [collapsed: boolean];
  reset: [];
}>();

/** How far past the narrowest width a drag goes before the pane collapses. */
const collapseReachPx = 56;

const dragging = ref(false);
let start: { x: number; size: number; pointerId: number } | undefined;
let pending: number | undefined;
let frame = 0;

const direction = computed(() => (props.edge === "start" ? 1 : -1));
const valueText = computed(() =>
  props.collapsed ? `${props.label} hidden` : `${props.label} ${props.size} pixels wide`,
);

onBeforeUnmount(() => cancelAnimationFrame(frame));

/** Resizes at most once per display frame; each resize relays out the panes. */
function request(size: number) {
  pending = size;
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    if (pending === undefined) return;
    const next = pending;
    pending = undefined;
    apply(next);
  });
}

function apply(size: number) {
  if (size < props.min - collapseReachPx) {
    if (!props.collapsed) emit("collapse", true);
    return;
  }
  if (props.collapsed) emit("collapse", false);
  emit("resize", Math.min(props.max, Math.max(props.min, Math.round(size))));
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  start = {
    x: event.clientX,
    size: props.collapsed ? props.min - collapseReachPx : props.size,
    pointerId: event.pointerId,
  };
  dragging.value = true;
}

function onPointerMove(event: PointerEvent) {
  if (!start || event.pointerId !== start.pointerId) return;
  request(start.size + (event.clientX - start.x) * direction.value);
}

function onPointerUp(event: PointerEvent) {
  if (!start || event.pointerId !== start.pointerId) return;
  start = undefined;
  dragging.value = false;
}

function onKeydown(event: KeyboardEvent) {
  const step = event.shiftKey ? props.step * 4 : props.step;
  let handled = true;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const grow = (event.key === "ArrowRight" ? 1 : -1) * direction.value;
    if (props.collapsed) {
      if (grow > 0) emit("collapse", false);
    } else if (grow < 0 && props.size <= props.min) emit("collapse", true);
    else emit("resize", Math.min(props.max, Math.max(props.min, props.size + grow * step)));
  } else if (event.key === "Home") {
    if (props.collapsed) emit("collapse", false);
    emit("resize", props.min);
  } else if (event.key === "End") {
    if (props.collapsed) emit("collapse", false);
    emit("resize", props.max);
  } else if (event.key === "Enter") {
    emit("collapse", !props.collapsed);
  } else handled = false;
  // The workspaces use these keys as shortcuts on the window; here they belong to the boundary.
  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
}
</script>

<template>
  <!-- biome-ignore lint/a11y/useSemanticElements: The APG window splitter is a focusable separator with a value and a pointer-sized grab area, which an hr does not give. -->
  <div
    class="pane-splitter"
    :class="[`pane-splitter--${edge}`, { 'is-dragging': dragging, 'is-collapsed': collapsed }]"
    role="separator"
    tabindex="0"
    aria-orientation="vertical"
    :aria-controls="controls"
    :aria-label="`Resize ${label.toLowerCase()}`"
    :aria-valuemin="0"
    :aria-valuemax="max"
    :aria-valuenow="collapsed ? 0 : size"
    :aria-valuetext="valueText"
    :title="`Drag to resize ${label.toLowerCase()}; double-click restores its width`"
    @mousedown.prevent
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @lostpointercapture="onPointerUp"
    @keydown="onKeydown"
    @dblclick="emit('reset')"
  ></div>
</template>
