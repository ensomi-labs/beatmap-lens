// @vitest-environment happy-dom
import { parseOsu, renderDefaults, toManiaChart } from "beatmap-lens";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import CompareStage from "./CompareStage.vue";

let app: ReturnType<typeof createApp>;
let resize = () => {};

afterEach(() => {
  app.unmount();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});

it("renders audio samples just beyond the note-buffer boundary", async () => {
  const chart = toManiaChart(
    parseOsu(
      "osu file format v14\n[General]\nMode:3\n[Difficulty]\nCircleSize:4\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n",
    ),
  );
  const playhead = ref(1000.269);
  const charts: [typeof chart, typeof chart] = [chart, chart];
  const errors: unknown[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  app = createApp({
    render: () =>
      h(CompareStage, {
        charts,
        envelope: { step_ms: 10, energy: Array(2000).fill(1), onset: Array(2000).fill(0.5) },
        playheadMs: playhead.value,
        shown: [0, 1],
        tailShortenMs: renderDefaults.scene.tailShortenMs,
        visualSpeed: 240,
      }),
  });
  app.config.errorHandler = (error) => errors.push(error);
  app.mount(container);
  await sizePanes(container);
  playhead.value = 4000.268;
  await nextTick();

  expect(errors).toEqual([]);
  expect(container.querySelector(".compare-energy")?.getAttribute("d")).toMatch(/^M56,/);
});

it("draws long notes in both panes with the one shared tail shortening", async () => {
  const chart = toManiaChart(
    parseOsu(
      "osu file format v14\n[General]\nMode:3\n[Difficulty]\nCircleSize:4\n[HitObjects]\n64,192,1000,128,0,1500:0:0:0:0:\n",
    ),
  );
  const tailShortenMs = ref(100);
  const container = document.createElement("div");
  document.body.append(container);
  app = createApp({
    render: () =>
      h(CompareStage, {
        charts: [chart, chart],
        playheadMs: 1000,
        shown: [0, 1],
        tailShortenMs: tailShortenMs.value,
        visualSpeed: 240,
      }),
  });
  app.mount(container);
  await sizePanes(container);
  // 240 px/s draws 0.24 px for each millisecond of the 500 ms note.
  expectBothPanes(container, 96);

  tailShortenMs.value = 0;
  await nextTick();
  expectBothPanes(container, 120);
});

async function sizePanes(container: HTMLElement) {
  for (const pane of container.querySelectorAll(".compare-pane")) {
    Object.defineProperties(pane, { clientWidth: { value: 300 }, clientHeight: { value: 720 } });
  }
  resize();
  await nextTick();
}

function expectBothPanes(container: HTMLElement, heightPx: number) {
  const heights = [...container.querySelectorAll(".compare-pane .moving-note-group rect")].map(
    (rect) => Number(rect.getAttribute("height")),
  );
  expect(heights).toHaveLength(2);
  expect(heights[1]).toBe(heights[0]);
  expect(heights[0]).toBeCloseTo(heightPx);
}
