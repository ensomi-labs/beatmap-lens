/**
 * Writes a playhead-offset calibration session for a setup with FineTune in the output path.
 *
 * The sync fixture used so far puts its ticks in digital silence. FineTune's onset gate arms after
 * 200 ms with every buffer's peak at or below 1e-4 (about −80 dBFS), mutes the first louder buffer
 * and fades in over 40 ms, so there every tick is heard late by where it falls in FineTune's buffer
 * (0-10.7 ms at 512 frames and 48 kHz, changing from tick to tick). Here the same kind of ticks sit
 * on a continuous noise floor at a peak of −60 dBFS, which keeps the gate from arming.
 *
 * Two passages, 48 and 44.1 kHz, each 12 s of stereo float32: ticks (880 Hz, 20 dBFS below full
 * scale, 30 ms exponential decay, starting at zero phase on their sample) at 1, 2, ... 11 s, shown
 * as one proposal named "ticks" with a bar on each tick.
 *
 *   node calibration-session.mjs DIR
 *   node apps/inspector/server/timing-server.ts --session DIR/sessions/calibration.timing.json
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const floorPeak = 1e-3;
export const tickPeak = 0.1;
export const tickTimesMs = Array.from({ length: 11 }, (_, index) => (index + 1) * 1000);

/** A deterministic 32-bit xorshift generator in [0, 1). */
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

/** Interleaved stereo: the floor everywhere, each tick added on its own sample. */
export function calibrationAudio(sampleRate, seconds = 12) {
  const frames = sampleRate * seconds;
  const next = random(sampleRate);
  const data = new Float32Array(frames * 2);
  for (let index = 0; index < data.length; index++) data[index] = (next() * 2 - 1) * floorPeak;
  const tickFrames = Math.round(sampleRate * 0.15);
  for (const ms of tickTimesMs) {
    const first = Math.round((ms * sampleRate) / 1000);
    for (let n = 0; n < tickFrames; n++) {
      const t = n / sampleRate;
      const value = tickPeak * Math.sin(2 * Math.PI * 880 * t) * Math.exp(-t / 0.03);
      data[(first + n) * 2] += value;
      data[(first + n) * 2 + 1] += value;
    }
  }
  return { data, frames };
}

export function writeCalibrationSession(dir) {
  mkdirSync(join(dir, "audio"), { recursive: true });
  mkdirSync(join(dir, "private"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const passages = [];
  for (const sampleRate of [48_000, 44_100]) {
    const { data, frames } = calibrationAudio(sampleRate);
    const bytes = Buffer.from(data.buffer);
    const path = join(dir, "audio", `calibration-${sampleRate}.f32`);
    writeFileSync(path, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    passages.push({
      id: `calibration-${sampleRate}`,
      title: `Calibration ${sampleRate / 1000} kHz`,
      start_ms: 500,
      end_ms: 11_500,
      context_before_ms: 500,
      context_after_ms: 500,
      hint: "Ticks at whole seconds over a quiet noise floor",
      flags: [],
      loudness_gain_db: 0,
      audio: {
        path,
        format: "f32le-interleaved",
        sha256: sha,
        pcm_sha256: sha,
        sample_rate: sampleRate,
        channels: 2,
        frames,
        decode: { decoder: "synthetic", lead_rule: "osu-lead-v1", lead_samples: 0 },
      },
      proposals: [{ key: "ticks", beats_ms: tickTimesMs }],
    });
  }
  const sessionPath = join(dir, "sessions", "calibration.timing.json");
  writeFileSync(
    sessionPath,
    `${JSON.stringify(
      {
        version: 1,
        id: "calibration",
        clock: "osu",
        reveal_key_path: "../private/calibration.identities.json",
        passages,
      },
      null,
      1,
    )}\n`,
  );
  writeFileSync(
    join(dir, "private", "calibration.identities.json"),
    `${JSON.stringify({
      version: 1,
      session_id: "calibration",
      passages: Object.fromEntries(passages.map((p) => [p.id, { ticks: { name: "ticks" } }])),
    })}\n`,
  );
  return { sessionPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv[2]) {
    process.stderr.write("Usage: node calibration-session.mjs DIR\n");
    process.exit(1);
  }
  console.log(writeCalibrationSession(process.argv[2]));
}
