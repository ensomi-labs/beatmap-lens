import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldTrace, parseTraceNdjson } from "ensomi";
import { afterEach, describe, expect, it } from "vitest";
import { sortedEntities, type TraceEvent } from "../src/draft/ensomi-contract";
import type { RecomputeRequest } from "../src/draft/recompute";
import { DraftSession } from "../src/draft/session";
import {
  demoAudio,
  demoBeats,
  demoPcm,
  demoProviders,
  demoSampleRate,
  demoSounds,
  encodeWav,
} from "../src/draft/synthetic";
import { createDraftMiddleware, RecomputeQueue, readTrace, TraceWriter } from "./draft";
import { startDraftServer } from "./draft-server";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function folder() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lens-draft-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function service(localDir: string) {
  const middleware = createDraftMiddleware({ localDir, cacheDir: join(localDir, "cache") });
  const server = createServer((request, response) =>
    middleware(request, response, () => {
      response.statusCode = 404;
      response.end();
    }),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => new Promise((done) => server.close(done)));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const post = (operation: string, body: unknown) =>
    fetch(`${origin}/api/draft/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Beatmap-Lens-Local": "1" },
      body: JSON.stringify(body),
    });
  return { origin, post };
}

const event = (seq: number): TraceEvent => ({
  schemaVersion: "0.1",
  seq,
  id: `edit_${seq}`,
  type: "edit",
  tsMs: 1_700_000_000_000 + seq,
  author: { kind: "user" },
  payload: { op: "remove_beat", id: `b${seq}` },
});

describe("TraceWriter", () => {
  it("serializes concurrent appends to one file in call order", async () => {
    const root = await folder();
    const path = join(root, "nested", "trace.jsonl");
    const writer = new TraceWriter();
    await Promise.all(
      Array.from({ length: 40 }, (_, index) => writer.append(path, [event(index)])),
    );
    const events = await readTrace(path);
    expect(events.map((entry) => entry.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it("writes DraftSession NDJSON traces that round-trip cleanly through ensomi parseTraceNdjson + foldTrace", async () => {
    const root = await folder();
    const path = join(root, "session.jsonl");
    const writer = new TraceWriter();
    const pending: Promise<void>[] = [];
    const session = new DraftSession((ev) => {
      pending.push(writer.append(path, [ev]));
    });
    session.initDraft(demoAudio(), { beats: demoBeats(), sounds: demoSounds() }, demoProviders);
    session.applyEdit({ op: "move_beat", id: "d0", t: 0.52, source: "user" });
    session.upsertStatement({ id: "st1", kind: "steady", span: { t0: 0, t1: 14 } });
    session.undo();
    session.redo();
    await Promise.all(pending);

    const raw = await readFile(path, "utf8");
    const parsed = parseTraceNdjson(raw);
    const folded = foldTrace(parsed);
    expect(parsed.every((ev) => ev.schemaVersion === "0.1")).toBe(true);
    expect(folded.beats.get("d0")).toMatchObject({ t: 0.52, source: "user", version: 2 });
    expect([...folded.statements.values()].filter((s) => s.active)).toHaveLength(1);
    expect(sortedEntities(folded.beats)).toEqual(sortedEntities(session.state.beats));
    expect((await readTrace(path)).map((ev) => ev.id)).toEqual(parsed.map((ev) => ev.id));
  });
});

describe("RecomputeQueue", () => {
  const request = (generation: number) => ({ generation }) as RecomputeRequest;

  it("supersedes an older generation, refuses a stale one and cancels a dropped request", async () => {
    const releases: (() => void)[] = [];
    const queue = new RecomputeQueue(
      (_request, signal) =>
        new Promise((resolve, reject) => {
          releases.push(() => resolve([]));
          signal?.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        }),
    );
    const first = queue.run("page", request(1));
    const second = queue.run("page", request(2));
    expect(await first).toEqual({ status: "superseded", generation: 1 });
    expect(await queue.run("page", request(1))).toEqual({ status: "stale", generation: 1 });
    releases[1]?.();
    expect(await second).toMatchObject({ status: "ok", providerKind: "rule", offers: [] });
    const dropped = new AbortController();
    const third = queue.run("page", request(3), dropped.signal);
    dropped.abort();
    expect(await third).toEqual({ status: "cancelled", generation: 3 });
  });

  it("runs the rule mock by default", async () => {
    const outcome = await new RecomputeQueue().run("page", {
      generation: 1,
      span: { t0: 0, t1: 5 },
      durationS: 10,
      beats: Array.from({ length: 6 }, (_, k) => ({
        id: `b${k}`,
        t: k * 0.5,
        source: "model",
        version: 1,
      })),
      boundaries: [],
      sounds: [],
      statements: [],
      suppressions: [],
    });
    expect(outcome).toMatchObject({ status: "ok", provider: "rule mock (reserved for N1)" });
  });
});

describe("Draft service", () => {
  it("appends and reads a trace, and refuses non-local requests", async () => {
    const root = await folder();
    const { origin, post } = await service(root);
    const tracePath = join(root, "t.jsonl");
    expect((await post("trace/append", { tracePath, events: [event(1), event(2)] })).status).toBe(
      200,
    );
    const read = await fetch(`${origin}/api/draft/trace?path=${encodeURIComponent(tracePath)}`, {
      headers: { "X-Beatmap-Lens-Local": "1" },
    });
    expect((await read.json()).events.map((entry: TraceEvent) => entry.seq)).toEqual([1, 2]);
    const foreign = await fetch(`${origin}/api/draft/trace?path=${encodeURIComponent(tracePath)}`);
    expect(foreign.status).toBe(403);
    expect((await post("nothing", {})).status).toBe(400);
  });

  it("renders listening views of a synthetic WAV, cached, and an export clip by path", async () => {
    const root = await folder();
    const { post } = await service(root);
    const audioPath = join(root, "demo.wav");
    await writeFile(audioPath, encodeWav([demoPcm()], demoSampleRate));
    const percussive = await post("audition-view", {
      audioPath,
      startSec: 1,
      endSec: 3,
      view: "percussive",
    });
    expect(percussive.status).toBe(200);
    expect(percussive.headers.get("content-type")).toBe("audio/wav");
    const bytes = new Uint8Array(await percussive.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(24, true)).toBe(demoSampleRate);
    expect(view.getUint32(40, true)).toBe(2 * demoSampleRate * 2);
    const again = await post("audition-view", {
      audioPath,
      startSec: 1,
      endSec: 3,
      view: "percussive",
    });
    expect((await again.arrayBuffer()).byteLength).toBe(bytes.byteLength);
    expect(
      (await post("audition-view", { audioPath, startSec: 0, endSec: 40, view: "low" })).status,
    ).toBe(400);
    expect(
      (await post("audition-view", { audioPath, startSec: 0, endSec: 1, view: "stems" })).status,
    ).toBe(400);

    const clip = await post("export-clip", {
      audioPath,
      startSec: 0.25,
      endSec: 2.25,
      beats: [0.5, 1, 1.5, 2],
    });
    const result = await clip.json();
    expect(result.outputPath.startsWith(join(root, "draft-clips"))).toBe(true);
    expect(result.beatCount).toBe(4);
    expect(result.downbeatCount).toBe(0);
    expect((await stat(result.outputPath)).size).toBeGreaterThan(44);
    expect(JSON.parse(await readFile(result.timingPath, "utf8"))).toEqual({
      beats: [0.5, 1, 1.5, 2],
    });
  }, 60_000);
});

describe("draft server routing", () => {
  it("opens /draft from the root and leaves /timing and its service untouched", async () => {
    const root = await folder();
    await writeFile(join(root, "index.html"), "<!doctype html><title>Inspector</title>");
    const server = await startDraftServer({ port: 0, staticRoot: root });
    cleanups.push(server.close);
    const origin = new URL(server.url).origin;
    expect(server.url).toBe(`${origin}/draft`);
    const home = await fetch(`${origin}/`, { redirect: "manual" });
    expect(home.headers.get("location")).toBe("/draft");
    expect((await fetch(`${origin}/draft`)).status).toBe(200);
    expect((await fetch(`${origin}/timing`)).status).toBe(200);
    const timing = await fetch(`${origin}/api/inspector/timing/passage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Beatmap-Lens-Local": "1" },
      body: JSON.stringify({ session_id: "none" }),
    });
    expect((await timing.json()).error).toBe("Reopen the session to reconnect the local service.");
    const draft = await fetch(`${origin}/api/draft/unknown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Beatmap-Lens-Local": "1" },
      body: "{}",
    });
    expect((await draft.json()).error).toBe("Unknown draft operation.");
  });
});
