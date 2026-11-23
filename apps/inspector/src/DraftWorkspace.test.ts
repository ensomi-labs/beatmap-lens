// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import DraftWorkspace from "./DraftWorkspace.vue";
import { draftJson, draftRequest } from "./draft/client";
import type { PatchOffer } from "./draft/ensomi-contract";

vi.mock("./draft/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./draft/client")>()),
  draftJson: vi.fn(),
  draftRequest: vi.fn(),
}));
const engine = vi.hoisted(() => ({
  plays: [] as { fromMs: number; loop: { startMs: number; endMs: number } | null }[],
  clicks: [] as (number[] | null)[],
}));
vi.mock("./timing/audio-engine", () => ({
  TimingAudioEngine: class {
    readonly sampleRate: number;
    playing = false;
    onEnded: (() => void) | undefined;
    constructor(sampleRate: number) {
      this.sampleRate = sampleRate;
    }
    load() {}
    setClickVolume() {}
    setClicks(beats: number[] | null) {
      engine.clicks.push(beats);
    }
    async play(options: { fromMs: number; loop: { startMs: number; endMs: number } | null }) {
      engine.plays.push(options);
      this.playing = true;
      return true;
    }
    stop() {
      this.playing = false;
      return undefined;
    }
    shownAt() {
      return undefined;
    }
    async close() {}
  },
}));

const json = vi.mocked(draftJson);
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  engine.plays = [];
  engine.clicks = [];
  json.mockImplementation(async (operation: string) => {
    if (operation === "trace/append") return {};
    throw new Error("No local service in this test.");
  });
  const container = document.createElement("div");
  document.body.append(container);
  app = createApp(DraftWorkspace);
  app.mount(container);
});

afterEach(() => {
  app.unmount();
  document.body.replaceChildren();
  localStorage.clear();
});

const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((entry) =>
    entry.textContent?.trim().startsWith(label),
  ) as HTMLButtonElement;
const press = (key: string, options: KeyboardEventInit = {}, type = "keydown") =>
  window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, ...options }));
const beatCount = () => Number(document.querySelector(".draft-beat-count")?.textContent);
const recomputeCalls = () => json.mock.calls.filter(([operation]) => operation === "recompute");

async function loadDemo() {
  button("Load demo").click();
  await vi.waitFor(() => expect(text()).toContain("Demo loaded without the local service"));
}

function shiftDrag(fromX: number, toX: number) {
  const svg = document.querySelector(".draft-svg") as SVGSVGElement;
  const init = { button: 0, pointerId: 1, bubbles: true, shiftKey: true };
  svg.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: fromX }));
  svg.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: toX }));
  svg.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: toX }));
}

function offer(id: string, t: number): PatchOffer {
  return {
    id,
    batchId: "b1",
    role: "alternative",
    scopeKind: "local",
    providerKind: "rule",
    provider: "rule mock (reserved for N1)",
    semanticKey: `alternative:${id}`,
    label: `Offer ${id}`,
    span: { t0: 1, t1: 2 },
    edits: [{ op: "move_beat", id: "d2", t, source: "rule" }],
    conflicts: [],
    consequences: { added: 0, moved: 1, removed: 0, maxShiftMs: 50, summary: `moves d2 to ${t}` },
  };
}

it("loads the demo with honest badges and a capability strip, and switches modes", async () => {
  await loadDemo();
  expect(text()).toContain("Draft · synthetic demo (mock)");
  expect(text()).toContain("Sounds · synthetic onsets (mock / experimental)");
  expect(text()).toContain("draft ✓");
  expect(text()).toContain("sounds (experimental)");
  expect(text()).toContain("constrained recompute ✗ (rule mock / reserved)");
  const audition = [
    ...document.querySelectorAll(".draft-mode-switch button"),
  ][1] as HTMLButtonElement;
  audition.click();
  await nextTick();
  expect(audition.getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector(".draft-views")).not.toBeNull();
  press("1");
  await nextTick();
  expect(audition.getAttribute("aria-pressed")).toBe("false");
  expect(document.querySelector(".draft-views")).toBeNull();
});

