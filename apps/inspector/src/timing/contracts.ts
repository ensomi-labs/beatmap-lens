/**
 * What crosses between the timing page and its local service. The files on disk (session input,
 * key file, marks output) are defined in `format.ts`; this module holds only the wire shapes.
 */

/**
 * The error name for an operation on a session id the service does not know, as after a restart.
 * The page reopens the same session path and retries; reopening reveals nothing.
 */
export const staleSessionError = "StaleSessionError";

export type MarkKind = "beat" | "unbeat";

/**
 * `click` at the pointer; `key-playhead` with B or N (or their buttons) at a stopped playhead;
 * `key-playing` with B or N while the audio plays, at the source time heard when the key went down.
 */
export type MarkMethod = "click" | "key-playhead" | "key-playing";

/**
 * One listener placement. `time_ms` is float64 milliseconds on the session clock (`osu`: sample
 * zero of the lead-corrected native decode) and is never rounded; the sample index is derived only
 * when a record is written.
 */
export interface Mark {
  id: string;
  kind: MarkKind;
  time_ms: number;
  placed: string;
  method: MarkMethod;
  zoom_ms_per_px: number;
  rate_at_placement: number;
  /** False once the passage's proposal names were revealed before this placement or edit. */
  blind: boolean;
  /** Sum of nudges applied since placement. */
  nudged_ms: number;
  snapped_to: null;
}

/** The PCM properties the page needs; no file path or source hash crosses the blind boundary. */
export interface BlindAudio {
  /** Opaque handle for the `audio` operation. */
  handle: string;
  format: "f32le-interleaved";
  sample_rate: number;
  channels: number;
  frames: number;
}

export interface BlindPassageRow {
  id: string;
  title: string;
  start_ms: number;
  end_ms: number;
  context_before_ms: number;
  context_after_ms: number;
  hint: string;
  flags: string[];
  loudness_gain_db: number;
  audio: BlindAudio;
  saved: boolean;
  revealed: boolean;
}

export interface OpenTiming {
  session_id: string;
  id: string;
  clock: string;
  marks_path: string;
  /** Lines of the marks file that could not be read and were skipped. */
  marks_warning?: string;
  passages: BlindPassageRow[];
}

/** One proposal while blind: an opaque key, a colour and beat times, in legend order. */
export interface BlindProposal {
  key: string;
  colour_index: number;
  beats_ms: number[];
}

export interface RevealedName {
  key: string;
  name: string;
}

export interface SavedSnapshot {
  save_id: string;
  time: string;
  setup: string;
  marks: Mark[];
}

export interface BlindPassage {
  proposals: BlindProposal[];
  saved: SavedSnapshot | null;
  /** Present only after a guarded reveal of this passage. */
  names?: RevealedName[];
  /** Why a revealed passage's names could not be read, such as a missing key file. */
  names_error?: string;
}

export interface PassageTarget {
  session_id: string;
  passage_index: number;
}

/** Playback conditions in force at save; written into every save event. */
export interface PlaybackSetup {
  rate: number;
  volume: number;
  loudness_match: boolean;
  loudness_gain_db: number;
  /** The gain actually applied: attenuation only, 0 while the toggle is off. */
  loudness_applied_db: number;
  /** Wall-clock milliseconds, applied before the playback-rate multiplication. */
  playhead_offset_ms: number;
  preroll_ms: number;
  /** A click sounded at each of the listener's own beat marks. */
  mark_clicks: boolean;
  /** The output device rate the listener declared, or null when not stated. */
  device_rate_hz: number | null;
  base_latency_ms: number | null;
  output_latency_ms: number | null;
}

/** How the page built and clocked its audio. */
export interface PageProvenance {
  transport: "copyToChannel";
  context_sample_rate: number;
  buffer_frames: number;
  buffer_channels: number;
  clock_method: "getOutputTimestamp";
  user_agent: string;
  browser_brands: string[];
}

export interface SaveRequest extends PassageTarget {
  marks: Mark[];
  setup: string;
  playback: PlaybackSetup;
  page: PageProvenance;
  /** Keys of the proposals switched on at save. */
  visible_keys: string[];
}

export interface SaveResponse {
  save_id: string;
  time: string;
}
