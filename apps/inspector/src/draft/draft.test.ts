import { describe, expect, it } from "vitest";
import {
  activeEvents,
  type Beat,
  computeGridFit,
  emptyState,
  fold,
  type PatchOffer,
  projectRedLines,
  rankTroubleSpans,
  type SoundAnchor,
  summarizeConsequences,
  type TraceEvent,
} from "./ensomi-contract";
import { ruleMockRecompute } from "./recompute";
import { DraftSession } from "./session";
import { beatsCollapse, overviewHeat, runBands, whiskerPx } from "./stage";
import { demoBeats, demoHits, demoSounds, encodeWav } from "./synthetic";

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

function init(beats: Beat[], sounds: SoundAnchor[] = []): TraceEvent {
  return {
    seq: 1,
    at: "t",
    type: "init",
    audio: { path: null, title: "x", durationS: 30, sampleRate: 44100, channels: 1 },
    beats,
    sounds,
    boundaries: [],
    providers: { beats: { kind: "model", name: "m" }, sounds: { kind: "rule", name: "s" } },
  };
}

describe("fold", () => {
  it("applies edits and statements without statements moving beats", () => {
    const events: TraceEvent[] = [
      init(grid(4)),
      { seq: 2, at: "t", type: "edit", edit: { op: "move_beat", id: "b1", t: 0.52 } },
      {
        seq: 3,
        at: "t",
        type: "statement",
        statement: { id: "s1", version: 1, kind: "steady", span: { t0: 0, t1: 2 } },
      },
    ];
    const state = fold(events);
    expect(state.beats.map((entry) => entry.t)).toEqual([0, 0.52, 1, 1.5]);
    expect(state.beats[1]).toMatchObject({ source: "user", version: 2 });
    expect(state.statements).toHaveLength(1);
    expect(state.lastSeq).toBe(3);
  });

  it("retracts an event, and a retract of the retract restores it", () => {
    const events: TraceEvent[] = [
      init(grid(3)),
      { seq: 2, at: "t", type: "edit", edit: { op: "remove_beat", id: "b2" } },
      { seq: 3, at: "t", type: "retract", target: 2 },
    ];
    expect(fold(events).beats).toHaveLength(3);
    const redone = [...events, { seq: 4, at: "t", type: "retract", target: 3 } as TraceEvent];
    expect(fold(redone).beats).toHaveLength(2);
    expect(activeEvents(redone).map((event) => event.seq)).toEqual([1, 2, 4]);
  });

  it("accepting an offer applies it and supersedes its siblings; rejecting suppresses its key", () => {
    const offer = (id: string, t: number): PatchOffer => ({
      id,
      batchId: "b1",
      role: "alternative",
      scopeKind: "local",
      providerKind: "rule",
      provider: "rule mock",
      semanticKey: `k-${id}`,
      label: id,
      span: { t0: 0, t1: 1 },
      edits: [{ op: "move_beat", id: "b1", t, source: "rule" }],
      conflicts: [],
      consequences: summarizeConsequences(grid(3), []),
    });
    const base: TraceEvent[] = [
      init(grid(3)),
      { seq: 2, at: "t", type: "offers", offers: [offer("a", 0.55), offer("b", 0.45)] },
    ];
    const accepted = fold([...base, { seq: 3, at: "t", type: "accept_offer", offerId: "b" }]);
    expect(accepted.beats[1]).toMatchObject({ t: 0.45, source: "rule" });
    expect(accepted.offers).toEqual([]);
    const rejected = fold([...base, { seq: 3, at: "t", type: "reject_offer", offerId: "a" }]);
    expect(rejected.offers.map((entry) => entry.id)).toEqual(["b"]);
    expect(rejected.suppressed).toEqual(["k-a"]);
    const again = fold([
      ...base,
      { seq: 3, at: "t", type: "reject_offer", offerId: "a" },
      { seq: 4, at: "t", type: "offers", offers: [offer("a", 0.55)] },
    ]);
    expect(again.offers).toEqual([]);
  });

  it("shifts a run's offset", () => {
    const state = fold([
      init(grid(4)),
      {
        seq: 2,
        at: "t",
        type: "edit",
        edit: { op: "shift_run_offset", span: { t0: 0.9, t1: 2 }, dt: 0.02 },
      },
    ]);
    expect(state.beats.map((entry) => entry.t)).toEqual([0, 0.5, 1.02, 1.52]);
  });
});

