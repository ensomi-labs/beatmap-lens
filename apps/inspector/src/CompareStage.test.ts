// @vitest-environment happy-dom
import { parseOsu, toManiaChart } from "beatmap-lens";
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import CompareStage from "./CompareStage.vue";

let app: ReturnType<typeof createApp>;

afterEach(() => {
  app.unmount();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("renders audio samples just beyond the note-buffer boundary", async () => {
  let resize = () => {};
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
        visualSpeed: 240,
      }),
  });
  app.config.errorHandler = (error) => errors.push(error);
  app.mount(container);
  const pane = container.querySelector(".compare-pane");
  if (!pane) throw new Error("No chart pane");
  Object.defineProperties(pane, { clientWidth: { value: 300 }, clientHeight: { value: 720 } });
  resize();
  await nextTick();
  playhead.value = 4000.268;
  await nextTick();

  expect(errors).toEqual([]);
  expect(container.querySelector(".compare-energy")?.getAttribute("d")).toMatch(/^M56,/);
});
