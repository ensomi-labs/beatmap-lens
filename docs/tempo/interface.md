# Tempo Interface Architecture

`/tempo` is the standalone interactive tempo-mapping workspace in Beatmap Lens
Inspector (`apps/inspector/src/tempo/`). It follows the dark audio workstation
conventions in [`apps/inspector/DESIGN.md`](../../apps/inspector/DESIGN.md) v2.0.

## Standing Product and Visual Principles

1. **100% user-useful surface:** Every label, badge, and row carries musical or
   timing meaning. Internal entity IDs, offer IDs, batch IDs, semantic hashes
   (`sk:...`), and song hashes never appear on screen.
2. **Zero development or mock chrome:** No internal provider badges, mock notices,
   or model caveats render in the workspace.
3. **Zero vanity count panels:** The right pane contains only actionable
   suggestions and contextual selection controls—never static track metadata,
   capability flags, or raw beat/sound counters.
4. **Standalone route:** Visiting `/tempo` mounts `TempoWorkspace.vue` inside
   `WorkspaceFrame` without `mode`, omitting the `Inspect`, `Annotate`, `Review`,
   `Compare`, and `Timing` mode switch tabs.

## Layout Contract

| Region | Sizing | Responsibility |
| --- | --- | --- |
| **Top toolbar** (`.frame-toolbar`) | `40 px` | `Tempo` title, `Import`, `Folder…`, `Export`; `Edit` / `Audition` switch; transport (`Play`/`Stop`, `Loop`, `Clicks`, `Rate`, `Follow`, `Undo`/`Redo`); contained `.time-counter`; status dot |
| **Left pane** (`tempo-left`) | `248 px` (`184–420 px`) | Vertically split collapsible `Songs` and `Inbox` lists so neither starves the other on multi-track folders |
| **Stage view bar** (`.stage-toolbar`) | `≥ 32 px`, `flex-wrap: wrap` | Shrinking song title (`flex: 1 1 0; min-width: 96px`) plus sub-mode tools (`Edit` cues or `Audition` filters + `Cache` toggle) with zero horizontal overflow across `1440 px`, `1240 px`, and `1100 px` |
| **Segment strip** (`TempoSegmentStrip`) | `30 px` | Whole-song `[0, duration)` `Segment` partition, `Keep`/`Free`/`Break` shading, `Inbox` priority pips, boundary handles, and viewport lens |
| **Detail stage** (`TempoStage`) | Flexible well (`#101820`) | Time ruler, worker STFT spectrogram, multi-scale stereo waveform, `Pulse` lane (`Beat` + `×` `Unbeat` cues), derived `Sounds` lane, and inline `Snap-to-Sound` candidates |
| **Right pane** (`tempo-right`) | `308 px` (`256–480 px`) | `Suggestions` (shown only when `valid` or `stale` offers exist; auto-revealed on `⌘K`) and contextual `Selection` / `Fine-Tune` |
| **Status bar** (`.frame-status`) | `24 px` | Passive non-per-frame facts: `Zoom`, `Rate`, `Loop`, `Kept`, and `.status-optional` workspace folder |

During playback, `.time-counter` (`contain: layout paint`, tabular `Azeret Mono
Variable`) and `PlayheadLayer` compositor transforms are the only elements that
update continuously; nothing triggers layout reflows.

## Visual Grammar

- **Segments, Spans, and Ranges:** Kept intervals carry a subtle emerald wash and
  top edge; `Free` regimes and spans carry a diagonal hatch; `Break` segments dim
  the backdrop; transient `Range` selections highlight `[t0, t1)` with `1 px`
  `--signal` edges.
- **Pulse lane:** `user` beats render as crisp white hairlines and triangles
  (heavier with `--seam` casing and `--signal-fill` plate when selected);
  `draft`/`offer` beats use a quieter secondary blue; candidate beats during
  `Alt` A/B hold glow emerald and drive `StageAudioEngine` clicks. Standalone
  `Unbeat` cues sit along the `Pulse` baseline as muted `×` ticks without
  cluttering the spectrogram.
- **Derived `Sounds` lane:** Renders `gridFit` alignment per sound anchor:
  hollow markers for `on_grid`, ternary `3` / `6` labels for `subdivision`, and
  amber dots with signed `residualMs` whiskers for `unexplained` onsets.
- **Inline `Snap-to-Sound`:** Selecting or placing a beat opens a clamped
  toolbar of up to 4 nearby acoustic targets (`1`–`4`, musical label, readable
  role `Attack` / `Swell` / `Harmony` / `Release`, signed `deltaMs`).

## Keyboard and Pointer Shortcuts

| Input | Action |
| --- | --- |
| `Space` / `L` / `C` / `F` | Play or stop / toggle loop / toggle audible beat clicks / toggle playhead follow |
| `B` / `U` / `N` | Place user `Beat` / standalone `Unbeat` cue / user `Sound` anchor at heard or cursor time |
| `V` / `R` | Toggle `Keep` / `Free` on active `Range` or selected `Segment` |
| `S` / `M` | Split active `Segment` at cursor / merge selected `Segment` with neighbor |
| `Shift+drag` or `[` / `]` | Select transient `Range` `[t0, t1)` (with `40 px` quadratic horizontal edge auto-scroll on drag) |
| `1`–`4` | Snap selected `Beat` to `SnapCandidate` 1–4 |
| `←` / `→`, `⇧←` / `⇧→`, `,` / `.` | Nudge selection `±1 ms`, `±0.1 ms`, or `±1 sample` (steps playhead when stopped with no selection) |
| `Delete` / `Backspace` | Delete selected beat, unbeat cue, user sound, or beats inside active `Range` |
| `J` / `⇧J` | Focus and loop next / previous ranked `Inbox` span |
| `⌘K` (`Ctrl+K`) | Run `heavy_recompute` on active `Range` or whole song |
| `Alt` (hold) / `\` / `Tab` / `⇧Tab` | Momentary A/B offer preview (`hold-offers`) / cycle options / accept / dismiss |
| `G` / `X` | Toggle `±750 ms` `0.25×` flam check / loop `±500 ms` around selection |
| `Ctrl+wheel`, `+` / `-` / `0` / `Z` | Zoom at pointer, zoom in/out/fit, or toggle `0.5 ms/devicePx` fine zoom |
| `Option+click` / middle-click | Locate playhead (restarts playback once with pre-roll while playing) |
| `⌘Z` / `⇧⌘Z` | Undo / redo trace events |
