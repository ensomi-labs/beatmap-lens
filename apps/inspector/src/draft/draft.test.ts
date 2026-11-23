import {
  computeGridFit as ensomiComputeGridFit,
  foldTrace as ensomiFoldTrace,
  parseTraceNdjson as ensomiParseTraceNdjson,
  projectRedLines as ensomiProjectRedLines,
  rankTroubleSpans as ensomiRankTroubleSpans,
  serializeTraceNdjson as ensomiSerializeTraceNdjson,
} from "ensomi";
import { describe, expect, it } from "vitest";
import { TraceAppendQueue, type TraceQueueSnapshot } from "./client";
import {
  type Beat,
  computeConsequences,
  computeGridFit,
  computeSemanticKey,
  createInitialState,
  DRAFT_GRID_FIT_OPTIONS,
  extractDraftMeta,
  flamLoopBounds,
  foldTrace,
  getRangeEntityIds,
  nearestGridSlot,
  type PatchOffer,
  parseTraceNdjson,
  projectRedLines,
  rankTroubleSpans,
  resolveActiveRetractions,
  type SoundAnchor,
  serializeTraceNdjson,
  signedGridResidualMs,
  sortedEntities,
  TRACE_SCHEMA_VERSION,
  type TraceEvent,
} from "./ensomi-contract";
import { ruleMockRecompute } from "./recompute";
import { DraftSession } from "./session";
import { beatsCollapse, overviewHeat, runBands, whiskerPx } from "./stage";
import { demoAudio, demoBeats, demoHits, demoProviders, demoSounds, encodeWav } from "./synthetic";

const beat = (id: string, t: number, extra: Partial<Beat> = {}): Beat => ({
  id,
  t,
  source: "model",
  version: 1,
  ...extra,
});
const sound = (id: string, t: number, emphasis = 1): SoundAnchor => ({
  id,
  t,
  emphasis,
  source: "rule",
  version: 1,
  experimental: true,
});
const grid = (count: number, step = 0.5, start = 0) =>
  Array.from({ length: count }, (_, k) => beat(`b${k}`, start + k * step));

function initEvents(beats: Beat[], sounds: SoundAnchor[] = []): TraceEvent[] {
  return [
    {
      schemaVersion: TRACE_SCHEMA_VERSION,
      seq: 0,
      id: "audio_bound_0",
      type: "audio_bound",
      tsMs: 1_700_000_000_000,
      author: { kind: "host" },
      payload: {
        audio: {
          audioId: "draft:x",
          durationSec: 30,
          sampleRate: 44100,
          clock: "source-audio-sec",
        },
        draftAudio: { path: null, title: "x", durationS: 30, sampleRate: 44100, channels: 1 },
        providers: { beats: { kind: "model", name: "m" }, sounds: { kind: "rule", name: "s" } },
      },
    },
    {
      schemaVersion: TRACE_SCHEMA_VERSION,
      seq: 1,
      id: "draft_loaded_1",
      type: "draft_loaded",
      tsMs: 1_700_000_000_001,
      author: { kind: "model", id: "m" },
      payload: { beats, sounds, boundaries: [], replace: true },
    },
  ];
}

