import type { ManiaNote } from "beatmap-lens";
import { describe, expect, it } from "vitest";
import { viewportYToSourceTime } from "./buffered-scene";
import {
  createGestureTransaction,
  finalizeGestureTransaction,
  previewGestureTransaction,
  recordValidGesturePreview,
  updateGestureTransaction,
} from "./gesture-transaction";
import { ManiaNoteTimeIndex } from "./note-time-index";
import { createTimelineRange } from "./timeline-range";

interface EditorState {
  readonly range: { readonly startMs: number; readonly endMs: number };
  readonly selectedNoteIds: readonly string[];
}

describe("gesture transaction", () => {
  it("keeps the latest pointer coordinate without treating movement as a valid preview", () => {
    const transaction = createTransaction();

    updateGestureTransaction(transaction, 180);
    updateGestureTransaction(transaction, 240);

    expect(transaction).toMatchObject({
      anchorMs: 100,
      hasValidPreview: false,
      lastCoordinate: 240,
      pointerId: 7,
      startCoordinate: 120,
    });
  });

  it("rolls back to the complete pre-gesture snapshot when the final value collapses", () => {
    const transaction = createTransaction();
    updateGestureTransaction(transaction, 260);
    recordValidGesturePreview(transaction);
    updateGestureTransaction(transaction, 120);

    const finalization = finalizeGestureTransaction(transaction, undefined);

    expect(finalization).toEqual({
      outcome: "rollback",
      transaction: {
        kind: "timeline-create",
        pointerId: 7,
        anchorMs: 100,
        startCoordinate: 120,
        lastCoordinate: 120,
        hasValidPreview: true,
        before: {
          editorState: {
            range: { startMs: 20, endMs: 80 },
            selectedNoteIds: ["first"],
          },
          undoStackLength: 3,
          rangeError: "Existing range error",
          rangeNotePage: 2,
          autosavePending: true,
        },
      },
    });
  });

  it("restores a valid preview as soon as the gesture becomes invalid", () => {
    const transaction = createTransaction();

    expect(previewGestureTransaction(transaction, { startMs: 100, endMs: 200 })).toEqual({
      outcome: "apply",
      firstValid: true,
      value: { startMs: 100, endMs: 200 },
    });
    expect(previewGestureTransaction(transaction, { startMs: 100, endMs: 240 })).toEqual({
      outcome: "apply",
      firstValid: false,
      value: { startMs: 100, endMs: 240 },
    });
    expect(previewGestureTransaction(transaction, undefined)).toEqual({ outcome: "restore" });
  });

  it("does nothing when a gesture is invalid before any valid preview", () => {
    expect(previewGestureTransaction(createTransaction(), undefined)).toEqual({ outcome: "noop" });
  });

  it("rolls back a timeline preview that collapses at the final anchor snap", () => {
    const transaction = createTransaction();
    const previewRange = createTimelineRange(1_000, 2_001, noteIndex, rangeOptions);
    const finalRange = createTimelineRange(1_000, 1_001, noteIndex, rangeOptions);

    expect(previewGestureTransaction(transaction, previewRange)).toMatchObject({
      outcome: "apply",
      value: { startMs: 1_000, endMs: 2_000 },
    });
    expect(finalRange).toBeUndefined();
    expect(finalizeGestureTransaction(transaction, finalRange).outcome).toBe("rollback");
  });

  it("rolls back the same collapsed final state after viewport projection", () => {
    const transaction = createTransaction();
    const viewport = {
      judgmentLineRatio: 0.8,
      playheadMs: 1_000,
      projection: {
        type: "linear" as const,
        range: { startMs: -1_000, endMs: 5_000 },
        direction: "bottom-to-top" as const,
        pixelsPerSecond: 250,
        contentTopPx: 24,
        contentHeightPx: 1_500,
      },
      sourceRange: { startMs: 0, endMs: 4_000 },
      viewportHeight: 500,
    };
    const anchorMs = viewportYToSourceTime({ ...viewport, viewportY: 400 });
    const previewMs = viewportYToSourceTime({ ...viewport, viewportY: 150 });
    const finalMs = viewportYToSourceTime({ ...viewport, viewportY: 400 });
    const previewRange = createTimelineRange(anchorMs, previewMs, noteIndex, rangeOptions);
    const finalRange = createTimelineRange(anchorMs, finalMs, noteIndex, rangeOptions);

    expect(previewGestureTransaction(transaction, previewRange)).toMatchObject({
      outcome: "apply",
      value: { startMs: 1_000, endMs: 2_000 },
    });
    expect(finalRange).toBeUndefined();
    expect(finalizeGestureTransaction(transaction, finalRange).outcome).toBe("rollback");
  });

  it("commits only the final value while retaining the original state for one undo", () => {
    const transaction = createTransaction();
    recordValidGesturePreview(transaction);
    updateGestureTransaction(transaction, 280);

    const finalization = finalizeGestureTransaction(transaction, {
      startMs: 100,
      endMs: 300,
    });

    expect(finalization.outcome).toBe("commit");
    if (finalization.outcome !== "commit") throw new Error("Expected a commit.");
    expect(finalization.value).toEqual({ startMs: 100, endMs: 300 });
    expect(finalization.transaction.before.editorState).toEqual({
      range: { startMs: 20, endMs: 80 },
      selectedNoteIds: ["first"],
    });
    expect(finalization.transaction.before.undoStackLength).toBe(3);
  });
});

function createTransaction() {
  const editorState: EditorState = {
    range: { startMs: 20, endMs: 80 },
    selectedNoteIds: ["first"],
  };

  return createGestureTransaction({
    kind: "timeline-create",
    pointerId: 7,
    anchorMs: 100,
    startCoordinate: 120,
    before: {
      editorState,
      undoStackLength: 3,
      rangeError: "Existing range error",
      rangeNotePage: 2,
      autosavePending: true,
    },
  });
}

const notes = [maniaNote("snap-1000", 1_000), maniaNote("snap-2000", 2_000)];
const noteIndex = new ManiaNoteTimeIndex(notes);
const rangeOptions = { chartEndMs: 4_000 };

function maniaNote(id: string, startMs: number): ManiaNote {
  return {
    column: 0,
    endMs: startMs,
    hitSound: 0,
    id,
    kind: "normal",
    sourceKind: "normal",
    sourceLine: 1,
    startMs,
    x: 64,
  };
}
