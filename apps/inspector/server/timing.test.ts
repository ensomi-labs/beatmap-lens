import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  type BlindPassage,
  type Mark,
  type OpenTiming,
  type PageProvenance,
  type PlaybackSetup,
  staleSessionError,
} from "../src/timing/contracts";
import type { SaveEventV1, SessionFileV1 } from "../src/timing/format";
import { createTimingMiddleware } from "./timing";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A non-integer tempo and fractional boundaries must cross the service unchanged.
const beatMs = 60_000 / 127.3;
const startMs = 70_000.37;
const proposalA = Array.from({ length: 30 }, (_, index) => startMs + 13.605 + index * beatMs);
const proposalB = Array.from({ length: 30 }, (_, index) => startMs + 12 + index * beatMs);

it("serves a blind view with keys, times and PCM properties only", async () => {
  const f = await fixture();
  const opened: OpenTiming = await f.post("open", { session_path: f.sessionPath });
  const target = { session_id: opened.session_id, passage_index: 0 };
  const passage: BlindPassage = await f.post("passage", target);
  const visible = JSON.stringify([opened, passage]);
  // The marks path is the listener's own output file and is shown, as Compare shows its verdicts.
  for (const secret of ["secret-model", "identities", "private", "bulk", ".f32", "sha256"])
    expect(visible).not.toContain(secret);
  expect(opened.passages[0]).toMatchObject({
    start_ms: startMs,
    end_ms: 85_000.5,
    audio: { handle: "a1", sample_rate: 44_100, channels: 2, frames: f.frames },
    saved: false,
    revealed: false,
  });
  expect(passage.proposals.map((p) => p.key).sort()).toEqual(["p1", "p2"]);
  const byKey = new Map(passage.proposals.map((p) => [p.key, p.beats_ms]));
  expect(byKey.get("p1")).toEqual(proposalA);
  expect(byKey.get("p2")).toEqual(proposalB);
  expect(new Set(passage.proposals.map((p) => p.colour_index)).size).toBe(2);
  expect(passage.names).toBeUndefined();

  const bytes = new Uint8Array(
    await (await f.request("audio", { ...target, handle: "a1" })).arrayBuffer(),
  );
  expect(bytes).toEqual(new Uint8Array(f.pcm.buffer));
});

it("refuses a PCM payload that does not match its stated hash", async () => {
  const f = await fixture({ pcmSha: "0".repeat(64) });
  const opened: OpenTiming = await f.post("open", { session_path: f.sessionPath });
  await expect(f.post("audio", { session_id: opened.session_id, handle: "a1" })).rejects.toThrow(
    "SHA-256",
  );
});

