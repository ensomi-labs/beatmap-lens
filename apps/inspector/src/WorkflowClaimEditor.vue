<script setup lang="ts">
import type { TimeRangeV1 } from "./annotation/contracts";
import { resolvePlaybackRate } from "./annotation/playback-rate";
import type { AssessmentV2, ClaimV2, FoundationTagV2 } from "./annotation/workflow/contracts";

const props = defineProps<{
  modelValue: ClaimV2;
  tags: readonly FoundationTagV2[];
  disabled?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [claim: ClaimV2];
  focus: [range: TimeRangeV1];
}>();

function update(patch: Partial<ClaimV2>): void {
  replace({ ...props.modelValue, ...patch });
}

function replace(claim: ClaimV2): void {
  if (!props.disabled) emit("update:modelValue", claim);
}

function assessment(presence: AssessmentV2["presence"]): void {
  update({ assessment: presence === "present" ? { presence, salience: "prominent" } : { presence } });
}

function range(kind: "scope" | "reviewContext", edge: "startMs" | "endMs", value: string): void {
  update({ [kind]: { ...props.modelValue[kind], [edge]: Number(value) } });
}

function boundary(edge: "start" | "end", value: string): void {
  const [startMs, endMs] = value.split(",").map(Number);
  const next = { ...props.modelValue.boundaryUncertainty };
  if (value.trim() && startMs !== undefined && endMs !== undefined) next[edge] = { startMs, endMs };
  else delete next[edge];
  const { boundaryUncertainty: _, ...claim } = props.modelValue;
  replace(Object.keys(next).length ? { ...claim, boundaryUncertainty: next } : claim);
}

function removeEvidence(kind: "noteRefs" | "contextNoteRefs", line: number): void {
  update({ evidence: { ...props.modelValue.evidence, [kind]: props.modelValue.evidence[kind].filter((ref) => ref.sourceLine !== line) } });
}

function setRole(value: string): void {
  const { exemplarRole: _, ...claim } = props.modelValue;
  replace(value ? { ...claim, exemplarRole: value as NonNullable<ClaimV2["exemplarRole"]> } : claim);
}

function addTransition(): void {
  update({ transition: {
    range: { ...props.modelValue.scope },
    description: "",
    evidence: { noteRefs: [], contextNoteRefs: [], rationale: "" },
  } });
}

function removeTransition(): void {
  const { transition: _, ...claim } = props.modelValue;
  replace(claim);
}

function updateTransition(patch: Partial<NonNullable<ClaimV2["transition"]>>): void {
  const transition = props.modelValue.transition;
  if (transition) update({ transition: { ...transition, ...patch } });
}

function transitionRange(edge: "startMs" | "endMs", value: string): void {
  const transition = props.modelValue.transition;
  if (transition) updateTransition({ range: { ...transition.range, [edge]: Number(value) } });
}

function transitionRationale(value: string): void {
  const transition = props.modelValue.transition;
  if (transition) updateTransition({ evidence: { ...transition.evidence, rationale: value } });
}

function copyTransitionNotes(): void {
  const transition = props.modelValue.transition;
  if (!transition) return;
  updateTransition({ evidence: {
    ...transition.evidence,
    noteRefs: [...props.modelValue.evidence.noteRefs],
    contextNoteRefs: [...props.modelValue.evidence.contextNoteRefs],
  } });
}
</script>