describe("ensomi contract delegation", () => {
  it("delegates directly to the real ensomi v0 package", () => {
    expect(foldTrace).toBe(ensomiFoldTrace);
    expect(parseTraceNdjson).toBe(ensomiParseTraceNdjson);
    expect(serializeTraceNdjson).toBe(ensomiSerializeTraceNdjson);
    expect(computeGridFit).toBe(ensomiComputeGridFit);
    expect(projectRedLines).toBe(ensomiProjectRedLines);
    expect(rankTroubleSpans).toBe(ensomiRankTroubleSpans);
  });

  it("applies edits and statements without statements moving beats", () => {
    const events: TraceEvent[] = [
      ...initEvents(grid(4)),
      {
        schemaVersion: "0.1",
        seq: 2,
        id: "edit_2",
        type: "edit",
        tsMs: 1_700_000_000_002,
        author: { kind: "user" },
        payload: { op: "move_beat", id: "b1", t: 0.52, source: "user" },
      },
      {
        schemaVersion: "0.1",
        seq: 3,
        id: "statement_3",
        type: "statement",
        tsMs: 1_700_000_000_003,
        author: { kind: "user" },
        payload: {
          action: "upsert",
          statement: { id: "s1", kind: "steady", span: { t0: 0, t1: 2 } },
        },
      },
    ];
    const state = foldTrace(events);
    expect(sortedEntities(state.beats).map((entry) => entry.t)).toEqual([0, 0.52, 1, 1.5]);
    expect(state.beats.get("b1")).toMatchObject({ source: "user", version: 2 });
    expect([...state.statements.values()].filter((s) => s.active)).toHaveLength(1);
    expect(state.lastSeq).toBe(3);
  });

  it("retracts an event by targetEventId, and a retract of the retract restores it", () => {
    const events: TraceEvent[] = [
      ...initEvents(grid(3)),
      {
        schemaVersion: "0.1",
        seq: 2,
        id: "edit_2",
        type: "edit",
        author: { kind: "user" },
        payload: { op: "remove_beat", id: "b2" },
      },
      {
        schemaVersion: "0.1",
        seq: 3,
        id: "retract_3",
        type: "retract",
        author: { kind: "user" },
        payload: { targetEventId: "edit_2" },
      },
    ];
    expect(foldTrace(events).beats.size).toBe(3);
    const redone: TraceEvent[] = [
      ...events,
      {
        schemaVersion: "0.1",
        seq: 4,
        id: "retract_4",
        type: "retract",
        author: { kind: "user" },
        payload: { targetEventId: "retract_3" },
      },
    ];
    expect(foldTrace(redone).beats.size).toBe(2);
    const retracted = resolveActiveRetractions(redone);
    expect(retracted.has("retract_3")).toBe(true);
    expect(retracted.has("edit_2")).toBe(false);
  });

  it("accepting an offer applies it and supersedes siblings; rejecting suppresses its semanticKey", () => {
    const baseEvents = initEvents(grid(3));
    const baseState = foldTrace(baseEvents);
    const makeOffer = (id: string, t: number): PatchOffer => {
      const writeScope = { t0: 0, t1: 1 };
      const ops = {
        upsertBeats: [{ id: "b1", t, source: "rule" as const }],
        expectedVersions: { b1: 1 },
        expectedRangeEntityIds: getRangeEntityIds(baseState, writeScope),
      };
      return {
        id,
        batchId: "b1",
        role: "alternative",
        scopeKind: "local",
        providerId: "rule mock",
        providerKind: "rule",
        generation: 1,
        basisSeq: 1,
        readScope: writeScope,
        writeScope,
        ops,
        summary: id,
        consequences: computeConsequences(baseState, ops),
        conflicts: [],
        semanticKey: computeSemanticKey(writeScope, ops),
        status: "pending",
      };
    };

    const offerA = makeOffer("a", 0.55);
    const offerB = makeOffer("b", 0.45);
    const withBatch: TraceEvent[] = [
      ...baseEvents,
      {
        schemaVersion: "0.1",
        seq: 2,
        id: "offer_batch_2",
        type: "offer_batch",
        author: { kind: "rule", id: "rule mock" },
        payload: { batchId: "b1", offers: [offerA, offerB] },
      },
    ];

    const accepted = foldTrace([
      ...withBatch,
      {
        schemaVersion: "0.1",
        seq: 3,
        id: "offer_accept_3",
        type: "offer_accept",
        author: { kind: "user" },
        payload: { offerId: "b" },
      },
    ]);
    expect(accepted.beats.get("b1")).toMatchObject({ t: 0.45, source: "rule", version: 2 });
    expect([...accepted.offers.values()].filter((o) => o.status === "pending")).toEqual([]);
    expect(accepted.offers.get("a")?.status).toBe("superseded");

    const rejected = foldTrace([
      ...withBatch,
      {
        schemaVersion: "0.1",
        seq: 3,
        id: "offer_reject_3",
        type: "offer_reject",
        author: { kind: "user" },
        payload: { offerId: "a" },
      },
    ]);
    expect(
      [...rejected.offers.values()].filter((o) => o.status === "pending").map((o) => o.id),
    ).toEqual(["b"]);
    expect(rejected.suppressions.map((s) => s.semanticKey)).toEqual([offerA.semanticKey]);

    const again = foldTrace([
      ...withBatch,
      {
        schemaVersion: "0.1",
        seq: 3,
        id: "offer_reject_3",
        type: "offer_reject",
        author: { kind: "user" },
        payload: { offerId: "a" },
      },
      {
        schemaVersion: "0.1",
        seq: 4,
        id: "offer_batch_4",
        type: "offer_batch",
        author: { kind: "rule", id: "rule mock" },
        payload: { batchId: "b2", offers: [{ ...offerA, id: "a-retry", batchId: "b2" }] },
      },
    ]);
    expect(again.offers.has("a-retry")).toBe(false);
    expect(again.suppressedOffers.map((o) => o.id)).toEqual(["a-retry"]);
  });

  it("shifts a run's offset via deltaSec", () => {
    const state = foldTrace([
      ...initEvents(grid(4)),
      {
        schemaVersion: "0.1",
        seq: 2,
        id: "edit_2",
        type: "edit",
        author: { kind: "user" },
        payload: {
          op: "shift_run_offset",
          span: { t0: 0.9, t1: 2 },
          deltaSec: 0.02,
          source: "user",
        },
      },
    ]);
    expect(sortedEntities(state.beats).map((entry) => entry.t)).toEqual([0, 0.5, 1.02, 1.52]);
  });
});

