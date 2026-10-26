import type { Mark } from "./contracts";
import type { TimeRange } from "./time-view";

/**
 * One passage's marks with its undo history. Selection alone is not an undoable change. Several
 * marks can be selected; the last one selected is the primary mark, which `[`/`]`, X and zoom
 * follow.
 */
export interface MarksState {
  marks: Mark[];
  selectedIds: string[];
  past: Snapshot[];
  future: Snapshot[];
}

interface Snapshot {
  marks: Mark[];
  selectedIds: string[];
}

/** How a pointer selection combines with the current one. */
export type SelectMode = "replace" | "add" | "toggle";

export function marksState(marks: Mark[] = []): MarksState {
  return { marks: sorted(marks), selectedIds: [], past: [], future: [] };
}

function sorted(marks: Mark[]): Mark[] {
  return [...marks].sort((a, b) => a.time_ms - b.time_ms);
}

function commit(state: MarksState, marks: Mark[], selectedIds: string[]): MarksState {
  return {
    marks: sorted(marks),
    selectedIds,
    past: [...state.past, { marks: state.marks, selectedIds: state.selectedIds }],
    future: [],
  };
}

/** The primary selected mark: the last selected one that still exists. */
export function selectedMark(state: MarksState): Mark | undefined {
  for (const id of [...state.selectedIds].reverse()) {
    const mark = state.marks.find((other) => other.id === id);
    if (mark) return mark;
  }
  return undefined;
}

/** Every selected mark, in time order. */
export function selectedMarks(state: MarksState): Mark[] {
  const ids = new Set(state.selectedIds);
  return state.marks.filter((mark) => ids.has(mark.id));
}

export function addMark(state: MarksState, mark: Mark): MarksState {
  return commit(state, [...state.marks, mark], [mark.id]);
}

export function removeSelected(state: MarksState): MarksState {
  const chosen = new Set(selectedMarks(state));
  if (!chosen.size) return state;
  return commit(
    state,
    state.marks.filter((other) => !chosen.has(other)),
    [],
  );
}

/**
 * Moves the selected marks together by `deltaMs`, limited so that every one stays inside `span`.
 * An edit after reveal is no longer blind, and stays so.
 */
export function nudgeSelected(
  state: MarksState,
  deltaMs: number,
  span: TimeRange,
  revealed: boolean,
): MarksState {
  const chosen = selectedMarks(state);
  const first = chosen[0];
  const last = chosen.at(-1);
  if (!first || !last) return state;
  const delta = Math.min(
    span.endMs - last.time_ms,
    Math.max(span.startMs - first.time_ms, deltaMs),
  );
  const moved = new Map<Mark, Mark>();
  for (const mark of chosen) {
    const time_ms = Math.min(span.endMs, Math.max(span.startMs, mark.time_ms + delta));
    if (time_ms === mark.time_ms) continue;
    moved.set(mark, {
      ...mark,
      time_ms,
      nudged_ms: mark.nudged_ms + (time_ms - mark.time_ms),
      blind: mark.blind && !revealed,
    });
  }
  if (!moved.size) return state;
  return commit(
    state,
    state.marks.map((other) => moved.get(other) ?? other),
    state.selectedIds,
  );
}

export function flipSelected(state: MarksState, revealed: boolean): MarksState {
  const chosen = new Set(selectedMarks(state));
  if (!chosen.size) return state;
  return commit(
    state,
    state.marks.map((mark) =>
      chosen.has(mark)
        ? {
            ...mark,
            kind: mark.kind === "beat" ? "unbeat" : "beat",
            blind: mark.blind && !revealed,
          }
        : mark,
    ),
    state.selectedIds,
  );
}

export function selectMark(state: MarksState, id: string | null): MarksState {
  return { ...state, selectedIds: id ? [id] : [] };
}

/** Replaces the selection with `ids`, adds them to it, or toggles each of them in it. */
export function selectMarks(state: MarksState, ids: string[], mode: SelectMode): MarksState {
  const known = ids.filter((id) => state.marks.some((mark) => mark.id === id));
  if (mode === "replace") return { ...state, selectedIds: known };
  const current = state.selectedIds.filter((id) => !known.includes(id));
  if (mode === "add") return { ...state, selectedIds: [...current, ...known] };
  const added = known.filter((id) => !state.selectedIds.includes(id));
  return { ...state, selectedIds: [...current, ...added] };
}

/** The ids of the marks inside `range`, ends included. */
export function marksWithin(marks: Mark[], range: TimeRange): string[] {
  return marks
    .filter((mark) => mark.time_ms >= range.startMs && mark.time_ms <= range.endMs)
    .map((mark) => mark.id);
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
    future: [{ marks: state.marks, selectedIds: state.selectedIds }, ...state.future],
  };
}

export function redo(state: MarksState): MarksState {
  const next = state.future[0];
  if (!next) return state;
  return {
    ...next,
    past: [...state.past, { marks: state.marks, selectedIds: state.selectedIds }],
    future: state.future.slice(1),
  };
}

/** True when the marks differ from `saved` (ids, kinds, times or provenance). */
export function differsFrom(state: MarksState, saved: Mark[]): boolean {
  return JSON.stringify(state.marks) !== JSON.stringify(sorted(saved));
}
