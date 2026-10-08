import type { ManiaChart, ManiaNote } from "beatmap-lens";
import type { ComparisonExcerpt } from "./contracts.ts";

/** Source-time placement differences, not a quality or musicality score. */
export function proposeExcerpts(a: ManiaChart, b: ManiaChart): ComparisonExcerpt[] {
  const differences: { time: number; weight: number }[] = [];
  for (let column = 0; column < a.keyCount; column++) {
    const left = a.notes.filter((note) => note.column === column);
    const right = b.notes.filter((note) => note.column === column);
    let i = 0;
    let j = 0;
    const unmatched = (note: ManiaNote) => differences.push({ time: note.startMs, weight: 1 });
    while (i < left.length || j < right.length) {
      const x = left[i];
      const y = right[j];
      if (x && y && Math.abs(x.startMs - y.startMs) <= 20) {
        if (Math.abs(x.endMs - y.endMs) > 20) {
          differences.push({ time: Math.min(x.endMs, y.endMs), weight: 0.25 });
        }
        i++;
        j++;
      } else if (x && (!y || x.startMs < y.startMs)) {
        unmatched(x);
        i++;
      } else if (y) {
        unmatched(y);
        j++;
      }
    }
  }
  const end = Math.max(a.range.endMs, b.range.endMs, 10_000);
  const duration = Math.min(15_000, end);
  const starts = new Set<number>([0, Math.max(0, end - duration)]);
  for (let start = 1000; start + duration <= end; start += 1000) starts.add(start);
  const candidates = [...starts]
    .map((start) => ({
      start,
      score: differences.reduce(
        (score, event) =>
          score + (event.time >= start && event.time < start + duration ? event.weight : 0),
        0,
      ),
    }))
    .sort((x, y) => y.score - x.score || x.start - y.start);
  const selected: ComparisonExcerpt[] = [];
  for (const candidate of candidates) {
    if (selected.length === 5 || (candidate.score === 0 && selected.length)) break;
    if (
      selected.some(
        (entry) => candidate.start < entry.end_ms && candidate.start + duration > entry.start_ms,
      )
    )
      continue;
    selected.push({
      id: `diff-${Math.round(candidate.start)}`,
      start_ms: candidate.start,
      end_ms: candidate.start + duration,
      hint:
        candidate.score > 0
          ? "Listen for extra or missing notes, their accents, and room to breathe."
          : "Same note placement within 20 ms. Listen for any felt difference.",
    });
  }
  return selected;
}
