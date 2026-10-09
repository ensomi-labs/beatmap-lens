import { describe, expect, it } from "vitest";
import { hashFoundationV1 } from "./canonical-json";
import type {
  AnnotationDocumentV1,
  GoldAnnotationV1,
  PredictionReviewStatusV1,
  SilverPredictionV1,
} from "./contracts";
import {
  addReviewNoteV1,
  completeAnnotationDocumentV1,
  resolveReviewNoteV1,
  sameTagOverlapWarningsV1,
} from "./quality";
import { fixtureDocument, fixtureFoundation } from "./test-helpers";

const annotationId = "00000000-0000-4000-8000-000000000003";
const noteId = "00000000-0000-4000-8000-000000000004";
const noteCreatedAt = "2026-08-04T00:01:00.000Z";
const resolvedAt = "2026-08-04T00:02:00.000Z";

describe("annotation quality workflow helpers", () => {
  it("adds and resolves durable review notes while preserving creation metadata", async () => {
    const foundation = fixtureFoundation();
    const foundationRef = {
      foundationId: foundation.foundationId,
      revision: foundation.revision,
      sha256: await hashFoundationV1(foundation),
    };
    const document = fixtureDocument(foundationRef, { reviewState: "complete" });
    const noteRef = document.annotations[0]?.noteRefs[0];
    if (!noteRef) throw new Error("Expected fixture note ref");

    const withNote = addReviewNoteV1(document, {
      createId: () => noteId,
      now: () => noteCreatedAt,
      noteRefs: [noteRef],
      range: { endMs: 2_000, startMs: 1_000 },
      text: "  definition needs an exemplar  ",
    });
    const resolved = resolveReviewNoteV1(withNote, {
      id: noteId,
      now: () => resolvedAt,
      resultingFoundation: foundationRef,
      resultingGoldAnnotationId: annotationId,
    });

    expect(withNote.reviewNotes).toHaveLength(1);
    expect(withNote.reviewState).toBe("in-progress");
    expect(withNote.reviewNotes[0]).toMatchObject({
      createdAt: noteCreatedAt,
      id: noteId,
      state: "open",
      text: "definition needs an exemplar",
    });
    expect(resolved.reviewNotes[0]).toMatchObject({
      createdAt: noteCreatedAt,
      id: noteId,
      resultingFoundation: foundationRef,
      resultingGoldAnnotationId: annotationId,
      state: "resolved",
    });
    expect(resolved.reviewNotes[0]?.noteRefs).toEqual([noteRef]);
    expect(resolved.revision).toBe(document.revision + 2);
    expect(resolved.updatedAt).toBe(resolvedAt);
    expect(document.reviewNotes).toEqual([]);
  });

  it("reports same-tag overlap warnings without blocking valid overlaps", async () => {
    const foundation = fixtureFoundation();
    const foundationRef = {
      foundationId: foundation.foundationId,
      revision: foundation.revision,
      sha256: await hashFoundationV1(foundation),
    };
    const document = fixtureDocument(foundationRef);
    const seed = document.annotations[0];
    if (!seed) throw new Error("Expected fixture annotation");
    const overlappingStream: GoldAnnotationV1 = {
      ...seed,
      id: "00000000-0000-4000-8000-000000000005",
      labels: [{ salience: 1, tagId: "stream" }],
      range: { endMs: 2_500, startMs: 1_500 },
    };
    const overlappingDifferentTag: GoldAnnotationV1 = {
      ...seed,
      id: "00000000-0000-4000-8000-000000000006",
      labels: [{ salience: 1, tagId: "jack" }],
      range: { endMs: 2_500, startMs: 1_500 },
    };

    expect(
      sameTagOverlapWarningsV1({
        annotations: [seed, overlappingStream, overlappingDifferentTag],
      }),
    ).toEqual([
      {
        leftAnnotationId: seed.id,
        overlap: { endMs: 2_000, startMs: 1_500 },
        rightAnnotationId: overlappingStream.id,
        tagId: "stream",
      },
      {
        leftAnnotationId: seed.id,
        overlap: { endMs: 2_000, startMs: 1_500 },
        rightAnnotationId: overlappingDifferentTag.id,
        tagId: "jack",
      },
    ]);
  });

  it("blocks chart completion until drafts, open notes, and pending predictions are cleared", async () => {
    const foundation = fixtureFoundation();
    const foundationRef = {
      foundationId: foundation.foundationId,
      revision: foundation.revision,
      sha256: await hashFoundationV1(foundation),
    };
    const document = fixtureDocument(foundationRef);
    const blocked: AnnotationDocumentV1 = {
      ...addReviewNoteV1(document, {
        createId: () => noteId,
        now: () => noteCreatedAt,
        text: "Needs review",
      }),
      predictions: [prediction(document)],
    };

    expect(completeAnnotationDocumentV1(blocked, { hasUncommittedDraft: true })).toEqual({
      blockers: ["uncommitted-draft", "open-review-note", "pending-prediction"],
      ok: false,
    });

    const cleared = {
      ...resolveReviewNoteV1(blocked, {
        id: noteId,
        now: () => resolvedAt,
      }),
      predictions: [
        {
          ...(blocked.predictions[0] as SilverPredictionV1),
          reviewStatus: "reviewed" as PredictionReviewStatusV1,
        },
      ],
    };
    const complete = completeAnnotationDocumentV1(cleared, {
      now: () => "2026-08-04T00:04:00.000Z",
    });

    expect(complete).toMatchObject({
      ok: true,
      document: {
        reviewState: "complete",
        revision: cleared.revision + 1,
        updatedAt: "2026-08-04T00:04:00.000Z",
      },
    });
  });
});

function prediction(document: AnnotationDocumentV1): SilverPredictionV1 {
  const annotation = document.annotations[0];
  if (!annotation) throw new Error("Expected fixture annotation");
  return {
    confidence: 0.9,
    createdAt: "2026-08-04T00:00:00.000Z",
    foundation: annotation.foundation,
    id: "00000000-0000-4000-8000-000000000007",
    labels: annotation.labels,
    modelVersion: "fixture-model",
    noteRefs: annotation.noteRefs,
    producerId: "fixture-agent",
    range: annotation.range,
    reviewStatus: "pending",
    skillVersion: "fixture-skill",
  };
}
