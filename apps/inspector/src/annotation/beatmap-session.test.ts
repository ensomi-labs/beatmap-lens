import { describe, expect, it } from "vitest";
import { createAnnotationDocument, createGoldAnnotation } from "./beatmap-session";
import { hashFoundationV1 } from "./canonical-json";
import type {
  FoundationRefV1,
  GoldAnnotationV1,
  JudgmentFoundationV1,
  StableNoteRefV1,
} from "./contracts";
import { fixtureFoundation } from "./test-helpers";

const annotationId = "00000000-0000-4000-8000-000000000003";
const now = "2026-08-04T00:00:00.000Z";

describe("beatmap session catalog context", () => {
  it("stores canonical tag IDs derived from raw catalog labels", () => {
    const document = createAnnotationDocument(
      source,
      "a".repeat(64),
      ["Tech", "Jump Stream", "Jump Stream"],
      now,
      annotationId,
    );

    expect(document.seedContext.suggestedTags).toEqual(["jump-stream", "tech"]);
  });
});

describe("beatmap session annotation editing", () => {
  it("applies Foundation pin rules and cleans incompatible exemplar roles", async () => {
    const foundation = fixtureFoundation();
    const currentRef = await foundationRef(foundation);
    const oldRef = { ...currentRef, revision: 99, sha256: "a".repeat(64) };
    const session = {
      foundation,
      noteRefs: new Map([["runtime-note", noteRef]]),
    };
    const existing = gold(
      oldRef,
      [{ salience: 2, tagId: "stream" }],
      [{ kind: "strong", tagId: "stream" }],
    );

    const noteOnly = createGoldAnnotation(session, input(existing), currentRef);
    const roleRemoved = createGoldAnnotation(
      session,
      input(existing, { exemplarRoles: [] }),
      currentRef,
    );
    const roleAdded = createGoldAnnotation(
      session,
      input(existing, {
        exemplarRoles: [
          { kind: "strong", tagId: "stream" },
          { kind: "counterexample", tagId: "jack" },
        ],
      }),
      currentRef,
    );
    const labelChanged = createGoldAnnotation(
      session,
      input(existing, { labels: [{ salience: 2, tagId: "jack" }] }),
      currentRef,
    );

    expect(noteOnly.foundation).toEqual(oldRef);
    expect(roleRemoved.foundation).toEqual(oldRef);
    expect(roleRemoved.exemplarRoles).toEqual([]);
    expect(roleAdded.foundation).toEqual(currentRef);
    expect(labelChanged.foundation).toEqual(currentRef);
    expect(labelChanged.exemplarRoles).toEqual([]);
  });

  it("rejects new labels or roles that are not active in the current Foundation", async () => {
    const current = fixtureFoundation();
    const foundation: JudgmentFoundationV1 = {
      ...current,
      tags: [
        ...current.tags,
        {
          aliases: [],
          definition: "Retired semantic.",
          displayName: "Retired",
          id: "retired",
          inclusionCues: ["Old cue."],
          status: "retired",
        },
      ],
    };
    const currentRef = await foundationRef(foundation);
    const session = {
      foundation,
      noteRefs: new Map([["runtime-note", noteRef]]),
    };

    expect(() =>
      createGoldAnnotation(
        session,
        input(undefined, { labels: [{ salience: 2, tagId: "retired" }] }),
        currentRef,
      ),
    ).toThrow(/retired, not active/);
    expect(() =>
      createGoldAnnotation(
        session,
        input(undefined, {
          exemplarRoles: [{ kind: "counterexample", tagId: "retired" }],
        }),
        currentRef,
      ),
    ).toThrow(/retired, not active/);
  });
});

function input(
  existing?: GoldAnnotationV1,
  patch: Partial<Pick<GoldAnnotationV1, "exemplarRoles" | "labels">> = {},
): Parameters<typeof createGoldAnnotation>[1] {
  return {
    annotatorId: "expert-a",
    labels: patch.labels ?? existing?.labels ?? [{ salience: 2, tagId: "stream" }],
    noteIds: ["runtime-note"],
    range: { endMs: 1_001, startMs: 1_000 },
    now: () => now,
    ...(existing ? { existing } : {}),
    ...(patch.exemplarRoles ? { exemplarRoles: patch.exemplarRoles } : {}),
  };
}

function gold(
  foundation: FoundationRefV1,
  labels: GoldAnnotationV1["labels"],
  exemplarRoles: GoldAnnotationV1["exemplarRoles"],
): GoldAnnotationV1 {
  return {
    annotatorId: "expert-a",
    createdAt: now,
    derivedFromPredictionIds: [],
    exemplarRoles,
    foundation,
    id: annotationId,
    labels,
    noteRefs: [noteRef],
    range: { endMs: 1_001, startMs: 1_000 },
    updatedAt: now,
  };
}

async function foundationRef(foundation: JudgmentFoundationV1): Promise<FoundationRefV1> {
  return {
    foundationId: foundation.foundationId,
    revision: foundation.revision,
    sha256: await hashFoundationV1(foundation),
  };
}

const noteRef: StableNoteRefV1 = {
  column: 0,
  endMs: 1_000,
  kind: "normal",
  sourceLine: 42,
  startMs: 1_000,
};

const source: Parameters<typeof createAnnotationDocument>[0] = {
  artist: "Artist",
  byteLength: 1024,
  creator: "Mapper",
  difficulty: "Expert",
  keyCount: 4,
  normalizerId: "beatmap-lens-mania-v1",
  noteCount: 1,
  osuFormatVersion: 14,
  sha256: "b".repeat(64),
  title: "Title",
};
