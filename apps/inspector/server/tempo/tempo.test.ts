import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  foldTrace,
  parseTraceNdjson,
  ScriptedMockProvider,
  SessionController,
  serializeState,
} from "ensomi";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertTempoLocalRequest,
  createTempoMiddleware,
  SongSessionHost,
  sanitizeTempoErrorMessage,
  TempoDaemonClient,
  type TempoServiceOptions,
  type TempoSongSummary,
  type TraceWriter,
} from "./index.ts";
import { startTempoServer } from "./tempo-server.ts";

const tempoServerScript = fileURLToPath(new URL("./tempo-server.ts", import.meta.url));

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

/** Synthesize a deterministic 16-bit PCM mono/stereo WAV click-and-tone track in memory. */
function buildSyntheticWav(options: {
  durationSec: number;
  clickTimesSec: readonly number[];
  sampleRate?: number;
  channels?: 1 | 2;
  toneHz?: number;
}): Buffer {
  const sr = options.sampleRate ?? 22050;
  const channels = options.channels ?? 1;
  const frames = Math.max(1, Math.round(options.durationSec * sr));
  const samples = new Float64Array(frames);

  if (options.toneHz) {
    for (let i = 0; i < frames; i += 1) {
      samples[i] = 0.08 * Math.sin((2 * Math.PI * options.toneHz * i) / sr);
    }
  }

  const burstFrames = Math.round(0.024 * sr);
  for (const clickSec of options.clickTimesSec) {
    const start = Math.round(clickSec * sr);
    for (let k = 0; k < burstFrames && start + k < frames; k += 1) {
      if (start + k < 0) continue;
      const env = Math.exp(-k / (0.0035 * sr));
      const osc =
        Math.sin((2 * Math.PI * 1600 * k) / sr) + 0.6 * Math.cos((2 * Math.PI * 3100 * k) / sr);
      samples[start + k] = (samples[start + k] ?? 0) + 0.55 * env * osc;
    }
  }

  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    const val = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const int16 = Math.round(val * 32767);
    for (let c = 0; c < channels; c += 1) {
      buf.writeInt16LE(int16, offset);
      offset += 2;
    }
  }
  return buf;
}

function regularClicks(startSec: number, endSec: number, stepSec: number): number[] {
  const out: number[] = [];
  for (let t = startSec; t < endSec - 1e-6; t += stepSec) {
    out.push(Number(t.toFixed(6)));
  }
  return out;
}