describe("DraftSession", () => {
  it("writes schemaVersion 0.1 NDJSON that round-trips through ensomi parseTraceNdjson + foldTrace", () => {
    const persisted: string[] = [];
    let tick = 1_700_000_000_000;
    const session = new DraftSession(
      (event) => persisted.push(event.id),
      () => tick++,
    );
    session.initDraft(demoAudio(), { beats: grid(3), sounds: [sound("s0", 0.5)] }, demoProviders);
    session.applyEdit({ op: "remove_beat", id: "b0" });
    session.upsertStatement({ id: "s", kind: "keep", span: { t0: 0, t1: 1 } });
    session.undo();
    expect([...session.state.statements.values()].filter((s) => s.active)).toEqual([]);
    session.undo();
    expect(session.state.beats.size).toBe(3);
    expect(session.canRedo).toBe(true);
    session.redo();
    expect(session.state.beats.size).toBe(2);
    session.applyEdit({ op: "remove_beat", id: "b1" });
    expect(session.canRedo).toBe(false);
    expect(persisted).toEqual([
      "audio_bound_0",
      "draft_loaded_1",
      "edit_2",
      "statement_3",
      "retract_4",
      "retract_5",
      "retract_6",
      "edit_7",
    ]);
    expect(session.events[5]).toMatchObject({
      schemaVersion: "0.1",
      type: "retract",
      payload: { targetEventId: "edit_2" },
    });
    expect(session.events[6]).toMatchObject({
      schemaVersion: "0.1",
      type: "retract",
      payload: { targetEventId: "retract_5" },
    });

    // Round-trip serialized NDJSON directly through ensomi's parseTraceNdjson + foldTrace
    const ndjson = session.exportNdjson();
    const parsed = ensomiParseTraceNdjson(ndjson);
    expect(parsed).toHaveLength(8);
    expect(parsed.every((ev) => ev.schemaVersion === "0.1")).toBe(true);
    const refolded = ensomiFoldTrace(parsed);
    expect(sortedEntities(refolded.beats).map((entry) => entry.id)).toEqual(["b2"]);
    expect(extractDraftMeta(refolded).audio?.title).toBe(demoAudio().title);

    const reloaded = new DraftSession();
    reloaded.load(parsed);
    expect(sortedEntities(reloaded.state.beats).map((entry) => entry.id)).toEqual(["b2"]);
  });

  it("blocks offer acceptance on constraint_violation and version_mismatch conflicts", async () => {
    const session = new DraftSession();
    session.initDraft(demoAudio(), { beats: grid(8), sounds: [sound("a", 1.012)] }, demoProviders);
    session.upsertStatement({ id: "k1", kind: "keep", span: { t0: 0, t1: 2 } });
    const offers = await ruleMockRecompute({
      generation: 1,
      basisSeq: session.state.lastSeq,
      span: { t0: 0, t1: 4 },
      durationS: 10,
      beats: sortedEntities(session.state.beats),
      boundaries: [],
      sounds: sortedEntities(session.state.sounds),
      statements: [...session.state.statements.values()],
      suppressions: session.state.suppressions,
    });
    session.recordOfferBatch(offers);
    const quick = offers.find((o) => o.role === "quick_fix");
    expect(quick).toBeDefined();
    expect(quick?.conflicts.map((c) => c.kind)).toContain("constraint_violation");
    const blocked = session.acceptOffer(quick?.id ?? "");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.conflicts.map((c) => c.kind)).toContain("constraint_violation");
    }
    expect(session.state.beats.get("b2")?.t).toBe(1);
  });
});

