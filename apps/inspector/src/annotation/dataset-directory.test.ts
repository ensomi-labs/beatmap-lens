import { describe, expect, it } from "vitest";
import { serializeFoundationV1 } from "./canonical-json";
import type { AnnotationDocumentV1, JudgmentFoundationV1 } from "./contracts";
import {
  type AnnotationSaveContext,
  createDatasetDirectory,
  DatasetWriteError,
  openDatasetDirectory,
  openDatasetDirectoryAnyVersion,
  ReadonlyFutureVersionError,
  saveDraftAnnotation,
} from "./dataset-directory";
import { type AnnotationDraft, MemorySessionStore } from "./session-store";
import { inspectOsuSourceV1 } from "./source-identity";
import { createStableNoteRefsV1 } from "./stable-note-ref";
import { FakeDirectoryHandle, fixtureDocument, fixtureFoundation } from "./test-helpers";

describe("FileSystemDatasetDirectory", () => {
  it("creates and reopens a verified dataset with an immutable Foundation snapshot", async () => {
    const root = new FakeDirectoryHandle();
    const directory = await createFixtureDataset(root);
    const reopened = await openDatasetDirectory(root);

    expect(reopened.manifest).toEqual(directory.manifest);
    expect(
      serializeFoundationV1(await reopened.readFoundation(reopened.manifest.currentFoundation)),
    ).toBe(serializeFoundationV1(fixtureFoundation()));
    const foundations = await root.getDirectoryHandle("foundations");
    expect([...foundations.children.keys()]).toEqual([
      `${reopened.manifest.currentFoundation.sha256}.judgment-foundation.v1.json`,
    ]);
  });

  it("caches a verified Foundation read by digest for the directory session", async () => {
    const root = new FakeDirectoryHandle();
    const directory = await createFixtureDataset(root);
    const reference = directory.manifest.currentFoundation;
    const reads = await instrumentFoundationByteReads(root, reference.sha256);

    await expectCanonicalFoundationRead(directory.readFoundation(reference));
    await expect(
      directory.readFoundation({ ...reference, revision: reference.revision + 1 }),
    ).rejects.toThrow("pinned identity");
    reads.file.setText("corrupt");

    await expectCanonicalFoundationRead(directory.readFoundation(reference));
    expect(reads.arrayBufferReads).toBe(1);
  });

  it("evicts failed Foundation reads so corrected bytes can be retried", async () => {
    const root = new FakeDirectoryHandle();
    const directory = await createFixtureDataset(root);
    const reference = directory.manifest.currentFoundation;
    const reads = await instrumentFoundationByteReads(root, reference.sha256);

    reads.file.setText("corrupt");
    await expect(directory.readFoundation(reference)).rejects.toThrow();
    expect(reads.arrayBufferReads).toBe(1);

    reads.file.setText(serializeFoundationV1(fixtureFoundation()));
    await expectCanonicalFoundationRead(directory.readFoundation(reference));
    await expectCanonicalFoundationRead(directory.readFoundation(reference));
    expect(reads.arrayBufferReads).toBe(2);
  });

  it("opens an unknown future dataset as a minimal read-only summary", async () => {
    const root = new FakeDirectoryHandle();
    await root.getDirectoryHandle("annotations", { create: true });
    const datasetFile = await root.getFileHandle("dataset.json", { create: true });
    datasetFile.setText(
      JSON.stringify({
        contract: "beatmap-lens-section-dataset",
        corpusRoot: "/private/corpus",
        datasetId: "future-dataset",
        name: "Future dataset",
        version: 2,
      }),
    );

    const opened = await openDatasetDirectoryAnyVersion(root);
    expect(opened.mode).toBe("readonly-future");
    expect(opened.manifest).toEqual({
      contract: "beatmap-lens-section-dataset",
      datasetId: "future-dataset",
      name: "Future dataset",
      version: 2,
    });
    expect(JSON.stringify(opened)).not.toContain("/private/corpus");
    expect("saveAnnotation" in opened).toBe(false);
  });

  it("preserves a journaled draft when an optimistic save conflicts", async () => {
    const root = new FakeDirectoryHandle();
    const directory = await createFixtureDataset(root);
    const sessions = new MemorySessionStore();
    const { context, document } = await emptyWorkflowDocument(directory.manifest.currentFoundation);

    await sessions.putDraft(draftFor(directory.manifest.datasetId, document.source.sha256, null));
    const first = await saveDraftAnnotation(directory, sessions, document, context);
    expect(first.status).toBe("saved");
    if (first.status !== "saved") throw new Error("expected save");

    const staleDraft = draftFor(
      directory.manifest.datasetId,
      document.source.sha256,
      first.version,
    );
    await sessions.putDraft(staleDraft);
    const external = await directory.saveAnnotation(first.document, first.version, context);
    expect(external.status).toBe("saved");

    const conflict = await saveDraftAnnotation(directory, sessions, first.document, context);
    expect(conflict.status).toBe("conflict");
    expect(await sessions.getDraft(directory.manifest.datasetId, document.source.sha256)).toEqual(
      staleDraft,
    );
  });

  it("preserves the draft when the browser write is interrupted", async () => {
    const root = new FakeDirectoryHandle();
    const directory = await createFixtureDataset(root);
    const sessions = new MemorySessionStore();
    const { context, document } = await emptyWorkflowDocument(directory.manifest.currentFoundation);

    await sessions.putDraft(draftFor(directory.manifest.datasetId, document.source.sha256, null));
    const first = await saveDraftAnnotation(directory, sessions, document, context);
    if (first.status !== "saved") throw new Error("expected save");

    const draft = draftFor(directory.manifest.datasetId, document.source.sha256, first.version);
    await sessions.putDraft(draft);
    const annotations = await root.getDirectoryHandle("annotations");
    const file = await annotations.getFileHandle(
      `${document.source.sha256}.section-annotations.v1.json`,
    );
    file.failWrites = true;

    await expect(
      saveDraftAnnotation(directory, sessions, first.document, context),
    ).rejects.toBeInstanceOf(DatasetWriteError);
    expect(await sessions.getDraft(directory.manifest.datasetId, document.source.sha256)).toEqual(
      draft,
    );
  });

  it("preserves the draft when post-close read-back is corrupted", async () => {
    const root = new FakeDirectoryHandle();
    const directory = await createFixtureDataset(root);
    const sessions = new MemorySessionStore();
    const { context, document } = await emptyWorkflowDocument(directory.manifest.currentFoundation);

    await sessions.putDraft(draftFor(directory.manifest.datasetId, document.source.sha256, null));
    const first = await saveDraftAnnotation(directory, sessions, document, context);
    if (first.status !== "saved") throw new Error("expected save");
    const draft = draftFor(directory.manifest.datasetId, document.source.sha256, first.version);
    await sessions.putDraft(draft);
    const annotations = await root.getDirectoryHandle("annotations");
    const file = await annotations.getFileHandle(
      `${document.source.sha256}.section-annotations.v1.json`,
    );
    file.corruptWrites = true;

    await expect(
      saveDraftAnnotation(directory, sessions, first.document, context),
    ).rejects.toBeInstanceOf(DatasetWriteError);
    expect(await sessions.getDraft(directory.manifest.datasetId, document.source.sha256)).toEqual(
      draft,
    );
  });

  it("rejects an unresolved or out-of-range persisted note before writing", async () => {
    const root = new FakeDirectoryHandle();
    const directory = await createFixtureDataset(root);
    const { context, document } = await noteWorkflowDocument(directory.manifest.currentFoundation);
    const invalid: AnnotationDocumentV1 = {
      ...document,
      annotations: document.annotations.map((annotation) => ({
        ...annotation,
        range: { endMs: 500, startMs: 0 },
      })),
    };

    await expect(directory.saveAnnotation(invalid, null, context)).rejects.toThrow(
      "Every selected note must intersect",
    );
    expect(await directory.readAnnotation(invalid.source.sha256)).toBeNull();
  });

  it("rejects a stable note reference that does not resolve to the exact source tuple", async () => {
    const root = new FakeDirectoryHandle();
    const directory = await createFixtureDataset(root);
    const { context, document } = await noteWorkflowDocument(directory.manifest.currentFoundation);
    const invalid: AnnotationDocumentV1 = {
      ...document,
      annotations: document.annotations.map((annotation) => ({
        ...annotation,
        noteRefs: annotation.noteRefs.map((note) => ({
          ...note,
          column: note.column + 1,
        })),
      })),
    };

    await expect(directory.saveAnnotation(invalid, null, context)).rejects.toThrow(
      "does not resolve",
    );
    expect(await directory.readAnnotation(invalid.source.sha256)).toBeNull();
  });

  it("discovers a newer annotation sidecar as read-only and refuses to overwrite its source", async () => {
    const root = new FakeDirectoryHandle();
    const directory = await createFixtureDataset(root);
    const { context, document } = await emptyWorkflowDocument(directory.manifest.currentFoundation);
    const annotations = await root.getDirectoryHandle("annotations");
    const filename = `${document.source.sha256}.section-annotations.v2.json`;
    const future = await annotations.getFileHandle(filename, { create: true });
    future.setText(
      JSON.stringify({
        contract: "beatmap-lens-section-annotations",
        revision: 7,
        source: {
          byteLength: document.source.byteLength,
          localDirectory: "/private/corpus",
          sha256: document.source.sha256,
        },
        version: 2,
      }),
    );

    expect(await directory.scanAnnotations()).toEqual([
      {
        filename,
        revision: 7,
        source: {
          byteLength: document.source.byteLength,
          sha256: document.source.sha256,
        },
        status: "readonly-future",
        version: 2,
      },
    ]);
    await expect(directory.readAnnotation(document.source.sha256)).rejects.toBeInstanceOf(
      ReadonlyFutureVersionError,
    );
    await expect(directory.saveAnnotation(document, null, context)).rejects.toBeInstanceOf(
      ReadonlyFutureVersionError,
    );
    expect(await (await future.getFile()).text()).toContain('"version":2');
  });

  it("rejects an incompatible Foundation child before making it current", async () => {
    const root = new FakeDirectoryHandle();
    const directory = await createFixtureDataset(root);
    const current = fixtureFoundation();
    const incompatible = {
      ...current,
      parentSha256: directory.manifest.currentFoundation.sha256,
      revision: 2,
      tags: current.tags.map((tag) =>
        tag.id === "stream" ? { ...tag, definition: "Changed established meaning." } : tag,
      ),
    };

    await expect(directory.setCurrentFoundation(incompatible)).rejects.toThrow(
      "Incompatible Foundation revision",
    );
    expect(directory.manifest.currentFoundation.revision).toBe(1);
  });

  it("loads and verifies a Foundation pinned only by a resolved review note", async () => {
    const root = new FakeDirectoryHandle();
    const directory = await createFixtureDataset(root);
    const { context, document } = await emptyWorkflowDocument(directory.manifest.currentFoundation);
    const withReviewResult: AnnotationDocumentV1 = {
      ...document,
      reviewNotes: [
        {
          createdAt: "2026-08-04T00:00:00.000Z",
          id: "00000000-0000-4000-8000-000000000098",
          resultingFoundation: directory.manifest.currentFoundation,
          state: "resolved",
          text: "Promoted into the Foundation.",
        },
      ],
    };

    await expect(directory.saveAnnotation(withReviewResult, null, context)).resolves.toMatchObject({
      status: "saved",
    });
  });

  it("does not rewrite document identity or seed provenance on a matching base", async () => {
    const root = new FakeDirectoryHandle();
    const directory = await createFixtureDataset(root);
    const { context, document } = await emptyWorkflowDocument(directory.manifest.currentFoundation);
    const first = await directory.saveAnnotation(document, null, context);
    if (first.status !== "saved") throw new Error("expected save");
    const rewritten: AnnotationDocumentV1 = {
      ...first.document,
      documentId: "00000000-0000-4000-8000-000000000097",
      seedContext: { ...first.document.seedContext, suggestedTags: ["jack"] },
    };

    await expect(directory.saveAnnotation(rewritten, first.version, context)).rejects.toThrow(
      "identity and seed provenance are immutable",
    );
    expect((await directory.readAnnotation(document.source.sha256))?.document.documentId).toBe(
      document.documentId,
    );
  });

  it("does not complete a chart or clear its meaningful editor draft", async () => {
    const root = new FakeDirectoryHandle();
    const directory = await createFixtureDataset(root);
    const sessions = new MemorySessionStore();
    const { context, document } = await emptyWorkflowDocument(
      directory.manifest.currentFoundation,
      "complete",
    );
    const draft = draftFor(directory.manifest.datasetId, document.source.sha256, null);
    await sessions.putDraft(draft);

    await expect(saveDraftAnnotation(directory, sessions, document, context)).rejects.toThrow(
      "uncommitted draft",
    );
    expect(await sessions.getDraft(directory.manifest.datasetId, document.source.sha256)).toEqual(
      draft,
    );
    expect(await directory.readAnnotation(document.source.sha256)).toBeNull();
  });
});

