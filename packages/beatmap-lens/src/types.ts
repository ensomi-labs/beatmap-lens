export type DiagnosticSeverity = "warning" | "error";

export interface OsuDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly section?: string;
  readonly value?: string;
}

export type OsuSourceLineKind =
  | "blank"
  | "comment"
  | "format"
  | "section"
  | "property"
  | "data"
  | "malformed";

export interface OsuSourceLine {
  readonly number: number;
  readonly text: string;
  readonly kind: OsuSourceLineKind;
  readonly section?: string;
  readonly key?: string;
  readonly value?: string;
  readonly fields?: readonly string[];
  readonly diagnostics: readonly OsuDiagnostic[];
}

export interface OsuProperty {
  readonly section: string;
  readonly key: string;
  readonly value: string;
  readonly line: number;
  readonly raw: string;
}

export interface OsuSection {
  readonly name: string;
  readonly headerLine: number;
  readonly lines: readonly OsuSourceLine[];
  readonly properties: readonly OsuProperty[];
  readonly dataLines: readonly OsuSourceLine[];
}

export type OsuHitObjectKind = "normal" | "hold" | "slider" | "spinner" | "unknown";

export interface OsuHitObject {
  readonly kind: OsuHitObjectKind;
  readonly x: number;
  readonly y: number;
  readonly timeMs: number;
  readonly type: number;
  readonly hitSound: number;
  readonly params: readonly string[];
  readonly rawFields: readonly string[];
  readonly sourceLine: number;
  readonly raw: string;
  readonly diagnostics: readonly OsuDiagnostic[];
}

export interface ParsedOsu {
  readonly formatVersion?: number;
  readonly lines: readonly OsuSourceLine[];
  readonly sections: readonly OsuSection[];
  readonly properties: readonly OsuProperty[];
  readonly hitObjects: readonly OsuHitObject[];
  readonly diagnostics: readonly OsuDiagnostic[];
}

export interface ManiaMetadata {
  readonly title?: string;
  readonly artist?: string;
  readonly creator?: string;
  readonly version?: string;
}

export type ManiaNoteKind = "normal" | "long";

export interface ManiaNote {
  readonly id: string;
  readonly kind: ManiaNoteKind;
  readonly sourceKind: "normal" | "hold";
  readonly column: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly sourceLine: number;
  readonly x: number;
  readonly hitSound: number;
}

export interface TimeRange {
  /** Half-open source-time interval [startMs, endMs). */
  readonly startMs: number;
  readonly endMs: number;
}

