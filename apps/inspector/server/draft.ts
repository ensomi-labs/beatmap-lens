/**
 * The Draft workspace's local service, under `/api/draft`:
 *
 * - `analyze`: raw BeatThis beats and experimental onset-flux sounds of a local audio file
 *   (`draft_analyze.py`), as contract entities, with a fresh trace path.
 * - `pcm`: the file decoded by ffmpeg as interleaved float32 at its own rate, for playback.
 * - `demo`: writes the built-in synthetic demo track as WAV and returns its path.
 * - `recompute`: RuleMockRecompute offers, cancelled when a newer generation arrives or the
 *   page drops the request.
 * - `audition-view`: a listening view (mix, HPSS part or band) of a span as WAV, cached; for the
 *   ear only, it never feeds a timestamp.
 * - `export-clip`: a click-overlay clip rendered by `harness/audio-harness.py` into
 *   `.local/draft-clips/`, for a listener (or Gemini) to hear by path.
 * - `trace/append` and `GET trace`: the append-only `.jsonl` trace, one serialized writer per file.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Beat,
  type ProviderInfo,
  parseTraceNdjson,
  type SoundAnchor,
  serializeTraceNdjson,
  type TraceEvent,
} from "../src/draft/ensomi-contract.ts";
import {
  type RecomputeOutcome,
  type RecomputeRequest,
  ruleMockProvider,
  ruleMockRecompute,
} from "../src/draft/recompute.ts";
import { demoPcm, demoSampleRate, encodeWav } from "../src/draft/synthetic.ts";
import {
  assertLocalRequest,
  fullPath,
  localService,
  localServicePlugin,
  readBody,
  sendJson,
} from "./local-service.ts";

const prefix = "/api/draft";
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const helper = fileURLToPath(new URL("./draft_analyze.py", import.meta.url));
const harness = join(repoRoot, "harness", "audio-harness.py");

export const audioExtensions = [".wav", ".mp3", ".ogg", ".flac", ".m4a"];
export const auditionViews = ["mix", "percussive", "harmonic", "low", "mid", "high"] as const;
export type AuditionView = (typeof auditionViews)[number];
/** The longest span an audition view renders. */
export const maxAuditionS = 30;

export interface DraftServiceOptions {
  /** Where traces, clips and the demo track go; the repository's `.local/` by default. */
  localDir?: string;
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PythonCommand {
  command: string;
  args: string[];
  label: string;
}

/**
 * The Python that runs the helper: `ENSOMI_PYTHON`; else the ensomi-model virtualenv (in
 * `ENSOMI_MODEL_DIR`, default `~/ensomi/ensomi-model`), which has BeatThis; else this
 * repository's `uv run --locked python`, where BeatThis is not installed and beats come from a
 * labelled rule.
 */
export function pythonCommand(env: NodeJS.ProcessEnv = process.env): PythonCommand {
  if (env.ENSOMI_PYTHON)
    return { command: env.ENSOMI_PYTHON, args: [], label: `ENSOMI_PYTHON ${env.ENSOMI_PYTHON}` };
  const venv = join(
    env.ENSOMI_MODEL_DIR ?? join(homedir(), "ensomi", "ensomi-model"),
    ".venv",
    "bin",
    "python",
  );
  if (existsSync(venv)) return { command: venv, args: [], label: `ensomi-model ${venv}` };
  return {
    command: "uv",
    args: ["run", "--locked", "--project", repoRoot, "python"],
    label: "uv run --locked python",
  };
}

export function runProcess(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal ? { signal } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr });
      else
        reject(
          new Error(
            `${basename(command)} exited with ${code}: ${stderr.trim().split("\n").at(-1)}`,
          ),
        );
    });
  });
}

/** Appends to `.jsonl` files one write at a time per file, in call order. */
export class TraceWriter {
  private readonly tails = new Map<string, Promise<void>>();

  append(path: string, events: readonly TraceEvent[]): Promise<void> {
    const text = serializeTraceNdjson([...events]);
    if (!text) return Promise.resolve();
    const previous = this.tails.get(path) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, text);
      });
    this.tails.set(path, next);
    next.then(
      () => this.tails.get(path) === next && this.tails.delete(path),
      () => this.tails.get(path) === next && this.tails.delete(path),
    );
    return next;
  }
}

export async function readTrace(path: string): Promise<TraceEvent[]> {
  const text = await readFile(path, "utf8");
  return parseTraceNdjson(text, { discardTruncatedTail: true });
}

/**
 * One recompute in flight per page: a newer generation aborts the older one, whose answer is
 * then `superseded`; an older generation arriving late is `stale` and never runs.
 */
