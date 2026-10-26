// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import TimingStage from "./TimingStage.vue";
import type { Mark } from "./timing/contracts";
import type { PlayheadMotion } from "./timing/display";

let app: ReturnType<typeof createApp>;
let frames: FrameRequestCallback[];
let overlayDraws: number;
/** Every fill style set on any canvas, in order. */
let fills: unknown[];
let events: unknown[][];
let exposed: { cancelDrag: () => boolean } | undefined;
/** Web Animations started on the playhead elements. */
let animations: {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  startTime: number | null;
  cancelled: boolean;
}[];

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
      if (key === "fillStyle") fills.push(value);
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
const loopRegion = { startMs: 0, endMs: 0 };
const proposals: never[] = [];

const props = reactive({
  playheadMs: 100,
  playheadMotion: undefined as PlayheadMotion | undefined,
  selectedIds: [] as string[],
  view: { startMs: 0, msPerPx: 10 },
});

beforeEach(() => {
  frames = [];
  overlayDraws = 0;
  fills = [];
  events = [];
  animations = [];
  props.playheadMs = 100;
  props.playheadMotion = undefined;
  props.selectedIds = [];
  props.view = { startMs: 0, msPerPx: 10 };
  HTMLElement.prototype.animate = function (keyframes, options) {
    const record = {
      element: this,
      keyframes: keyframes as Keyframe[],
      options: options as KeyframeAnimationOptions,
      startTime: null as number | null,
      cancelled: false,
    };
    animations.push(record);
    return {
      set startTime(value: number) {
        record.startTime = value;
      },
      cancel() {
        record.cancelled = true;
      },
    } as unknown as Animation;
  };
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
        ref: (instance) => {
          exposed = instance as unknown as typeof exposed;
        },
        buffer,
        span,
        bounds,
        view: props.view,
        proposals,
        marks,
        selectedIds: props.selectedIds,
        playheadMs: props.playheadMs,
        playheadMotion: props.playheadMotion,
        loopRegion,
        looping: false,
        onSelect: (...args: unknown[]) => events.push(["select", ...args]),
        onPlace: (...args: unknown[]) => events.push(["place", ...args]),
        onSeek: (...args: unknown[]) => events.push(["seek", ...args]),
        onLocate: (...args: unknown[]) => events.push(["locate", ...args]),
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

function playhead(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".timing-stage-playhead");
  if (!element) throw new Error("No playhead");
  return element;
}

it("places the playhead with a transform, like a mark, and redraws no canvas for it", async () => {
  await nextTick();
  runFrames();
  const before = overlayDraws;
  for (const timeMs of [150, 200.04, 250]) {
    props.playheadMs = timeMs;
    await nextTick();
    // x px is x × 10 ms; a one-device-pixel line sits on the pixel its time falls in.
    expect(playhead().style.transform).toBe(`translateX(${Math.floor(timeMs / 10)}px)`);
  }
  expect(overlayDraws).toBe(before);
  expect(frames).toHaveLength(0);
});

it("runs the playhead on the compositor while playing, placed again only for a new motion", async () => {
  await nextTick();
  runFrames();
  vi.spyOn(performance, "now").mockReturnValue(900);
  // Heard from page time 1000 ms at source 100 ms, at full speed, looping 200-400 ms.
  props.playheadMotion = {
    startPerfMs: 1000,
    holdMs: 100,
    speed: 1,
    firstEndMs: 400,
    loop: { startMs: 200, endMs: 400 },
  };
  await nextTick();
  const line = animations.filter((record) => record.element === playhead());
  expect(line).toHaveLength(2);
  expect(line.map((record) => record.startTime)).toEqual([1000, 1300]);
  // Centred on the time, unrounded: the line is 1 px wide.
  expect(line[0]?.keyframes).toEqual([
    { transform: "translateX(9.5px)" },
    { transform: "translateX(39.5px)" },
  ]);
  expect(line[1]?.options).toMatchObject({ duration: 200, iterations: Infinity, easing: "linear" });
  // The first pass holds its end until the loop piece takes over, so no frame shows the hold.
  expect(line.map((record) => record.options.fill)).toEqual(["forwards", "none"]);
  expect(playhead().style.transform).toBe("translateX(9.5px)");
  // The HUD's readouts while playing, and base redraws for a new selection, move nothing.
  const count = animations.length;
  props.playheadMs = 250;
  await nextTick();
  props.selectedIds = ["a"];
  await nextTick();
  runFrames();
  expect(animations).toHaveLength(count);
  // Stopping cancels the animations and holds the playhead still.
  props.playheadMotion = undefined;
  props.playheadMs = 321;
  await nextTick();
  expect(animations.every((record) => record.cancelled)).toBe(true);
  expect(playhead().style.transform).toBe("translateX(32px)");
});

it("holds a play's end, and starts a long-running loop's piece at a recent wrap", async () => {
  await nextTick();
  runFrames();
  const motion: PlayheadMotion = {
    startPerfMs: 1000,
    holdMs: 100,
    speed: 1,
    firstEndMs: 400,
    loop: null,
  };
  props.playheadMotion = motion;
  await nextTick();
  const once = animations.filter((record) => record.element === playhead());
  expect(once.map((record) => record.options.fill)).toEqual(["forwards"]);
  // Handed the loop again a minute in: its piece starts at the wrap at least 100 ms before now.
  vi.spyOn(performance, "now").mockReturnValue(61_000);
  props.playheadMotion = { ...motion, loop: { startMs: 200, endMs: 400 } };
  await nextTick();
  const looped = animations.filter((record) => record.element === playhead()).slice(-2);
  expect(looped.map((record) => record.startTime)).toEqual([1000, 1300 + 298 * 200]);
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
  pointer("pointermove", 50, 50);
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

it("places the playhead for a new view with the base frame that draws that view", async () => {
  await nextTick();
  runFrames();
  props.playheadMs = 500;
  await nextTick();
  expect(playhead().style.transform).toBe("translateX(50px)");
  // The view moves 100 ms: the playhead waits for the frame that redraws the stage.
  props.view = { startMs: 100, msPerPx: 10 };
  await nextTick();
  expect(playhead().style.transform).toBe("translateX(50px)");
  runFrames();
  expect(playhead().style.transform).toBe("translateX(40px)");
});

describe("locate", () => {
  const middle = { button: 1 };
  const option = { button: 0, altKey: true };

  it("locates with the middle button or Option+click on every lane, whatever the modifiers", () => {
    // Ruler, waveform (on mark a) and marks lane; then the overview, whose scale is the bounds.
    for (const y of [10, 50, 150]) {
      click(31, y, middle);
      click(31, y, { ...middle, shiftKey: true, metaKey: true });
      click(31, y, option);
      click(31, y, { ...option, shiftKey: true, ctrlKey: true });
    }
    click(0.5, 170, middle);
    expect(events).toEqual([
      ...Array.from({ length: 12 }, () => ["locate", 310, "end"]),
      ["view", { startMs: 500, msPerPx: 10 }],
      ["locate", 500, "end"],
    ]);
    // A plain click still selects, so the locate presses changed nothing else.
    click(31);
    expect(events.at(-1)).toEqual(["select", ["a"], "replace"]);
  });

  it("cancels the press and the mouse events after it, so nothing scrolls or pastes", () => {
    const send = (event: Event) => {
      overlay().dispatchEvent(event);
      return event.defaultPrevented;
    };
    const init = { clientX: 20, clientY: 50, pointerId: 1, bubbles: true, cancelable: true };
    expect(send(new PointerEvent("pointerdown", { ...init, ...middle }))).toBe(true);
    expect(send(new MouseEvent("mousedown", { ...init, ...middle }))).toBe(true);
    expect(send(new PointerEvent("pointerup", { ...init, ...middle }))).toBe(false);
    expect(send(new MouseEvent("auxclick", { ...init, ...middle }))).toBe(true);
    expect(send(new PointerEvent("pointerdown", { ...init, ...option }))).toBe(true);
    pointer("pointerup", 20, 50, option);
    expect(send(new PointerEvent("pointerdown", init))).toBe(false);
  });

  it("shows a dashed target while dragging and locates once, on release", async () => {
    await nextTick();
    runFrames();
    pointer("pointerdown", 20, 50, middle);
    pointer("pointermove", 22, 50, middle);
    expect(events).toEqual([]);
    pointer("pointermove", 30, 50, middle);
    await nextTick();
    expect(fills).toContain("rgba(255, 77, 79, 0.9)");
    pointer("pointermove", 40, 170, middle);
    pointer("pointerup", 45, 50, middle);
    expect(events).toEqual([
      ["locate", 300, "move"],
      ["locate", 400, "move"],
      ["locate", 450, "end"],
    ]);
  });

  it("Esc cancels a locate drag, and the release then does nothing", () => {
    pointer("pointerdown", 20, 50, middle);
    pointer("pointermove", 30, 50, middle);
    expect(exposed?.cancelDrag()).toBe(true);
    pointer("pointerup", 30, 50, middle);
    expect(events).toEqual([
      ["locate", 300, "move"],
      ["locate", 200, "cancel"],
    ]);
  });

  it("ignores a middle button chorded into a left drag", () => {
    pointer("pointerdown", 20, 50, { buttons: 1 });
    pointer("pointermove", 50, 50, { buttons: 1 });
    // The second button arrives as a move; a browser that sends a press instead is ignored too.
    pointer("pointermove", 52, 50, { button: 1, buttons: 5 });
    pointer("pointerdown", 52, 50, { button: 1, buttons: 5 });
    pointer("pointermove", 64, 50, { button: 0, buttons: 4 });
    pointer("pointerup", 64, 50, { button: 1, buttons: 0 });
    expect(events).toEqual([["select", ["a", "b"], "replace"]]);
  });
});
