import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream, existsSync, realpathSync } from "node:fs";
import {
  appendFile,
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertTraceEventEnvelope,
  canonicalJson,
  foldTrace,
  rankInboxSpans,
  type SessionState,
  type Span,
  type SpanPriority,
  serializeTraceNdjson,
  type TraceEvent,
} from "ensomi";
import { fullPath } from "../local-service.ts";

export const SUPPORTED_AUDIO_EXTENSIONS = [
  ".mp3",
  ".ogg",
  ".wav",
  ".flac",
  ".m4a",
  ".opus",
] as const;

const AUDIO_EXT_SET = new Set<string>(SUPPORTED_AUDIO_EXTENSIONS);

export const VALID_SONG_ID_RE = /^[a-z0-9][a-z0-9_-]{0,120}$/;

export function isValidSongId(songId: string): boolean {
  return typeof songId === "string" && VALID_SONG_ID_RE.test(songId);
}

export function assertValidSongId(songId: string): string {
  if (!isValidSongId(songId)) {
    throw new Error("Invalid song identifier.");
  }
  return songId;
}

export function isSupportedAudioFileName(fileName: string): boolean {
  if (!fileName || fileName.startsWith(".")) return false;
  return AUDIO_EXT_SET.has(extname(fileName).toLowerCase());
}

export interface AudioSourceFingerprint {
  audioSizeBytes: number;
  audioSha256: string;
  audioSha256Sample: string;
}

export async function computeAudioFingerprint(audioPath: string): Promise<AudioSourceFingerprint> {
  const canonicalPath = await realpath(audioPath);
  const info = await stat(canonicalPath);
  if (!info.isFile()) {
    throw new Error("Audio source path is not a regular file.");
  }
  const hasher = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(canonicalPath);
    stream.on("data", (chunk: Buffer | string) => {
      hasher.update(chunk);
    });
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash());
  });
  const digest = hasher.digest("hex");
  return {
    audioSizeBytes: info.size,
    audioSha256: digest,
    audioSha256Sample: digest,
  };
}

/**
 * Verifies that `targetPath` (existing or about-to-be-created) stays strictly inside
 * `stateDir`, refusing traversal and refusing symlinks escaping `stateDir` via `lstat` + `realpath`.
 */
export async function assertContainedInStateDir(
  stateDir: string,
  targetPath: string,
): Promise<string> {
  const canonicalStateDir = await realpath(stateDir);
  const resolved = resolve(targetPath);
  const rel = relative(canonicalStateDir, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new DOMException("Path escapes Tempo state directory.", "NotAllowedError");
  }

  const parts = rel.split(sep).filter(Boolean);
  let cursor = canonicalStateDir;
  for (const part of parts) {
    cursor = join(cursor, part);
    let lst: Awaited<ReturnType<typeof lstat>>;
    try {
      lst = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }
    if (lst.isSymbolicLink()) {
      const targetReal = await realpath(cursor).catch(() => null);
      if (
        !targetReal ||
        (targetReal !== canonicalStateDir && !targetReal.startsWith(`${canonicalStateDir}${sep}`))
      ) {
        throw new DOMException(
          "Refusing symlink escaping Tempo state directory.",
          "NotAllowedError",
        );
      }
    }
  }

  if (existsSync(resolved)) {
    const finalReal = await realpath(resolved).catch(() => null);
    if (
      !finalReal ||
      (finalReal !== canonicalStateDir && !finalReal.startsWith(`${canonicalStateDir}${sep}`))
    ) {
      throw new DOMException("Path escapes Tempo state directory.", "NotAllowedError");
    }
  }

  return resolved;
}

export interface TempoSongSummary {
  songId: string;
  title: string;
  fileName: string;
  audioPath: string;
  audioSizeBytes: number;
  audioSha256: string;
  audioSha256Sample: string;
  durationSec: number | null;
  analyzed: boolean;
  segmentCount: number;
  keptSegmentCount: number;
  inboxCount: number;
  highestPriority: SpanPriority | null;
  ready: boolean;
  updatedAtMs: number;
}

export interface TempoWorkspaceManifest {
  schemaVersion: 1;
  workspaceDir: string;
  activeSongId: string | null;
  songs: TempoSongSummary[];
}

export interface WorkspaceTarget {
  workspaceDir: string;
  stateDir: string;
}

export interface TraceAppendResult {
  appended: number;
  skipped: number;
}

interface InspectedTrace {
  events: TraceEvent[];
  needsLeadingNewline: boolean;
  truncateBytes?: number;
}

