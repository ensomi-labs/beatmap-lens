import {
  axisEdgePenetration,
  edgeAutoScrollZonePx,
  quadraticEdgeVelocity,
} from "../stage-audio/edge-auto-scroll";
import type { TimeRangeV1 } from "./contracts";

export const minimumTimelineViewDurationMs = 1_000;
export const timelineEdgePanSizePx = edgeAutoScrollZonePx;

export type TimelineEdgePanDirection = "earlier" | "later";

export interface TimelineViewMapping {
  readonly viewRange: TimeRangeV1;
  readonly height: number;
}

export interface TimelineWheelZoomInput {
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey?: boolean;
}

export interface TimelineZoomAtYOptions extends TimelineViewMapping {
  readonly anchorY: number;
  readonly chartEndMs: number;
  readonly zoomDelta: number;
}

export interface TimelineZoomAtTimeOptions {
  readonly anchorMs: number;
  readonly chartEndMs: number;
  readonly viewRange: TimeRangeV1;
  readonly zoomDelta: number;
}

export interface TimelineEdgePanCalculation {
  readonly direction: TimelineEdgePanDirection;
  readonly penetration: number;
  readonly velocityMsPerSecond: number;
  readonly deltaMs: number;
}

export interface TimelineEdgePanOptions extends TimelineViewMapping {
  readonly chartEndMs: number;
  readonly elapsedMs: number;
  readonly edgeSizePx?: number;
  readonly pointerY: number;
}

export function timelineViewDurationMs(viewRange: TimeRangeV1): number {
  return viewRange.endMs - viewRange.startMs;
}

export function fitTimelineViewRange(chartEndMs: number): TimeRangeV1 {
  return { startMs: 0, endMs: chartEndMs };
}

export function minimumTimelineViewDuration(chartEndMs: number): number {
  return Math.min(chartEndMs, minimumTimelineViewDurationMs);
}

export function clampTimelineViewRange(range: TimeRangeV1, chartEndMs: number): TimeRangeV1 {
  const duration = clamp(
    timelineViewDurationMs(range),
    minimumTimelineViewDuration(chartEndMs),
    chartEndMs,
  );
  if (duration >= chartEndMs) return fitTimelineViewRange(chartEndMs);

  const startMs = clamp(range.startMs, 0, chartEndMs - duration);
  return { startMs, endMs: startMs + duration };
}

export function offsetTimelineViewRange(
  viewRange: TimeRangeV1,
  deltaMs: number,
  chartEndMs: number,
): TimeRangeV1 {
  const duration = timelineViewDurationMs(viewRange);
  if (duration >= chartEndMs) return fitTimelineViewRange(chartEndMs);

  const startMs = clamp(viewRange.startMs + deltaMs, 0, chartEndMs - duration);
  return { startMs, endMs: startMs + duration };
}

export function clampTimelineY(y: number, height: number): number {
  return clamp(y, 0, height);
}

export function timelineSourceTimeFromY(y: number, mapping: TimelineViewMapping): number {
  const durationMs = timelineViewDurationMs(mapping.viewRange);
  return mapping.viewRange.endMs - (y / mapping.height) * durationMs;
}

export function timelineSourceTimeFromClampedY(y: number, mapping: TimelineViewMapping): number {
  return timelineSourceTimeFromY(clampTimelineY(y, mapping.height), mapping);
}

export function timelineYFromSourceTime(timeMs: number, mapping: TimelineViewMapping): number {
  const durationMs = timelineViewDurationMs(mapping.viewRange);
  return ((mapping.viewRange.endMs - timeMs) / durationMs) * mapping.height;
}

export function normalizeTimelineWheelZoomDelta(input: TimelineWheelZoomInput): number {
  return -input.deltaY * timelineWheelDeltaFactor(input.deltaMode) * (input.ctrlKey ? 10 : 1);
}

export function zoomTimelineViewRangeAtY(options: TimelineZoomAtYOptions): TimeRangeV1 {
  const anchorY = clampTimelineY(options.anchorY, options.height);
  const anchorRatio = anchorY / options.height;
  return zoomTimelineViewRangeAtAnchor({
    anchorMs: timelineSourceTimeFromY(anchorY, options),
    anchorRatio,
    chartEndMs: options.chartEndMs,
    viewRange: options.viewRange,
    zoomDelta: options.zoomDelta,
  });
}

export function zoomTimelineViewRangeAtTime(options: TimelineZoomAtTimeOptions): TimeRangeV1 {
  const durationMs = timelineViewDurationMs(options.viewRange);
  const anchorRatio = clamp((options.viewRange.endMs - options.anchorMs) / durationMs, 0, 1);
  return zoomTimelineViewRangeAtAnchor({
    anchorMs: options.anchorMs,
    anchorRatio,
    chartEndMs: options.chartEndMs,
    viewRange: options.viewRange,
    zoomDelta: options.zoomDelta,
  });
}

export function timelineZoomAnchorMs(viewRange: TimeRangeV1, playheadMs: number): number {
  return playheadMs >= viewRange.startMs && playheadMs <= viewRange.endMs
    ? playheadMs
    : (viewRange.startMs + viewRange.endMs) / 2;
}

export function calculateTimelineEdgePan(
  options: TimelineEdgePanOptions,
): TimelineEdgePanCalculation | undefined {
  const hit = axisEdgePenetration({
    coordinatePx: options.pointerY,
    startPx: 0,
    endPx: options.height,
    edgeZonePx: options.edgeSizePx ?? timelineEdgePanSizePx,
  });
  if (!hit) return undefined;

  const direction = hit.side === "start" ? "later" : "earlier";
  const velocityMsPerSecond = quadraticEdgeVelocity(
    hit.penetrationRatio,
    timelineViewDurationMs(options.viewRange),
  );
  const deltaMs =
    velocityMsPerSecond * (options.elapsedMs / 1_000) * (direction === "later" ? 1 : -1);
  return { direction, penetration: hit.penetrationRatio, velocityMsPerSecond, deltaMs };
}

export function applyTimelineEdgePan(options: TimelineEdgePanOptions): TimeRangeV1 {
  const pan = calculateTimelineEdgePan(options);
  return pan
    ? offsetTimelineViewRange(options.viewRange, pan.deltaMs, options.chartEndMs)
    : options.viewRange;
}

interface TimelineZoomAtAnchorOptions {
  readonly anchorMs: number;
  readonly anchorRatio: number;
  readonly chartEndMs: number;
  readonly viewRange: TimeRangeV1;
  readonly zoomDelta: number;
}

function zoomTimelineViewRangeAtAnchor(options: TimelineZoomAtAnchorOptions): TimeRangeV1 {
  const scale = 2 ** options.zoomDelta;
  const durationMs = clamp(
    timelineViewDurationMs(options.viewRange) / scale,
    minimumTimelineViewDuration(options.chartEndMs),
    options.chartEndMs,
  );
  return clampTimelineViewRange(
    {
      startMs: options.anchorMs - (1 - options.anchorRatio) * durationMs,
      endMs: options.anchorMs + options.anchorRatio * durationMs,
    },
    options.chartEndMs,
  );
}

function timelineWheelDeltaFactor(deltaMode: number): number {
  if (deltaMode === 1) return 0.05;
  if (deltaMode === 2) return 1;
  return 0.002;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
