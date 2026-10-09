import {
  createRenderScene,
  type ManiaChart,
  projectTime,
  type RenderLane,
  type RenderNoteGlyph,
  type RenderScene,
  type RenderSceneOptions,
  type RenderTimeProjection,
  type TimeRange,
  unprojectTime,
} from "beatmap-lens";
import type { TimeRangeV1 } from "./contracts";
import { ManiaNoteTimeIndex } from "./note-time-index";

export const visualSpeedPresets = [120, 240, 480, 720] as const;
export const defaultVisualSpeed = 240;
export const minimumVisualSpeed = 30;
export const maximumVisualSpeed = 2_000;
export const judgmentLineRatio = 0.82;

export interface BufferedSceneOptions {
  readonly viewportHeight: number;
  readonly width: number;
  readonly pixelsPerSecond?: number;
  readonly judgmentLineRatio?: number;
  readonly theme?: RenderSceneOptions["theme"];
}

export interface ViewportSourceTimeOptions {
  readonly projection: RenderTimeProjection;
  readonly playheadMs: number;
  readonly viewportY: number;
  readonly viewportHeight: number;
  readonly sourceRange?: TimeRange;
  readonly judgmentLineRatio?: number;
}

export interface ProjectedSceneRange {
  readonly y: number;
  readonly height: number;
}

export interface KeyedRenderNote {
  readonly key: string;
  readonly glyph: RenderNoteGlyph;
}

export interface KeyedRenderLane {
  readonly key: string;
  readonly lane: RenderLane;
}

export interface BufferRefreshThreshold {
  readonly minimumPlayheadMs: number;
  readonly maximumPlayheadMs: number;
}

export interface BufferedSceneFrame {
  readonly revision: number;
  readonly refreshed: boolean;
  readonly scene: RenderScene;
  readonly keyedNotes: readonly KeyedRenderNote[];
  readonly keyedLanes: readonly KeyedRenderLane[];
  readonly bufferRange: TimeRangeV1;
  readonly viewportRange: TimeRangeV1;
  readonly refreshThreshold: BufferRefreshThreshold;
  /** Bind this to the one moving SVG note group during playback. */
  readonly noteGroupTransform: string;
}

export interface BufferedSceneInstrumentation {
  readonly sceneBuildCount: number;
  readonly reusedFrameCount: number;
  readonly lastBufferedNoteCount: number;
  readonly maximumBufferedNoteCount: number;
  readonly lastRenderedNoteCount: number;
  readonly maximumRenderedNoteCount: number;
  readonly lastBuildDurationMs: number;
  readonly maximumBuildDurationMs: number;
}

interface SceneBuffer {
  readonly revision: number;
  readonly scene: RenderScene;
  readonly keyedNotes: readonly KeyedRenderNote[];
  readonly keyedLanes: readonly KeyedRenderLane[];
  readonly range: TimeRangeV1;
  readonly refreshThreshold: BufferRefreshThreshold;
}

export function viewportYToSourceTime(options: ViewportSourceTimeOptions): number {
  const lineRatio = options.judgmentLineRatio ?? judgmentLineRatio;
  const judgmentY = options.viewportHeight * lineRatio;
  const translateY = judgmentY - projectTime(options.projection, options.playheadMs);
  const sceneY = normalizeProjectionBoundary(options.projection, options.viewportY - translateY);
  const sourceTimeMs = unprojectTime(options.projection, sceneY);
  return options.sourceRange
    ? clamp(sourceTimeMs, options.sourceRange.startMs, options.sourceRange.endMs)
    : sourceTimeMs;
}

export function projectSceneRange(
  projection: RenderTimeProjection,
  range: TimeRange,
): ProjectedSceneRange | undefined {
  const startMs = Math.max(range.startMs, projection.range.startMs);
  const endMs = Math.min(range.endMs, projection.range.endMs);
  if (startMs >= endMs) return undefined;

  const startY = projectTime(projection, startMs);
  const endY = projectTime(projection, endMs);
  return {
    y: Math.min(startY, endY),
    height: Math.max(1, Math.abs(endY - startY)),
  };
}

/**
 * Keeps geometry stable for one viewport of travel in either direction. Each built scene covers
 * the visible viewport plus one viewport of time before and after it.
 */
export class BufferedSceneController {
  private readonly index: ManiaNoteTimeIndex;
  private pixelsPerSecond: number;
  private buffer: SceneBuffer | undefined;
  private revision = 0;
  private counters = {
    sceneBuildCount: 0,
    reusedFrameCount: 0,
    lastBufferedNoteCount: 0,
    maximumBufferedNoteCount: 0,
    lastRenderedNoteCount: 0,
    maximumRenderedNoteCount: 0,
    lastBuildDurationMs: 0,
    maximumBuildDurationMs: 0,
  };

  constructor(
    private readonly chart: ManiaChart,
    private readonly options: BufferedSceneOptions,
  ) {
    this.pixelsPerSecond = options.pixelsPerSecond ?? defaultVisualSpeed;
    validateOptions(options, this.pixelsPerSecond);
    this.index = new ManiaNoteTimeIndex(chart.notes);
  }

  frame(playheadMs: number): BufferedSceneFrame {
    if (this.buffer && this.isWithinBuffer(playheadMs, this.buffer)) {
      this.counters.reusedFrameCount += 1;
      return this.createFrame(this.buffer, playheadMs, false);
    }

    const buffer = this.buildBuffer(playheadMs);
    this.buffer = buffer;
    return this.createFrame(buffer, playheadMs, true);
  }