it("saves anonymous keys and derived samples, and reveals only after a current save", async () => {
  const f = await fixture();
  const opened: OpenTiming = await f.post("open", { session_path: f.sessionPath });
  const target = { session_id: opened.session_id, passage_index: 0 };
  const shown: BlindPassage = await f.post("passage", target);
  await expect(f.post("reveal", { ...target, save_id: "none" })).rejects.toThrow("Save");

  const marks = [mark("m2", "unbeat", 72_700.25), mark("m1", "beat", 72_468.9342)];
  await expect(f.post("save", { ...saveBody(target, marks), setup: " " })).rejects.toThrow("setup");
  const saved = await f.post("save", saveBody(target, marks));
  const record: SaveEventV1 = JSON.parse(await readFile(opened.marks_path, "utf8"));
  expect(opened.marks_path).toBe(join(f.root, "sessions", "session-01.timing.marks.jsonl"));
  expect(record).toMatchObject({
    type: "save",
    id: saved.save_id,
    session_id: "session-01",
    passage_id: "passage-01",
    clock: "osu",
    audio: { sha256: "source-sha", pcm_sha256: f.pcmSha, sample_rate: 44_100, frames: f.frames },
    setup: "DT 270 PRO · FineTune bypassed · 44.1 kHz device",
  });
  expect(record.marks.map((m) => [m.id, m.time_ms, m.sample])).toEqual([
    ["m1", 72_468.9342, Math.floor((72_468.9342 * 44_100) / 1000 + 0.5)],
    ["m2", 72_700.25, Math.floor((72_700.25 * 44_100) / 1000 + 0.5)],
  ]);
  expect(record.proposals_shown).toEqual(
    shown.proposals.map((p, legend_index) => ({
      key: p.key,
      colour_index: p.colour_index,
      legend_index,
      visible_at_save: p.key === "p1",
    })),
  );
  expect(JSON.stringify(record)).not.toContain("secret-model");
  expect(JSON.stringify(saved)).not.toContain("secret-model");

  await expect(f.post("reveal", { ...target, save_id: "stale" })).rejects.toThrow("current");
  const revealed = await f.post("reveal", { ...target, save_id: saved.save_id });
  expect(revealed.names).toEqual(
    shown.proposals.map((p) => ({
      key: p.key,
      name: p.key === "p1" ? "secret-model-one" : "secret-model-two",
    })),
  );
  const lines = (await readFile(opened.marks_path, "utf8")).trim().split("\n");
  expect(JSON.parse(lines[1] ?? "")).toMatchObject({
    type: "reveal",
    passage_id: "passage-01",
    after_save_id: saved.save_id,
  });

  // Reopening replays the legend, the saved marks and the revealed state.
  const reopened: OpenTiming = await f.post("open", { session_path: f.sessionPath });
  expect(reopened.passages[0]).toMatchObject({ saved: true, revealed: true });
  const again: BlindPassage = await f.post("passage", {
    session_id: reopened.session_id,
    passage_index: 0,
  });
  expect(again.proposals).toEqual(shown.proposals);
  expect(again.saved?.marks.map((m) => [m.id, m.time_ms])).toEqual([
    ["m1", 72_468.9342],
    ["m2", 72_700.25],
  ]);
  expect(again.names).toEqual(revealed.names);
});

it("opens a revealed passage without names when the key file is gone, and records no failed reveal", async () => {
  const f = await fixture();
  const opened: OpenTiming = await f.post("open", { session_path: f.sessionPath });
  const target = { session_id: opened.session_id, passage_index: 0 };
  const saved = await f.post("save", saveBody(target, [mark("m1", "beat", 72_468.9342)]));
  const keyPath = join(f.root, "private", "session-01.identities.json");
  await rename(keyPath, `${keyPath}.away`);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(f.post("reveal", { ...target, save_id: saved.save_id })).rejects.toThrow(
    "identity key file could not be read",
  );
  expect((await readFile(opened.marks_path, "utf8")).trim().split("\n")).toHaveLength(1);

  await rename(`${keyPath}.away`, keyPath);
  await f.post("reveal", { ...target, save_id: saved.save_id });
  await rm(keyPath);
  const passage: BlindPassage = await f.post("passage", target);
  expect(passage.saved?.marks).toHaveLength(1);
  expect(passage.names).toBeUndefined();
  expect(passage.names_error).toContain("identity key file could not be read");
  expect(JSON.stringify(passage)).not.toContain("private");
});

it("keeps an unsaved passage's legend when the session is opened again", async () => {
  const f = await fixture();
  const first: OpenTiming = await f.post("open", { session_path: f.sessionPath });
  const shown: BlindPassage = await f.post("passage", {
    session_id: first.session_id,
    passage_index: 0,
  });
  const again: OpenTiming = await f.post("open", { session_path: f.sessionPath });
  expect(
    (await f.post("passage", { session_id: again.session_id, passage_index: 0 })).proposals,
  ).toEqual(shown.proposals);
});

it("refuses marks outside the passage and marks whose time is not a number", async () => {
  const f = await fixture();
  const opened: OpenTiming = await f.post("open", { session_path: f.sessionPath });
  const target = { session_id: opened.session_id, passage_index: 0 };
  await expect(f.post("save", saveBody(target, [mark("m", "beat", 69_999)]))).rejects.toThrow(
    "inside",
  );
  const coerced = { ...mark("m", "beat", 0), time_ms: "72000.5" } as unknown as Mark;
  await expect(f.post("save", saveBody(target, [coerced]))).rejects.toThrow("finite numbers");
  await expect(
    f.post("save", saveBody(target, [{ ...mark("", "beat", 72_000.5) }])),
  ).rejects.toThrow("id");
});

