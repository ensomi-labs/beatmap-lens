import { projectTimeFromValidatedProjection, validateRenderTimeProjection } from "./projection.js";
import { renderDefaults } from "./render-defaults.js";
import type {
  LinearRenderTimeProjection,
  ManiaChart,
  ManiaNote,
  PlayfieldSize,
  RenderLane,
  RenderMetrics,
  RenderNoteGlyph,
  RenderScene,
  RenderSceneOptions,
  RenderThemeInput,
  RenderTimeProjection,
  ResolvedPlayfieldSize,
} from "./types.js";

export interface ResolvedRenderSceneStyle {
  readonly metrics: RenderMetrics;
  readonly playfield: ResolvedPlayfieldSize;
  readonly tailShortenMs: number;
}

export function createRenderScene(
  chart: ManiaChart,
  options: RenderSceneOptions,
): RenderScene & { readonly projection: LinearRenderTimeProjection } {
  if (!options?.range) {
    throw new RangeError("A finite render range with startMs and endMs is required.");
  }
  const metrics = resolveMetrics(options.theme);
  const pixelsPerSecond = options.pixelsPerSecond ?? renderDefaults.scene.pixelsPerSecond;
  const { startMs, endMs } = options.range;
  const timeDirection = options.timeDirection ?? renderDefaults.scene.timeDirection;
  validateRenderInputs({
    endMs,
    metrics,
    pixelsPerSecond,
    startMs,
  });
  const contentHeightPx = ((endMs - startMs) * pixelsPerSecond) / 1000;
  if (!Number.isFinite(contentHeightPx) || contentHeightPx <= 0) {
    throw new RangeError("Resolved contentHeightPx must be finite and positive.");
  }
  const heightPx = metrics.paddingPx.top + contentHeightPx + metrics.paddingPx.bottom;
  if (!Number.isFinite(heightPx) || heightPx <= 0) {
    throw new RangeError("Resolved scene heightPx must be finite and positive.");
  }
  const style = resolveRenderSceneStyle(chart, options.playfield, options.theme);
  const projection: LinearRenderTimeProjection = {
    type: "linear",
    range: { startMs, endMs },
    direction: timeDirection,
    pixelsPerSecond,
    contentTopPx: metrics.paddingPx.top,
    contentHeightPx,
  };

  return createRenderSceneFromProjection(chart, projection, style) as RenderScene & {
    readonly projection: LinearRenderTimeProjection;
  };
}

export function resolveRenderSceneStyle(
  chart: ManiaChart,
  playfield?: PlayfieldSize,
  theme?: RenderThemeInput,
): ResolvedRenderSceneStyle {
  const metrics = resolveMetrics(theme);
  validateMetrics(metrics);
  const resolvedPlayfield = resolvePlayfield(playfield, metrics, chart.keyCount);
  validateResolvedPlayfield(
    resolvedPlayfield.laneWidthPx,
    resolvedPlayfield.widthPx,
    metrics.noteInsetPx,
  );
  const tailShortenMs = theme?.tailShortenMs ?? renderDefaults.scene.tailShortenMs;
  if (!Number.isFinite(tailShortenMs) || tailShortenMs < 0) {
    throw new RangeError("theme.tailShortenMs must be finite and non-negative.");
  }
  return { metrics, playfield: resolvedPlayfield, tailShortenMs };
}

