<script setup lang="ts">
import type { WorkspaceMode } from "./workspace-mode";

defineProps<{
  disabled?: boolean;
  modelValue: WorkspaceMode;
}>();

const emit = defineEmits<{
  "update:modelValue": [mode: WorkspaceMode];
}>();
</script>

<template>
  <fieldset class="workspace-mode-switch" aria-label="Inspector workspace">
    <button
      v-for="mode in (['inspect', 'annotate', 'review', 'compare'] as const)"
      :key="mode"
      class="workspace-mode-button"
      :class="{ 'is-active': modelValue === mode }"
      type="button"
      :disabled="disabled"
      :aria-pressed="modelValue === mode"
      @click="!disabled && emit('update:modelValue', mode)"
    >
      {{ mode }}
    </button>
  </fieldset>
</template>
