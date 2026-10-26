<script setup lang="ts">
import { watch } from "vue";
import type { AssessmentV2, ClaimV2, FoundationTagV2, HumanConfidenceV2 } from "./annotation/workflow/contracts";

const props = withDefaults(defineProps<{
  claims: readonly ClaimV2[];
  tags: readonly FoundationTagV2[];
  disabled?: boolean;
  activeClaimId?: string;
  confidences?: Readonly<Record<string, HumanConfidenceV2 | undefined>>;
  explicitLow?: boolean;
}>(), { disabled: false });
const emit = defineEmits<{
  "update:claim": [claim: ClaimV2];
  select: [claimId: string];
  "update:confidence": [claimId: string, confidence: HumanConfidenceV2];
}>();

// Native input and click can arrive before the controlled value renders again.
const pendingAssessments = new Map<string, AssessmentV2>();
watch(() => props.claims, () => pendingAssessments.clear(), { flush: "sync" });

function name(claim: ClaimV2): string {
  return props.tags.find((tag) => tag.id === claim.tagId)?.displayName ?? claim.tagId;
}

function shortName(claim: ClaimV2): string {
  const full = name(claim);
  return full === "LN coordination" ? "LN" : full.replace(/ organization$/, "");
}

function assessmentText(assessment: AssessmentV2): string {
  if (assessment.presence === "present")
    return assessment.salience === "supporting" ? "Supporting" : "Prominent";
  return assessment.presence === "absent" ? "Absent"
    : assessment.presence === "unresolved" ? "Unresolved" : "Unreviewed";
}

function rangeValue(assessment: AssessmentV2): number {
  return assessment.presence === "present" ? assessment.salience === "prominent" ? 2 : 1 : 0;
}

function isRated(assessment: AssessmentV2): boolean {
  return assessment.presence === "present" || assessment.presence === "absent";
}

function select(claim: ClaimV2): void {
  if (!props.disabled) emit("select", claim.id);
}

function update(claim: ClaimV2, assessment: AssessmentV2): void {
  if (props.disabled) return;
  select(claim);
  const previous = pendingAssessments.get(claim.id) ?? claim.assessment;
  if (assessmentText(previous) === assessmentText(assessment)) return;
  pendingAssessments.set(claim.id, assessment);
  emit("update:claim", { ...claim, assessment });
}

function input(claim: ClaimV2, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  update(claim, value === 0 ? { presence: "absent" }
    : { presence: "present", salience: value === 1 ? "supporting" : "prominent" });
}

function confidenceInput(claim: ClaimV2, event: Event): void {
  if (props.disabled || !isRated(claim.assessment)) return;
  emit("update:confidence", claim.id, (event.target as HTMLInputElement).checked ? "high" : "low");
}