describe("computeGridFit (ensomi with calibrated Draft defaults)", () => {
  it("classifies on_grid, subdivision and unexplained sounds with 12 ms tol and no 1/8", () => {
    const beats = grid(5);
    const fits = computeGridFit(
      [sound("a", 0.5), sound("b", 0.752), sound("c", 1 + 0.5 / 3), sound("d", 1.3), sound("e", 9)],
      beats,
      [],
      DRAFT_GRID_FIT_OPTIONS,
    );
    expect(fits.map((fit) => fit.status)).toEqual([
      "on_grid",
      "subdivision",
      "subdivision",
      "unexplained",
      "unexplained",
    ]);
    expect(fits[1]?.nearestDivisor).toBe(2);
    expect(fits[1]?.residualMs).toBeCloseTo(2, 4);
    expect(fits[2]?.nearestDivisor).toBe(3);
    expect(fits[3]?.nearestDivisor).toBeNull();
    expect(fits[4]?.nearestDivisor).toBeNull();
  });

  it("does not explain sounds across a gap_start boundary", () => {
    const fits = computeGridFit(
      [sound("a", 0.75)],
      grid(3),
      [{ id: "g", t: 0.6, kind: "gap_start", source: "user", version: 1 }],
      DRAFT_GRID_FIT_OPTIONS,
    );
    expect(fits[0]?.status).toBe("unexplained");
  });
});

describe("projectRedLines (ensomi)", () => {
  it("emits one red line per steady run, splits at boundaries, and marks barlines_not_inferred", () => {
    const beats = [...grid(8), ...grid(6, 0.4, 4.1).map((entry, k) => ({ ...entry, id: `c${k}` }))];
    const projection = projectRedLines(beats, [
      { id: "r", t: 4.1, kind: "reset", source: "user", version: 1 },
    ]);
    expect(projection.barPolicy).toBe("barlines_not_inferred");
    expect(projection.redLines).toHaveLength(2);
    expect(projection.redLines[0]).toMatchObject({ offsetMs: 0, beatLengthMs: 500, bpm: 120 });
    expect(projection.redLines[1]?.beatLengthMs).toBeCloseTo(400, 4);
    expect(projection.losses.join(" ")).toContain("barlines_not_inferred");
    expect(projection.osuTimingPoints).toContain("0,500,4,1,0,100,1,0");
  });

  it("gives a free run fallback lines and omits gaps", () => {
    const beats = [beat("a", 0), beat("b", 0.5), beat("c", 1.1), beat("d", 5), beat("e", 5.5)];
    const projection = projectRedLines(beats, [
      { id: "f", t: 0, kind: "free_start", source: "user", version: 1 },
      { id: "g", t: 1.5, kind: "gap_start", source: "user", version: 1 },
      { id: "h", t: 4.9, kind: "gap_end", source: "user", version: 1 },
      { id: "s", t: 4.95, kind: "steady_start", source: "user", version: 1 },
    ]);
    expect(projection.redLines.filter((r) => r.kind === "free_fallback")).toHaveLength(3);
    expect(projection.redLines.filter((r) => r.kind === "steady_run")).toHaveLength(1);
    expect(projection.losses.join(" ")).toContain("free_region_approximated");
    expect(projection.losses.join(" ")).toContain("gap_regions_unrepresented");
  });
});