async function createFixtureDataset(root: FakeDirectoryHandle) {
  return createDatasetDirectory(root, {
    catalogSources: [{ csvSha256: "a".repeat(64), url: "https://example.test/catalog.csv" }],
    datasetId: "00000000-0000-4000-8000-000000000010",
    foundation: fixtureFoundation(),
    name: "Fixture dataset",
    now: () => "2026-08-04T00:00:00.000Z",
  });
}

async function instrumentFoundationByteReads(root: FakeDirectoryHandle, sha256: string) {
  const foundations = await root.getDirectoryHandle("foundations");
  const file = await foundations.getFileHandle(`${sha256}.judgment-foundation.v1.json`);
  const getFile = file.getFile.bind(file);
  let arrayBufferReads = 0;
  file.getFile = async () => {
    const snapshot = await getFile();
    return {
      arrayBuffer: async () => {
        arrayBufferReads += 1;
        return snapshot.arrayBuffer();
      },
      text: () => snapshot.text(),
    };
  };

  return {
    file,
    get arrayBufferReads() {
      return arrayBufferReads;
    },
  };
}

async function expectCanonicalFoundationRead(read: Promise<JudgmentFoundationV1>) {
  expect(serializeFoundationV1(await read)).toBe(serializeFoundationV1(fixtureFoundation()));
}