function keydown(claim: ClaimV2, event: KeyboardEvent): void {
  if (props.disabled) return;
  const control = event.target as HTMLInputElement;
  let value = Number(control.value);
  if (["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)) value = Math.max(0, value - 1);
  else if (["ArrowRight", "ArrowUp", "PageUp"].includes(event.key)) value = Math.min(2, value + 1);
  else if (event.key === "Home") value = 0;
  else if (event.key === "End") value = 2;
  else return;
  event.preventDefault();
  control.value = String(value);
  input(claim, event);
}
</script>

<template>
  <fieldset class="section-sliders" aria-label="Section style assessments">
    <div class="slider-scale" aria-hidden="true">
      <span>Absent</span><span>Supporting</span><span>Prominent</span>
    </div>
    <span v-if="confidences" class="confidence-heading">High</span>
    <div
      v-for="claim in claims"
      :key="claim.id"
      class="slider-row"
      :class="{ active: claim.id === activeClaimId, unrated: !isRated(claim.assessment) }"
    >
      <button
        type="button"
        class="slider-label"
        :disabled="disabled"
        :aria-label="`${name(claim)} evidence`"
        :aria-pressed="claim.id === activeClaimId"
        @click="select(claim)"
      >
        <strong :title="name(claim)">{{ shortName(claim) }}</strong>
        <span>{{ assessmentText(claim.assessment) }}</span>
      </button>
      <input
        type="range"
        min="0"
        max="2"
        step="1"
        :disabled="disabled"
        :value="rangeValue(claim.assessment)"
        :aria-label="`${name(claim)} assessment`"
        :aria-valuetext="assessmentText(claim.assessment)"
        @input="input(claim, $event)"
        @click="input(claim, $event)"
        @keydown="keydown(claim, $event)"
      >
      <button
        type="button"
        class="unresolved-button"
        :disabled="disabled"
        :aria-label="`Mark ${name(claim)} unresolved`"
        :aria-pressed="claim.assessment.presence === 'unresolved'"
        @click="update(claim, { presence: 'unresolved' })"
      >Unresolved</button>
      <label v-if="confidences" class="confidence-control">
      <span class="confidence-accessible-label">High confidence</span>
      <input
        type="checkbox"
        class="confidence-checkbox"
        :aria-label="`${name(claim)} high confidence`"
        :title="confidences[claim.id] === undefined ? 'Confidence not specified in this historical judgment' : confidences[claim.id] === 'high' ? 'High confidence' : 'Low confidence'"
        :disabled="disabled || !isRated(claim.assessment)"
        :checked="confidences[claim.id] === 'high'"
        @change="confidenceInput(claim, $event)"
      >
      </label>
      <button v-if="explicitLow && confidences && confidences[claim.id] === undefined" type="button" class="record-low" :disabled="disabled || !isRated(claim.assessment)" :aria-label="`Record Low confidence for ${name(claim)}`" @click="emit('update:confidence', claim.id, 'low')">Record Low</button>
      <span v-else-if="explicitLow && confidences" class="record-low">{{ confidences[claim.id] === 'high' ? 'High' : 'Low' }} confidence</span>
    </div>
  </fieldset>
</template>

<style scoped>
.section-sliders { display: grid; grid-template-columns: 68px minmax(0, 1fr) 68px; column-gap: 6px; min-width: 0; margin: 0; padding: 0; border: 0; }
.section-sliders:has(.confidence-heading) { grid-template-columns: 58px minmax(0, 1fr) 52px 28px; }
.confidence-heading { grid-column: 4; font-size: var(--text-2xs); color: var(--ink-muted); align-self: center; text-align: center; }
.confidence-control { display: grid; place-items: center; width: 28px; height: 28px; cursor: pointer; }
.confidence-accessible-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.confidence-checkbox { appearance: none; width: 16px; height: 16px; margin: 0; border: 1px solid var(--ink-secondary); border-radius: 3px; background: var(--field); cursor: pointer; }
.confidence-checkbox:checked { border-color: var(--signal-fill); background: var(--signal-fill); }
.confidence-checkbox:checked::after { content: ""; display: block; width: 4px; height: 8px; margin: 1px 0 0 5px; border: solid oklch(100% 0 0); border-width: 0 2px 2px 0; transform: rotate(45deg); }
.confidence-checkbox:disabled { opacity: .45; cursor: default; }
.slider-scale { grid-column: 2; display: flex; justify-content: space-between; gap: 4px; padding: 0 2px 2px; color: var(--ink-muted); font-size: var(--text-2xs); }
.slider-row { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center; min-height: 34px; border-top: 1px solid var(--line); }
.record-low { grid-column: 2 / -1; justify-self: end; font-size: var(--text-xs); }
button { min-width: 0; min-height: var(--control-h-sm); padding: 2px 0; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--ink-secondary); font: inherit; cursor: pointer; }
button:hover { color: var(--ink); background: var(--surface-hover); }
button:disabled, input:disabled { opacity: .45; cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
.slider-label { display: grid; align-content: center; gap: 2px; text-align: left; }
.slider-label strong { color: var(--ink); font-size: var(--text-sm); font-weight: 650; }
.slider-label span { color: var(--ink-muted); font-size: var(--text-2xs); }
.active .slider-label strong { color: var(--signal); }
.unresolved-button { font-size: var(--text-2xs); }
.unresolved-button[aria-pressed="true"] { color: var(--ink); font-weight: 650; text-decoration: underline; text-underline-offset: 3px; }
input[type="range"] { appearance: none; width: 100%; min-width: 0; height: 26px; margin: 0; padding: 0; border: 0; border-radius: 4px; background: transparent; cursor: pointer; }
input[type="range"]::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: var(--line); }
input[type="range"]::-moz-range-track { height: 3px; border-radius: 2px; background: var(--line); }
input[type="range"]::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; margin-top: -5.5px; border: 2px solid var(--surface-1); border-radius: 50%; background: var(--signal); box-shadow: 0 0 0 1px var(--signal); }
input[type="range"]::-moz-range-thumb { width: 10px; height: 10px; border: 2px solid var(--surface-1); border-radius: 50%; background: var(--signal); box-shadow: 0 0 0 1px var(--signal); }
.unrated input::-webkit-slider-thumb { opacity: 0; }
.unrated input::-moz-range-thumb { opacity: 0; }
</style>