describe("rankTroubleSpans (ensomi)", () => {
  it("ranks low confidence, interval jumps and unexplained sounds highest", () => {
    const beats = [
      ...grid(10),
      beat("x", 5.2, { conf: 0.1 }),
      ...grid(10, 0.5, 5.5).map((entry, k) => ({ ...entry, id: `y${k}`, conf: 0.9 })),
    ];
    const state = foldTrace(initEvents(beats, [sound("u", 12.13)]));
    const spans = rankTroubleSpans(state, { gridFitOptions: DRAFT_GRID_FIT_OPTIONS });
    expect(spans[0]?.span.t0).toBeLessThanOrEqual(5.2);
    expect(spans[0]?.span.t1).toBeGreaterThan(5.2);
    expect(spans[0]?.reasons.join()).toContain("low-confidence");
    expect(spans[0]?.reasons.join()).toContain("interval jump");
    expect(spans.some((entry) => entry.reasons.join().includes("unexplained sound"))).toBe(true);
  });
});

describe("RuleMockRecompute", () => {
  const request = (overrides = {}) => ({
    generation: 1,
    basisSeq: 1,
    span: { t0: 0, t1: 10 },
    durationS: 20,
    beats: grid(12),
    boundaries: [],
    sounds: [],
    statements: [],
    suppressions: [],
    ...overrides,
  });

  it("refits a steady statement linearly, badged as a rule, with constraint_violation on keep", async () => {
    const beats = grid(8).map((entry, k) =>
      k === 3 ? { ...entry, t: entry.t + 0.02, source: "user" as const } : entry,
    );
    const offers = await ruleMockRecompute(
      request({
        span: { t0: 0, t1: 4 },
        beats,
        statements: [
          {
            id: "s",
            version: 1,
            active: true,
            createdAtSeq: 2,
            kind: "steady",
            span: { t0: 0, t1: 4 },
          },
          {
            id: "k",
            version: 1,
            active: true,
            createdAtSeq: 3,
            kind: "keep",
            span: { t0: 1, t1: 2 },
          },
        ],
      }),
    );
    const rewrite = offers.find((offer) => offer.role === "rewrite");
    expect(rewrite).toMatchObject({ providerKind: "rule", scopeKind: "local", status: "pending" });
    expect(rewrite?.conflicts.map((conflict) => conflict.kind)).toContain("constraint_violation");
    expect(rewrite?.consequences.beatsMoved).toBeGreaterThan(0);
    expect(rewrite?.ops.expectedVersions).toBeDefined();
    expect(rewrite?.ops.expectedRangeEntityIds).toBeDefined();
  });

  it("extends a steady run forward and offers exclusive alternatives with sibling_conflict", async () => {
    const offers = await ruleMockRecompute(
      request({
        span: { t0: 0, t1: 6 },
        beats: grid(8),
        sounds: [sound("a", 2.19), sound("b", 2.69)],
      }),
    );
    const extend = offers.find((offer) => offer.role === "extend");
    expect(extend?.scopeKind).toBe("forward_continuation");
    expect(extend?.consequences.beatsAdded).toBeGreaterThan(10);
    const alternatives = offers.filter((offer) => offer.role === "alternative");
    expect(alternatives).toHaveLength(2);
    expect(new Set(alternatives.map((offer) => offer.batchId)).size).toBe(1);
    expect(
      alternatives[0]?.conflicts.some(
        (c) => c.kind === "sibling_conflict" && c.entityIds?.includes(alternatives[1]?.id ?? ""),
      ),
    ).toBe(true);
  });

  it("snaps beats onto strong nearby sounds and honours semanticKey suppressions", async () => {
    const offers = await ruleMockRecompute(request({ sounds: [sound("a", 1.012)] }));
    const fix = offers.find((offer) => offer.role === "quick_fix");
    expect(fix?.ops.upsertBeats).toEqual([
      expect.objectContaining({ id: "b2", t: 1.012, source: "rule" }),
    ]);
    const suppressed = await ruleMockRecompute(
      request({
        sounds: [sound("a", 1.012)],
        suppressions: [
          {
            semanticKey: fix?.semanticKey ?? "",
            writeScope: fix?.writeScope ?? { t0: 0, t1: 10 },
            rejectedAtSeq: 2,
            offerId: fix?.id ?? "o",
          },
        ],
      }),
    );
    expect(suppressed.some((offer) => offer.role === "quick_fix")).toBe(false);
  });

  it("stops cooperatively when cancelled", async () => {
    const controller = new AbortController();
    const running = ruleMockRecompute(request(), controller.signal);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("namespaces durable IDs across reloads so newly generated beats and offers never collide", async () => {
    const first = await ruleMockRecompute(
      request({
        generation: 1,
        basisSeq: 1,
        span: { t0: 0, t1: 4 },
        durationS: 8,
        beats: grid(6),
      }),
    );
    const firstExtend = first.find((o) => o.role === "extend");
    expect(firstExtend).toBeDefined();
    const acceptedBeats = [
      ...grid(6),
      ...(firstExtend?.ops.upsertBeats ?? []).map((b) => ({
        ...b,
        version: b.version ?? 1,
      })),
    ];
    // Simulate a page reload where generation restarts at 1 with higher basisSeq and existing beats/offers.
    const second = await ruleMockRecompute(
      request({
        generation: 1,
        basisSeq: 4,
        span: { t0: 4, t1: 8 },
        durationS: 12,
        beats: acceptedBeats,
        existingOfferIds: first.map((o) => o.id),
      }),
    );
    const secondExtend = second.find((o) => o.role === "extend");
    expect(secondExtend).toBeDefined();
    const existingBeatIds = new Set(acceptedBeats.map((b) => b.id));
    for (const beat of secondExtend?.ops.upsertBeats ?? []) {
      expect(existingBeatIds.has(beat.id)).toBe(false);
    }
    const firstOfferIds = new Set(first.map((o) => o.id));
    for (const offer of second) {
      expect(firstOfferIds.has(offer.id)).toBe(false);
    }
  });

  it("gives independent proposals distinct batchIds while keeping alternative siblings shared", async () => {
    // Beat b2 at 1.0 has a strong sound 12 ms away -> quick_fix; steady run ends at 3.5 -> extend.
    const session = new DraftSession();
    session.initDraft(
      demoAudio(),
      { beats: grid(8), sounds: [sound("s_snap", 1.012, 1.0)] },
      demoProviders,
    );
    const offers = await ruleMockRecompute({
      generation: 1,
      basisSeq: session.state.lastSeq,
      span: { t0: 0, t1: 6 },
      durationS: 10,
      beats: sortedEntities(session.state.beats),
      boundaries: [],
      sounds: sortedEntities(session.state.sounds),
      statements: [],
      suppressions: [],
    });
    const fix = offers.find((o) => o.role === "quick_fix");
    const ext = offers.find((o) => o.role === "extend");
    expect(fix).toBeDefined();
    expect(ext).toBeDefined();
    expect(fix?.batchId).not.toBe(ext?.batchId);

    session.recordOfferBatch(offers);
    const acceptFix = session.acceptOffer(fix?.id ?? "");
    expect(acceptFix.ok).toBe(true);
    // Disjoint extend offer must remain pending, NOT superseded by quick_fix!
    expect(session.state.offers.get(ext?.id ?? "")?.status).toBe("pending");
    const acceptExt = session.acceptOffer(ext?.id ?? "");
    expect(acceptExt.ok).toBe(true);
  });

  it("bounds local phase reset to the earliest boundary or selection end", async () => {
    // Selection [0, 6] has an interior boundary at 3.2; phase reset at 2.19 must stop at 3.2.
    const withInterior = await ruleMockRecompute(
      request({
        span: { t0: 0, t1: 6 },
        durationS: 12,
        beats: grid(16),
        boundaries: [
          { id: "b_in", t: 3.2, kind: "reset", source: "user", version: 1 },
          { id: "b_far", t: 10, kind: "reset", source: "user", version: 1 },
        ],
        sounds: [sound("a", 2.19), sound("b", 2.69)],
      }),
    );
    const resetInterior = withInterior.find((o) => o.role === "alternative" && o.optionIndex === 0);
    expect(resetInterior).toBeDefined();
    expect(resetInterior?.writeScope.t1).toBeLessThanOrEqual(3.2);
    for (const upserted of resetInterior?.ops.upsertBeats ?? []) {
      expect(upserted.t).toBeLessThan(3.2);
    }

    // Selection [0, 4] with only a distant boundary at 10 must stop at selection end (4).
    const withDistant = await ruleMockRecompute(
      request({
        span: { t0: 0, t1: 4 },
        durationS: 12,
        beats: grid(16),
        boundaries: [{ id: "b_far", t: 10, kind: "reset", source: "user", version: 1 }],
        sounds: [sound("a", 2.19), sound("b", 2.69)],
      }),
    );
    const resetDistant = withDistant.find((o) => o.role === "alternative" && o.optionIndex === 0);
    expect(resetDistant).toBeDefined();
    expect(resetDistant?.writeScope.t1).toBeLessThanOrEqual(4);
    for (const upserted of resetDistant?.ops.upsertBeats ?? []) {
      expect(upserted.t).toBeLessThan(4);
    }
  });
});

describe("flam loop bounds and signed residual", () => {
  it("computes exact signed residual (negative early, positive late) and handles 0 beats", () => {
    expect(nearestGridSlot(1.0, [])).toBeNull();
    expect(signedGridResidualMs(1.0, [])).toBe(0);
    // Beat grid at 0.5 s -> quarter-beat slots every 0.125 s (0.5, 0.625, 0.75, 0.875, 1.0)
    const early = nearestGridSlot(0.985, [0.5, 1.0, 1.5]);
    expect(early?.slotTime).toBeCloseTo(1.0, 6);
    expect(early?.residualMs).toBeCloseTo(-15, 4);
    const late = nearestGridSlot(1.015, [0.5, 1.0, 1.5]);
    expect(late?.slotTime).toBeCloseTo(1.0, 6);
    expect(late?.residualMs).toBeCloseTo(15, 4);
    // Sound at 4 s, nearest beat at 2 s -> residual is +2000 ms, flam loop contains BOTH 2 s and 4 s
    const far = nearestGridSlot(4.0, [1.5, 2.0]);
    expect(far?.slotTime).toBe(2.0);
    expect(far?.residualMs).toBeCloseTo(2000, 4);
    const bounds = flamLoopBounds(4.0, 2.0, 10.0, 0.4);
    expect(bounds.t0).toBeCloseTo(1.6, 6);
    expect(bounds.t1).toBeCloseTo(4.4, 6);
    expect(flamLoopBounds(0.1, 0.2, 0.35, 0.4)).toEqual({ t0: 0, t1: 0.35 });
  });
});

describe("TraceAppendQueue", () => {
  it("keeps a failed prefix queued and retries it in order before reporting saved", async () => {
    const sent: number[][] = [];
    const statuses: TraceQueueSnapshot[] = [];
    let failNext = false;
    const queue = new TraceAppendQueue(
      async (_path, events) => {
        sent.push(events.map((ev) => ev.seq));
        if (failNext) {
          failNext = false;
          throw new Error("disk full");
        }
      },
      (snap) => statuses.push(snap),
    );
    const ev = (seq: number): TraceEvent => ({
      schemaVersion: "0.1",
      seq,
      id: `edit_${seq}`,
      type: "edit",
      author: { kind: "user" },
      payload: { op: "remove_beat", id: `b${seq}` },
    });

    queue.attach("/tmp/t.jsonl", [ev(0), ev(1)]);
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.snapshot()).toMatchObject({ status: "saved", pendingCount: 0 });

    failNext = true;
    queue.enqueue([ev(2)]);
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.snapshot()).toMatchObject({
      status: "error",
      pendingCount: 1,
      lastError: "disk full",
    });

    // Next edit retries the missing prefix [2, 3] together in order!
    queue.enqueue([ev(3)]);
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([[0, 1], [2], [2, 3]]);
    expect(queue.snapshot()).toMatchObject({ status: "saved", pendingCount: 0 });
  });
});

