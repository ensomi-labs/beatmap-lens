import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  type AnalysisDraft,
  type AudioDescriptor,
  type PatchOffer,
  type PreparedEvidence,
  type ProviderKind,
  type ProviderManifest,
  type RecomputeRequest,
  type RecomputeResult,
  type SessionState,
  SNAP_FAMILIES,
  SNAP_ROLES,
  type SnapCandidate,
  type SuggestSnapsRequest,
  serializeState,
  type TimingProvider,
} from "ensomi";

export const AUDITION_FILTERS = ["mix", "percussive", "harmonic", "low", "mid", "high"] as const;

export type AuditionFilter = (typeof AUDITION_FILTERS)[number];

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const daemonScriptPath = fileURLToPath(new URL("./tempo_daemon.py", import.meta.url));

export interface PythonCommand {
  command: string;
  args: string[];
  label: string;
}

/**
 * Resolves the Python runtime for the warm Tempo daemon:
 *  1. `ENSOMI_PYTHON` when explicitly configured;
 *  2. `ensomi-model` `.venv/bin/python` (which provides BeatThis + PyTorch);
 *  3. repository `.venv/bin/python` if synced locally;
 *  4. `uv run --locked --project <repoRoot> python`.
 */
export function resolvePythonCommand(env: NodeJS.ProcessEnv = process.env): PythonCommand {
  if (env.ENSOMI_PYTHON) {
    return {
      command: env.ENSOMI_PYTHON,
      args: [],
      label: `ENSOMI_PYTHON (${env.ENSOMI_PYTHON})`,
    };
  }
  const modelVenv = join(
    env.ENSOMI_MODEL_DIR ?? join(homedir(), "ensomi", "ensomi-model"),
    ".venv",
    "bin",
    "python",
  );
  if (existsSync(modelVenv)) {
    return {
      command: modelVenv,
      args: [],
      label: `ensomi-model (${modelVenv})`,
    };
  }
  const localVenv = join(repoRoot, ".venv", "bin", "python");
  if (existsSync(localVenv)) {
    return {
      command: localVenv,
      args: [],
      label: `repo venv (${localVenv})`,
    };
  }
  return {
    command: "uv",
    args: ["run", "--locked", "--project", repoRoot, "python"],
    label: "uv run --locked python",
  };
}

export interface DaemonPrepareResponse {
  audioPath: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  providerKind: "model" | "rule";
}

export interface DaemonAnalyzeResponse extends DaemonPrepareResponse {
  segments: NonNullable<AnalysisDraft["segments"]>;
  beats: NonNullable<AnalysisDraft["beats"]>;
  sounds: NonNullable<AnalysisDraft["sounds"]>;
  elapsedSec: number;
}

export interface DaemonSuggestSnapsResponse {
  candidates: SnapCandidate[];
  elapsedMs: number;
}

export interface DaemonRecomputeResponse {
  batchId?: string;
  offers: PatchOffer[];
  elapsedMs: number;
}

export interface DaemonRenderSpanResponse {
  outputPath: string;
  filter: AuditionFilter;
  startSec: number;
  endSec: number;
  startSample: number;
  endSample: number;
  sampleRate: number;
  channels: number;
  elapsedSec: number;
}

interface PendingRpc {
  child: ChildProcessWithoutNullStreams;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  cleanupAbort: () => void;
}

interface RpcEnvelope {
  id: string | null;
  ok: boolean;
  cancelled?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

export interface TempoDaemonClientOptions {
  env?: NodeJS.ProcessEnv;
  maxCachedTracks?: number;
}

function makeAbortError(message = "The operation was aborted."): DOMException {
  return new DOMException(message, "AbortError");
}

/**
 * Persistent warm stdio NDJSON client to `tempo_daemon.py`.
 * Lazily spawns the Python daemon, auto-restarts on unexpected exit, forwards cooperative
 * `cancel` signals by `requestId`, and shuts down cleanly on `close()`.
 */
export class TempoDaemonClient {
  private readonly env: NodeJS.ProcessEnv;
  private readonly python: PythonCommand;
  private readonly maxCachedTracks: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: ReadlineInterface | null = null;
  private readonly pending = new Map<string, PendingRpc>();
  private closed = false;
  private nextId = 1;

  constructor(options: TempoDaemonClientOptions = {}) {
    this.env = options.env ? { ...process.env, ...options.env } : process.env;
    this.python = resolvePythonCommand(this.env);
    this.maxCachedTracks = options.maxCachedTracks ?? 3;
  }

  get runtimeLabel(): string {
    return this.python.label;
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.closed) {
      throw new Error("Tempo daemon client is closed.");
    }
    if (
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      !this.child.killed
    ) {
      return this.child;
    }

    const args = [
      ...this.python.args,
      daemonScriptPath,
      "--max-cached-tracks",
      String(this.maxCachedTracks),
      ...(this.env.TEMPO_ANALYZER_BACKEND === "dsp" ? ["--backend", "dsp"] : []),
    ];

    const child = spawn(this.python.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
    });
    this.child = child;
    const stderrTail: string[] = [];