<template>
  <fieldset class="claim-fields">
    <legend>{{ tags.find(tag => tag.id === modelValue.tagId)?.displayName ?? modelValue.tagId }}</legend>
    <p class="claim-definition">Judgment rate · {{ resolvePlaybackRate(modelValue.playbackRate) }}×</p>
    <p class="claim-definition">{{ tags.find(tag => tag.id === modelValue.tagId)?.definition }}</p>
    <label>Assessment
      <select :disabled="disabled" :value="modelValue.assessment.presence" @change="assessment(($event.target as HTMLSelectElement).value as AssessmentV2['presence'])">
        <option value="unreviewed">Unreviewed · not assessed</option>
        <option value="present">Present</option>
        <option value="absent">Absent · explicitly checked</option>
        <option value="unresolved">Unresolved · checked, uncertain</option>
      </select>
    </label>
    <label v-if="modelValue.assessment.presence === 'present'">Salience · independent for this tag
      <select :disabled="disabled" :value="modelValue.assessment.salience" @change="update({ assessment: { presence: 'present', salience: ($event.target as HTMLSelectElement).value as 'supporting' | 'prominent' } })">
        <option value="supporting">Supporting</option>
        <option value="prominent">Prominent</option>
      </select>
    </label>
    <div v-for="kind in (['scope', 'reviewContext'] as const)" :key="kind">
      <div class="claim-field-heading">
        <strong>{{ kind === 'scope' ? 'Claim scope' : 'Review context' }} · source ms</strong>
        <button type="button" @click="emit('focus', modelValue[kind])">View</button>
      </div>
      <div class="claim-range">
        <label>Start<input type="number" step="any" :disabled="disabled" :value="modelValue[kind].startMs" @change="range(kind, 'startMs', ($event.target as HTMLInputElement).value)"></label>
        <label>End<input type="number" step="any" :disabled="disabled" :value="modelValue[kind].endMs" @change="range(kind, 'endMs', ($event.target as HTMLInputElement).value)"></label>
      </div>
    </div>
    <label>Evidence / judgment rationale · optional
      <textarea rows="3" :disabled="disabled" :value="modelValue.evidence.rationale" @input="update({ evidence: { ...modelValue.evidence, rationale: ($event.target as HTMLTextAreaElement).value } })" />
    </label>
    <div v-for="kind in (['noteRefs', 'contextNoteRefs'] as const)" :key="kind">
      <strong>{{ kind === 'noteRefs' ? 'Witness notes' : 'Context notes' }} · {{ modelValue.evidence[kind].length }}</strong>
      <div class="claim-witness-list">
        <button v-for="note in modelValue.evidence[kind]" :key="note.sourceLine" type="button" :disabled="disabled" :aria-label="`Remove ${kind === 'noteRefs' ? 'witness' : 'context'} source line ${note.sourceLine}`" @click="removeEvidence(kind, note.sourceLine)">
          L{{ note.sourceLine }} · C{{ note.column + 1 }} · {{ note.startMs }}{{ note.kind === 'long' ? `–${note.endMs}` : '' }} ms ×
        </button>
      </div>
    </div>
    <details>
      <summary>Boundary, transition and exemplar</summary>
      <p class="claim-definition">Boundary ranges describe acceptable cut points. A transition needs its own evidence and describes actual change.</p>
      <label>Acceptable start cuts · min,max ms
        <input :disabled="disabled" :value="modelValue.boundaryUncertainty?.start ? `${modelValue.boundaryUncertainty.start.startMs},${modelValue.boundaryUncertainty.start.endMs}` : ''" placeholder="Optional" @change="boundary('start', ($event.target as HTMLInputElement).value)">
      </label>
      <label>Acceptable end cuts · min,max ms
        <input :disabled="disabled" :value="modelValue.boundaryUncertainty?.end ? `${modelValue.boundaryUncertainty.end.startMs},${modelValue.boundaryUncertainty.end.endMs}` : ''" placeholder="Optional" @change="boundary('end', ($event.target as HTMLInputElement).value)">
      </label>
      <label>Exemplar role · separate from assessment
        <select :disabled="disabled" :value="modelValue.exemplarRole ?? ''" @change="setRole(($event.target as HTMLSelectElement).value)">
          <option value="">No exemplar role</option>
          <option value="typical-positive">Typical positive</option>
          <option value="weak-positive">Weak positive</option>
          <option value="near-miss">Near-miss</option>
        </select>
      </label>
      <div v-if="modelValue.transition" class="claim-transition">
        <div class="claim-field-heading">
          <strong>Transition · source ms</strong>
          <button type="button" :disabled="disabled" @click="removeTransition">Remove transition</button>
        </div>
        <div class="claim-range">
          <label>Transition start<input type="number" step="any" :disabled="disabled" :value="modelValue.transition.range.startMs" @change="transitionRange('startMs', ($event.target as HTMLInputElement).value)"></label>
          <label>Transition end<input type="number" step="any" :disabled="disabled" :value="modelValue.transition.range.endMs" @change="transitionRange('endMs', ($event.target as HTMLInputElement).value)"></label>
        </div>
        <label>Transition description
          <textarea rows="3" :disabled="disabled" :value="modelValue.transition.description" placeholder="What changes during this interval?" @input="updateTransition({ description: ($event.target as HTMLTextAreaElement).value })" />
        </label>
        <label>Transition evidence rationale
          <textarea rows="3" :disabled="disabled" :value="modelValue.transition.evidence.rationale" placeholder="Which notes show the change?" @input="transitionRationale(($event.target as HTMLTextAreaElement).value)" />
        </label>
        <p class="claim-definition">The transition interval is separate from the claim scope. Copy notes selected for this change.</p>
        <button type="button" :disabled="disabled" @click="copyTransitionNotes">Copy current claim witnesses and context to transition</button>
        <small>{{ modelValue.transition.evidence.noteRefs.length }} transition witnesses · {{ modelValue.transition.evidence.contextNoteRefs.length }} context notes</small>
        <button type="button" @click="emit('focus', modelValue.transition.range)">View transition evidence</button>
      </div>
      <div v-else class="claim-transition">
        <p class="claim-definition">No transition asserted. Uncertainty is recorded as unresolved.</p>
        <button type="button" :disabled="disabled" @click="addTransition">Add transition</button>
      </div>
    </details>
  </fieldset>
