import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import { type AnnotationDraft, hasMeaningfulDraft, MemorySessionStore } from "./session-store";

describe("MemorySessionStore", () => {
  it("implements preferences, persisted handles, and the keyed draft journal", async () => {
    const store = new MemorySessionStore();
    const handle = { kind: "directory", name: "dataset" };
    const draft: AnnotationDraft = {
      annotationEditorDirty: true,
      base: null,
      datasetId: "dataset-a",
      editorText: "unfinished",
      exemplarRoles: [{ kind: "strong", tagId: "stream" }],
      labels: [{ salience: 2, tagId: "stream" }],
      noteRefs: [],
      playheadMs: 1_000,
      range: { endMs: 2_000, startMs: 500 },
      rangeEditor: { end: "broken", start: "01:02." },
      reviewNoteIncludeSelection: false,
      reviewNoteText: "definition still needs review",
      sourceSha256: "a".repeat(64),
      undoState: [{ action: "select" }],
      visualSpeed: 480,
    };

    await store.setDirectoryHandle("dataset", handle);
    await store.setPreferences({
      annotatorId: "expert-a",
      musicEnabled: false,
      visualSpeed: 480,
    });
    await store.putDraft(draft);

    expect(await store.getDirectoryHandle("dataset")).toBe(handle);
    expect(await store.getPreferences()).toEqual({
      annotatorId: "expert-a",
      audioOffsetMs: 0,
      audioVolume: 0.8,
      musicEnabled: false,
      visualSpeed: 480,
    });
    expect(await store.getDraft("dataset-a", "a".repeat(64))).toEqual(draft);
    expect((await store.getDraft("dataset-a", "a".repeat(64)))?.rangeEditor).toEqual({
      end: "broken",
      start: "01:02.",
    });
    expect(await store.getDraft("dataset-b", "a".repeat(64))).toBeUndefined();
  });

  it("normalizes optional audio offset preferences", async () => {
    const store = new MemorySessionStore();

    await store.setPreferences({
      annotatorId: "expert-a",
      musicEnabled: true,
      visualSpeed: 240,
    });

    expect(await store.getPreferences()).toEqual({
      annotatorId: "expert-a",
      audioOffsetMs: 0,
      audioVolume: 0.8,
      musicEnabled: true,
      visualSpeed: 240,
    });

    await store.setPreferences({
      annotatorId: "expert-a",
      audioOffsetMs: -120,
      audioVolume: 0.35,
      musicEnabled: true,
      visualSpeed: 240,
    });

    expect(await store.getPreferences()).toEqual({
      annotatorId: "expert-a",
      audioOffsetMs: -120,
      audioVolume: 0.35,
      musicEnabled: true,
      visualSpeed: 240,
    });
  });

  it("lists drafts for one dataset without sharing mutable records", async () => {
    const store = new MemorySessionStore();
    const first = draftFor("dataset-a", "b", { editorText: "first" });
    const second = draftFor("dataset-a", "a", { editorText: "second" });
    await store.putDraft(first);
    await store.putDraft(second);
    await store.putDraft(draftFor("dataset-b", "c", { editorText: "other dataset" }));

    const listed = await store.listDrafts("dataset-a");

    expect(listed.map((draft) => draft.sourceSha256)).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(listed).toEqual([second, first]);
    const firstListed = listed[0];
    if (!firstListed) throw new Error("Expected a listed draft.");
    firstListed.labels = [{ salience: 1, tagId: "mutated" }];
    expect((await store.getDraft("dataset-a", "a".repeat(64)))?.labels).toEqual([]);
  });

  it("normalizes drafts saved before exemplar role metadata", async () => {
    const store = new MemorySessionStore();
    const legacy = legacyDraftFor("dataset-a", "a", { editorText: "old local work" });
    await store.putDraft(legacy as AnnotationDraft);

    expect(await store.getDraft("dataset-a", "a".repeat(64))).toEqual({
      ...legacy,
      exemplarRoles: [],
    });
    expect(await store.listDrafts("dataset-a")).toEqual([{ ...legacy, exemplarRoles: [] }]);
    expect(hasMeaningfulDraft(legacy as AnnotationDraft)).toBe(true);
    expect(hasMeaningfulDraft(legacyDraftFor("dataset-a", "b") as AnnotationDraft)).toBe(false);
  });

  it("persists drafts assembled from Vue reactive state", async () => {
    const store = new MemorySessionStore();
    const state = reactive({
      base: { revision: 2, sha256: "b".repeat(64) },
      exemplarRoles: [{ kind: "strong" as const, tagId: "stream" }],
      labels: [{ salience: 2 as const, tagId: "stream" }],
      undoState: [
        {
          draftEnd: "2000",
          draftStart: "1000",
          editingAnnotationId: "annotation-a",
          exemplarRoles: [{ kind: "strong" as const, tagId: "stream" }],
          judgmentNote: "before edit",
          labels: [{ salience: 2 as const, tagId: "stream" }],
          manualExclusions: ["note-b"],
          selectedNoteIds: ["note-a"],
        },
      ],
    });
    const draft = draftFor("dataset-a", "a", {
      base: state.base,
      exemplarRoles: state.exemplarRoles,
      labels: state.labels,
      undoState: state.undoState,
    });

    await store.putDraft(draft);

    expect(await store.getDraft("dataset-a", "a".repeat(64))).toEqual({
      ...draft,
      base: { revision: 2, sha256: "b".repeat(64) },
      exemplarRoles: [{ kind: "strong", tagId: "stream" }],
      labels: [{ salience: 2, tagId: "stream" }],
      undoState: [
        {
          draftEnd: "2000",
          draftStart: "1000",
          editingAnnotationId: "annotation-a",
          exemplarRoles: [{ kind: "strong", tagId: "stream" }],
          judgmentNote: "before edit",
          labels: [{ salience: 2, tagId: "stream" }],
          manualExclusions: ["note-b"],
          selectedNoteIds: ["note-a"],
        },
      ],
    });
  });

  it("distinguishes meaningful editor drafts from recoverable playback state", () => {
    expect(
      hasMeaningfulDraft(
        draftFor("dataset-a", "a", {
          annotationEditorDirty: false,
          playheadMs: 12_000,
          range: { endMs: 2_000, startMs: 1_000 },
          reviewNoteText: "   ",
        }),
      ),
    ).toBe(false);
    expect(hasMeaningfulDraft(draftFor("dataset-a", "b", { annotationEditorDirty: true }))).toBe(
      true,
    );
    expect(
      hasMeaningfulDraft(
        draftFor("dataset-a", "c", {
          annotationEditorDirty: false,
          reviewNoteText: "needs source check",
        }),
      ),
    ).toBe(true);
    expect(
      hasMeaningfulDraft(draftFor("dataset-a", "d", { rangeEditor: { end: "bad", start: "" } })),
    ).toBe(true);
  });
});

function draftFor(
  datasetId: string,
  sourceHashCharacter: string,
  overrides: Partial<AnnotationDraft> = {},
): AnnotationDraft {
  return {
    base: null,
    datasetId,
    editorText: "",
    exemplarRoles: [],
    labels: [],
    noteRefs: [],
    playheadMs: 0,
    range: null,
    sourceSha256: sourceHashCharacter.repeat(64),
    undoState: [],
    visualSpeed: 240,
    ...overrides,
  };
}

function legacyDraftFor(
  datasetId: string,
  sourceHashCharacter: string,
  overrides: Partial<AnnotationDraft> = {},
): Omit<AnnotationDraft, "exemplarRoles"> {
  const { exemplarRoles: _exemplarRoles, ...draft } = draftFor(
    datasetId,
    sourceHashCharacter,
    overrides,
  );
  return draft;
}
