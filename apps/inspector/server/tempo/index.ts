import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  computeGridFit,
  DEFAULT_TRIGGER_POLICY,
  EDIT_OP_KINDS,
  type EditOp,
  EnsomiError,
  type GridFitItem,
  type LayerLifecycleState,
  type PatchOffer,
  projectRedLines,
  type Range,
  type RedLineProjection,
  rankInboxSpans,
  type SerializedSessionState,
  SessionController,
  type Span,
  serializeState,
  type TriggerLayer,
  type TriggerPolicy,
  type TriggerPolicyOverride,
} from "ensomi";
import type { Connect, Plugin } from "vite";
import { fullPath, localService, readBody, sendJson } from "../local-service.ts";
import {
  AUDITION_FILTERS,
  type AuditionFilter,
  TempoDaemonClient,
  TempoTimingProvider,
} from "./daemon-client.ts";
import {
  assertValidSongId,
  atomicWriteJson,
  slugifySongStem,
  type TempoSongSummary,
  type TempoWorkspaceManifest,
  TempoWorkspaceStore,
  type WorkspaceTarget,
} from "./workspace-store.ts";

export const TEMPO_API_PREFIX = "/api/tempo";
export const MAX_AUDITION_SPAN_SEC = 60;
export const DEFAULT_MAX_ACTIVE_HOSTS = 8;

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const EDIT_OP_SET = new Set<string>(EDIT_OP_KINDS);

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
};

const ENSOMI_ERROR_MESSAGES: Record<string, string> = {
  SESSION_CLOSED: "The song session was closed; reopen the song to continue.",
  INVALID_RANGE: "Choose a valid time span inside the recording.",
  INVALID_BEAT: "Beat timing must stay within the recording bounds.",
  INVALID_SEGMENT: "Segment boundaries must stay ordered inside the recording.",
  INVALID_SEGMENTS: "Segment boundaries must cover the recording without overlap.",
  INVALID_SPAN: "Marked span must lie inside a single segment.",
  INVALID_SOUND: "Sound marker must stay within the recording bounds.",
  INVALID_UNBEAT: "Unbeat cue must stay within the recording bounds.",
  INVALID_EDIT: "That edit could not be applied to the current timing state.",
  INVALID_RETRACT: "That undo or redo step is no longer available.",
  INVALID_OFFER: "That timing suggestion is no longer applicable.",
  OFFER_NOT_FOUND: "That timing suggestion is no longer available.",
  PROTECTED_KEEP: "A locked Keep section prevents modifying beats in that span.",
  DUPLICATE_EVENT_ID: "Duplicate session trace event rejected.",
  CORRUPT_NDJSON: "The saved session trace could not be parsed cleanly.",
};

const INTERNAL_TOKEN_RE =
  /\b(?:sk:[A-Za-z0-9_-]+|\d+:(?:edit|draft_loaded|offer_accept|offer_reject|audio_bound|retract|ready)_[A-Za-z0-9_-]+|(?:offer_b|seg|span|beat|snd|sound|unbeat|offer|batch|evt|snap|ub|kb)[_-][A-Za-z0-9_-]+|b[_-][A-Za-z0-9_-]{2,}|(?:audio_bound|draft_loaded|offer_batch|offer_accept|offer_reject|listen_effort|retract|signal|edit|ready)_\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

export function sanitizeTempoErrorMessage(error: unknown): string {
  if (error instanceof EnsomiError) {
    const mapped = ENSOMI_ERROR_MESSAGES[error.code];
    if (mapped) return mapped;
  }
  const raw = error instanceof Error ? error.message : String(error ?? "Request failed.");
  const redacted = raw
    .replace(/"[^"]*"/g, (quoted) => {
      const inner = quoted.slice(1, -1);
      if (INTERNAL_TOKEN_RE.test(inner)) {
        INTERNAL_TOKEN_RE.lastIndex = 0;
        return "this item";
      }
      INTERNAL_TOKEN_RE.lastIndex = 0;
      return quoted;
    })
    .replace(INTERNAL_TOKEN_RE, "item")
    .replace(/\s{2,}/g, " ")
    .trim();
  return redacted || "Tempo request could not be completed.";
}

function sanitizeTempoHttpError(error: unknown): Error {
  if (error instanceof DOMException) {
    return new DOMException(sanitizeTempoErrorMessage(error), error.name);
  }
  const rawErr = error as (Error & { code?: string }) | undefined;
  const cleaned = new Error(sanitizeTempoErrorMessage(error));
  if (rawErr?.name && rawErr.name !== "EnsomiError") {
    cleaned.name = rawErr.name;
  }
  if (typeof rawErr?.code === "string" && (rawErr.code === "ENOENT" || rawErr.code === "ENOTDIR")) {
    (cleaned as Error & { code?: string }).code = rawErr.code;
  }
  return cleaned;
}

export interface TempoServiceOptions {
  /** Initial folder workspace to open automatically (`TEMPO_WORKSPACE_DIR`). */
  workspaceDir?: string;
  /** Optional custom state directory (`TEMPO_STATE_DIR`), defaulting to `<workspaceDir>/.ensomi-tempo/`. */
  stateDir?: string;
  /** Fallback workspace folder created automatically if user uploads/imports before opening a folder. */
  defaultImportWorkspaceDir?: string;
  /** Custom allowed bind host when CLI server runs with `--host`. */
  allowedHost?: string;
  /** Explicit opt-in required to accept non-loopback connections (`--allow-remote`). */
  allowRemote?: boolean;
  /** Optional `TriggerPolicy` overrides for `SessionController` instances. */
  triggerPolicy?: TriggerPolicyOverride;
  /** Environment overrides forwarded to `TempoDaemonClient`. */
  env?: NodeJS.ProcessEnv;
  maxCachedTracks?: number;
  /** Maximum retained `SongSessionHost` instances in memory before evicting oldest idle host. */
  maxActiveHosts?: number;
}

export interface TempoWorkspaceResponse extends TempoWorkspaceManifest {
  triggerPolicy: TriggerPolicy;
}

export interface TempoSongSessionPayload {
  song: TempoSongSummary;
  songSummary: TempoSongSummary;
  state: SerializedSessionState;
  gridFit: GridFitItem[];
  inboxSpans: Span[];
  redLineProjection: RedLineProjection;
  layerStates: Record<TriggerLayer, LayerLifecycleState>;
  holdingOffers: boolean;
  heldOffers: PatchOffer[];
  canUndo: boolean;
  canRedo: boolean;
}

