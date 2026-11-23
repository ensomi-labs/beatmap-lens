import type {
  EditOp,
  GridFitItem,
  LayerLifecycleState,
  OfferConflict,
  PatchOffer,
  Range,
  RedLineProjection,
  SerializedSessionState,
  SnapCandidate,
  Span,
  SpanPriority,
  TriggerLayer,
  TriggerPolicy,
} from "ensomi";

export const TEMPO_API_PREFIX = "/api/tempo";
export const LOCAL_HEADER_NAME = "x-beatmap-lens-local";
export const LOCAL_HEADER_VALUE = "1";
export const WORKSPACE_DIR_HEADER_NAME = "X-Tempo-Workspace-Dir";

let activeClientWorkspaceDir: string | null = null;

export function setClientWorkspaceDir(dir: string | null | undefined): void {
  const trimmed = typeof dir === "string" ? dir.trim() : "";
  activeClientWorkspaceDir = trimmed.length > 0 ? trimmed : null;
}

export function getClientWorkspaceDir(): string | null {
  return activeClientWorkspaceDir;
}

export type AuditionFilter = "mix" | "percussive" | "harmonic" | "low" | "mid" | "high";

export interface TempoSongSummary {
  songId: string;
  title: string;
  fileName: string;
  audioPath: string;
  audioSizeBytes?: number;
  audioSha256?: string;
  audioSha256Sample?: string;
  durationSec: number | null;
  analyzed: boolean;
  segmentCount: number;
  keptSegmentCount: number;
  inboxCount: number;
  highestPriority: SpanPriority | null;
  ready: boolean;
  updatedAtMs: number;
}

export interface TempoWorkspaceResponse {
  schemaVersion: 1;
  workspaceDir: string | null;
  activeSongId: string | null;
  songs: TempoSongSummary[];
  triggerPolicy: TriggerPolicy;
}

export interface TempoUploadResponse extends TempoWorkspaceResponse {
  workspace: TempoWorkspaceResponse;
  songId: string | null;
  importedSongIds: string[];
  song?: TempoSongSummary;
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

export interface TempoSuggestSnapsResponse {
  status: "ok" | "cancelled" | "superseded";
  songId: string | null;
  generation: number;
  candidates: SnapCandidate[];
}

export interface TempoRecomputeResponse extends TempoSongSessionPayload {
  status: "applied" | "held" | "cancelled" | "superseded";
  generation: number;
  offers: PatchOffer[];
  suppressedOffers: PatchOffer[];
}

export interface TempoHoldOffersResponse extends TempoSongSessionPayload {
  hold: boolean;
  flushed: boolean;
  offers: PatchOffer[];
}

export interface TempoOfferActionResponse extends TempoSongSessionPayload {
  ok: boolean;
  conflicts?: OfferConflict[];
  offer?: PatchOffer;
  supersededOfferIds?: string[];
}

export interface TempoExportOsuResponse {
  format: "osu";
  fileName: string;
  osuTimingPoints: string;
  content: string;
  redLineProjection: RedLineProjection;
}

export interface TempoExportJsonlResponse {
  format: "jsonl";
  fileName: string;
  tracePath: string;
  content: string;
  eventCount: number;
}

export interface TempoExportClipResponse {
  format: "clip";
  fileName: string;
  clipPath: string;
  downloadUrl: string;
  startSec: number;
  endSec: number;
  filter: AuditionFilter;
  sampleRate: number;
  channels: number;
}

export type TempoExportResponse =
  | TempoExportOsuResponse
  | TempoExportJsonlResponse
  | TempoExportClipResponse;

export function isAbortError(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (cause instanceof Error && cause.name === "AbortError")
  );
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let parsed: unknown = {};
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      throw new Error("Invalid JSON response from local Tempo service.");
    }
  }
  if (!response.ok) {
    const errMsg =
      parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `HTTP ${response.status}`;
    throw new Error(errMsg);
  }
  return parsed as T;
}

