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
        span: { startMs: 100, endMs: 900 },
        bounds: { startMs: 0, endMs: 1000 },
        view: { startMs: 0, msPerPx: 10 },
        proposals: [],
        marks: [mark("a", 300), mark("b", 600)],
        selectedIds: props.selectedIds,
        playheadMs: props.playheadMs,
        loopRegion: { startMs: 0, endMs: 0 },
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

it("redraws the playhead on every change while the frames keep coming", async () => {
  await nextTick();
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
