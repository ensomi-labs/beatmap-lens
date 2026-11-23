import { type TimeRange, type TimeView, xToMs } from "./time-view";

export const edgeAutoScrollZonePx = 40;
export const defaultEdgeAutoScrollFrameMs = 16.7;
export const maxEdgeAutoScrollFrameMs = 64;

export type AxisEdgeSide = "start" | "end";
export type HorizontalScrollEdge = "left" | "right";

export interface AxisEdgePenetrationOptions {
  readonly coordinatePx: number;
  readonly startPx: number;
  readonly endPx: number;
  readonly edgeZonePx?: number;
}

export interface AxisEdgePenetration {
  readonly side: AxisEdgeSide;
  readonly penetrationPx: number;
  readonly penetrationRatio: number;
}

export interface HorizontalClientRect {
  readonly left: number;
  readonly right: number;
  readonly width: number;
}

export interface HorizontalPointerXOptions {
  readonly clientX: number;
  readonly rect: HorizontalClientRect;
  readonly stageWidthPx?: number;
}

export interface HorizontalPointerX {
  readonly clampedClientX: number;
  readonly localX: number;
}

export interface HorizontalEdgePenetrationOptions {
  readonly localX: number;
  readonly widthPx: number;
  readonly edgeZonePx?: number;
}

export interface HorizontalClientEdgePenetrationOptions {
  readonly clientX: number;
  readonly rect: HorizontalClientRect;
  readonly edgeZonePx?: number;
}

export interface HorizontalEdgePenetration {
  readonly edge: HorizontalScrollEdge;
  readonly penetrationPx: number;
  readonly penetrationRatio: number;
}

export interface HorizontalEdgeScrollAdvanceOptions {
  readonly startMs: number;
  readonly visibleDurationMs: number;
  readonly bounds: TimeRange;
  readonly elapsedMs: number;
  readonly penetration: HorizontalEdgePenetration | undefined;
}

export interface HorizontalEdgeScrollAdvance {
  readonly startMs: number;
  readonly deltaMs: number;
  readonly velocityMsPerSecond: number;
  readonly atBoundary: boolean;
}

export interface TimeViewEdgeScrollAdvanceOptions {
  readonly view: TimeView;
  readonly widthPx: number;
  readonly bounds: TimeRange;
  readonly elapsedMs: number;
  readonly penetration: HorizontalEdgePenetration | undefined;
}

export interface TimeViewEdgeScrollAdvance {
  readonly view: TimeView;
  readonly deltaMs: number;
  readonly velocityMsPerSecond: number;
  readonly atBoundary: boolean;
}

export interface EdgeAutoScrollStep {
  readonly penetration: HorizontalEdgePenetration;
  readonly elapsedMs: number;
  readonly timestampMs: number;
}

