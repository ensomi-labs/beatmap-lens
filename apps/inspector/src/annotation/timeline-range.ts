import type { TimeRangeV1 } from "./contracts";
import type { ManiaNoteTimeIndex } from "./note-time-index";
import { type TimelineViewMapping, timelineYFromSourceTime } from "./timeline-view-range";

export interface TimelinePlacementOptions {
  readonly chartEndMs: number;
  readonly freePlacement?: boolean;
}

export type TimelineRangeEdge = "start" | "end";
export type TimelineRangeHitTarget = "body" | "end-edge" | "start-edge";
export type TimelineGestureKind =
  | "create-range"
  | "move-range"
  | "noop"
  | "pan-viewport"
  | "resize-end"
  | "resize-start";
export type TimelineOutOfViewDirection = "above" | "below";

export interface TimelineVerticalRangeGeometry {
  readonly y: number;
  readonly height: number;
  readonly startY: number;
  readonly endY: number;
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
}

export interface TimelineGestureSnapshot {
  readonly controlKey?: boolean;
  readonly rangeBodyHit?: boolean;
  readonly rangeHit?: TimelineRangeHitTarget;
  readonly shiftKey?: boolean;
}

export interface TimelineViewportPanStart {
  readonly grabOffsetMs: number;
  readonly viewportRange: TimeRangeV1;
}

export interface ManualRangeDraft {
  readonly start: string;
  readonly end: string;
}

export type TimeInputResult =
  | { readonly ok: true; readonly valueMs: number }
  | { readonly ok: false; readonly error: string };

export function snapTimelineTime(
  timeMs: number,
  index: ManiaNoteTimeIndex,
  options: TimelinePlacementOptions,
): number {
  const boundedTime = clamp(timeMs, 0, options.chartEndMs);
  if (options.freePlacement) {
    return boundedTime;
  }
  return clamp(index.nearestSnapPoint(boundedTime) ?? boundedTime, 0, options.chartEndMs);
}

/** Converts a CSS-pixel vertical edge target into timeline viewBox units. */
export function timelineEdgeHitHeight(
  renderedHeight: number,
  viewBoxHeight: number,
  exteriorTargetPx = 40,
): number {
  return (exteriorTargetPx * viewBoxHeight) / renderedHeight;
}

export function timelineRangeVerticalGeometry(
  range: TimeRangeV1,
  mapping: TimelineViewMapping,
  minimumHeight = 0,
): TimelineVerticalRangeGeometry | undefined {
  const startMs = Math.max(range.startMs, mapping.viewRange.startMs);
  const endMs = Math.min(range.endMs, mapping.viewRange.endMs);
  if (startMs >= endMs) return undefined;

  const startY = timelineYFromSourceTime(startMs, mapping);
  const endY = timelineYFromSourceTime(endMs, mapping);
  return {
    y: Math.min(startY, endY),
    height: Math.max(minimumHeight, Math.abs(startY - endY)),
    startY,
    endY,
    clippedStart: startMs > range.startMs,
    clippedEnd: endMs < range.endMs,
  };
}

export function timelineRangeOutOfView(
  range: TimeRangeV1,
  viewRange: TimeRangeV1,
): TimelineOutOfViewDirection | undefined {
  if (range.endMs <= viewRange.startMs) return "below";
  if (range.startMs >= viewRange.endMs) return "above";
  return undefined;
}

export function hitTimelineRangeTarget(
  pointerY: number,
  geometry: TimelineVerticalRangeGeometry | undefined,
  edgeHitHeight: number,
): TimelineRangeHitTarget | undefined {
  if (!geometry) return undefined;

  const startDistance = Math.abs(pointerY - geometry.startY);
  const endDistance = Math.abs(pointerY - geometry.endY);
  const hitsStart = startDistance <= edgeHitHeight;
  const hitsEnd = endDistance <= edgeHitHeight;
  if (hitsStart && hitsEnd) return startDistance < endDistance ? "start-edge" : "end-edge";
  if (hitsStart) return "start-edge";
  if (hitsEnd) return "end-edge";
  return timelineRangeBodyContainsY(pointerY, geometry) ? "body" : undefined;
}

export function timelineRangeBodyContainsY(
  pointerY: number,
  geometry: TimelineVerticalRangeGeometry | undefined,
): boolean {
  return Boolean(geometry && pointerY >= geometry.y && pointerY <= geometry.y + geometry.height);
}

export function classifyTimelineGesture(snapshot: TimelineGestureSnapshot): TimelineGestureKind {
  if (snapshot.shiftKey) return "create-range";
  if (snapshot.controlKey) {
    if (snapshot.rangeHit === "start-edge") return "resize-start";
    if (snapshot.rangeHit === "end-edge") return "resize-end";
    if (snapshot.rangeBodyHit || snapshot.rangeHit === "body") return "move-range";
    return "noop";
  }
  if (snapshot.rangeBodyHit || snapshot.rangeHit === "body") return "move-range";
  return "pan-viewport";
}

export function centerTimelineViewportRange(
  centerMs: number,
  durationMs: number,
  chartEndMs: number,
): TimeRangeV1 {
  return clampTimelineViewportRange(
    { startMs: centerMs - durationMs / 2, endMs: centerMs + durationMs / 2 },
    chartEndMs,
  );
}

