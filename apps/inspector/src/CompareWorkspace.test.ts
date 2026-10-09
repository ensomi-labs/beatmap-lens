// @vitest-environment happy-dom
import { parseOsu, toManiaChart } from "beatmap-lens";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { MediaPlaybackClock } from "./annotation/media-playback-clock";
import type { SessionPreferences } from "./annotation/session-store";
import CompareWorkspace from "./CompareWorkspace.vue";
import { comparisonJson, comparisonRequest } from "./compare/client";
import type { OpenComparison, VerdictRecord } from "./compare/contracts";

vi.mock("./compare/client", () => ({ comparisonJson: vi.fn(), comparisonRequest: vi.fn() }));
vi.mock("./compare/audio-envelope", () => ({
  decodeEnvelope: async () => ({ step_ms: 10, energy: [0, 1], onset: [0, 1] }),
}));
const preferences = vi.hoisted(() => ({ value: undefined as SessionPreferences | undefined }));
vi.mock("./annotation/session-store", () => ({
  IndexedDbSessionStore: class {
    async getPreferences() {
      return preferences.value;
    }
    async setPreferences(value: SessionPreferences) {
      preferences.value = value;
    }
  },
}));
vi.mock("./annotation/media-playback-clock", () => ({
  MediaPlaybackClock: vi.fn(function FakeMediaPlaybackClock() {
    let listener = (_state: unknown) => {};
    const clock = {
      currentTimeMs: 0,
      playing: false,
      subscribe(callback: (state: unknown) => void) {
        listener = callback;
      },
      seek: vi.fn((time: number) => {
        clock.currentTimeMs = time;
        listener(clock);
      }),
      loopSelection: vi.fn(async (range: { startMs: number }) => {
        clock.playing = true;
        clock.currentTimeMs = range.startMs;
        listener(clock);
      }),
      pause: vi.fn(() => {
        clock.playing = false;
        listener(clock);
      }),
      setPlaybackRate: vi.fn(),
      setAudioOffsetMs: vi.fn(),
      setAudioVolume: vi.fn(),
      dispose: vi.fn(),
    };
    return clock;
  }),
}));

const excerpt = { id: "one", start_ms: 1000, end_ms: 16_000, hint: "Listen for the breath." };
const saved: VerdictRecord = {
  version: 1,
  id: "saved-one",
  comparison_id: "trial",
  pair_id: "song",
  excerpt,
  shown_a: { model: "Model hidden-one", chart_path: "/one.osu", sha256: "one" },
  shown_b: { model: "Model hidden-two", chart_path: "/two.osu", sha256: "two" },
  verdict: "a_better",
  note: "",
  playback_rate: 1,
  time: "2026-10-09T00:00:00.000Z",
};
const opened: OpenComparison = {
  session_id: "session",
  verdict_path: "/results/trial.verdicts.jsonl",
  pairs: [
    {
      title: "Song",
      excerpts: [
        { ...excerpt, saved: false },
        { ...excerpt, id: "two", start_ms: 20_000, end_ms: 35_000, saved: false },
      ],
    },
  ],
};
const chart = toManiaChart(
  parseOsu(
    "osu file format v14\n[General]\nMode:3\n[Difficulty]\nCircleSize:4\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n",
  ),
);

let app: ReturnType<typeof createApp>;
let container: HTMLElement;

