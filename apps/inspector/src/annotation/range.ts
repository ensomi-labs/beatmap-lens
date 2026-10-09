import type { ManiaChart, ManiaNote } from "beatmap-lens";
import type { TimeRangeV1 } from "./contracts";

export function chartEndMs(chart: Pick<ManiaChart, "notes">): number {
  return Math.max(0, ...chart.notes.map((note) => note.endMs)) + 1;
}

export function noteIntersectsRange(note: ManiaNote, range: TimeRangeV1): boolean {
  return note.kind === "long"
    ? note.startMs < range.endMs && note.endMs > range.startMs
    : range.startMs <= note.startMs && note.startMs < range.endMs;
}

export function rangeCandidates(
  chartOrNotes: Pick<ManiaChart, "notes"> | readonly ManiaNote[],
  range: TimeRangeV1,
): readonly ManiaNote[] {
  const notes: readonly ManiaNote[] = Array.isArray(chartOrNotes)
    ? chartOrNotes
    : (chartOrNotes as Pick<ManiaChart, "notes">).notes;
  return notes.filter((note) => noteIntersectsRange(note, range));
}

export function intersectRanges(left: TimeRangeV1, right: TimeRangeV1): TimeRangeV1 | undefined {
  const startMs = Math.max(left.startMs, right.startMs);
  const endMs = Math.min(left.endMs, right.endMs);
  return startMs < endMs ? { startMs, endMs } : undefined;
}

export function expandRangeToIncludeNote(range: TimeRangeV1, note: ManiaNote): TimeRangeV1 {
  if (noteIntersectsRange(note, range)) return range;

  return {
    startMs: Math.min(range.startMs, note.startMs),
    endMs: Math.max(range.endMs, note.kind === "long" ? note.endMs : note.startMs + 1),
  };
}

export function expandRangeToIncludeNotes(
  range: TimeRangeV1,
  notes: readonly ManiaNote[],
): TimeRangeV1 {
  return notes.reduce(expandRangeToIncludeNote, range);
}
