// @vitest-environment happy-dom
import {
  computeGridFit,
  type EditOp,
  type PatchOffer,
  projectRedLines,
  type Range,
  rankInboxSpans,
  ScriptedMockProvider,
  SessionController,
  type SnapCandidate,
  serializeState,
} from "ensomi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import type { TempoRecomputeResponse, TempoSongSessionPayload, TempoSongSummary } from "./client";
import {
  AuditionSliceCache,
  computeAuditionWindow,
  MAX_AUDITION_SLICE_CACHE_BYTES,
  MAX_AUDITION_SLICE_CACHE_ENTRIES,
} from "./state";
import TempoWorkspace from "./TempoWorkspace.vue";

const engineSpy = vi.hoisted(() => ({
  plays: 0,
  stops: 0,
  loads: 0,
  swaps: 0,
  unloads: 0,
  lastBufferChannels: null as Float32Array[] | null,
  lastPlayOptions: null as {
    fromMs: number;
    endMs: number;
    rate: number;
    loop: { startMs: number; endMs: number } | null;
  } | null,
  clicks: [] as (number[] | null)[],
  clickVolumes: [] as number[],
  playing: false,
  positionMs: 0,
  forceContextSampleRate: null as number | null,
  overrideHeardAt: undefined as (() => number | undefined) | undefined,
  overrideAudioFrames: null as number | null,
}));

vi.mock("../stage-audio", async () => {
  const actual = await vi.importActual<typeof import("../stage-audio")>("../stage-audio");
  return {
    ...actual,
    StageAudioEngine: class {
      readonly sampleRate: number;
      readonly context: { decodeAudioData: (buf: ArrayBuffer) => Promise<AudioBuffer> };
      loaded: AudioBuffer | undefined;
      playing = false;
      starting = false;
      onEnded: ((posMs: number) => void) | undefined;

      constructor(sampleRate: number) {
        this.sampleRate = engineSpy.forceContextSampleRate ?? sampleRate;
        this.context = {
          decodeAudioData: async (buf: ArrayBuffer) => {
            // Support synthetic float32 test payload marker (`AUD!`) or default 16s buffer.
            if (buf.byteLength >= 12) {
              const dv = new DataView(buf);
              if (dv.getUint32(0, true) === 0x21445541) {
                const len = dv.getUint32(4, true);
                const fill = dv.getFloat32(8, true);
                const data = new Float32Array(len).fill(fill);
                return {
                  numberOfChannels: 1,
                  sampleRate: this.sampleRate,
                  length: len,
                  duration: len / this.sampleRate,
                  getChannelData: () => data,
                } as unknown as AudioBuffer;
              }
            }
            const defaultFrames = engineSpy.overrideAudioFrames ?? this.sampleRate * 16;
            return {
              numberOfChannels: 1,
              sampleRate: this.sampleRate,
              length: defaultFrames,
              duration: defaultFrames / this.sampleRate,
              getChannelData: () => new Float32Array(defaultFrames),
            } as unknown as AudioBuffer;
          },
        };
      }

      createBuffer(channels: Float32Array[], frames: number): AudioBuffer {
        const cloned = channels.map((c) => Float32Array.from(c));
        return {
          numberOfChannels: cloned.length,
          sampleRate: this.sampleRate,
          length: frames,
          duration: frames / this.sampleRate,
          getChannelData: (c: number) => cloned[c] ?? new Float32Array(frames),
        } as unknown as AudioBuffer;
      }

      load(channels: Float32Array[], frames: number): AudioBuffer {
        engineSpy.loads += 1;
        const buf = this.createBuffer(channels, frames);
        this.loaded = buf;
        engineSpy.lastBufferChannels = channels.map((c) => Float32Array.from(c));
        return buf;
      }

      swapBuffer(nextBuffer: AudioBuffer) {
        engineSpy.swaps += 1;
        this.loaded = nextBuffer;
        engineSpy.lastBufferChannels = Array.from({ length: nextBuffer.numberOfChannels }, (_, c) =>
          Float32Array.from(nextBuffer.getChannelData(c)),
        );
      }

      unload() {
        engineSpy.unloads += 1;
        this.playing = false;
        engineSpy.playing = false;
        this.loaded = undefined;
      }

      async play(opts: {
        fromMs: number;
        endMs: number;
        rate: number;
        loop: { startMs: number; endMs: number } | null;
      }) {
        engineSpy.plays += 1;
        engineSpy.playing = true;
        engineSpy.positionMs = opts.fromMs;
        engineSpy.lastPlayOptions = opts;
        this.playing = true;
        return true;
      }

      stop() {
        engineSpy.stops += 1;
        engineSpy.playing = false;
        this.playing = false;
        return engineSpy.positionMs;
      }

      sampleClock() {}
      motion() {
        return undefined;
      }
      shownAt() {
        return engineSpy.positionMs;
      }
      heardAt() {
        if (engineSpy.overrideHeardAt) {
          return engineSpy.overrideHeardAt();
        }
        return this.playing ? engineSpy.positionMs : undefined;
      }
      setClicks(beats: number[] | null) {
        engineSpy.clicks.push(beats ? [...beats] : null);
      }
      setVolume() {}
      setClickVolume(val: number) {
        engineSpy.clickVolumes.push(val);
      }
      async close() {
        this.playing = false;
      }
    },
  };
});

const stageHook = vi.hoisted(() => ({
  props: {} as Record<string, unknown>,
  emit: undefined as ((event: string, ...args: unknown[]) => void) | undefined,
}));

vi.mock("./TempoStage.vue", () => ({
  default: defineComponent({
    inheritAttrs: false,
    emits: [
      "resize",
      "update:view",
      "manual-pan",
      "hover-time",
      "select",
      "range-select",
      "place-beat",
      "place-unbeat",
      "apply-snap",
      "seek",
      "locate",
    ],
    setup(_, { attrs, emit, expose }) {
      stageHook.emit = emit as (event: string, ...args: unknown[]) => void;
      expose({ cancelDrag: () => false });
      return () => {
        stageHook.props = attrs;
        const inlineSnaps = (
          (attrs.snapCandidates ?? attrs["snap-candidates"]) as SnapCandidate[] | undefined
        )?.slice(0, 4);
        const sel = attrs.selection as { kind?: string } | undefined;
        return h(
          "div",
          { class: "tempo-stage-stub" },
          sel?.kind === "beat" && inlineSnaps && inlineSnaps.length > 0
            ? inlineSnaps.map((cand, i) =>
                h(
                  "button",
                  {
                    type: "button",
                    class: "tempo-snap-chip-stub",
                    onClick: () => emit("apply-snap", cand),
                  },
                  `${i + 1} ${cand.label}`,
                ),
              )
            : [],
        );
      };
    },
  }),
}));

interface MockSongRecord {
  summary: TempoSongSummary;
  controller: SessionController;
  redoStack: string[];
  snapsCalls: number[];
  holdCalls: boolean[];
}

function makeSongRecord(songId: string, title: string, fileName: string): MockSongRecord {
  const provider = new ScriptedMockProvider({
    draft: {
      segments: [
        { id: "seg_0", t0: 0, t1: 8, regime: "auto", kept: false },
        { id: "seg_1", t0: 8, t1: 16, regime: "auto", kept: false },
      ],
      beats: [
        { id: "b-s14-01", timeSec: 1.0, confidence: 0.92 },
        { id: "b-s14-02", timeSec: 2.0, confidence: 0.35 },
        { id: "b-s14-03", timeSec: 3.0, confidence: 0.91 },
        { id: "b-s14-04", timeSec: 4.0, confidence: 0.93 },
        { id: "b-s14-05", timeSec: 9.0, confidence: 0.92 },
        { id: "b-s14-06", timeSec: 10.0, confidence: 0.92 },
      ],
      sounds: [
        { id: "snd_01", timeSec: 1.0, strength: 0.9 },
        { id: "snd_02", timeSec: 2.18, strength: 0.88 },
        { id: "snd_03", timeSec: 9.0, strength: 0.85 },
      ],
    },
    snapScript: [
      ({ request }) => [
        {
          eventId: "evt_kick_01",
          targetSec: Number((request.timeSec + 0.008).toFixed(4)),
          deltaMs: 8.0,
          family: "percussion",
          role: "transient_attack",
          label: "Kick transient",
          salience: 0.94,
        },
        {
          eventId: "evt_pad_02",
          targetSec: Number((request.timeSec - 0.014).toFixed(4)),
          deltaMs: -14.0,
          family: "strings_winds",
          role: "p_center",
          label: "Strings swell",
          salience: 0.72,
        },
      ],
    ],
    script: [
      ({ request }) => {
        const segId = "seg_0";
        const t0 = request.scope === "song" ? 0 : request.scope.t0;
        const t1 = request.scope === "song" ? 8 : Math.min(8, request.scope.t1);
        const offerA: PatchOffer = {
          id: "offer_internal_alpha_01",
          batchId: "batch_internal_99",
          semanticKey: "sk:internal_hash_abc123",
          providerId: "ensomi-tempo-daemon",
          providerKind: "model",
          generation: request.generation,
          basisSeq: request.basisSeq,
          expectedRevisions: {},
          writeScopes: [{ segmentId: segId, t0, t1 }],
          scopeKind: "local",
          optionIndex: 1,
          optionCount: 2,
          title: "Align triplet pickup",
          consequenceSummary: "Moves 1 beat (+18 ms) and adds 1 pickup beat",
          advisoryNotes: ["Soft cue near 0:02.0 shifted by 6 ms to match kick attack"],
          ops: {
            upsertBeats: [
              { id: "b-offer-a1", timeSec: 2.018, source: "offer" },
              { id: "b-offer-a2", timeSec: 2.5, source: "offer" },
            ],
            removeBeatIds: ["b-s14-02"],
          },
          consequences: {
            beatsAdded: 1,
            beatsMoved: 1,
            beatsRemoved: 0,
            maxShiftMs: 18,
            segmentChanges: 0,
          },
          conflicts: [],
          status: "valid",
        };
        const offerB: PatchOffer = {
          ...offerA,
          id: "offer_internal_beta_02",
          semanticKey: "sk:internal_hash_def456",
          optionIndex: 2,
          optionCount: 2,
          title: "Hold steady duple pulse",
          consequenceSummary: "Keeps 4 beats steady across 0:00.0–0:08.0",
          advisoryNotes: [],
          ops: {
            upsertBeats: [{ id: "b-offer-b1", timeSec: 2.004, source: "offer" }],
            removeBeatIds: ["b-s14-02"],
          },
        };
        return {
          batchId: "batch_internal_99",
          offers: [offerA, offerB],
        };
      },
    ],
  });

  const controller = new SessionController({ provider });
  return {
    summary: {
      songId,
      title,
      fileName,
      audioPath: `/music/${fileName}`,
      durationSec: 16,
      analyzed: false,
      segmentCount: 0,
      keptSegmentCount: 0,
      inboxCount: 0,
      highestPriority: null,
      ready: false,
      updatedAtMs: 1000,
    },
    controller,
    redoStack: [],
    snapsCalls: [],
    holdCalls: [],
  };
}

