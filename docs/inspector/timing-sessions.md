# Timing sessions

Inspector **Timing** lets a person mark where the beats of a passage are, by ear
and on the still waveform, while timing proposals are drawn in anonymous
colours. A preparation job writes a *session*, a separate *identity key* and
the audio as float32 PCM; Timing appends *save* and *reveal* events beside the
session. This page is the contract between them. How to open and use the page
is in the [Inspector guide](../../apps/inspector/README.md#timing). The parsing
and writing code is `apps/inspector/src/timing/format.ts`.

## Clock

`clock: "osu"`: time zero is sample zero of the native libsndfile decode after
the `osu-lead-v1` lead was prepended. Every time is float64 milliseconds on
that clock, including fractional sample positions, and is never rounded. A
saved mark also carries `sample = floor(time_ms * sample_rate / 1000 + 0.5)`,
derived only when it is written; `time_ms` is never recomputed from it.

## Session

UTF-8 JSON, version 1, conventionally `<name>.timing.json`. Paths inside it
are relative to the session file unless absolute; `~` is not expanded.

```json
{
  "version": 1,
  "id": "session-01",
  "clock": "osu",
  "reveal_key_path": "../private/session-01.identities.json",
  "passages": [{
    "id": "passage-01",
    "title": "Passage 01",
    "start_ms": 70000.0,
    "end_ms": 85000.0,
    "context_before_ms": 3000,
    "context_after_ms": 3000,
    "hint": "Place the pulse against the attacks.",
    "flags": [],
    "loudness_gain_db": -12.9,
    "audio": {
      "path": "/abs/path/audio/opaque-id.f32",
      "format": "f32le-interleaved",
      "sha256": "original source file SHA-256",
      "pcm_sha256": "SHA-256 of the .f32 payload",
      "sample_rate": 44100,
      "channels": 2,
      "frames": 7591680,
      "decode": { "decoder": "libsndfile", "decoder_version": "1.2.2",
                  "lead_rule": "osu-lead-v1", "lead_samples": 0 }
    },
    "proposals": [
      { "key": "p1", "beats_ms": [70109.10973387957] },
      { "key": "p2", "beats_ms": [70115.0] }
    ]
  }]
}
```

| Field | Meaning |
| --- | --- |
| `passages[].start_ms`, `end_ms` | The span where marks can be placed. |
| `context_before_ms`, `context_after_ms` | Audio shown and playable around the span, clamped to the recording; 2000 when absent. |
| `loudness_gain_db` | Constant playback gain for the optional loudness match; only attenuation is applied. |
| `audio` | One recording per passage; passages may use different recordings and rates. The payload is interleaved little-endian float32 at the native rate and channel count, exactly `frames * channels * 4` bytes. The service checks the size and `pcm_sha256` before serving it. |
| `proposals[]` | Anonymous keys and beat times only. Names live in the key file. |

## Identity key

Read by the service only for a passage whose current marks are saved, on an
explicit reveal, or for a passage already revealed. It is never served whole.
The plain-Node server checks at startup that it exists, without reading it. If
it cannot be read later, a reveal fails without being recorded, and a passage
already revealed still opens with its names shown as unavailable.

```json
{ "version": 1, "session_id": "session-01",
  "passages": { "passage-01": { "p1": { "name": "identity" } } } }
```

## What the page sees

Passage titles, hints, spans, the PCM properties (`sample_rate`, `channels`,
`frames`) behind an opaque audio handle, and proposals as `{ key,
colour_index, beats_ms }` in a shuffled legend order. No file paths except
the marks file, no hashes, no proposal names. The legend order and colours
stay the same while the service runs and are replayed from the last save.

At open the page also gets `last_setup`: the latest setup line and the latest
output device rate saved in any `*.timing.marks.jsonl` of the session's
folder (this session's and its siblings'), each with the save it came from
(`session_id`, `save_id`, `time`). Only those fields of `save` lines are read.

## Marks output

`<name>.timing.marks.jsonl` beside the session, append-only, one event per
line. The latest `save` of a passage is its current snapshot. A passage is
revealed only by a `reveal` record that names it. A line that does not parse to
an object, such as the end of an append cut short by a crash, and a line of this
session of any other kind, are skipped with a warning in the service's terminal
and on the page; the file is never rewritten, and the next event starts on a new
line.

Builds up to `4954249` count every line of the session that is not a `save` as
a reveal of the passage it names. No other kind of record is ever written to
this file, so those builds can open it safely.

```json
{ "version": 1, "type": "save", "id": "…uuid…", "session_id": "session-01",
  "passage_id": "passage-01", "time": "2026-10-25T01:12:03.120Z", "clock": "osu",
  "passage": { "start_ms": 70000, "end_ms": 85000 },
  "audio": { "sha256": "…", "pcm_sha256": "…", "format": "f32le-interleaved",
             "sample_rate": 44100, "channels": 2, "frames": 7591680, "decode": { … } },
  "page": { "transport": "copyToChannel", "context_sample_rate": 44100,
            "buffer_frames": 7591680, "buffer_channels": 2,
            "clock_method": "getOutputTimestamp", "user_agent": "…", "browser_brands": ["…"] },
  "setup": "DT 270 PRO · FineTune bypassed · 44.1 kHz device",
  "setup_source": "last-save",
  "setup_from": { "session_id": "session-01", "save_id": "…", "time": "2026-10-25T01:02:00.000Z" },
  "playback": { "rate": 1, "volume": 0.5, "loudness_match": false, "loudness_gain_db": -12.9,
                "loudness_applied_db": 0, "playhead_offset_ms": 12, "preroll_ms": 120,
                "mark_clicks": false, "device_rate_hz": 44100, "device_rate_source": "detected",
                "device_rate_from": null, "device_rate_detected_hz": 44100,
                "device_rate_detected_at": "2026-10-25T01:11:58.004Z",
                "base_latency_ms": 5.8, "output_latency_ms": 16.0 },
  "proposals_shown": [ { "key": "p3", "colour_index": 4, "legend_index": 0, "visible_at_save": true } ],
  "marks": [
    { "id": "…", "kind": "beat", "time_ms": 72468.9342, "sample": 3195880,
      "placed": "…", "method": "click", "zoom_ms_per_px": 0.25, "rate_at_placement": 0.5,
      "blind": true, "nudged_ms": -0.0227, "snapped_to": null } ],
  "note": { "text": "pulse unclear after the break", "edited": "2026-10-25T01:11:40.551Z",
            "blind": true } }
{ "version": 1, "type": "reveal", "id": "…", "session_id": "session-01",
  "passage_id": "passage-01", "time": "…", "after_save_id": "…" }
```

| Field | Meaning |
| --- | --- |
| `playback.playhead_offset_ms` | The listener's moving-bar correction in wall-clock milliseconds, applied before the playback rate; positive moves the bar earlier. It affects only the drawn playhead, never a mark. |
| `playback.mark_clicks` | `true` when any playback of this passage in the page, before this save, had clicks on the listener's own beat marks. Absent from saves made before the option existed. |
| `setup` | The listener's line about the playback setup: headphones, EQ app state, volume. Empty only with `setup_source: "none"`. |
| `setup_source` | Where `setup` came from: `typed` (entered or changed in the page since the session was opened), `last-save` (carried unchanged from the save in `setup_from`), `browser` (carried unchanged from the value this browser remembered), `none` (no setup stated). Absent from saves made before it was recorded: the listener stated the setup, possibly remembered by the browser or copied from an earlier save. |
| `setup_from` | `{ session_id, save_id, time }` of the save a `last-save` value came from, possibly another session's in the same folder; `null` otherwise. |
| `playback.device_rate_hz` | The output device rate the page worked with, or `null` when not known. A value other than `audio.sample_rate` means the system converts the rate after the page. In saves without `device_rate_source`, the rate the listener stated. |
| `playback.device_rate_source` | `typed` (chosen in the page since the session was opened), `detected` (read from a short-lived default `AudioContext`), `last-save` (carried from the save in `device_rate_from`), `browser` (remembered by this browser), `none`. |
| `playback.device_rate_detected_hz`, `device_rate_detected_at` | The latest detection and when it ran, whatever the source, so a chosen rate that disagrees with it stays visible. Detection runs only while stopped; `null` when it never ran or failed. |
| `playback.*_latency_ms` | The browser's reported `baseLatency` and `outputLatency`, for spotting setup changes. |
| `proposals_shown` | Anonymous keys only; names are joined from the key file afterwards. |
| `marks[].zoom_ms_per_px` | Milliseconds per device pixel when the mark was placed. |
| `marks[].blind` | `false` for a mark placed or edited after the passage's names were revealed. |
| `note` | The listener's optional note about this passage, one listening in Timing: `{ text, edited, blind }`, never tied to a mark or a time. `text` is trimmed and at most 4,000 characters; `edited` is when it last changed; `blind` is `false` once it was changed after the passage's names were revealed. `null` for no note; absent from saves made before notes existed. Like the marks, the latest save's note is current. |
| `marks[].method` | `click` (at the pointer), `key-playhead` (B or N, or the Beat and Unbeat buttons, at the playhead while stopped) or `key-playing` (the same while the audio plays, at the source time heard when the key or button went down, read from the output clock at the event's time stamp without the playhead offset). |

## Session note

`<name>.timing.notes.jsonl` beside the session, append-only, one line per
save of the note about the whole session. The latest line of the session is
current; an empty `text` means the note was cleared.

```json
{ "version": 1, "type": "session-note", "id": "…uuid…", "session_id": "session-01",
  "time": "2026-10-25T01:40:12.004Z", "text": "Tired by passage 05; headphones slipped once.",
  "edited": "2026-10-25T01:39:58.310Z", "revealed_passages": ["passage-01"] }
```

| Field | Meaning |
| --- | --- |
| `time` | When the note was saved. |
| `edited` | When its text last changed. |
| `revealed_passages` | Passages whose names had been revealed when the text last changed. |

The session note never goes into the marks file, and it has no `passage_id`.
Builds up to `4954249` read only the marks file and count any line there that
is not a `save` as a reveal, so a note line in it would show proposal names in
those builds; in its own file no build reads it as anything but a note.
