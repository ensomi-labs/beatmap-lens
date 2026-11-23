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
import TempoWorkspace from "./TempoWorkspace.vue";

const engineSpy = vi.hoisted(() => ({
  plays: 0,
  stops: 0,
  loads: 0,
  clicks: [] as (number[] | null)[],
  clickVolumes: [] as number[],
  playing: false,
  positionMs: 0,
}));

vi.mock("../stage-audio", async () => {
  const actual = await vi.importActual<typeof import("../stage-audio")>("../stage-audio");
  return {
    ...actual,
    StageAudioEngine: class {
      readonly sampleRate: number;
      readonly context: { decodeAudioData: (buf: ArrayBuffer) => Promise<AudioBuffer> };
      playing = false;
      starting = false;
      onEnded: ((posMs: number) => void) | undefined;

      constructor(sampleRate: number) {
        this.sampleRate = sampleRate;
        this.context = {
          decodeAudioData: async () =>
            ({
              numberOfChannels: 1,
              sampleRate: this.sampleRate,
              length: this.sampleRate * 16,
              duration: 16,
              getChannelData: () => new Float32Array(this.sampleRate * 16),
            }) as unknown as AudioBuffer,
        };
      }

      load(channels: Float32Array[], frames: number): AudioBuffer {
        engineSpy.loads += 1;
        return {
          numberOfChannels: channels.length,
          sampleRate: this.sampleRate,
          length: frames,
          duration: frames / this.sampleRate,
          getChannelData: (c: number) => channels[c] ?? new Float32Array(frames),
        } as unknown as AudioBuffer;
      }

      async play(opts: { fromMs: number }) {
        engineSpy.plays += 1;
        engineSpy.playing = true;
        engineSpy.positionMs = opts.fromMs;
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
  const redLineProjection = projectRedLines(st.beats, st.segments);
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
  };
}

async function flushUi() {
  for (let i = 0; i < 6; i += 1) {
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
      clicks: [],
      clickVolumes: [],
      playing: false,
      positionMs: 0,
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
              const st = rec.controller.getState();
              const target = [...st.events]
                .reverse()
                .find(
                  (ev) =>
                    !st.retractedEventIds.has(ev.id) &&
                    (ev.type === "edit" ||
                      ev.type === "offer_accept" ||
                      ev.type === "offer_reject"),
                );
              if (target) {
                const res = rec.controller.retract(target.id);
                rec.redoStack.push(res.event.id);
              }
            } else if (body.action === "redo") {
              const rId = rec.redoStack.pop();
              if (rId) rec.controller.retract(rId, "Redo");
            } else {
              const ops = (body.ops ?? body.op) as EditOp | EditOp[];
              rec.controller.applyEdit(ops);
              rec.redoStack.length = 0;
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
});
