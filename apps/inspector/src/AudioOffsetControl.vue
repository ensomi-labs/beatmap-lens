<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{ modelValue: number; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: number] }>();
const draft = ref("");
const error = ref("");

watch(() => props.modelValue, syncDraft, { immediate: true });

function syncDraft(value: number) {
  draft.value = String(Number(value.toFixed(3)));
  error.value = "";
}

function apply(value = Number(draft.value)) {
  if (!Number.isFinite(value)) {
    error.value = "Use a finite offset in milliseconds.";
    return;
  }
  syncDraft(value);
  emit("update:modelValue", value);
}
</script>

<template>
  <div class="audio-offset-control">
    <div class="transport-control-label">
      <span>Audio offset</span>
      <small>Positive values play audio earlier</small>
    </div>
    <div class="audio-offset-editor">
      <button type="button" :disabled="disabled" @click="apply(modelValue - 10)">−10</button>
      <label>
        <span class="sr-only">Audio offset in milliseconds</span>
        <input
          v-model="draft"
          type="number"
          step="10"
          :disabled="disabled"
          @blur="apply()"
          @keydown.enter.prevent="apply()"
        />
        <small>ms</small>
      </label>
      <button type="button" :disabled="disabled" @click="apply(modelValue + 10)">+10</button>
      <button type="button" :disabled="disabled || modelValue === 0" @click="apply(0)">Reset</button>
    </div>
    <small v-if="error" role="alert">{{ error }}</small>
  </div>
</template>
