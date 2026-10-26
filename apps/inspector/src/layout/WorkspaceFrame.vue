<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import WorkspaceModeSwitch from "../WorkspaceModeSwitch.vue";
import type { WorkspaceMode } from "../workspace-mode";
import PaneSplitter from "./PaneSplitter.vue";
import { type PaneSpec, usePaneLayout } from "./pane-layout";

export type MobilePanel = "source" | "preview" | "details";

/**
 * The shell every open workspace shares: a toolbar, an optional left pane, the main view, an
 * optional right pane, and a status bar. Side panes are resized at their boundaries and hidden
 * from the toolbar; their widths and hidden states are kept per workspace in the browser. At
 * 920 px and below a view switch shows one of the three at a time instead.
 */
const props = withDefaults(
  defineProps<{
    layoutKey: string;
    mode?: WorkspaceMode | undefined;
    modeDisabled?: boolean;
    left?: PaneSpec;
    right?: PaneSpec;
    /** Given, the left pane's hidden state belongs to the parent (`v-model:left-collapsed`). */
    leftCollapsed?: boolean | undefined;
    /** Given, narrow windows switch between the panes (`v-model:mobile-panel`). */
    mobilePanel?: MobilePanel | undefined;
    mobileLabel?: string;
  }>(),
  { leftCollapsed: undefined, mobilePanel: undefined, mobileLabel: "Workspace views" },
);

const emit = defineEmits<{
  "change-mode": [mode: WorkspaceMode];
  "update:leftCollapsed": [collapsed: boolean];
  "update:mobilePanel": [panel: MobilePanel];
}>();

const specs = [props.left, props.right].filter((spec): spec is PaneSpec => Boolean(spec));
const layout = usePaneLayout(props.layoutKey, specs);

/** At 920 px and below the panes are not side by side; the view switch shows one at a time. */
const narrowQuery =
  typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 920px)") : undefined;
const narrow = ref(narrowQuery?.matches ?? false);
const onNarrowChange = (event: MediaQueryListEvent) => {
  narrow.value = event.matches;
};
narrowQuery?.addEventListener("change", onNarrowChange);
onBeforeUnmount(() => narrowQuery?.removeEventListener("change", onNarrowChange));

function paneState(spec: PaneSpec | undefined) {
  return spec ? layout.state.value[spec.id] : undefined;
}

const leftHidden = computed(() =>
  props.leftCollapsed !== undefined
    ? props.leftCollapsed
    : Boolean(paneState(props.left)?.collapsed),
);
const rightHidden = computed(() => Boolean(paneState(props.right)?.collapsed));

function setCollapsed(spec: PaneSpec, collapsed: boolean) {
  if (spec === props.left && props.leftCollapsed !== undefined) {
    emit("update:leftCollapsed", collapsed);
    return;
  }
  layout.setCollapsed(spec.id, collapsed);
}

function resize(spec: PaneSpec, size: number) {
  layout.resize(spec.id, size);
  setCollapsed(spec, false);
}

function reset(spec: PaneSpec) {
  layout.reset(spec.id);
  setCollapsed(spec, false);
}

const columns = computed(() => {
  if (narrow.value) return "minmax(0, 1fr)";
  const width = (spec: PaneSpec | undefined, hidden: boolean) =>
    spec
      ? [hidden ? "0px" : `min(${paneState(spec)?.size ?? spec.defaultSize}px, 38vw)`, "1px"]
      : [];
  const left = width(props.left, leftHidden.value);
  const right = width(props.right, rightHidden.value).reverse();
  return [...left, "minmax(0, 1fr)", ...right].join(" ");
});

/**
 * Grid columns of the body's children, placed explicitly: a pane hidden with `display: none`
 * leaves the grid, and auto-placement would shift the main view into the pane's column.
 */
const placement = computed(() => {
  if (narrow.value) return {};
  const main = props.left ? 3 : 1;
  return { left: 1, leftSplitter: 2, main, rightSplitter: main + 1, right: main + 2 };
});

/** Whether a pane is on screen: by its hidden state on desktop, by the view switch when narrow. */
function paneShown(side: "left" | "right"): boolean {
  if (narrow.value && props.mobilePanel !== undefined)
    return props.mobilePanel === (side === "left" ? "source" : "details");
  return side === "left" ? !leftHidden.value : !rightHidden.value;
}

const mainShown = computed(
  () => !narrow.value || props.mobilePanel === undefined || props.mobilePanel === "preview",
);

/** Shows a hidden side pane, for a control inside it that must take focus; true if it was hidden. */
function showPane(side: "left" | "right"): boolean {
  if (narrow.value && props.mobilePanel !== undefined) {
    const panel = side === "left" ? "source" : "details";
    if (props.mobilePanel === panel) return false;
    emit("update:mobilePanel", panel);
    return true;
  }
  const spec = side === "left" ? props.left : props.right;
  const hidden = side === "left" ? leftHidden.value : rightHidden.value;
  if (!spec || !hidden) return false;
  setCollapsed(spec, false);
  return true;
}

