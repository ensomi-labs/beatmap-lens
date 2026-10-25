import { describe, expect, it } from "vitest";
import type { Mark } from "./contracts";
import { nearestSample } from "./format";
import {
  addMark,
  adjacentMark,
  differsFrom,
  flipSelected,
  markNear,
  marksState,
  nudgeSelected,
  redo,
  removeSelected,
  selectMark,
  undo,
} from "./marks";

const span = { startMs: 70_000.37, endMs: 85_000.5 };

function mark(id: string, time_ms: number, kind: Mark["kind"] = "beat"): Mark {
  return {
    id,
    kind,
    time_ms,
    placed: "2026-10-25T09:00:00.000Z",
    method: "click",
    zoom_ms_per_px: 0.25,
    rate_at_placement: 1,
    blind: true,
    nudged_ms: 0,
    snapped_to: null,
  };
}

describe("marks history", () => {
  it("undoes and redoes add, nudge, flip and delete in order, restoring the selection", () => {
    let state = marksState();
    state = addMark(state, mark("a", 72_000));
    state = addMark(state, mark("b", 71_000));
    expect(state.marks.map((m) => m.id)).toEqual(["b", "a"]);
    state = nudgeSelected(state, 1, span, false);
    state = flipSelected(state, false);
    state = selectMark(state, "a");
    state = removeSelected(state);
    expect(state.marks.map((m) => [m.id, m.kind, m.time_ms])).toEqual([["b", "unbeat", 71_001]]);

    state = undo(state);
    expect(state.marks.map((m) => m.id)).toEqual(["b", "a"]);
    expect(state.selectedId).toBe("a");
    state = undo(state);
    expect(state.marks[0]?.kind).toBe("beat");
    state = undo(state);
    expect(state.marks[0]?.time_ms).toBe(71_000);
    expect(state.selectedId).toBe("b");
    state = redo(state);
    state = redo(state);
    expect(state.marks[0]).toMatchObject({ kind: "unbeat", time_ms: 71_001, nudged_ms: 1 });
    // A new change clears the redo history.
    state = addMark(state, mark("c", 73_000));
    expect(redo(state)).toBe(state);
  });

  it("detects changes against the saved snapshot", () => {
    const saved = [mark("a", 72_000), mark("b", 71_000)];
    const state = marksState(saved);
    expect(differsFrom(state, saved)).toBe(false);
    expect(differsFrom(undo(nudgeSelected(selectMark(state, "a"), 1, span, false)), saved)).toBe(
      false,
    );
    expect(differsFrom(nudgeSelected(selectMark(state, "a"), 1, span, false), saved)).toBe(true);
  });
});

describe("nudging", () => {
  for (const sampleRate of [44_100, 48_000]) {
    it(`moves by exactly one derived sample at ${sampleRate} Hz`, () => {
      const oneSample = 1000 / sampleRate;
      for (const start of [72_468.9342, 80_000, 70_123.000_01]) {
        let state = selectMark(marksState([mark("a", start)]), "a");
        const before = nearestSample(start, sampleRate);
        state = nudgeSelected(state, oneSample, span, false);
        expect(nearestSample(state.marks[0]?.time_ms ?? 0, sampleRate)).toBe(before + 1);
        state = nudgeSelected(state, -oneSample, span, false);
        state = nudgeSelected(state, -oneSample, span, false);
        expect(nearestSample(state.marks[0]?.time_ms ?? 0, sampleRate)).toBe(before - 1);
        // The canonical time keeps its fraction; nothing snaps it to the sample grid.
        expect(state.marks[0]?.time_ms).toBeCloseTo(start - oneSample, 9);
        expect(state.marks[0]?.nudged_ms).toBeCloseTo(-oneSample, 9);
      }
    });
  }

  it("nudges by 1 ms and 0.1 ms, kept inside the passage", () => {
    let state = selectMark(marksState([mark("a", 85_000)]), "a");
    state = nudgeSelected(state, 0.1, span, false);
    expect(state.marks[0]?.time_ms).toBeCloseTo(85_000.1, 9);
    state = nudgeSelected(state, 1, span, false);
    expect(state.marks[0]?.time_ms).toBe(85_000.5);
    expect(state.marks[0]?.nudged_ms).toBeCloseTo(0.5, 9);
  });

  it("marks an edit after reveal as not blind", () => {
    const state = selectMark(marksState([mark("a", 72_000)]), "a");
    expect(nudgeSelected(state, 1, span, true).marks[0]?.blind).toBe(false);
    expect(flipSelected(state, true).marks[0]?.blind).toBe(false);
    expect(flipSelected(state, false).marks[0]?.blind).toBe(true);
  });
});

describe("finding marks", () => {
  const state = marksState([mark("a", 71_000), mark("b", 72_000), mark("c", 73_000)]);

  it("visits neighbours from the selection or from a time", () => {
    expect(adjacentMark(selectMark(state, "b"), 1, 0)?.id).toBe("c");
    expect(adjacentMark(selectMark(state, "b"), -1, 0)?.id).toBe("a");
    expect(adjacentMark(state, 1, 71_500)?.id).toBe("b");
    expect(adjacentMark(state, -1, 71_500)?.id).toBe("a");
    expect(adjacentMark(selectMark(state, "c"), 1, 0)).toBeUndefined();
  });

  it("finds the nearest mark within a tolerance", () => {
    expect(markNear(state, 72_003, 4)?.id).toBe("b");
    expect(markNear(state, 72_005, 4)).toBeUndefined();
  });
});