export function createRenderSceneFromProjection(
  chart: ManiaChart,
  projection: RenderTimeProjection,
  style: ResolvedRenderSceneStyle,
): RenderScene {
  validateRenderTimeProjection(projection);
  if (projection.contentTopPx !== style.metrics.paddingPx.top) {
    throw new RangeError("projection.contentTopPx must equal the resolved top padding.");
  }

  const { metrics } = style;
  const { laneWidthPx, widthPx } = style.playfield;
  const heightPx = metrics.paddingPx.top + projection.contentHeightPx + metrics.paddingPx.bottom;
  if (!Number.isFinite(heightPx) || heightPx <= 0) {
    throw new RangeError("Resolved scene heightPx must be finite and positive.");
  }

  const lanes = Array.from({ length: chart.keyCount }, (_, column): RenderLane => {
    const x = metrics.paddingPx.left + column * (laneWidthPx + metrics.laneGapPx);
    return {
      column,
      x,
      y: metrics.paddingPx.top,
      width: laneWidthPx,
      height: projection.contentHeightPx,
      label: String(column + 1),
      fill: column % 2 === 0 ? "#18232f" : "#1f2d3a",
      stroke: "#314254",
    };
  });

  // A long note is visible while its drawn body reaches into the range. One shortened to its
  // start is still drawn when it starts inside the range, as a tap is.
  const visibleNotes = chart.notes.filter((note) =>
    note.kind === "long"
      ? (note.startMs >= projection.range.startMs ||
          drawnEndMs(note, style.tailShortenMs) > projection.range.startMs) &&
        note.startMs < projection.range.endMs
      : note.startMs >= projection.range.startMs && note.startMs < projection.range.endMs,
  );
  const notes = visibleNotes.map((note) =>
    createNoteGlyph(note, lanes[note.column] as RenderLane, {
      metrics,
      projection,
      tailShortenMs: style.tailShortenMs,
    }),
  );

  return {
    kind: "mania",
    keyCount: chart.keyCount,
    size: {
      widthPx,
      heightPx,
    },
    projection,
    metrics,
    metadata: chart.metadata,
    lanes,
    notes,
  };
}

function createNoteGlyph(
  note: ManiaNote,
  lane: RenderLane,
  options: {
    metrics: RenderMetrics;
    projection: RenderTimeProjection;
    tailShortenMs: number;
  },
): RenderNoteGlyph {
  const width = lane.width - options.metrics.noteInsetPx * 2;
  const laneTop = options.projection.contentTopPx;
  const laneBottom = laneTop + options.projection.contentHeightPx;
  const visibleStartMs = Math.max(note.startMs, options.projection.range.startMs);
  const visibleEndMs = Math.min(
    drawnEndMs(note, options.tailShortenMs),
    options.projection.range.endMs,
  );
  const startY = projectTimeFromValidatedProjection(options.projection, visibleStartMs);
  const endY = projectTimeFromValidatedProjection(options.projection, visibleEndMs);
  const isLong = note.kind === "long";
  const effectiveNoteHeight = Math.min(
    options.metrics.noteHeightPx,
    options.projection.contentHeightPx,
  );
  const y = isLong
    ? clamp(Math.min(startY, endY), laneTop, laneBottom)
    : clamp(startY - effectiveNoteHeight / 2, laneTop, laneBottom - effectiveNoteHeight);
  const height = isLong
    ? Math.min(Math.max(Math.abs(endY - startY), effectiveNoteHeight), Math.max(laneBottom - y, 0))
    : effectiveNoteHeight;

  return {
    id: note.id,
    kind: note.kind,
    sourceKind: note.sourceKind,
    column: note.column,
    startMs: note.startMs,
    endMs: note.endMs,
    continuesBefore: isLong && note.startMs < options.projection.range.startMs,
    continuesAfter: isLong && note.endMs > options.projection.range.endMs,
    x: lane.x + options.metrics.noteInsetPx,
    y,
    width,
    height,
    radius: options.metrics.noteRadiusPx,
    fill: isLong ? "#4ecdc4" : "#f2c14e",
    stroke: isLong ? "#257a78" : "#916f1d",
    sourceLine: note.sourceLine,
  };
}

/** Where a note is drawn to end: tailShortenMs before its end time, never before its start. */
function drawnEndMs(note: ManiaNote, tailShortenMs: number): number {
  return Math.max(note.startMs, note.endMs - tailShortenMs);
}

