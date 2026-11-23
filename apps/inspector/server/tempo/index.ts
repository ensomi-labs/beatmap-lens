import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  computeGridFit,
  DEFAULT_TRIGGER_POLICY,
  EDIT_OP_KINDS,
  type EditOp,
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
import { localService, readBody, sendJson } from "../local-service.ts";
import {
  AUDITION_FILTERS,
  type AuditionFilter,
  TempoDaemonClient,
  TempoTimingProvider,
} from "./daemon-client.ts";
import {
  slugifySongStem,
  type TempoSongSummary,
  type TempoWorkspaceManifest,
  TempoWorkspaceStore,
} from "./workspace-store.ts";

export const TEMPO_API_PREFIX = "/api/tempo";
export const MAX_AUDITION_SPAN_SEC = 60;

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const EDIT_OP_SET = new Set<string>(EDIT_OP_KINDS);
const UNDOABLE_USER_TYPES = new Set(["edit", "offer_accept", "offer_reject", "ready"]);

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
};

export interface TempoServiceOptions {
  /** Initial folder workspace to open automatically (`TEMPO_WORKSPACE_DIR`). */
  workspaceDir?: string;
  /** Optional custom state directory (`TEMPO_STATE_DIR`), defaulting to `<workspaceDir>/.ensomi-tempo/`. */
  stateDir?: string;
  /** Fallback workspace folder created automatically if user uploads/imports before opening a folder. */
  defaultImportWorkspaceDir?: string;
  /** Custom allowed bind host when CLI server runs with `--host`. */
  allowedHost?: string;
  /** Optional `TriggerPolicy` overrides for `SessionController` instances. */
  triggerPolicy?: TriggerPolicyOverride;
  /** Environment overrides forwarded to `TempoDaemonClient`. */
  env?: NodeJS.ProcessEnv;
  maxCachedTracks?: number;
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
}

