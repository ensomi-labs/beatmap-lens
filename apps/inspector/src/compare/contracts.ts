import type { ManiaChart } from "beatmap-lens";

/** Producer contract, documented in docs/inspector/model-comparison.md. */
export interface ComparisonManifest {
  version: 1;
  id: string;
  pairs: ComparisonPair[];
}

export interface ComparisonPair {
  id: string;
  title: string;
  audio_path: string;
  /** Input order only; the service decides which chart is shown as A. */
  charts: [ComparisonSource, ComparisonSource];
  difficulty_band?: number | string;
  seed?: number;
  excerpts?: ComparisonExcerpt[];
}

export interface ComparisonSource {
  chart_path: string;
  model: string;
}

/** Half-open `[start_ms, end_ms)` in source audio time. */
export interface ComparisonExcerpt {
  id: string;
  start_ms: number;
  end_ms: number;
  hint: string;
}

export type ComparisonVerdict = "a_better" | "b_better" | "no_difference" | "cant_tell";

export type ShownChart = ComparisonSource & { sha256: string };

/** One line of `<manifest>.verdicts.jsonl`. */
export interface VerdictRecord {
  version: 1;
  id: string;
  comparison_id: string;
  pair_id: string;
  excerpt: ComparisonExcerpt;
  shown_a: ShownChart;
  shown_b: ShownChart;
  verdict: ComparisonVerdict;
  note: string;
  time: string;
  playback_rate: number;
}

/** What the browser sees while blind: no model labels or chart paths. */
export interface OpenComparison {
  session_id: string;
  verdict_path: string;
  pairs: {
    title: string;
    difficulty_band?: number | string;
    seed?: number;
    excerpts: (ComparisonExcerpt & { saved: boolean })[];
  }[];
}

export interface ExcerptTarget {
  session_id: string;
  pair_index: number;
  excerpt_index: number;
}

/** Charts in A/B order with metadata removed; the verdict, once saved, reveals the models. */
export interface BlindExcerpt {
  charts: [ManiaChart, ManiaChart];
  verdict?: VerdictRecord;
}
