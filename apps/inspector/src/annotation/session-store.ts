import { toRaw } from "vue";
import { normalizeAudioVolume } from "./audio-volume";
import type { GoldExemplarRoleV1, StableNoteRefV1, TimeRangeV1 } from "./contracts";

export interface DraftLabel {
  salience: 1 | 2;
  tagId: string;
}

export interface DraftBaseVersion {
  revision: number;
  sha256: string;
}

export interface AnnotationDraft {
  annotationEditorDirty?: boolean;
  base: DraftBaseVersion | null;
  datasetId: string;
  editorText: string;
  editingAnnotationId?: string;
  exemplarRoles: readonly GoldExemplarRoleV1[];
  labels: readonly DraftLabel[];
  noteRefs: readonly StableNoteRefV1[];
  playheadMs: number;
  reviewNoteIncludeSelection?: boolean;
  reviewNoteText?: string;
  range: TimeRangeV1 | null;
  rangeEditor?: {
    readonly start: string;
    readonly end: string;
  };
  sourceSha256: string;
  undoState: readonly unknown[];
  visualSpeed: number;
}

type StoredAnnotationDraft = Omit<AnnotationDraft, "exemplarRoles"> & {
  readonly exemplarRoles?: readonly GoldExemplarRoleV1[];
};

export interface SessionPreferences {
  annotatorId: string;
  audioOffsetMs?: number;
  audioVolume?: number;
  musicEnabled: boolean;
  visualSpeed: number;
}

type StoredSessionPreferences = Omit<SessionPreferences, "audioOffsetMs"> & {
  readonly audioOffsetMs?: number;
};

export type DirectoryHandleKind = "corpus" | "dataset";

export interface SessionStore {
  deleteDraft(datasetId: string, sourceSha256: string): Promise<void>;
  getDirectoryHandle<T = unknown>(kind: DirectoryHandleKind): Promise<T | undefined>;
  getDraft(datasetId: string, sourceSha256: string): Promise<AnnotationDraft | undefined>;
  getPreferences(): Promise<SessionPreferences | undefined>;
  listDrafts(datasetId: string): Promise<readonly AnnotationDraft[]>;
  putDraft(draft: AnnotationDraft): Promise<void>;
  setDirectoryHandle(kind: DirectoryHandleKind, handle: unknown): Promise<void>;
  setPreferences(preferences: SessionPreferences): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  readonly #drafts = new Map<string, AnnotationDraft>();
  readonly #handles = new Map<DirectoryHandleKind, unknown>();
  #preferences?: StoredSessionPreferences;

  async deleteDraft(datasetId: string, sourceSha256: string): Promise<void> {
    this.#drafts.delete(draftKey(datasetId, sourceSha256));
  }

  async getDirectoryHandle<T = unknown>(kind: DirectoryHandleKind): Promise<T | undefined> {
    return this.#handles.get(kind) as T | undefined;
  }

  async getDraft(datasetId: string, sourceSha256: string): Promise<AnnotationDraft | undefined> {
    return clone(this.#drafts.get(draftKey(datasetId, sourceSha256)));
  }

  async getPreferences(): Promise<SessionPreferences | undefined> {
    return normalizeOptionalPreferences(this.#preferences);
  }

  async listDrafts(datasetId: string): Promise<readonly AnnotationDraft[]> {
    return [...this.#drafts.values()]
      .filter((draft) => draft.datasetId === datasetId)
      .sort(compareDrafts)
      .map(clone);
  }

  async putDraft(draft: AnnotationDraft): Promise<void> {
    this.#drafts.set(draftKey(draft.datasetId, draft.sourceSha256), clone(normalizeDraft(draft)));
  }

  async setDirectoryHandle(kind: DirectoryHandleKind, handle: unknown): Promise<void> {
    this.#handles.set(kind, handle);
  }

  async setPreferences(preferences: SessionPreferences): Promise<void> {
    this.#preferences = clone(normalizePreferences(preferences));
  }
}

export class IndexedDbSessionStore implements SessionStore {
  readonly #database: Promise<IDBDatabase>;

  constructor(name = "beatmap-lens-inspector", indexedDb: IDBFactory = indexedDB) {
    this.#database = openDatabase(indexedDb, name);
  }

  async deleteDraft(datasetId: string, sourceSha256: string): Promise<void> {
    await this.#request("drafts", "readwrite", (store) =>
      store.delete(draftKey(datasetId, sourceSha256)),
    );
  }

  async getDirectoryHandle<T = unknown>(kind: DirectoryHandleKind): Promise<T | undefined> {
    return (await this.#request("handles", "readonly", (store) => store.get(kind))) as
      | T
      | undefined;
  }

  async getDraft(datasetId: string, sourceSha256: string): Promise<AnnotationDraft | undefined> {
    return normalizeOptionalDraft(
      (await this.#request("drafts", "readonly", (store) =>
        store.get(draftKey(datasetId, sourceSha256)),
      )) as StoredAnnotationDraft | undefined,
    );
  }

  async getPreferences(): Promise<SessionPreferences | undefined> {
    return normalizeOptionalPreferences(
      (await this.#request("preferences", "readonly", (store) => store.get("current"))) as
        | StoredSessionPreferences
        | undefined,
    );
  }

  async listDrafts(datasetId: string): Promise<readonly AnnotationDraft[]> {
    const drafts = (await this.#request("drafts", "readonly", (store) =>
      store.getAll(),
    )) as StoredAnnotationDraft[];
    return drafts
      .filter((draft) => draft.datasetId === datasetId)
      .sort(compareDrafts)
      .map(normalizeDraft)
      .map(clone);
  }

  async putDraft(draft: AnnotationDraft): Promise<void> {
    await this.#request("drafts", "readwrite", (store) =>
      store.put(normalizeDraft(draft), draftKey(draft.datasetId, draft.sourceSha256)),
    );
  }

  async setDirectoryHandle(kind: DirectoryHandleKind, handle: unknown): Promise<void> {
    await this.#request("handles", "readwrite", (store) => store.put(handle, kind));
  }

  async setPreferences(preferences: SessionPreferences): Promise<void> {
    await this.#request("preferences", "readwrite", (store) =>
      store.put(normalizePreferences(preferences), "current"),
    );
  }

