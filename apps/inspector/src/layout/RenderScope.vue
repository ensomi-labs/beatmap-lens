<script setup lang="ts">
/**
 * Renders its slot in a render scope of its own. The frame wraps each region in one, so a value
 * that changes every frame during playback (the playhead) re-renders only the regions that show
 * it, not the side panes and their long lists.
 */
</script>

<template>
  <slot></slot>
</template>