    // Prevent unhandled stream error crashes (e.g. EPIPE when daemon exits mid-write).
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        stderrTail.push(trimmed);
        if (stderrTail.length > 20) stderrTail.shift();
      }
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl = rl;
    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: RpcEnvelope;
      try {
        msg = JSON.parse(trimmed) as RpcEnvelope;
      } catch {
        return;
      }
      if (!msg.id) return;
      const entry = this.pending.get(msg.id);
      if (!entry || entry.child !== child) return;
      this.pending.delete(msg.id);
      entry.cleanupAbort();
      if (msg.ok) {
        entry.resolve(msg.result);
      } else if (msg.cancelled || msg.error?.code === "CANCELLED") {
        entry.reject(makeAbortError(msg.error?.message ?? "Request cancelled"));
      } else {
        entry.reject(new Error(msg.error?.message ?? "Tempo daemon request failed."));
      }
    });

    const rejectPendingForChild = (err: unknown) => {
      rl.close();
      if (this.child === child) {
        this.child = null;
      }
      if (this.rl === rl) {
        this.rl = null;
      }
      const owned: Array<[string, PendingRpc]> = [];
      for (const [id, entry] of this.pending) {
        if (entry.child === child) {
          owned.push([id, entry]);
        }
      }
      for (const [id, entry] of owned) {
        this.pending.delete(id);
        entry.cleanupAbort();
        entry.reject(err);
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = stderrTail.at(-1) ?? `code=${String(code)} signal=${String(signal)}`;
      const err = this.closed
        ? makeAbortError("Tempo daemon closed.")
        : new Error(`Tempo daemon exited unexpectedly (${detail}).`);
      rejectPendingForChild(err);
    };

    child.once("exit", onExit);
    child.once("error", (err) => {
      rejectPendingForChild(err);
    });

    return child;
  }

  private sendRaw(child: ChildProcessWithoutNullStreams, payload: Record<string, unknown>): void {
    if (child.stdin.destroyed || !child.stdin.writable) {
      throw new Error("Tempo daemon stdin pipe is not writable.");
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
      // Handled by process exit/error listener; swallow callback error to avoid unhandled throw.
      void err;
    });
  }

  request<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(makeAbortError());
    }
    if (this.closed) {
      return Promise.reject(new Error("Tempo daemon client is closed."));
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.ensureProcess();
    } catch (err) {
      return Promise.reject(err);
    }

    const reqId = `req_${this.nextId++}_${randomUUID().slice(0, 6)}`;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const entry = this.pending.get(reqId);
        if (!entry) return;
        this.pending.delete(reqId);
        entry.cleanupAbort();
        if (
          entry.child.exitCode === null &&
          entry.child.signalCode === null &&
          !entry.child.killed &&
          !entry.child.stdin.destroyed &&
          entry.child.stdin.writable
        ) {
          try {
            entry.child.stdin.write(
              `${JSON.stringify({ method: "cancel", params: { targetId: reqId } })}\n`,
              () => {},
            );
          } catch {
            // Ignore broken pipe during shutdown.
          }
        }
        reject(makeAbortError());
      };

      const cleanupAbort = () => {
        signal?.removeEventListener("abort", onAbort);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(reqId, {
        child,
        resolve: (val) => resolve(val as T),
        reject,
        cleanupAbort,
      });

      try {
        this.sendRaw(child, { id: reqId, method, params });
      } catch (err) {
        this.pending.delete(reqId);
        cleanupAbort();
        reject(err);
      }
    });
  }

  prepare(audioPath: string, signal?: AbortSignal): Promise<DaemonPrepareResponse> {
    return this.request<DaemonPrepareResponse>("prepare", { audioPath }, signal);
  }

  analyze(
    audioPath: string,
    options?: { useBeatThis?: boolean },
    signal?: AbortSignal,
  ): Promise<DaemonAnalyzeResponse> {
    return this.request<DaemonAnalyzeResponse>(
      "analyze",
      {
        audioPath,
        ...(options?.useBeatThis !== undefined ? { useBeatThis: options.useBeatThis } : {}),
      },
      signal,
    );
  }

  suggestSnaps(
    audioPath: string,
    timeSec: number,
    windowSec = 0.12,
    signal?: AbortSignal,
  ): Promise<DaemonSuggestSnapsResponse> {
    return this.request<DaemonSuggestSnapsResponse>(
      "suggest_snaps",
      { audioPath, timeSec, windowSec },
      signal,
    );
  }

  recompute(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<DaemonRecomputeResponse> {
    return this.request<DaemonRecomputeResponse>("recompute", params, signal);
  }

  renderAudition(
    params: {
      audioPath: string;
      startSec: number;
      endSec: number;
      filter: AuditionFilter;
      outputPath: string;
    },
    signal?: AbortSignal,
  ): Promise<DaemonRenderSpanResponse> {
    return this.request<DaemonRenderSpanResponse>("render_audition", { ...params }, signal);
  }

  exportClip(
    params: {
      audioPath: string;
      startSec: number;
      endSec: number;
      filter: AuditionFilter;
      outputPath: string;
    },
    signal?: AbortSignal,
  ): Promise<DaemonRenderSpanResponse> {
    return this.request<DaemonRenderSpanResponse>("export_clip", { ...params }, signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      this.rl?.close();
      this.rl = null;
      return;
    }

    await new Promise<void>((done) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        clearTimeout(giveUpTimer);
        child.off("exit", finish);
        child.off("close", finish);
        done();
      };

      child.once("exit", finish);
      child.once("close", finish);

      const termTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGTERM");
          } catch {
            finish();
          }
        }
      }, 400);
      termTimer.unref?.();

      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            finish();
          }
        }
      }, 800);
      killTimer.unref?.();

      const giveUpTimer = setTimeout(finish, 1500);
      giveUpTimer.unref?.();

      try {
        if (!child.stdin.destroyed && child.stdin.writable) {
          child.stdin.write(
            `${JSON.stringify({ id: "shutdown", method: "shutdown", params: {} })}\n`,
            () => {},
          );
          child.stdin.end();
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          finish();
        }
      }
    });

    if (this.child === child) {
      this.child = null;
    }
    this.rl?.close();
    this.rl = null;
  }
}

