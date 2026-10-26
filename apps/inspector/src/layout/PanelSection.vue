<script setup lang="ts">
import { ref, watch } from "vue";

/**
 * A titled section of a side pane. A collapsible one has its title as a disclosure button (the
 * WAI-ARIA accordion pattern) and the browser remembers whether it was open.
 */
const props = withDefaults(
  defineProps<{
    id: string;
    title: string;
    collapsible?: boolean;
    defaultOpen?: boolean;
    /** Opens the section when it turns true, for a warning inside it; not remembered. */
    reveal?: boolean;
  }>(),
  { collapsible: true, defaultOpen: true, reveal: false },
);

const storageKey = "lens-sections";
const open = ref(props.collapsible ? (readOpen()[props.id] ?? props.defaultOpen) : true);
watch(
  () => props.reveal,
  (reveal) => {
    if (reveal) open.value = true;
  },
  { immediate: true },
);

function readOpen(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function toggle() {
  open.value = !open.value;
  try {
    localStorage.setItem(storageKey, JSON.stringify({ ...readOpen(), [props.id]: open.value }));
  } catch {}
}
</script>

<template>
  <section :id="id" class="panel-section" :class="{ 'is-closed': !open }">
    <header class="panel-section-header">
      <h3 class="panel-section-title">
        <button
          v-if="collapsible"
          type="button"
          class="panel-section-toggle"
          :aria-expanded="open"
          :aria-controls="`${id}-body`"
          @click="toggle"
        >
          <svg class="panel-section-chevron" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3 2l3.5 3L3 8" />
          </svg>
          {{ title }}
        </button>
        <template v-else>{{ title }}</template>
      </h3>
      <span v-if="$slots.meta" class="panel-section-meta"><slot name="meta"></slot></span>
      <div v-if="$slots.actions" class="panel-section-actions"><slot name="actions"></slot></div>
    </header>
    <div v-show="open" :id="`${id}-body`" class="panel-section-body">
      <slot></slot>
    </div>
  </section>
</template>