export function beginTimelineViewportPan(
  pointerTimeMs: number,
  viewportRange: TimeRangeV1,
  chartEndMs: number,
): TimelineViewportPanStart {
  const durationMs = viewportRange.endMs - viewportRange.startMs;
  const initialRange =
    viewportRange.startMs <= pointerTimeMs && pointerTimeMs <= viewportRange.endMs
      ? clampTimelineViewportRange(viewportRange, chartEndMs)
      : centerTimelineViewportRange(pointerTimeMs, durationMs, chartEndMs);
  return {
    viewportRange: initialRange,
    grabOffsetMs: pointerTimeMs - initialRange.startMs,
  };
}

export function panTimelineViewportRange(
  pointerTimeMs: number,
  panStart: TimelineViewportPanStart,
  chartEndMs: number,
): TimeRangeV1 {
  const durationMs = panStart.viewportRange.endMs - panStart.viewportRange.startMs;
  return clampTimelineViewportRange(
    {
      startMs: pointerTimeMs - panStart.grabOffsetMs,
      endMs: pointerTimeMs - panStart.grabOffsetMs + durationMs,
    },
    chartEndMs,
  );
}

export function clampTimelineViewportRange(range: TimeRangeV1, chartEndMs: number): TimeRangeV1 {
  const durationMs = Math.min(range.endMs - range.startMs, chartEndMs);
  const startMs = clamp(range.startMs, 0, chartEndMs - durationMs);
  return { startMs, endMs: startMs + durationMs };
}

export function formatTimelineRangeTime(timeMs: number): string {
  const totalTenths = Math.round(timeMs / 100);
  const minutes = Math.floor(totalTenths / 600);
  const secondTenths = totalTenths % 600;
  const seconds = Math.floor(secondTenths / 10);
  const tenths = secondTenths % 10;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

export function formatTimelineRangeLabels(range: TimeRangeV1): ManualRangeDraft {
  return {
    start: formatTimelineRangeTime(range.startMs),
    end: formatTimelineRangeTime(range.endMs),
  };
}

export function createTimelineRange(
  anchorMs: number,
  focusMs: number,
  index: ManiaNoteTimeIndex,
  options: TimelinePlacementOptions,
): TimeRangeV1 | undefined {
  const anchor = snapTimelineTime(anchorMs, index, options);
  const focus = snapTimelineTime(focusMs, index, options);
  const startMs = Math.min(anchor, focus);
  const endMs = Math.max(anchor, focus);
  return startMs < endMs ? { startMs, endMs } : undefined;
}

export function moveTimelineRange(
  range: TimeRangeV1,
  deltaMs: number,
  index: ManiaNoteTimeIndex,
  options: TimelinePlacementOptions,
): TimeRangeV1 {
  const durationMs = range.endMs - range.startMs;
  const maximumStart = options.chartEndMs - durationMs;
  const proposedStart = clamp(range.startMs + deltaMs, 0, maximumStart);
  if (options.freePlacement) {
    return { startMs: proposedStart, endMs: proposedStart + durationMs };
  }

  const proposedEnd = proposedStart + durationMs;
  const startSnap = index.nearestSnapPoint(proposedStart);
  const endSnap = index.nearestSnapPoint(proposedEnd);
  const snapDeltas = [
    startSnap === undefined ? undefined : startSnap - proposedStart,
    endSnap === undefined ? undefined : endSnap - proposedEnd,
  ].filter((value): value is number => value !== undefined);
  const snappedDelta = snapDeltas
    .filter((value) => proposedStart + value >= 0 && proposedEnd + value <= options.chartEndMs)
    .sort((left, right) => Math.abs(left) - Math.abs(right))[0];
  const startMs = proposedStart + (snappedDelta ?? 0);
  return { startMs, endMs: startMs + durationMs };
}

export function resizeTimelineRange(
  range: TimeRangeV1,
  edge: TimelineRangeEdge,
  targetMs: number,
  index: ManiaNoteTimeIndex,
  options: TimelinePlacementOptions,
): TimeRangeV1 | undefined {
  const placedTime = snapTimelineTime(targetMs, index, options);
  const resized =
    edge === "start"
      ? { startMs: placedTime, endMs: range.endMs }
      : { startMs: range.startMs, endMs: placedTime };
  return resized.startMs < resized.endMs ? resized : undefined;
}

export function parseTimeInput(input: string): TimeInputResult {
  const value = input.trim();
  const clockMatch = /^(\d+):([0-5]\d)\.(\d{3})$/.exec(value);
  if (clockMatch) {
    const minutes = Number(clockMatch[1]);
    const seconds = Number(clockMatch[2]);
    const milliseconds = Number(clockMatch[3]);
    return { ok: true, valueMs: minutes * 60_000 + seconds * 1_000 + milliseconds };
  }

  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
    const valueMs = Number(value);
    if (Number.isFinite(valueMs)) {
      return { ok: true, valueMs };
    }
  }

  return {
    ok: false,
    error: "Use milliseconds or mm:ss.mmm.",
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