  async #request(
    storeName: SessionStoreName,
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest,
  ): Promise<unknown> {
    const database = await this.#database;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      let result: unknown;
      request.addEventListener("success", () => {
        result = request.result;
      });
      request.addEventListener("error", () => reject(request.error));
      transaction.addEventListener("complete", () => resolve(result));
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  }
}

type SessionStoreName = "drafts" | "handles" | "preferences";

function openDatabase(indexedDb: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(name, 1);
    request.addEventListener("upgradeneeded", () => {
      for (const storeName of ["drafts", "handles", "preferences"] satisfies SessionStoreName[]) {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function draftKey(datasetId: string, sourceSha256: string): string {
  return `${datasetId}:${sourceSha256}`;
}

export function hasMeaningfulDraft(draft: AnnotationDraft): boolean {
  if (draft.annotationEditorDirty !== undefined) {
    return draft.annotationEditorDirty || Boolean(draft.reviewNoteText?.trim());
  }
  return (
    draft.range !== null ||
    hasRangeEditorText(draft) ||
    draft.noteRefs.length > 0 ||
    draft.labels.length > 0 ||
    (draft.exemplarRoles?.length ?? 0) > 0 ||
    draft.editorText.trim().length > 0 ||
    draft.editingAnnotationId !== undefined ||
    Boolean(draft.reviewNoteText?.trim()) ||
    draft.undoState.length > 0
  );
}

function hasRangeEditorText(draft: AnnotationDraft): boolean {
  return Boolean(draft.rangeEditor?.start.trim() || draft.rangeEditor?.end.trim());
}

function compareDrafts(left: StoredAnnotationDraft, right: StoredAnnotationDraft): number {
  return left.sourceSha256.localeCompare(right.sourceSha256);
}

function normalizeDraft(draft: StoredAnnotationDraft): AnnotationDraft {
  const snapshot = snapshotReactiveData(draft);
  return { ...snapshot, exemplarRoles: snapshot.exemplarRoles ?? [] };
}

function snapshotReactiveData<T>(value: T): T {
  const raw = toRaw(value);
  if (Array.isArray(raw)) return raw.map(snapshotReactiveData) as T;
  if (typeof raw !== "object" || raw === null) return raw;
  return Object.fromEntries(
    Object.entries(raw).map(([key, entry]) => [key, snapshotReactiveData(entry)]),
  ) as T;
}

function normalizeOptionalDraft(
  draft: StoredAnnotationDraft | undefined,
): AnnotationDraft | undefined {
  return draft === undefined ? undefined : normalizeDraft(draft);
}

function normalizePreferences(preferences: StoredSessionPreferences): SessionPreferences {
  const snapshot = snapshotReactiveData(preferences);
  return {
    ...snapshot,
    audioOffsetMs: normalizeAudioOffsetMs(snapshot.audioOffsetMs),
    audioVolume: normalizeAudioVolume(snapshot.audioVolume),
  };
}

function normalizeOptionalPreferences(
  preferences: StoredSessionPreferences | undefined,
): SessionPreferences | undefined {
  return preferences === undefined ? undefined : clone(normalizePreferences(preferences));
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function normalizeAudioOffsetMs(audioOffsetMs: number | undefined): number {
  return audioOffsetMs === undefined || !Number.isFinite(audioOffsetMs) ? 0 : audioOffsetMs;
}