function buildPayload(rec: MockSongRecord): TempoSongSessionPayload {
  const st = rec.controller.getState();
  const serialized = serializeState(st);
  const gridFit = computeGridFit(st.sounds, st.beats, st.segments);
  const inboxSpans = rankInboxSpans(st);
  const redLineProjection = projectRedLines(st.beats, st.segments, { spans: st.spans });
  const summary: TempoSongSummary = {
    ...rec.summary,
    durationSec: st.durationSec || 16,
    analyzed: st.beats.size > 0 || st.segments.length > 0,
    segmentCount: st.segments.length,
    keptSegmentCount: st.segments.filter((s) => s.kept).length,
    inboxCount: inboxSpans.length,
    highestPriority: inboxSpans[0]?.priority ?? null,
    ready: st.ready,
  };
  rec.summary = summary;
  return {
    song: summary,
    songSummary: summary,
    state: serialized,
    gridFit,
    inboxSpans,
    redLineProjection,
    layerStates: {
      song_open: rec.controller.getLayerState("song_open"),
      micro_assist: rec.controller.getLayerState("micro_assist"),
      heavy_recompute: rec.controller.getLayerState("heavy_recompute"),
    },
    holdingOffers: rec.controller.isHoldingOffers(),
    heldOffers: rec.controller.getHeldOffers(),
    canUndo: rec.controller.canUndo(),
    canRedo: rec.controller.canRedo(),
  };
}

async function flushUi() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

