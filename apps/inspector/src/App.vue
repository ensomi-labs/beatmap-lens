<script setup lang="ts">
import { ref } from "vue";
import AnnotateWorkspace from "./AnnotateWorkspace.vue";
import CompareWorkspace from "./CompareWorkspace.vue";
import InspectWorkspace from "./InspectWorkspace.vue";
import ReviewInbox from "./ReviewInbox.vue";
import ReviewWorkspace from "./ReviewWorkspace.vue";
import TimingWorkspace from "./TimingWorkspace.vue";
import type { WorkspaceMode } from "./workspace-mode";

const directModes: Record<string, WorkspaceMode> = { "/compare": "compare", "/timing": "timing" };
const mode = ref<WorkspaceMode>(directModes[window.location.pathname] ?? "annotate");
const connectedReview = window.location.pathname === "/review";
</script>

<template>
  <ReviewInbox v-if="connectedReview" />
  <CompareWorkspace v-else-if="mode === 'compare'" @change-mode="mode = $event" />
  <TimingWorkspace v-else-if="mode === 'timing'" @change-mode="mode = $event" />
  <InspectWorkspace v-else-if="mode === 'inspect'" @change-mode="mode = $event" />
  <ReviewWorkspace v-else-if="mode === 'review'" @change-mode="mode = $event" />
  <AnnotateWorkspace v-else @change-mode="mode = $event" />
</template>