defineExpose({ showPane });

const mobilePanels: { key: MobilePanel; label: string }[] = [
  { key: "source", label: "Source" },
  { key: "preview", label: "Preview" },
  { key: "details", label: "Details" },
];

const toggleLabel = (spec: PaneSpec, hidden: boolean) =>
  `${hidden ? "Show" : "Hide"} ${spec.label.toLowerCase()}`;
</script>

<template>
  <div
    class="workspace-frame"
    :class="{
      'is-narrow': narrow,
      'is-left-hidden': left && leftHidden,
      'is-right-hidden': right && rightHidden,
    }"
  >
    <header class="frame-toolbar">
      <div class="frame-toolbar-start">
        <span class="brand-glyph" aria-hidden="true" title="Beatmap Lens"></span>
        <span class="sr-only">Beatmap Lens</span>
        <slot name="mode">
          <WorkspaceModeSwitch
            v-if="mode"
            :model-value="mode"
            :disabled="modeDisabled"
            @update:model-value="emit('change-mode', $event)"
          />
        </slot>
      </div>
      <slot name="toolbar"></slot>
      <div class="frame-toolbar-end">
        <slot name="toolbar-end"></slot>
        <fieldset v-if="(left || right) && !narrow" class="pane-toggles" aria-label="Panels">
          <button
            v-if="left"
            type="button"
            class="tool-button tool-button--icon pane-toggle"
            :class="{ 'is-shown': !leftHidden }"
            :aria-expanded="!leftHidden"
            :aria-controls="left.id"
            :title="toggleLabel(left, leftHidden)"
            @click="setCollapsed(left, !leftHidden)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
              <path class="pane-toggle-fill" d="M2 3h4v10H2z" />
              <path d="M6.5 2.5v11" />
            </svg>
            <span class="sr-only">{{ toggleLabel(left, leftHidden) }}</span>
          </button>
          <button
            v-if="right"
            type="button"
            class="tool-button tool-button--icon pane-toggle"
            :class="{ 'is-shown': !rightHidden }"
            :aria-expanded="!rightHidden"
            :aria-controls="right.id"
            :title="toggleLabel(right, rightHidden)"
            @click="setCollapsed(right, !rightHidden)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
              <path class="pane-toggle-fill" d="M10 3h4v10h-4z" />
              <path d="M9.5 2.5v11" />
            </svg>
            <span class="sr-only">{{ toggleLabel(right, rightHidden) }}</span>
          </button>
        </fieldset>
      </div>
    </header>

    <nav v-if="narrow && mobilePanel !== undefined" class="frame-view-switch" :aria-label="mobileLabel">
      <button
        v-for="panel in mobilePanels"
        :key="panel.key"
        type="button"
        :class="{ 'is-active': mobilePanel === panel.key }"
        :aria-pressed="mobilePanel === panel.key"
        @click="emit('update:mobilePanel', panel.key)"
      >
        {{ panel.label }}
      </button>
    </nav>

    <div class="frame-body" :style="{ gridTemplateColumns: columns }">
      <template v-if="left">
        <aside
          v-show="paneShown('left')"
          :id="left.id"
          class="frame-pane frame-pane--left"
          :style="{ gridColumn: placement.left }"
          :aria-label="left.label"
        >
          <slot name="left"></slot>
        </aside>
        <PaneSplitter
          v-if="!narrow"
          :style="{ gridColumn: placement.leftSplitter }"
          :controls="left.id"
          :label="left.label"
          :size="paneState(left)?.size ?? left.defaultSize"
          :min="left.min"
          :max="left.max"
          :collapsed="leftHidden"
          edge="start"
          @resize="resize(left, $event)"
          @collapse="setCollapsed(left, $event)"
          @reset="reset(left)"
        />
      </template>
      <div v-show="mainShown" class="frame-main" :style="{ gridColumn: placement.main }">
        <slot name="main"></slot>
      </div>
      <template v-if="right">
        <PaneSplitter
          v-if="!narrow"
          :style="{ gridColumn: placement.rightSplitter }"
          :controls="right.id"
          :label="right.label"
          :size="paneState(right)?.size ?? right.defaultSize"
          :min="right.min"
          :max="right.max"
          :collapsed="rightHidden"
          edge="end"
          @resize="resize(right, $event)"
          @collapse="setCollapsed(right, $event)"
          @reset="reset(right)"
        />
        <aside
          v-show="paneShown('right')"
          :id="right.id"
          class="frame-pane frame-pane--right"
          :style="{ gridColumn: placement.right }"
          :aria-label="right.label"
        >
          <slot name="right"></slot>
        </aside>
      </template>
    </div>

    <footer v-if="$slots.status" class="frame-status">
      <slot name="status"></slot>
    </footer>
  </div>
</template>
