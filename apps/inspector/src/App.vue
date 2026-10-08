<script setup lang="ts">
import { ref } from "vue";
import AnnotateWorkspace from "./AnnotateWorkspace.vue";
import CompareWorkspace from "./CompareWorkspace.vue";
import InspectWorkspace from "./InspectWorkspace.vue";
import ReviewInbox from "./ReviewInbox.vue";
import ReviewWorkspace from "./ReviewWorkspace.vue";
import type { WorkspaceMode } from "./workspace-mode";

const mode = ref<WorkspaceMode>(window.location.pathname === "/compare" ? "compare" : "annotate");
const connectedReview = window.location.pathname === "/review";
</script>

<template>
  <ReviewInbox v-if="connectedReview" />
  <CompareWorkspace v-else-if="mode === 'compare'" @change-mode="mode = $event" />
  <InspectWorkspace v-else-if="mode === 'inspect'" @change-mode="mode = $event" />
  <ReviewWorkspace v-else-if="mode === 'review'" @change-mode="mode = $event" />
  <AnnotateWorkspace v-else @change-mode="mode = $event" />
</template>
