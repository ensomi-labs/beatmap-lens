import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
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

export function isSupportedAudioFileName(fileName: string): boolean {
  if (!fileName || fileName.startsWith(".")) return false;
  return AUDIO_EXT_SET.has(extname(fileName).toLowerCase());
}

export interface TempoSongSummary {
  songId: string;
  title: string;
  fileName: string;
  audioPath: string;
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
      throw new Error(
        `Invalid Tempo trace file at line ${lineNum}: duplicate event id "${event.id}".`,
      );
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
      throw new Error(`Incoming trace events contain duplicate id "${event.id}".`);
    }
    seenIds.add(event.id);
    prevSeq = event.seq;
    validated.push(event);
  }
  return validated;
}

/**
 * Mutex-serialized, crash-safe per-song `.jsonl` trace writer.
 * Validates `ensomi` `0.2` envelopes, heals torn crash tails, guarantees newline termination,
 * and prevents concurrent saves/edits from interleaving or truncating prefixes.
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
    if (incoming.length === 0) return Promise.resolve({ appended: 0, skipped: 0 });

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

        if (inspected.truncateBytes !== undefined && existsSync(path)) {
          await truncate(path, inspected.truncateBytes);
        }
        if (toAppend.length === 0) return { appended: 0, skipped };

        await mkdir(dirname(path), { recursive: true });
        const serialized = serializeTraceNdjson(toAppend);
        const payload = inspected.needsLeadingNewline ? `\n${serialized}` : serialized;
        await appendFile(path, payload, "utf8");
        return { appended: toAppend.length, skipped };
      });

    this.tails.set(path, next);
    next.then(
      () => {
        if (this.tails.get(path) === next) this.tails.delete(path);
      },
      () => {
        if (this.tails.get(path) === next) this.tails.delete(path);
      },
    );
    return next;
  }

  async read(path: string): Promise<TraceEvent[]> {
    assertNotTimingFile(path);
    const pending = this.tails.get(path);
    if (pending) await pending.catch(() => {});
    let raw = "";
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const inspected = inspectTraceContent(raw, true);
    if (inspected.truncateBytes !== undefined) {
      await truncate(path, inspected.truncateBytes).catch(() => {});
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
  const fileName = basename(audioPath);
  const slug = slugifySongStem(fileName);
  const isInsideWorkspace =
    audioPath.startsWith(`${workspaceDir}${sep}`) && dirname(audioPath) === workspaceDir;
  const hashInput = isInsideWorkspace
    ? `rel:${relative(workspaceDir, audioPath)}`
    : `abs:${audioPath}`;
  const shortHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
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

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
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

async function uniqueDestinationPath(dir: string, sanitizedName: string): Promise<string> {
  const ext = extname(sanitizedName);
  const stem = basename(sanitizedName, ext);
  let candidate = join(dir, sanitizedName);
  let counter = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${counter}${ext}`);
    counter += 1;
  }
  return candidate;
}

/**
 * Folder-backed `.ensomi-tempo/` multi-song workspace store.
 */
export class TempoWorkspaceStore {
  private workspaceDir: string | null = null;
  private stateDir: string | null = null;
  private manifest: TempoWorkspaceManifest | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();
  readonly traceWriter = new TraceWriter();

  get isOpen(): boolean {
    return this.workspaceDir !== null && this.stateDir !== null && this.manifest !== null;
  }

  get currentWorkspaceDir(): string | null {
    return this.workspaceDir;
  }

  get currentStateDir(): string | null {
    return this.stateDir;
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
    if (!this.manifest) {
      throw new Error("Open a Tempo workspace folder first.");
    }
    const found = this.manifest.songs.find((s) => s.songId === songId);
    if (!found) {
      const err = new Error(`Unknown song "${songId}" in workspace.`);
      err.name = "NotFoundError";
      throw err;
    }
    return { ...found };
  }

  tracePathFor(songId: string): string {
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
      .then(() => atomicWriteJson(this.manifestPath(stateDir), snapshot));
    this.writeChain = next;
    return next;
  }

  async openWorkspace(
    dirInput: string,
    options?: { stateDir?: string; createIfMissing?: boolean },
  ): Promise<TempoWorkspaceManifest> {
    const resolvedInput = fullPath(dirInput);
    if (options?.createIfMissing) {
      await mkdir(resolvedInput, { recursive: true });
    }
    const info = await stat(resolvedInput);
    if (!info.isDirectory()) {
      throw new Error(`Expected an audio workspace folder: ${resolvedInput}`);
    }
    const workspaceDir = await realpath(resolvedInput);
    const rawStateDir = options?.stateDir
      ? resolve(fullPath(options.stateDir))
      : join(workspaceDir, ".ensomi-tempo");

    await mkdir(join(rawStateDir, "traces"), { recursive: true });
    await mkdir(join(rawStateDir, "clips"), { recursive: true });
    const stateDir = await realpath(rawStateDir);

    let existingManifest: Partial<TempoWorkspaceManifest> | null = null;
    try {
      const rawJson = await readFile(this.manifestPath(stateDir), "utf8");
      existingManifest = JSON.parse(rawJson) as Partial<TempoWorkspaceManifest>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Ignore malformed missing manifest only if unreadable? No, surface genuine JSON syntax errors unless empty.
        throw error;
      }
    }