export class RecomputeQueue {
  private readonly inflight = new Map<
    string,
    { generation: number; controller: AbortController }
  >();
  private readonly compute: typeof ruleMockRecompute;

  constructor(compute = ruleMockRecompute) {
    this.compute = compute;
  }

  async run(
    client: string,
    request: RecomputeRequest,
    dropped?: AbortSignal,
  ): Promise<RecomputeOutcome> {
    const generation = request.generation;
    const previous = this.inflight.get(client);
    if (previous && previous.generation >= generation) return { status: "stale", generation };
    previous?.controller.abort();
    const entry = { generation, controller: new AbortController() };
    this.inflight.set(client, entry);
    dropped?.addEventListener("abort", () => entry.controller.abort(), { once: true });
    try {
      const offers = await this.compute(request, entry.controller.signal);
      if (this.inflight.get(client) !== entry) return { status: "superseded", generation };
      return { status: "ok", generation, providerKind: "rule", provider: ruleMockProvider, offers };
    } catch (error) {
      if ((error as Error).name !== "AbortError") throw error;
      return {
        status: this.inflight.get(client) === entry ? "cancelled" : "superseded",
        generation,
      };
    } finally {
      if (this.inflight.get(client) === entry) this.inflight.delete(client);
    }
  }
}

async function audioFile(input: unknown): Promise<string> {
  if (typeof input !== "string") throw new Error("Give the audio file's full path.");
  const path = fullPath(input);
  if (!audioExtensions.includes(extname(path).toLowerCase()))
    throw new Error(`Choose an audio file (${audioExtensions.join(", ")}).`);
  if (!(await stat(path)).isFile()) throw new Error(`Not a file: ${path}`);
  return path;
}