function assertNotTimingFile(path: string): void {
  const lower = basename(path).toLowerCase();
  if (lower.endsWith(".timing.marks.jsonl") || lower.endsWith(".timing.notes.jsonl")) {
    throw new Error("Refusing to open or write a Timing marks/notes file as a Tempo trace.");
  }
}

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
    const line = lines[i];
    if (line === undefined) continue;
    const isLast = i === lines.length - 1;
    const lineNum = i + 1;
    if (line.trim().length === 0) {
      if (isLast) break;
      throw new Error(`Invalid Tempo trace file: empty line at line ${lineNum}.`);
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
        `Invalid Tempo trace file at line ${lineNum}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const event = assertTraceEventEnvelope(parsed);
    if (prevSeq >= 0 && event.seq <= prevSeq) {
      throw new Error(
        `Invalid Tempo trace file at line ${lineNum}: non-monotonic seq ${event.seq} after ${prevSeq}.`,
      );
    }
    if (seenIds.has(event.id)) {
      throw new Error("Invalid Tempo trace file: duplicate event identifier.");
    }
    seenIds.add(event.id);
    prevSeq = event.seq;
    events.push(event);
  }

  return { events, needsLeadingNewline: events.length > 0 && !hasTrailingNewline };
}

function validateIncomingBatch(events: readonly TraceEvent[]): TraceEvent[] {
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
      throw new Error("Incoming trace events contain duplicate event identifier.");
    }
    seenIds.add(event.id);
    prevSeq = event.seq;
    validated.push(event);
  }
  return validated;
}

/**
 * Mutex-serialized, crash-safe per-song `.jsonl` trace writer.
 * Validates `ensomi` `0.2` envelopes, enforces `stateDir` containment, heals torn crash tails,
 * guarantees newline termination, and prevents concurrent saves/edits from interleaving.
 */
export class TraceWriter {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly getStateDir: (() => string | null) | undefined;

  constructor(getStateDir?: () => string | null) {
    this.getStateDir = getStateDir;
  }

  private async verifyPath(path: string, expectedStateDir?: string | null): Promise<string> {
    assertNotTimingFile(path);
    const activeStateDir = expectedStateDir ?? this.getStateDir?.() ?? null;
    if (activeStateDir) {
      return await assertContainedInStateDir(activeStateDir, path);
    }
    const resolved = resolve(path);
    try {
      const lst = await lstat(resolved);
      if (lst.isSymbolicLink()) {
        const parentReal = await realpath(dirname(resolved));
        const targetReal = await realpath(resolved).catch(() => null);
        if (!targetReal?.startsWith(`${parentReal}${sep}`)) {
          throw new DOMException("Refusing symlink trace target.", "NotAllowedError");
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return resolved;
  }

  append(
    path: string,
    events: readonly TraceEvent[],
    expectedStateDir?: string | null,
  ): Promise<TraceAppendResult> {
    let incoming: TraceEvent[];
    try {
      assertNotTimingFile(path);
      incoming = validateIncomingBatch(events);
    } catch (error) {
      return Promise.reject(error);
    }
    if (incoming.length === 0) return Promise.resolve({ appended: 0, skipped: 0 });

    const key = resolve(path);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async (): Promise<TraceAppendResult> => {
        const safePath = await this.verifyPath(path, expectedStateDir);
        let raw = "";
        try {
          raw = await readFile(safePath, "utf8");
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
              throw new Error(`Conflicting trace event for seq ${ev.seq} with different content.`);
            }
            skipped += 1;
            continue;
          }
          if (existingBySeq || existingById) {
            throw new Error(
              `Conflicting trace writer: seq ${ev.seq} conflicts with existing trace.`,
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

        if (inspected.truncateBytes !== undefined && existsSync(safePath)) {
          await truncate(safePath, inspected.truncateBytes);
        }
        if (toAppend.length === 0) return { appended: 0, skipped };

        await mkdir(dirname(safePath), { recursive: true });
        await this.verifyPath(safePath, expectedStateDir);
        const serialized = serializeTraceNdjson(toAppend);
        const payload = inspected.needsLeadingNewline ? `\n${serialized}` : serialized;
        await appendFile(safePath, payload, "utf8");
        return { appended: toAppend.length, skipped };
      });

    this.tails.set(key, next);
    next.then(
      () => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      },
      () => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      },
    );
    return next;
  }

  async read(path: string, expectedStateDir?: string | null): Promise<TraceEvent[]> {
    const key = resolve(path);
    const pending = this.tails.get(key);
    if (pending) await pending.catch(() => {});
    const safePath = await this.verifyPath(path, expectedStateDir);
    let raw = "";
    try {
      raw = await readFile(safePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const inspected = inspectTraceContent(raw, true);
    if (inspected.truncateBytes !== undefined) {
      await truncate(safePath, inspected.truncateBytes).catch(() => {});
    }
    return inspected.events;
  }
}

export function slugifySongStem(fileName: string): string {
  const stem = basename(fileName, extname(fileName));
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "track";
}

export function deriveSongId(workspaceDir: string, audioPath: string): string {
  let canonicalWs = resolve(workspaceDir);
  try {
    canonicalWs = realpathSync(canonicalWs);
  } catch {}
  let canonicalAudio = resolve(audioPath);
  try {
    canonicalAudio = realpathSync(canonicalAudio);
  } catch {}
  const fileName = basename(canonicalAudio);
  const slug = slugifySongStem(fileName);
  const isInsideWorkspace =
    canonicalAudio.startsWith(`${canonicalWs}${sep}`) && dirname(canonicalAudio) === canonicalWs;
  const canonicalEntryKey = isInsideWorkspace
    ? `rel:${relative(canonicalWs, canonicalAudio)}`
    : `abs:${canonicalAudio}`;
  const shortHash = createHash("sha1")
    .update(`${canonicalWs}\0${canonicalEntryKey}`)
    .digest("hex")
    .slice(0, 8);
  return `${slug}-${shortHash}`;
}

export function sanitizeAudioUploadName(rawName: string): string {
  const base = basename(rawName.replaceAll("\\", "/").trim())
    .replace(/^\.+/, "")
    .replace(/(?:\p{Cc}|[<>:"/\\|?*])+/gu, "_")
    .trim();
  if (!base) {
    throw new Error("Provide a valid audio filename.");
  }
  const ext = extname(base).toLowerCase();
  if (!AUDIO_EXT_SET.has(ext)) {
    throw new Error(
      `Unsupported audio format "${ext || base}". Supported formats: ${SUPPORTED_AUDIO_EXTENSIONS.join(", ")}.`,
    );
  }
  const stem = basename(base, extname(base)).trim() || "track";
  return `${stem}${ext}`;
}

function highestInboxPriority(inboxSpans: readonly Span[]): SpanPriority | null {
  if (inboxSpans.some((s) => s.priority === "high")) return "high";
  if (inboxSpans.some((s) => s.priority === "medium")) return "medium";
  if (inboxSpans.some((s) => s.priority === "low")) return "low";
  return null;
}

export function summarizeSongFromState(
  base: TempoSongSummary,
  state: SessionState,
  precomputedInbox?: readonly Span[],
  nowMs = Date.now(),
): TempoSongSummary {
  const inbox = precomputedInbox ?? rankInboxSpans(state);
  const hasDraftEvent = state.events.some(
    (ev) => !state.retractedEventIds.has(ev.id) && ev.type === "draft_loaded",
  );
  const analyzed = hasDraftEvent || state.beats.size > 0 || state.sounds.size > 0;
  return {
    ...base,
    durationSec: state.durationSec > 0 ? state.durationSec : base.durationSec,
    analyzed,
    segmentCount: state.segments.length,
    keptSegmentCount: state.segments.filter((s) => s.kept).length,
    inboxCount: inbox.length,
    highestPriority: highestInboxPriority(inbox),
    ready: state.ready,
    updatedAtMs: nowMs,
  };
}

function sortSongsDeterministically(songs: TempoSongSummary[]): TempoSongSummary[] {
  return songs
    .slice()
    .sort(
      (a, b) =>
        a.fileName.localeCompare(b.fileName, "en", { numeric: true, sensitivity: "base" }) ||
        a.songId.localeCompare(b.songId),
    );
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(
    dir,
    `.${basename(filePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function copyFileExclusiveWithRetry(
  srcPath: string,
  dir: string,
  sanitizedName: string,
): Promise<string> {
  const ext = extname(sanitizedName);
  const stem = basename(sanitizedName, ext);
  let counter = 1;
  while (true) {
    const fileName = counter === 1 ? sanitizedName : `${stem}-${counter}${ext}`;
    const candidate = join(dir, fileName);
    try {
      await copyFile(srcPath, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        counter += 1;
        continue;
      }
      throw error;
    }
  }
}

async function publishTempFileExclusiveWithRetry(
  tempPath: string,
  dir: string,
  sanitizedName: string,
): Promise<string> {
  const ext = extname(sanitizedName);
  const stem = basename(sanitizedName, ext);
  let counter = 1;
  try {
    while (true) {
      const fileName = counter === 1 ? sanitizedName : `${stem}-${counter}${ext}`;
      const candidate = join(dir, fileName);
      try {
        await link(tempPath, candidate);
        await unlink(tempPath);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          counter += 1;
          continue;
        }
        throw error;
      }
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

function isValidPersistedSummaryCandidate(
  entry: unknown,
): entry is Partial<TempoSongSummary> & { songId: string; audioPath: string } {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<TempoSongSummary>;
  if (typeof candidate.songId !== "string" || !isValidSongId(candidate.songId)) return false;
  if (typeof candidate.audioPath !== "string" || !candidate.audioPath.trim()) return false;
  if (!isSupportedAudioFileName(basename(candidate.audioPath))) return false;
  if (
    candidate.fileName !== undefined &&
    (typeof candidate.fileName !== "string" || !isSupportedAudioFileName(candidate.fileName))
  ) {
    return false;
  }
  return true;
}

/**
 * Folder-backed `.ensomi-tempo/` multi-song workspace store.
 */
export class TempoWorkspaceStore {
  private workspaceDir: string | null = null;
  private stateDir: string | null = null;
  private manifest: TempoWorkspaceManifest | null = null;
  private opChain: Promise<unknown> = Promise.resolve();
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly traceEpochs = new Map<string, number>();
  readonly traceWriter: TraceWriter;

  constructor() {
    this.traceWriter = new TraceWriter(() => this.stateDir);
  }

  private withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.catch(() => {}).then(fn);
    this.opChain = next;
    return next;
  }

  get isOpen(): boolean {
    return this.workspaceDir !== null && this.stateDir !== null && this.manifest !== null;
  }

  get currentWorkspaceDir(): string | null {
    return this.workspaceDir;
  }

  get currentStateDir(): string | null {
    return this.stateDir;
  }

  captureTarget(): WorkspaceTarget {
    if (!this.workspaceDir || !this.stateDir) {
      throw new Error("Open a Tempo workspace folder first.");
    }
    return {
      workspaceDir: this.workspaceDir,
      stateDir: this.stateDir,
    };
  }

  getSnapshot(): TempoWorkspaceManifest | null {
    if (!this.manifest) return null;
    return {
      schemaVersion: 1,
      workspaceDir: this.manifest.workspaceDir,
      activeSongId: this.manifest.activeSongId,
      songs: this.manifest.songs.map((s) => ({ ...s })),
    };
  }

  getSong(songId: string): TempoSongSummary {
    assertValidSongId(songId);
    if (!this.manifest) {
      throw new Error("Open a Tempo workspace folder first.");
    }
    const found = this.manifest.songs.find((s) => s.songId === songId);
    if (!found) {
      const err = new Error("Requested song was not found in the open workspace.");
      err.name = "NotFoundError";
      throw err;
    }
    return { ...found };
  }

  tracePathFor(songId: string): string {
    assertValidSongId(songId);
    if (!this.stateDir) throw new Error("Open a Tempo workspace folder first.");
    this.getSong(songId);
    return join(this.stateDir, "traces", `${songId}.jsonl`);
  }

  clipsDir(): string {
    if (!this.stateDir) throw new Error("Open a Tempo workspace folder first.");
    return join(this.stateDir, "clips");
  }

  auditionCacheDir(): string {
    if (!this.stateDir) throw new Error("Open a Tempo workspace folder first.");
    return join(this.stateDir, ".cache", "audition");
  }

  async resolveContainedStatePath(...subSegments: string[]): Promise<string> {
    if (!this.stateDir) {
      throw new Error("Open a Tempo workspace folder first.");
    }
    const target = join(this.stateDir, ...subSegments);
    return await assertContainedInStateDir(this.stateDir, target);
  }

  private manifestPath(stateDir: string): string {
    return join(stateDir, "workspace.json");
  }

  private enqueueSave(manifest: TempoWorkspaceManifest, stateDir: string): Promise<void> {
    const snapshot: TempoWorkspaceManifest = {
      schemaVersion: 1,
      workspaceDir: manifest.workspaceDir,
      activeSongId: manifest.activeSongId,
      songs: manifest.songs.map((s) => ({ ...s })),
    };
    const next = this.writeChain
      .catch(() => {})
      .then(async () => {
        const safeManifestPath = await assertContainedInStateDir(
          stateDir,
          this.manifestPath(stateDir),
        );
        await atomicWriteJson(safeManifestPath, snapshot);
      });
    this.writeChain = next;
    return next;
  }

  private async loadOrCloneTargetManifest(
    target: WorkspaceTarget,
  ): Promise<TempoWorkspaceManifest> {
    if (this.stateDir === target.stateDir && this.manifest) {
      return {
        schemaVersion: 1,
        workspaceDir: this.manifest.workspaceDir,
        activeSongId: this.manifest.activeSongId,
        songs: this.manifest.songs.map((s) => ({ ...s })),
      };
    }
    const safeManifestPath = await assertContainedInStateDir(
      target.stateDir,
      this.manifestPath(target.stateDir),
    );
    try {
      const raw = await readFile(safeManifestPath, "utf8");
      const parsed = JSON.parse(raw) as TempoWorkspaceManifest;
      return {
        schemaVersion: 1,
        workspaceDir: parsed.workspaceDir || target.workspaceDir,
        activeSongId: parsed.activeSongId ?? null,
        songs: Array.isArray(parsed.songs) ? parsed.songs.map((s) => ({ ...s })) : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          schemaVersion: 1,
          workspaceDir: target.workspaceDir,
          activeSongId: null,
          songs: [],
        };
      }
      throw error;
    }
  }

  private async commitTargetManifest(
    target: WorkspaceTarget,
    nextManifest: TempoWorkspaceManifest,
  ): Promise<TempoWorkspaceManifest> {
    if (this.stateDir === target.stateDir) {
      this.manifest = nextManifest;
    }
    await this.enqueueSave(nextManifest, target.stateDir);
    return {
      schemaVersion: 1,
      workspaceDir: nextManifest.workspaceDir,
      activeSongId: nextManifest.activeSongId,
      songs: nextManifest.songs.map((s) => ({ ...s })),
    };
  }

  private bumpTraceEpoch(stateDir: string, songId: string): number {
    const key = `${stateDir}::${songId}`;
    const next = (this.traceEpochs.get(key) ?? 0) + 1;
    this.traceEpochs.set(key, next);
    return next;
  }

  getTraceEpoch(songId: string, explicitStateDir?: string | null): number {
    const dir = explicitStateDir ?? this.stateDir;
    if (!dir) return 0;
    return this.traceEpochs.get(`${dir}::${songId}`) ?? 0;
  }

  private async rotateSupersededTrace(
    stateDir: string,
    songId: string,
  ): Promise<string | undefined> {
    assertValidSongId(songId);
    this.bumpTraceEpoch(stateDir, songId);
    const tracePath = await assertContainedInStateDir(
      stateDir,
      join(stateDir, "traces", `${songId}.jsonl`),
    );
    if (!existsSync(tracePath)) return undefined;
    const backupPath = await assertContainedInStateDir(
      stateDir,
      `${tracePath}.superseded-${Date.now()}-${randomUUID().slice(0, 6)}.bak`,
    );
    await rename(tracePath, backupPath);
    return backupPath;
  }

  openWorkspace(
    dirInput: string,
    options?: { stateDir?: string; createIfMissing?: boolean },
  ): Promise<TempoWorkspaceManifest> {
    return this.withStoreLock(async () => {
      const resolvedInput = fullPath(dirInput);
      if (options?.createIfMissing) {
        await mkdir(resolvedInput, { recursive: true });
      }
      const info = await stat(resolvedInput);
      if (!info.isDirectory()) {
        throw new Error("Expected an audio workspace folder.");
      }
      const workspaceDir = await realpath(resolvedInput);
      const rawStateDir = options?.stateDir
        ? resolve(fullPath(options.stateDir))
        : join(workspaceDir, ".ensomi-tempo");

      await mkdir(rawStateDir, { recursive: true });
      const stateDir = await realpath(rawStateDir);
      await assertContainedInStateDir(stateDir, join(stateDir, "traces"));
      await assertContainedInStateDir(stateDir, join(stateDir, "clips"));
      await mkdir(join(stateDir, "traces"), { recursive: true });
      await mkdir(join(stateDir, "clips"), { recursive: true });

      let existingManifest: Partial<TempoWorkspaceManifest> | null = null;
      const safeManifestPath = await assertContainedInStateDir(
        stateDir,
        this.manifestPath(stateDir),
      );
      try {
        const rawJson = await readFile(safeManifestPath, "utf8");
        existingManifest = JSON.parse(rawJson) as Partial<TempoWorkspaceManifest>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const previousByPath = new Map<string, TempoSongSummary>();
      const previousById = new Map<string, TempoSongSummary>();
      for (const rawPrev of existingManifest?.songs ?? []) {
        if (!isValidPersistedSummaryCandidate(rawPrev)) continue;
        const prevCanonical = await realpath(rawPrev.audioPath).catch(() => null);
        if (!prevCanonical || !isSupportedAudioFileName(basename(prevCanonical))) continue;
        const prevStat = await stat(prevCanonical).catch(() => null);
        if (!prevStat?.isFile()) continue;
        const prevSha =
          typeof rawPrev.audioSha256 === "string" && rawPrev.audioSha256.length > 0
            ? rawPrev.audioSha256
            : (rawPrev.audioSha256Sample ?? "");
        const normalizedPrev = {
          ...rawPrev,
          audioPath: prevCanonical,
          audioSha256: prevSha,
          audioSha256Sample: prevSha,
        } as TempoSongSummary;
        previousByPath.set(prevCanonical, normalizedPrev);
        previousByPath.set(rawPrev.audioPath, normalizedPrev);
        previousById.set(rawPrev.songId, normalizedPrev);
      }

      const entries = await readdir(workspaceDir, { withFileTypes: true });
      const discoveredPaths = new Set<string>();
      const usedSongIds = new Set<string>();
      const reconciled: TempoSongSummary[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === ".ensomi-tempo") continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!isSupportedAudioFileName(entry.name)) continue;
        const candidatePath = join(workspaceDir, entry.name);
        const canonicalAudioPath = await realpath(candidatePath).catch(() => null);
        if (
          !canonicalAudioPath ||
          !isSupportedAudioFileName(basename(canonicalAudioPath)) ||
          discoveredPaths.has(canonicalAudioPath)
        ) {
          continue;
        }
        const entryStat = await stat(canonicalAudioPath).catch(() => null);
        if (!entryStat?.isFile()) continue;
        discoveredPaths.add(canonicalAudioPath);

        const prev = previousByPath.get(canonicalAudioPath) ?? previousByPath.get(candidatePath);
        const usablePrev = prev && !usedSongIds.has(prev.songId) ? prev : undefined;
        const summary = await this.buildOrReconcileSongSummary(
          workspaceDir,
          stateDir,
          canonicalAudioPath,
          entry.name,
          usablePrev,
          entryStat.mtimeMs,
        );
        usedSongIds.add(summary.songId);
        reconciled.push(summary);
      }

      // Preserve externally linked songs from workspace.json whose audio files still exist as regular files.
      for (const rawPrev of existingManifest?.songs ?? []) {
        if (!isValidPersistedSummaryCandidate(rawPrev)) continue;
        const prevCanonical = await realpath(rawPrev.audioPath).catch(() => null);
        if (
          !prevCanonical ||
          !isSupportedAudioFileName(basename(prevCanonical)) ||
          discoveredPaths.has(prevCanonical)
        ) {
          continue;
        }
        const insideWorkspace =
          prevCanonical.startsWith(`${workspaceDir}${sep}`) &&
          dirname(prevCanonical) === workspaceDir;
        if (insideWorkspace) continue;
        const extStat = await stat(prevCanonical).catch(() => null);
        if (!extStat?.isFile()) continue;
        const fileName = rawPrev.fileName || basename(prevCanonical);
        if (!isSupportedAudioFileName(fileName)) continue;
        if (usedSongIds.has(rawPrev.songId)) continue;
        discoveredPaths.add(prevCanonical);

        const summary = await this.buildOrReconcileSongSummary(
          workspaceDir,
          stateDir,
          prevCanonical,
          fileName,
          previousById.get(rawPrev.songId),
          extStat.mtimeMs,
        );
        usedSongIds.add(summary.songId);
        reconciled.push(summary);
      }

      const sortedSongs = sortSongsDeterministically(reconciled);
      const prevActive = existingManifest?.activeSongId ?? this.manifest?.activeSongId ?? null;
      const activeSongId =
        prevActive && isValidSongId(prevActive) && sortedSongs.some((s) => s.songId === prevActive)
          ? prevActive
          : (sortedSongs[0]?.songId ?? null);

      const nextManifest: TempoWorkspaceManifest = {
        schemaVersion: 1,
        workspaceDir,
        activeSongId,
        songs: sortedSongs,
      };

      this.workspaceDir = workspaceDir;
      this.stateDir = stateDir;
      this.manifest = nextManifest;
      await this.enqueueSave(nextManifest, stateDir);
      return this.getSnapshot() as TempoWorkspaceManifest;
    });
  }

  private async buildOrReconcileSongSummary(
    workspaceDir: string,
    stateDir: string,
    audioPath: string,
    fileName: string,
    existing: TempoSongSummary | undefined,
    fallbackUpdatedMs: number,
  ): Promise<TempoSongSummary> {
    const fingerprint = await computeAudioFingerprint(audioPath);
    const candidateId =
      existing && isValidSongId(existing.songId)
        ? existing.songId
        : deriveSongId(workspaceDir, audioPath);
    const songId = assertValidSongId(candidateId);
    const title = existing?.title ?? basename(fileName, extname(fileName));

    const prevDigest = existing?.audioSha256 || existing?.audioSha256Sample || "";
    const fingerprintMismatch =
      existing !== undefined &&
      prevDigest.length > 0 &&
      (existing.audioSizeBytes !== fingerprint.audioSizeBytes ||
        prevDigest !== fingerprint.audioSha256);

    if (fingerprintMismatch) {
      await this.rotateSupersededTrace(stateDir, songId);
    }

    const validExisting = fingerprintMismatch ? undefined : existing;

    const base: TempoSongSummary = {
      songId,
      title,
      fileName,
      audioPath,
      audioSizeBytes: fingerprint.audioSizeBytes,
      audioSha256: fingerprint.audioSha256,
      audioSha256Sample: fingerprint.audioSha256Sample,
      durationSec: validExisting?.durationSec ?? null,
      analyzed: validExisting?.analyzed ?? false,
      segmentCount: validExisting?.segmentCount ?? 0,
      keptSegmentCount: validExisting?.keptSegmentCount ?? 0,
      inboxCount: validExisting?.inboxCount ?? 0,
      highestPriority: validExisting?.highestPriority ?? null,
      ready: validExisting?.ready ?? false,
      updatedAtMs: validExisting?.updatedAtMs ?? Math.round(fallbackUpdatedMs),
    };

    const tracePath = await assertContainedInStateDir(
      stateDir,
      join(stateDir, "traces", `${songId}.jsonl`),
    );
    if (!validExisting && !fingerprintMismatch && existsSync(tracePath)) {
      const events = await this.traceWriter.read(tracePath, stateDir);
      if (events.length > 0) {
        const folded = foldTrace(events);
        return summarizeSongFromState(base, folded, undefined, base.updatedAtMs);
      }
    }
    return base;
  }

  /**
   * Verifies that `song.audioPath` is still an existing regular file with matching source
   * fingerprint; if the audio file on disk changed since the trace was recorded, rotates the
   * stale `.jsonl` trace to `<trace>.superseded-<ts>.bak` and resets summary metadata.
   */
  verifySongAudioFreshness(
    songId: string,
  ): Promise<{ song: TempoSongSummary; rotated: boolean; backupPath?: string }> {
    assertValidSongId(songId);
    return this.withStoreLock(async () => {
      if (!this.manifest || !this.stateDir) {
        throw new Error("Open a Tempo workspace folder first.");
      }
      const stateDir = this.stateDir;
      const idx = this.manifest.songs.findIndex((s) => s.songId === songId);
      const current = idx >= 0 ? this.manifest.songs[idx] : undefined;
      if (!current) {
        const err = new Error("Requested song was not found in the open workspace.");
        err.name = "NotFoundError";
        throw err;
      }

      const canonicalAudio = await realpath(current.audioPath).catch(() => null);
      if (!canonicalAudio) {
        const err = new Error("Audio file not found.");
        err.name = "NotFoundError";
        throw err;
      }
      if (!isSupportedAudioFileName(basename(canonicalAudio))) {
        throw new DOMException("Unsupported audio target.", "NotAllowedError");
      }
      const liveFp = await computeAudioFingerprint(canonicalAudio);
      await assertContainedInStateDir(stateDir, join(stateDir, "traces", `${songId}.jsonl`));

      const prevDigest = current.audioSha256 || current.audioSha256Sample || "";
      const changed =
        prevDigest.length > 0 &&
        (current.audioSizeBytes !== liveFp.audioSizeBytes || prevDigest !== liveFp.audioSha256);

      if (!changed) {
        if (
          current.audioPath !== canonicalAudio ||
          current.audioSizeBytes !== liveFp.audioSizeBytes ||
          current.audioSha256 !== liveFp.audioSha256 ||
          current.audioSha256Sample !== liveFp.audioSha256Sample
        ) {
          const synced: TempoSongSummary = {
            ...current,
            audioPath: canonicalAudio,
            audioSizeBytes: liveFp.audioSizeBytes,
            audioSha256: liveFp.audioSha256,
            audioSha256Sample: liveFp.audioSha256Sample,
          };
          this.manifest.songs[idx] = synced;
          await this.enqueueSave(this.manifest, stateDir);
          return { song: { ...synced }, rotated: false };
        }
        return { song: { ...current }, rotated: false };
      }

      const backupPath = await this.rotateSupersededTrace(stateDir, songId);
      const resetSong: TempoSongSummary = {
        ...current,
        audioPath: canonicalAudio,
        audioSizeBytes: liveFp.audioSizeBytes,
        audioSha256: liveFp.audioSha256,
        audioSha256Sample: liveFp.audioSha256Sample,
        durationSec: null,
        analyzed: false,
        segmentCount: 0,
        keptSegmentCount: 0,
        inboxCount: 0,
        highestPriority: null,
        ready: false,
        updatedAtMs: Date.now(),
      };
      this.manifest.songs[idx] = resetSong;
      await this.enqueueSave(this.manifest, stateDir);
      return {
        song: { ...resetSong },
        rotated: true,
        ...(backupPath ? { backupPath } : {}),
      };
    });
  }

  importPaths(options: {
    paths: readonly string[];
    copyIntoWorkspace?: boolean;
    target?: WorkspaceTarget;
  }): Promise<{ workspace: TempoWorkspaceManifest; importedSongIds: string[] }> {
    return this.withStoreLock(async () => {
      const target = options.target ?? this.captureTarget();
      const { workspaceDir, stateDir } = target;
      if (!Array.isArray(options.paths) || options.paths.length === 0) {
        throw new Error("Provide at least one audio file or directory path to import.");
      }

      const copyIntoWorkspace = Boolean(options.copyIntoWorkspace);
      const candidateFiles: string[] = [];

      for (const rawInput of options.paths) {
        if (typeof rawInput !== "string" || !rawInput.trim()) continue;
        const expanded = fullPath(rawInput);
        const st = await stat(expanded);
        if (st.isDirectory()) {
          const dirCanonical = await realpath(expanded);
          const dirEntries = await readdir(dirCanonical, { withFileTypes: true });
          const names = dirEntries
            .filter(
              (e) =>
                !e.name.startsWith(".") &&
                e.name !== ".ensomi-tempo" &&
                (e.isFile() || e.isSymbolicLink()) &&
                isSupportedAudioFileName(e.name),
            )
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
          for (const name of names) {
            const subPath = join(dirCanonical, name);
            const subCanonical = await realpath(subPath).catch(() => null);
            if (!subCanonical || !isSupportedAudioFileName(basename(subCanonical))) continue;
            const subStat = await stat(subCanonical).catch(() => null);
            if (subStat?.isFile()) candidateFiles.push(subCanonical);
          }
        } else if (st.isFile()) {
          const ext = extname(expanded).toLowerCase();
          if (!AUDIO_EXT_SET.has(ext)) {
            throw new Error(
              `Unsupported audio file "${basename(expanded)}". Supported formats: ${SUPPORTED_AUDIO_EXTENSIONS.join(", ")}.`,
            );
          }
          const canonicalFile = await realpath(expanded);
          if (!isSupportedAudioFileName(basename(canonicalFile))) {
            throw new Error(
              `Unsupported audio file "${basename(canonicalFile)}". Supported formats: ${SUPPORTED_AUDIO_EXTENSIONS.join(", ")}.`,
            );
          }
          const realStat = await stat(canonicalFile);
          if (!realStat.isFile()) {
            throw new Error("Audio source path is not a regular file.");
          }
          candidateFiles.push(canonicalFile);
        } else {
          throw new Error("Import path must be an audio file or directory.");
        }
      }

      if (candidateFiles.length === 0) {
        throw new Error("No supported audio files found in the specified path(s).");
      }

      const targetManifest = await this.loadOrCloneTargetManifest(target);
      const importedSongIds: string[] = [];
      const byAudioPath = new Map(targetManifest.songs.map((s) => [s.audioPath, s]));

      for (const srcPath of candidateFiles) {
        const isAlreadyInside =
          srcPath.startsWith(`${workspaceDir}${sep}`) && dirname(srcPath) === workspaceDir;
        if (!copyIntoWorkspace || isAlreadyInside) {
          const alreadyRegistered = byAudioPath.get(srcPath);
          if (alreadyRegistered) {
            importedSongIds.push(alreadyRegistered.songId);
            continue;
          }
        }

        let finalAudioPath = srcPath;
        if (copyIntoWorkspace && !isAlreadyInside) {
          const sanitized = sanitizeAudioUploadName(basename(srcPath));
          const dest = await copyFileExclusiveWithRetry(srcPath, workspaceDir, sanitized);
          finalAudioPath = await realpath(dest);
        }

        const existingAfterCopy = byAudioPath.get(finalAudioPath);
        if (existingAfterCopy) {
          importedSongIds.push(existingAfterCopy.songId);
          continue;
        }

        const fileStat = await stat(finalAudioPath);
        const fileName = basename(finalAudioPath);
        const summary = await this.buildOrReconcileSongSummary(
          workspaceDir,
          stateDir,
          finalAudioPath,
          fileName,
          undefined,
          fileStat.mtimeMs,
        );
        byAudioPath.set(finalAudioPath, summary);
        importedSongIds.push(summary.songId);
      }

      targetManifest.songs = sortSongsDeterministically(Array.from(byAudioPath.values()));
      if (importedSongIds[0]) {
        targetManifest.activeSongId = importedSongIds[0];
      } else if (!targetManifest.activeSongId && targetManifest.songs[0]) {
        targetManifest.activeSongId = targetManifest.songs[0].songId;
      }

      const saved = await this.commitTargetManifest(target, targetManifest);
      return {
        workspace: saved,
        importedSongIds,
      };
    });
  }

  async importUploadedStream(
    rawFileName: string,
    stream: Readable,
    explicitTarget?: WorkspaceTarget,
  ): Promise<{ workspace: TempoWorkspaceManifest; song: TempoSongSummary }> {
    const target = explicitTarget ?? this.captureTarget();
    const { workspaceDir, stateDir } = target;
    const sanitized = sanitizeAudioUploadName(rawFileName);
    const tempPath = join(workspaceDir, `.upload.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);

    let byteCount = 0;
    try {
      const out = createWriteStream(tempPath, { flags: "wx" });
      stream.on("data", (chunk: Buffer) => {
        byteCount += chunk.length;
      });
      await pipeline(stream, out);
      if (byteCount === 0) {
        throw new Error("Uploaded audio file is empty.");
      }
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }

    return await this.withStoreLock(async () => {
      const destPath = await publishTempFileExclusiveWithRetry(tempPath, workspaceDir, sanitized);
      const canonicalDest = await realpath(destPath);
      const fileName = basename(canonicalDest);
      const song = await this.buildOrReconcileSongSummary(
        workspaceDir,
        stateDir,
        canonicalDest,
        fileName,
        undefined,
        Date.now(),
      );

      const targetManifest = await this.loadOrCloneTargetManifest(target);
      const filtered = targetManifest.songs.filter((s) => s.songId !== song.songId);
      filtered.push(song);
      targetManifest.songs = sortSongsDeterministically(filtered);
      targetManifest.activeSongId = song.songId;
      const saved = await this.commitTargetManifest(target, targetManifest);

      return {
        workspace: saved,
        song: { ...song },
      };
    });
  }

  async importUploadedBuffer(
    rawFileName: string,
    bytes: Uint8Array,
    explicitTarget?: WorkspaceTarget,
  ): Promise<{ workspace: TempoWorkspaceManifest; song: TempoSongSummary }> {
    const target = explicitTarget ?? this.captureTarget();
    if (bytes.byteLength === 0) {
      throw new Error("Uploaded audio file is empty.");
    }
    const { workspaceDir, stateDir } = target;
    const sanitized = sanitizeAudioUploadName(rawFileName);
    const tempPath = join(workspaceDir, `.upload.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);

    try {
      await writeFile(tempPath, bytes, { flag: "wx" });
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }

    return await this.withStoreLock(async () => {
      const destPath = await publishTempFileExclusiveWithRetry(tempPath, workspaceDir, sanitized);
      const canonicalDest = await realpath(destPath);
      const fileName = basename(canonicalDest);
      const song = await this.buildOrReconcileSongSummary(
        workspaceDir,
        stateDir,
        canonicalDest,
        fileName,
        undefined,
        Date.now(),
      );

      const targetManifest = await this.loadOrCloneTargetManifest(target);
      const filtered = targetManifest.songs.filter((s) => s.songId !== song.songId);
      filtered.push(song);
      targetManifest.songs = sortSongsDeterministically(filtered);
      targetManifest.activeSongId = song.songId;
      const saved = await this.commitTargetManifest(target, targetManifest);

      return {
        workspace: saved,
        song: { ...song },
      };
    });
  }

  setActiveSong(songId: string): Promise<TempoSongSummary> {
    assertValidSongId(songId);
    return this.withStoreLock(async () => {
      if (!this.manifest || !this.stateDir) {
        throw new Error("Open a Tempo workspace folder first.");
      }
      const song = this.getSong(songId);
      if (this.manifest.activeSongId !== songId) {
        this.manifest.activeSongId = songId;
        await this.enqueueSave(this.manifest, this.stateDir);
      }
      return song;
    });
  }

  /**
   * Read-only projection of `TempoSongSummary` from live `SessionState` without mutating
   * `this.manifest` or writing `workspace.json` (used for side-effect-free `GET` endpoints).
   */
  projectSongSummary(
    songId: string,
    state: SessionState,
    inboxSpans?: readonly Span[],
  ): TempoSongSummary {
    const current = this.getSong(songId);
    return summarizeSongFromState(current, state, inboxSpans, current.updatedAtMs);
  }

  updateSongFromState(
    songId: string,
    state: SessionState,
    inboxSpans?: readonly Span[],
  ): Promise<TempoSongSummary> {
    assertValidSongId(songId);
    return this.withStoreLock(async () => {
      if (!this.manifest || !this.stateDir) {
        throw new Error("Open a Tempo workspace folder first.");
      }
      const idx = this.manifest.songs.findIndex((s) => s.songId === songId);
      const current = idx >= 0 ? this.manifest.songs[idx] : undefined;
      if (!current) {
        const err = new Error("Requested song was not found in the open workspace.");
        err.name = "NotFoundError";
        throw err;
      }
      const updated = summarizeSongFromState(current, state, inboxSpans);
      this.manifest.songs[idx] = updated;
      await this.enqueueSave(this.manifest, this.stateDir);
      return { ...updated };
    });
  }
}
