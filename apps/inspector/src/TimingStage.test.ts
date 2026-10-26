// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import TimingStage from "./TimingStage.vue";
import type { Mark } from "./timing/contracts";

let app: ReturnType<typeof createApp>;
let frames: FrameRequestCallback[];
let overlayDraws: number;
let events: unknown[][];

/** A 2D context that accepts every call; `clearRect` happens only when the overlay is drawn. */
function context(): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = {};
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return () => ({ width: 0 });
      if (key === "clearRect") return () => overlayDraws++;
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function mark(id: string, time_ms: number): Mark {
  return {
    id,
    kind: "beat",
    time_ms,
    placed: "2026-10-26T09:00:00.000Z",
    method: "click",
    zoom_ms_per_px: 10,
    rate_at_placement: 1,
    blind: true,
    nudged_ms: 0,
    snapped_to: null,
  };
}

// Stable like the workspace's computed props, so a playhead change alone changes nothing else.
const marks = [mark("a", 300), mark("b", 600)];
const span = { startMs: 100, endMs: 900 };
const bounds = { startMs: 0, endMs: 1000 };
const view = { startMs: 0, msPerPx: 10 };
const loopRegion = { startMs: 0, endMs: 0 };
const proposals: never[] = [];

const props = reactive({
  playheadMs: 100,
  selectedIds: [] as string[],
});

beforeEach(() => {
  frames = [];
  overlayDraws = 0;
  events = [];
  props.playheadMs = 100;
  props.selectedIds = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("Worker", undefined);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context() as never);
  HTMLElement.prototype.setPointerCapture ??= () => {};
  const channel = new Float32Array(44_100);
  const buffer = {
    sampleRate: 44_100,
    length: channel.length,
    numberOfChannels: 1,
    getChannelData: () => channel,
  } as unknown as AudioBuffer;
  const container = document.createElement("div");
  document.body.append(container);
  // In this DOM the stage measures 0 px, so the lanes are: ruler 0–20 px, waveform 20–140 px,
  // marks 140–156 px, overview below; x px is x × 10 ms.
  app = createApp({
    render: () =>
      h(TimingStage, {
        buffer,
        span,
        bounds,
        view,
        proposals,
        marks,
        selectedIds: props.selectedIds,
        playheadMs: props.playheadMs,
        loopRegion,
        looping: false,
        onSelect: (...args: unknown[]) => events.push(["select", ...args]),
        onPlace: (...args: unknown[]) => events.push(["place", ...args]),
        onSeek: (...args: unknown[]) => events.push(["seek", ...args]),
        "onLoop-region": (...args: unknown[]) => events.push(["loop", ...args]),
        "onUpdate:view": (...args: unknown[]) => events.push(["view", ...args]),
      }),
  });
  app.mount(container);
});

afterEach(() => {
  app.unmount();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function overlay(): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>(".timing-stage-overlay");
  if (!canvas) throw new Error("No overlay");
  return canvas;
}

function pointer(type: string, x: number, y: number, init: PointerEventInit = {}) {
  overlay().dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true, ...init }),
  );
}

function click(x: number, y = 50, init: PointerEventInit = {}) {
  pointer("pointerdown", x, y, init);
  pointer("pointerup", x, y, init);
}

function drag(fromX: number, toX: number, init: PointerEventInit = {}) {
  pointer("pointerdown", fromX, 50, init);
  pointer("pointermove", toX, 50, init);
  pointer("pointerup", toX, 50, init);
}

function runFrames() {
  for (const frame of frames.splice(0)) frame(0);
}

it("redraws the playhead on every change while the frames keep coming", async () => {
  await nextTick();
  runFrames();
  // Playback moves the playhead from inside each animation frame; the drawing must not wait for
  // a frame requested from there, which used to be cancelled and requested again every time.
  for (const timeMs of [150, 200, 250, 300]) {
    const before = overlayDraws;
    props.playheadMs = timeMs;
    await nextTick();
    expect(overlayDraws).toBe(before + 1);
  }
});

it("keeps a requested base frame instead of requesting another for each change", async () => {
  await nextTick();
  const pending = frames.length;
  props.selectedIds = ["a"];
  await nextTick();
  props.selectedIds = ["a", "b"];
  await nextTick();
  expect(frames.length - pending).toBeLessThanOrEqual(1);
});

it("selects with a click or a drag and places a beat only with Shift", () => {
  click(31);
  click(60, 50, { metaKey: true });
  click(45);
  drag(25, 65);
  drag(25, 65, { metaKey: true });
  click(45, 50, { shiftKey: true });
  click(5, 50, { shiftKey: true });
  click(45, 50, { button: 2 });
  click(45, 10);
  expect(events).toEqual([
    ["select", ["a"], "replace"],
    ["select", ["b"], "toggle"],
    ["select", [], "replace"],
    ["select", ["a", "b"], "replace"],
    ["select", ["a", "b"], "add"],
    ["place", "beat", 450],
    ["seek", 50],
    ["place", "unbeat", 450],
    ["seek", 450],
  ]);
});

it("keeps Shift+drag for the loop region", () => {
  drag(25, 65, { shiftKey: true });
  expect(events).toEqual([["loop", { startMs: 250, endMs: 650 }]]);
});

it("draws the overlay with a pending base frame, so the layers never disagree", async () => {
  await nextTick();
  runFrames();
  props.selectedIds = ["a"];
  await nextTick();
  const before = overlayDraws;
  props.playheadMs = 500;
  await nextTick();
  expect(overlayDraws).toBe(before);
  runFrames();
  expect(overlayDraws).toBe(before + 1);
});

it("on Retina, a click that wobbles a few pixels still clicks and a mark's glyph is hit", () => {
  vi.stubGlobal("devicePixelRatio", 2);
  window.dispatchEvent(new Event("resize"));
  // 3 px of movement: a click on mark a, not a drag.
  pointer("pointerdown", 33, 50);
  pointer("pointermove", 36, 50);
  pointer("pointerup", 36, 50);
  // Shift with 6 px of movement still places a beat rather than a tiny loop.
  pointer("pointerdown", 45, 50, { shiftKey: true });
  pointer("pointermove", 51, 50, { shiftKey: true });
  pointer("pointerup", 51, 50, { shiftKey: true });
  // A band that ends just short of mark a still takes it, as its glyph is touched.
  drag(22, 28);
  expect(events).toEqual([
    ["select", ["a"], "replace"],
    ["place", "beat", 510],
    ["select", ["a"], "replace"],
  ]);
});