interface AuditionRenderMeta {
  startSample: number;
  endSample: number;
  sampleRate: number;
}

export class SongSessionHost {
  readonly songId: string;
  readonly tracePath: string;
  readonly controller: SessionController;
  private persistedCount: number;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly traceWriter: TempoWorkspaceStore["traceWriter"];

  constructor(options: {
    songId: string;
    tracePath: string;
    controller: SessionController;
    persistedCount: number;
    traceWriter: TempoWorkspaceStore["traceWriter"];
  }) {
    this.songId = options.songId;
    this.tracePath = options.tracePath;
    this.controller = options.controller;
    this.persistedCount = options.persistedCount;
    this.traceWriter = options.traceWriter;
  }

  /**
   * Serializes `.jsonl` persistence across concurrent edits via `this.flushChain`.
   * Advances `this.persistedCount` ONLY after `traceWriter.append` resolves, keeping
   * `this.flushChain` alive on failure so subsequent flushes retry the full unsaved suffix.
   */
  flushTrace(): Promise<void> {
    const task = this.flushChain.then(async () => {
      const allEvents = this.controller.getState().events;
      if (allEvents.length <= this.persistedCount) return;
      const delta = allEvents.slice(this.persistedCount);
      if (delta.length === 0) return;
      await this.traceWriter.append(this.tracePath, delta);
      this.persistedCount = allEvents.length;
    });
    this.flushChain = task.catch(() => {});
    return task;
  }

  isIdle(): boolean {
    const ls = this.layerStates();
    return !ls.song_open.inFlight && !ls.micro_assist.inFlight && !ls.heavy_recompute.inFlight;
  }

  layerStates(): Record<TriggerLayer, LayerLifecycleState> {
    return {
      song_open: this.controller.getLayerState("song_open"),
      micro_assist: this.controller.getLayerState("micro_assist"),
      heavy_recompute: this.controller.getLayerState("heavy_recompute"),
    };
  }
}

function disconnectSignal(
  request: IncomingMessage,
  response: ServerResponse,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onDisconnect = () => {
    if (!response.writableFinished) {
      controller.abort();
    }
  };
  if (request.destroyed) {
    controller.abort();
  }
  request.on("aborted", onDisconnect);
  response.on("close", onDisconnect);
  return {
    signal: controller.signal,
    cleanup: () => {
      request.off("aborted", onDisconnect);
      response.off("close", onDisconnect);
    },
  };
}

export function assertTempoLocalRequest(
  request: IncomingMessage,
  url: URL,
  options: { allowedHost?: string; allowRemote?: boolean } = {},
  requireLocalHeader = false,
): void {
  const remote = request.socket.remoteAddress ?? "";
  let socketAllowed = LOOPBACK_ADDRESSES.has(remote);
  let hostAllowed = LOOPBACK_HOSTNAMES.has(url.hostname);

  if (options.allowRemote) {
    if (!options.allowedHost || options.allowedHost === "0.0.0.0" || options.allowedHost === "::") {
      socketAllowed = true;
      hostAllowed = true;
    } else {
      socketAllowed =
        socketAllowed ||
        remote === options.allowedHost ||
        remote === `::ffff:${options.allowedHost}`;
      hostAllowed = hostAllowed || url.hostname === options.allowedHost;
    }
  }

  if (
    !socketAllowed ||
    !hostAllowed ||
    (request.headers.origin && request.headers.origin !== url.origin) ||
    request.headers["sec-fetch-site"] === "cross-site"
  ) {
    throw new DOMException(
      "Inspector's Tempo service accepts only same-origin local requests.",
      "NotAllowedError",
    );
  }

  if (requireLocalHeader) {
    const contentType = (request.headers["content-type"] ?? "").toLowerCase();
    const isSimpleFormPost =
      contentType.startsWith("application/x-www-form-urlencoded") ||
      contentType.startsWith("text/plain");
    if (isSimpleFormPost || request.headers["x-beatmap-lens-local"] !== "1") {
      throw new DOMException(
        "Tempo mutations require same-origin local confirmation header.",
        "NotAllowedError",
      );
    }
  }
}

function parseHttpByteRange(
  rangeHeader: string,
  totalSize: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!rangeHeader.startsWith("bytes=")) return null;
  const spec = rangeHeader.slice("bytes=".length).split(",")[0]?.trim() ?? "";
  const dashIdx = spec.indexOf("-");
  if (dashIdx < 0 || totalSize <= 0) return "unsatisfiable";

  const startPart = spec.slice(0, dashIdx).trim();
  const endPart = spec.slice(dashIdx + 1).trim();

  if (startPart === "") {
    const suffixLen = Number(endPart);
    if (!Number.isInteger(suffixLen) || suffixLen <= 0) return "unsatisfiable";
    const start = Math.max(0, totalSize - suffixLen);
    return { start, end: totalSize - 1 };
  }

  const start = Number(startPart);
  const end = endPart === "" ? totalSize - 1 : Number(endPart);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= totalSize ||
    end < start
  ) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, totalSize - 1) };
}

async function streamFileWithRange(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
  contentType: string,
  extraHeaders?: Record<string, string>,
): Promise<void> {
  const info = await stat(filePath);
  if (!info.isFile()) {
    const err = new Error("Audio file not found.");
    err.name = "NotFoundError";
    throw err;
  }
  const totalSize = info.size;
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", contentType);
  if (extraHeaders) {
    for (const [key, val] of Object.entries(extraHeaders)) {
      response.setHeader(key, val);
    }
  }

  const rangeHeader = request.headers.range;
  if (typeof rangeHeader === "string" && rangeHeader.length > 0) {
    const parsed = parseHttpByteRange(rangeHeader, totalSize);
    if (parsed === "unsatisfiable") {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${totalSize}`);
      response.end();
      return;
    }
    if (parsed !== null) {
      const chunkLen = parsed.end - parsed.start + 1;
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${parsed.start}-${parsed.end}/${totalSize}`);
      response.setHeader("Content-Length", String(chunkLen));
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const { signal, cleanup } = disconnectSignal(request, response);
      try {
        await pipeline(
          createReadStream(filePath, { start: parsed.start, end: parsed.end }),
          response,
          { signal },
        );
      } catch (error) {
        if (!signal.aborted && !response.destroyed) throw error;
      } finally {
        cleanup();
      }
      return;
    }
  }

  response.statusCode = 200;
  response.setHeader("Content-Length", String(totalSize));
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const { signal, cleanup } = disconnectSignal(request, response);
  try {
    await pipeline(createReadStream(filePath), response, { signal });
  } catch (error) {
    if (!signal.aborted && !response.destroyed) throw error;
  } finally {
    cleanup();
  }
}