export interface TempoTimingProviderOptions {
  daemon: TempoDaemonClient;
  resolveAudioPath: (songId: string) => string;
  initialKind?: ProviderKind;
}

/**
 * `ensomi` `TimingProvider` backed by the warm `TempoDaemonClient`.
 */
export class TempoTimingProvider implements TimingProvider {
  private readonly daemon: TempoDaemonClient;
  private readonly resolveAudioPath: (songId: string) => string;
  private kind: ProviderKind;

  constructor(options: TempoTimingProviderOptions) {
    this.daemon = options.daemon;
    this.resolveAudioPath = options.resolveAudioPath;
    this.kind = options.initialKind ?? "model";
  }

  manifest(): ProviderManifest {
    return {
      id: "ensomi-tempo-daemon",
      version: "0.2.0",
      kind: this.kind,
      capabilities: {
        draft: true,
        sounds: true,
        snapSuggestions: true,
        constrainedRecompute: true,
        supportedSnapFamilies: [...SNAP_FAMILIES],
        supportedSnapRoles: [...SNAP_ROLES],
        diagnostics: true,
        alternatives: true,
        repeatPropagation: true,
      },
    };
  }

  async prepare(audio: AudioDescriptor, signal?: AbortSignal): Promise<PreparedEvidence> {
    const audioPath = this.resolveAudioPath(audio.songId);
    const info = await this.daemon.prepare(audioPath, signal);
    this.kind = info.providerKind;
    return {
      songId: audio.songId,
      audioPath: info.audioPath,
      durationSec: info.durationSec,
      sampleRate: info.sampleRate,
      channels: info.channels,
    };
  }

  async analyze(evidence: PreparedEvidence, signal?: AbortSignal): Promise<AnalysisDraft> {
    const audioPath = this.extractAudioPath(evidence);
    const result = await this.daemon.analyze(audioPath, undefined, signal);
    this.kind = result.providerKind;
    return {
      segments: result.segments,
      beats: result.beats,
      sounds: result.sounds,
    };
  }

  async suggestSnaps(
    evidence: PreparedEvidence,
    _state: SessionState,
    request: SuggestSnapsRequest,
    signal?: AbortSignal,
  ): Promise<SnapCandidate[]> {
    const audioPath = this.extractAudioPath(evidence);
    const result = await this.daemon.suggestSnaps(
      audioPath,
      request.timeSec,
      request.windowSec,
      signal,
    );
    return result.candidates;
  }

  async recompute(
    evidence: PreparedEvidence,
    state: SessionState,
    request: RecomputeRequest,
    signal?: AbortSignal,
  ): Promise<RecomputeResult> {
    const audioPath = this.extractAudioPath(evidence);
    const serialized = serializeState(state);
    const result = await this.daemon.recompute(
      {
        audioPath,
        scope: request.scope,
        reason: request.reason,
        generation: request.generation,
        basisSeq: request.basisSeq,
        providerId: "ensomi-tempo-daemon",
        providerKind: this.kind,
        state: {
          segments: serialized.segments,
          spans: serialized.spans,
          beats: serialized.beats,
          sounds: serialized.sounds,
          unbeats: serialized.unbeats,
          entityRevisions: serialized.entityRevisions,
        },
        constraints: request.constraints,
      },
      signal,
    );
    return {
      ...(result.batchId !== undefined ? { batchId: result.batchId } : {}),
      offers: result.offers,
    };
  }

  private extractAudioPath(evidence: PreparedEvidence): string {
    if (typeof evidence.audioPath === "string" && evidence.audioPath.length > 0) {
      return evidence.audioPath;
    }
    if (typeof evidence.songId === "string" && evidence.songId.length > 0) {
      return this.resolveAudioPath(evidence.songId);
    }
    throw new Error("Audio path is not bound for this song session.");
  }
}
