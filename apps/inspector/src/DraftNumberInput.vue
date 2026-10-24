<script setup lang="ts">
import { ref } from "vue";

/**
 * A number field that keeps what is typed while it has focus. The page redraws every frame
 * during playback, and a bound value would write the stored number back over the typed text on
 * each redraw. Enter, Tab and blur commit a finite number; anything else shows the stored value
 * again.
 */
defineProps<{ modelValue: number }>();
const emit = defineEmits<{ "update:modelValue": [value: number] }>();
/** The typed text since the last commit; undefined shows `modelValue`. */
const draft = ref<string>();

function edit(event: Event) {
  draft.value = (event.target as HTMLInputElement).value;
}

function commit(event: Event) {
  if (draft.value === undefined) return;
  draft.value = undefined;
  const value = (event.target as HTMLInputElement).valueAsNumber;
  if (Number.isFinite(value)) emit("update:modelValue", value);
}
</script>

<template>
  <input
    type="number"
    :value="draft ?? modelValue"
    @input="edit"
    @change="commit"
    @blur="commit"
    @keydown.enter="commit"
  />
</template>
