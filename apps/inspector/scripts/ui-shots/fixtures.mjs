/**
 * Synthetic inputs for interface screenshots and browser checks, with no external data:
 *
 * - `music/`: a timing session of six passages over 32 s of 122 BPM drums, bass and pad (48 kHz
 *   stereo float32 PCM), four anonymous proposals per passage, and its identity key.
 * - `fixtures/`: two `.osu` charts of the same groove with a 16-bit WAV, a comparison manifest and
 *   an annotation catalog, for Compare, Review, Annotate and Inspect.
 *
 * Usage: node fixtures.mjs <out-dir>
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  process.stderr.write("Usage: node fixtures.mjs <out-dir>\n");
  process.exit(1);
}

/** A small seeded generator (mulberry32), so every run writes the same bytes. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rate = 48_000;
const seconds = 32;
const frames = rate * seconds;
const bpm = 122;
const beat = 60 / bpm;
const first = 0.731;
const left = new Float64Array(frames);
const right = new Float64Array(frames);
const noise = random(7);

function add(at, signal, pan = 0, gain = 1) {
  const start = Math.round(at * rate);
  for (let i = 0; i < signal.length && start + i < frames; i++) {
    const value = signal[i] * gain;
    left[start + i] += value * (1 - Math.max(0, pan));
    right[start + i] += value * (1 + Math.min(0, pan));
  }
}

function kick() {
  const n = Math.round(0.35 * rate);
  const signal = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const x = i / rate;
    phase += (2 * Math.PI * (45 + 110 * Math.exp(-x * 28))) / rate;
    signal[i] = Math.sin(phase) * Math.exp(-x * 9) * 0.9;
  }
  return signal;
}

function snare() {
  const n = Math.round(0.22 * rate);
  return Float64Array.from({ length: n }, (_, i) => {
    const x = i / rate;
    const hiss = (noise() * 2 - 1) * 1.6 * Math.exp(-x * 22);
    return hiss * 0.35 + Math.sin(2 * Math.PI * 190 * x) * Math.exp(-x * 30) * 0.4;
  });
}

function hat() {
  const n = Math.round(0.06 * rate);
  let previous = 0;
  return Float64Array.from({ length: n }, (_, i) => {
    const value = noise() * 2 - 1;
    const high = value - previous;
    previous = value;
    return high * Math.exp(-(i / rate) * 70) * 0.12;
  });
}

const beats = [];
for (let time = first; time < seconds - 0.4; time += beat) beats.push(time);

const kickSound = kick();
for (const [index, at] of beats.entries()) {
  if (index % 4 === 0 || index % 4 === 2 || index % 8 === 7) add(at, kickSound);
  if (index % 4 === 1 || index % 4 === 3) add(at, snare(), 0.1);
  add(at, hat(), -0.3);
  add(at + beat / 2, hat(), -0.3, 0.7);
}

// Bass: eighth notes on a four-bar progression.
const roots = [55, 55, 43.65, 49];
for (const [index, at] of beats.entries()) {
  const root = roots[Math.floor(index / 4) % 4];
  const n = Math.round((beat / 2) * rate * 0.9);
  const note = Float64Array.from({ length: n }, (_, i) => {
    const x = i / rate;
    const wave =
      Math.sign(Math.sin(2 * Math.PI * root * x)) * 0.5 +
      Math.sin(2 * Math.PI * root * 2 * x) * 0.3;
    return wave * Math.exp(-x * 6) * 0.18;
  });
  add(at, note);
  add(at + beat / 2, note);
}

// Pad: one sustained chord per bar with a slow attack.
const chords = [
  [220, 277.18, 329.63],
  [220, 261.63, 329.63],
  [174.61, 220, 261.63],
  [196, 246.94, 293.66],
];
for (let bar = 0; bar <= Math.floor(beats.length / 4); bar++) {
  const n = Math.round(4 * beat * rate);
  const chord = chords[bar % 4];
  const pad = Float64Array.from({ length: n }, (_, i) => {
    const x = i / rate;
    const envelope = Math.min(1, x / 0.4) * Math.exp(-x * 0.3);
    let sum = 0;
    for (const f of chord)
      sum += Math.sin(2 * Math.PI * f * x) + 0.3 * Math.sin(2 * Math.PI * f * 2.01 * x);
    return sum * envelope * 0.035;
  });
  add(first + bar * 4 * beat, pad, 0.2);
}

let peak = 0;
for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
const interleaved = new Float32Array(frames * 2);
for (let i = 0; i < frames; i++) {
  interleaved[2 * i] = (left[i] * 0.8) / peak;
  interleaved[2 * i + 1] = (right[i] * 0.8) / peak;
}
const pcm = Buffer.from(interleaved.buffer);
const digest = createHash("sha256").update(pcm).digest("hex");

const music = join(out, "music");
for (const folder of ["audio", "sessions", "private"])
  await mkdir(join(music, folder), { recursive: true });
const audioPath = join(music, "audio", "music48.f32");
await writeFile(audioPath, pcm);

const beatMs = beats.map((b) => Math.round(b * 1e6) / 1000);
const round3 = (value) => Math.round(value * 1000) / 1000;
const proposalTimes = [
  beatMs,
  beatMs.map((value) => round3(value + 6)),
  beatMs.map((value) => round3(value - 9 + (0.6 * value) / 1000)),
  beatMs.map((value) => round3(value + beat * 500)),
];

function passage(index, startMs, endMs, hint, flags) {
  const keys = ["p1", "p2", "p3", "p4"];
  return {
    id: `passage-${String(index + 1).padStart(2, "0")}`,
    title: `Passage ${String(index + 1).padStart(2, "0")}`,
    start_ms: startMs,
    end_ms: endMs,
    context_before_ms: 1000,
    context_after_ms: 1000,
    hint,
    flags,
    loudness_gain_db: -6.4 - index,
    audio: {
      path: audioPath,
      format: "f32le-interleaved",
      sha256: digest,
      pcm_sha256: digest,
      sample_rate: rate,
      channels: 2,
      frames,
      decode: {
        decoder: "libsndfile",
        decoder_version: "1.2.2",
        binding: "soundfile",
        binding_version: "0.13.1",
        lead_rule: "osu-lead-v1",
        lead_samples: 0,
        native_decode_frames: frames,
      },
    },
    proposals: keys.map((key, k) => ({
      key,
      beats_ms: proposalTimes[(index + k) % 4].filter(
        (value) => value >= startMs - 1000 && value <= endMs + 1000,
      ),
    })),
  };
}

const passages = [
  passage(0, 1000, 12000, "Kick on one and three, snare on two and four.", []),
  passage(1, 9000, 21000, "Bass moves in eighths; the pad changes each bar.", ["dense"]),
  passage(2, 18000, 30000, "Same groove, later in the recording.", []),
  passage(3, 4000, 14000, "Listen for the pickup kick before each fourth bar.", ["pickup"]),
  passage(4, 12000, 24000, "Hats on the off-beats.", []),
  passage(5, 20000, 31000, "Ending: does the last bar keep its pulse?", ["ending"]),
];
const names = ["grid-exact", "grid-plus6", "grid-drift", "half-beat"];
await writeFile(
  join(music, "sessions", "music.timing.json"),
  JSON.stringify(
    {
      version: 1,
      id: "music",
      clock: "osu",
      reveal_key_path: "../private/music.identities.json",
      passages,
    },
    null,
    1,
  ),
);
await writeFile(
  join(music, "private", "music.identities.json"),
  JSON.stringify(
    {
      version: 1,
      session_id: "music",
      passages: Object.fromEntries(
        passages.map((row, i) => [
          row.id,
          Object.fromEntries([0, 1, 2, 3].map((k) => [`p${k + 1}`, { name: names[(i + k) % 4] }])),
        ]),
      ),
    },
    null,
    1,
  ),
);

// Charts of the same groove for the other modes.
const fixtures = join(out, "fixtures");
const corpus = join(fixtures, "corpus", "groove");
await mkdir(corpus, { recursive: true });
await mkdir(join(fixtures, "dataset"), { recursive: true });

const wav = Buffer.alloc(44 + frames * 4);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + frames * 4, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate * 4, 28);
wav.writeUInt16LE(4, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(frames * 4, 40);
for (let i = 0; i < frames * 2; i++)
  wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, interleaved[i])) * 32767), 44 + i * 2);
await writeFile(join(corpus, "audio.wav"), wav);

function chart(seed, version) {
  const next = random(seed);
  const beatMsLength = 60_000 / bpm;
  const lines = [];
  let index = 0;
  for (let time = first * 1000; time < 31_000; index++) {
    const columns = [0, 1, 2, 3].sort(() => next() - 0.5).slice(0, index % 4 === 0 ? 2 : 1);
    for (const column of columns) {
      const x = [64, 192, 320, 448][column];
      if (next() < 0.12)
        lines.push(
          `${x},192,${Math.round(time)},128,0,${Math.round(time + beatMsLength)}:0:0:0:0:`,
        );
      else lines.push(`${x},192,${Math.round(time)},1,0,0:0:0:0:`);
    }
    time += beatMsLength / (next() < 0.55 ? 2 : 1);
  }
  return [
    "osu file format v14",
    "",
    "[General]",
    "AudioFilename: audio.wav",
    "Mode: 3",
    "",
    "[Metadata]",
    "Title:Synthetic Groove",
    "Artist:Beatmap Lens",
    "Creator:Fixture",
    `Version:${version}`,
    "",
    "[Difficulty]",
    "CircleSize:4",
    "OverallDifficulty:7",
    "",
    "[TimingPoints]",
    `${Math.round(first * 1000)},${beatMsLength},4,2,0,60,1,0`,
    "",
    "[HitObjects]",
    ...lines,
    "",
  ].join("\n");
}

await writeFile(join(corpus, "chart.osu"), chart(1, "Normal"));
await writeFile(join(corpus, "chart-b.osu"), chart(2, "Normal"));
const index = "path\ngroove/chart.osu\n";
await writeFile(join(fixtures, "corpus", "index.csv"), index);
await writeFile(
  join(fixtures, "catalog.json"),
  JSON.stringify({
    version: 1,
    catalog: {
      source: "index.csv",
      sha256: createHash("sha256").update(index).digest("hex"),
      categoryEnum: ["stream", "jack"],
    },
    corpus: { root: "corpus" },
    pathCategories: { "corpus/groove/chart.osu": ["stream"] },
  }),
);
await writeFile(
  join(fixtures, "comparison.json"),
  JSON.stringify({
    version: 1,
    id: "fixture-trial",
    pairs: [
      {
        id: "groove",
        title: "Synthetic Groove",
        audio_path: join(corpus, "audio.wav"),
        charts: [
          { chart_path: join(corpus, "chart.osu"), model: "model-one" },
          { chart_path: join(corpus, "chart-b.osu"), model: "model-two" },
        ],
        difficulty_band: 3,
        seed: 0,
        excerpts: [
          { id: "a", start_ms: 2000, end_ms: 14000, hint: "Listen for the snare on two and four." },
          { id: "b", start_ms: 14000, end_ms: 28000, hint: "Do the hats lead the notes?" },
        ],
      },
    ],
  }),
);
process.stdout.write(
  `${JSON.stringify({ session: join(music, "sessions", "music.timing.json"), fixtures, digest })}\n`,
);