it("labels a real analysis as raw BeatThis with experimental onset-flux sounds and saves its trace", async () => {
  json.mockImplementation(async (operation: string) => {
    if (operation === "trace/append") return {};
    if (operation === "analyze")
      return {
        audio: {
          path: "/music/a.mp3",
          title: "a.mp3",
          durationS: 4,
          sampleRate: 44100,
          channels: 1,
        },
        beats: [0.5, 1, 1.5].map((t, k) => ({
          id: `m${k}`,
          t,
          source: "model",
          version: 1,
          conf: 0.9,
        })),
        sounds: [{ id: "o0", t: 0.5, emphasis: 1, source: "rule", version: 1, experimental: true }],
        boundaries: [],
        providers: {
          beats: { kind: "model", name: "BeatThis final0 (raw, un-folded)" },
          sounds: { kind: "rule", name: "onset-flux (log-Mel)", experimental: true },
        },
        tracePath: "/repo/.local/draft-traces/a.jsonl",
        runtime: "test",
      };
    throw new Error(operation);
  });
  vi.mocked(draftRequest).mockResolvedValue({
    arrayBuffer: async () => new Float32Array(8).buffer,
  } as Response);
  const input = document.querySelector("input[name=audio]") as HTMLInputElement;
  input.value = "/music/a.mp3";
  input.dispatchEvent(new Event("input"));
  await nextTick();
  button("Analyze").click();
  await vi.waitFor(() => expect(text()).toContain("Draft · BeatThis (raw, un-folded)"));
  expect(text()).toContain("Sounds · onset-flux (experimental / draft)");
  await vi.waitFor(() =>
    expect(json).toHaveBeenCalledWith("trace/append", {
      tracePath: "/repo/.local/draft-traces/a.jsonl",
      events: [expect.objectContaining({ seq: 1, type: "init" })],
    }),
  );
});

it("keeps statements and direct edits apart, and recomputes only when asked", async () => {
  await loadDemo();
  const beats = beatCount();
  shiftDrag(100, 300);
  press("e");
  await nextTick();
  expect(document.querySelectorAll(".draft-statement")).toHaveLength(1);
  expect(text()).toContain("Statement · recorded (not honored by raw BeatThis)");
  expect(beatCount()).toBe(beats);
  press("a");
  await nextTick();
  expect(beatCount()).toBe(beats + 1);
  expect(recomputeCalls()).toHaveLength(0);
  press("k", { metaKey: true });
  await vi.waitFor(() => expect(recomputeCalls()).toHaveLength(1));
  const [, body] = recomputeCalls()[0] ?? [];
  const { request } = body as {
    request: { statements: unknown[]; span: { t0: number; t1: number } };
  };
  expect(request.statements).toHaveLength(1);
  expect(request.span.t0).toBeCloseTo(2.4, 9);
  expect(request.span.t1).toBeCloseTo(7.2, 9);
});

it("plays an offer only while Alt is held and never swaps it mid-audition", async () => {
  await loadDemo();
  json.mockImplementation(async (operation: string) => {
    if (operation === "recompute")
      return {
        status: "ok",
        generation: 1,
        providerKind: "rule",
        provider: "rule mock",
        offers: [offer("A", 1.55), offer("B", 1.45)],
      };
    return {};
  });
  press("k", { metaKey: true });
  await vi.waitFor(() => expect(document.querySelectorAll(".draft-offer")).toHaveLength(2));
  expect(text()).toContain("Offer · rule mock (reserved for N1)");
  press("2");
  await nextTick();
  const active = () => document.querySelector(".draft-offer.is-active")?.textContent ?? "";
  press("Alt", { altKey: true });
  await nextTick();
  expect(engine.clicks.at(-1)).toContain(1550);
  press("«", { code: "Backslash", altKey: true });
  press("Tab", { altKey: true });
  await nextTick();
  expect(active()).toContain("Offer A");
  expect(document.querySelectorAll(".draft-offer")).toHaveLength(2);
  expect(text()).toContain("Release Alt");
  press("Alt", {}, "keyup");
  await nextTick();
  expect(engine.clicks.at(-1)).toContain(1500);
  expect(engine.clicks.at(-1)).not.toContain(1550);
  press("\\", { code: "Backslash" });
  await nextTick();
  expect(active()).toContain("Offer B");
  expect(text()).toContain("moves d2 to 1.45");
  press("Tab");
  await nextTick();
  expect(document.querySelectorAll(".draft-offer")).toHaveLength(0);
  expect(engine.clicks.at(-1)).toContain(1450);
});

it("tours the trouble spans with J and Shift+J, looping each with clicks on", async () => {
  await loadDemo();
  const rows = () => [...document.querySelectorAll(".draft-tour-row")];
  expect(rows().length).toBeGreaterThan(1);
  press("j");
  await nextTick();
  expect(rows()[0]?.classList.contains("is-active")).toBe(true);
  const first = engine.plays.at(-1);
  expect(first?.loop).not.toBeNull();
  expect(engine.clicks.at(-1)?.length).toBeGreaterThan(0);
  press("j");
  await nextTick();
  expect(rows()[1]?.classList.contains("is-active")).toBe(true);
  press("J", { shiftKey: true });
  await nextTick();
  expect(rows()[0]?.classList.contains("is-active")).toBe(true);
  expect(engine.plays.at(-1)?.loop).toEqual(first?.loop);
});