    const previousByPath = new Map<string, TempoSongSummary>();
    const previousById = new Map<string, TempoSongSummary>();
    for (const prev of existingManifest?.songs ?? []) {
      if (prev && typeof prev.audioPath === "string" && typeof prev.songId === "string") {
        previousByPath.set(prev.audioPath, prev);
        previousById.set(prev.songId, prev);
      }
    }

    const entries = await readdir(workspaceDir, { withFileTypes: true });
    const discoveredPaths = new Set<string>();
    const reconciled: TempoSongSummary[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === ".ensomi-tempo") continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!isSupportedAudioFileName(entry.name)) continue;
      const candidatePath = join(workspaceDir, entry.name);
      const entryStat = await stat(candidatePath).catch(() => null);
      if (!entryStat?.isFile()) continue;
      const canonicalAudioPath = await realpath(candidatePath);
      discoveredPaths.add(canonicalAudioPath);

      const summary = await this.buildOrReconcileSongSummary(
        workspaceDir,
        stateDir,
        canonicalAudioPath,
        entry.name,
        previousByPath.get(canonicalAudioPath) ?? previousByPath.get(candidatePath),
        entryStat.mtimeMs,
      );
      reconciled.push(summary);
    }

    // Preserve externally linked songs from workspace.json whose audio files still exist on disk.
    for (const prev of existingManifest?.songs ?? []) {
      if (!prev || typeof prev.audioPath !== "string") continue;
      const prevCanonical = await realpath(prev.audioPath).catch(() => null);
      if (!prevCanonical || discoveredPaths.has(prevCanonical)) continue;
      const insideWorkspace =
        prevCanonical.startsWith(`${workspaceDir}${sep}`) &&
        dirname(prevCanonical) === workspaceDir;
      if (insideWorkspace) continue;
      const extStat = await stat(prevCanonical).catch(() => null);
      if (!extStat?.isFile()) continue;
      discoveredPaths.add(prevCanonical);
      const summary = await this.buildOrReconcileSongSummary(
        workspaceDir,
        stateDir,
        prevCanonical,
        prev.fileName || basename(prevCanonical),
        previousById.get(prev.songId) ?? prev,
        extStat.mtimeMs,
      );
      reconciled.push(summary);
    }

    const sortedSongs = sortSongsDeterministically(reconciled);
    const prevActive = existingManifest?.activeSongId ?? this.manifest?.activeSongId ?? null;
    const activeSongId =
      prevActive && sortedSongs.some((s) => s.songId === prevActive)
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
  }

  private async buildOrReconcileSongSummary(
    workspaceDir: string,
    stateDir: string,
    audioPath: string,
    fileName: string,
    existing: TempoSongSummary | undefined,
    fallbackUpdatedMs: number,
  ): Promise<TempoSongSummary> {
    const songId = existing?.songId ?? deriveSongId(workspaceDir, audioPath);
    const title = existing?.title ?? basename(fileName, extname(fileName));
    const base: TempoSongSummary = {
      songId,
      title,
      fileName,
      audioPath,
      durationSec: existing?.durationSec ?? null,
      analyzed: existing?.analyzed ?? false,
      segmentCount: existing?.segmentCount ?? 0,
      keptSegmentCount: existing?.keptSegmentCount ?? 0,
      inboxCount: existing?.inboxCount ?? 0,
      highestPriority: existing?.highestPriority ?? null,
      ready: existing?.ready ?? false,
      updatedAtMs: existing?.updatedAtMs ?? Math.round(fallbackUpdatedMs),
    };

    const tracePath = join(stateDir, "traces", `${songId}.jsonl`);
    if (!existing && existsSync(tracePath)) {
      const events = await this.traceWriter.read(tracePath).catch(() => []);
      if (events.length > 0) {
        const folded = foldTrace(events);
        return summarizeSongFromState(base, folded, undefined, base.updatedAtMs);
      }
    }
    return base;
  }

  async importPaths(options: {
    paths: readonly string[];
    copyIntoWorkspace?: boolean;
  }): Promise<{ workspace: TempoWorkspaceManifest; importedSongIds: string[] }> {
    if (!this.workspaceDir || !this.stateDir || !this.manifest) {
      throw new Error("Open a Tempo workspace folder before importing audio.");
    }
    if (!Array.isArray(options.paths) || options.paths.length === 0) {
      throw new Error("Provide at least one audio file or directory path to import.");
    }

    const workspaceDir = this.workspaceDir;
    const stateDir = this.stateDir;
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
          const subStat = await stat(subPath).catch(() => null);
          if (subStat?.isFile()) candidateFiles.push(await realpath(subPath));
        }
      } else if (st.isFile()) {
        const ext = extname(expanded).toLowerCase();
        if (!AUDIO_EXT_SET.has(ext)) {
          throw new Error(
            `Unsupported audio file "${basename(expanded)}". Supported formats: ${SUPPORTED_AUDIO_EXTENSIONS.join(", ")}.`,
          );
        }
        candidateFiles.push(await realpath(expanded));
      } else {
        throw new Error(`Not a file or directory: ${expanded}`);
      }
    }

    if (candidateFiles.length === 0) {
      throw new Error("No supported audio files found in the specified path(s).");
    }

    const importedSongIds: string[] = [];
    const byAudioPath = new Map(this.manifest.songs.map((s) => [s.audioPath, s]));

    for (const srcPath of candidateFiles) {
      const alreadyRegistered = byAudioPath.get(srcPath);
      if (alreadyRegistered) {
        importedSongIds.push(alreadyRegistered.songId);
        continue;
      }

      let finalAudioPath = srcPath;
      const isAlreadyInside =
        srcPath.startsWith(`${workspaceDir}${sep}`) && dirname(srcPath) === workspaceDir;
      if (copyIntoWorkspace && !isAlreadyInside) {
        const sanitized = sanitizeAudioUploadName(basename(srcPath));
        const dest = await uniqueDestinationPath(workspaceDir, sanitized);
        await copyFile(srcPath, dest);
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

    this.manifest.songs = sortSongsDeterministically(Array.from(byAudioPath.values()));
    if (importedSongIds[0]) {
      this.manifest.activeSongId = importedSongIds[0];
    } else if (!this.manifest.activeSongId && this.manifest.songs[0]) {
      this.manifest.activeSongId = this.manifest.songs[0].songId;
    }

    await this.enqueueSave(this.manifest, stateDir);
    return {
      workspace: this.getSnapshot() as TempoWorkspaceManifest,
      importedSongIds,
    };
  }

  async importUploadedStream(
    rawFileName: string,
    stream: Readable,
  ): Promise<{ workspace: TempoWorkspaceManifest; song: TempoSongSummary }> {
    if (!this.workspaceDir || !this.stateDir || !this.manifest) {
      throw new Error("Open a Tempo workspace folder before uploading audio.");
    }
    const workspaceDir = this.workspaceDir;
    const stateDir = this.stateDir;
    const sanitized = sanitizeAudioUploadName(rawFileName);
    const destPath = await uniqueDestinationPath(workspaceDir, sanitized);
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
      await rename(tempPath, destPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }

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

    const filtered = this.manifest.songs.filter((s) => s.songId !== song.songId);
    filtered.push(song);
    this.manifest.songs = sortSongsDeterministically(filtered);
    this.manifest.activeSongId = song.songId;
    await this.enqueueSave(this.manifest, stateDir);

    return {
      workspace: this.getSnapshot() as TempoWorkspaceManifest,
      song: { ...song },
    };
  }

  async importUploadedBuffer(
    rawFileName: string,
    bytes: Uint8Array,
  ): Promise<{ workspace: TempoWorkspaceManifest; song: TempoSongSummary }> {
    if (!this.workspaceDir || !this.stateDir || !this.manifest) {
      throw new Error("Open a Tempo workspace folder before uploading audio.");
    }
    if (bytes.byteLength === 0) {
      throw new Error("Uploaded audio file is empty.");
    }
    const workspaceDir = this.workspaceDir;
    const stateDir = this.stateDir;
    const sanitized = sanitizeAudioUploadName(rawFileName);
    const destPath = await uniqueDestinationPath(workspaceDir, sanitized);
    const tempPath = join(workspaceDir, `.upload.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);

    try {
      await writeFile(tempPath, bytes, { flag: "wx" });
      await rename(tempPath, destPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }

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

    const filtered = this.manifest.songs.filter((s) => s.songId !== song.songId);
    filtered.push(song);
    this.manifest.songs = sortSongsDeterministically(filtered);
    this.manifest.activeSongId = song.songId;
    await this.enqueueSave(this.manifest, stateDir);

    return {
      workspace: this.getSnapshot() as TempoWorkspaceManifest,
      song: { ...song },
    };
  }

  async setActiveSong(songId: string): Promise<TempoSongSummary> {
    if (!this.manifest || !this.stateDir) {
      throw new Error("Open a Tempo workspace folder first.");
    }
    const song = this.getSong(songId);
    if (this.manifest.activeSongId !== songId) {
      this.manifest.activeSongId = songId;
      await this.enqueueSave(this.manifest, this.stateDir);
    }
    return song;
  }

  async updateSongFromState(
    songId: string,
    state: SessionState,
    inboxSpans?: readonly Span[],
  ): Promise<TempoSongSummary> {
    if (!this.manifest || !this.stateDir) {
      throw new Error("Open a Tempo workspace folder first.");
    }
    const idx = this.manifest.songs.findIndex((s) => s.songId === songId);
    if (idx < 0) {
      const err = new Error(`Unknown song "${songId}" in workspace.`);
      err.name = "NotFoundError";
      throw err;
    }
    const current = this.manifest.songs[idx];
    if (!current) {
      throw new Error(`Unknown song "${songId}" in workspace.`);
    }
    const updated = summarizeSongFromState(current, state, inboxSpans);
    this.manifest.songs[idx] = updated;
    await this.enqueueSave(this.manifest, this.stateDir);
    return { ...updated };
  }
}
