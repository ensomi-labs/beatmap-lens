/**
 * Marks files are shared between builds: the listener's session 1 was saved by `4954249`, and that
 * build may open a file this one wrote. `fixtures/build-4954249/` holds that build's service and
 * reader code byte for byte (checked against its git blobs below), so these tests run its own
 * code on the files each build writes.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type {
  BlindPassage,
  Mark,
  OpenTiming,
  PageProvenance,
  PlaybackSetup,
} from "../src/timing/contracts";
import type { SessionFileV1 } from "../src/timing/format";
import { createTimingMiddleware as deployedMiddleware } from "./fixtures/build-4954249/server/timing";
import { createTimingMiddleware } from "./timing";

/** Git blob ids of the files at `4954249` (`git rev-parse 4954249:apps/inspector/<path>`). */
const deployedBlobs = {
  "server/timing.ts": "e9e29f817c25e5cfb896f38bbff437628f1abec3",
  "server/local-service.ts": "4adfd8242bfd1cbe793313fca8360e8884720c07",
  "src/timing/format.ts": "da197dcb3b8174a0d5c60d837617141688e37470",
  "src/timing/contracts.ts": "8c89993020b4a48a5c3d7f24ab0e9ae36f3713a3",
};

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const startMs = 70_000.37;
const beatMs = 60_000 / 127.3;
const beats = (shiftMs: number) =>
  Array.from({ length: 30 }, (_, index) => startMs + shiftMs + index * beatMs);

it("holds 4954249's service and reader code byte for byte", async () => {
  for (const [path, blob] of Object.entries(deployedBlobs)) {
    const bytes = await readFile(new URL(`./fixtures/build-4954249/${path}`, import.meta.url));
    const id = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    expect(id, path).toBe(blob);
  }
});

it("opens a marks file written by 4954249 as that build does: saves, reveals and legends", async () => {
  const f = await fixture();
  const old = await f.service(deployedMiddleware());
  const opened: OpenTiming = await old("open", { session_path: f.sessionPath });
  const target = (passage_index: number) => ({ session_id: opened.session_id, passage_index });
  const shown: BlindPassage[] = [await old("passage", target(0)), await old("passage", target(1))];
  const first = await old("save", saveBody(target(0), [mark("m1", 72_468.9342)]));
  const second = await old(
    "save",
    saveBody(target(0), [mark("m1", 72_468.9342), mark("m2", 73_000)]),
  );
  await old("reveal", { ...target(0), save_id: second.save_id });
  await old("save", saveBody(target(1), [mark("m3", 75_000.25)]));
  expect(first.save_id).not.toBe(second.save_id);

  const current = await f.service(createTimingMiddleware());
  const reopened: OpenTiming = await current("open", { session_path: f.sessionPath });
  expect(reopened.marks_warning).toBeUndefined();
  expect(reopened.passages.map(({ saved, revealed }) => ({ saved, revealed }))).toEqual([
    { saved: true, revealed: true },
    { saved: true, revealed: false },
  ]);
  const again = (passage_index: number): Promise<BlindPassage> =>
    current("passage", { session_id: reopened.session_id, passage_index });
  const revealed = await again(0);
  expect(revealed.proposals).toEqual(shown[0]?.proposals);
  expect(revealed.saved).toMatchObject({ save_id: second.save_id, setup: "DT270pro 3%" });
  expect(revealed.saved?.marks).toEqual([mark("m1", 72_468.9342), mark("m2", 73_000)]);
  expect(revealed.names?.map((entry) => entry.name).sort()).toEqual(["model-one", "model-two"]);
  const blind = await again(1);
  expect(blind.proposals).toEqual(shown[1]?.proposals);
  expect(blind.saved?.marks).toEqual([mark("m3", 75_000.25)]);
  expect(blind.names).toBeUndefined();
  expect(JSON.stringify(blind)).not.toContain("model-");
});

function mark(id: string, time_ms: number): Mark {
  return {
    id,
    kind: "beat",
    time_ms,
    placed: "2026-10-25T09:10:41.002Z",
    method: "key-playing",
    zoom_ms_per_px: 0.25,
    rate_at_placement: 1,
    blind: true,
    nudged_ms: 0,
    snapped_to: null,
  };
}

/** A save as the `4954249` page sends it. */
function saveBody(target: { session_id: string; passage_index: number }, marks: Mark[]) {
  const playback: PlaybackSetup = {
    rate: 1,
    volume: 0.5,
    loudness_match: false,
    loudness_gain_db: -4.2,
    loudness_applied_db: 0,
    playhead_offset_ms: 12,
    preroll_ms: 120,
    mark_clicks: false,
    device_rate_hz: 44_100,
    base_latency_ms: 5.8,
    output_latency_ms: 16,
  };
  const page: PageProvenance = {
    transport: "copyToChannel",
    context_sample_rate: 44_100,
    buffer_frames: 64,
    buffer_channels: 2,
    clock_method: "getOutputTimestamp",
    user_agent: "test",
    browser_brands: [],
  };
  return { ...target, marks, setup: "DT270pro 3%", playback, page, visible_keys: ["p1", "p2"] };
}

/** A session of two passages in a temporary folder, and a way to serve it with a given build. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lens-timing-compat-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const folder of ["sessions", "private", "bulk"]) await mkdir(join(root, folder));
  const frames = 64;
  const pcm = new Float32Array(frames * 2).map((_, index) => Math.sin(index));
  await writeFile(join(root, "bulk", "audio.f32"), new Uint8Array(pcm.buffer));
  const audio = {
    path: "../bulk/audio.f32",
    format: "f32le-interleaved" as const,
    sha256: "source-sha",
    pcm_sha256: createHash("sha256").update(new Uint8Array(pcm.buffer)).digest("hex"),
    sample_rate: 44_100,
    channels: 2,
    frames,
    decode: { decoder: "libsndfile", lead_rule: "osu-lead-v1", lead_samples: 0 },
  };
  const passage = (id: string) => ({
    id,
    start_ms: startMs,
    end_ms: 85_000.5,
    audio,
    proposals: [
      { key: "p1", beats_ms: beats(13.605) },
      { key: "p2", beats_ms: beats(12) },
    ],
  });
  const session: SessionFileV1 = {
    version: 1,
    id: "session-01",
    clock: "osu",
    reveal_key_path: "../private/session-01.identities.json",
    passages: [passage("passage-01"), passage("passage-02")],
  };
  const sessionPath = join(root, "sessions", "session-01.timing.json");
  await writeFile(sessionPath, JSON.stringify(session));
  const names = { p1: { name: "model-one" }, p2: { name: "model-two" } };
  await writeFile(
    join(root, "private", "session-01.identities.json"),
    JSON.stringify({
      version: 1,
      session_id: "session-01",
      passages: { "passage-01": names, "passage-02": names },
    }),
  );

  /** Serves the session folder with one build's middleware; returns its operation caller. */
  const service = async (
    middleware: (request: IncomingMessage, response: ServerResponse, next: () => void) => unknown,
  ) => {
    const server = createServer((req, res) => middleware(req, res, () => res.writeHead(404).end()));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address.");
    return async (operation: string, body: unknown) => {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/inspector/timing/${operation}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Beatmap-Lens-Local": "1" },
          body: JSON.stringify(body),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    };
  };
  return { root, sessionPath, service };
}