describe("stage helpers", () => {
  it("bands runs as steady with a BPM, free, or gap, including trailing gaps after the final beat", () => {
    const beats = [...grid(5), beat("f1", 2.4), beat("f2", 3.1), beat("f3", 3.4)];
    const bands = runBands(beats, [
      { id: "f", t: 2.4, kind: "free_start", source: "user", version: 1 },
      { id: "g", t: 3.2, kind: "gap_start", source: "user", version: 1 },
      { id: "h", t: 3.3, kind: "gap_end", source: "user", version: 1 },
    ]);
    expect(bands.map((band) => band.kind)).toEqual(["steady", "free", "gap"]);
    expect(bands[0]?.bpm).toBeCloseTo(120, 6);

    // Gap whose closing boundary is AFTER the final beat
    const trailingClosed = runBands(grid(4), [
      { id: "g1", t: 2.0, kind: "gap_start", source: "user", version: 1 },
      { id: "g2", t: 3.5, kind: "gap_end", source: "user", version: 1 },
    ]);
    expect(trailingClosed).toContainEqual({ t0: 2.0, t1: 3.5, kind: "gap" });

    // Unclosed gap after the final beat extends to durationS
    const trailingOpen = runBands(
      grid(4),
      [{ id: "g1", t: 2.0, kind: "gap_start", source: "user", version: 1 }],
      6.0,
    );
    expect(trailingOpen).toContainEqual({ t0: 2.0, t1: 6.0, kind: "gap" });
  });

  it("collapses dense beats, scales whiskers by ms and normalizes overview heat", () => {
    expect(beatsCollapse(grid(100, 0.5), { startS: 0, endS: 50 }, 400)).toBe(true);
    expect(beatsCollapse(grid(100, 0.5), { startS: 0, endS: 5 }, 400)).toBe(false);
    expect(whiskerPx(-12)).toBe(-12);
    expect(whiskerPx(500)).toBe(48);
    const heat = overviewHeat(
      computeGridFit([sound("a", 1.3)], grid(5), [], DRAFT_GRID_FIT_OPTIONS),
      grid(5),
      2,
      4,
    );
    expect(heat[2]?.unexplained).toBe(1);
  });
});

describe("synthetic demo", () => {
  it("has a known answer the mock draft gets wrong after 14 s", () => {
    const fits = computeGridFit(demoSounds(), demoBeats(), [], DRAFT_GRID_FIT_OPTIONS);
    const unexplained = fits.filter((fit) => fit.status === "unexplained");
    expect(unexplained.length).toBeGreaterThan(5);
    expect(unexplained.every((fit) => fit.t > 14)).toBe(true);
    expect(fits.some((fit) => fit.status === "subdivision" && fit.nearestDivisor === 3)).toBe(true);
    expect(demoHits().length).toBe(demoSounds().length);
  });

  it("encodes 16-bit WAV", () => {
    const bytes = encodeWav([new Float32Array([0, 1, -1])], 8000);
    const view = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(createInitialState().beats.size).toBe(0);
  });
});