function resolveMetrics(theme: RenderThemeInput | undefined): RenderMetrics {
  const metrics = theme?.metrics;
  return {
    paddingPx: { ...renderDefaults.scene.metrics.paddingPx, ...metrics?.paddingPx },
    laneGapPx: metrics?.laneGapPx ?? renderDefaults.scene.metrics.laneGapPx,
    noteHeightPx: metrics?.noteHeightPx ?? renderDefaults.scene.metrics.noteHeightPx,
    noteInsetPx: metrics?.noteInsetPx ?? renderDefaults.scene.metrics.noteInsetPx,
    noteRadiusPx: metrics?.noteRadiusPx ?? renderDefaults.scene.metrics.noteRadiusPx,
  };
}

function resolvePlayfield(
  playfield: PlayfieldSize | undefined,
  metrics: RenderMetrics,
  keyCount: ManiaChart["keyCount"],
): { readonly laneWidthPx: number; readonly widthPx: number } {
  const candidate = (playfield ?? renderDefaults.scene.playfield) as {
    readonly laneWidthPx?: unknown;
    readonly widthPx?: unknown;
  };
  const hasLaneWidth = Object.hasOwn(candidate, "laneWidthPx");
  const hasWidth = Object.hasOwn(candidate, "widthPx");

  if (hasLaneWidth === hasWidth) {
    throw new RangeError("playfield must define exactly one of widthPx or laneWidthPx.");
  }

  if (hasWidth) {
    assertPositiveFinite(candidate.widthPx, "playfield.widthPx");
    const widthPx = candidate.widthPx;
    return {
      widthPx,
      laneWidthPx:
        (widthPx -
          metrics.paddingPx.left -
          metrics.paddingPx.right -
          (keyCount - 1) * metrics.laneGapPx) /
        keyCount,
    };
  }

  assertPositiveFinite(candidate.laneWidthPx, "playfield.laneWidthPx");
  const laneWidthPx = candidate.laneWidthPx;
  return {
    laneWidthPx,
    widthPx:
      metrics.paddingPx.left +
      keyCount * laneWidthPx +
      (keyCount - 1) * metrics.laneGapPx +
      metrics.paddingPx.right,
  };
}

function validateRenderInputs(options: {
  endMs: number;
  metrics: RenderMetrics;
  pixelsPerSecond: number;
  startMs: number;
}): void {
  validateMetrics(options.metrics);
  if (!Number.isFinite(options.pixelsPerSecond) || options.pixelsPerSecond <= 0) {
    throw new RangeError("pixelsPerSecond must be finite and positive.");
  }
  if (
    !Number.isFinite(options.startMs) ||
    !Number.isFinite(options.endMs) ||
    options.endMs <= options.startMs
  ) {
    throw new RangeError("range.endMs must be finite and greater than range.startMs.");
  }
}

function validateMetrics(metrics: RenderMetrics): void {
  const paddingValues = Object.values(metrics.paddingPx);
  if (paddingValues.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError("theme.metrics.paddingPx values must be finite and non-negative.");
  }
  if (!Number.isFinite(metrics.laneGapPx) || metrics.laneGapPx < 0) {
    throw new RangeError("theme.metrics.laneGapPx must be finite and non-negative.");
  }
  if (!Number.isFinite(metrics.noteHeightPx) || metrics.noteHeightPx <= 0) {
    throw new RangeError("theme.metrics.noteHeightPx must be finite and positive.");
  }
  if (!Number.isFinite(metrics.noteInsetPx) || metrics.noteInsetPx < 0) {
    throw new RangeError("theme.metrics.noteInsetPx must be finite and non-negative.");
  }
  if (!Number.isFinite(metrics.noteRadiusPx) || metrics.noteRadiusPx < 0) {
    throw new RangeError("theme.metrics.noteRadiusPx must be finite and non-negative.");
  }
}

function validateResolvedPlayfield(
  laneWidthPx: number,
  widthPx: number,
  noteInsetPx: number,
): void {
  if (!Number.isFinite(widthPx) || widthPx <= 0) {
    throw new RangeError("Resolved playfield width must be finite and positive.");
  }
  if (!Number.isFinite(laneWidthPx) || laneWidthPx <= noteInsetPx * 2) {
    throw new RangeError("Resolved laneWidthPx must be greater than twice noteInsetPx.");
  }
}

function assertPositiveFinite(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and positive.`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