function parseFiniteNumber(value: unknown, label: string): number {
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return num;
}

function validateAuditionFilter(value: unknown): AuditionFilter {
  const f = value === undefined || value === null || value === "" ? "mix" : String(value);
  if (!(AUDITION_FILTERS as readonly string[]).includes(f)) {
    throw new Error(`Invalid filter "${f}". Expected one of: ${AUDITION_FILTERS.join(", ")}.`);
  }
  return f as AuditionFilter;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(request)).toString("utf8").trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object request body.");
  }
  return parsed as Record<string, unknown>;
}

export interface TempoService {
  readonly daemon: TempoDaemonClient;
  readonly store: TempoWorkspaceStore;
  readonly activeHostCount: number;
  ensureInitialWorkspace(): Promise<TempoWorkspaceManifest | null>;
  openWorkspace(dir: string, stateDir?: string): Promise<TempoWorkspaceResponse>;
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void>;
  close(): Promise<void>;
}

export function createTempoService(options: TempoServiceOptions = {}): TempoService {
  const env = options.env ?? process.env;
  const maxActiveHosts = Math.max(1, options.maxActiveHosts ?? DEFAULT_MAX_ACTIVE_HOSTS);
  const store = new TempoWorkspaceStore();
  const daemon = new TempoDaemonClient({
    env,
    ...(options.maxCachedTracks !== undefined ? { maxCachedTracks: options.maxCachedTracks } : {}),
  });

  const provider = new TempoTimingProvider({
    daemon,
    resolveAudioPath: (songId) => store.getSong(songId).audioPath,
    initialKind: env.TEMPO_ANALYZER_BACKEND === "dsp" ? "rule" : "model",
  });

  const hosts = new Map<string, SongSessionHost>();
  const hostInitLocks = new Map<string, Promise<SongSessionHost>>();

  const configuredDir = options.workspaceDir ?? env.TEMPO_WORKSPACE_DIR;
  const configuredStateDir = options.stateDir ?? env.TEMPO_STATE_DIR;
  const defaultImportDir =
    options.defaultImportWorkspaceDir ?? join(repoRoot, ".local", "tempo-workspace");

  let initPromise: Promise<TempoWorkspaceManifest | null> | null = null;

  function effectiveTriggerPolicy(): TriggerPolicy {
    const sample = hosts.values().next().value as SongSessionHost | undefined;
    if (sample) return sample.controller.getTriggerPolicy();
    return {
      song_open: { ...DEFAULT_TRIGGER_POLICY.song_open, ...options.triggerPolicy?.song_open },
      micro_assist: {
        ...DEFAULT_TRIGGER_POLICY.micro_assist,
        ...options.triggerPolicy?.micro_assist,
      },
      heavy_recompute: {
        ...DEFAULT_TRIGGER_POLICY.heavy_recompute,
        ...options.triggerPolicy?.heavy_recompute,
      },
    };
  }

  async function closeHostsForOtherStateDir(nextStateDir: string | null): Promise<void> {
    const toClose: Array<[string, SongSessionHost]> = [];
    for (const [key, host] of hosts) {
      if (!nextStateDir || !key.startsWith(`${nextStateDir}::`)) {
        toClose.push([key, host]);
      }
    }
    for (const [key, host] of toClose) {
      hosts.delete(key);
      await host.flushTrace().catch(() => {});
      host.controller.close();
    }
  }

  async function evictHostForSong(stateDir: string | null, songId: string): Promise<void> {
    if (!stateDir) return;
    const key = `${stateDir}::${songId}`;
    const existing = hosts.get(key);
    if (!existing) return;
    hosts.delete(key);
    existing.controller.close();
  }

  async function evictIdleHostsIfNeeded(protectKey?: string): Promise<void> {
    for (const [key, host] of hosts) {
      if (hosts.size <= maxActiveHosts) break;
      if (key === protectKey || !host.isIdle()) continue;
      await host.flushTrace();
      if (
        hosts.size > maxActiveHosts &&
        hosts.get(key) === host &&
        key !== protectKey &&
        host.isIdle()
      ) {
        hosts.delete(key);
        host.controller.close();
      }
    }
  }

  async function openWorkspaceInternal(
    dir: string,
    stateDir?: string,
    createIfMissing = false,
  ): Promise<TempoWorkspaceManifest> {
    const manifest = await store.openWorkspace(dir, {
      ...(stateDir ? { stateDir } : {}),
      createIfMissing,
    });
    await closeHostsForOtherStateDir(store.currentStateDir);
    return manifest;
  }

  function ensureInitialWorkspace(): Promise<TempoWorkspaceManifest | null> {
    if (store.isOpen) {
      return Promise.resolve(store.getSnapshot());
    }
    if (!configuredDir) {
      return Promise.resolve(null);
    }
    if (!initPromise) {
      initPromise = openWorkspaceInternal(configuredDir, configuredStateDir).catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    return initPromise;
  }

  async function ensureWorkspaceForImport(
    explicitDir?: string,
    explicitStateDir?: string,
  ): Promise<{ manifest: TempoWorkspaceManifest; target: WorkspaceTarget }> {
    if (explicitDir) {
      const expanded = fullPath(explicitDir);
      const canonicalExplicit = await realpath(expanded).catch(() => expanded);
      if (store.isOpen && store.currentWorkspaceDir === canonicalExplicit && !explicitStateDir) {
        return {
          manifest: store.getSnapshot() as TempoWorkspaceManifest,
          target: store.captureTarget(),
        };
      }
      const nextStateDir =
        explicitStateDir ??
        (store.currentWorkspaceDir === canonicalExplicit
          ? (store.currentStateDir ?? configuredStateDir)
          : configuredStateDir);
      const manifest = await openWorkspaceInternal(explicitDir, nextStateDir);
      return { manifest, target: store.captureTarget() };
    }
    const current = await ensureInitialWorkspace();
    if (current) {
      return { manifest: current, target: store.captureTarget() };
    }
    const manifest = await openWorkspaceInternal(
      defaultImportDir,
      explicitStateDir ?? configuredStateDir,
      true,
    );
    return { manifest, target: store.captureTarget() };
  }

  function formatWorkspaceResponse(
    manifest: TempoWorkspaceManifest | null,
  ): TempoWorkspaceResponse {
    const triggerPolicy = effectiveTriggerPolicy();
    if (!manifest) {
      return {
        schemaVersion: 1,
        workspaceDir: "",
        activeSongId: null,
        songs: [],
        triggerPolicy,
      };
    }
    return {
      ...manifest,
      triggerPolicy,
    };
  }

  async function getOrLoadHost(songId: string, signal?: AbortSignal): Promise<SongSessionHost> {
    assertValidSongId(songId);
    signal?.throwIfAborted?.();
    await ensureInitialWorkspace();
    signal?.throwIfAborted?.();
    const stateDir = store.currentStateDir;
    if (!stateDir) {
      throw new Error("Open a Tempo workspace folder first.");
    }
    store.getSong(songId);
    const key = `${stateDir}::${songId}`;
    const existing = hosts.get(key);
    if (existing && !existing.controller.isClosed()) {
      hosts.delete(key);
      hosts.set(key, existing);
      return existing;
    }

    const inflight = hostInitLocks.get(key);
    if (inflight) {
      const resolvedHost = await inflight;
      signal?.throwIfAborted?.();
      return resolvedHost;
    }

    const loader = (async () => {
      try {
        const tracePath = await store.resolveContainedStatePath("traces", `${songId}.jsonl`);
        const initialEvents = await store.traceWriter.read(tracePath);
        const controller = new SessionController({
          provider,
          ...(options.triggerPolicy ? { triggerPolicy: options.triggerPolicy } : {}),
          ...(initialEvents.length > 0 ? { initialEvents } : {}),
        });
        const host = new SongSessionHost({
          songId,
          tracePath,
          controller,
          persistedCount: initialEvents.length,
          traceWriter: store.traceWriter,
        });
        hosts.set(key, host);
        await evictIdleHostsIfNeeded(key);
        return host;
      } finally {
        hostInitLocks.delete(key);
      }
    })();

    hostInitLocks.set(key, loader);
    const created = await loader;
    signal?.throwIfAborted?.();
    return created;
  }

  async function buildSongSessionPayload(host: SongSessionHost): Promise<TempoSongSessionPayload> {
    const liveState = host.controller.getState();
    const serialized = serializeState(liveState);
    const gridFit = computeGridFit(liveState.sounds, liveState.beats, liveState.segments);
    const inboxSpans = rankInboxSpans(liveState);
    const redLineProjection = projectRedLines(liveState.beats, liveState.segments, {
      spans: liveState.spans,
    });
    const songSummary = await store.updateSongFromState(host.songId, liveState, inboxSpans);
    return {
      song: songSummary,
      songSummary,
      state: serialized,
      gridFit,
      inboxSpans,
      redLineProjection,
      layerStates: host.layerStates(),
      holdingOffers: host.controller.isHoldingOffers(),
      heldOffers: host.controller.getHeldOffers(),
      canUndo: host.controller.canUndo(),
      canRedo: host.controller.canRedo(),
    };
  }

  async function openSongSession(
    songId: string,
    signal?: AbortSignal,
  ): Promise<TempoSongSessionPayload> {
    assertValidSongId(songId);
    signal?.throwIfAborted?.();
    await ensureInitialWorkspace();
    signal?.throwIfAborted?.();

    const freshness = await store.verifySongAudioFreshness(songId);
    if (freshness.rotated) {
      await evictHostForSong(store.currentStateDir, songId);
    }
    signal?.throwIfAborted?.();

    const song = await store.setActiveSong(songId);
    signal?.throwIfAborted?.();
    const host = await getOrLoadHost(songId, signal);
    const stateBefore = host.controller.getState();

    const hasDraftLoaded = stateBefore.events.some(
      (ev) => !stateBefore.retractedEventIds.has(ev.id) && ev.type === "draft_loaded",
    );
    const hasUserMutations = stateBefore.events.some(
      (ev) => !stateBefore.retractedEventIds.has(ev.id) && ev.type === "edit",
    );

    if (!stateBefore.audio) {
      const prepared = await daemon.prepare(song.audioPath, signal);
      signal?.throwIfAborted?.();
      await host.controller.openSong(
        {
          songId,
          durationSec: prepared.durationSec,
          sampleRate: prepared.sampleRate,
          clock: "source-audio-sec",
          decoder: "ffmpeg-f32le",
        },
        signal,
      );
      await host.flushTrace();
    } else if (
      !hasDraftLoaded &&
      !hasUserMutations &&
      host.controller.getTriggerPolicy().song_open.mode === "auto"
    ) {
      await daemon.prepare(song.audioPath, signal);
      signal?.throwIfAborted?.();
      await host.controller.analyze(signal);
      await host.flushTrace();
    } else {
      // Warm PCM cache in the background without blocking cached `.jsonl` reopen!
      void daemon.prepare(song.audioPath).catch(() => {});
    }

    signal?.throwIfAborted?.();
    return await buildSongSessionPayload(host);
  }

  async function renderCachedAudition(
    song: TempoSongSummary,
    t0: number,
    t1: number,
    filter: AuditionFilter,
    signal?: AbortSignal,
  ): Promise<{ wavPath: string } & AuditionRenderMeta> {
    if (t0 < 0 || t1 <= t0 || t1 - t0 > MAX_AUDITION_SPAN_SEC + 1e-6) {
      throw new Error(`Choose an audition span between 0 and ${MAX_AUDITION_SPAN_SEC} seconds.`);
    }
    const fileInfo = await stat(song.audioPath);
    const cacheKey = createHash("sha1")
      .update(
        [
          song.audioPath,
          song.audioSha256Sample,
          String(fileInfo.mtimeMs),
          String(fileInfo.size),
          String(t0),
          String(t1),
          filter,
        ].join("\0"),
      )
      .digest("hex");

    const cacheDir = await store.resolveContainedStatePath(".cache", "audition");
    await mkdir(cacheDir, { recursive: true });
    const outPath = await store.resolveContainedStatePath(".cache", "audition", `${cacheKey}.wav`);
    const metaPath = await store.resolveContainedStatePath(
      ".cache",
      "audition",
      `${cacheKey}.wav.meta.json`,
    );

    if (existsSync(outPath) && existsSync(metaPath)) {
      try {
        const rawMeta = JSON.parse(await readFile(metaPath, "utf8")) as Partial<AuditionRenderMeta>;
        if (
          typeof rawMeta.startSample === "number" &&
          Number.isInteger(rawMeta.startSample) &&
          typeof rawMeta.endSample === "number" &&
          Number.isInteger(rawMeta.endSample) &&
          typeof rawMeta.sampleRate === "number" &&
          rawMeta.sampleRate > 0
        ) {
          return {
            wavPath: outPath,
            startSample: rawMeta.startSample,
            endSample: rawMeta.endSample,
            sampleRate: rawMeta.sampleRate,
          };
        }
      } catch {
        // Fall through to re-render when sidecar metadata is unreadable.
      }
    }

    const rendered = await daemon.renderAudition(
      {
        audioPath: song.audioPath,
        startSec: t0,
        endSec: t1,
        filter,
        outputPath: outPath,
      },
      signal,
    );
    const meta: AuditionRenderMeta = {
      startSample: rendered.startSample,
      endSample: rendered.endSample,
      sampleRate: rendered.sampleRate,
    };
    await atomicWriteJson(metaPath, meta);
    return {
      wavPath: outPath,
      ...meta,
    };
  }

  async function handleUploadRequest(
    request: IncomingMessage,
    url: URL,
  ): Promise<Record<string, unknown>> {
    const { target } = await ensureWorkspaceForImport(
      url.searchParams.get("dir") ?? undefined,
      url.searchParams.get("stateDir") ?? undefined,
    );
    const contentType = (request.headers["content-type"] ?? "").toLowerCase();

    if (contentType.startsWith("multipart/form-data")) {
      const rawBuffer = await readBody(request);
      const webReq = new Request("http://127.0.0.1/upload", {
        method: "POST",
        headers: { "content-type": request.headers["content-type"] ?? "multipart/form-data" },
        body: new Uint8Array(rawBuffer),
      });
      const form = await webReq.formData();
      const importedSongIds: string[] = [];
      let lastSong: TempoSongSummary | null = null;
      let latestWorkspace: TempoWorkspaceManifest | null = null;

      for (const value of form.values()) {
        if (typeof value === "object" && value !== null && "arrayBuffer" in value) {
          const fileObj = value as File;
          if (!fileObj.name) continue;
          const bytes = new Uint8Array(await fileObj.arrayBuffer());
          const uploaded = await store.importUploadedBuffer(fileObj.name, bytes, target);
          importedSongIds.push(uploaded.song.songId);
          lastSong = uploaded.song;
          latestWorkspace = uploaded.workspace;
        }
      }

      if (importedSongIds.length === 0 || !latestWorkspace || !lastSong) {
        throw new Error("Multipart upload contained no supported audio files.");
      }

      const firstSongId = importedSongIds[0] ?? lastSong.songId;
      let refreshed = latestWorkspace;
      if (store.currentStateDir === target.stateDir) {
        await store.setActiveSong(firstSongId);
        refreshed = (store.getSnapshot() as TempoWorkspaceManifest) ?? latestWorkspace;
      }
      const firstSong = refreshed.songs.find((s) => s.songId === firstSongId) ?? lastSong;
      const formatted = formatWorkspaceResponse(refreshed);
      return {
        ...formatted,
        workspace: formatted,
        songId: firstSongId,
        importedSongIds,
        song: firstSong,
      };
    }

    const rawHeaderName = request.headers["x-file-name"];
    const nameParam =
      url.searchParams.get("name") ??
      (typeof rawHeaderName === "string" ? decodeURIComponent(rawHeaderName) : "");
    if (!nameParam) {
      throw new Error("Provide ?name=<filename> or multipart/form-data for audio upload.");
    }

    const { workspace, song } = await store.importUploadedStream(nameParam, request, target);
    const formatted = formatWorkspaceResponse(workspace);
    return {
      ...formatted,
      workspace: formatted,
      songId: song.songId,
      importedSongIds: [song.songId],
      song,
    };
  }

  async function handleEditRequest(
    host: SongSessionHost,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let committedEvent = null;

    if (body.action === "undo") {
      const res = host.controller.undo(typeof body.reason === "string" ? body.reason : undefined);
      if (!res.ok || !res.event) {
        throw new Error("Nothing to undo.");
      }
      committedEvent = res.event;
    } else if (body.action === "redo") {
      const explicitTarget =
        typeof body.targetEventId === "string"
          ? body.targetEventId
          : typeof body.targetSeq === "number"
            ? body.targetSeq
            : undefined;
      if (explicitTarget !== undefined) {
        const res = host.controller.retract(
          explicitTarget,
          typeof body.reason === "string" ? body.reason : "redo",
        );
        committedEvent = res.event;
      } else {
        const res = host.controller.redo(typeof body.reason === "string" ? body.reason : undefined);
        if (!res.ok || !res.event) {
          throw new Error("Nothing to redo.");
        }
        committedEvent = res.event;
      }
    } else if (
      body.action === "retract" ||
      body.retract !== undefined ||
      body.targetEventId !== undefined ||
      body.targetSeq !== undefined
    ) {
      const target =
        typeof body.retract === "string" || typeof body.retract === "number"
          ? body.retract
          : typeof body.targetEventId === "string"
            ? body.targetEventId
            : typeof body.targetSeq === "number"
              ? body.targetSeq
              : undefined;
      if (target === undefined) {
        throw new Error("Specify targetEventId or targetSeq to retract.");
      }
      const res = host.controller.retract(
        target,
        typeof body.reason === "string" ? body.reason : undefined,
      );
      committedEvent = res.event;
    } else if (body.action === "ready" || typeof body.ready === "boolean") {
      const wantReady = body.ready === undefined ? true : Boolean(body.ready);
      const currentState = host.controller.getState();
      if (wantReady) {
        const res = host.controller.markReady(
          typeof body.notes === "string" ? body.notes : undefined,
        );
        committedEvent = res.event;
      } else if (currentState.ready && currentState.readyAtSeq !== null) {
        const res = host.controller.retract(currentState.readyAtSeq, "Cleared ready status");
        committedEvent = res.event;
      }
    } else if (body.action === "listen_effort" || body.listenEffort !== undefined) {
      const src =
        body.listenEffort && typeof body.listenEffort === "object"
          ? (body.listenEffort as Record<string, unknown>)
          : body;
      const effortPayload: { listenSec?: number; waitSec?: number; range?: Range } = {};
      if (typeof src.listenSec === "number") effortPayload.listenSec = src.listenSec;
      if (typeof src.waitSec === "number") effortPayload.waitSec = src.waitSec;
      if (src.range && typeof src.range === "object") {
        effortPayload.range = src.range as Range;
      }
      const res = host.controller.recordListenEffort(effortPayload);
      committedEvent = res.event;
    } else {
      let opsInput: EditOp | EditOp[];
      if (Array.isArray(body.ops)) {
        opsInput = body.ops as EditOp[];
      } else if (body.op && typeof body.op === "object") {
        opsInput = body.op as EditOp;
      } else if (typeof body.op === "string" && EDIT_OP_SET.has(body.op)) {
        opsInput = body as unknown as EditOp;
      } else {
        throw new Error(
          "Provide EditOp(s) in { ops: [...] }, a single EditOp, or { action: 'retract' | 'undo' | 'redo' | 'ready' | 'listen_effort' }.",
        );
      }
      const res = host.controller.applyEdit(opsInput);
      committedEvent = res.event;
    }

    await host.flushTrace();
    const payload = await buildSongSessionPayload(host);
    return {
      ...payload,
      event: committedEvent,
    };
  }

  async function handleExportRequest(
    host: SongSessionHost,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const format = String(body.format ?? "osu");
    const song = store.getSong(host.songId);
    const state = host.controller.getState();

    if (format === "osu") {
      const projection = projectRedLines(state.beats, state.segments, {
        spans: state.spans,
      });
      const content = `[TimingPoints]\n${projection.osuTimingPoints}\n`;
      return {
        format: "osu",
        fileName: `${slugifySongStem(song.fileName)}.osu.timing.txt`,
        osuTimingPoints: projection.osuTimingPoints,
        content,
        redLineProjection: projection,
      };
    }

    if (format === "jsonl") {
      await host.flushTrace();
      const content = host.controller.exportNdjson();
      return {
        format: "jsonl",
        fileName: `${song.songId}.jsonl`,
        tracePath: host.tracePath,
        content,
        eventCount: state.events.length,
      };
    }

    if (format === "clip") {
      const filter = validateAuditionFilter(body.filter);
      const maxDur = state.durationSec > 0 ? state.durationSec : (song.durationSec ?? 30);
      const t0 = body.t0 !== undefined ? parseFiniteNumber(body.t0, "t0") : 0;
      const t1 =
        body.t1 !== undefined ? parseFiniteNumber(body.t1, "t1") : Math.min(maxDur, t0 + 15);
      if (t0 < 0 || t1 <= t0) {
        throw new Error("Clip export requires 0 <= t0 < t1.");
      }

      const clipsDir = await store.resolveContainedStatePath("clips");
      await mkdir(clipsDir, { recursive: true });
      const clipFileName = `${song.songId}-${t0.toFixed(3)}-${t1.toFixed(3)}-${filter}-${randomUUID().slice(0, 6)}.wav`;
      const outputPath = await store.resolveContainedStatePath("clips", clipFileName);
      const rendered = await daemon.exportClip(
        {
          audioPath: song.audioPath,
          startSec: t0,
          endSec: t1,
          filter,
          outputPath,
        },
        signal,
      );
      return {
        format: "clip",
        fileName: clipFileName,
        clipPath: rendered.outputPath,
        downloadUrl: `${TEMPO_API_PREFIX}/songs/${encodeURIComponent(song.songId)}/clips/${encodeURIComponent(clipFileName)}`,
        startSec: rendered.startSec,
        endSec: rendered.endSec,
        startSample: rendered.startSample,
        endSample: rendered.endSample,
        filter: rendered.filter,
        sampleRate: rendered.sampleRate,
        channels: rendered.channels,
      };
    }

    throw new Error(`Unsupported export format "${format}". Expected "osu", "jsonl", or "clip".`);
  }

  async function handleInternal(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const subPath = url.pathname.slice(TEMPO_API_PREFIX.length).replace(/^\/+/, "");
    const parts = subPath ? subPath.split("/").map((p) => decodeURIComponent(p)) : [];

    const requireLocalHeader =
      method !== "GET" && method !== "HEAD"
        ? true
        : url.searchParams.has("dir") || url.searchParams.has("stateDir");
    assertTempoLocalRequest(
      request,
      url,
      {
        ...(options.allowedHost ? { allowedHost: options.allowedHost } : {}),
        ...(options.allowRemote !== undefined ? { allowRemote: options.allowRemote } : {}),
      },
      requireLocalHeader,
    );

    // Workspace endpoints
    if (parts[0] === "workspace" && parts.length === 1 && method === "GET") {
      const dirQuery = url.searchParams.get("dir");
      const stateDirQuery = url.searchParams.get("stateDir") ?? configuredStateDir;
      if (dirQuery) {
        const opened = await openWorkspaceInternal(dirQuery, stateDirQuery);
        sendJson(response, formatWorkspaceResponse(opened));
        return;
      }
      const current = await ensureInitialWorkspace();
      if (!current) {
        sendJson(response, {
          schemaVersion: 1,
          workspaceDir: null,
          activeSongId: null,
          songs: [],
          triggerPolicy: effectiveTriggerPolicy(),
        });
        return;
      }
      sendJson(response, formatWorkspaceResponse(store.getSnapshot()));
      return;
    }

    if (
      parts[0] === "workspace" &&
      parts[1] === "open" &&
      parts.length === 2 &&
      method === "POST"
    ) {
      const body = await readJsonBody(request);
      if (typeof body.dir !== "string" || !body.dir.trim()) {
        throw new Error("Provide { dir: string } to open a Tempo workspace folder.");
      }
      const stateDir = typeof body.stateDir === "string" ? body.stateDir : configuredStateDir;
      const manifest = await openWorkspaceInternal(body.dir, stateDir);
      sendJson(response, formatWorkspaceResponse(manifest));
      return;
    }

    if (
      parts[0] === "workspace" &&
      parts[1] === "import" &&
      parts.length === 2 &&
      method === "POST"
    ) {
      const body = await readJsonBody(request);
      const { target } = await ensureWorkspaceForImport(
        typeof body.dir === "string" ? body.dir : undefined,
        typeof body.stateDir === "string" ? body.stateDir : undefined,
      );
      if (!Array.isArray(body.paths)) {
        throw new Error("Provide { paths: string[] } to import local audio files or folders.");
      }
      const { workspace, importedSongIds } = await store.importPaths({
        paths: body.paths as string[],
        target,
        ...(typeof body.copyIntoWorkspace === "boolean"
          ? { copyIntoWorkspace: body.copyIntoWorkspace }
          : {}),
      });
      const formatted = formatWorkspaceResponse(workspace);
      sendJson(response, {
        ...formatted,
        workspace: formatted,
        importedSongIds,
        songId: importedSongIds[0] ?? formatted.activeSongId,
      });
      return;
    }

    if (
      parts[0] === "workspace" &&
      (parts[1] === "import-upload" || parts[1] === "upload") &&
      parts.length === 2 &&
      method === "POST"
    ) {
      sendJson(response, await handleUploadRequest(request, url));
      return;
    }

    // Per-song endpoints: /api/tempo/songs/:songId/...
    if (parts[0] === "songs" && typeof parts[1] === "string" && parts[1].length > 0) {
      const songId = assertValidSongId(parts[1]);
      const action = parts[2];

      if (action === undefined && method === "GET") {
        const host = await getOrLoadHost(songId);
        sendJson(response, await buildSongSessionPayload(host));
        return;
      }

      if (action === "open" && parts.length === 3 && method === "POST") {
        const { signal, cleanup } = disconnectSignal(request, response);
        try {
          await readBody(request);
          if (signal.aborted || response.destroyed) return;
          const payload = await openSongSession(songId, signal);
          if (!signal.aborted && !response.destroyed) {
            sendJson(response, payload);
          }
        } catch (error) {
          if (signal.aborted || response.destroyed) return;
          throw error;
        } finally {
          cleanup();
        }
        return;
      }

      if (action === "audio" && parts.length === 3 && (method === "GET" || method === "HEAD")) {
        await ensureInitialWorkspace();
        const song = store.getSong(songId);
        const canonicalAudio = await realpath(song.audioPath);
        const mime =
          AUDIO_MIME_BY_EXT[extname(canonicalAudio).toLowerCase()] ?? "application/octet-stream";
        await streamFileWithRange(request, response, canonicalAudio, mime);
        return;
      }

      if (action === "audition" && parts.length === 3 && (method === "GET" || method === "HEAD")) {
        const { signal, cleanup } = disconnectSignal(request, response);
        let rendered: { wavPath: string } & AuditionRenderMeta;
        try {
          if (signal.aborted || response.destroyed) return;
          await ensureInitialWorkspace();
          if (signal.aborted || response.destroyed) return;
          const song = store.getSong(songId);
          const t0 = parseFiniteNumber(
            url.searchParams.get("t0") ?? url.searchParams.get("start"),
            "t0",
          );
          const t1 = parseFiniteNumber(
            url.searchParams.get("t1") ?? url.searchParams.get("end"),
            "t1",
          );
          const filter = validateAuditionFilter(
            url.searchParams.get("filter") ?? url.searchParams.get("view"),
          );
          rendered = await renderCachedAudition(song, t0, t1, filter, signal);
        } catch (error) {
          cleanup();
          if (signal.aborted || response.destroyed) return;
          throw error;
        }
        cleanup();
        if (signal.aborted || response.destroyed) return;
        await streamFileWithRange(request, response, rendered.wavPath, "audio/wav", {
          "X-Audition-Only": "listening view; timestamps stay on the original mix",
          "X-Audition-Start-Sample": String(rendered.startSample),
          "X-Audition-End-Sample": String(rendered.endSample),
          "X-Audition-Sample-Rate": String(rendered.sampleRate),
        });
        return;
      }

      if (
        action === "clips" &&
        typeof parts[3] === "string" &&
        parts.length === 4 &&
        (method === "GET" || method === "HEAD")
      ) {
        await ensureInitialWorkspace();
        store.getSong(songId);
        const rawClipName = parts[3];
        if (
          !rawClipName ||
          rawClipName !== basename(rawClipName) ||
          !rawClipName.endsWith(".wav")
        ) {
          throw new DOMException("Invalid clip path.", "NotAllowedError");
        }
        const safeClipPath = await store.resolveContainedStatePath("clips", rawClipName);
        await streamFileWithRange(request, response, safeClipPath, "audio/wav");
        return;
      }

      if (action === "edit" && parts.length === 3 && method === "POST") {
        const body = await readJsonBody(request);
        const host = await getOrLoadHost(songId);
        sendJson(response, await handleEditRequest(host, body));
        return;
      }

      if (action === "snaps" && parts.length === 3 && method === "POST") {
        const { signal, cleanup } = disconnectSignal(request, response);
        try {
          const body = await readJsonBody(request);
          if (signal.aborted || response.destroyed) return;
          const timeSec = parseFiniteNumber(body.timeSec, "timeSec");
          const windowSec =
            body.windowSec !== undefined ? parseFiniteNumber(body.windowSec, "windowSec") : 0.12;
          const immediate = body.immediate === undefined ? true : Boolean(body.immediate);

          const host = await getOrLoadHost(songId, signal);
          if (signal.aborted || response.destroyed) return;
          const song = store.getSong(songId);

          if (!host.controller.getState().audio) {
            const direct = await daemon.suggestSnaps(song.audioPath, timeSec, windowSec, signal);
            if (!signal.aborted && !response.destroyed) {
              sendJson(response, {
                status: "ok",
                songId,
                generation: 1,
                candidates: direct.candidates,
              });
            }
            return;
          }
          const outcome = await host.controller.suggestSnaps(
            { timeSec, windowSec, immediate },
            signal,
          );
          if (!signal.aborted && !response.destroyed) {
            sendJson(response, {
              status: outcome.status,
              songId: outcome.songId,
              generation: outcome.generation,
              candidates: outcome.candidates,
            });
          }
        } catch (error) {
          if (signal.aborted || response.destroyed) return;
          throw error;
        } finally {
          cleanup();
        }
        return;
      }

      if (action === "recompute" && parts.length === 3 && method === "POST") {
        const { signal, cleanup } = disconnectSignal(request, response);
        let onDisconnectAbort: (() => void) | null = null;
        try {
          const body = await readJsonBody(request);
          if (signal.aborted || response.destroyed) return;
          const rawScope = body.scope ?? "song";
          const scope: Range | "song" =
            rawScope === "song"
              ? "song"
              : {
                  t0: parseFiniteNumber((rawScope as Record<string, unknown>).t0, "scope.t0"),
                  t1: parseFiniteNumber((rawScope as Record<string, unknown>).t1, "scope.t1"),
                };
          const reason =
            typeof body.reason === "string" && body.reason.trim().length > 0
              ? body.reason.trim()
              : "User requested recompute";

          const host = await getOrLoadHost(songId, signal);
          if (signal.aborted || response.destroyed) return;
          if (!host.controller.getState().audio) {
            const song = store.getSong(songId);
            const prepared = await daemon.prepare(song.audioPath, signal);
            if (signal.aborted || response.destroyed) return;
            await host.controller.bindAudio(
              {
                songId,
                durationSec: prepared.durationSec,
                sampleRate: prepared.sampleRate,
                clock: "source-audio-sec",
                decoder: "ffmpeg-f32le",
              },
              signal,
            );
            await host.flushTrace();
            if (signal.aborted || response.destroyed) return;
          }

          const recomputePromise = host.controller.recompute({ scope, reason });
          const myGeneration = host.controller.getLayerState("heavy_recompute").generation;
          void host.flushTrace().catch(() => {});

          onDisconnectAbort = () => {
            const cur = host.controller.getLayerState("heavy_recompute");
            if (cur.inFlight && cur.generation === myGeneration) {
              host.controller.abortLayer("heavy_recompute", "Client disconnected");
            }
          };
          signal.addEventListener("abort", onDisconnectAbort, { once: true });
          if (signal.aborted) {
            onDisconnectAbort();
          }

          const outcome = await recomputePromise;
          await host.flushTrace();
          const sessionPayload = await buildSongSessionPayload(host);
          if (!signal.aborted && !response.destroyed) {
            sendJson(response, {
              ...sessionPayload,
              status: outcome.status,
              generation: outcome.generation,
              offers: outcome.offers,
              suppressedOffers: outcome.suppressedOffers,
            });
          }
        } catch (error) {
          await hosts
            .get(`${store.currentStateDir ?? ""}::${songId}`)
            ?.flushTrace()
            .catch(() => {});
          if (signal.aborted || response.destroyed) return;
          throw error;
        } finally {
          if (onDisconnectAbort) {
            signal.removeEventListener("abort", onDisconnectAbort);
          }
          cleanup();
        }
        return;
      }

      if (action === "hold-offers" && parts.length === 3 && method === "POST") {
        const body = await readJsonBody(request);
        const hold = Boolean(body.hold);
        const host = await getOrLoadHost(songId);
        const { flushed, offers } = host.controller.setHoldOffers(hold);
        if (flushed) {
          await host.flushTrace();
        }
        const sessionPayload = await buildSongSessionPayload(host);
        sendJson(response, {
          ...sessionPayload,
          hold: host.controller.isHoldingOffers(),
          flushed,
          offers,
        });
        return;
      }

      if (
        action === "offers" &&
        typeof parts[3] === "string" &&
        parts[3].length > 0 &&
        (parts[4] === "accept" || parts[4] === "reject") &&
        parts.length === 5 &&
        method === "POST"
      ) {
        const offerId = parts[3];
        const offerAction = parts[4];
        const body = await readJsonBody(request);
        const host = await getOrLoadHost(songId);

        if (offerAction === "accept") {
          const outcome = host.controller.acceptOffer(offerId);
          if (outcome.ok) {
            await host.flushTrace();
          }
          const sessionPayload = await buildSongSessionPayload(host);
          sendJson(response, {
            ...sessionPayload,
            ...outcome,
          });
          return;
        }

        const outcome = host.controller.rejectOffer(
          offerId,
          typeof body.reason === "string" ? body.reason : undefined,
        );
        await host.flushTrace();
        const sessionPayload = await buildSongSessionPayload(host);
        sendJson(response, {
          ...sessionPayload,
          ...outcome,
        });
        return;
      }

      if (action === "export" && parts.length === 3 && method === "POST") {
        const { signal, cleanup } = disconnectSignal(request, response);
        try {
          const body = await readJsonBody(request);
          if (signal.aborted || response.destroyed) return;
          const host = await getOrLoadHost(songId, signal);
          if (signal.aborted || response.destroyed) return;
          const exported = await handleExportRequest(host, body, signal);
          if (!signal.aborted && !response.destroyed) {
            sendJson(response, exported);
          }
        } catch (error) {
          if (signal.aborted || response.destroyed) return;
          throw error;
        } finally {
          cleanup();
        }
        return;
      }
    }

    const notFound = new Error("Unknown Tempo API endpoint.");
    notFound.name = "NotFoundError";
    throw notFound;
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    try {
      await handleInternal(request, response, url);
    } catch (error) {
      throw sanitizeTempoHttpError(error);
    }
  }

  async function close(): Promise<void> {
    const active = Array.from(hosts.values());
    hosts.clear();
    await Promise.allSettled(active.map((h) => h.flushTrace()));
    for (const host of active) {
      host.controller.close();
    }
    await daemon.close();
  }

  return {
    daemon,
    store,
    get activeHostCount() {
      return hosts.size;
    },
    ensureInitialWorkspace,
    openWorkspace: async (dir: string, stateDir?: string) =>
      formatWorkspaceResponse(await openWorkspaceInternal(dir, stateDir)),
    handle,
    close,
  };
}

export function createTempoMiddleware(options?: TempoServiceOptions) {
  const service = createTempoService(options);
  const middleware = localService(TEMPO_API_PREFIX, (req, res, url) =>
    service.handle(req, res, url),
  );
  return Object.assign(middleware, { service });
}

export function tempoPlugin(options?: TempoServiceOptions): Plugin {
  let activeService: TempoService | null = null;
  const install = (server: {
    middlewares: Connect.Server;
    httpServer?: { once: (ev: string, fn: () => void) => void } | null;
  }) => {
    const svc = activeService ?? createTempoService(options);
    activeService = svc;
    server.middlewares.use(
      localService(TEMPO_API_PREFIX, (req, res, url) => svc.handle(req, res, url)),
    );
    server.httpServer?.once("close", () => {
      if (activeService === svc) activeService = null;
      void svc.close();
    });
  };

  return {
    name: "inspector-tempo",
    configureServer: install,
    configurePreviewServer: install,
    async closeBundle() {
      const svc = activeService;
      activeService = null;
      if (svc) await svc.close();
    },
  };
}

export type { AuditionFilter } from "./daemon-client.ts";
export { AUDITION_FILTERS, resolvePythonCommand, TempoDaemonClient } from "./daemon-client.ts";
export type {
  AudioSourceFingerprint,
  TempoSongSummary,
  TempoWorkspaceManifest,
  WorkspaceTarget,
} from "./workspace-store.ts";
export {
  assertContainedInStateDir,
  assertValidSongId,
  computeAudioFingerprint,
  isValidSongId,
  SUPPORTED_AUDIO_EXTENSIONS,
  TempoWorkspaceStore,
  TraceWriter,
  VALID_SONG_ID_RE,
} from "./workspace-store.ts";