describe("DraftSession", () => {
  it("undoes and redoes with retract events, persisting each in order", () => {
    const persisted: number[] = [];
    const session = new DraftSession(
      (event) => persisted.push(event.seq),
      () => "now",
    );
    const { seq: _, at: __, ...body } = init(grid(3));
    session.commit(body);
    session.commit({ type: "edit", edit: { op: "remove_beat", id: "b0" } });
    session.commit({
      type: "statement",
      statement: { id: "s", version: 1, kind: "keep", span: { t0: 0, t1: 1 } },
    });
    session.undo();
    expect(session.state.statements).toEqual([]);
    session.undo();
    expect(session.state.beats).toHaveLength(3);
    expect(session.canRedo).toBe(true);
    session.redo();
    expect(session.state.beats).toHaveLength(2);
    session.commit({ type: "edit", edit: { op: "remove_beat", id: "b1" } });
    expect(session.canRedo).toBe(false);
    expect(persisted).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(session.events.at(4)).toMatchObject({ type: "retract", target: 2 });
    expect(session.events.at(5)).toMatchObject({ type: "retract", target: 5 });
    const reloaded = new DraftSession();
    reloaded.load(session.events);
    expect(reloaded.state.beats.map((entry) => entry.id)).toEqual(["b2"]);
  });
});

describe("computeGridFit", () => {
  it("classifies on-grid, subdivision and unexplained sounds with signed residuals", () => {
    const beats = grid(5);
    const fits = computeGridFit(
      [sound("a", 0.5), sound("b", 0.752), sound("c", 1 + 0.5 / 3), sound("d", 1.3), sound("e", 9)],
      beats,
      [],
    );
    expect(fits.map((fit) => fit.status)).toEqual([
      "on_grid",
      "on_grid",
      "subdivision",
      "unexplained",
      "unexplained",
    ]);
    expect(fits[1]?.divisor).toBe(2);
    expect(fits[1]?.residualMs).toBeCloseTo(2, 6);
    expect(fits[2]?.divisor).toBe(3);
    // Unexplained: residual from the nearest quarter slot, 1.25 s.
    expect(fits[3]?.residualMs).toBeCloseTo(50, 6);
    expect(fits[4]?.residualMs).toBeCloseTo(7000, 6);
  });

  it("does not explain sounds across a reset or a gap", () => {
    const fits = computeGridFit([sound("a", 0.75)], grid(3), [
      { id: "r", t: 0.6, kind: "reset", source: "user", version: 1 },
    ]);
    expect(fits[0]?.status).toBe("unexplained");
  });
});

describe("projectRedLines", () => {
  it("emits one red line per steady run, splits at boundaries, and marks barlines not inferred", () => {
    const beats = [...grid(8), ...grid(6, 0.4, 4.1).map((entry, k) => ({ ...entry, id: `c${k}` }))];
    const projection = projectRedLines(beats, [
      { id: "r", t: 4.1, kind: "reset", source: "user", version: 1 },
    ]);
    expect(projection.barlines_not_inferred).toBe(true);
    expect(projection.points).toHaveLength(2);
    expect(projection.points[0]).toMatchObject({ timeMs: 0, beatLengthMs: 500 });
    expect(projection.points[1]?.beatLengthMs).toBeCloseTo(400, 6);
    expect(projection.text).toContain("barlines not inferred");
    expect(projection.text).toContain("[TimingPoints]\n0,500.000000000000,4,2,0,100,1,0");
  });

  it("gives a free run one line per interval and a gap none", () => {
    const beats = [beat("a", 0), beat("b", 0.5), beat("c", 1.1), beat("d", 5), beat("e", 5.5)];
    const projection = projectRedLines(beats, [
      { id: "f", t: 0, kind: "free_start", source: "user", version: 1 },
      { id: "g", t: 1.5, kind: "gap_start", source: "user", version: 1 },
      { id: "h", t: 4.9, kind: "gap_end", source: "user", version: 1 },
      { id: "s", t: 4.95, kind: "steady_start", source: "user", version: 1 },
    ]);
    expect(projection.points.map((point) => Math.round(point.beatLengthMs))).toEqual([
      500, 600, 500,
    ]);
  });
});

describe("rankTroubleSpans", () => {
  it("ranks low confidence, interval jumps and unexplained sounds; edited spans count half", () => {
    const beats = [
      ...grid(10),
      beat("x", 5.2, { conf: 0.1 }),
      ...grid(10, 0.5, 5.5).map((entry, k) => ({ ...entry, id: `y${k}`, conf: 0.9 })),
    ];
    const spans = rankTroubleSpans({
      beats,
      boundaries: [],
      sounds: [sound("u", 12.13)],
      offers: [],
    });
    expect(spans[0]?.span.t0).toBeLessThan(5.2);
    expect(spans[0]?.span.t1).toBeGreaterThan(5.2);
    expect(spans[0]?.reasons.join()).toContain("low confidence");
    expect(spans[0]?.reasons.join()).toContain("interval jump");
    expect(spans.some((entry) => entry.reasons.join().includes("unexplained sound"))).toBe(true);
    const edited = rankTroubleSpans({
      beats: beats.map((entry) =>
        entry.id === "b9" ? { ...entry, source: "user" as const } : entry,
      ),
      boundaries: [],
      sounds: [],
      offers: [],
    });
    expect(edited[0]?.score).toBeCloseTo((spans[0]?.score ?? 0) / 2, 6);
  });
});

