import type { ManiaChart } from "beatmap-lens";
import type { ComparisonExcerpt } from "./contracts.ts";

const toleranceMs = 20;
const windowMs = 15_000;
const shortestSongMs = 10_000;
const stepMs = 1000;
const maximumExcerpts = 5;

interface Difference {
  timeMs: number;
  weight: number;
}

/**
 * Up to five non-overlapping windows where the charts place notes differently, most different
 * first. This counts placement differences; it does not judge quality or musical importance.
 */
export function proposeExcerpts(a: ManiaChart, b: ManiaChart): ComparisonExcerpt[] {
  const differences = placementDifferences(a, b);
  const endMs = Math.max(a.range.endMs, b.range.endMs, shortestSongMs);
  const durationMs = Math.min(windowMs, endMs);
  const starts = new Set([0, endMs - durationMs]);
  for (let start = stepMs; start + durationMs <= endMs; start += stepMs) starts.add(start);
  const ranked = [...starts]
    .map((start) => ({ start, score: weightWithin(differences, start, start + durationMs) }))
    .sort((x, y) => y.score - x.score || x.start - y.start);

  const chosen: ComparisonExcerpt[] = [];
  for (const { start, score } of ranked) {
    if (chosen.length === maximumExcerpts || (score === 0 && chosen.length > 0)) break;
    const end = start + durationMs;
    if (chosen.some((excerpt) => start < excerpt.end_ms && end > excerpt.start_ms)) continue;
    chosen.push({
      id: `diff-${Math.round(start)}`,
      start_ms: start,
      end_ms: end,
      hint:
        score > 0
          ? "Listen for extra or missing notes, their accents, and room to breathe."
          : "Same note placement within 20 ms. Listen for any felt difference.",
    });
  }
  return chosen;
}

/** Per column, heads match within 20 ms. An unmatched head weighs 1, a moved hold end 0.25. */
function placementDifferences(a: ManiaChart, b: ManiaChart): Difference[] {
  const differences: Difference[] = [];
  for (let column = 0; column < Math.max(a.keyCount, b.keyCount); column++) {
    const left = a.notes.filter((note) => note.column === column);
    const right = b.notes.filter((note) => note.column === column);
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
      const x = left[i];
      const y = right[j];
      if (x && y && Math.abs(x.startMs - y.startMs) <= toleranceMs) {
        if (Math.abs(x.endMs - y.endMs) > toleranceMs)
          differences.push({ timeMs: Math.min(x.endMs, y.endMs), weight: 0.25 });
        i++;
        j++;
      } else if (x && (!y || x.startMs < y.startMs)) {
        differences.push({ timeMs: x.startMs, weight: 1 });
        i++;
      } else if (y) {
        differences.push({ timeMs: y.startMs, weight: 1 });
        j++;
      }
    }
  }
  return differences;
}

function weightWithin(differences: Difference[], startMs: number, endMs: number): number {
  let weight = 0;
  for (const difference of differences)
    if (difference.timeMs >= startMs && difference.timeMs < endMs) weight += difference.weight;
  return weight;
}
