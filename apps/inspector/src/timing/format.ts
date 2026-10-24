/**
 * The timing session's files: the session input, the separate identity key file and the
 * append-only marks output. Everything that reads or writes their shape lives here, so a format
 * change is an edit to this module. The contract is documented in docs/inspector/timing-sessions.md.
 *
 * This module is pure (no Node imports) because the standalone service runs it with plain `node`
 * and the tests run it directly; the caller resolves paths.
 */
import type { Mark, PageProvenance, PlaybackSetup, RevealedName } from "./contracts.ts";

export interface SessionFileV1 {
  version: 1;
  id: string;
  /** `osu`: sample zero of the native decode after `osu-lead-v1` was prepended. */
  clock: string;
  /** Identity key file; relative to the session file unless absolute. Read only on reveal. */
  reveal_key_path: string;
  passages: PassageInputV1[];
}

export interface PassageInputV1 {
  id: string;
  title?: string;
  start_ms: number;
  end_ms: number;
  context_before_ms?: number;
  context_after_ms?: number;
  hint?: string;
  flags?: string[];
  loudness_gain_db?: number;
  audio: AudioInputV1;
  proposals?: { key: string; beats_ms: number[] }[];
}

export interface AudioInputV1 {
  /** Relative to the session file unless absolute; `~` is not expanded. */
  path: string;
  format: "f32le-interleaved";
  /** Original source file hash. */
  sha256: string;
  /** Hash of the served PCM payload. */
  pcm_sha256: string;
  sample_rate: number;
  channels: number;
  frames: number;
  decode: Record<string, unknown>;
}

export interface TimingSession {
  id: string;
  clock: string;
  revealKeyPath: string;
  passages: TimingPassage[];
}

export interface TimingPassage {
  id: string;
  title: string;
  start_ms: number;
  end_ms: number;
  context_before_ms: number;
  context_after_ms: number;
  hint: string;
  flags: string[];
  loudness_gain_db: number;
  audio: AudioInputV1;
  proposals: { key: string; beats_ms: number[] }[];
}

/** Context shown and played around a passage when the session does not state it. */
export const defaultContextMs = 2000;

/** Nearest sample index of a source time, derived only for writing; `time_ms` stays canonical. */
export function nearestSample(timeMs: number, sampleRate: number): number {
  return Math.floor((timeMs * sampleRate) / 1000 + 0.5);
}

/** Reads a session file; `resolvePath` resolves a path relative to the session file. */
export function parseSession(text: string, resolvePath: (path: string) => string): TimingSession {
  const input: SessionFileV1 = JSON.parse(text);
  if (input.version !== 1) throw new Error("Expected timing session version 1.");
  if (!input.reveal_key_path) throw new Error("The session needs a reveal_key_path.");
  return {
    id: input.id,
    clock: input.clock,
    revealKeyPath: resolvePath(input.reveal_key_path),
    passages: input.passages.map((passage) => {
      if (passage.audio.format !== "f32le-interleaved")
        throw new Error(`Passage ${passage.id}: expected f32le-interleaved audio.`);
      return {
        id: passage.id,
        title: passage.title ?? passage.id,
        start_ms: passage.start_ms,
        end_ms: passage.end_ms,
        context_before_ms: passage.context_before_ms ?? defaultContextMs,
        context_after_ms: passage.context_after_ms ?? defaultContextMs,
        hint: passage.hint ?? "",
        flags: passage.flags ?? [],
        loudness_gain_db: passage.loudness_gain_db ?? 0,
        audio: { ...passage.audio, path: resolvePath(passage.audio.path) },
        proposals: (passage.proposals ?? []).map(({ key, beats_ms }) => ({
          key,
          // Times are copied unchanged; sorting only orders them for drawing.
          beats_ms: [...beats_ms].sort((a, b) => a - b),
        })),
      };
    }),
  };
}

/** The proposals as the listener saw them, by anonymous key only. */
export interface ShownProposal {
  key: string;
  colour_index: number;
  legend_index: number;
  visible_at_save: boolean;
}