describe("TempoWorkspace interactive UI", () => {
  let songsMap: Map<string, MockSongRecord>;
  let activeSongId: string;
  let container: HTMLElement;
  let app: ReturnType<typeof createApp> | null = null;

  beforeEach(() => {
    localStorage.clear();
    Object.assign(engineSpy, {
      plays: 0,
      stops: 0,
      loads: 0,
      swaps: 0,
      unloads: 0,
      lastBufferChannels: null,
      lastPlayOptions: null,
      clicks: [],
      clickVolumes: [],
      playing: false,
      positionMs: 0,
      forceContextSampleRate: null,
      overrideHeardAt: undefined,
      overrideAudioFrames: null,
    });

    const song1 = makeSongRecord("01-campanella-a1b2c3d4", "01 - Lime - Campanella", "01.mp3");
    const song2 = makeSongRecord("02-hyper-vivacity-e5f60718", "02 - Hyper Vivacity", "02.mp3");
    songsMap = new Map([
      [song1.summary.songId, song1],
      [song2.summary.songId, song2],
    ]);
    activeSongId = song1.summary.songId;

    window.history.replaceState({}, "", "/tempo");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === "string" ? input : input.toString();
        const url = new URL(rawUrl, "http://127.0.0.1");
        const path = url.pathname;
        const method = init?.method ?? "GET";
        const body =
          init?.body && typeof init.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {};

        const jsonRes = (data: unknown) =>
          new Response(JSON.stringify(data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });

        if (path === "/api/tempo/workspace" && method === "GET") {
          return jsonRes({
            schemaVersion: 1,
            workspaceDir: "/music/hard-songs",
            activeSongId,
            songs: Array.from(songsMap.values()).map((r) => r.summary),
            triggerPolicy: song1.controller.getTriggerPolicy(),
          });
        }

        const songMatch = path.match(/^\/api\/tempo\/songs\/([^/]+)(?:\/(.+))?$/);
        if (songMatch) {
          const id = decodeURIComponent(songMatch[1] ?? "");
          const rest = songMatch[2] ?? "";
          const rec = songsMap.get(id);
          if (!rec) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });

          if (rest === "open" && method === "POST") {
            activeSongId = id;
            if (!rec.controller.getState().audio) {
              await rec.controller.openSong({
                songId: id,
                durationSec: 16,
                sampleRate: 44_100,
                clock: "source-audio-sec",
              });
            }
            return jsonRes(buildPayload(rec));
          }

          if ((rest === "audio" || rest === "audition") && method === "GET") {
            return new Response(new ArrayBuffer(64), {
              status: 200,
              headers: { "Content-Type": "audio/wav" },
            });
          }

          if (rest === "snaps" && method === "POST") {
            const timeSec = Number(body.timeSec ?? 0);
            rec.snapsCalls.push(timeSec);
            const outcome = await rec.controller.suggestSnaps({
              timeSec,
              windowSec: Number(body.windowSec ?? 0.12),
              immediate: true,
            });
            return jsonRes({
              status: outcome.status,
              songId: id,
              generation: outcome.generation,
              candidates: outcome.candidates,
            });
          }

          if (rest === "edit" && method === "POST") {
            if (body.action === "undo") {
              rec.controller.undo();
            } else if (body.action === "redo") {
              rec.controller.redo();
            } else {
              const ops = (body.ops ?? body.op) as EditOp | EditOp[];
              rec.controller.applyEdit(ops);
            }
            return jsonRes(buildPayload(rec));
          }

          if (rest === "recompute" && method === "POST") {
            const scope = (body.scope ?? "song") as Range | "song";
            const outcome = await rec.controller.recompute({
              scope,
              reason: String(body.reason ?? "User recompute"),
            });
            const payload: TempoRecomputeResponse = {
              ...buildPayload(rec),
              status: outcome.status,
              generation: outcome.generation,
              offers: outcome.offers,
              suppressedOffers: outcome.suppressedOffers,
            };
            return jsonRes(payload);
          }

          if (rest === "hold-offers" && method === "POST") {
            const hold = Boolean(body.hold);
            rec.holdCalls.push(hold);
            const { flushed, offers } = rec.controller.setHoldOffers(hold);
            return jsonRes({
              ...buildPayload(rec),
              hold: rec.controller.isHoldingOffers(),
              flushed,
              offers,
            });
          }

          const offerMatch = rest.match(/^offers\/([^/]+)\/(accept|reject)$/);
          if (offerMatch && method === "POST") {
            const offerId = decodeURIComponent(offerMatch[1] ?? "");
            const act = offerMatch[2];
            if (act === "accept") {
              const outcome = rec.controller.acceptOffer(offerId);
              return jsonRes({ ...buildPayload(rec), ...outcome });
            }
            const outcome = rec.controller.rejectOffer(offerId);
            return jsonRes({ ...buildPayload(rec), ...outcome });
          }
        }

        throw new Error(`Unhandled mock fetch: ${method} ${path}`);
      }),
    );

    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mountWorkspace() {
    app = createApp(TempoWorkspace);
    app.mount(container);
    await flushUi();
    stageHook.emit?.("resize", 900, 1);
    await flushUi();
  }

  function requireSong(songId: string): MockSongRecord {
    const rec = songsMap.get(songId);
    if (!rec) throw new Error(`Missing mock song ${songId}`);
    return rec;
  }

  it("renders standalone Tempo toolbar with Import & Export, zero mode tabs, and zero vanity panels", async () => {
    await mountWorkspace();

    expect(container.querySelector(".workspace-mode-switch")).toBeNull();
    const toolbarButtons = Array.from(container.querySelectorAll(".frame-toolbar button")).map(
      (b) => b.textContent?.trim() ?? "",
    );
    expect(toolbarButtons).toContain("Import");
    expect(toolbarButtons).toContain("Export");
    expect(toolbarButtons).not.toContain("inspect");
    expect(toolbarButtons).not.toContain("annotate");
    expect(toolbarButtons).not.toContain("timing");

    const panelTitles = Array.from(container.querySelectorAll(".panel-section-title")).map(
      (el) => el.textContent?.trim() ?? "",
    );
    expect(panelTitles).toContain("Songs");
    expect(panelTitles).toContain("Inbox");
    expect(panelTitles).not.toContain("Track");
    expect(panelTitles).not.toContain("Capabilities");
    expect(panelTitles).not.toContain("Draft");

    // Zero internal IDs in rendered text
    const text = container.textContent ?? "";
    expect(text).not.toContain("01-campanella-a1b2c3d4");
    expect(text).not.toContain("seg_0");
    expect(text).not.toContain("b-s14-01");
  });

  it("supports multi-song switching, Inbox focus/loop, and Keep clearing covered Inbox items", async () => {
    await mountWorkspace();

    const songRows = container.querySelectorAll("#tempo-songs .tempo-list-row");
    expect(songRows.length).toBe(2);
    expect(songRows[0]?.textContent).toContain("01 - Lime - Campanella");

    // Initial song has Inbox items (low beat confidence + unexplained sound at 2.18s)
    const inboxBefore = container.querySelectorAll("#tempo-inbox .tempo-inbox-row");
    expect(inboxBefore.length).toBeGreaterThan(0);

    // Click first Inbox item -> focuses Range & turns on Loop
    (inboxBefore[0] as HTMLButtonElement).click();
    await flushUi();
    expect(stageHook.props.looping).toBe(true);
    expect(stageHook.props.activeRange ?? stageHook.props["active-range"]).toBeTruthy();

    // Press Escape to clear transient range, then press V to Keep whole Segment 1 in 1 step
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushUi();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "v" }));
    await flushUi();

    // Segment 1 ([0, 8)) is now Kept and all Inbox items inside [0, 8) are cleared!
    const inboxAfterFirstKeep = Array.from(
      container.querySelectorAll("#tempo-inbox .tempo-inbox-time"),
    ).map((el) => el.textContent ?? "");
    expect(inboxAfterFirstKeep.some((t) => t.startsWith("0:00") || t.startsWith("0:02"))).toBe(
      false,
    );
    expect(songRows[0]?.textContent).toContain("1/2");

    // Select Segment 2 on TempoSegmentStrip and press V -> all Inbox items cleared!
    const segCells = container.querySelectorAll(".tempo-seg-cell");
    (segCells[1] as HTMLElement | undefined)?.click();
    await flushUi();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "v" }));
    await flushUi();

    const inboxAfterAllKept = container.querySelectorAll("#tempo-inbox .tempo-inbox-row");
    expect(inboxAfterAllKept.length).toBe(0);
    expect(songRows[0]?.textContent).toContain("Ready");

    // Switch to second song
    (songRows[1] as HTMLButtonElement).click();
    await flushUi();
    expect(container.querySelector(".tempo-song-identity")?.textContent).toContain(
      "02 - Hyper Vivacity",
    );
  });

  it("supports whole-song Segment strip split (S), merge (M), boundary move, and [ / ] cursor Range selection", async () => {
    await mountWorkspace();
    const song1 = requireSong("01-campanella-a1b2c3d4");
    expect(song1.controller.getState().segments.length).toBe(2);

    // Move hover cursor to 4.0s and split with S
    stageHook.emit?.("hover-time", 4000);
    await flushUi();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }));
    await flushUi();
    expect(song1.controller.getState().segments.length).toBe(3);

    // Merge back with M
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }));
    await flushUi();
    expect(song1.controller.getState().segments.length).toBe(2);

    // Drag interior boundary handle on TempoSegmentStrip
    const handle = container.querySelector(".tempo-seg-boundary") as HTMLElement | null;
    expect(handle).not.toBeNull();
    const strip = container.querySelector(".tempo-segment-strip") as HTMLElement;
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 30,
      width: 800,
      height: 30,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    handle?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 400 }));
    handle?.dispatchEvent(new PointerEvent("pointermove", { clientX: 450 }));
    handle?.dispatchEvent(new PointerEvent("pointerup", { clientX: 450 }));
    await flushUi();
    expect(song1.controller.getState().segments[0]?.t1).toBeCloseTo(9.0, 2);

    // [ and ] cursor Range selection
    stageHook.emit?.("hover-time", 2000);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "[" }));
    stageHook.emit?.("hover-time", 6000);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "]" }));
    await flushUi();

    const activeRange = (stageHook.props.activeRange ?? stageHook.props["active-range"]) as Range;
    expect(activeRange).toEqual({ t0: 2, t1: 6 });

    // Free on selected Range (`R`)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    await flushUi();
    expect(song1.controller.getState().spans.some((sp) => sp.kind === "free")).toBe(true);
  });

  it("places Beat (B) with micro_assist snaps & snap_beat, standalone Unbeat (U) with 1-step Undo, Sound (N), and Fine-Tune nudges", async () => {
    await mountWorkspace();
    const song1 = requireSong("01-campanella-a1b2c3d4");

    // Place Beat at 5.2s -> triggers snaps without writing trace lines for snaps
    stageHook.emit?.("hover-time", 5200);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    await flushUi();

    expect(song1.snapsCalls.length).toBeGreaterThanOrEqual(1);
    const snapRows = container.querySelectorAll(".tempo-snap-row");
    expect(snapRows.length).toBe(2);
    expect(snapRows[0]?.textContent).toContain("Kick transient");
    expect(snapRows[0]?.textContent).toContain("Attack");

    // Apply SnapCandidate 1 via keyboard `1`
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
    await flushUi();
    const snappedBeat = Array.from(song1.controller.getState().beats.values()).find(
      (b) => b.snapEventId === "evt_kick_01",
    );
    expect(snappedBeat).toBeDefined();
    if (!snappedBeat) throw new Error("Expected snappedBeat");
    expect(snappedBeat.timeSec).toBeCloseTo(5.208, 3);

    // Fine-Tune nudge +5 ms button and sample step `.`
    const plus5Btn = Array.from(
      container.querySelectorAll("#tempo-selection .segmented button"),
    ).find((b) => b.textContent?.trim() === "+5") as HTMLButtonElement | undefined;
    expect(plus5Btn).toBeDefined();
    plus5Btn?.click();
    await flushUi();
    expect(song1.controller.getState().beats.get(snappedBeat.id)?.timeSec).toBeCloseTo(5.213, 3);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "." }));
    await flushUi();
    expect(song1.controller.getState().beats.get(snappedBeat.id)?.timeSec).toBeGreaterThan(5.213);

    // Standalone Unbeat (`U`) at 6.5s (no nearby beat required!) + single-step Cmd+Z undo
    const beatsBeforeUnbeat = song1.controller.getState().beats.size;
    stageHook.emit?.("hover-time", 6500);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "u" }));
    await flushUi();
    expect(song1.controller.getState().unbeats.length).toBe(1);
    expect(song1.controller.getState().beats.size).toBe(beatsBeforeUnbeat);

    // Single-step Cmd+Z removes the standalone Unbeat cue
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true }));
    await flushUi();
    expect(song1.controller.getState().unbeats.length).toBe(0);

    // Unbeat (`U`) near draft beat at 3.0s captures draft beat AND records unbeat atomically, undone in 1 step!
    stageHook.emit?.("hover-time", 3005);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "u" }));
    await flushUi();
    expect(song1.controller.getState().unbeats.length).toBe(1);
    expect(song1.controller.getState().beats.has("b-s14-03")).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true }));
    await flushUi();
    expect(song1.controller.getState().unbeats.length).toBe(0);
    expect(song1.controller.getState().beats.has("b-s14-03")).toBe(true);

    // Place user Sound (`N`) at 7.1s
    stageHook.emit?.("hover-time", 7100);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    await flushUi();
    expect(
      Array.from(song1.controller.getState().sounds.values()).some(
        (s) => s.source === "user" && Math.abs(s.timeSec - 7.1) < 1e-3,
      ),
    ).toBe(true);
  });

  it("renders human-safe Offers on Cmd+K recompute, toggles hold-offers on Alt A/B, and supports Tab accept / Shift+Tab dismiss", async () => {
    await mountWorkspace();
    const song1 = requireSong("01-campanella-a1b2c3d4");

    // Trigger Cmd+K recompute
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    await flushUi();

    const suggestions = container.querySelector("#tempo-suggestions");
    expect(suggestions).not.toBeNull();
    const suggText = suggestions?.textContent ?? "";
    expect(suggText).toContain("Option 1 of 2");
    expect(suggText).toContain("Option 2 of 2");
    expect(suggText).toContain("Align triplet pickup");
    expect(suggText).toContain("Moves 1 beat (+18 ms) and adds 1 pickup beat");
    expect(suggText).toContain("Soft cue near 0:02.0 shifted by 6 ms to match kick attack");

    // Zero internal IDs leaked in Suggestions panel!
    expect(suggText).not.toContain("offer_internal");
    expect(suggText).not.toContain("batch_internal");
    expect(suggText).not.toContain("sk:");

    // Hold Alt -> calls hold-offers { hold: true } and previews candidate beat clicks
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));
    await flushUi();
    expect(song1.holdCalls).toContain(true);
    expect(engineSpy.clicks.at(-1)).toContain(2018);

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    await flushUi();
    expect(song1.holdCalls.at(-1)).toBe(false);

    // Dismiss Option 1 with Shift+Tab -> Option 2 remains
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }));
    await flushUi();
    expect(song1.controller.getState().offers.get("offer_internal_alpha_01")?.status).toBe(
      "rejected",
    );

    // Accept remaining Option 2 with Tab
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    await flushUi();
    expect(song1.controller.getState().offers.get("offer_internal_beta_02")?.status).toBe(
      "accepted",
    );
    expect(container.querySelector("#tempo-suggestions")).toBeNull();
  });

  it("never interrupts playback when toggling Edit and Audition on Mix", async () => {
    await mountWorkspace();

    // Start playback via Space
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    await flushUi();
    expect(engineSpy.plays).toBe(1);
    expect(engineSpy.stops).toBe(0);

    // Switch to Audition mode (default filter Mix) -> zero engine stops!
    const auditionBtn = Array.from(
      container.querySelectorAll(".frame-toolbar .segmented button"),
    ).find((b) => b.textContent?.trim() === "Audition") as HTMLButtonElement;
    auditionBtn.click();
    await flushUi();
    expect(engineSpy.stops).toBe(0);
    expect(engineSpy.plays).toBe(1);

    // Switch back to Edit mode -> zero engine stops!
    const editBtn = Array.from(container.querySelectorAll(".frame-toolbar .segmented button")).find(
      (b) => b.textContent?.trim() === "Edit",
    ) as HTMLButtonElement;
    editBtn.click();
    await flushUi();
    expect(engineSpy.stops).toBe(0);
  });

  it("enforces synchronous song-switch isolation: releases Alt hold on old song and blocks mid-load B/cues", async () => {
    const gate = { resolveSong2Open: null as (() => void) | null };
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === "string" ? input : input.toString();
        if (rawUrl.includes("/songs/02-hyper-vivacity-e5f60718/open")) {
          await new Promise<void>((resolve) => {
            gate.resolveSong2Open = resolve;
          });
        }
        return await baseFetch(input, init);
      }),
    );

    await mountWorkspace();
    const song1 = requireSong("01-campanella-a1b2c3d4");
    const song2 = requireSong("02-hyper-vivacity-e5f60718");

    // Hold Alt on Song 1 -> holdCalls receives `true`
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));
    await flushUi();
    expect(song1.holdCalls).toEqual([true]);

    const song1BeatsBefore = song1.controller.getState().beats.size;

    // Click Song 2 while Song 2 `/open` hangs in-flight!
    const songRows = container.querySelectorAll("#tempo-songs .tempo-list-row");
    (songRows[1] as HTMLButtonElement).click();
    await flushUi();

    // 1) Alt hold was synchronously released on Song 1 (`holdCalls` received `false`)!
    expect(song1.holdCalls).toEqual([true, false]);
    // 2) Audio buffer was synchronously unloaded!
    expect(engineSpy.unloads).toBeGreaterThanOrEqual(1);

    // 3) Pressing B while Song 2 is still loading (`loadedSongId === null`) MUST NOT mutate Song 1 or Song 2!
    stageHook.emit?.("hover-time", 5500);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    await flushUi();
    expect(song1.controller.getState().beats.size).toBe(song1BeatsBefore);
    expect(song2.controller.getState().beats.size).toBe(0);

    // Finish loading Song 2 -> now B works on Song 2!
    gate.resolveSong2Open?.();
    await flushUi();
    stageHook.emit?.("hover-time", 5500);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    await flushUi();
    expect(
      Array.from(song2.controller.getState().beats.values()).some(
        (b) => b.source === "user" && Math.abs(b.timeSec - 5.5) < 1e-4,
      ),
    ).toBe(true);
  });

  it("accumulates exact 100 source-sample nudges at 44.1 kHz under 48 kHz WebAudio, promotes coincident beats, and gates live-tap heardAt", async () => {
    engineSpy.forceContextSampleRate = 48_000;
    await mountWorkspace();
    const song1 = requireSong("01-campanella-a1b2c3d4");

    // 1) Coincident Beat guard: placing B at 1.0003s (within <= 0.5ms of draft beat b-s14-01 at 1.0s)
    // promotes b-s14-01 to `source: "user"` instead of creating a duplicate beat!
    const countBefore = song1.controller.getState().beats.size;
    stageHook.emit?.("hover-time", 1000.3);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    await flushUi();
    expect(song1.controller.getState().beats.size).toBe(countBefore);
    expect(song1.controller.getState().beats.get("b-s14-01")?.source).toBe("user");

    // 2) Select beat at 2.000000 s (`b-s14-02`) and fire 100 rapid `.` sample nudges synchronously!
    stageHook.emit?.("select", { kind: "beat", id: "b-s14-02" });
    await flushUi();
    const baseFrame = Math.round(2.0 * 44_100);
    for (let i = 0; i < 100; i += 1) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "." }));
    }
    await flushUi();

    const movedBeat = song1.controller.getState().beats.get("b-s14-02");
    expect(movedBeat).toBeDefined();
    expect(Math.round((movedBeat?.timeSec ?? 0) * 44_100) - baseFrame).toBe(100);
    expect(movedBeat?.timeSec).toBeCloseTo((baseFrame + 100) / 44_100, 12);

    // 3) Live-tap `heardAt()` guard: while playing, if `heardAt()` returns `undefined` (before audible output starts),
    // pressing `B` MUST ignore the tap instead of falling back to visual playhead!
    engineSpy.overrideHeardAt = () => undefined;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    await flushUi();
    expect(engineSpy.playing).toBe(true);
    const beatsBeforeTap = song1.controller.getState().beats.size;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    await flushUi();
    expect(song1.controller.getState().beats.size).toBe(beatsBeforeTap);
  });

  it("splices 0-sample-aligned Audition via swapBuffer without stopping playback, and disables Accept/Tab on Stale offers", async () => {
    const auditionRequests: Array<{ t0: string; t1: string; filter: string }> = [];
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === "string" ? input : input.toString();
        const url = new URL(rawUrl, "http://127.0.0.1");
        if (url.pathname.endsWith("/audition")) {
          const t0 = url.searchParams.get("t0") ?? "0";
          const t1 = url.searchParams.get("t1") ?? "0";
          const filter = url.searchParams.get("filter") ?? "mix";
          auditionRequests.push({ t0, t1, filter });

          // Build synthetic `AUD!` marker with 100 samples of amplitude `0.75` starting at exact sample 44100!
          const marker = new ArrayBuffer(12);
          const dv = new DataView(marker);
          dv.setUint32(0, 0x21445541, true);
          dv.setUint32(4, 100, true);
          dv.setFloat32(8, 0.75, true);
          return new Response(marker, {
            status: 200,
            headers: {
              "Content-Type": "audio/wav",
              "X-Audition-Start-Sample": "44100",
              "X-Audition-End-Sample": "44200",
              "X-Audition-Sample-Rate": "44100",
            },
          });
        }
        return await baseFetch(input, init);
      }),
    );

    await mountWorkspace();
    const song1 = requireSong("01-campanella-a1b2c3d4");

    // Undo and Redo buttons start disabled (`canUndo: false`, `canRedo: false`)!
    const undoBtn = container.querySelector('button[aria-label="Undo"]') as HTMLButtonElement;
    const redoBtn = container.querySelector('button[aria-label="Redo"]') as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(true);
    expect(redoBtn.disabled).toBe(true);

    // Start playback, switch to Audition -> Perc: swaps buffer seamlessly with ZERO stops and splices at exact sample 44100!
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    await flushUi();
    expect(engineSpy.stops).toBe(0);

    const auditionBtn = Array.from(
      container.querySelectorAll(".frame-toolbar .segmented button"),
    ).find((b) => b.textContent?.trim() === "Audition") as HTMLButtonElement;
    auditionBtn.click();
    await flushUi();

    const percBtn = Array.from(container.querySelectorAll(".stage-toolbar .segmented button")).find(
      (b) => b.textContent?.trim() === "Perc",
    ) as HTMLButtonElement;
    percBtn.click();
    await flushUi();

    expect(auditionRequests.length).toBe(1);
    expect(engineSpy.stops).toBe(0);
    expect(engineSpy.swaps).toBe(1);
    expect(engineSpy.lastBufferChannels?.[0]?.[44_099]).toBe(0);
    expect(engineSpy.lastBufferChannels?.[0]?.[44_100]).toBeCloseTo(0.75, 5);
    expect(engineSpy.lastBufferChannels?.[0]?.[44_199]).toBeCloseTo(0.75, 5);
    expect(engineSpy.lastBufferChannels?.[0]?.[44_200]).toBe(0);

    // Switch back to Edit, trigger Cmd+K recompute, then mutate beat `b-s14-02` so offers become `stale`!
    const editBtn = Array.from(container.querySelectorAll(".frame-toolbar .segmented button")).find(
      (b) => b.textContent?.trim() === "Edit",
    ) as HTMLButtonElement;
    editBtn.click();
    await flushUi();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    await flushUi();

    // Move `b-s14-02` directly so expectedRevisions mismatch -> offer becomes `stale`!
    stageHook.emit?.("select", { kind: "beat", id: "b-s14-02" });
    await flushUi();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await flushUi();

    const staleOffers = Array.from(song1.controller.getState().offers.values());
    expect(staleOffers.some((o) => o.status === "stale")).toBe(true);

    const acceptButtons = Array.from(
      container.querySelectorAll("#tempo-suggestions .tempo-offer-actions button"),
    ).filter((b) => b.textContent?.includes("Accept")) as HTMLButtonElement[];
    expect(acceptButtons.length).toBeGreaterThan(0);
    expect(acceptButtons.every((b) => b.disabled)).toBe(true);

    // Recompute button is rendered on stale offers, and pressing Tab does NOT accept a stale offer!
    const recomputeOnStale = Array.from(
      container.querySelectorAll("#tempo-suggestions .tempo-offer-actions button"),
    ).find((b) => b.textContent?.includes("Recompute"));
    expect(recomputeOnStale).toBeDefined();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    await flushUi();
    expect(
      Array.from(song1.controller.getState().offers.values()).every((o) => o.status !== "accepted"),
    ).toBe(true);
  });

  it("auto-refreshes filtered Audition window when seeking outside [startSec, endSec) on > 60s tracks", async () => {
    const requestedWindows: Array<{ t0: number; t1: number }> = [];
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === "string" ? input : input.toString();
        const url = new URL(rawUrl, "http://127.0.0.1");
        if (url.pathname.endsWith("/open")) {
          const song1 = requireSong("01-campanella-a1b2c3d4");
          await song1.controller.openSong({
            songId: "01-campanella-a1b2c3d4",
            durationSec: 180,
            sampleRate: 44_100,
            clock: "source-audio-sec",
          });
          return new Response(JSON.stringify(buildPayload(song1)), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname.endsWith("/audition")) {
          const t0 = Number(url.searchParams.get("t0") ?? "0");
          const t1 = Number(url.searchParams.get("t1") ?? "0");
          requestedWindows.push({ t0, t1 });
          return new Response(new ArrayBuffer(64), {
            status: 200,
            headers: {
              "Content-Type": "audio/wav",
              "X-Audition-Start-Sample": String(Math.round(t0 * 44_100)),
              "X-Audition-End-Sample": String(Math.round(t1 * 44_100)),
              "X-Audition-Sample-Rate": "44100",
            },
          });
        }
        return await baseFetch(input, init);
      }),
    );

    await mountWorkspace();

    const auditionBtn = Array.from(
      container.querySelectorAll(".frame-toolbar .segmented button"),
    ).find((b) => b.textContent?.trim() === "Audition") as HTMLButtonElement;
    auditionBtn.click();
    await flushUi();

    const lowBtn = Array.from(container.querySelectorAll(".stage-toolbar .segmented button")).find(
      (b) => b.textContent?.trim() === "Low",
    ) as HTMLButtonElement;
    lowBtn.click();
    await flushUi();

    // Initial window covers [0, 60)
    expect(requestedWindows).toEqual([{ t0: 0, t1: 60 }]);

    // Seek outside [0, 60) to 120.0 s (120_000 ms) -> automatically fetches & swaps a new 60s window covering 120s!
    stageHook.emit?.("seek", 120_000);
    await flushUi();
    expect(requestedWindows).toHaveLength(2);
    expect(requestedWindows[1]?.t0).toBeLessThanOrEqual(120);
    expect(requestedWindows[1]?.t1).toBeGreaterThan(120);
  });

  it("tags TempoStage spectrogram worker requests with requestId (ignoring out-of-order Song A replies) and re-crops past 10:00 on > 10 min songs", async () => {
    const RealTempoStage = (
      await vi.importActual<{ default: ReturnType<typeof defineComponent> }>("./TempoStage.vue")
    ).default;

    const postedMessages: Array<{
      requestId?: number;
      startMs: number;
      endMs: number;
      frameHop?: number;
    }> = [];
    const workerSpy = { onMessage: null as ((ev: MessageEvent) => void) | null };
    class MockSpecWorker {
      set onmessage(fn: ((ev: MessageEvent) => void) | null) {
        workerSpy.onMessage = fn;
      }
      get onmessage() {
        return workerSpy.onMessage;
      }
      postMessage(msg: { requestId?: number; startMs: number; endMs: number; frameHop?: number }) {
        postedMessages.push({
          ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
          startMs: msg.startMs,
          endMs: msg.endMs,
          ...(msg.frameHop !== undefined ? { frameHop: msg.frameHop } : {}),
        });
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", MockSpecWorker);

    const makeStubBuffer = (seconds: number, sr = 1000): AudioBuffer =>
      ({
        numberOfChannels: 1,
        sampleRate: sr,
        length: seconds * sr,
        duration: seconds,
        getChannelData: () => new Float32Array(seconds * sr),
      }) as unknown as AudioBuffer;

    const bufA = makeStubBuffer(720); // 12 minutes (720_000 ms)
    const bufB = makeStubBuffer(120); // 2 minutes (120_000 ms)

    const currentBuffer = { value: bufA };
    const currentBounds = { value: { startMs: 0, endMs: 720_000 } };
    const currentView = { value: { startMs: 0, msPerPx: 10 } };

    const stageHost = document.createElement("div");
    document.body.appendChild(stageHost);

    const { ref: vueRef } = await import("vue");
    const rBuf = vueRef<AudioBuffer>(currentBuffer.value);
    const rBounds = vueRef(currentBounds.value);
    const rView = vueRef(currentView.value);

    const stageApp = createApp({
      setup() {
        return () =>
          h(RealTempoStage, {
            buffer: rBuf.value,
            bounds: rBounds.value,
            view: rView.value,
            visualMode: "spec",
            segments: [],
            spans: [],
            beats: [],
            unbeats: [],
            sounds: [],
            gridFit: [],
            selection: { kind: "none" },
            activeRange: null,
            snapCandidates: [],
            offerPreview: null,
            abComparing: false,
            playheadMs: 0,
            loopRegion: { startMs: 0, endMs: 0 },
            looping: false,
          });
      },
    });

    try {
      stageApp.mount(stageHost);
      await flushUi();

      // Request #1: [0, 600_000] on 12-min track
      expect(postedMessages).toHaveLength(1);
      expect(postedMessages[0]).toEqual({ requestId: 1, startMs: 0, endMs: 600_000 });

      // Simulate worker completing Request #1
      workerSpy.onMessage?.({
        data: {
          requestId: 1,
          sampleRate: 1000,
          firstFrame: 0,
          frameCount: 10,
          bins: 513,
          db: new Float32Array(10 * 513),
        },
      } as MessageEvent);
      await flushUi();

      // Pan viewport past 10:00 to 650_000 ms (10:50) -> triggers Request #2 covering > 600_000 ms!
      rView.value = { startMs: 650_000, msPerPx: 10 };
      await flushUi();
      expect(postedMessages).toHaveLength(2);
      expect(postedMessages[1]?.requestId).toBe(2);
      expect(postedMessages[1]?.endMs).toBe(720_000);
      expect(postedMessages[1]?.startMs).toBe(120_000);

      // Switch to Song B BEFORE Request #2 replies -> posts fresh request for Song B
      rBuf.value = bufB;
      rBounds.value = { startMs: 0, endMs: 120_000 };
      rView.value = { startMs: 0, msPerPx: 10 };
      await flushUi();
      expect(postedMessages).toHaveLength(3);
      const songBReqId = postedMessages[2]?.requestId ?? 0;
      expect(songBReqId).toBeGreaterThan(2);
      expect(postedMessages[2]).toEqual({ requestId: songBReqId, startMs: 0, endMs: 120_000 });

      // Out-of-order stale reply for Request #2 (Song A) arrives -> ignored; Song B stays clean
      workerSpy.onMessage?.({
        data: {
          requestId: 2,
          sampleRate: 1000,
          firstFrame: 468,
          frameCount: 10,
          bins: 513,
          db: new Float32Array(10 * 513),
        },
      } as MessageEvent);
      await flushUi();

      // Deliver Song B's matching requestId cleanly
      workerSpy.onMessage?.({
        data: {
          requestId: songBReqId,
          sampleRate: 1000,
          firstFrame: 0,
          frameCount: 10,
          bins: 513,
          db: new Float32Array(10 * 513),
        },
      } as MessageEvent);
      await flushUi();
      expect(postedMessages).toHaveLength(3);

      // Switch back to 12-min Song A zoomed all the way out to [0, 720_000 ms) (`msPerPx = 900` on 800px width):
      // MUST cover the entire [0, 720_000 ms] visible span with adaptive frameHop (zero blank tail!)
      rBuf.value = bufA;
      rBounds.value = { startMs: 0, endMs: 720_000 };
      rView.value = { startMs: 0, msPerPx: 900 };
      await flushUi();
      const wideMsg = postedMessages.at(-1) as {
        requestId?: number;
        startMs: number;
        endMs: number;
        frameHop?: number;
      };
      expect(wideMsg.startMs).toBe(0);
      expect(wideMsg.endMs).toBe(720_000);
      expect(wideMsg.frameHop).toBe(512);
    } finally {
      stageApp.unmount();
      stageHost.remove();
    }
  });

  it("[Stage 7] enforces audio-settled mutation gate, optimistic double-B dedupe, song-scoped nudge keys, recomputing reset, stale lastSeq drop, sequential Alt hold chain, X-Tempo-Workspace-Dir, and paused-seek Audition window", async () => {
    // 1. Unit check on computeAuditionWindow when playheadSec lies outside activeRange [80, 90):
    expect(
      computeAuditionWindow({
        durationSec: 180,
        playheadSec: 5,
        activeRange: { t0: 80, t1: 90 },
        looping: false,
        loopStartSec: 80,
        loopEndSec: 90,
      }),
    ).toEqual({ t0: 0, t1: 60 });

    const seenWorkspaceHeaders: string[] = [];
    let releaseAudioSong2: (() => void) | null = null;
    let delaySong1Nudge: (() => void) | null = null;
    let releaseHoldTrue: (() => void) | null = null;
    let delayFirstPlaceBeat: (() => void) | null = null;

    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === "string" ? input : input.toString();
        const url = new URL(rawUrl, "http://127.0.0.1");
        const headersObj = (init?.headers ?? {}) as Record<string, string>;
        const wsHdr = headersObj["X-Tempo-Workspace-Dir"] ?? headersObj["x-tempo-workspace-dir"];
        if (wsHdr) {
          seenWorkspaceHeaders.push(`${init?.method ?? "GET"} ${url.pathname} -> ${wsHdr}`);
        }

        if (url.pathname === "/api/tempo/songs/02-hyper-vivacity-e5f60718/audio") {
          await new Promise<void>((r) => {
            releaseAudioSong2 = r;
          });
        }
        if (
          url.pathname === "/api/tempo/songs/01-campanella-a1b2c3d4/recompute" &&
          init?.method === "POST"
        ) {
          // Stall recompute until aborted on song switch
          await new Promise<void>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          });
        }
        if (
          url.pathname === "/api/tempo/songs/01-campanella-a1b2c3d4/hold-offers" &&
          typeof init?.body === "string" &&
          init.body.includes('"hold":true')
        ) {
          const song1 = requireSong("01-campanella-a1b2c3d4");
          // Capture stale snapshot BEFORE hold:true resolves so we can verify stale lastSeq drop & sequential hold:false!
          const staleSnapshot = buildPayload(song1);
          await new Promise<void>((r) => {
            releaseHoldTrue = r;
          });
          song1.holdCalls.push(true);
          song1.controller.setHoldOffers(true);
          return new Response(
            JSON.stringify({
              ...staleSnapshot,
              hold: true,
              flushed: false,
              offers: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (
          url.pathname === "/api/tempo/songs/01-campanella-a1b2c3d4/edit" &&
          typeof init?.body === "string"
        ) {
          if (init.body.includes('"upsert_beat"') && !delayFirstPlaceBeat) {
            await new Promise<void>((r) => {
              delayFirstPlaceBeat = r;
            });
          } else if (init.body.includes('"b-s14-01"') && !delaySong1Nudge) {
            await new Promise<void>((r) => {
              delaySong1Nudge = r;
            });
          }
        }
        return await baseFetch(input, init);
      }),
    );

    await mountWorkspace();
    const song1 = requireSong("01-campanella-a1b2c3d4");
    const song2 = requireSong("02-hyper-vivacity-e5f60718");

    // Verify X-Tempo-Workspace-Dir header was sent on openSong!
    expect(seenWorkspaceHeaders.some((h) => h.includes("%2Fmusic%2Fhard-songs"))).toBe(true);

    // 2. Rapid double-B press at 6.2500s and 6.2503s while first POST .../edit is still in flight:
    //    reuses the exact same optimistic beat ID instead of inserting two distinct beats!
    const initialBeatCount = song1.controller.getState().beats.size;
    stageHook.emit?.("hover-time", 6250.0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    stageHook.emit?.("hover-time", 6250.3);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    await nextTick();
    (delayFirstPlaceBeat as (() => void) | null)?.();
    await flushUi();
    expect(song1.controller.getState().beats.size).toBe(initialBeatCount + 1);

    // 3. Sequential Alt hold-offers chain + stale lastSeq response drop:
    //    Press Alt (stalled on hold:true), release Alt immediately, AND perform an edit advancing lastSeq!
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    stageHook.emit?.("hover-time", 7200.0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    await flushUi();
    // Before releaseHoldTrue, holdCalls must NOT have executed hold:false ahead of hold:true!
    expect(song1.holdCalls).toEqual([]);
    (releaseHoldTrue as (() => void) | null)?.();
    await flushUi();
    // Strict sequential order [true, false], AND stale hold:true payload did NOT clobber the newer beat at 7.2s!
    expect(song1.holdCalls).toEqual([true, false]);
    expect(
      ((stageHook.props.beats ?? []) as Array<{ timeSec: number }>).some(
        (b) => Math.abs(b.timeSec - 7.2) < 1e-4,
      ),
    ).toBe(true);

    // 4. Start in-flight recompute AND delayed nudge on Song 1's `b-s14-01`, then switch to Song 2!
    stageHook.emit?.("select", { kind: "beat", id: "b-s14-01" });
    await flushUi();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    await nextTick();

    const songRows = container.querySelectorAll("#tempo-songs .tempo-list-row");
    (songRows[1] as HTMLButtonElement).click();
    await flushUi();

    // Song 2 `/open` resolved, while `/audio` is still paused:
    //  a) `recomputing` was reset immediately (Recompute button wouldn't stay stuck once audio settles),
    //  b) While `/audio` is unsettled, pressing `B` MUST be gated (zero premature beats on Song 2)!
    stageHook.emit?.("hover-time", 4500);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    await flushUi();
    expect(
      Array.from(song2.controller.getState().beats.values()).some(
        (b) => Math.abs(b.timeSec - 4.5) < 1e-3,
      ),
    ).toBe(false);

    // Settle Song 2 audio AND release Song 1's delayed nudge drain while nudging Song 2's same ID `b-s14-01`!
    (releaseAudioSong2 as (() => void) | null)?.();
    await flushUi();

    const recomputeBtn = Array.from(container.querySelectorAll(".stage-toolbar button")).find((b) =>
      b.textContent?.includes("Recompute"),
    ) as HTMLButtonElement | undefined;
    expect(recomputeBtn?.disabled).toBe(false);

    stageHook.emit?.("select", { kind: "beat", id: "b-s14-01" });
    await flushUi();
    (delaySong1Nudge as (() => void) | null)?.();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await flushUi();
    expect(song2.controller.getState().beats.get("b-s14-01")?.timeSec).toBeCloseTo(1.001, 4);
  });

  it("[Stage 9 #5] centers paused-seek Audition window at [60, 120) for 90s on 180s song and isolates nudge queues by songEpoch across A -> B -> A switches", async () => {
    // 1. Unit checks for symmetric [60, 120) centering at 90s on a 180s song:
    expect(
      computeAuditionWindow({
        durationSec: 180,
        playheadSec: 90,
        activeRange: null,
        looping: false,
        loopStartSec: 0,
        loopEndSec: 0,
      }),
    ).toEqual({ t0: 60, t1: 120 });

    expect(
      computeAuditionWindow({
        durationSec: 180,
        playheadSec: 90,
        activeRange: { t0: 10, t1: 20 },
        looping: false,
        loopStartSec: 10,
        loopEndSec: 20,
      }),
    ).toEqual({ t0: 60, t1: 120 });

    const requestedAuditionWindows: Array<{ t0: number; t1: number }> = [];
    let releaseEpoch1Nudge: (() => void) | null = null;
    let stalledFirstSongANudge = false;

    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === "string" ? input : input.toString();
        const url = new URL(rawUrl, "http://127.0.0.1");

        if (url.pathname === "/api/tempo/songs/01-campanella-a1b2c3d4/open") {
          const song1 = requireSong("01-campanella-a1b2c3d4");
          if (!song1.controller.getState().audio) {
            await song1.controller.openSong({
              songId: "01-campanella-a1b2c3d4",
              durationSec: 180,
              sampleRate: 44_100,
              clock: "source-audio-sec",
            });
          }
          return new Response(JSON.stringify(buildPayload(song1)), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.pathname.endsWith("/audition")) {
          const t0 = Number(url.searchParams.get("t0") ?? "0");
          const t1 = Number(url.searchParams.get("t1") ?? "0");
          requestedAuditionWindows.push({ t0, t1 });
          return new Response(new ArrayBuffer(64), {
            status: 200,
            headers: {
              "Content-Type": "audio/wav",
              "X-Audition-Start-Sample": String(Math.round(t0 * 44_100)),
              "X-Audition-End-Sample": String(Math.round(t1 * 44_100)),
              "X-Audition-Sample-Rate": "44100",
            },
          });
        }

        if (
          url.pathname === "/api/tempo/songs/01-campanella-a1b2c3d4/edit" &&
          typeof init?.body === "string" &&
          init.body.includes('"b-s14-01"') &&
          !stalledFirstSongANudge
        ) {
          stalledFirstSongANudge = true;
          await new Promise<void>((r) => {
            releaseEpoch1Nudge = r;
          });
        }

        return await baseFetch(input, init);
      }),
    );

    await mountWorkspace();
    const song1 = requireSong("01-campanella-a1b2c3d4");

    // 2. Interactive paused seek to 90s (90_000 ms) in Audition mode -> fetches [60, 120)!
    const auditionBtn = Array.from(
      container.querySelectorAll(".frame-toolbar .segmented button"),
    ).find((b) => b.textContent?.trim() === "Audition") as HTMLButtonElement;
    auditionBtn.click();
    await flushUi();

    const lowBtn = Array.from(container.querySelectorAll(".stage-toolbar .segmented button")).find(
      (b) => b.textContent?.trim() === "Low",
    ) as HTMLButtonElement;
    lowBtn.click();
    await flushUi();
    expect(requestedAuditionWindows.at(-1)).toEqual({ t0: 0, t1: 60 });

    stageHook.emit?.("seek", 90_000);
    await flushUi();
    expect(requestedAuditionWindows.at(-1)).toEqual({ t0: 60, t1: 120 });

    // Switch back to Edit mode
    const editBtn = Array.from(container.querySelectorAll(".frame-toolbar .segmented button")).find(
      (b) => b.textContent?.trim() === "Edit",
    ) as HTMLButtonElement;
    editBtn.click();
    await flushUi();

    // 3. Nudge `b-s14-01` on Song A (epoch 1 -> stalled), switch A -> B -> A (epoch 3),
    //    then nudge `b-s14-01` (+5 ms via Shift+ArrowRight) on Song A BEFORE & AS epoch 1's drain finishes!
    stageHook.emit?.("select", { kind: "beat", id: "b-s14-01" });
    await flushUi();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await nextTick();
    expect(releaseEpoch1Nudge).not.toBeNull();

    const songRows = container.querySelectorAll("#tempo-songs .tempo-list-row");
    // Switch A -> B
    (songRows[1] as HTMLButtonElement).click();
    await flushUi();
    // Switch B -> A while epoch 1's drain is STILL awaiting `releaseEpoch1Nudge`!
    (songRows[0] as HTMLButtonElement).click();
    await flushUi();

    // Select `b-s14-01` in epoch 3 and queue two ArrowLeft (-1 ms - 1 ms -> 0.998 s) nudges
    // so the second sits in queuedEntityNudges while epoch 1's (+1 ms -> 1.001 s) drain wakes up!
    stageHook.emit?.("select", { kind: "beat", id: "b-s14-01" });
    await flushUi();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    // Release epoch 1's old stalled edit so epoch 1's drain wakes up and exits without touching epoch 3's queue!
    (releaseEpoch1Nudge as (() => void) | null)?.();
    await flushUi();
    await flushUi();

    expect(song1.controller.getState().beats.get("b-s14-01")?.timeSec).toBeCloseTo(0.998, 4);
  });

  it("runs Flam check (G) at 0.25x over +-750 ms (1,500 ms span, clamped at bounds) with clicks and restores prior state on second G", async () => {
    await mountWorkspace();

    // Set non-default prior state: rate = 0.75x, custom loop [2000, 6000] enabled, clicks OFF
    const rate075Btn = Array.from(
      container.querySelectorAll('.frame-toolbar [aria-label="Playback rate"] button'),
    ).find((b) => b.textContent?.trim() === "0.75×") as HTMLButtonElement;
    rate075Btn.click();
    await flushUi();

    stageHook.emit?.("range-select", { t0: 2, t1: 6 });
    await flushUi();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "l" }));
    await flushUi();

    const clicksBtn = Array.from(container.querySelectorAll(".frame-toolbar button")).find(
      (b) => b.textContent?.trim() === "Clicks",
    ) as HTMLButtonElement;
    expect(clicksBtn.getAttribute("aria-pressed")).toBe("false");

    // Select beat at 3.0 s (`b-s14-03`) and press G -> 0.25x, loop [2250, 3750] (1,500 ms span), clicks ON!
    stageHook.emit?.("select", { kind: "beat", id: "b-s14-03" });
    await flushUi();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
    await flushUi();

    expect(engineSpy.playing).toBe(true);
    expect(engineSpy.lastPlayOptions?.rate).toBe(0.25);
    expect(engineSpy.lastPlayOptions?.loop).toEqual({ startMs: 2250, endMs: 3750 });
    expect(
      (engineSpy.lastPlayOptions?.loop?.endMs ?? 0) -
        (engineSpy.lastPlayOptions?.loop?.startMs ?? 0),
    ).toBe(1500);
    expect(clicksBtn.getAttribute("aria-pressed")).toBe("true");
    expect(engineSpy.clicks.at(-1)).not.toBeNull();
    expect(container.querySelector(".frame-status")?.textContent).toContain("Rate 0.25×");

    // Press G again -> stops flam check and restores rate = 0.75x, looping = true, loopRegion = [2000, 6000], clicks = false!
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
    await flushUi();

    expect(engineSpy.playing).toBe(false);
    expect(rate075Btn.getAttribute("aria-pressed")).toBe("true");
    expect(clicksBtn.getAttribute("aria-pressed")).toBe("false");
    expect(stageHook.props.looping).toBe(true);
    expect(stageHook.props.loopRegion ?? stageHook.props["loop-region"]).toEqual({
      startMs: 2000,
      endMs: 6000,
    });

    // Also verify track-start and track-end boundary clamping (+-750 ms clamped to [0, 16000]):
    stageHook.emit?.("select", { kind: "none" });
    stageHook.emit?.("seek", 300);
    await flushUi();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
    await flushUi();
    expect(engineSpy.lastPlayOptions?.rate).toBe(0.25);
    expect(engineSpy.lastPlayOptions?.loop).toEqual({ startMs: 0, endMs: 1050 });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
    await flushUi();

    stageHook.emit?.("seek", 15_600);
    await flushUi();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
    await flushUi();
    expect(engineSpy.lastPlayOptions?.loop).toEqual({ startMs: 14_850, endMs: 16_000 });
  });

  it("defaults Audition Cache ON with localStorage persistence, aborts pre-warm when toggled OFF, and swaps cached Perc <-> Harm with zero Rendering flicker", async () => {
    const auditionRequests: Array<{
      filter: string;
      t0: number;
      t1: number;
      signal?: AbortSignal;
    }> = [];
    let pendingHarmResolve: (() => void) | null = null;
    let blockHarmOnce = false;

    const fillByFilter: Record<string, number> = {
      percussive: 0.75,
      harmonic: 0.42,
      low: 0.25,
      mid: 0.5,
      high: 0.15,
    };

    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === "string" ? input : input.toString();
        const url = new URL(rawUrl, "http://127.0.0.1");
        if (url.pathname.endsWith("/audition")) {
          const filter = url.searchParams.get("filter") ?? "mix";
          const t0 = Number(url.searchParams.get("t0") ?? "0");
          const t1 = Number(url.searchParams.get("t1") ?? "0");
          auditionRequests.push({
            filter,
            t0,
            t1,
            ...(init?.signal ? { signal: init.signal } : {}),
          });
          if (blockHarmOnce && filter === "harmonic") {
            blockHarmOnce = false;
            await new Promise<void>((resolve, reject) => {
              pendingHarmResolve = resolve;
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            });
          }
          const marker = new ArrayBuffer(12);
          const dv = new DataView(marker);
          dv.setUint32(0, 0x21445541, true);
          dv.setUint32(4, 200, true);
          dv.setFloat32(8, fillByFilter[filter] ?? 0.5, true);
          return new Response(marker, {
            status: 200,
            headers: {
              "Content-Type": "audio/wav",
              "X-Audition-Start-Sample": "1000",
              "X-Audition-End-Sample": "1200",
              "X-Audition-Sample-Rate": "44100",
            },
          });
        }
        return await baseFetch(input, init);
      }),
    );

    await mountWorkspace();

    const auditionBtn = Array.from(
      container.querySelectorAll(".frame-toolbar .segmented button"),
    ).find((b) => b.textContent?.trim() === "Audition") as HTMLButtonElement;
    blockHarmOnce = true;
    auditionBtn.click();
    await flushUi();

    const cacheBtn = Array.from(container.querySelectorAll(".stage-toolbar button")).find(
      (b) => b.textContent?.trim() === "Cache",
    ) as HTMLButtonElement | undefined;
    expect(cacheBtn).toBeDefined();
    expect(cacheBtn?.getAttribute("aria-pressed")).toBe("true");

    // Wait >15ms so background pre-warm starts `percussive` and stalls on `harmonic`
    await new Promise((r) => setTimeout(r, 35));
    await flushUi();
    expect(auditionRequests.some((r) => r.filter === "percussive")).toBe(true);
    const harmReq = auditionRequests.find((r) => r.filter === "harmonic");
    expect(harmReq).toBeDefined();
    expect(harmReq?.signal?.aborted).toBe(false);
    // Background pre-warm NEVER shows "Rendering filter…"
    expect(container.querySelector(".tempo-status")?.textContent?.trim()).not.toBe(
      "Rendering filter…",
    );

    // Toggle Cache OFF -> immediately aborts the in-flight background `harmonic` request and persists `false`!
    cacheBtn?.click();
    await flushUi();
    expect(cacheBtn?.getAttribute("aria-pressed")).toBe("false");
    expect(harmReq?.signal?.aborted).toBe(true);
    expect(
      JSON.parse(localStorage.getItem("lens-tempo-preferences") ?? "{}").cacheAuditionFilters,
    ).toBe(false);
    (pendingHarmResolve as (() => void) | null)?.();

    const countAfterDisable = auditionRequests.length;
    await new Promise((r) => setTimeout(r, 35));
    await flushUi();
    expect(auditionRequests.length).toBe(countAfterDisable);

    // Toggle Cache back ON -> warms all remaining non-mix filters for `[0, 16)`!
    cacheBtn?.click();
    await nextTick();
    expect(cacheBtn?.getAttribute("aria-pressed")).toBe("true");
    expect(
      JSON.parse(localStorage.getItem("lens-tempo-preferences") ?? "{}").cacheAuditionFilters,
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 45));
    await flushUi();

    const warmedFilters = new Set(auditionRequests.map((r) => r.filter));
    expect(warmedFilters).toEqual(new Set(["percussive", "harmonic", "low", "mid", "high"]));

    // Now switch Perc -> Harm -> Perc: ZERO new fetches, ZERO "Rendering filter…" status flicker, exact synchronous buffer splice!
    const statusEl = container.querySelector(".tempo-status");
    const observedStatusTexts: string[] = [];
    const statusObserver = new MutationObserver(() => {
      observedStatusTexts.push(statusEl?.textContent?.trim() ?? "");
    });
    if (statusEl) {
      statusObserver.observe(statusEl, { childList: true, characterData: true, subtree: true });
    }

    const countBeforeSwitches = auditionRequests.length;
    const swapsBefore = engineSpy.swaps;
    const percBtn = Array.from(container.querySelectorAll(".stage-toolbar .segmented button")).find(
      (b) => b.textContent?.trim() === "Perc",
    ) as HTMLButtonElement;
    const harmBtn = Array.from(container.querySelectorAll(".stage-toolbar .segmented button")).find(
      (b) => b.textContent?.trim() === "Harm",
    ) as HTMLButtonElement;

    percBtn.click();
    // Synchronous check BEFORE flushUi()!
    expect(engineSpy.swaps).toBe(swapsBefore + 1);
    expect(engineSpy.lastBufferChannels?.[0]?.[1000]).toBeCloseTo(0.75, 5);
    await nextTick();
    expect(container.querySelector(".tempo-status")?.textContent?.trim()).not.toBe(
      "Rendering filter…",
    );

    harmBtn.click();
    expect(engineSpy.swaps).toBe(swapsBefore + 2);
    expect(engineSpy.lastBufferChannels?.[0]?.[1000]).toBeCloseTo(0.42, 5);
    await nextTick();
    expect(container.querySelector(".tempo-status")?.textContent?.trim()).not.toBe(
      "Rendering filter…",
    );

    percBtn.click();
    expect(engineSpy.swaps).toBe(swapsBefore + 3);
    expect(engineSpy.lastBufferChannels?.[0]?.[1000]).toBeCloseTo(0.75, 5);
    await flushUi();
    statusObserver.disconnect();
    expect(observedStatusTexts).not.toContain("Rendering filter…");
    expect(auditionRequests.length).toBe(countBeforeSwitches);
  });

  it("reuses exact active 60s window across filter switches during playback and enforces <= 128 MiB / <= 12-slice LRU bounds on 3600s tracks", async () => {
    // 1. Direct unit checks for 15s grid quantization & AuditionSliceCache byte/count bounds:
    expect(
      computeAuditionWindow({
        durationSec: 3600,
        playheadSec: 100.0,
        activeRange: null,
        looping: false,
        loopStartSec: 0,
        loopEndSec: 0,
      }),
    ).toEqual({ t0: 75, t1: 135 });
    expect(
      computeAuditionWindow({
        durationSec: 3600,
        playheadSec: 102.5,
        activeRange: null,
        looping: false,
        loopStartSec: 0,
        loopEndSec: 0,
      }),
    ).toEqual({ t0: 75, t1: 135 });

    // Verify 128 MiB byte cap: 60s @ 48 kHz stereo = 23,040,000 bytes/slice -> 5 slices fit (115.2 MB), 6th evicts oldest!
    const byteCache = new AuditionSliceCache();
    expect(byteCache.maxBytes).toBe(MAX_AUDITION_SLICE_CACHE_BYTES);
    expect(byteCache.maxEntries).toBe(MAX_AUDITION_SLICE_CACHE_ENTRIES);
    const sliceBytes48kStereo = 60 * 48_000 * 2 * 4; // 23,040,000 bytes
    for (let i = 0; i < 6; i += 1) {
      if (i === 5) {
        // Touch key_0 via get() so key_1 becomes the LRU victim instead of key_0!
        expect(byteCache.get("key_0")).toBeDefined();
      }
      byteCache.set(`key_${i}`, {
        startFrame: i * 1000,
        channels: [],
        sampleRate: 48_000,
        byteLength: sliceBytes48kStereo,
      });
    }
    expect(byteCache.size).toBe(5);
    expect(byteCache.totalBytes).toBeLessThanOrEqual(MAX_AUDITION_SLICE_CACHE_BYTES);
    expect(byteCache.has("key_0")).toBe(true);
    expect(byteCache.has("key_1")).toBe(false);

    // 2. Full component test on a simulated 3,600 s (1-hour) song (at 1 kHz mock rate to keep test fast):
    engineSpy.forceContextSampleRate = 1000;
    engineSpy.overrideAudioFrames = 3_600_000;
    const requestedSlices: Array<{ filter: string; t0: number; t1: number }> = [];
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === "string" ? input : input.toString();
        const url = new URL(rawUrl, "http://127.0.0.1");
        if (url.pathname.endsWith("/open")) {
          const song1 = requireSong("01-campanella-a1b2c3d4");
          if (!song1.controller.getState().audio) {
            await song1.controller.openSong({
              songId: "01-campanella-a1b2c3d4",
              durationSec: 3600,
              sampleRate: 1000,
              clock: "source-audio-sec",
            });
          }
          return new Response(JSON.stringify(buildPayload(song1)), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname.endsWith("/audition")) {
          const filter = url.searchParams.get("filter") ?? "mix";
          const t0 = Number(url.searchParams.get("t0") ?? "0");
          const t1 = Number(url.searchParams.get("t1") ?? "0");
          requestedSlices.push({ filter, t0, t1 });
          const marker = new ArrayBuffer(12);
          const dv = new DataView(marker);
          dv.setUint32(0, 0x21445541, true);
          dv.setUint32(4, 60_000, true);
          dv.setFloat32(8, 0.33, true);
          return new Response(marker, {
            status: 200,
            headers: {
              "Content-Type": "audio/wav",
              "X-Audition-Start-Sample": String(Math.round(t0 * 1000)),
              "X-Audition-End-Sample": String(Math.round(t1 * 1000)),
              "X-Audition-Sample-Rate": "1000",
            },
          });
        }
        return await baseFetch(input, init);
      }),
    );

    await mountWorkspace();

    const auditionBtn = Array.from(
      container.querySelectorAll(".frame-toolbar .segmented button"),
    ).find((b) => b.textContent?.trim() === "Audition") as HTMLButtonElement;
    auditionBtn.click();
    await flushUi();

    // Seek to 90.0 s (establishes anchor window [60, 120)) and warm all 5 filters
    stageHook.emit?.("seek", 90_000);
    await flushUi();
    const harmBtn = Array.from(container.querySelectorAll(".stage-toolbar .segmented button")).find(
      (b) => b.textContent?.trim() === "Harm",
    ) as HTMLButtonElement;
    const percBtn = Array.from(container.querySelectorAll(".stage-toolbar .segmented button")).find(
      (b) => b.textContent?.trim() === "Perc",
    ) as HTMLButtonElement;
    harmBtn.click();
    await new Promise((r) => setTimeout(r, 45));
    await flushUi();
    expect(
      requestedSlices
        .filter((s) => s.t0 === 60 && s.t1 === 120)
        .map((s) => s.filter)
        .sort(),
    ).toEqual(["harmonic", "high", "low", "mid", "percussive"]);

    // Start playback and advance playhead from 90.0 s to 102.5 s (where unanchored computeAuditionWindow would compute [75, 135)!)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    await flushUi();
    engineSpy.positionMs = 102_500;

    const fetchesBeforeSwitch = requestedSlices.length;
    percBtn.click();
    await flushUi();
    // Reused exact [60, 120) anchor window -> ZERO new /audition fetches!
    expect(requestedSlices.length).toBe(fetchesBeforeSwitch);

    // Stop playback, turn Cache OFF, and visit 13 distinct 60s windows across the 3600s track to verify 12-slice eviction!
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    await flushUi();
    const cacheBtn = Array.from(container.querySelectorAll(".stage-toolbar button")).find(
      (b) => b.textContent?.trim() === "Cache",
    ) as HTMLButtonElement;
    cacheBtn.click();
    await flushUi();

    requestedSlices.length = 0;
    for (let idx = 0; idx < 13; idx += 1) {
      // Centers at 210, 300, 390, ... -> distinct non-overlapping [180, 240), [270, 330), ...
      stageHook.emit?.("seek", (210 + idx * 90) * 1000);
      await flushUi();
    }
    expect(requestedSlices.length).toBe(13);

    // Re-visiting idx=12 (most recent) and idx=1 (12th most recent) hits cache (0 fetches)!
    stageHook.emit?.("seek", (210 + 1 * 90) * 1000);
    await flushUi();
    expect(requestedSlices.length).toBe(13);

    // Re-visiting idx=0 (evicted as 13th entry) fetches fresh from server!
    stageHook.emit?.("seek", 210 * 1000);
    await flushUi();
    expect(requestedSlices.length).toBe(14);
  });
});
