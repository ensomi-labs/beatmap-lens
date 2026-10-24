import type { Mark } from "./contracts";
import type { TimeRange } from "./time-view";

/** One passage's marks with its undo history. Selection alone is not an undoable change. */
export interface MarksState {
  marks: Mark[];
  selectedId: string | null;
  past: Snapshot[];
  future: Snapshot[];
}

interface Snapshot {
  marks: Mark[];
  selectedId: string | null;
}

export function marksState(marks: Mark[] = []): MarksState {
  return { marks: sorted(marks), selectedId: null, past: [], future: [] };
}

function sorted(marks: Mark[]): Mark[] {
  return [...marks].sort((a, b) => a.time_ms - b.time_ms);
}

function commit(state: MarksState, marks: Mark[], selectedId: string | null): MarksState {
  return {
    marks: sorted(marks),
    selectedId,
    past: [...state.past, { marks: state.marks, selectedId: state.selectedId }],
    future: [],
  };
}

export function selectedMark(state: MarksState): Mark | undefined {
  return state.marks.find((mark) => mark.id === state.selectedId);
}

export function addMark(state: MarksState, mark: Mark): MarksState {
  return commit(state, [...state.marks, mark], mark.id);
}

export function removeSelected(state: MarksState): MarksState {
  const mark = selectedMark(state);
  if (!mark) return state;
  return commit(
    state,
    state.marks.filter((other) => other !== mark),
    null,
  );
}

/**
 * Moves the selected mark by `deltaMs`, kept inside `span`. An edit after reveal is no longer
 * blind, and stays so.
 */
export function nudgeSelected(
  state: MarksState,
  deltaMs: number,
  span: TimeRange,
  revealed: boolean,
): MarksState {
  const mark = selectedMark(state);
  if (!mark) return state;
  const time_ms = Math.min(span.endMs, Math.max(span.startMs, mark.time_ms + deltaMs));
  if (time_ms === mark.time_ms) return state;
  const moved: Mark = {
    ...mark,
    time_ms,
    nudged_ms: mark.nudged_ms + (time_ms - mark.time_ms),
    blind: mark.blind && !revealed,
  };
  return commit(
    state,
    state.marks.map((other) => (other === mark ? moved : other)),
    mark.id,
  );
}

export function flipSelected(state: MarksState, revealed: boolean): MarksState {
  const mark = selectedMark(state);
  if (!mark) return state;
  const flipped: Mark = {
    ...mark,
    kind: mark.kind === "beat" ? "unbeat" : "beat",
    blind: mark.blind && !revealed,
  };
  return commit(
    state,
    state.marks.map((other) => (other === mark ? flipped : other)),
    mark.id,
  );
}

export function selectMark(state: MarksState, id: string | null): MarksState {
  return { ...state, selectedId: id };
}

/** The next (`1`) or previous (`-1`) mark from the selection, or from `fromMs` without one. */
export function adjacentMark(
  state: MarksState,
  direction: 1 | -1,
  fromMs: number,
): Mark | undefined {
  const selected = selectedMark(state);
  const index = selected ? state.marks.indexOf(selected) : -1;
  if (selected) return state.marks[index + direction];
  if (direction === 1) return state.marks.find((mark) => mark.time_ms > fromMs);
  return [...state.marks].reverse().find((mark) => mark.time_ms < fromMs);
}

/** The mark nearest to `timeMs` within `toleranceMs`. */
export function markNear(state: MarksState, timeMs: number, toleranceMs: number): Mark | undefined {
  let best: Mark | undefined;
  for (const mark of state.marks) {
    const distance = Math.abs(mark.time_ms - timeMs);
    if (distance <= toleranceMs && (!best || distance < Math.abs(best.time_ms - timeMs)))
      best = mark;
  }
  return best;
}

export function undo(state: MarksState): MarksState {
  const previous = state.past.at(-1);
  if (!previous) return state;
  return {
    ...previous,
    past: state.past.slice(0, -1),
    future: [{ marks: state.marks, selectedId: state.selectedId }, ...state.future],
  };
}

export function redo(state: MarksState): MarksState {
  const next = state.future[0];
  if (!next) return state;
  return {
    ...next,
    past: [...state.past, { marks: state.marks, selectedId: state.selectedId }],
    future: state.future.slice(1),
  };
}

/** True when the marks differ from `saved` (ids, kinds, times or provenance). */
export function differsFrom(state: MarksState, saved: Mark[]): boolean {
  return JSON.stringify(state.marks) !== JSON.stringify(sorted(saved));
}