export type MarkRecord = Mark & { sample: number };

/** One line of `<session>.timing.marks.jsonl`: a full snapshot of one passage's marks. */
export interface SaveEventV1 {
  version: 1;
  type: "save";
  id: string;
  session_id: string;
  passage_id: string;
  time: string;
  clock: string;
  passage: { start_ms: number; end_ms: number };
  audio: {
    sha256: string;
    pcm_sha256: string;
    format: string;
    sample_rate: number;
    channels: number;
    frames: number;
    decode: Record<string, unknown>;
  };
  page: PageProvenance;
  setup: string;
  playback: PlaybackSetup;
  proposals_shown: ShownProposal[];
  marks: MarkRecord[];
}

export interface RevealEventV1 {
  version: 1;
  type: "reveal";
  id: string;
  session_id: string;
  passage_id: string;
  time: string;
  after_save_id: string;
}

export type TimingEvent = SaveEventV1 | RevealEventV1;

export function saveEvent(input: {
  id: string;
  time: string;
  session: TimingSession;
  passage: TimingPassage;
  marks: Mark[];
  setup: string;
  playback: PlaybackSetup;
  page: PageProvenance;
  proposals: ShownProposal[];
}): SaveEventV1 {
  const { audio } = input.passage;
  return {
    version: 1,
    type: "save",
    id: input.id,
    session_id: input.session.id,
    passage_id: input.passage.id,
    time: input.time,
    clock: input.session.clock,
    passage: { start_ms: input.passage.start_ms, end_ms: input.passage.end_ms },
    audio: {
      sha256: audio.sha256,
      pcm_sha256: audio.pcm_sha256,
      format: audio.format,
      sample_rate: audio.sample_rate,
      channels: audio.channels,
      frames: audio.frames,
      decode: audio.decode,
    },
    page: input.page,
    setup: input.setup,
    playback: input.playback,
    proposals_shown: input.proposals,
    marks: [...input.marks]
      .sort((a, b) => a.time_ms - b.time_ms)
      .map((mark) => {
        const { id, kind, time_ms, ...provenance } = mark;
        return {
          id,
          kind,
          time_ms,
          sample: nearestSample(time_ms, audio.sample_rate),
          ...provenance,
        };
      }),
  };
}

export function revealEvent(input: {
  id: string;
  time: string;
  sessionId: string;
  passageId: string;
  afterSaveId: string;
}): RevealEventV1 {
  return {
    version: 1,
    type: "reveal",
    id: input.id,
    session_id: input.sessionId,
    passage_id: input.passageId,
    time: input.time,
    after_save_id: input.afterSaveId,
  };
}

export function encodeEvent(event: TimingEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** The latest save per passage is current; a passage stays revealed once any reveal is recorded. */
export function readMarksFile(text: string, sessionId: string) {
  const saves = new Map<string, SaveEventV1>();
  const reveals = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const event: TimingEvent = JSON.parse(line);
    if (event.session_id !== sessionId) continue;
    if (event.type === "save") saves.set(event.passage_id, event);
    else reveals.add(event.passage_id);
  }
  return { saves, reveals };
}

/** Back from a record to the page's mark: the derived sample is dropped, `time_ms` is kept. */
export function markFromRecord({ sample: _sample, ...mark }: MarkRecord): Mark {
  return mark;
}

export interface KeyFileV1 {
  version: 1;
  session_id: string;
  passages: Record<string, Record<string, { name: string }>>;
}

/** Names for one passage's keys, in the order given. */
export function revealedNames(
  text: string,
  sessionId: string,
  passageId: string,
  keys: string[],
): RevealedName[] {
  const file: KeyFileV1 = JSON.parse(text);
  if (file.version !== 1 || file.session_id !== sessionId)
    throw new Error("The identity key file does not belong to this session.");
  const passage = file.passages[passageId] ?? {};
  return keys.map((key) => ({ key, name: passage[key]?.name ?? "(not in key file)" }));
}
