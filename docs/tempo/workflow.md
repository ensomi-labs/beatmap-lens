# Tempo Time Model, Cues, and Mapping Workflow

`/tempo` organizes time into three explicit tiers and treats human edits as
both immediate edits and forgiving soft constraints for constrained recompute.

## Three-Tier Time Model

1. **`Segment` (macro partition):** A contiguous, non-overlapping partition
   covering the entire canonical track `[0, durationSec)`:
   - `segments[0].t0 === 0`, `segments.at(-1).t1 === durationSec`, and
     `segments[i].t1 === segments[i + 1].t0`.
   - Each `Segment` carries a `regime` (`auto`, `free`, or `break`) and a whole-segment
     `kept: boolean` lock.
   - Users select a segment on the Whole-Song `Segment` Strip and press `V` (or
     click `Keep`) to lock a clean section in one step, drag interior boundaries
     clamped strictly between neighbor bounds, split (`S`), or merge (`M`).
2. **`Range` (transient working selection):** An ephemeral half-open interval
   `[t0, t1)` (`0 <= t0 < t1 <= durationSec`) that may cross segment boundaries:
   - Created either by `Shift+drag` on the stage/ruler (with `40 px` horizontal
     edge auto-scroll) or by setting start and end cursor points with `[` and `]`.
   - Scopes local operations (`Loop`, `Keep`, `Free`, `Shift beats`,
     `Delete beats in range`, `⌘K` recompute, WAV clip export) and can be
     promoted into permanent segment boundaries (`Promote to Segment`).
3. **`Span` (child sub-interval):** A persistent or derived interval strictly
   contained within a single parent `Segment` (`seg.t0 <= span.t0 < span.t1 <= seg.t1`):
   - Represents ranked `inbox` review regions, `PatchOffer` `writeScopes`, and
     partial `keep` or `free` sub-locks decomposed from cross-segment `Range`
     actions (`decomposeRangeToSpans`).

## Five Forgiving User Cues

Every cue acts immediately on session state and compiles into `CompiledConstraints`
for subsequent `⌘K` recomputes:

| Action | Immediate state effect | Compiled constraint role |
| --- | --- | --- |
| **`Beat` (`B`)** | Inserts or updates a `user` `Beat` and queries `micro_assist` snap targets (`±120 ms`) | Soft `BeatGuideConstraint` (`toleranceSec`, plus optional snapped acoustic event/family/role) |
| **`Unbeat` (`U`)** | Dispatches atomic `apply_unbeat_cue`: records a standalone `UnbeatCue` (`×` tick on the `Pulse` baseline) and removes any beat within zoom-scaled `captureRadiusSec` (`15–35 ms`, `35 ms` live tap). Requires **no** existing beat nearby and undoes in one `⌘Z` step | Soft `UnbeatRepulsionConstraint` suppressing candidate beats near `timeSec` |
| **`Sound` (`N`)** | Places a `user` `SoundAnchor` on the `Sounds` lane | Soft `SoundObservationConstraint` informing grid-fit residuals and phrase alignment |
| **`Free` (`R`)** | Marks the selected `Range` (`set_range_free`) or `Segment` (`regime: "free"`) as rubato/fermata/tempo-transition | `FreeIntervalConstraint` relaxing steady-tempo priors inside `[t0, t1)` |
| **`Keep` (`V`)** | Locks the selected `Segment` (`set_segment_keep`) or `Range` (`set_range_keep`) and clears covered `Inbox` spans | **Hard** `KeepLockConstraint`: `PatchOffer`s may read kept beats as boundary context, never mutate them |

When a `PatchOffer` disagrees with a soft cue (`Beat`, `Unbeat`, `Sound`), it
remains selectable and surfaces a concise musical explanation in
`offer.advisoryNotes`. Any offer attempting to write inside a `Keep` interval is
rejected by `validatePatchOffer` (`protected_keep`).

## Multi-Song Mapping Loop (`.ensomi-tempo/`)

1. **Open or Import:** Open a folder (`?dir=`, `Folder…`) or upload audio files
   (`Import`). Workspace state persists beside the audio in `.ensomi-tempo/`
   (`workspace.json`, crash-safe append-only `traces/<songId>.jsonl`, and
   exported `clips/`).
2. **Automatic Draft & `Inbox` Triage:** Opening an unanalyzed track runs
   `song_open` analysis once and ranks `Inbox` spans (`high`, `medium`, `low`)
   from low beat confidence, tempo jumps, and `unexplained` sound residuals.
   Clicking an `Inbox` item or pressing `J` / `⇧J` focuses and loops the passage.
3. **Micro-Snap, Cues, and `Alt` A/B Recompute:** Refine beats directly with
   `Snap-to-Sound` (`1`–`4`), place `Beat` / `Unbeat` / `Sound` / `Free` cues on
   hard passages, and press `⌘K` to request `PatchOffer`s. Hold `Alt` to hear and
   see candidate beats against current beats before pressing `Tab` (accept) or
   `⇧Tab` (dismiss).
4. **Lock and Export:** Press `V` to `Keep` verified segments until `Inbox` is
   clear, then `Export` `.osu` `[TimingPoints]` (`barlines_not_inferred`),
   canonical `.jsonl` traces, or WAV clips. All trace and entity coordinates stay
   in canonical float64 source-audio seconds (`clock: "source-audio-sec"`),
   preserving sub-millisecond timing ready for real-time downstream consumers.
