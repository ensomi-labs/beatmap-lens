import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { foldTrace, parseTraceNdjson, serializeState } from "ensomi";
import { afterEach, describe, expect, it } from "vitest";
import { createTempoMiddleware, type TempoSongSummary } from "./index.ts";
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

async function createTestHarness(workspaceDir?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lens-tempo-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));

  const wsDir = workspaceDir ?? join(root, "workspace");
  await mkdir(wsDir, { recursive: true });

  const middleware = createTempoMiddleware({
    workspaceDir: wsDir,
    env: {
      ...process.env,
      TEMPO_ANALYZER_BACKEND: "dsp",
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
});
