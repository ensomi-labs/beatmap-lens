# Tempo System Boundaries, `ensomi` Seam, and Provider Contracts

## Four-Way Module Split in `beatmap-lens`

`beatmap-lens` enforces strict ownership and import boundaries across four
surfaces:

1. **`packages/beatmap-lens/`:** Independently published, DOM-free npm chart
   parser and projection toolkit. Zero awareness of Inspector servers or `ensomi`.
2. **`apps/inspector/src/stage-audio/`:** Protocol-free browser audio and canvas
   primitives (`StageAudioEngine`, `OutputClock`, `PlayheadLayer`, multi-scale
   waveform, worker STFT spectrogram, `TimeView`, and
   `createTimeViewEdgeAutoScroller`). Shared by `/timing` and `/tempo` without
   domain coupling.
3. **`apps/inspector/src/timing/` + `server/timing*.ts`:** Blind human beat-label
   evaluation tool (`osu` ms clock, guarded proposal reveal, self-contained
   `timing:bundle`). Completely untouched by `/tempo`.
4. **`apps/inspector/src/tempo/` + `server/tempo/`:** Interactive multi-song
   tempo workspace backed by `ensomi` `0.2`. `src/tempo/module-boundary.test.ts`
   verifies that `src/tempo/` never imports from `../timing`, `../annotation`, or
   `../draft`.

## `ensomi` `0.2` Seam and Canonical Clock Invariant

`ensomi` `0.2` is the sole authority for session state, reducer folding
(`foldTrace`), constraint compilation (`compileConstraints`), offer validation
(`validatePatchOffer`), derived views (`computeGridFit`, `rankInboxSpans`,
`projectRedLines`), and lifecycle orchestration (`SessionController`).

Every timestamp in `SessionState` and `.ensomi-tempo/traces/<songId>.jsonl` is
recorded in canonical float64 seconds on the **original stereo mix**
(`clock: "source-audio-sec"`). Switching `Audition` to a filtered stem or band
(`mix`, `percussive`, `harmonic`, `low`, `mid`, `high`) hot-swaps only the
listening buffer inside the root `StageAudioEngine` (`X-Audition-Only`); visual
waveforms, spectrograms, beat clicks, and saved edits remain locked to the
original mix clock.

## Three-Layer `TriggerPolicy` Lifecycle

`SessionController` isolates work into three independent `(songId, layer, generation)`
lifecycles:

| Layer | Trigger & Budget | Trace Persistence & Cancellation |
| --- | --- | --- |
| **`song_open`** | Automatic once on unanalyzed song open (`< 5 s` target; `< 200 ms` reopen from `.jsonl`) | Commits `audio_bound` + `draft_loaded`; aborted immediately if the user switches songs |
| **`micro_assist`** | Debounced preemptive CPU query on beat place/select (`< 100 ms` target) | **Zero `.jsonl` writes** (`suggestSnaps`); `latest_wins` `AbortController` cancellation |
| **`heavy_recompute`** | Explicit manual `⌘K` (`< 5 s` target) | Appends `signal` + `offer_batch` (or holds offers in memory while `Alt` A/B compare is active via `setHoldOffers`); concurrent local edits invalidate overlapping `local` offers while preserving valid `cross_region` offers |

## Local HTTP Service and Warm Daemon Contract

`apps/inspector/server/tempo/index.ts` exposes `/api/tempo/*` behind same-origin
localhost and `x-beatmap-lens-local: 1` guards, serializing trace writes through
`TraceWriter` (monotonic `seq`, duplicate-ID rejection, and torn-tail healing).
`TempoDaemonClient` maintains a single warm stdio NDJSON subprocess
(`tempo_daemon.py`) with bounded LRU PCM/feature caching and cooperative
per-request `cancel` propagation.

Behind `ensomi`'s `TimingProvider` interface (`manifest`, `prepare`, `analyze`,
`suggestSnaps`, `recompute`), providers satisfy functional I/O, canonical clock,
and latency contracts without coupling the workspace to any specific internal
model architecture:

- **`analyze`:** Returns initial `segments`, `beats`, and `sounds` on the
  original mix clock.
- **`suggestSnaps`:** Returns acoustically verifiable `SnapCandidate` targets
  classified by `SnapFamily` and the four `SnapRole`s (`transient_attack`,
  `p_center`, `harmonic_change`, `release`) with signed `deltaMs` and `salience`.
- **`recompute`:** Consumes `SerializedSessionState` and `CompiledConstraints`
  over `scope` (`Range | "song"`) and returns candidate `PatchOffer`s with
  explicit `writeScopes`, `consequences`, and soft-cue `advisoryNotes`.
