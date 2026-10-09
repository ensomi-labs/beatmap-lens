# Model comparison packets

Inspector **Compare** lets a person judge two generated charts of the same song by
listening, without knowing which model produced which. An experiment job writes a
*manifest* that lists the pairs; Compare appends one *verdict* line per judgment.
This page is the contract between the two. How to open and use the page is in the
[Inspector guide](../../apps/inspector/README.md#compare).

A verdict says which chart a listener felt follows the music better in one excerpt.
It is not a pattern annotation, a Foundation label or a quality score, and it is
stored apart from the annotation datasets.

## Manifest

UTF-8 JSON, version 1. Paths are absolute or start with `~/`, and are resolved on
the machine that runs Inspector.

```json
{
  "version": 1,
  "id": "head-model-trial-001",
  "pairs": [
    {
      "id": "5150-band3-seed0",
      "title": "5150",
      "audio_path": "~/model-outputs/5150/audio.mp3",
      "charts": [
        { "chart_path": "~/model-outputs/baseline/5150/band-3-seed-0.osu", "model": "head-baseline + R2" },
        { "chart_path": "~/model-outputs/candidate/5150/band-3-seed-0.osu", "model": "head-candidate + R2" }
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

| Field | Meaning |
| --- | --- |
| `version` | Always `1`. |
| `id` | Identifies the experiment. A new experiment gets a new ID. |
| `pairs[].id` | Unique within the manifest and stable across rewrites of it. |
| `pairs[].title` | Song title, shown while blind. |
| `pairs[].audio_path` | The one audio file both charts were made for, on the same time origin. |
| `pairs[].charts` | Exactly two `{ chart_path, model }`. Order is input order only; A and B are assigned by Compare. `model` must tell the two apart. |
| `pairs[].difficulty_band`, `pairs[].seed` | Optional, shown while blind. Band is a number or a short string; seed is a number. |
| `pairs[].excerpts` | Optional, in listening order. Omit or leave empty to have Compare propose them. |
| `excerpts[].id` | Unique within its pair and stable across rewrites. |
| `excerpts[].start_ms`, `end_ms` | Half-open `[start, end)` in source audio milliseconds, usually 10–20 s long. Playback rate never changes them. |
| `excerpts[].hint` | One neutral line on what to listen for. |

The producer is responsible for matching song, difficulty, seed and audio origin;
Compare does not infer them. Everything shown while blind (the title, band, seed,
hints and the manifest and verdict file names) must stay model-neutral: no model
names, no predictions, no winner. The blinding is a property of the page, not a
security boundary against someone reading the files.

Inspector draws 4K–7K charts best; this workflow was written first for 4K
head-model comparisons.

## Proposed excerpts

When a pair has no excerpts, Compare looks for places where the charts differ.
Per column it matches note heads within 20 ms. An unmatched head counts 1 and a
matched head whose hold end moved by more than 20 ms counts 0.25. It scores every
15-second window starting on a whole second (plus the window ending at the song's
end), then takes up to five non-overlapping windows, highest score first and
earlier first on ties. Charts shorter than 15 s use one window over their length,
at least 10 s. Identical charts get one window whose hint says so.

The score counts placement differences. It does not claim that the most different
window matters most musically, or that either chart is better.

## Blinding

For every excerpt the local service decides at random which chart is A. The
browser receives note geometry only; chart metadata, model labels and paths stay
on the service until a verdict has been written. A failed write keeps the page
blind and keeps the note for a retry.

When a manifest is reopened, an excerpt that already has a verdict is shown with
the same A/B it was judged under. A verdict belongs to an excerpt when the
comparison ID, pair ID, excerpt ID and bounds match and both charts have the same
model label and file hash, in either order. Moving or reordering the chart files
therefore does not invert a verdict. Excerpts without a
verdict are shuffled again.

## Energy strip

Beside the charts, Compare draws the song's RMS energy (white) and its onset rise
(blue). Both are computed in the browser from the decoded audio, in 10 ms bins
across all channels: energy is the RMS, rise is how far it exceeds the mean of
the previous 50 ms. Each curve is scaled to its own song-wide maximum and scrolls
on the same time axis as the notes, whatever the playback rate.

RMS is an energy proxy, not perceived loudness, and a rise is not a validated
onset or accent detector: sustained, distorted, compressed or soft attacks can
look unlike how they sound. The strip helps a listener find a moment; listening
decides the verdict.

## Verdicts

Verdicts go to `<manifest name>.verdicts.jsonl` beside the manifest, or in the
folder chosen on the setup form. Two loose charts write
`comparison.verdicts.jsonl` in the chosen folder. Charts, audio and manifests are
only read.

Each verdict appends one line:

```json
{
  "version": 1,
  "id": "1f0c6c1e-6d5e-4bd6-9a0e-6a3d1c2b9f10",
  "comparison_id": "head-model-trial-001",
  "pair_id": "5150-band3-seed0",
  "excerpt": { "id": "first-breath", "start_ms": 25000, "end_ms": 40000, "hint": "Listen for the breath, then the accented return." },
  "shown_a": { "model": "head-candidate + R2", "chart_path": "/path/to/model-outputs/candidate/5150/band-3-seed-0.osu", "sha256": "…" },
  "shown_b": { "model": "head-baseline + R2", "chart_path": "/path/to/model-outputs/baseline/5150/band-3-seed-0.osu", "sha256": "…" },
  "verdict": "a_better",
  "note": "The return lands with the accent.",
  "time": "2026-10-09T01:00:00.000Z",
  "playback_rate": 1
}
```

- `verdict` is `a_better`, `b_better`, `no_difference` or `cant_tell`. A and B mean
  the charts as displayed (`shown_a`, `shown_b`), not manifest order.
- `shown_a` and `shown_b` carry the resolved path and the SHA-256 of the exact
  `.osu` bytes, so a reader can tell which file was judged.
- `note` may be empty. `time` is the service's UTC time. `playback_rate` is the
  audio rate at the moment of the choice.

The file is append-only. If an excerpt has several lines (for example from two
sessions open at once), the last one is the verdict.