export interface SizePx {
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface ManiaChart {
  readonly keyCount: number;
  readonly sourceKeyCount?: number;
  readonly mode?: number;
  readonly metadata: ManiaMetadata;
  readonly notes: readonly ManiaNote[];
  readonly range: TimeRange;
  readonly diagnostics: readonly OsuDiagnostic[];
}

export interface BeatmapAudio {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly mimeType?: string;
}

export interface ParseBeatmapOptions {
  readonly filename?: string;
  readonly audio?: BeatmapAudio;
}

export interface Beatmap {
  readonly osuSource: string;
  readonly osuFilename?: string;
  readonly document: ParsedOsu;
  readonly chart: ManiaChart;
  readonly audioFilename?: string;
  readonly audio?: BeatmapAudio;
}

export interface BeatmapSet {
  readonly beatmaps: readonly Beatmap[];
  readonly audios: readonly BeatmapAudio[];
}

export interface ParseOszOptions {
  readonly maxInflatedBytes?: number;
  readonly maxConcurrency?: number;
}

export interface RenderPadding {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export type RenderTimeDirection = "bottom-to-top" | "top-to-bottom";

export interface LinearRenderTimeProjection {
  readonly type: "linear";
  readonly range: TimeRange;
  readonly direction: RenderTimeDirection;
  readonly pixelsPerSecond: number;
  readonly contentTopPx: number;
  readonly contentHeightPx: number;
}

export interface PiecewiseLinearRenderTimeProjection {
  readonly type: "piecewise-linear";
  readonly range: TimeRange;
  readonly direction: RenderTimeDirection;
  readonly contentTopPx: number;
  readonly contentHeightPx: number;
  readonly basePixelsPerSecond: number;
  readonly anchors: readonly {
    readonly timeMs: number;
    readonly distancePx: number;
  }[];
  readonly compressedRanges: readonly TimeRange[];
}

export type RenderTimeProjection = LinearRenderTimeProjection | PiecewiseLinearRenderTimeProjection;

export type PlayfieldSize =
  | {
      readonly widthPx: number;
      readonly laneWidthPx?: never;
    }
  | {
      readonly laneWidthPx: number;
      readonly widthPx?: never;
    };

export interface RenderMetrics {
  readonly paddingPx: RenderPadding;
  readonly laneGapPx: number;
  readonly noteHeightPx: number;
  readonly noteInsetPx: number;
  readonly noteRadiusPx: number;
}

export interface RenderMetricOptions {
  readonly paddingPx?: Partial<RenderPadding>;
  readonly laneGapPx?: number;
  readonly noteHeightPx?: number;
  readonly noteInsetPx?: number;
  readonly noteRadiusPx?: number;
}

export interface RenderThemeInput {
  readonly metrics?: RenderMetricOptions;
  /**
   * Draw each long note ending this many ms before its end time, never before its start, as
   * shortened-tail skins do. Display only: glyph `endMs` and `continuesAfter` keep the end time.
   */
  readonly tailShortenMs?: number;
}

export type RenderPaddingInput = number | Partial<RenderPadding>;

export interface RenderSceneOptions {
  readonly range: TimeRange;
  readonly pixelsPerSecond?: number;
  readonly playfield?: PlayfieldSize;
  readonly timeDirection?: RenderTimeDirection;
  readonly theme?: RenderThemeInput;
}

export type RenderAnimationOptions = {
  /** Source-time playback interval, independent of each frame's visible range. */
  readonly range: TimeRange;
  /** Logical scene dimensions. Defaults to 640 × 480. */
  readonly viewport?: SizePx;
  /** Frames per source second. Defaults to 30. */
  readonly fps?: number;
  readonly timeDirection?: RenderTimeDirection;
  readonly theme?: RenderThemeInput;
} & (
  | {
      /** osu!lazer baseline speed, 1–40, for a landscape viewport. Defaults to 20. */
      readonly scrollSpeed?: number;
      readonly pixelsPerSecond?: never;
    }
  | {
      /** Direct linear speed in logical pixels per source second; also supports portrait viewports. */
      readonly pixelsPerSecond: number;
      readonly scrollSpeed?: never;
    }
);

export interface ResolvedRenderAnimationOptions {
  readonly viewport: SizePx;
  readonly fps: number;
  readonly pixelsPerSecond: number;
  readonly timeDirection: RenderTimeDirection;
  readonly metrics: RenderMetrics;
  readonly playfield: ResolvedPlayfieldSize;
  readonly tailShortenMs: number;
  readonly contentHeightPx: number;
  readonly visibleDurationMs: number;
  readonly durationMs: number;
  readonly frameCount: number;
}

export interface RenderAnimation {
  readonly kind: "mania-animation";
  /** Retained by reference; frame generation does not copy the chart. */
  readonly chart: ManiaChart;
  readonly range: TimeRange;
  readonly resolved: ResolvedRenderAnimationOptions;
}

export interface RenderAnimationFrame {
  readonly index: number;
  readonly timeMs: number;
  readonly durationMs: number;
  readonly scene: RenderScene;
}

export type RenderDocumentScaleInput =
  | {
      readonly type: "linear";
      readonly pixelsPerSecond?: number;
    }
  | {
      readonly type: "fit";
      readonly preferredPixelsPerSecond?: number;
      readonly minPixelsPerSecond?: number;
    }
  | {
      readonly type: "row-aware";
      readonly basePixelsPerSecond?: number;
      readonly minRowGapPx?: number;
      readonly maxEmptyGapPx?: number;
    };

export interface RenderTimeAxisInput {
  readonly side?: "left" | "right";
  readonly widthPx?: number;
  readonly labels?: "bounds" | "major";
  readonly tickStepMs?: number | "auto";
  readonly showCompressionMarks?: boolean;
}

export interface RenderDocumentOptions {
  readonly range: TimeRange;
  readonly page?: {
    readonly size?: SizePx;
    readonly paddingPx?: RenderPaddingInput;
    readonly gapPx?: number;
    readonly columns?: "auto" | number;
  };
  readonly panel?: {
    readonly playfield?: PlayfieldSize;
    readonly maxNoteRows?: number | "unbounded";
    readonly maxSourceDurationMs?: number;
  };
  readonly scale?: RenderDocumentScaleInput;
  readonly timeDirection?: RenderTimeDirection;
  readonly timeAxis?: false | RenderTimeAxisInput;
  readonly theme?: RenderThemeInput;
}

export interface OsuLazerManiaPixelsPerSecondOptions {
  readonly scrollSpeed: number;
  /** The effective gameplay rectangle after lazer screen scaling and safe-area adjustments. */
  readonly gameplayViewport: {
    readonly widthPx: number;
    readonly heightPx: number;
  };
}

export interface RenderScene {
  readonly kind: "mania";
  readonly keyCount: number;
  readonly size: {
    readonly widthPx: number;
    readonly heightPx: number;
  };
  readonly projection: RenderTimeProjection;
  readonly metrics: RenderMetrics;
  readonly metadata: ManiaMetadata;
  readonly lanes: readonly RenderLane[];
  readonly notes: readonly RenderNoteGlyph[];
}

export interface ResolvedPlayfieldSize {
  readonly widthPx: number;
  readonly laneWidthPx: number;
}

export type ResolvedRenderDocumentScale =
  | {
      readonly type: "linear";
      readonly pixelsPerSecond: number;
    }
  | {
      readonly type: "fit";
      readonly preferredPixelsPerSecond: number;
      readonly minPixelsPerSecond: number;
      readonly pixelsPerSecond: number;
    }
  | {
      readonly type: "row-aware";
      readonly basePixelsPerSecond: number;
      readonly minRowGapPx: number;
      readonly maxEmptyGapPx: number;
    };

export interface ResolvedRenderTimeAxisOptions {
  readonly side: "left" | "right";
  readonly widthPx: number;
  readonly gapPx: number;
  readonly labels: "bounds" | "major";
  readonly tickStepMs: number | "auto";
  readonly showCompressionMarks: boolean;
}

export interface ResolvedRenderDocumentOptions {
  readonly pageSize: SizePx;
  readonly pagePaddingPx: RenderPadding;
  readonly pageGapPx: number;
  readonly columnsPerPage: number;
  readonly panelPlayfield: ResolvedPlayfieldSize;
  readonly panelWidthPx: number;
  readonly panelContentHeightPx: number;
  readonly maxNoteRows: number | "unbounded";
  readonly maxSourceDurationMs: number;
  readonly scale: ResolvedRenderDocumentScale;
  readonly timeDirection: RenderTimeDirection;
  readonly timeAxis: false | ResolvedRenderTimeAxisOptions;
  readonly panelCount: number;
  readonly pageCount: number;
}

export interface RenderDiagnostic {
  readonly severity: "warning";
  readonly code: "fit-minimum-reached";
  readonly message: string;
}

export interface RenderTimeAxisTick {
  readonly kind: "start" | "major" | "end";
  readonly timeMs: number;
  readonly y: number;
  readonly label: string;
}

export interface RenderTimeCompressionMark {
  readonly range: TimeRange;
  readonly y: number;
}

export interface RenderTimeAxis {
  readonly side: "left" | "right";
  readonly widthPx: number;
  readonly gapPx: number;
  readonly labels: "bounds" | "major";
  readonly tickStepMs: number;
  readonly ticks: readonly RenderTimeAxisTick[];
  readonly compressionMarks: readonly RenderTimeCompressionMark[];
}

export interface RenderPanel {
  readonly index: number;
  readonly range: TimeRange;
  readonly noteRowCount: number;
  readonly frame: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly scene: RenderScene;
  readonly timeAxis?: RenderTimeAxis;
}

export interface RenderPage {
  readonly index: number;
  readonly size: SizePx;
  readonly range: TimeRange;
  readonly panels: readonly RenderPanel[];
}

export interface RenderDocument {
  readonly kind: "mania-document";
  readonly range: TimeRange;
  readonly pageSize: SizePx;
  readonly resolved: ResolvedRenderDocumentOptions;
  readonly pages: readonly RenderPage[];
  readonly diagnostics: readonly RenderDiagnostic[];
}

export interface RenderLane {
  readonly column: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly fill: string;
  readonly stroke: string;
}

export interface RenderNoteGlyph {
  readonly id: string;
  readonly kind: ManiaNoteKind;
  readonly sourceKind: "normal" | "hold";
  readonly column: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly continuesBefore: boolean;
  readonly continuesAfter: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly fill: string;
  readonly stroke: string;
  readonly sourceLine: number;
}

export interface SerializeSvgOptions {
  readonly title?: string;
}

export interface SerializeSvgPagesOptions {
  readonly title?: string;
}

export interface SerializedSvgPage {
  readonly index: number;
  readonly count: number;
  readonly range: TimeRange;
  readonly size: SizePx;
  readonly svg: string;
}