beforeEach(() => {
  preferences.value = {
    annotatorId: "listener",
    audioOffsetMs: 45,
    musicEnabled: true,
    visualSpeed: 900,
  };
  vi.stubGlobal(
    "Audio",
    class extends EventTarget {
      load() {
        queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata")));
      }
      removeAttribute() {}
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.mocked(comparisonJson).mockImplementation(async (operation, body) => {
    if (operation === "open") return structuredClone(opened);
    if (operation === "excerpt") return { charts: [chart, chart] };
    if (operation === "verdict") return { ...saved, ...(body as object) };
    throw new Error(operation);
  });
  vi.mocked(comparisonRequest).mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
  container = document.createElement("div");
  document.body.append(container);
  app = createApp(CompareWorkspace);
  app.mount(container);
});

afterEach(() => {
  app.unmount();
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("switches A/B without touching playback and reveals the models only after saving", async () => {
  await open();
  expect(container.textContent).not.toContain("Model hidden");
  expect(panes()).toEqual(["Chart A", "Chart B"]);

  await click("Loop excerpt");
  const clock = vi.mocked(MediaPlaybackClock).mock.results[0]?.value;
  clock.seek(7000);
  await click("A");
  expect(panes()).toEqual(["Chart A"]);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
  await nextTick();
  expect(panes()).toEqual(["Chart B"]);
  expect(clock.currentTimeMs).toBe(7000);
  expect(clock.playing).toBe(true);
  expect(clock.loopSelection).toHaveBeenCalledOnce();

  type("The quiet part breathes.");
  await click("A better");
  await vi.waitFor(() => expect(container.textContent).toContain("Saved · A better"));
  expect(comparisonJson).toHaveBeenCalledWith("verdict", {
    session_id: "session",
    pair_index: 0,
    excerpt_index: 0,
    verdict: "a_better",
    note: "The quiet part breathes.",
    playback_rate: 1,
  });
  expect(container.textContent).toContain("Model hidden-one");

  await click("Next excerpt");
  await vi.waitFor(() => expect(container.textContent).not.toContain("Model hidden"));
  expect(clock.currentTimeMs).toBe(20_000);
  expect(container.querySelector("textarea")?.value).toBe("");
  expect(comparisonRequest).toHaveBeenCalledOnce();
});

it("stays blind and keeps the note when saving fails, then saves on retry", async () => {
  await open();
  vi.mocked(comparisonJson).mockRejectedValueOnce(new Error("Output folder is not writable."));
  type("Needs another listen.");
  await click("Can't tell");
  await vi.waitFor(() => expect(container.textContent).toContain("Output folder is not writable."));
  expect(container.textContent).not.toContain("Model hidden");
  expect(container.querySelector("textarea")?.value).toBe("Needs another listen.");
  await click("Can't tell");
  await vi.waitFor(() => expect(container.textContent).toContain("Saved · Can't tell"));
});

it("restores, applies, and saves the shared audio offset", async () => {
  await open();
  const clock = vi.mocked(MediaPlaybackClock).mock.results[0]?.value;
  const input = container.querySelector<HTMLInputElement>(".audio-offset-editor input");
  if (!input) throw new Error("No audio offset field");
  expect(input.value).toBe("45");
  expect(vi.mocked(MediaPlaybackClock).mock.calls[0]?.[3]).toBe(45);

  const previous = preferences.value;
  input.value = "-80";
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(new Event("blur"));
  expect(clock.setAudioOffsetMs).toHaveBeenLastCalledWith(-80);
  await vi.waitFor(() => expect(preferences.value).toEqual({ ...previous, audioOffsetMs: -80 }));

  await click("+10");
  expect(input.value).toBe("-70");
  await click("Reset");
  expect(input.value).toBe("0");
  expect(clock.setAudioOffsetMs).toHaveBeenLastCalledWith(0);
  await vi.waitFor(() => expect(preferences.value?.audioOffsetMs).toBe(0));
});

it("defaults to 80% and restores volume without interrupting comparison playback", async () => {
  await open();
  const clock = vi.mocked(MediaPlaybackClock).mock.results[0]?.value;
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Volume"]');
  if (!input) throw new Error("No volume control");
  expect(input.value).toBe("80");
  expect(clock.setAudioVolume).toHaveBeenCalledWith(0.8);
  await click("Loop excerpt");
  clock.seek(7000);
  const previous = preferences.value;
  input.value = "35";
  input.dispatchEvent(new Event("input"));
  expect(clock.setAudioVolume).toHaveBeenLastCalledWith(0.35);
  expect(clock.currentTimeMs).toBe(7000);
  expect(clock.playing).toBe(true);
  expect(clock.loopSelection).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(preferences.value).toEqual({ ...previous, audioVolume: 0.35 }));

  app.unmount();
  vi.mocked(MediaPlaybackClock).mockClear();
  vi.mocked(comparisonRequest).mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
  app = createApp(CompareWorkspace);
  app.mount(container);
  await open();
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Volume"]')?.value).toBe("35");
  expect(vi.mocked(MediaPlaybackClock).mock.results[0]?.value.setAudioVolume).toHaveBeenCalledWith(
    0.35,
  );
});

async function open() {
  const input = container.querySelector<HTMLInputElement>('input[name="manifest"]');
  if (!input) throw new Error("No manifest field");
  input.value = "/trial.json";
  input.dispatchEvent(new Event("input"));
  container.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(MediaPlaybackClock).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(panes()).toHaveLength(2));
}

async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === text,
  );
  if (!button) throw new Error(`No button: ${text}`);
  button.click();
  await nextTick();
}

function type(text: string) {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("No note field");
  textarea.value = text;
  textarea.dispatchEvent(new Event("input"));
}

function panes() {
  return [...container.querySelectorAll(".compare-pane")].map((pane) =>
    pane.getAttribute("aria-label"),
  );
}
