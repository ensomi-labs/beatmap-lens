# Model comparison packets

Inspector Compare is a listening workflow for two generated charts of the same
audio. It does not produce pattern annotations or quality scores. The researcher
judges whether note starts, accents, density, and rests follow the music.

Start and open it using the [Inspector instructions](../../apps/inspector/README.md).
The local endpoint is `http://127.0.0.1:5174/compare`; enter the JSON file in
**Manifest path**. A `?manifest=…` URL parameter can prefill that field, but does
not open or write a comparison automatically.

## Manifest version 1

Use UTF-8 JSON. Paths must be absolute or start with `~/`; they are resolved on
the machine running Inspector. There is no assumed ensomi checkout location.
An export job can write:

```json
{
  "version": 1,
  "id": "head-model-trial-001",
  "pairs": [
    {
      "id": "5150-band3-seed0",
      "title": "5150",
      "audio_path": "~/model-outputs/song/audio.mp3",
      "charts": [
        {
          "chart_path": "~/model-outputs/baseline/song/band-3-seed-0.osu",
          "model": "head-baseline + R2"
        },
        {
          "chart_path": "~/model-outputs/candidate/song/band-3-seed-0.osu",
          "model": "head-candidate + R2"
        }
      ],
      "difficulty_band": 3,
      "seed": 0,
      "excerpts": [
        {
          "id": "first-breath",
          "start_ms": 25000,
          "end_ms": 40000,
          "hint": "Listen for the breath, then the accented return."
        }
      ]
    }
  ]
}
```

| Field | Contract |
| --- | --- |
| `version` | Exactly `1`. |
| `id` | Stable comparison/experiment ID. Use a new ID for a new experiment. |
| `pairs` | One or more songs, each with exactly two charts. |
| Pair `id` | Stable unique ID within this comparison. |
| `title` | Human song title, shown while blind. Keep it model-neutral. |
| `audio_path` | One shared audio track, with the same time origin as both charts. |
| `charts` | Exactly two `{chart_path, model}` objects. Array order is input order, not displayed A/B order. Labels need to identify the variants unambiguously. |
| `difficulty_band`, `seed` | Optional shared metadata. Band is a number or a display string; seed is a number. Both are visible while blind. |
| `excerpts` | Optional list, in listening order. Omit it or use `[]` for automatic proposals. |
| Excerpt `id` | Stable unique ID within its pair. |
| `start_ms`, `end_ms` | Half-open interval in source audio milliseconds, normally 10–20 seconds long. Playback rate never changes these coordinates. |
| `hint` | One neutral line describing what to listen for. Avoid model names, predictions, or declaring a winner. |

The producer is responsible for matching song, difficulty, seed, and audio origin.
Compare does not run the generators or infer these experiment conditions from
filenames. `.osu` charts are baseline valid inputs. Inspector prioritizes 4K–7K;
this workflow is intended first for 4K head-model comparisons.

## Automatic excerpts

Without supplied excerpts, Inspector compares notes in each column, matching
heads within 20 ms. Unmatched heads contribute one difference; a changed hold end
contributes 0.25. It scores 15-second windows starting at one-second intervals
(plus the final window), then greedily chooses up to five non-overlapping windows
in decreasing difference order. Equal scores prefer earlier windows. An identical
pair gets one excerpt explaining that note placement matches. Charts shorter
than 15 seconds use their extent, with a ten-second minimum display interval.

This is a placement-difference heuristic. It does not claim that the highest
count is the most musically important disagreement, or that either chart is
better. Producer-supplied excerpts and hints take precedence.

## Blinding and playback

The local service randomly assigns A/B independently for every excerpt. This
assignment remains fixed while that comparison is open. Both views use one audio
element and the Inspector media clock. Switching the visible chart never restarts
the song; the loop, seek position, pitch-preserving rate, and zoom are shared.

The service sends chart geometry with metadata and diagnostics removed. Model
labels, source paths, and the assignment stay on the service until a verdict has
successfully been written. A failed save keeps the UI blind and retains the note
for retry. The manifest path, output filename, song title, band, seed, and hints
are visible, so producers should avoid identity clues there. This is research
blinding in the UI, not a security boundary against a person reading local files.

On reopen, saved verdicts restore the original mapping when comparison/pair ID,
excerpt ID and bounds, and both model labels and chart hashes match. Unsaved excerpts are shuffled
again. The UI shows completed excerpts as already judged and does not submit them
again. The file remains append-only; readers should use the latest matching
record if multiple records exist, for example from separately opened sessions.

## Audio strip

Audio analysis belongs to Inspector (`src/compare/audio-envelope.ts`), alongside
its browser playback and local service. It introduces no audio runtime or DOM
dependency into `beatmap-lens` and does not invoke ensomi-model.

The browser decodes the shared audio once per song. It computes RMS across channels
in 10 ms bins, plus positive RMS rises against the preceding 50 ms mean as a simple
onset envelope. Channels contribute squared energy so opposite polarity does not
cancel them. Each curve is normalized by its full-song maximum, identically for A
and B. White shows RMS energy; blue shows onset energy rises. They scroll with the
same source-time projection as the falling notes, independent of playback rate.

RMS is an energy proxy, not perceptual loudness; energy rises are not a validated
musical onset or emphasis detector. Sustained, distorted, compressed, and soft
attacks can look different from their perceived emphasis. Listening decides the
verdict. The display does not score alignment or decide a winner.

## Verdict JSONL

For `comparison.json`, the default output is `comparison.verdicts.jsonl` beside
it. Choosing an output folder changes the folder, preserving the filename. Two
chart paths use `comparison.verdicts.jsonl` in the required chosen folder. Only
verdict files are written; charts, audio, and manifests remain read-only.

Each click appends one UTF-8 JSON object and a newline. Required fields are:

```json
{
  "version": 1,
  "id": "a-generated-uuid",
  "comparison_id": "head-model-trial-001",
  "pair_id": "5150-band3-seed0",
  "excerpt": {
    "id": "first-breath",
    "start_ms": 25000,
    "end_ms": 40000,
    "hint": "Listen for the breath, then the accented return."
  },
  "shown_a": {
    "model": "head-candidate + R2",
    "chart_path": "/absolute/path/to/candidate.osu",
    "sha256": "sha256-of-exact-osu-bytes"
  },
  "shown_b": {
    "model": "head-baseline + R2",
    "chart_path": "/absolute/path/to/baseline.osu",
    "sha256": "sha256-of-exact-osu-bytes"
  },
  "verdict": "a_better",
  "note": "The return feels more connected to the accent.",
  "time": "2026-10-09T01:00:00.000Z",
  "playback_rate": 1
}
```

`verdict` is `a_better`, `b_better`, `no_difference`, or `cant_tell`. A/B refer to
the displayed labels, **not manifest order**. `note` can be empty. `time` is the
service's UTC ISO timestamp; `playback_rate` is the speed at submission. IDs and
source hashes preserve the context agents need to read the result. These are
model-comparison decisions, not Foundation labels or annotation records.

The local demo lives under
`~/ensomi/ensomi-model/artifacts/audio-rows-20261008/lens-demo/`. It compares two
difficulty bands of existing exports because matched model variants were not yet
available. Its automated sample verdict must be excluded from human preference
analysis.