  private createFrame(
    buffer: SceneBuffer,
    playheadMs: number,
    refreshed: boolean,
  ): BufferedSceneFrame {
    return {
      revision: buffer.revision,
      refreshed,
      scene: buffer.scene,
      keyedNotes: buffer.keyedNotes,
      keyedLanes: buffer.keyedLanes,
      bufferRange: buffer.range,
      viewportRange: this.viewportRange(playheadMs),
      refreshThreshold: buffer.refreshThreshold,
      noteGroupTransform: this.noteGroupTransform(buffer, playheadMs),
    };
  }

  setVisualSpeed(pixelsPerSecond: number, playheadMs: number): BufferedSceneFrame {
    validateVisualSpeed(pixelsPerSecond);
    if (pixelsPerSecond === this.pixelsPerSecond) {
      return this.frame(playheadMs);
    }
    this.pixelsPerSecond = pixelsPerSecond;
    this.buffer = undefined;
    return this.frame(playheadMs);
  }

  instrumentation(): BufferedSceneInstrumentation {
    return { ...this.counters };
  }

  private isWithinBuffer(playheadMs: number, buffer: SceneBuffer): boolean {
    return (
      playheadMs >= buffer.refreshThreshold.minimumPlayheadMs &&
      playheadMs <= buffer.refreshThreshold.maximumPlayheadMs
    );
  }

  private buildBuffer(playheadMs: number): SceneBuffer {
    const startedAt = performance.now();
    const viewportDurationMs = this.viewportDurationMs();
    const viewportRange = this.viewportRange(playheadMs);
    const range = {
      startMs: viewportRange.startMs - viewportDurationMs,
      endMs: viewportRange.endMs + viewportDurationMs,
    };
    const notes = this.index.notesInRange(range);
    const scene = createRenderScene(
      { ...this.chart, notes },
      {
        range,
        playfield: { widthPx: this.options.width },
        pixelsPerSecond: this.pixelsPerSecond,
        ...(this.options.theme === undefined ? {} : { theme: this.options.theme }),
      },
    );
    const keyedNotes = scene.notes.map((glyph) => ({ key: glyph.id, glyph }));
    const keyedLanes = scene.lanes.map((lane) => ({ key: `lane-${lane.column}`, lane }));
    const buildDurationMs = performance.now() - startedAt;

    this.revision += 1;
    this.counters.sceneBuildCount += 1;
    this.counters.lastBufferedNoteCount = notes.length;
    this.counters.maximumBufferedNoteCount = Math.max(
      this.counters.maximumBufferedNoteCount,
      notes.length,
    );
    this.counters.lastRenderedNoteCount = scene.notes.length;
    this.counters.maximumRenderedNoteCount = Math.max(
      this.counters.maximumRenderedNoteCount,
      scene.notes.length,
    );
    this.counters.lastBuildDurationMs = buildDurationMs;
    this.counters.maximumBuildDurationMs = Math.max(
      this.counters.maximumBuildDurationMs,
      buildDurationMs,
    );

    return {
      revision: this.revision,
      scene,
      keyedNotes,
      keyedLanes,
      range,
      refreshThreshold: {
        minimumPlayheadMs: playheadMs - viewportDurationMs,
        maximumPlayheadMs: playheadMs + viewportDurationMs,
      },
    };
  }

  private viewportRange(playheadMs: number): TimeRangeV1 {
    const lineRatio = this.options.judgmentLineRatio ?? judgmentLineRatio;
    const durationMs = this.viewportDurationMs();
    return {
      startMs: playheadMs - durationMs * (1 - lineRatio),
      endMs: playheadMs + durationMs * lineRatio,
    };
  }

  private viewportDurationMs(): number {
    return (this.options.viewportHeight / this.pixelsPerSecond) * 1_000;
  }

  private noteGroupTransform(buffer: SceneBuffer, playheadMs: number): string {
    const lineRatio = this.options.judgmentLineRatio ?? judgmentLineRatio;
    const judgmentY = this.options.viewportHeight * lineRatio;
    const playheadSceneY = projectTime(buffer.scene.projection, playheadMs);
    return `translate(0 ${judgmentY - playheadSceneY})`;
  }
}

function validateOptions(options: BufferedSceneOptions, pixelsPerSecond: number): void {
  if (!Number.isFinite(options.viewportHeight) || options.viewportHeight <= 0) {
    throw new RangeError("viewportHeight must be finite and positive.");
  }
  const lineRatio = options.judgmentLineRatio ?? judgmentLineRatio;
  if (!Number.isFinite(lineRatio) || lineRatio <= 0 || lineRatio >= 1) {
    throw new RangeError("judgmentLineRatio must be between 0 and 1.");
  }
  validateVisualSpeed(pixelsPerSecond);
}

function validateVisualSpeed(pixelsPerSecond: number): void {
  if (
    !Number.isFinite(pixelsPerSecond) ||
    pixelsPerSecond < minimumVisualSpeed ||
    pixelsPerSecond > maximumVisualSpeed
  ) {
    throw new RangeError(
      `pixelsPerSecond must be between ${minimumVisualSpeed} and ${maximumVisualSpeed}.`,
    );
  }
}

function normalizeProjectionBoundary(projection: RenderTimeProjection, yPx: number): number {
  const topPx = projection.contentTopPx;
  const bottomPx = topPx + projection.contentHeightPx;
  const pixelsPerSecond =
    projection.type === "linear" ? projection.pixelsPerSecond : projection.basePixelsPerSecond;
  const sourceMagnitudePx =
    (Math.max(Math.abs(projection.range.startMs), Math.abs(projection.range.endMs)) *
      pixelsPerSecond) /
    1_000;
  const tolerance =
    Number.EPSILON * 32 * Math.max(1, Math.abs(topPx), Math.abs(bottomPx), sourceMagnitudePx);
  if (yPx < topPx && topPx - yPx <= tolerance) return topPx;
  if (yPx > bottomPx && yPx - bottomPx <= tolerance) return bottomPx;
  return yPx;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