function draftFor(
  datasetId: string,
  sourceSha256: string,
  base: AnnotationDraft["base"],
): AnnotationDraft {
  return {
    base,
    datasetId,
    editorText: "local unsaved judgment",
    exemplarRoles: [],
    labels: [{ salience: 2, tagId: "stream" }],
    noteRefs: [],
    playheadMs: 1_000,
    range: { endMs: 2_000, startMs: 500 },
    sourceSha256,
    undoState: [],
    visualSpeed: 240,
  };
}

async function emptyWorkflowDocument(
  foundation: Parameters<typeof fixtureDocument>[0],
  reviewState: "complete" | "in-progress" = "in-progress",
): Promise<{ document: AnnotationDocumentV1; context: AnnotationSaveContext }> {
  const sourceBytes = new TextEncoder().encode(osuSource());
  const inspected = await inspectOsuSourceV1(sourceBytes);
  const base = fixtureDocument(foundation, { reviewState });
  return {
    context: { chart: inspected.chart, sourceBytes },
    document: {
      ...base,
      annotations: [],
      source: inspected.source,
    },
  };
}

async function noteWorkflowDocument(
  foundation: Parameters<typeof fixtureDocument>[0],
): Promise<{ document: AnnotationDocumentV1; context: AnnotationSaveContext }> {
  const sourceBytes = new TextEncoder().encode(osuSource("64,192,1000,1,0,0:0:0:0:"));
  const inspected = await inspectOsuSourceV1(sourceBytes);
  const [noteRef] = createStableNoteRefsV1(inspected.chart);
  if (!noteRef) throw new Error("expected stable note reference");
  const base = fixtureDocument(foundation);
  const annotation = base.annotations[0];
  if (!annotation) throw new Error("expected fixture annotation");
  return {
    context: { chart: inspected.chart, sourceBytes },
    document: {
      ...base,
      annotations: [
        {
          ...annotation,
          labels: [{ salience: 2, tagId: "stream" }],
          noteRefs: [noteRef],
          range: { endMs: 1_001, startMs: 1_000 },
        },
      ],
      source: inspected.source,
    },
  };
}

function osuSource(hitObject?: string): string {
  return `osu file format v14

[General]
Mode: 3

[Metadata]
Title:Title
Artist:Artist
Creator:Mapper
Version:Expert

[Difficulty]
CircleSize:4

[HitObjects]
${hitObject ?? ""}
`;
}