function seconds(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a time in seconds.`);
  return value;
}

const stamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
const stemOf = (path: string) => basename(path, extname(path)).replace(/[^\w.-]+/g, "_");

interface Analysis {
  audio: { path: string; durationS: number; sampleRate: number; channels: number; codec: string };
  beats: {
    provider: ProviderInfo & { checkpoint?: string };
    items: { t: number; conf: number; downbeatP?: number }[];
  };
  sounds: { provider: ProviderInfo; items: { t: number; emphasis: number; conf: number }[] };
  seconds: Record<string, number>;
}

export function draftHandler(options: DraftServiceOptions = {}) {
  const python = pythonCommand(options.env);
  const localDir = options.localDir ?? join(repoRoot, ".local");
  const cacheDir = options.cacheDir ?? join(tmpdir(), "beatmap-lens-draft-audition");
  const writer = new TraceWriter();
  const recomputes = new RecomputeQueue();
  const runPython = (args: string[], signal?: AbortSignal) =>
    runProcess(python.command, [...python.args, ...args], signal);

  async function analyze(body: { audioPath?: unknown }) {
    const path = await audioFile(body.audioPath);
    const { stdout } = await runPython([helper, "analyze", path]);
    const result = JSON.parse(stdout.toString("utf8")) as Analysis;
    const beatSource = result.beats.provider.kind === "model" ? "model" : "rule";
    const beats: Beat[] = result.beats.items.map((item, index) => ({
      id: `m${index}`,
      t: item.t,
      source: beatSource,
      version: 1,
      conf: item.conf,
      ...(item.downbeatP !== undefined ? { meta: { downbeatP: item.downbeatP } } : {}),
    }));
    const sounds: SoundAnchor[] = result.sounds.items.map((item, index) => ({
      id: `o${index}`,
      t: item.t,
      emphasis: item.emphasis,
      conf: item.conf,
      source: "rule",
      version: 1,
      experimental: true,
    }));
    return {
      audio: { ...result.audio, title: basename(path) },
      beats,
      sounds,
      boundaries: [],
      providers: { beats: result.beats.provider, sounds: result.sounds.provider },
      tracePath: join(localDir, "draft-traces", `${stemOf(path)}-${stamp()}.jsonl`),
      runtime: python.label,
      seconds: result.seconds,
    };
  }

  async function auditionView(body: Record<string, unknown>): Promise<string> {
    const path = await audioFile(body.audioPath);
    const view = body.view as AuditionView;
    if (!auditionViews.includes(view))
      throw new Error(`Choose a view: ${auditionViews.join(", ")}.`);
    const start = seconds(body.startSec, "startSec");
    const end = seconds(body.endSec, "endSec");
    if (end <= start || end - start > maxAuditionS)
      throw new Error(`Choose a span of at most ${maxAuditionS} s.`);
    const info = await stat(path);
    const key = createHash("sha1")
      .update([path, info.mtimeMs, info.size, start.toFixed(4), end.toFixed(4), view].join("\0"))
      .digest("hex");
    const out = join(cacheDir, `${key}.wav`);
    if (!existsSync(out)) {
      await mkdir(cacheDir, { recursive: true });
      const partial = `${out}.${process.pid}.${Date.now()}.part.wav`;
      await runPython([
        helper,
        "audition",
        path,
        "--start",
        String(start),
        "--end",
        String(end),
        "--view",
        view,
        "--out",
        partial,
      ]);
      await rename(partial, out);
    }
    return out;
  }

  async function exportClip(body: Record<string, unknown>) {
    const path = await audioFile(body.audioPath);
    const start = seconds(body.startSec, "startSec");
    const end = seconds(body.endSec, "endSec");
    if (end <= start) throw new Error("Choose a span to export.");
    const beats = Array.isArray(body.beats)
      ? body.beats.filter((t): t is number => typeof t === "number" && t >= start && t <= end)
      : [];
    const format = body.format === "mp3" ? "mp3" : "wav";
    const folder = join(localDir, "draft-clips");
    await mkdir(folder, { recursive: true });
    const name = `${stemOf(path)}-${start.toFixed(3)}-${end.toFixed(3)}-${stamp()}`;
    const timingPath = join(folder, `${name}.beats.json`);
    const outputPath = join(folder, `${name}.${format}`);
    // Beats only: no downbeats are given, so the harness infers no bar.
    await writeFile(timingPath, JSON.stringify({ beats }));
    const { stdout } = await runPython([
      harness,
      "audition",
      path,
      "--timing",
      timingPath,
      "--format",
      "json",
      "--out",
      outputPath,
      "--start",
      String(start),
      "--end",
      String(end),
    ]);
    return { ...JSON.parse(stdout.toString("utf8")), outputPath, timingPath };
  }

  async function writeDemo() {
    const audioPath = join(localDir, "draft-demo", "synthetic-demo.wav");
    if (!existsSync(audioPath)) {
      await mkdir(dirname(audioPath), { recursive: true });
      await writeFile(audioPath, encodeWav([demoPcm()], demoSampleRate));
    }
    return {
      audioPath,
      tracePath: join(localDir, "draft-traces", `synthetic-demo-${stamp()}.jsonl`),
    };
  }

  function tracePath(input: unknown): string {
    if (typeof input !== "string") throw new Error("Give the trace's full path.");
    const path = fullPath(input);
    if (extname(path) !== ".jsonl") throw new Error("A trace is a .jsonl file.");
    return path;
  }

  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    assertLocalRequest(request, url);
    const operation = url.pathname.slice(prefix.length + 1);
    if (request.method === "GET" && operation === "trace") {
      sendJson(response, { events: await readTrace(tracePath(url.searchParams.get("path"))) });
      return;
    }
    if (request.method !== "POST") throw new Error("Use POST for draft operations.");
    const body = JSON.parse((await readBody(request)).toString("utf8") || "{}");
    if (operation === "analyze") sendJson(response, await analyze(body));
    else if (operation === "demo") sendJson(response, await writeDemo());
    else if (operation === "pcm") {
      const path = await audioFile(body.audioPath);
      const { stdout } = await runProcess("ffmpeg", [
        "-v",
        "error",
        "-nostdin",
        "-i",
        path,
        "-map",
        "0:a:0",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-",
      ]);
      response.setHeader("Content-Type", "application/octet-stream");
      response.end(stdout);
    } else if (operation === "recompute") {
      const dropped = new AbortController();
      response.on("close", () => {
        if (!response.writableFinished) dropped.abort();
      });
      sendJson(
        response,
        await recomputes.run(
          String(body.client ?? "page"),
          body.request as RecomputeRequest,
          dropped.signal,
        ),
      );
    } else if (operation === "audition-view") {
      const out = await auditionView(body);
      response.setHeader("Content-Type", "audio/wav");
      response.setHeader("X-Audition-Only", "listening view; timestamps stay on the original mix");
      await new Promise<void>((resolve, reject) => {
        createReadStream(out).on("error", reject).pipe(response).on("finish", resolve);
      });
    } else if (operation === "export-clip") sendJson(response, await exportClip(body));
    else if (operation === "trace/append") {
      const path = tracePath(body.tracePath);
      if (!Array.isArray(body.events)) throw new Error("Give the events to append.");
      await writer.append(path, body.events);
      sendJson(response, { tracePath: path, appended: body.events.length });
    } else throw new Error("Unknown draft operation.");
  };
}

export const draftPlugin = () =>
  localServicePlugin("inspector-draft", prefix, () => draftHandler());

export const createDraftMiddleware = (options?: DraftServiceOptions) =>
  localService(prefix, draftHandler(options));