it("names an unknown session id so the page can reopen the session and retry", async () => {
  const f = await fixture();
  const response = await f.request("save", saveBody({ session_id: "gone", passage_index: 0 }, []));
  expect(await response.json()).toMatchObject({ name: staleSessionError });
});

function mark(id: string, kind: Mark["kind"], time_ms: number): Mark {
  return {
    id,
    kind,
    time_ms,
    placed: "2026-10-25T09:10:41.002Z",
    method: "click",
    zoom_ms_per_px: 0.25,
    rate_at_placement: 0.5,
    blind: true,
    nudged_ms: 0,
    snapped_to: null,
  };
}

function saveBody(target: { session_id: string; passage_index: number }, marks: Mark[]) {
  const playback: PlaybackSetup = {
    rate: 1,
    volume: 0.5,
    loudness_match: false,
    loudness_gain_db: -4.2,
    loudness_applied_db: 0,
    playhead_offset_ms: 12,
    preroll_ms: 120,
    device_rate_hz: 44_100,
    base_latency_ms: 5.8,
    output_latency_ms: 16,
  };
  const page: PageProvenance = {
    transport: "copyToChannel",
    context_sample_rate: 44_100,
    buffer_frames: 100,
    buffer_channels: 2,
    clock_method: "getOutputTimestamp",
    user_agent: "test",
    browser_brands: [],
  };
  return {
    ...target,
    marks,
    setup: "DT 270 PRO · FineTune bypassed · 44.1 kHz device",
    playback,
    page,
    visible_keys: ["p1"],
  };
}

async function fixture(options: { pcmSha?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lens-timing-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const folder of ["sessions", "private", "bulk"]) await mkdir(join(root, folder));
  const frames = 64;
  const pcm = new Float32Array(frames * 2).map((_, index) => Math.sin(index) * 1.25);
  await writeFile(join(root, "bulk", "opaque-audio.f32"), new Uint8Array(pcm.buffer));
  const pcmSha = createHash("sha256").update(new Uint8Array(pcm.buffer)).digest("hex");
  const session: SessionFileV1 = {
    version: 1,
    id: "session-01",
    clock: "osu",
    reveal_key_path: "../private/session-01.identities.json",
    passages: [
      {
        id: "passage-01",
        title: "Passage 01",
        start_ms: startMs,
        end_ms: 85_000.5,
        context_before_ms: 3000,
        context_after_ms: 3000,
        hint: "Place the pulse against the attacks.",
        flags: [],
        loudness_gain_db: -4.2,
        audio: {
          path: "../bulk/opaque-audio.f32",
          format: "f32le-interleaved",
          sha256: "source-sha",
          pcm_sha256: options.pcmSha ?? pcmSha,
          sample_rate: 44_100,
          channels: 2,
          frames,
          decode: { decoder: "libsndfile", lead_rule: "osu-lead-v1", lead_samples: 0 },
        },
        proposals: [
          { key: "p1", beats_ms: proposalA },
          { key: "p2", beats_ms: proposalB },
        ],
      },
    ],
  };
  const sessionPath = join(root, "sessions", "session-01.timing.json");
  await writeFile(sessionPath, JSON.stringify(session));
  await writeFile(
    join(root, "private", "session-01.identities.json"),
    JSON.stringify({
      version: 1,
      session_id: "session-01",
      passages: {
        "passage-01": { p1: { name: "secret-model-one" }, p2: { name: "secret-model-two" } },
      },
    }),
  );

  const middleware = createTimingMiddleware();
  const server = createServer((req, res) => middleware(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address.");
  const request = (operation: string, body: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/api/inspector/timing/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Beatmap-Lens-Local": "1" },
      body: JSON.stringify(body),
    });
  const post = async (operation: string, body: unknown) => {
    const response = await request(operation, body);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  };
  return { root, sessionPath, frames, pcm, pcmSha, request, post };
}
