<script setup lang="ts">
defineProps<{ modelValue: number; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: number] }>();
</script>

<template>
  <label class="audio-volume-control">
    <span>Volume <output>{{ Math.round(modelValue * 100) }}%</output></span>
    <input
      type="range"
      min="0"
      max="100"
      step="1"
      aria-label="Volume"
      :aria-valuetext="`${Math.round(modelValue * 100)}%`"
      :value="Math.round(modelValue * 100)"
      :disabled="disabled"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).valueAsNumber / 100)"
    />
  </label>
</template>

<style scoped>
.audio-volume-control {
  display: grid;
  gap: 0;
  min-width: 0;
}

.audio-volume-control > span {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--ink-secondary);
  font-size: var(--text-xs);
}

.audio-volume-control output {
  color: var(--ink-muted);
  font-family: var(--font-data);
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
}

.audio-volume-control input {
  width: 100%;
  min-height: var(--control-h-sm);
  margin: 0;
  padding: 0;
  accent-color: var(--signal-fill);
}
</style>
