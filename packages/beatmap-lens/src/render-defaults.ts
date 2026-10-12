export const renderDefaults = deepFreeze({
  scene: {
    pixelsPerSecond: 240,
    playfield: { widthPx: 640 },
    timeDirection: "bottom-to-top",
    /** Long notes are drawn ending this many ms before their end time, never before their start. */
    tailShortenMs: 10,
    metrics: {
      paddingPx: {
        top: 24,
        right: 16,
        bottom: 24,
        left: 16,
      },
      laneGapPx: 4,
      noteHeightPx: 8,
      noteInsetPx: 5,
      noteRadiusPx: 2,
    },
  },
  animation: {
    viewport: { widthPx: 640, heightPx: 480 },
    scrollSpeed: 20,
    fps: 30,
  },
  document: {
    page: {
      size: { widthPx: 1600, heightPx: 900 },
      paddingPx: { top: 24, right: 24, bottom: 24, left: 24 },
      gapPx: 12,
      columns: "auto",
    },
    panel: {
      playfield: { laneWidthPx: 48 },
      maxNoteRows: 32,
      maxSourceDurationMs: 10_000,
    },
    scale: { type: "linear", pixelsPerSecond: 240 },
    fit: { preferredPixelsPerSecond: 240, minPixelsPerSecond: 140 },
    rowAware: { basePixelsPerSecond: 240, minRowGapPx: 12, maxEmptyGapPx: 72 },
    timeDirection: "bottom-to-top",
    timeAxis: {
      side: "left",
      widthPx: 32,
      gapPx: 0,
      labels: "major",
      tickStepMs: "auto",
      showCompressionMarks: true,
    },
  },
} as const);

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  Object.freeze(value);
  return value;
}
