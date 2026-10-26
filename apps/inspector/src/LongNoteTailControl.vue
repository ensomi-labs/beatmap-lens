<script setup lang="ts">
import { ref } from "vue";

defineProps<{ modelValue: number; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: number] }>();
const error = ref("");

function apply(input: HTMLInputElement) {
  const value = input.valueAsNumber;
  if (!Number.isFinite(value) || value < 0) {
    error.value = "Use 0 or a positive number of milliseconds.";
    return;
  }
  error.value = "";
  emit("update:modelValue", value);
}
</script>

<template>
  <label class="long-note-tail-control">
    <span>Long-note tail <small>ms shorter · 0 draws full length</small></span>
    <input
      type="number"
      min="0"
      step="1"
      aria-label="Long-note tail shortening in milliseconds"
      :value="modelValue"
      :disabled="disabled"
      @change="apply($event.target as HTMLInputElement)"
    />
    <small v-if="error" role="alert">{{ error }}</small>
  </label>
</template>

<style scoped>
.long-note-tail-control {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.long-note-tail-control > span {
  color: var(--ink-secondary);
  font-size: var(--text-xs);
}

.long-note-tail-control small {
  color: var(--ink-muted);
}

.long-note-tail-control input {
  width: 100%;
  min-height: var(--control-h);
  margin: 0;
  padding: 0 6px;
  color: var(--ink);
  border: 0;
  border-radius: var(--radius-control);
  background: var(--field);
  box-shadow: inset 0 0 0 1px var(--field-edge);
  font-family: var(--font-data);
  font-size: var(--text-xs);
}
</style>