async function tempoJson<T>(
  path: string,
  options?: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    signal?: AbortSignal;
    localWrite?: boolean;
    workspaceDir?: string | null;
    includeWorkspaceHeader?: boolean;
  },
): Promise<T> {
  const method = options?.method ?? "GET";
  const headers: Record<string, string> = {};
  if (method !== "GET" || options?.localWrite) {
    headers[LOCAL_HEADER_NAME] = LOCAL_HEADER_VALUE;
  }
  if (options?.includeWorkspaceHeader) {
    const wsDir = options.workspaceDir ?? activeClientWorkspaceDir;
    if (typeof wsDir === "string" && wsDir.trim().length > 0) {
      headers[WORKSPACE_DIR_HEADER_NAME] = encodeURIComponent(wsDir.trim());
    }
  }
  if (options?.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${TEMPO_API_PREFIX}${path}`, {
    method,
    headers,
    ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  return await parseJsonResponse<T>(response);
}

export function fetchWorkspace(options?: {
  dir?: string;
  stateDir?: string;
  signal?: AbortSignal;
}): Promise<TempoWorkspaceResponse> {
  const params = new URLSearchParams();
  if (options?.dir) params.set("dir", options.dir);
  if (options?.stateDir) params.set("stateDir", options.stateDir);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return tempoJson<TempoWorkspaceResponse>(`/workspace${query}`, {
    ...(options?.signal ? { signal: options.signal } : {}),
    localWrite: Boolean(options?.dir),
  });
}

export function openWorkspaceFolder(
  dir: string,
  options?: { stateDir?: string; signal?: AbortSignal },
): Promise<TempoWorkspaceResponse> {
  return tempoJson<TempoWorkspaceResponse>("/workspace/open", {
    method: "POST",
    body: {
      dir,
      ...(options?.stateDir ? { stateDir: options.stateDir } : {}),
    },
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

export function importWorkspacePaths(
  paths: string[],
  options?: {
    dir?: string;
    workspaceDir?: string | null;
    copyIntoWorkspace?: boolean;
    signal?: AbortSignal;
  },
): Promise<TempoUploadResponse> {
  return tempoJson<TempoUploadResponse>("/workspace/import", {
    method: "POST",
    body: {
      paths,
      ...(options?.dir ? { dir: options.dir } : {}),
      ...(options?.copyIntoWorkspace !== undefined
        ? { copyIntoWorkspace: options.copyIntoWorkspace }
        : {}),
    },
    includeWorkspaceHeader: !options?.dir,
    ...(options?.workspaceDir !== undefined ? { workspaceDir: options.workspaceDir } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

export async function uploadAudioFiles(
  files: readonly File[],
  options?: { dir?: string; workspaceDir?: string | null; signal?: AbortSignal },
): Promise<TempoUploadResponse> {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file, file.name);
  }
  const params = new URLSearchParams();
  if (options?.dir) params.set("dir", options.dir);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const headers: Record<string, string> = {
    [LOCAL_HEADER_NAME]: LOCAL_HEADER_VALUE,
  };
  if (!options?.dir) {
    const wsDir = options?.workspaceDir ?? activeClientWorkspaceDir;
    if (typeof wsDir === "string" && wsDir.trim().length > 0) {
      headers[WORKSPACE_DIR_HEADER_NAME] = encodeURIComponent(wsDir.trim());
    }
  }
  const response = await fetch(`${TEMPO_API_PREFIX}/workspace/import-upload${query}`, {
    method: "POST",
    headers,
    body: form,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  return await parseJsonResponse<TempoUploadResponse>(response);
}

export function openSongSession(
  songId: string,
  signal?: AbortSignal,
  workspaceDir?: string | null,
): Promise<TempoSongSessionPayload> {
  return tempoJson<TempoSongSessionPayload>(`/songs/${encodeURIComponent(songId)}/open`, {
    method: "POST",
    body: {},
    includeWorkspaceHeader: true,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    ...(signal ? { signal } : {}),
  });
}

export function fetchSongSession(
  songId: string,
  signal?: AbortSignal,
): Promise<TempoSongSessionPayload> {
  return tempoJson<TempoSongSessionPayload>(`/songs/${encodeURIComponent(songId)}`, {
    ...(signal ? { signal } : {}),
  });
}

export async function fetchSongAudioBytes(
  songId: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(`${TEMPO_API_PREFIX}/songs/${encodeURIComponent(songId)}/audio`, {
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Failed to load song audio (HTTP ${response.status}).`);
  }
  return await response.arrayBuffer();
}

export interface AuditionAudioSlice {
  bytes: ArrayBuffer;
  startSample: number | null;
  endSample: number | null;
  sampleRate: number | null;
}

function parseOptionalHeaderInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function fetchAuditionAudio(
  songId: string,
  params: { t0: number; t1: number; filter: AuditionFilter },
  signal?: AbortSignal,
): Promise<AuditionAudioSlice> {
  const query = new URLSearchParams({
    t0: String(params.t0),
    t1: String(params.t1),
    filter: params.filter,
  });
  const response = await fetch(
    `${TEMPO_API_PREFIX}/songs/${encodeURIComponent(songId)}/audition?${query.toString()}`,
    {
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = `Failed to render audition audio (HTTP ${response.status}).`;
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string" && parsed.error.length > 0) {
          message = parsed.error;
        } else {
          message = text.slice(0, 200);
        }
      } catch {
        message = text.slice(0, 200);
      }
    }
    throw new Error(message);
  }
  const startSample = parseOptionalHeaderInt(response.headers.get("X-Audition-Start-Sample"));
  const endSample = parseOptionalHeaderInt(response.headers.get("X-Audition-End-Sample"));
  const sampleRate = parseOptionalHeaderInt(response.headers.get("X-Audition-Sample-Rate"));
  const bytes = await response.arrayBuffer();
  return {
    bytes,
    startSample,
    endSample,
    sampleRate: sampleRate !== null && sampleRate > 0 ? sampleRate : null,
  };
}