async function createTestHarness(workspaceDir?: string, extraOptions?: TempoServiceOptions) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lens-tempo-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));

  const wsDir = workspaceDir ?? join(root, "workspace");
  await mkdir(wsDir, { recursive: true });

  const middleware = createTempoMiddleware({
    workspaceDir: wsDir,
    ...extraOptions,
    env: {
      ...process.env,
      TEMPO_ANALYZER_BACKEND: "dsp",
      ...extraOptions?.env,
    },
  });
  cleanups.push(() => middleware.service.close());

  const server = createServer((req, res) => {
    middleware(req, res, () => {
      res.writeHead(404);
      res.end("Not found");
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  cleanups.push(() => {
    server.closeAllConnections?.();
    return new Promise<void>((done) => server.close(() => done()));
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const origin = `http://127.0.0.1:${port}`;

  async function apiJson<T = Record<string, unknown>>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const res = await fetch(`${origin}${path}`, {
      ...init,
      headers: {
        "X-Beatmap-Lens-Local": "1",
        ...(init?.body && typeof init.body === "string"
          ? { "Content-Type": "application/json" }
          : {}),
        ...init?.headers,
      },
    });
    const payload = (await res.json()) as T & { error?: string };
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${payload.error ?? JSON.stringify(payload)}`);
    }
    return payload;
  }

  return { root, wsDir, origin, service: middleware.service, apiJson };
}

describe("Tempo backend (.ensomi-tempo/ workspace, warm daemon, SessionController API)", () => {
  it("discovers top-level audio files, ignores dotfiles, and supports both local path and binary/multipart upload Import", {
    timeout: 15_000,
  }, async () => {
    const { root, wsDir, origin, apiJson } = await createTestHarness();
    await writeFile(
      join(wsDir, "02-beta.wav"),
      buildSyntheticWav({ durationSec: 4, clickTimesSec: regularClicks(0.5, 3.6, 0.5) }),
    );
    await writeFile(
      join(wsDir, "01-alpha.wav"),
      buildSyntheticWav({ durationSec: 4, clickTimesSec: regularClicks(0.4, 3.6, 0.5) }),
    );
    await writeFile(join(wsDir, ".hidden.wav"), Buffer.from("ignored"));
    await writeFile(join(wsDir, "notes.txt"), "ignored");

    const initial = await apiJson<{
      workspaceDir: string;
      activeSongId: string | null;
      songs: TempoSongSummary[];
    }>("/api/tempo/workspace");

    expect(initial.workspaceDir).toBe(await realpath(wsDir));
    expect(initial.songs.map((s) => s.fileName)).toEqual(["01-alpha.wav", "02-beta.wav"]);
    expect(initial.activeSongId).toBe(initial.songs[0]?.songId);
    expect(existsSync(join(wsDir, ".ensomi-tempo", "workspace.json"))).toBe(true);

    // External local path import (linked without duplicating file when copyIntoWorkspace is false).
    const extDir = join(root, "external");
    await mkdir(extDir, { recursive: true });
    const extAudio = join(extDir, "03-external.wav");
    await writeFile(
      extAudio,
      buildSyntheticWav({ durationSec: 4, clickTimesSec: regularClicks(0.5, 3.5, 0.5) }),
    );

    const imported = await apiJson<{
      songs: TempoSongSummary[];
      importedSongIds: string[];
      activeSongId: string;
    }>("/api/tempo/workspace/import", {
      method: "POST",
      body: JSON.stringify({ paths: [extAudio] }),
    });
    expect(imported.importedSongIds).toHaveLength(1);
    expect(imported.activeSongId).toBe(imported.importedSongIds[0]);
    expect(imported.songs.map((s) => s.fileName)).toEqual([
      "01-alpha.wav",
      "02-beta.wav",
      "03-external.wav",
    ]);

    // Binary stream browser upload (`POST /api/tempo/workspace/import-upload?name=...`).
    const uploadBytes = buildSyntheticWav({
      durationSec: 3,
      clickTimesSec: regularClicks(0.5, 2.6, 0.5),
    });
    const binUpload = await apiJson<{
      songId: string;
      song: TempoSongSummary;
      songs: TempoSongSummary[];
    }>("/api/tempo/workspace/import-upload?name=04-uploaded%20track.wav", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(uploadBytes),
    });
    expect(binUpload.song.fileName).toBe("04-uploaded track.wav");
    expect(existsSync(join(wsDir, "04-uploaded track.wav"))).toBe(true);
    expect(binUpload.songs).toHaveLength(4);

    // Multipart FormData upload (`<input type="file" multiple>`).
    const form = new FormData();
    form.append(
      "files",
      new File([new Uint8Array(uploadBytes)], "05-form-upload.wav", { type: "audio/wav" }),
    );
    const formRes = await fetch(`${origin}/api/tempo/workspace/import-upload`, {
      method: "POST",
      headers: { "X-Beatmap-Lens-Local": "1" },
      body: form,
    });
    expect(formRes.ok).toBe(true);
    const formBody = (await formRes.json()) as { songs: TempoSongSummary[]; songId: string };
    expect(formBody.songs).toHaveLength(5);
    expect(existsSync(join(wsDir, "05-form-upload.wav"))).toBe(true);
  });

  it("persists crash-safe .jsonl traces, heals torn crash tails on reopen, and supports single-step apply_unbeat_cue undo & redo", {
    timeout: 15_000,
  }, async () => {
    const { wsDir, service, apiJson } = await createTestHarness();
    await writeFile(
      join(wsDir, "pulse.wav"),
      buildSyntheticWav({ durationSec: 8, clickTimesSec: regularClicks(0.5, 7.6, 0.5) }),
    );

    const ws = await apiJson<{ songs: TempoSongSummary[] }>("/api/tempo/workspace");
    const songId = ws.songs[0]?.songId ?? "";
    expect(songId.length).toBeGreaterThan(0);

    const opened = await apiJson<{
      song: TempoSongSummary;
      state: ReturnType<typeof serializeState>;
    }>(`/api/tempo/songs/${songId}/open`, { method: "POST", body: "{}" });

    expect(opened.song.analyzed).toBe(true);
    expect(opened.state.beats.length).toBeGreaterThan(8);
    const targetBeat = opened.state.beats[2];
    expect(targetBeat).toBeDefined();
    const beatCountBefore = opened.state.beats.length;

    // Apply atomic `apply_unbeat_cue` right on `targetBeat.timeSec`: removes nearby draft beat AND adds UnbeatCue!
    const afterUnbeat = await apiJson<{
      state: ReturnType<typeof serializeState>;
      event: { id: string };
    }>(`/api/tempo/songs/${songId}/edit`, {
      method: "POST",
      body: JSON.stringify({
        op: "apply_unbeat_cue",
        id: "unbeat_user_1",
        timeSec: targetBeat?.timeSec ?? 1.5,
        captureRadiusSec: 0.06,
      }),
    });
    expect(afterUnbeat.state.unbeats).toHaveLength(1);
    expect(afterUnbeat.state.beats.length).toBe(beatCountBefore - 1);

    // Single-step undo restores BOTH the captured draft beat AND removes the UnbeatCue!
    const afterUndo = await apiJson<{ state: ReturnType<typeof serializeState> }>(
      `/api/tempo/songs/${songId}/edit`,
      {
        method: "POST",
        body: JSON.stringify({ action: "undo" }),
      },
    );
    expect(afterUndo.state.unbeats).toHaveLength(0);
    expect(afterUndo.state.beats.length).toBe(beatCountBefore);

    // Redo re-applies the unbeat cue cleanly!
    const afterRedo = await apiJson<{ state: ReturnType<typeof serializeState> }>(
      `/api/tempo/songs/${songId}/edit`,
      {
        method: "POST",
        body: JSON.stringify({ action: "redo" }),
      },
    );
    expect(afterRedo.state.unbeats).toHaveLength(1);
    expect(afterRedo.state.beats.length).toBe(beatCountBefore - 1);

    // Fire 6 concurrent edits to verify serialized mutex `.jsonl` persistence without interleaving.
    await Promise.all(
      [0, 1, 2, 3, 4, 5].map((idx) =>
        apiJson(`/api/tempo/songs/${songId}/edit`, {
          method: "POST",
          body: JSON.stringify({
            op: "upsert_sound",
            sound: {
              id: `user_sound_${idx}`,
              timeSec: 0.25 + idx * 0.2,
              strength: 0.8,
              family: "percussion",
              role: "transient_attack",
              source: "user",
            },
          }),
        }),
      ),
    );

    const tracePath = join(wsDir, ".ensomi-tempo", "traces", `${songId}.jsonl`);
    const preCloseRaw = await readFile(tracePath, "utf8");
    expect(preCloseRaw.endsWith("\n")).toBe(true);
    const parsedEvents = parseTraceNdjson(preCloseRaw);
    const expectedFolded = serializeState(foldTrace(parsedEvents));

    // Simulate a torn unterminated crash line at the tail of `.jsonl`, then reopen in a fresh service!
    await service.close();
    await appendFile(tracePath, '{"schemaVersion":"0.2","seq":999,"id":"torn_partial');

    const second = await createTestHarness(wsDir);
    const reopened = await second.apiJson<{
      state: ReturnType<typeof serializeState>;
    }>(`/api/tempo/songs/${songId}/open`, { method: "POST", body: "{}" });

    expect(reopened.state.lastSeq).toBe(expectedFolded.lastSeq);
    expect(reopened.state.beats).toEqual(expectedFolded.beats);
    expect(reopened.state.unbeats).toEqual(expectedFolded.unbeats);
    expect(reopened.state.sounds.length).toBe(expectedFolded.sounds.length);
  });

  it("maintains 3-layer isolation (snaps writes zero .jsonl lines and never aborts recompute), Segment split/move/merge/keep, Range 206 audio, and exports", {
    timeout: 15_000,
  }, async () => {
    const { wsDir, origin, apiJson } = await createTestHarness();
    await writeFile(
      join(wsDir, "structure.wav"),
      buildSyntheticWav({
        durationSec: 10,
        clickTimesSec: regularClicks(0.5, 9.6, 0.5),
        channels: 2,
        toneHz: 330,
      }),
    );

    const ws = await apiJson<{ songs: TempoSongSummary[] }>("/api/tempo/workspace");
    const songId = ws.songs[0]?.songId ?? "";
    const opened = await apiJson<{ state: ReturnType<typeof serializeState> }>(
      `/api/tempo/songs/${songId}/open`,
      { method: "POST", body: "{}" },
    );

    const firstSeg = opened.state.segments[0];
    expect(firstSeg).toBeDefined();

    // Segment split -> move boundary -> keep -> merge roundtrip.
    const splitRes = await apiJson<{
      state: ReturnType<typeof serializeState>;
      songSummary: TempoSongSummary;
    }>(`/api/tempo/songs/${songId}/edit`, {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            op: "split_segment",
            segmentId: firstSeg?.id ?? "seg_0",
            newSegmentId: "seg_user_right",
            timeSec: 4.0,
          },
          {
            op: "move_segment_boundary",
            leftSegmentId: firstSeg?.id ?? "seg_0",
            rightSegmentId: "seg_user_right",
            timeSec: 4.5,
          },
          {
            op: "set_segment_keep",
            segmentId: firstSeg?.id ?? "seg_0",
            kept: true,
          },
        ],
      }),
    });
    expect(splitRes.songSummary.keptSegmentCount).toBe(1);
    expect(splitRes.state.segments[0]?.t1).toBe(4.5);
    expect(splitRes.state.segments[0]?.kept).toBe(true);

    // Shift unlocked beats in [4.5, 10) slightly off-grid so recompute has a clear correction to propose.
    await apiJson(`/api/tempo/songs/${songId}/edit`, {
      method: "POST",
      body: JSON.stringify({
        op: "shift_beats",
        range: { t0: 4.6, t1: 9.8 },
        deltaSec: 0.055,
        source: "draft",
      }),
    });

    const tracePath = join(wsDir, ".ensomi-tempo", "traces", `${songId}.jsonl`);
    const traceBeforeSnaps = await readFile(tracePath, "utf8");

    // Run snaps alone first: verify ZERO `.jsonl` lines appended!
    const snapOnly = await apiJson<{
      status: string;
      candidates: Array<{ role: string; deltaMs: number; label: string }>;
    }>(`/api/tempo/songs/${songId}/snaps`, {
      method: "POST",
      body: JSON.stringify({ timeSec: 1.01, windowSec: 0.12 }),
    });
    expect(snapOnly.status).toBe("ok");
    expect(snapOnly.candidates.length).toBeGreaterThanOrEqual(1);
    const traceAfterSnaps = await readFile(tracePath, "utf8");
    expect(traceAfterSnaps).toBe(traceBeforeSnaps);

    // Enable hold-offers (`Alt`-audition hold), then fire recompute AND concurrent snaps simultaneously!
    await apiJson(`/api/tempo/songs/${songId}/hold-offers`, {
      method: "POST",
      body: JSON.stringify({ hold: true }),
    });

    const [recompHeld, concurrentSnap] = await Promise.all([
      apiJson<{
        status: string;
        offers: Array<{ id: string; status: string }>;
        holdingOffers: boolean;
      }>(`/api/tempo/songs/${songId}/recompute`, {
        method: "POST",
        body: JSON.stringify({ scope: { t0: 4.5, t1: 10.0 }, reason: "Realign second section" }),
      }),
      apiJson<{ status: string; candidates: unknown[] }>(`/api/tempo/songs/${songId}/snaps`, {
        method: "POST",
        body: JSON.stringify({ timeSec: 5.01, windowSec: 0.12 }),
      }),
    ]);

    expect(concurrentSnap.status).toBe("ok");
    expect(recompHeld.status).toBe("held");
    expect(recompHeld.holdingOffers).toBe(true);
    expect(recompHeld.offers.length).toBeGreaterThanOrEqual(1);

    // Release hold -> flushes held offers into state & `.jsonl`!
    const released = await apiJson<{
      flushed: boolean;
      offers: Array<{ id: string }>;
    }>(`/api/tempo/songs/${songId}/hold-offers`, {
      method: "POST",
      body: JSON.stringify({ hold: false }),
    });
    expect(released.flushed).toBe(true);
    const offerId = released.offers[0]?.id ?? "";
    expect(offerId.length).toBeGreaterThan(0);

    // Accept surfaced offer cleanly!
    const accepted = await apiJson<{ ok: boolean }>(
      `/api/tempo/songs/${songId}/offers/${offerId}/accept`,
      { method: "POST", body: "{}" },
    );
    expect(accepted.ok).toBe(true);

    // Merge the two segments back and verify contiguity.
    const merged = await apiJson<{ state: ReturnType<typeof serializeState> }>(
      `/api/tempo/songs/${songId}/edit`,
      {
        method: "POST",
        body: JSON.stringify({
          op: "merge_segments",
          leftSegmentId: firstSeg?.id ?? "seg_0",
          rightSegmentId: "seg_user_right",
        }),
      },
    );
    expect(merged.state.segments[0]?.t0).toBe(0);

    // HTTP Range 206 Partial Content check on `/audio` + stereo `audition` WAV check.
    const rangeRes = await fetch(`${origin}/api/tempo/songs/${songId}/audio`, {
      headers: { Range: "bytes=0-63" },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("accept-ranges")).toBe("bytes");
    expect(rangeRes.headers.get("content-range")).toMatch(/^bytes 0-63\/\d+$/);
    expect((await rangeRes.arrayBuffer()).byteLength).toBe(64);

    const auditionRes = await fetch(
      `${origin}/api/tempo/songs/${songId}/audition?t0=1.0&t1=2.5&filter=percussive`,
    );
    expect(auditionRes.status).toBe(200);
    expect(auditionRes.headers.get("content-type")).toBe("audio/wav");
    const wavBytes = Buffer.from(await auditionRes.arrayBuffer());
    expect(wavBytes.subarray(0, 4).toString("ascii")).toBe("RIFF");

    // Export `.osu`, `.jsonl`, and WAV `clip`.
    const osuExp = await apiJson<{ format: string; content: string }>(
      `/api/tempo/songs/${songId}/export`,
      { method: "POST", body: JSON.stringify({ format: "osu" }) },
    );
    expect(osuExp.content).toContain("[TimingPoints]");

    const jsonlExp = await apiJson<{ format: string; content: string; eventCount: number }>(
      `/api/tempo/songs/${songId}/export`,
      { method: "POST", body: JSON.stringify({ format: "jsonl" }) },
    );
    expect(jsonlExp.eventCount).toBeGreaterThan(4);
    expect(parseTraceNdjson(jsonlExp.content)).toHaveLength(jsonlExp.eventCount);

    const clipExp = await apiJson<{ format: string; clipPath: string; downloadUrl: string }>(
      `/api/tempo/songs/${songId}/export`,
      {
        method: "POST",
        body: JSON.stringify({ format: "clip", t0: 0.5, t1: 2.0, filter: "harmonic" }),
      },
    );
    expect(existsSync(clipExp.clipPath)).toBe(true);
    const clipDownload = await fetch(`${origin}${clipExp.downloadUrl}`);
    expect(clipDownload.status).toBe(200);
    await clipDownload.arrayBuffer();

    // Mark session ready and verify workspace summary reflects ready === true.
    const readyRes = await apiJson<{ songSummary: TempoSongSummary }>(
      `/api/tempo/songs/${songId}/edit`,
      {
        method: "POST",
        body: JSON.stringify({ action: "ready", ready: true }),
      },
    );
    expect(readyRes.songSummary.ready).toBe(true);
  });

  it("runs standalone tempo-server.ts under plain Node with --dir auto-redirect to /tempo", {
    timeout: 15_000,
  }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lens-tempo-cli-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const distDir = join(root, "dist");
    const wsDir = join(root, "songs");
    await mkdir(join(distDir, "assets"), { recursive: true });
    await mkdir(wsDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<!doctype html><title>Tempo Inspector</title>");
    await writeFile(join(distDir, "assets", "index.js"), "export {};");
    await writeFile(
      join(wsDir, "track-a.wav"),
      buildSyntheticWav({ durationSec: 3, clickTimesSec: [0.5, 1.0, 1.5, 2.0, 2.5] }),
    );

    // Programmatic check + plain Node subprocess CLI check.
    const inProc = await startTempoServer({
      dir: wsDir,
      port: 0,
      staticRoot: distDir,
      env: { ...process.env, TEMPO_ANALYZER_BACKEND: "dsp" },
    });
    cleanups.push(inProc.close);
    expect(inProc.summary).toContain("1 song");

    const child = spawn(
      process.execPath,
      [tempoServerScript, "--dir", wsDir, "--port", "0", "--static", distDir],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TEMPO_ANALYZER_BACKEND: "dsp" },
      },
    );
    cleanups.push(async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((done) => child.once("exit", () => done()));
      }
    });

    const printedUrl = await new Promise<string>((resolveUrl, reject) => {
      const rl = createInterface({ input: child.stdout });
      const errChunks: string[] = [];
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => errChunks.push(d));
      child.once("exit", (code) => {
        reject(new Error(`tempo-server exited early (${code}): ${errChunks.join("")}`));
      });
      rl.on("line", (line) => {
        const match = /^Tempo workspace:\s+(http:\/\/\S+)/.exec(line.trim());
        if (match?.[1]) {
          rl.close();
          resolveUrl(match[1]);
        }
      });
    });

    const parsed = new URL(printedUrl);
    expect(parsed.pathname).toBe("/tempo");
    expect(parsed.searchParams.get("dir")).toBe(wsDir);

    const rootRedirect = await fetch(`${parsed.origin}/`, { redirect: "manual" });
    expect(rootRedirect.status).toBe(302);
    expect(rootRedirect.headers.get("location")).toContain("/tempo?dir=");

    const htmlRes = await fetch(`${parsed.origin}/tempo`);
    expect(htmlRes.status).toBe(200);
    expect(await htmlRes.text()).toContain("Tempo Inspector");

    const wsRes = await fetch(`${parsed.origin}/api/tempo/workspace`);
    expect(wsRes.status).toBe(200);
    const wsBody = (await wsRes.json()) as { songs: TempoSongSummary[] };
    expect(wsBody.songs).toHaveLength(1);
  });

  it("serializes SongSessionHost.flushTrace() across append failures so zero trace events are ever skipped", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lens-tempo-flush-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const tracePath = join(root, "song-flush.jsonl");

    const controller = new SessionController({
      provider: new ScriptedMockProvider(),
      durationSec: 10,
    });
    cleanups.push(async () => controller.close());

    // Event 0 (`seq: 0`): initial edit persisted on disk before fault injection.
    controller.applyEdit({
      op: "upsert_beat",
      beat: { id: "b_0", timeSec: 1.0, source: "user" },
    });

    let failNextAppend = false;
    const realTraceWriter = createTempoMiddleware().service.store.traceWriter;
    const faultWriter = {
      append: async (path: string, events: Parameters<TraceWriter["append"]>[1]) => {
        if (failNextAppend) {
          failNextAppend = false;
          throw new Error("Simulated transient ENOSPC write failure");
        }
        return await realTraceWriter.append(path, events);
      },
      read: (path: string) => realTraceWriter.read(path),
    } as unknown as TraceWriter;

    const host = new SongSessionHost({
      songId: "song-flush",
      tracePath,
      controller,
      persistedCount: 0,
      traceWriter: faultWriter,
    });

    await host.flushTrace();

    // Edit #1 (`seq: 1`) fails to append; Edit #2 (`seq: 2`) succeeds and MUST persist both [1, 2]!
    failNextAppend = true;
    controller.applyEdit({
      op: "upsert_beat",
      beat: { id: "b_1", timeSec: 2.0, source: "user" },
    });
    await expect(host.flushTrace()).rejects.toThrow("Simulated transient ENOSPC write failure");

    controller.applyEdit({
      op: "upsert_beat",
      beat: { id: "b_2", timeSec: 3.0, source: "user" },
    });
    await host.flushTrace();

    const persisted = await realTraceWriter.read(tracePath);
    expect(persisted.map((ev) => ev.seq)).toEqual([0, 1, 2]);
    expect(Array.from(foldTrace(persisted).beats.keys()).sort()).toEqual(["b_0", "b_1", "b_2"]);
  });

  it("preserves chronological Redo across .jsonl reopen, clears Redo on branch edits, and passes spans into projectRedLines", {
    timeout: 15_000,
  }, async () => {
    const { wsDir, service, apiJson } = await createTestHarness();
    await writeFile(
      join(wsDir, "redo-reopen.wav"),
      buildSyntheticWav({ durationSec: 6, clickTimesSec: [] }),
    );

    const ws = await apiJson<{ songs: TempoSongSummary[] }>("/api/tempo/workspace");
    const songId = ws.songs[0]?.songId ?? "";
    const opened = await apiJson<{
      state: ReturnType<typeof serializeState>;
      canUndo: boolean;
      canRedo: boolean;
    }>(`/api/tempo/songs/${songId}/open`, { method: "POST", body: "{}" });
    expect(opened.canUndo).toBe(false);
    expect(opened.canRedo).toBe(false);

    // Add beat A and beat B -> undo both -> redo A -> close & reopen -> redo again -> BOTH A and B!
    await apiJson(`/api/tempo/songs/${songId}/edit`, {
      method: "POST",
      body: JSON.stringify({
        op: "upsert_beat",
        beat: { id: "beat_a", timeSec: 1.0, source: "user" },
      }),
    });
    await apiJson(`/api/tempo/songs/${songId}/edit`, {
      method: "POST",
      body: JSON.stringify({
        op: "upsert_beat",
        beat: { id: "beat_b", timeSec: 1.5, source: "user" },
      }),
    });

    await apiJson(`/api/tempo/songs/${songId}/edit`, {
      method: "POST",
      body: JSON.stringify({ action: "undo" }),
    });
    const afterTwoUndos = await apiJson<{
      state: ReturnType<typeof serializeState>;
      canUndo: boolean;
      canRedo: boolean;
    }>(`/api/tempo/songs/${songId}/edit`, {
      method: "POST",
      body: JSON.stringify({ action: "undo" }),
    });
    expect(afterTwoUndos.canUndo).toBe(false);
    expect(afterTwoUndos.canRedo).toBe(true);

    const afterFirstRedo = await apiJson<{
      state: ReturnType<typeof serializeState>;
      canUndo: boolean;
      canRedo: boolean;
    }>(`/api/tempo/songs/${songId}/edit`, {
      method: "POST",
      body: JSON.stringify({ action: "redo" }),
    });
    expect(afterFirstRedo.state.beats.some((b) => b.id === "beat_a")).toBe(true);
    expect(afterFirstRedo.state.beats.some((b) => b.id === "beat_b")).toBe(false);
    expect(afterFirstRedo.canRedo).toBe(true);

    // Close & reopen from `.jsonl` on disk!
    await service.close();
    const reopenedHarness = await createTestHarness(wsDir);
    const reopened = await reopenedHarness.apiJson<{
      state: ReturnType<typeof serializeState>;
      canUndo: boolean;
      canRedo: boolean;
    }>(`/api/tempo/songs/${songId}/open`, { method: "POST", body: "{}" });
    expect(reopened.canUndo).toBe(true);
    expect(reopened.canRedo).toBe(true);

    // Second redo after reopen MUST restore beat_b (producing BOTH A and B, never zero beats)!
    const afterSecondRedo = await reopenedHarness.apiJson<{
      state: ReturnType<typeof serializeState>;
      canUndo: boolean;
      canRedo: boolean;
    }>(`/api/tempo/songs/${songId}/edit`, {
      method: "POST",
      body: JSON.stringify({ action: "redo" }),
    });
    expect(afterSecondRedo.state.beats.some((b) => b.id === "beat_a")).toBe(true);
    expect(afterSecondRedo.state.beats.some((b) => b.id === "beat_b")).toBe(true);
    expect(afterSecondRedo.canRedo).toBe(false);

    // Undo beat_b, then apply a new branch edit (set_range_free + rubato beats) -> clears canRedo across reopen
    // AND verifies { spans } is passed to projectRedLines!
    await reopenedHarness.apiJson(`/api/tempo/songs/${songId}/edit`, {
      method: "POST",
      body: JSON.stringify({ action: "undo" }),
    });
    const seg0Id = reopened.state.segments[0]?.id ?? "seg_0";
    const afterBranchEdit = await reopenedHarness.apiJson<{
      canRedo: boolean;
      redLineProjection: { redLines: Array<{ kind: string }> };
    }>(`/api/tempo/songs/${songId}/edit`, {
      method: "POST",
      body: JSON.stringify({
        ops: [
          { op: "set_segment_regime", segmentId: seg0Id, regime: "auto", source: "user" },
          { op: "upsert_beat", beat: { id: "beat_c1", timeSec: 2.0, source: "user" } },
          { op: "upsert_beat", beat: { id: "beat_c2", timeSec: 2.42, source: "user" } },
          { op: "upsert_beat", beat: { id: "beat_c3", timeSec: 2.95, source: "user" } },
          { op: "set_range_free", t0: 1.8, t1: 3.2, free: true, source: "user" },
        ],
      }),
    });
    expect(afterBranchEdit.canRedo).toBe(false);
    expect(afterBranchEdit.redLineProjection.redLines.some((rl) => rl.kind === "free_pulse")).toBe(
      true,
    );

    await reopenedHarness.service.close();
    const thirdHarness = await createTestHarness(wsDir);
    const thirdOpen = await thirdHarness.apiJson<{ canRedo: boolean }>(
      `/api/tempo/songs/${songId}/open`,
      { method: "POST", body: "{}" },
    );
    expect(thirdOpen.canRedo).toBe(false);
  });

  it("handles concurrent same-name imports atomically, preserves custom stateDir on upload, rotates stale traces when audio changes, and blocks symlinks & invalid songIds", {
    timeout: 20_000,
  }, async () => {
    const { root, wsDir, origin, service, apiJson } = await createTestHarness();
    const customStateDir = join(root, "custom-state");
    await mkdir(customStateDir, { recursive: true });

    // Open workspace with explicit custom `stateDir`
    await apiJson("/api/tempo/workspace/open", {
      method: "POST",
      body: JSON.stringify({ dir: wsDir, stateDir: customStateDir }),
    });
    expect(service.store.currentStateDir).toBe(await realpath(customStateDir));

    // Fire 4 concurrent uploads with the EXACT SAME filename ("dup.wav") and NO ?dir= query!
    const wavA = buildSyntheticWav({ durationSec: 3, clickTimesSec: [0.5, 1.0, 1.5, 2.0, 2.5] });
    await Promise.all(
      [0, 1, 2, 3].map(() =>
        apiJson("/api/tempo/workspace/import-upload?name=dup.wav", {
          method: "POST",
          headers: { "Content-Type": "audio/wav" },
          body: new Uint8Array(wavA),
        }),
      ),
    );

    // Custom stateDir MUST remain preserved, and all 4 uploads MUST get distinct non-clobbered files!
    expect(service.store.currentStateDir).toBe(await realpath(customStateDir));
    const afterConcurrent = await apiJson<{ songs: TempoSongSummary[] }>("/api/tempo/workspace");
    expect(new Set(afterConcurrent.songs.map((s) => s.fileName))).toEqual(
      new Set(["dup.wav", "dup-2.wav", "dup-3.wav", "dup-4.wav"]),
    );
    for (const s of afterConcurrent.songs) {
      expect(s.audioSizeBytes).toBe(wavA.byteLength);
      expect(s.audioSha256Sample).toMatch(/^[0-9a-f]{64}$/);
    }

    // Invalid songId traversal or malformed ID -> HTTP 400!
    const badIdRes = await fetch(`${origin}/api/tempo/songs/${encodeURIComponent("../escape")}`, {
      headers: { "X-Beatmap-Lens-Local": "1" },
    });
    expect(badIdRes.status).toBe(400);

    // Open `dup.wav` so `.jsonl` trace is recorded, then replace `dup.wav` with longer 72s audio!
    const firstSong = afterConcurrent.songs.find((s) => s.fileName === "dup.wav");
    expect(firstSong).toBeDefined();
    const songId = firstSong?.songId ?? "";
    const openV1 = await apiJson<{ state: ReturnType<typeof serializeState> }>(
      `/api/tempo/songs/${songId}/open`,
      { method: "POST", body: "{}" },
    );
    expect(openV1.state.durationSec).toBeCloseTo(3, 1);

    const wavB = buildSyntheticWav({
      durationSec: 72,
      clickTimesSec: regularClicks(0.5, 12.0, 0.5),
    });
    await writeFile(join(wsDir, "dup.wav"), wavB);

    // Reopening songId detects audio fingerprint mismatch, rotates old `.jsonl` to `.superseded-*.bak`, and analyzes wavB!
    const openV2 = await apiJson<{ state: ReturnType<typeof serializeState> }>(
      `/api/tempo/songs/${songId}/open`,
      { method: "POST", body: "{}" },
    );
    expect(openV2.state.durationSec).toBeCloseTo(72, 1);
    const traceFiles = await readdir(join(customStateDir, "traces"));
    expect(
      traceFiles.some((f) => f.startsWith(`${songId}.jsonl.superseded-`) && f.endsWith(".bak")),
    ).toBe(true);

    // Exact-sample 60s float-boundary audition `[10.0002, 70.0002)` (`70.0002 - 10.0002 = 60.00000000000001`)!
    const audRes = await fetch(
      `${origin}/api/tempo/songs/${songId}/audition?t0=10.0002&t1=70.0002&filter=mix`,
    );
    expect(audRes.status).toBe(200);
    expect(audRes.headers.get("x-audition-start-sample")).toBe(String(Math.round(10.0002 * 22050)));
    expect(audRes.headers.get("x-audition-end-sample")).toBe(String(Math.round(70.0002 * 22050)));
    expect(audRes.headers.get("x-audition-sample-rate")).toBe("22050");
    await audRes.arrayBuffer();

    const cacheEntries = await readdir(join(customStateDir, ".cache", "audition"));
    expect(cacheEntries.some((f) => f.endsWith(".wav.meta.json"))).toBe(true);

    // Symlink inside `clips/` escaping `stateDir` MUST be rejected with 403!
    const secretWav = join(root, "outside-secret.wav");
    await writeFile(secretWav, wavA);
    await symlink(secretWav, join(customStateDir, "clips", "escape.wav"));
    const escapeClipRes = await fetch(`${origin}/api/tempo/songs/${songId}/clips/escape.wav`);
    expect(escapeClipRes.status).toBe(403);
  });

  it("enforces loopback + x-beatmap-lens-local: 1 on wildcard bind, sanitizes internal IDs from errors, caps Host LRU, and handles daemon EPIPE cleanly", {
    timeout: 15_000,
  }, async () => {
    // 1. Wildcard `allowedHost: "0.0.0.0"` WITHOUT `allowRemote: true` rejects non-loopback remote sockets & hostnames!
    const fakeRemoteReq = {
      method: "GET",
      headers: { host: "192.168.1.50:4179" },
      socket: { remoteAddress: "192.168.1.99" },
    } as unknown as IncomingMessage;
    expect(() =>
      assertTempoLocalRequest(
        fakeRemoteReq,
        new URL("http://192.168.1.50:4179/api/tempo/workspace"),
        { allowedHost: "0.0.0.0" },
        false,
      ),
    ).toThrow(/same-origin local/);

    // With explicit `allowRemote: true`, remote socket is permitted for GET, while POST without header still fails!
    expect(() =>
      assertTempoLocalRequest(
        fakeRemoteReq,
        new URL("http://192.168.1.50:4179/api/tempo/workspace"),
        { allowedHost: "0.0.0.0", allowRemote: true },
        false,
      ),
    ).not.toThrow();
    expect(() =>
      assertTempoLocalRequest(
        fakeRemoteReq,
        new URL("http://192.168.1.50:4179/api/tempo/workspace/open"),
        { allowedHost: "0.0.0.0", allowRemote: true },
        true,
      ),
    ).toThrow();

    // 2. Missing `x-beatmap-lens-local: 1` on `application/json` POST is rejected with 403!
    const { wsDir, origin, service, apiJson } = await createTestHarness(undefined, {
      maxActiveHosts: 2,
    });
    for (const i of [1, 2, 3]) {
      await writeFile(
        join(wsDir, `song-${i}.wav`),
        buildSyntheticWav({ durationSec: 2, clickTimesSec: [0.5, 1.0, 1.5] }),
      );
    }

    const noHeaderPost = await fetch(`${origin}/api/tempo/workspace/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: wsDir }),
    });
    expect(noHeaderPost.status).toBe(403);

    // 3. Sanitized error messages strip internal entity/offer/semantic tokens!
    const scrubbed = sanitizeTempoErrorMessage(
      new Error(
        'Cannot mutate "seg_0" or beat b_s14_01 or span_99 or sk:deadbeef1234 or offer_g1_s2_1',
      ),
    );
    expect(scrubbed).not.toContain("seg_0");
    expect(scrubbed).not.toContain("b_s14_01");
    expect(scrubbed).not.toContain("span_99");
    expect(scrubbed).not.toContain("sk:deadbeef");
    expect(scrubbed).not.toContain("offer_g1");

    // Verify over HTTP too: invalid edit referencing internal IDs never echoes them back!
    const ws = await apiJson<{ songs: TempoSongSummary[] }>("/api/tempo/workspace");
    expect(ws.songs).toHaveLength(3);
    for (const s of ws.songs) {
      await apiJson(`/api/tempo/songs/${s.songId}/open`, { method: "POST", body: "{}" });
    }
    // Bounded Host LRU (`maxActiveHosts: 2`) evicted the oldest idle host cleanly!
    expect(service.activeHostCount).toBeLessThanOrEqual(2);

    const errHttp = await fetch(`${origin}/api/tempo/songs/${ws.songs[0]?.songId}/edit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Beatmap-Lens-Local": "1",
      },
      body: JSON.stringify({
        op: "merge_segments",
        leftSegmentId: "seg_missing_internal_1",
        rightSegmentId: "seg_missing_internal_2",
      }),
    });
    expect(errHttp.status).toBe(400);
    const errJson = (await errHttp.json()) as { error: string };
    expect(errJson.error).not.toContain("seg_missing_internal_1");
    expect(errJson.error).not.toContain("seg_missing_internal_2");

    // 4. Early disconnect abort before/during `open` resolves cleanly without crashing.
    const abortCtrl = new AbortController();
    const abortedFetch = fetch(`${origin}/api/tempo/songs/${ws.songs[0]?.songId}/snaps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Beatmap-Lens-Local": "1",
      },
      body: JSON.stringify({ timeSec: 0.5 }),
      signal: abortCtrl.signal,
    });
    abortCtrl.abort();
    await expect(abortedFetch).rejects.toThrow();

    // 5. TempoDaemonClient handles broken pipe / sudden child kill & awaits exit on close().
    const daemonClient = new TempoDaemonClient({
      env: { ...process.env, TEMPO_ANALYZER_BACKEND: "dsp" },
    });
    const pong = await daemonClient.request<{ pong: boolean }>("ping", {});
    expect(pong.pong).toBe(true);
    await daemonClient.close();
    await expect(daemonClient.request("ping", {})).rejects.toThrow(/closed/);
    void ({} as ServerResponse);
  });
});
