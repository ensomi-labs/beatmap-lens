// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import DraftWorkspace from "./DraftWorkspace.vue";
import { draftJson, draftRequest } from "./draft/client";
import { computeSemanticKey, type PatchOffer } from "./draft/ensomi-contract";

vi.mock("./draft/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./draft/client")>()),
  draftJson: vi.fn(),
  draftRequest: vi.fn(),
}));
const engine = vi.hoisted(() => ({
  plays: [] as { fromMs: number; loop: { startMs: number; endMs: number } | null }[],
  clicks: [] as (number[] | null)[],
  stops: 0,
  playHook: null as
    | ((options: {
        fromMs: number;
        loop: { startMs: number; endMs: number } | null;
      }) => Promise<boolean>)
    | null,
}));
vi.mock("./timing/audio-engine", () => ({
  TimingAudioEngine: class {
    readonly sampleRate: number;
    playing = false;
    starting = false;
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
      if (engine.playHook) {
        this.starting = true;
        const ok = await engine.playHook(options);
        this.starting = false;
        this.playing = ok;
        return ok;
      }
      this.playing = true;
      return true;
    }
    stop() {
      engine.stops += 1;
      this.starting = false;
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
const request = vi.mocked(draftRequest);
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  engine.plays = [];
  engine.clicks = [];
  engine.stops = 0;
  engine.playHook = null;
  request.mockReset();
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
  const writeScope = { t0: 1, t1: 2 };
  const ops = {
    upsertBeats: [{ id: "d2", t, source: "rule" as const }],
    expectedVersions: { d2: 1 },
  };
  return {
    id,
    batchId: "b1",
    role: "alternative",
    scopeKind: "local",
    providerId: "rule mock (reserved for N1)",
    providerKind: "rule",
    generation: 1,
    basisSeq: 2,
    readScope: writeScope,
    writeScope,
    ops,
    summary: `Offer ${id}`,
    consequences: { beatsAdded: 0, beatsMoved: 1, beatsRemoved: 0 },
    conflicts: [],
    semanticKey: computeSemanticKey(writeScope, ops),
    status: "pending",
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
      events: [
        expect.objectContaining({ schemaVersion: "0.1", seq: 0, type: "audio_bound" }),
        expect.objectContaining({ schemaVersion: "0.1", seq: 1, type: "draft_loaded" }),
      ],
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
  expect(text()).toContain("moves 1 beat (max 50.0 ms)");
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

it("blocks Tab acceptance when an offer conflicts with an active keep constraint", async () => {
  await loadDemo();
  // Select a span covering d2 (at 1.5 s) and record a keep statement (V).
  shiftDrag(40, 120);
  press("v");
  await nextTick();
  json.mockImplementation(async (operation: string) => {
    if (operation === "recompute")
      return {
        status: "ok",
        generation: 1,
        providerKind: "rule",
        provider: "rule mock",
        offers: [offer("A", 1.55)],
      };
    return {};
  });
  press("k", { metaKey: true });
  await vi.waitFor(() => expect(document.querySelectorAll(".draft-offer")).toHaveLength(1));
  expect(text()).toContain('violates active "keep"');
  press("2");
  await nextTick();
  press("Tab");
  await nextTick();
  expect(text()).toContain("Blocked by conflict");
  expect(document.querySelectorAll(".draft-offer")).toHaveLength(1);
});

it("keeps a failed trace append queued, retries the prefix in order, and only shows Trace saved when flushed", async () => {
  const appendedSeqs: number[][] = [];
  let failEdit2 = true;
  json.mockImplementation(async (operation: string, body: unknown) => {
    if (operation === "demo") {
      return { audioPath: "/tmp/demo.wav", tracePath: "/tmp/demo.jsonl" };
    }
    if (operation === "trace/append") {
      const { events } = body as { events: { seq: number }[] };
      const seqs = events.map((e) => e.seq);
      appendedSeqs.push(seqs);
      if (failEdit2 && seqs.includes(2)) {
        failEdit2 = false;
        throw new Error("temporary write error");
      }
      return { appended: seqs.length, skipped: 0 };
    }
    throw new Error(operation);
  });
  button("Load demo").click();
  await vi.waitFor(() => expect(text()).toContain("Trace saved"));

  // Edit 2 fails -> UI must NOT say "Trace saved" and must show unsaved + Retry save.
  press("a");
  await vi.waitFor(() => expect(text()).toContain("Trace unsaved (1)"));
  expect(text()).not.toContain("Trace saved");
  expect(button("Retry save")).toBeDefined();

  // Edit 3 triggers retry of the ENTIRE unacknowledged prefix [2, 3] in order!
  press("a");
  await vi.waitFor(() => expect(text()).toContain("Trace saved"));
  expect(appendedSeqs).toEqual([[0, 1], [2], [2, 3]]);
});

it("drops in-flight recompute from previous track on switch and disables Play when next track PCM fails", async () => {
  await loadDemo();
  let resolveOldRecompute!: (value: unknown) => void;
  json.mockImplementation(async (operation: string) => {
    if (operation === "recompute") {
      return new Promise((resolve) => {
        resolveOldRecompute = resolve;
      });
    }
    if (operation === "analyze") {
      return {
        audio: {
          path: "/music/b.mp3",
          title: "b.mp3",
          durationS: 8,
          sampleRate: 44100,
          channels: 1,
        },
        beats: [{ id: "m0", t: 0.5, source: "model", version: 1, conf: 0.9 }],
        sounds: [],
        boundaries: [],
        providers: {
          beats: { kind: "model", name: "BeatThis" },
          sounds: { kind: "rule", name: "onset-flux", experimental: true },
        },
        tracePath: "/tmp/b.jsonl",
        runtime: "test",
      };
    }
    if (operation === "trace/append") return {};
    throw new Error(operation);
  });
  request.mockRejectedValue(new Error("ffmpeg failed"));

  // Start recompute on demo (track A), then switch to track B whose PCM fails.
  press("k", { metaKey: true });
  await vi.waitFor(() => expect(resolveOldRecompute).toBeDefined());
  const input = document.querySelector("input[name=audio]") as HTMLInputElement;
  input.value = "/music/b.mp3";
  input.dispatchEvent(new Event("input"));
  await nextTick();
  button("Analyze").click();
  await vi.waitFor(() => expect(text()).toContain("ffmpeg failed"));

  // Play button must be disabled (not reusing track A's buffer!).
  const playButton = document.querySelector(".tool-button--play") as HTMLButtonElement;
  expect(playButton.disabled).toBe(true);

  // Even if track A's recompute now resolves, its offers must NOT land in track B!
  resolveOldRecompute({
    status: "ok",
    generation: 1,
    providerKind: "rule",
    provider: "rule mock",
    offers: [offer("stale-from-A", 1.55)],
  });
  await nextTick();
  await new Promise((r) => setTimeout(r, 10));
  expect(document.querySelectorAll(".draft-offer")).toHaveLength(0);
});

it("pins the auditioned offer while Alt is held, blocks undo, and flushes buffered recomputes on release", async () => {
  await loadDemo();
  let call = 0;
  let resolveSecond!: (value: unknown) => void;
  json.mockImplementation(async (operation: string) => {
    if (operation === "recompute") {
      call += 1;
      if (call === 1) {
        return {
          status: "ok",
          generation: 1,
          providerKind: "rule",
          provider: "rule mock",
          offers: [offer("A", 1.55)],
        };
      }
      return new Promise((resolve) => {
        resolveSecond = resolve;
      });
    }
    return {};
  });
  press("a"); // create an undoable edit
  await nextTick();
  const countBefore = beatCount();
  press("k", { metaKey: true });
  await vi.waitFor(() => expect(document.querySelectorAll(".draft-offer")).toHaveLength(1));

  press("2");
  await nextTick();
  // Kick off second recompute, then hold Alt on offer A before it returns.
  press("k", { metaKey: true });
  await vi.waitFor(() => expect(resolveSecond).toBeDefined());
  press("Alt", { altKey: true });
  await nextTick();
  expect(engine.clicks.at(-1)).toContain(1550);

  // Undo while Alt is held must be blocked.
  press("z", { metaKey: true });
  await nextTick();
  expect(beatCount()).toBe(countBefore);

  // Resolve second recompute while Alt is still held -> must buffer, NOT swap clicks or offers!
  resolveSecond({
    status: "ok",
    generation: 2,
    providerKind: "rule",
    provider: "rule mock",
    offers: [offer("C", 1.62)],
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(document.querySelector(".draft-offer.is-active")?.textContent).toContain("Offer A");
  expect(engine.clicks.at(-1)).toContain(1550);

  // Release Alt -> buffered Offer C flushes cleanly!
  press("Alt", {}, "keyup");
  await vi.waitFor(() => expect(text()).toContain("Offer C"));
});

it("does not start audition playback after Stop or view switch while WAV render or blob awaits", async () => {
  json.mockImplementation(async (operation: string) => {
    if (operation === "demo") return { audioPath: "/tmp/demo.wav", tracePath: "/tmp/demo.jsonl" };
    if (operation === "trace/append") return {};
    throw new Error(operation);
  });
  const audioPlay = vi.fn().mockResolvedValue(undefined);
  const audioPause = vi.fn();
  const OrigAudio = globalThis.Audio;
  const origCreateUrl = URL.createObjectURL;
  const origRevokeUrl = URL.revokeObjectURL;
  // @ts-expect-error test stub
  globalThis.Audio = class {
    loop = false;
    paused = true;
    play = audioPlay;
    pause = audioPause;
  };
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();

  try {
    button("Load demo").click();
    await vi.waitFor(() => expect(text()).toContain("Trace saved"));
    press("2");
    await nextTick();

    let resolveBlob!: (blob: Blob) => void;
    request.mockResolvedValue({
      blob: () =>
        new Promise<Blob>((resolve) => {
          resolveBlob = resolve;
        }),
    } as Response);

    button("Low <250").click();
    await vi.waitFor(() => expect(resolveBlob).toBeDefined());
    // Press Esc (Stop) before response.blob() resolves
    press("Escape");
    await nextTick();
    resolveBlob(new Blob([new Uint8Array(16)], { type: "audio/wav" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(audioPlay).not.toHaveBeenCalled();

    // Pending mix start cancelled by Stop during engine.play() await
    let resolveMixPlay!: (ok: boolean) => void;
    engine.playHook = () =>
      new Promise<boolean>((resolve) => {
        resolveMixPlay = resolve;
      });
    press(" ");
    await vi.waitFor(() => expect(resolveMixPlay).toBeDefined());
    const stopsBefore = engine.stops;
    press("Escape");
    expect(engine.stops).toBeGreaterThan(stopsBefore);
    resolveMixPlay(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(button("Play")).toBeDefined();
  } finally {
    globalThis.Audio = OrigAudio;
    URL.createObjectURL = origCreateUrl;
    URL.revokeObjectURL = origRevokeUrl;
  }
});

it("flushes coalesced nudges before adding a beat so the new beat never steals the old preview time", async () => {
  await loadDemo();
  // Select beat d1 (at 1.0 s) and nudge right (+1 ms -> 1.001 s).
  const hit = document.querySelector('[data-beat-id="d1"]') as SVGRectElement;
  hit.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 1, bubbles: true }));
  await nextTick();
  press("ArrowRight");
  await nextTick();
  // Immediately add a beat at cursor (0.0 s) within 400 ms and nudge it right (+1 ms -> 0.001 s).
  press("a");
  await nextTick();
  press("ArrowRight");
  await nextTick();
  // Wait for settle (>400 ms) or trigger commit via mode switch.
  press("2");
  await nextTick();
  // Selected beat is the newly added beat at 0.001 s, NOT 1.002 s!
  expect(text()).toContain("00:00.001");
  expect(text()).not.toContain("00:01.002");
});

it("attaches ResizeObserver when the stage mounts after a track loads", async () => {
  const observed: Element[] = [];
  const callbacks: (() => void)[] = [];
  const OrigRO = globalThis.ResizeObserver;
  // @ts-expect-error test stub
  globalThis.ResizeObserver = class {
    constructor(cb: () => void) {
      callbacks.push(cb);
    }
    observe(el: Element) {
      observed.push(el);
    }
    disconnect() {}
  };
  try {
    // Remount fresh without a track -> stage is not mounted yet.
    app.unmount();
    const container = document.createElement("div");
    document.body.append(container);
    app = createApp(DraftWorkspace);
    app.mount(container);
    expect(observed).toHaveLength(0);

    await loadDemo();
    await nextTick();
    const wrap = document.querySelector(".draft-stage-wrap") as HTMLElement;
    expect(wrap).not.toBeNull();
    expect(observed).toContain(wrap);
    Object.defineProperty(wrap, "clientWidth", { value: 777, configurable: true });
    for (const cb of callbacks) cb();
    await nextTick();
    expect(document.querySelector(".draft-svg")?.getAttribute("width")).toBe("777");
  } finally {
    globalThis.ResizeObserver = OrigRO;
  }
});

it("bounds flam check to contain both sound and nearest slot, and guards 0-beat tracks", async () => {
  // 1. Track with 0 beats and 1 unexplained sound: pressing G in Audition must not play.
  json.mockImplementation(async (operation: string) => {
    if (operation === "trace/append") return {};
    if (operation === "analyze") {
      return {
        audio: {
          path: "/music/zero.mp3",
          title: "zero.mp3",
          durationS: 10,
          sampleRate: 44100,
          channels: 1,
        },
        beats: [],
        sounds: [{ id: "o0", t: 4.0, emphasis: 1, source: "rule", version: 1, experimental: true }],
        boundaries: [],
        providers: {
          beats: { kind: "model", name: "BeatThis" },
          sounds: { kind: "rule", name: "onset-flux", experimental: true },
        },
        tracePath: "/tmp/zero.jsonl",
        runtime: "test",
      };
    }
    throw new Error(operation);
  });
  request.mockResolvedValue({
    arrayBuffer: async () => new Float32Array(16).buffer,
  } as Response);
  const input = document.querySelector("input[name=audio]") as HTMLInputElement;
  input.value = "/music/zero.mp3";
  input.dispatchEvent(new Event("input"));
  await nextTick();
  button("Analyze").click();
  await vi.waitFor(() => expect(text()).toContain("zero.mp3"));
  press("2");
  await nextTick();
  press("g", { code: "KeyG" });
  await nextTick();
  expect(engine.plays).toHaveLength(0);
  expect(text()).toContain("No beats available");

  // 2. Track with beat at 2.0 s and sound at 4.0 s: flam loop must contain BOTH 2.0 s and 4.0 s!
  json.mockImplementation(async (operation: string) => {
    if (operation === "trace/append") return {};
    if (operation === "analyze") {
      return {
        audio: {
          path: "/music/far.mp3",
          title: "far.mp3",
          durationS: 10,
          sampleRate: 44100,
          channels: 1,
        },
        beats: [{ id: "m0", t: 2.0, source: "model", version: 1, conf: 0.9 }],
        sounds: [{ id: "o0", t: 4.0, emphasis: 1, source: "rule", version: 1, experimental: true }],
        boundaries: [],
        providers: {
          beats: { kind: "model", name: "BeatThis" },
          sounds: { kind: "rule", name: "onset-flux", experimental: true },
        },
        tracePath: "/tmp/far.jsonl",
        runtime: "test",
      };
    }
    throw new Error(operation);
  });
  input.value = "/music/far.mp3";
  input.dispatchEvent(new Event("input"));
  await nextTick();
  button("Analyze").click();
  await vi.waitFor(() => expect(text()).toContain("far.mp3"));
  await vi.waitFor(() =>
    expect((document.querySelector(".tool-button--play") as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  press("g", { code: "KeyG" });
  await vi.waitFor(() => expect(engine.plays.length).toBeGreaterThan(0));
  const loop = engine.plays.at(-1)?.loop;
  expect(loop?.startMs).toBeCloseTo(1600, 3);
  expect(loop?.endMs).toBeCloseTo(4400, 3);
  expect(text()).toContain("2000.0 ms late");
});