describe("RuleMockRecompute", () => {
  const request = (overrides = {}) => ({
    generation: 1,
    span: { t0: 0, t1: 10 },
    durationS: 20,
    beats: grid(12),
    boundaries: [],
    sounds: [],
    statements: [],
    suppressed: [],
    ...overrides,
  });

  it("refits a steady statement linearly, badged as a rule, with user-edit conflicts", async () => {
    const beats = grid(8).map((entry, k) =>
      k === 3 ? { ...entry, t: entry.t + 0.02, source: "user" as const } : entry,
    );
    const offers = await ruleMockRecompute(
      request({
        span: { t0: 0, t1: 4 },
        beats,
        statements: [{ id: "s", version: 1, kind: "steady", span: { t0: 0, t1: 4 } }],
      }),
    );
    const rewrite = offers.find((offer) => offer.role === "rewrite");
    expect(rewrite).toMatchObject({ providerKind: "rule", scopeKind: "local" });
    expect(rewrite?.conflicts.map((conflict) => conflict.kind)).toContain("user_edit");
    expect(rewrite?.consequences.moved).toBeGreaterThan(0);
  });

  it("extends a steady run forward and offers exclusive alternatives for unexplained sounds", async () => {
    const offers = await ruleMockRecompute(
      request({
        span: { t0: 0, t1: 6 },
        beats: grid(8),
        sounds: [sound("a", 2.19), sound("b", 2.69)],
      }),
    );
    const extend = offers.find((offer) => offer.role === "extend");
    expect(extend?.scopeKind).toBe("forward_continuation");
    expect(extend?.consequences.added).toBeGreaterThan(10);
    const alternatives = offers.filter((offer) => offer.role === "alternative");
    expect(alternatives).toHaveLength(2);
    expect(new Set(alternatives.map((offer) => offer.batchId)).size).toBe(1);
    expect(alternatives[0]?.conflicts.find((c) => c.kind === "sibling")?.refs).toEqual([
      alternatives[1]?.id,
    ]);
  });

  it("snaps beats onto strong nearby sounds and honours suppressed keys", async () => {
    const offers = await ruleMockRecompute(request({ sounds: [sound("a", 1.012)] }));
    const fix = offers.find((offer) => offer.role === "quick_fix");
    expect(fix?.edits).toEqual([{ op: "move_beat", id: "b2", t: 1.012, source: "rule" }]);
    const suppressed = await ruleMockRecompute(
      request({ sounds: [sound("a", 1.012)], suppressed: [fix?.semanticKey] }),
    );
    expect(suppressed.some((offer) => offer.role === "quick_fix")).toBe(false);
  });

  it("stops cooperatively when cancelled", async () => {
    const controller = new AbortController();
    const running = ruleMockRecompute(request(), controller.signal);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("stage helpers", () => {
  it("bands runs as steady with a BPM, free, or gap", () => {
    const beats = [...grid(5), beat("f1", 2.4), beat("f2", 3.1), beat("f3", 3.4)];
    const bands = runBands(beats, [
      { id: "f", t: 2.4, kind: "free_start", source: "user", version: 1 },
      { id: "g", t: 3.2, kind: "gap_start", source: "user", version: 1 },
      { id: "h", t: 3.3, kind: "gap_end", source: "user", version: 1 },
    ]);
    expect(bands.map((band) => band.kind)).toEqual(["steady", "free", "gap"]);
    expect(bands[0]?.bpm).toBeCloseTo(120, 6);
  });

  it("collapses dense beats, scales whiskers by ms and normalizes overview heat", () => {
    expect(beatsCollapse(grid(100, 0.5), { startS: 0, endS: 50 }, 400)).toBe(true);
    expect(beatsCollapse(grid(100, 0.5), { startS: 0, endS: 5 }, 400)).toBe(false);
    expect(whiskerPx(-12)).toBe(-12);
    expect(whiskerPx(500)).toBe(48);
    const heat = overviewHeat(computeGridFit([sound("a", 1.3)], grid(5), []), grid(5), 2, 4);
    expect(heat[2]?.unexplained).toBe(1);
  });
});

describe("synthetic demo", () => {
  it("has a known answer the mock draft gets wrong after 14 s", () => {
    const fits = computeGridFit(demoSounds(), demoBeats(), []);
    const unexplained = fits.filter((fit) => fit.status === "unexplained");
    expect(unexplained.length).toBeGreaterThan(5);
    expect(unexplained.every((fit) => fit.t > 14)).toBe(true);
    expect(fits.some((fit) => fit.status === "subdivision" && fit.divisor === 3)).toBe(true);
    expect(demoHits().length).toBe(demoSounds().length);
  });

  it("encodes 16-bit WAV", () => {
    const bytes = encodeWav([new Float32Array([0, 1, -1])], 8000);
    const view = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(emptyState().beats).toEqual([]);
  });
});