class SongSessionHost {
  readonly songId: string;
  readonly tracePath: string;
  readonly controller: SessionController;
  private enqueuedCount: number;
  private readonly traceWriter: TempoWorkspaceStore["traceWriter"];
  readonly redoStack: string[] = [];

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
    this.enqueuedCount = options.persistedCount;
    this.traceWriter = options.traceWriter;
  }

  /**
   * Synchronously captures any newly committed `TraceEvent` slice from `SessionController`
   * in exact ascending `seq` order and appends it through the per-file mutex `TraceWriter`.
   */
  flushTrace(): Promise<void> {
    const allEvents = this.controller.getState().events;
    if (allEvents.length <= this.enqueuedCount) {
      return Promise.resolve();
    }
    const delta = allEvents.slice(this.enqueuedCount);
    this.enqueuedCount = allEvents.length;
    return this.traceWriter.append(this.tracePath, delta).then(() => {});
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

function assertTempoLocalRequest(
  request: IncomingMessage,
  url: URL,
  allowedHost?: string,
  isWriteOrConfig = false,
): void {
  const allowedAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  const allowedHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (allowedHost && allowedHost !== "0.0.0.0" && allowedHost !== "::") {
    allowedAddresses.add(allowedHost);
    allowedHostnames.add(allowedHost);
  }
  const remote = request.socket.remoteAddress ?? "";
  const socketAllowed =
    allowedHost === "0.0.0.0" || allowedHost === "::" || allowedAddresses.has(remote);
  const hostAllowed =
    allowedHost === "0.0.0.0" || allowedHost === "::" || allowedHostnames.has(url.hostname);

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

  if (isWriteOrConfig) {
    const contentType = (request.headers["content-type"] ?? "").toLowerCase();
    const isSimpleFormPost =
      contentType.startsWith("application/x-www-form-urlencoded") ||
      contentType.startsWith("text/plain");
    const isMultipartWithoutOriginOrHeader =
      contentType.startsWith("multipart/form-data") &&
      request.headers["x-beatmap-lens-local"] !== "1" &&
      request.headers.origin !== url.origin &&
      request.headers["sec-fetch-site"] !== "same-origin";

    if (isSimpleFormPost || isMultipartWithoutOriginOrHeader) {
      throw new DOMException(
        "Cross-site form submissions are not permitted on the local Tempo service.",
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
    const err = new Error(`Audio file not found: ${filePath}`);
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
  ensureInitialWorkspace(): Promise<TempoWorkspaceManifest | null>;
  openWorkspace(dir: string, stateDir?: string): Promise<TempoWorkspaceResponse>;
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void>;
  close(): Promise<void>;
}

export function createTempoService(options: TempoServiceOptions = {}): TempoService {
  const env = options.env ?? process.env;
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

  function closeHostsForOtherStateDir(nextStateDir: string | null): void {
    for (const [key, host] of hosts) {
      if (!nextStateDir || !key.startsWith(`${nextStateDir}::`)) {
        host.controller.close();
        hosts.delete(key);
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
    closeHostsForOtherStateDir(store.currentStateDir);
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

  async function ensureWorkspaceForImport(explicitDir?: string): Promise<TempoWorkspaceManifest> {
    if (explicitDir) {
      return await openWorkspaceInternal(explicitDir, configuredStateDir);
    }
    const current = await ensureInitialWorkspace();
    if (current) return current;
    return await openWorkspaceInternal(defaultImportDir, configuredStateDir, true);
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

  async function getOrLoadHost(songId: string): Promise<SongSessionHost> {
    await ensureInitialWorkspace();
    const stateDir = store.currentStateDir;
    if (!stateDir) {
      throw new Error("Open a Tempo workspace folder first.");
    }
    store.getSong(songId);
    const key = `${stateDir}::${songId}`;
    const existing = hosts.get(key);
    if (existing && !existing.controller.isClosed()) {
      return existing;
    }

    const inflight = hostInitLocks.get(key);
    if (inflight) return await inflight;

    const loader = (async () => {
      try {
        const tracePath = store.tracePathFor(songId);
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
        return host;
      } finally {
        hostInitLocks.delete(key);
      }
    })();

    hostInitLocks.set(key, loader);
    return await loader;
  }

  async function buildSongSessionPayload(host: SongSessionHost): Promise<TempoSongSessionPayload> {
    const liveState = host.controller.getState();
    const serialized = serializeState(liveState);
    const gridFit = computeGridFit(liveState.sounds, liveState.beats, liveState.segments);
    const inboxSpans = rankInboxSpans(liveState);
    const redLineProjection = projectRedLines(liveState.beats, liveState.segments);
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
    };
  }

  async function openSongSession(
    songId: string,
    signal?: AbortSignal,
  ): Promise<TempoSongSessionPayload> {
    await ensureInitialWorkspace();
    const song = await store.setActiveSong(songId);
    const host = await getOrLoadHost(songId);
    const stateBefore = host.controller.getState();

    const hasDraftLoaded = stateBefore.events.some(
      (ev) => !stateBefore.retractedEventIds.has(ev.id) && ev.type === "draft_loaded",
    );
    const hasUserMutations = stateBefore.events.some(
      (ev) => !stateBefore.retractedEventIds.has(ev.id) && ev.type === "edit",
    );

    if (!stateBefore.audio) {
      const prepared = await daemon.prepare(song.audioPath, signal);
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
      await host.controller.analyze(signal);
      await host.flushTrace();
    } else {
      // Warm PCM cache in the background without blocking cached `.jsonl` reopen!
      void daemon.prepare(song.audioPath).catch(() => {});
    }

    return await buildSongSessionPayload(host);
  }

  async function renderCachedAudition(
    song: TempoSongSummary,
    t0: number,
    t1: number,
    filter: AuditionFilter,
    signal?: AbortSignal,
  ): Promise<string> {
    if (t0 < 0 || t1 <= t0 || t1 - t0 > MAX_AUDITION_SPAN_SEC) {
      throw new Error(`Choose an audition span between 0 and ${MAX_AUDITION_SPAN_SEC} seconds.`);
    }
    const fileInfo = await stat(song.audioPath);
    const cacheKey = createHash("sha1")
      .update(
        [
          song.audioPath,
          String(fileInfo.mtimeMs),
          String(fileInfo.size),
          t0.toFixed(4),
          t1.toFixed(4),
          filter,
        ].join("\0"),
      )
      .digest("hex");

    const cacheDir = store.auditionCacheDir();
    await mkdir(cacheDir, { recursive: true });
    const outPath = join(cacheDir, `${cacheKey}.wav`);
    if (!existsSync(outPath)) {
      await daemon.renderAudition(
        {
          audioPath: song.audioPath,
          startSec: t0,
          endSec: t1,
          filter,
          outputPath: outPath,
        },
        signal,
      );
    }
    return outPath;
  }

  async function handleUploadRequest(
    request: IncomingMessage,
    url: URL,
  ): Promise<Record<string, unknown>> {
    await ensureWorkspaceForImport(url.searchParams.get("dir") ?? undefined);
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
          const uploaded = await store.importUploadedBuffer(fileObj.name, bytes);
          importedSongIds.push(uploaded.song.songId);
          lastSong = uploaded.song;
          latestWorkspace = uploaded.workspace;
        }
      }

      if (importedSongIds.length === 0 || !latestWorkspace || !lastSong) {
        throw new Error("Multipart upload contained no supported audio files.");
      }

      const firstSongId = importedSongIds[0] ?? lastSong.songId;
      await store.setActiveSong(firstSongId);
      const refreshed = store.getSnapshot() as TempoWorkspaceManifest;
      const firstSong = store.getSong(firstSongId);
      return {
        ...formatWorkspaceResponse(refreshed),
        workspace: formatWorkspaceResponse(refreshed),
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

    const { workspace, song } = await store.importUploadedStream(nameParam, request);
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
      const state = host.controller.getState();
      let targetId: string | null = null;
      for (let i = state.events.length - 1; i >= 0; i -= 1) {
        const ev = state.events[i];
        if (!ev) continue;
        if (state.retractedEventIds.has(ev.id)) continue;
        if (UNDOABLE_USER_TYPES.has(ev.type)) {
          targetId = ev.id;
          break;
        }
      }
      if (!targetId) {
        throw new Error("Nothing to undo.");
      }
      const res = host.controller.retract(
        targetId,
        typeof body.reason === "string" ? body.reason : undefined,
      );
      host.redoStack.push(res.event.id);
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
          typeof body.reason === "string" ? body.reason : "Redo",
        );
        committedEvent = res.event;
      } else {
        const state = host.controller.getState();
        let retractEventId: string | undefined;
        while (host.redoStack.length > 0) {
          const candidate = host.redoStack.pop();
          if (candidate && !state.retractedEventIds.has(candidate)) {
            retractEventId = candidate;
            break;
          }
        }
        if (!retractEventId) {
          for (let i = state.events.length - 1; i >= 0; i -= 1) {
            const ev = state.events[i];
            if (ev && ev.type === "retract" && !state.retractedEventIds.has(ev.id)) {
              retractEventId = ev.id;
              break;
            }
          }
        }
        if (!retractEventId) {
          throw new Error("Nothing to redo.");
        }
        const res = host.controller.retract(retractEventId, "Redo");
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
      if (typeof target === "string" || typeof target === "number") {
        host.redoStack.push(res.event.id);
      }
      committedEvent = res.event;
    } else if (body.action === "ready" || typeof body.ready === "boolean") {
      const wantReady = body.ready === undefined ? true : Boolean(body.ready);
      const currentState = host.controller.getState();
      if (wantReady) {
        const res = host.controller.markReady(
          typeof body.notes === "string" ? body.notes : undefined,
        );
        host.redoStack.length = 0;
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
      host.redoStack.length = 0;
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
      const projection = projectRedLines(state.beats, state.segments);
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

      const clipsDir = store.clipsDir();
      await mkdir(clipsDir, { recursive: true });
      const clipFileName = `${song.songId}-${t0.toFixed(3)}-${t1.toFixed(3)}-${filter}-${randomUUID().slice(0, 6)}.wav`;
      const outputPath = join(clipsDir, clipFileName);
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
        filter: rendered.filter,
        sampleRate: rendered.sampleRate,
        channels: rendered.channels,
      };
    }

    throw new Error(`Unsupported export format "${format}". Expected "osu", "jsonl", or "clip".`);
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const subPath = url.pathname.slice(TEMPO_API_PREFIX.length).replace(/^\/+/, "");
    const parts = subPath ? subPath.split("/").map((p) => decodeURIComponent(p)) : [];

    const isMutatingOrDirSwitch =
      method !== "GET" && method !== "HEAD" ? true : url.searchParams.has("dir");
    assertTempoLocalRequest(request, url, options.allowedHost, isMutatingOrDirSwitch);

    // Workspace endpoints
    if (parts[0] === "workspace" && parts.length === 1 && method === "GET") {
      const dirQuery = url.searchParams.get("dir");
      const stateDirQuery = url.searchParams.get("stateDir") ?? undefined;
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
      const stateDir = typeof body.stateDir === "string" ? body.stateDir : undefined;
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
      await ensureWorkspaceForImport(typeof body.dir === "string" ? body.dir : undefined);
      if (!Array.isArray(body.paths)) {
        throw new Error("Provide { paths: string[] } to import local audio files or folders.");
      }
      const { workspace, importedSongIds } = await store.importPaths({
        paths: body.paths as string[],
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
      const songId = parts[1];
      const action = parts[2];

      if (action === undefined && method === "GET") {
        const host = await getOrLoadHost(songId);
        sendJson(response, await buildSongSessionPayload(host));
        return;
      }

      if (action === "open" && parts.length === 3 && method === "POST") {
        await readBody(request);
        const { signal, cleanup } = disconnectSignal(request, response);
        try {
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
        const mime =
          AUDIO_MIME_BY_EXT[extname(song.audioPath).toLowerCase()] ?? "application/octet-stream";
        await streamFileWithRange(request, response, song.audioPath, mime);
        return;
      }

      if (action === "audition" && parts.length === 3 && (method === "GET" || method === "HEAD")) {
        await ensureInitialWorkspace();
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
        const { signal, cleanup } = disconnectSignal(request, response);
        let wavPath: string;
        try {
          wavPath = await renderCachedAudition(song, t0, t1, filter, signal);
        } catch (error) {
          cleanup();
          if (signal.aborted || response.destroyed) return;
          throw error;
        }
        cleanup();
        if (signal.aborted || response.destroyed) return;
        await streamFileWithRange(request, response, wavPath, "audio/wav", {
          "X-Audition-Only": "listening view; timestamps stay on the original mix",
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
        const clipsRoot = resolve(store.clipsDir());
        const targetClip = resolve(clipsRoot, basename(parts[3]));
        if (!targetClip.startsWith(`${clipsRoot}${sep}`)) {
          throw new DOMException("Invalid clip path.", "NotAllowedError");
        }
        await streamFileWithRange(request, response, targetClip, "audio/wav");
        return;
      }

      if (action === "edit" && parts.length === 3 && method === "POST") {
        const body = await readJsonBody(request);
        const host = await getOrLoadHost(songId);
        sendJson(response, await handleEditRequest(host, body));
        return;
      }

      if (action === "snaps" && parts.length === 3 && method === "POST") {
        const body = await readJsonBody(request);
        const timeSec = parseFiniteNumber(body.timeSec, "timeSec");
        const windowSec =
          body.windowSec !== undefined ? parseFiniteNumber(body.windowSec, "windowSec") : 0.12;
        const immediate = body.immediate === undefined ? true : Boolean(body.immediate);

        const host = await getOrLoadHost(songId);
        const song = store.getSong(songId);

        // If the session does not have audio bound yet, bind metadata without running heavy analyze,
        // or query the CPU fast-path directly when completely unopened so ZERO trace lines are written!
        const { signal, cleanup } = disconnectSignal(request, response);
        try {
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
        const body = await readJsonBody(request);
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

        const host = await getOrLoadHost(songId);
        if (!host.controller.getState().audio) {
          const song = store.getSong(songId);
          const prepared = await daemon.prepare(song.audioPath);
          await host.controller.bindAudio({
            songId,
            durationSec: prepared.durationSec,
            sampleRate: prepared.sampleRate,
            clock: "source-audio-sec",
            decoder: "ffmpeg-f32le",
          });
          await host.flushTrace();
        }

        const { signal, cleanup } = disconnectSignal(request, response);
        const recomputePromise = host.controller.recompute({ scope, reason });
        // Capture synchronous `signal` event generation immediately so disconnect only aborts THIS generation!
        const myGeneration = host.controller.getLayerState("heavy_recompute").generation;
        void host.flushTrace().catch(() => {});

        const onDisconnectAbort = () => {
          const cur = host.controller.getLayerState("heavy_recompute");
          if (cur.inFlight && cur.generation === myGeneration) {
            host.controller.abortLayer("heavy_recompute", "Client disconnected");
          }
        };
        signal.addEventListener("abort", onDisconnectAbort, { once: true });

        try {
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
          await host.flushTrace().catch(() => {});
          if (signal.aborted || response.destroyed) return;
          throw error;
        } finally {
          signal.removeEventListener("abort", onDisconnectAbort);
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
            host.redoStack.length = 0;
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
        host.redoStack.length = 0;
        await host.flushTrace();
        const sessionPayload = await buildSongSessionPayload(host);
        sendJson(response, {
          ...sessionPayload,
          ...outcome,
        });
        return;
      }

      if (action === "export" && parts.length === 3 && method === "POST") {
        const body = await readJsonBody(request);
        const host = await getOrLoadHost(songId);
        const { signal, cleanup } = disconnectSignal(request, response);
        try {
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

    const notFound = new Error(`Unknown Tempo endpoint: ${method} ${url.pathname}`);
    notFound.name = "NotFoundError";
    throw notFound;
  }

  async function close(): Promise<void> {
    for (const host of hosts.values()) {
      host.controller.close();
    }
    hosts.clear();
    await daemon.close();
  }

  return {
    daemon,
    store,
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
export type { TempoSongSummary, TempoWorkspaceManifest } from "./workspace-store.ts";
export { SUPPORTED_AUDIO_EXTENSIONS, TempoWorkspaceStore, TraceWriter } from "./workspace-store.ts";