export interface EdgeAutoScrollControllerOptions {
  /**
   * Advances one animation frame while the pointer lies inside an edge zone.
   * Return `false` when the scroll has reached its track boundary to pause the rAF loop until
   * the next pointer update.
   */
  readonly onFrame: (step: EdgeAutoScrollStep) => boolean | undefined;
  readonly edgeZonePx?: number;
  readonly defaultFrameMs?: number;
  readonly maxFrameMs?: number;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export interface EdgeAutoScrollController {
  readonly active: boolean;
  readonly penetration: HorizontalEdgePenetration | undefined;
  update(options: {
    readonly localX: number;
    readonly widthPx: number;
  }): HorizontalEdgePenetration | undefined;
  updateClient(options: {
    readonly clientX: number;
    readonly rect: HorizontalClientRect;
  }): HorizontalEdgePenetration | undefined;
  stop(): void;
}

export interface TimeViewEdgeAutoScrollerOptions {
  readonly getContext: () =>
    | {
        readonly view: TimeView;
        readonly widthPx: number;
        readonly bounds: TimeRange;
      }
    | undefined;
  readonly onScroll: (update: {
    readonly view: TimeView;
    readonly deltaMs: number;
    readonly velocityMsPerSecond: number;
    readonly pointerTimeMs: number;
  }) => void;
  readonly edgeZonePx?: number;
  readonly defaultFrameMs?: number;
  readonly maxFrameMs?: number;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export interface TimeViewEdgeAutoScroller {
  readonly active: boolean;
  readonly penetration: HorizontalEdgePenetration | undefined;
  update(options: {
    readonly localX: number;
    readonly widthPx: number;
  }): HorizontalEdgePenetration | undefined;
  updateClient(options: {
    readonly clientX: number;
    readonly rect: HorizontalClientRect;
  }): HorizontalEdgePenetration | undefined;
  stop(): void;
}

/**
 * 1D edge-zone penetration for `[startPx, endPx]`. Coordinates outside the interval clamp to full
 * penetration (`penetrationRatio = 1`), and coordinates strictly outside both edge zones return
 * `undefined`.
 */
export function axisEdgePenetration(
  options: AxisEdgePenetrationOptions,
): AxisEdgePenetration | undefined {
  const edgeZonePx = options.edgeZonePx ?? edgeAutoScrollZonePx;
  if (edgeZonePx <= 0 || options.endPx <= options.startPx) return undefined;

  const startPenetrationPx = clamp(
    edgeZonePx - (options.coordinatePx - options.startPx),
    0,
    edgeZonePx,
  );
  const endPenetrationPx = clamp(
    edgeZonePx - (options.endPx - options.coordinatePx),
    0,
    edgeZonePx,
  );
  const penetrationPx = Math.max(startPenetrationPx, endPenetrationPx);
  if (penetrationPx <= 0) return undefined;

  return {
    side: startPenetrationPx >= endPenetrationPx ? "start" : "end",
    penetrationPx,
    penetrationRatio: penetrationPx / edgeZonePx,
  };
}

/** Unsigned quadratic edge velocity (`p * p * visibleDurationMs`, in ms per second). */
export function quadraticEdgeVelocity(penetrationRatio: number, visibleDurationMs: number): number {
  const ratio = clamp(penetrationRatio, 0, 1);
  return ratio * ratio * Math.max(0, visibleDurationMs);
}

/** Clamps captured `clientX` to `rect` before projecting to stage coordinates. */
export function horizontalPointerX(options: HorizontalPointerXOptions): HorizontalPointerX {
  const clampedClientX = clamp(options.clientX, options.rect.left, options.rect.right);
  const targetWidth = options.stageWidthPx ?? options.rect.width;
  const localX =
    options.rect.width > 0
      ? ((clampedClientX - options.rect.left) / options.rect.width) * targetWidth
      : 0;
  return { clampedClientX, localX };
}

/** Horizontal edge-zone penetration for local stage coordinate `localX` in `[0, widthPx]`. */
export function horizontalEdgePenetration(
  options: HorizontalEdgePenetrationOptions,
): HorizontalEdgePenetration | undefined {
  const hit = axisEdgePenetration({
    coordinatePx: options.localX,
    startPx: 0,
    endPx: options.widthPx,
    ...(options.edgeZonePx !== undefined ? { edgeZonePx: options.edgeZonePx } : {}),
  });
  if (!hit) return undefined;
  return {
    edge: hit.side === "start" ? "left" : "right",
    penetrationPx: hit.penetrationPx,
    penetrationRatio: hit.penetrationRatio,
  };
}

/** Horizontal edge-zone penetration for viewport `clientX` against a stage `HorizontalClientRect`. */
export function horizontalClientEdgePenetration(
  options: HorizontalClientEdgePenetrationOptions,
): HorizontalEdgePenetration | undefined {
  const hit = axisEdgePenetration({
    coordinatePx: options.clientX,
    startPx: options.rect.left,
    endPx: options.rect.right,
    ...(options.edgeZonePx !== undefined ? { edgeZonePx: options.edgeZonePx } : {}),
  });
  if (!hit) return undefined;
  return {
    edge: hit.side === "start" ? "left" : "right",
    penetrationPx: hit.penetrationPx,
    penetrationRatio: hit.penetrationRatio,
  };
}

/** Signed horizontal velocity (`ms / s`): negative at the left edge, positive at the right edge. */
export function horizontalEdgeVelocityMsPerSecond(
  penetration: HorizontalEdgePenetration | undefined,
  visibleDurationMs: number,
): number {
  if (!penetration || visibleDurationMs <= 0) return 0;
  const direction = penetration.edge === "right" ? 1 : -1;
  return direction * quadraticEdgeVelocity(penetration.penetrationRatio, visibleDurationMs);
}

/** Advances a horizontal view window `[startMs, startMs + visibleDurationMs]` by one frame. */
export function advanceHorizontalEdgeScroll(
  options: HorizontalEdgeScrollAdvanceOptions,
): HorizontalEdgeScrollAdvance {
  const velocityMsPerSecond = horizontalEdgeVelocityMsPerSecond(
    options.penetration,
    options.visibleDurationMs,
  );
  const minStartMs = options.bounds.startMs;
  const maxStartMs = Math.max(
    options.bounds.startMs,
    options.bounds.endMs - options.visibleDurationMs,
  );
  const targetStartMs = options.startMs + (velocityMsPerSecond * options.elapsedMs) / 1_000;
  const startMs = clamp(targetStartMs, minStartMs, maxStartMs);
  const atBoundary =
    options.penetration?.edge === "left"
      ? startMs <= minStartMs
      : options.penetration?.edge === "right"
        ? startMs >= maxStartMs
        : false;

  return {
    startMs,
    deltaMs: startMs - options.startMs,
    velocityMsPerSecond,
    atBoundary,
  };
}

/** Advances a `TimeView` horizontally while keeping `msPerPx` constant and clamped to `bounds`. */
export function advanceTimeViewEdgeScroll(
  options: TimeViewEdgeScrollAdvanceOptions,
): TimeViewEdgeScrollAdvance {
  const visibleDurationMs = options.view.msPerPx * Math.max(0, options.widthPx);
  const advance = advanceHorizontalEdgeScroll({
    startMs: options.view.startMs,
    visibleDurationMs,
    bounds: options.bounds,
    elapsedMs: options.elapsedMs,
    penetration: options.penetration,
  });
  return {
    view:
      advance.deltaMs === 0
        ? options.view
        : { startMs: advance.startMs, msPerPx: options.view.msPerPx },
    deltaMs: advance.deltaMs,
    velocityMsPerSecond: advance.velocityMsPerSecond,
    atBoundary: advance.atBoundary,
  };
}

/**
 * Runs a `requestAnimationFrame` loop strictly while a dragged pointer stays inside the left or
 * right edge zone. Leaving the edge zone or calling `stop()` cancels any pending frame at once.
 */
export function createEdgeAutoScrollController(
  options: EdgeAutoScrollControllerOptions,
): EdgeAutoScrollController {
  const edgeZonePx = options.edgeZonePx ?? edgeAutoScrollZonePx;
  const defaultFrameMs = options.defaultFrameMs ?? defaultEdgeAutoScrollFrameMs;
  const maxFrameMs = options.maxFrameMs ?? maxEdgeAutoScrollFrameMs;
  const requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
  const cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));

