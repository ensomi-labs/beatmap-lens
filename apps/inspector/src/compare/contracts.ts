import type { ManiaChart } from "beatmap-lens";

export interface ComparisonExcerpt {
  id: string;
  start_ms: number;
  end_ms: number;
  hint: string;
}

export interface ComparisonSource {
  chart_path: string;
  model: string;
}

export interface ComparisonPair {
  id: string;
  title: string;
  audio_path: string;
  charts: [ComparisonSource, ComparisonSource];
  difficulty_band?: number | string;
  seed?: number;
  excerpts?: ComparisonExcerpt[];
}

export interface ComparisonManifest {
  version: 1;
  id: string;
  pairs: ComparisonPair[];
}

export type ComparisonVerdict = "a_better" | "b_better" | "no_difference" | "cant_tell";

export interface VerdictRecord {
  version: 1;
  id: string;
  comparison_id: string;
  pair_id: string;
  excerpt: ComparisonExcerpt;
  shown_a: ComparisonSource & { sha256: string };
  shown_b: ComparisonSource & { sha256: string };
  verdict: ComparisonVerdict;
  note: string;
  time: string;
  playback_rate: number;
}

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

export interface BlindExcerpt {
  charts: [ManiaChart, ManiaChart];
  verdict?: VerdictRecord;
}
