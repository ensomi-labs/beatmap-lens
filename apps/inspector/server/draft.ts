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
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  assertTraceEventEnvelope,
  type Beat,
  canonicalJson,
  type ProviderInfo,
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
  if (signal?.aborted) {
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 2000);
      killTimer.unref?.();
      if (!settled) {
        settled = true;
        cleanup();
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
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

function assertNotTimingFile(path: string) {
  const lower = basename(path).toLowerCase();
  if (lower.endsWith(".timing.marks.jsonl") || lower.endsWith(".timing.notes.jsonl")) {
    throw new Error("Refusing to open or write a Timing marks/notes file as a Draft trace.");
  }
}

interface InspectedTrace {
  events: TraceEvent[];
  needsLeadingNewline: boolean;
  truncateBytes?: number;
}

/**
 * Validates existing NDJSON content strictly as `ensomi` v0 Draft trace events.
 * Complete JSON records that do not match the Draft envelope (e.g. Timing marks) are ALWAYS
 * rejected; an unterminated, syntactically incomplete final line may be recovered/truncated.
 */
function inspectTraceContent(raw: string, allowTruncatedTail: boolean): InspectedTrace {
  if (raw.length === 0) return { events: [], needsLeadingNewline: false };
  const hasTrailingNewline = raw.endsWith("\n");
  const lines = raw.split(/\r?\n/);
  if (hasTrailingNewline) lines.pop();
  if (lines.length === 0) return { events: [], needsLeadingNewline: false };

  const events: TraceEvent[] = [];
  const seenIds = new Set<string>();
  let prevSeq = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const isLast = i === lines.length - 1;
    const lineNum = i + 1;
    if (line.trim().length === 0) {
      throw new Error(`Invalid Draft trace file: empty line at line ${lineNum}.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (isLast && !hasTrailingNewline && allowTruncatedTail) {
        const lastNewline = raw.lastIndexOf("\n");
        const truncateBytes =
          lastNewline >= 0 ? Buffer.byteLength(raw.slice(0, lastNewline + 1), "utf8") : 0;
        return { events, needsLeadingNewline: false, truncateBytes };
      }
      throw new Error(
        `Invalid Draft trace file at line ${lineNum}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let event: TraceEvent;
    try {
      event = assertTraceEventEnvelope(parsed);
    } catch (error) {
      throw new Error(
        `Not a valid Draft trace (.jsonl) file at line ${lineNum}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (prevSeq >= 0 && event.seq <= prevSeq) {
      throw new Error(
        `Invalid Draft trace file at line ${lineNum}: non-monotonic seq ${event.seq} after ${prevSeq}.`,
      );
    }
    if (seenIds.has(event.id)) {
      throw new Error(
        `Invalid Draft trace file at line ${lineNum}: duplicate event id "${event.id}".`,
      );
    }
    seenIds.add(event.id);
    prevSeq = event.seq;
    events.push(event);
  }

  return { events, needsLeadingNewline: events.length > 0 && !hasTrailingNewline };
}

function validateIncomingBatch(events: readonly unknown[]): TraceEvent[] {
  const validated: TraceEvent[] = [];
  const seenIds = new Set<string>();
  let prevSeq = -1;
  for (const raw of events) {
    const event = assertTraceEventEnvelope(raw);
    if (prevSeq >= 0 && event.seq <= prevSeq) {
      throw new Error(
        `Incoming trace events must have strictly increasing seq (got ${event.seq} after ${prevSeq}).`,
      );
    }
    if (seenIds.has(event.id)) {
      throw new Error(`Incoming trace events contain duplicate id "${event.id}".`);
    }
    seenIds.add(event.id);
    prevSeq = event.seq;
    validated.push(event);
  }
  return validated;
}

export interface TraceAppendResult {
  appended: number;
  skipped: number;
}

/**
 * Appends to `.jsonl` Draft trace files one write at a time per file, in call order.
 * Validates existing and incoming records as `ensomi` v0 Draft envelopes, preserves newline
 * framing (including torn-tail recovery), rejects conflicting writers, and treats identical
 * `(seq, id)` retries as idempotent no-ops.
 */
export class TraceWriter {
  private readonly tails = new Map<string, Promise<unknown>>();

  append(path: string, events: readonly TraceEvent[]): Promise<TraceAppendResult> {
    let incoming: TraceEvent[];
    try {
      assertNotTimingFile(path);
      incoming = validateIncomingBatch(events);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!incoming.length) return Promise.resolve({ appended: 0, skipped: 0 });
    const previous = this.tails.get(path) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async (): Promise<TraceAppendResult> => {
        let raw = "";
        try {
          raw = await readFile(path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const inspected = inspectTraceContent(raw, true);
        const bySeq = new Map<number, TraceEvent>();
        const byId = new Map<string, TraceEvent>();
        let lastSeq = -1;
        for (const ev of inspected.events) {
          bySeq.set(ev.seq, ev);
          byId.set(ev.id, ev);
          lastSeq = ev.seq;
        }

        const toAppend: TraceEvent[] = [];
        let skipped = 0;
        for (const ev of incoming) {
          const existingBySeq = bySeq.get(ev.seq);
          const existingById = byId.get(ev.id);
          if (existingBySeq && existingBySeq.id === ev.id) {
            if (canonicalJson(existingBySeq) !== canonicalJson(ev)) {
              throw new Error(
                `Conflicting trace event for seq ${ev.seq} / id "${ev.id}" with different content.`,
              );
            }
            skipped += 1;
            continue;
          }
          if (existingBySeq || existingById) {
            throw new Error(
              `Conflicting trace writer: seq ${ev.seq} / id "${ev.id}" conflicts with existing trace.`,
            );
          }
          if (ev.seq <= lastSeq) {
            throw new Error(
              `Conflicting trace writer: seq ${ev.seq} is not greater than persisted lastSeq ${lastSeq}.`,
            );
          }
          bySeq.set(ev.seq, ev);
          byId.set(ev.id, ev);
          lastSeq = ev.seq;
          toAppend.push(ev);
        }

        if (inspected.truncateBytes !== undefined) {
          await truncate(path, inspected.truncateBytes);
        }
        if (!toAppend.length) return { appended: 0, skipped };

        await mkdir(dirname(path), { recursive: true });
        const serialized = serializeTraceNdjson(toAppend);
        const payload = inspected.needsLeadingNewline ? `\n${serialized}` : serialized;
        await appendFile(path, payload);
        return { appended: toAppend.length, skipped };
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
  assertNotTimingFile(path);
  const text = await readFile(path, "utf8");
  return inspectTraceContent(text, true).events;
}

/**
 * One recompute in flight per page: a newer generation aborts the older one, whose answer is
 * then `superseded`; an older generation arriving late is `stale` and never runs, even after
 * the newer generation has completed (via a bounded per-client high-water mark).
 */
export class RecomputeQueue {
  private readonly inflight = new Map<
    string,
    { generation: number; controller: AbortController }
  >();
  private readonly highWater = new Map<string, number>();
  private readonly maxClients: number;
  private readonly compute: typeof ruleMockRecompute;

  constructor(compute = ruleMockRecompute, maxClients = 128) {
    this.compute = compute;
    this.maxClients = maxClients;
  }

  private recordHighWater(client: string, generation: number) {
    const existing = this.highWater.get(client);
    if (existing !== undefined && existing >= generation) return;
    this.highWater.delete(client);
    this.highWater.set(client, generation);
    while (this.highWater.size > this.maxClients) {
      const oldest = this.highWater.keys().next().value;
      if (oldest === undefined) break;
      this.highWater.delete(oldest);
    }
  }

  async run(
    client: string,
    request: RecomputeRequest,
    dropped?: AbortSignal,
  ): Promise<RecomputeOutcome> {
    const generation = request.generation;
    const highest = this.highWater.get(client);
    const previous = this.inflight.get(client);
    if (
      (highest !== undefined && generation < highest) ||
      (previous && previous.generation >= generation)
    ) {
      return { status: "stale", generation };
    }
    this.recordHighWater(client, generation);
    previous?.controller.abort();
    const entry = { generation, controller: new AbortController() };
    this.inflight.set(client, entry);
    const onDropped = () => entry.controller.abort();
    if (dropped?.aborted) entry.controller.abort();
    else dropped?.addEventListener("abort", onDropped, { once: true });
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
      dropped?.removeEventListener("abort", onDropped);
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

const stampMs = () => new Date().toISOString().replace(/[-:.]/g, "");
const stemOf = (path: string) => basename(path, extname(path)).replace(/[^\w.-]+/g, "_");

async function reserveTraceFile(localDir: string, stem: string): Promise<string> {
  const folder = join(localDir, "draft-traces");
  await mkdir(folder, { recursive: true });
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = join(folder, `${stem}-${stampMs()}-${randomUUID().slice(0, 8)}.jsonl`);
    try {
      const handle = await open(candidate, "wx");
      await handle.close();
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Could not reserve a unique Draft trace filename.");
}

function disconnectController(
  request: IncomingMessage,
  response: ServerResponse,
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const onDisconnect = () => {
    if (!response.writableFinished) controller.abort();
  };
  request.on("aborted", onDisconnect);
  response.on("close", onDisconnect);
  return {
    controller,
    cleanup: () => {
      request.off("aborted", onDisconnect);
      response.off("close", onDisconnect);
    },
  };
}

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
  const registeredTraces = new Set<string>();
  const runPython = (args: string[], signal?: AbortSignal) =>
    runProcess(python.command, [...python.args, ...args], signal);

  async function analyze(body: { audioPath?: unknown }, signal?: AbortSignal) {
    const path = await audioFile(body.audioPath);
    const { stdout } = await runPython([helper, "analyze", path], signal);
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
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
    const reserved = await reserveTraceFile(localDir, stemOf(path));
    registeredTraces.add(reserved);
    return {
      audio: { ...result.audio, title: basename(path) },
      beats,
      sounds,
      boundaries: [],
      providers: { beats: result.beats.provider, sounds: result.sounds.provider },
      tracePath: reserved,
      runtime: python.label,
      seconds: result.seconds,
    };
  }

  async function auditionView(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
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
      const partial = `${out}.${process.pid}.${randomUUID().slice(0, 8)}.part.wav`;
      try {
        await runPython(
          [
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
          ],
          signal,
        );
        await rename(partial, out);
      } catch (error) {
        await rm(partial, { force: true }).catch(() => {});
        throw error;
      }
    }
    return out;
  }

  async function exportClip(body: Record<string, unknown>, signal?: AbortSignal) {
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
    const name = `${stemOf(path)}-${start.toFixed(3)}-${end.toFixed(3)}-${stampMs()}-${randomUUID().slice(0, 8)}`;
    const timingPath = join(folder, `${name}.beats.json`);
    const outputPath = join(folder, `${name}.${format}`);
    // Beats only: no downbeats are given, so the harness infers no bar.
    await writeFile(timingPath, JSON.stringify({ beats }));
    try {
      const { stdout } = await runPython(
        [
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
        ],
        signal,
      );
      return { ...JSON.parse(stdout.toString("utf8")), outputPath, timingPath };
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => {});
      await rm(timingPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function writeDemo() {
    const audioPath = join(localDir, "draft-demo", "synthetic-demo.wav");
    if (!existsSync(audioPath)) {
      await mkdir(dirname(audioPath), { recursive: true });
      await writeFile(audioPath, encodeWav([demoPcm()], demoSampleRate));
    }
    const reserved = await reserveTraceFile(localDir, "synthetic-demo");
    registeredTraces.add(reserved);
    return {
      audioPath,
      tracePath: reserved,
    };
  }

  function tracePath(input: unknown): string {
    if (typeof input !== "string") throw new Error("Give the trace's full path.");
    const path = fullPath(input);
    if (extname(path) !== ".jsonl") throw new Error("A trace is a .jsonl file.");
    assertNotTimingFile(path);
    return path;
  }

  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    assertLocalRequest(request, url);
    const operation = url.pathname.slice(prefix.length + 1);
    if (request.method === "GET" && operation === "trace") {
      const path = tracePath(url.searchParams.get("path"));
      const events = await readTrace(path);
      registeredTraces.add(path);
      sendJson(response, { events });
      return;
    }
    if (request.method !== "POST") throw new Error("Use POST for draft operations.");
    const body = JSON.parse((await readBody(request)).toString("utf8") || "{}");
    const { controller: disconnected, cleanup } = disconnectController(request, response);
    try {
      if (operation === "analyze") {
        const result = await analyze(body, disconnected.signal);
        if (!disconnected.signal.aborted && !response.destroyed) sendJson(response, result);
      } else if (operation === "demo") sendJson(response, await writeDemo());
      else if (operation === "pcm") {
        const path = await audioFile(body.audioPath);
        const { stdout } = await runProcess(
          "ffmpeg",
          [
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
          ],
          disconnected.signal,
        );
        if (!disconnected.signal.aborted && !response.destroyed) {
          response.setHeader("Content-Type", "application/octet-stream");
          response.end(stdout);
        }
      } else if (operation === "recompute") {
        const result = await recomputes.run(
          String(body.client ?? "page"),
          body.request as RecomputeRequest,
          disconnected.signal,
        );
        if (!disconnected.signal.aborted && !response.destroyed) sendJson(response, result);
      } else if (operation === "audition-view") {
        const out = await auditionView(body, disconnected.signal);
        if (disconnected.signal.aborted || response.destroyed) return;
        response.setHeader("Content-Type", "audio/wav");
        response.setHeader(
          "X-Audition-Only",
          "listening view; timestamps stay on the original mix",
        );
        await pipeline(createReadStream(out), response, { signal: disconnected.signal });
      } else if (operation === "export-clip") {
        const result = await exportClip(body, disconnected.signal);
        if (!disconnected.signal.aborted && !response.destroyed) sendJson(response, result);
      } else if (operation === "trace/append") {
        const path = tracePath(body.tracePath);
        if (!Array.isArray(body.events)) throw new Error("Give the events to append.");
        const result = await writer.append(path, body.events);
        registeredTraces.add(path);
        sendJson(response, { tracePath: path, ...result });
      } else throw new Error("Unknown draft operation.");
    } catch (error) {
      if (disconnected.signal.aborted || response.destroyed) return;
      throw error;
    } finally {
      cleanup();
    }
  };
}

export const draftPlugin = () =>
  localServicePlugin("inspector-draft", prefix, () => draftHandler());

export const createDraftMiddleware = (options?: DraftServiceOptions) =>
  localService(prefix, draftHandler(options));
