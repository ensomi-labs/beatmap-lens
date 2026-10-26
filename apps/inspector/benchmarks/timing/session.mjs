/**
 * Writes the synthetic timing session the latency harness plays: float32 PCM, the session file,
 * its identity key and, optionally, a marks file with one saved snapshot per passage.
 *
 * - `noise48`, `noise44`: 30 s of stereo white noise at 48 and 44.1 kHz, about −12 dBFS. Each
 *   passage has one proposal with a bar every 250 ms; the harness reads the drawn bars to learn
 *   the time axis, so it needs no access to the page's state.
 * - `pulses48`: 20 s of silence at 48 kHz with a one-sample pulse of 0.5 at every whole 500 ms.
 *   Each pulse from 1 s on has one saved beat mark after it, at an offset that cycles through
 *   `clickOffsetSamples`, so clicks at marks sit at fractional sample positions.
 *
 * Usage: node session.mjs DIR [--marks N]
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

/**
 * Offsets (48 kHz samples) of the saved marks from their pulses: on the pulse, fractional parts
 * .5, .75, .4 and .6, and at least 3 samples apart so each click is attributed to its mark.
 */
export const clickOffsetSamples = [0, 3.5, 7.75, 40.4, 100.6];
export const pulseLevel = 0.5;
export const pulseStepMs = 500;

/** A deterministic 32-bit xorshift generator. */
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 2 ** 32;
  };
}

function noise(sampleRate, seconds, channels, seed) {
  const next = random(seed);
  const data = new Float32Array(sampleRate * seconds * channels);
  for (let index = 0; index < data.length; index++) data[index] = (next() * 2 - 1) * 0.25;
  return data;
}

function pulses(sampleRate, seconds, channels) {
  const data = new Float32Array(sampleRate * seconds * channels);
  for (let ms = pulseStepMs; ms < seconds * 1000; ms += pulseStepMs) {
    const frame = (ms * sampleRate) / 1000;
    for (let channel = 0; channel < channels; channel++)
      data[frame * channels + channel] = pulseLevel;
  }
  return data;
}

function beats(fromMs, toMs, stepMs) {
  const times = [];
  for (let ms = fromMs; ms < toMs; ms += stepMs) times.push(ms);
  return times;
}

export const recordings = {
  noise48: { sampleRate: 48_000, seconds: 30, make: () => noise(48_000, 30, 2, 0x5eed) },
  noise44: { sampleRate: 44_100, seconds: 30, make: () => noise(44_100, 30, 2, 0xbeef) },
  pulses48: { sampleRate: 48_000, seconds: 20, make: () => pulses(48_000, 20, 2) },
};

/**
 * Passage id → recording and span; one proposal with a bar every 250 ms. Without saved marks the
 * page opens the first passage, so the harness starts at 48 kHz.
 */
const passages = [
  { id: "p-noise48", recording: "noise48", startMs: 2000, endMs: 28_000 },
  { id: "p-pulses48", recording: "pulses48", startMs: 1000, endMs: 19_000 },
  { id: "p-noise44", recording: "noise44", startMs: 2000, endMs: 28_000 },
];

/**
 * Writes the session under `dir` and returns its paths. `marks` puts that many saved beat marks
 * on `p-noise48`, spread over its span; `p-pulses48` always gets one mark after each pulse from
 * 1 s on (see `clickOffsetSamples`).
 */
export function writeSession(dir, { marks = 0 } = {}) {
  const audioDir = join(dir, "audio");
  mkdirSync(audioDir, { recursive: true });
  mkdirSync(join(dir, "private"), { recursive: true });
  const audio = {};
  for (const [name, recording] of Object.entries(recordings)) {
    const bytes = Buffer.from(recording.make().buffer);
    const path = join(audioDir, `${name}.f32`);
    writeFileSync(path, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    audio[name] = {
      path,
      format: "f32le-interleaved",
      sha256: sha,
      pcm_sha256: sha,
      sample_rate: recording.sampleRate,
      channels: 2,
      frames: recording.sampleRate * recording.seconds,
      decode: { decoder: "synthetic", lead_rule: "osu-lead-v1", lead_samples: 0 },
    };
  }
  const session = {
    version: 1,
    id: "latency",
    clock: "osu",
    reveal_key_path: "../private/latency.identities.json",
    passages: passages.map((passage) => ({
      id: passage.id,
      title: passage.id,
      start_ms: passage.startMs,
      end_ms: passage.endMs,
      context_before_ms: 1000,
      context_after_ms: 1000,
      hint: "",
      flags: [],
      loudness_gain_db: 0,
      audio: audio[passage.recording],
      proposals: [
        { key: "p1", beats_ms: beats(0, recordings[passage.recording].seconds * 1000, 250) },
      ],
    })),
  };
  const sessions = join(dir, "sessions");
  mkdirSync(sessions, { recursive: true });
  const sessionPath = join(sessions, "latency.timing.json");
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 1)}\n`);
  writeFileSync(
    join(dir, "private", "latency.identities.json"),
    `${JSON.stringify({
      version: 1,
      session_id: "latency",
      passages: Object.fromEntries(passages.map((p) => [p.id, { p1: { name: "grid" } }])),
    })}\n`,
  );
  const saved = { "p-pulses48": [] };
  for (let k = 2; k * pulseStepMs < 19_000; k++)
    saved["p-pulses48"].push(k * pulseStepMs + (clickOffsetSamples[k % 5] * 1000) / 48_000);
  if (marks > 0) {
    const step = (28_000 - 2000) / marks;
    saved["p-noise48"] = Array.from({ length: marks }, (_, index) => 2000 + step * (index + 0.5));
  }
  const lines = Object.entries(saved).map(([passageId, times]) => {
    const passage = session.passages.find((p) => p.id === passageId);
    return JSON.stringify(saveEvent(passage, times));
  });
  const marksPath = join(sessions, "latency.timing.marks.jsonl");
  writeFileSync(marksPath, `${lines.join("\n")}\n`);
  return { sessionPath, marksPath };
}

function saveEvent(passage, times) {
  const rate = passage.audio.sample_rate;
  return {
    version: 1,
    type: "save",
    id: randomUUID(),
    session_id: "latency",
    passage_id: passage.id,
    time: new Date(0).toISOString(),
    clock: "osu",
    passage: { start_ms: passage.start_ms, end_ms: passage.end_ms },
    audio: { ...passage.audio, path: undefined },
    page: {},
    setup: "latency harness",
    playback: {},
    proposals_shown: [{ key: "p1", colour_index: 0, legend_index: 0, visible_at_save: true }],
    marks: times.map((time_ms) => ({
      id: randomUUID(),
      kind: "beat",
      time_ms,
      sample: Math.floor((time_ms * rate) / 1000 + 0.5),
      placed: new Date(0).toISOString(),
      method: "click",
      zoom_ms_per_px: 1,
      rate_at_placement: 1,
      blind: true,
      nudged_ms: 0,
      snapped_to: null,
    })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { marks: { type: "string", default: "0" } },
  });
  if (!positionals[0]) {
    process.stderr.write("Usage: node session.mjs DIR [--marks N]\n");
    process.exit(1);
  }
  console.log(writeSession(positionals[0], { marks: Number(values.marks) }));
}