export async function fetchAuditionAudioBytes(
  songId: string,
  params: { t0: number; t1: number; filter: AuditionFilter },
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const slice = await fetchAuditionAudio(songId, params, signal);
  return slice.bytes;
}

export function applySongOps(
  songId: string,
  ops: EditOp | EditOp[],
  signal?: AbortSignal,
  workspaceDir?: string | null,
): Promise<TempoSongSessionPayload> {
  return tempoJson<TempoSongSessionPayload>(`/songs/${encodeURIComponent(songId)}/edit`, {
    method: "POST",
    body: Array.isArray(ops) ? { ops } : { op: ops },
    includeWorkspaceHeader: true,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    ...(signal ? { signal } : {}),
  });
}

export function applySongAction(
  songId: string,
  action: "undo" | "redo" | "ready",
  extra?: Record<string, unknown>,
  signal?: AbortSignal,
  workspaceDir?: string | null,
): Promise<TempoSongSessionPayload> {
  return tempoJson<TempoSongSessionPayload>(`/songs/${encodeURIComponent(songId)}/edit`, {
    method: "POST",
    body: { action, ...extra },
    includeWorkspaceHeader: true,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    ...(signal ? { signal } : {}),
  });
}

export function suggestSongSnaps(
  songId: string,
  params: { timeSec: number; windowSec?: number; immediate?: boolean },
  signal?: AbortSignal,
  workspaceDir?: string | null,
): Promise<TempoSuggestSnapsResponse> {
  return tempoJson<TempoSuggestSnapsResponse>(`/songs/${encodeURIComponent(songId)}/snaps`, {
    method: "POST",
    body: {
      timeSec: params.timeSec,
      windowSec: params.windowSec ?? 0.12,
      immediate: params.immediate ?? true,
    },
    includeWorkspaceHeader: true,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    ...(signal ? { signal } : {}),
  });
}

export function recomputeSong(
  songId: string,
  params: { scope: Range | "song"; reason?: string },
  signal?: AbortSignal,
  workspaceDir?: string | null,
): Promise<TempoRecomputeResponse> {
  return tempoJson<TempoRecomputeResponse>(`/songs/${encodeURIComponent(songId)}/recompute`, {
    method: "POST",
    body: {
      scope: params.scope,
      reason: params.reason ?? "User requested recompute",
    },
    includeWorkspaceHeader: true,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    ...(signal ? { signal } : {}),
  });
}

export function setHoldOffers(
  songId: string,
  hold: boolean,
  signal?: AbortSignal,
  workspaceDir?: string | null,
): Promise<TempoHoldOffersResponse> {
  return tempoJson<TempoHoldOffersResponse>(`/songs/${encodeURIComponent(songId)}/hold-offers`, {
    method: "POST",
    body: { hold },
    includeWorkspaceHeader: true,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    ...(signal ? { signal } : {}),
  });
}

export function acceptOffer(
  songId: string,
  offerId: string,
  signal?: AbortSignal,
  workspaceDir?: string | null,
): Promise<TempoOfferActionResponse> {
  return tempoJson<TempoOfferActionResponse>(
    `/songs/${encodeURIComponent(songId)}/offers/${encodeURIComponent(offerId)}/accept`,
    {
      method: "POST",
      body: {},
      includeWorkspaceHeader: true,
      ...(workspaceDir !== undefined ? { workspaceDir } : {}),
      ...(signal ? { signal } : {}),
    },
  );
}

export function rejectOffer(
  songId: string,
  offerId: string,
  reason?: string,
  signal?: AbortSignal,
  workspaceDir?: string | null,
): Promise<TempoOfferActionResponse> {
  return tempoJson<TempoOfferActionResponse>(
    `/songs/${encodeURIComponent(songId)}/offers/${encodeURIComponent(offerId)}/reject`,
    {
      method: "POST",
      body: reason ? { reason } : {},
      includeWorkspaceHeader: true,
      ...(workspaceDir !== undefined ? { workspaceDir } : {}),
      ...(signal ? { signal } : {}),
    },
  );
}

export function exportSong(
  songId: string,
  params: {
    format: "osu" | "jsonl" | "clip";
    t0?: number;
    t1?: number;
    filter?: AuditionFilter;
  },
  signal?: AbortSignal,
  workspaceDir?: string | null,
): Promise<TempoExportResponse> {
  return tempoJson<TempoExportResponse>(`/songs/${encodeURIComponent(songId)}/export`, {
    method: "POST",
    body: { ...params },
    includeWorkspaceHeader: true,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    ...(signal ? { signal } : {}),
  });
}