</template>

<style scoped>
.claim-fields { display: grid; gap: 8px; min-width: 0; margin: 0; padding: 0; border: 0; }
legend { padding: 0 0 4px; font-size: var(--text-md); font-weight: 650; }
.claim-definition { margin: 0; color: var(--ink-secondary); font-size: var(--text-xs); line-height: 1.5; }
.claim-range { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.claim-field-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--text-xs); }
label { display: grid; gap: 3px; min-width: 0; color: var(--ink-muted); font-size: var(--text-xs); }
input, select, textarea { width: 100%; min-width: 0; min-height: var(--control-h); padding: 3px 6px; border: 0; border-radius: var(--radius-control); background: var(--field); box-shadow: inset 0 0 0 1px var(--field-edge); color: var(--ink); font: inherit; font-size: var(--text-xs); }
textarea { resize: vertical; }
button { min-height: var(--control-h); padding: 3px 8px; border: 0; border-radius: var(--radius-control); background: var(--surface-3); box-shadow: var(--shadow-control); color: var(--ink-secondary); cursor: pointer; font-size: var(--text-xs); font-weight: 600; }
button:active { background: var(--surface-2); }
button:disabled { opacity: .45; cursor: default; }
.claim-witness-list { display: flex; flex-wrap: wrap; gap: 4px; max-height: 150px; overflow: auto; margin-top: 8px; }
.claim-witness-list button { font-family: var(--font-data); font-size: var(--text-2xs); }
details { padding-top: 6px; border-top: 1px solid var(--line); }
details > label, details > p { margin-top: 6px; }
summary { min-height: var(--header-h); color: var(--ink-secondary); cursor: pointer; font-size: var(--text-xs); font-weight: 650; line-height: var(--header-h); }
.claim-transition { display: grid; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
.claim-transition small { color: var(--ink-secondary); font-family: var(--font-data); font-size: var(--text-2xs); }
</style>