  let currentPenetration: HorizontalEdgePenetration | undefined;
  let frameId: number | undefined;
  let lastTimestampMs: number | undefined;

  const cancelScheduledFrame = () => {
    if (frameId !== undefined) {
      cancelFrame(frameId);
      frameId = undefined;
    }
    lastTimestampMs = undefined;
  };

  const step: FrameRequestCallback = (timestampMs) => {
    frameId = undefined;
    if (!currentPenetration) {
      lastTimestampMs = undefined;
      return;
    }
    const elapsedMs =
      lastTimestampMs === undefined
        ? defaultFrameMs
        : clamp(timestampMs - lastTimestampMs, 0, maxFrameMs);
    lastTimestampMs = timestampMs;
    const keepRunning = options.onFrame({
      penetration: currentPenetration,
      elapsedMs,
      timestampMs,
    });
    if (!currentPenetration) return;
    if (keepRunning === false) {
      lastTimestampMs = undefined;
      return;
    }
    if (frameId === undefined) {
      frameId = requestFrame(step);
    }
  };

  const applyPenetration = (next: HorizontalEdgePenetration | undefined) => {
    currentPenetration = next;
    if (!next) {
      cancelScheduledFrame();
      return undefined;
    }
    if (frameId === undefined) {
      frameId = requestFrame(step);
    }
    return next;
  };

  return {
    get active() {
      return frameId !== undefined;
    },
    get penetration() {
      return currentPenetration;
    },
    update({ localX, widthPx }) {
      return applyPenetration(horizontalEdgePenetration({ localX, widthPx, edgeZonePx }));
    },
    updateClient({ clientX, rect }) {
      return applyPenetration(horizontalClientEdgePenetration({ clientX, rect, edgeZonePx }));
    },
    stop() {
      currentPenetration = undefined;
      cancelScheduledFrame();
    },
  };
}

/**
 * Turnkey `TimeView` horizontal edge auto-scroller: scrolls `view` while a dragged pointer stays
 * inside the 40 px edge zone, projects the clamped pointer position to `pointerTimeMs` on each
 * frame, and stops scheduling frames once `bounds` is reached.
 */
export function createTimeViewEdgeAutoScroller(
  options: TimeViewEdgeAutoScrollerOptions,
): TimeViewEdgeAutoScroller {
  let lastLocalX = 0;

  const controller = createEdgeAutoScrollController({
    ...(options.edgeZonePx !== undefined ? { edgeZonePx: options.edgeZonePx } : {}),
    ...(options.defaultFrameMs !== undefined ? { defaultFrameMs: options.defaultFrameMs } : {}),
    ...(options.maxFrameMs !== undefined ? { maxFrameMs: options.maxFrameMs } : {}),
    ...(options.requestFrame !== undefined ? { requestFrame: options.requestFrame } : {}),
    ...(options.cancelFrame !== undefined ? { cancelFrame: options.cancelFrame } : {}),
    onFrame({ penetration, elapsedMs }) {
      const context = options.getContext();
      if (!context || context.widthPx <= 0) return false;
      const result = advanceTimeViewEdgeScroll({
        view: context.view,
        widthPx: context.widthPx,
        bounds: context.bounds,
        elapsedMs,
        penetration,
      });
      if (result.deltaMs !== 0) {
        const clampedX = clamp(lastLocalX, 0, context.widthPx);
        options.onScroll({
          view: result.view,
          deltaMs: result.deltaMs,
          velocityMsPerSecond: result.velocityMsPerSecond,
          pointerTimeMs: xToMs(result.view, clampedX),
        });
      }
      return !result.atBoundary;
    },
  });

  return {
    get active() {
      return controller.active;
    },
    get penetration() {
      return controller.penetration;
    },
    update({ localX, widthPx }) {
      lastLocalX = localX;
      return controller.update({ localX, widthPx });
    },
    updateClient({ clientX, rect }) {
      lastLocalX = clientX - rect.left;
      return controller.updateClient({ clientX, rect });
    },
    stop() {
      controller.stop();
    },
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
