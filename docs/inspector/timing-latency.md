# Timing engine latency

Inspector **Timing** asks a listener to place beats by ear against a 5 ms target. This page
describes the engine behind it: how the audio clock, the drawn playhead and the listener's keys
are related, what was measured, and what is left to measure on the real setup. How to use the
page is in the [Inspector guide](../../apps/inspector/README.md#timing); the session and save
formats are in [Timing sessions](timing-sessions.md).

The 5 ms target is judged with the listener's offset matched, so a delay that is the same on
every frame or press (output latency, display latency) cancels; a delay that varies does not.
The engine is built to remove variable delay, and this page says when a change only moves a
constant.

## Time bases

| Time base | Unit | Where it comes from |
| --- | --- | --- |
| Context time | s | The `AudioContext` clock; sources start, loop and stop on it |
| Page time | ms | `performance.now()`, an event's `timeStamp`, an animation frame's time stamp, `document.timeline` |
| Source time | ms, float64 | The recording's own clock (`osu`); marks are placed in it |
| Display time | ms | When a frame is seen: its time stamp plus a display delay the page cannot measure |

## Modules

All under `apps/inspector/src/timing/`. The four engine modules are pure and tested with fake
clocks; the Vue components only wire them.

| Module | Contract |
| --- | --- |
| `clock.ts` | Clock model. `OutputClock` relates page time to the context time heard at the output: a robust straight line through the last second of `getOutputTimestamp()` pairs (median gate, then two least-squares passes keeping residuals within 3 · 1.4826 · MAD, at least 0.1 ms), following a step after three stamps. `PlaybackAnchor` and `sourceAtContext` relate context time to source time for one source, holding the start before it, clamping a non-looping end and wrapping a loop after its first pass. |
| `transport.ts` | Transport and scheduler. `planPlay` puts the start time, the buffer offset and the loop edges on whole frames, and the anchor on the frame really played. `clickTimes` maps the listener's beats to context times (fractional, so a click's onset is exact to a fraction of a sample); `clickWindow` schedules them 1 s ahead and drops a click that can no longer start on time instead of playing it late. |
| `display.ts` | Display path. A frame that begins at page time `f` shows the source time heard at `f − offset`; `offset` is the listener's playhead offset, applied here and nowhere else. Within one play that is a straight line in page time (`PlayheadMotion`), held before the start, clamped at the end or wrapping in a loop. `needsResync` keeps the running motion through refits that move it by less than 0.25 ms; `followView` decides view jumps. |
| `input.ts` | Input path. A key or button press maps through the same clock model at its own `timeStamp`, without the offset; a press before the sound reached the output gives nothing. |
| `audio-engine.ts` | Web Audio adapter: the context at the recording's rate, the music and click sources, feeding stamps to the clock model. A running context starts at once, without awaiting `resume()`. |
| `playhead-layer.ts` | DOM adapter: the playhead element moved only by `transform`. Standing still, a transform placed like a mark of the same width; playing, the motion's pieces as Web Animations whose start times are page times, run by the compositor. |

`TimingWorkspace.vue` runs no animation-frame loop while playing: with one, a main-thread stall can
hold even the compositor's playhead, by about a frame ([Measurements](#measurements)). A 25 ms timer
step feeds the clock model, hands the stage a new motion only when `needsResync` says so, refreshes
the HUD readout every 100 ms and follows the playhead; it also runs exactly when the playhead will
leave the view or a loop wraps (`nextFollowCheckMs`), so follow jumps stay on time.
`TimingStage.vue` places the playhead with the frame that redraws a new view, so the line never
shows the new view over the old picture.

Borrowed from ensomi-runtime (read only, commit `edf4066`), reimplemented and not depended on:
the robust line fit of `drift` in `crates/generate/src/fitter/mel_phase.rs` (lines 101-120) for
the clock model; applying an offset exactly once (`crates/gameplay/src/session.rs` lines 16-22)
for the display offset; and the test that results do not depend on the advance schedule
(`fixtures_do_not_depend_on_the_advance_schedule` in `crates/gameplay/tests/conformance.rs`) for
the frame-cadence test of the display path. The runtime has no audio clock, display or input
code of its own (its core reads no clock), so nothing else transfers.

## Measurements

Three runs of the harness below on 2026-10-26, on a MacBook Air (Apple M5, macOS 27) in headless
Google Chrome 155 with `--mute-audio`, each comparing builds in the same job against the version
before the engine (`4954249`). The engine was measured with a frame loop (`f8f143b`, `73d5c7b`:
five repeats in all) and as described above (`3a87776`, whose engine code is this branch's: two
repeats; the engine column pools all seven). Ranges are the smallest and largest per-repeat
values.

| What | Before the engine | Engine | Kind |
| --- | --- | --- | --- |
| Drawn position minus the source heard at the frame's time stamp (0.5 ms per device pixel) | mean +1.9 to +2.3 ms, SD 0.64-1.41 ms | mean −0.17 to +0.05 ms, SD 0.07-0.20 ms | the mean is a constant the offset absorbs; the SD is jitter |
| Presented playhead, 80 ms main-thread stalls every 500 ms | longest gap between frames 82-94 ms, error held up to 64-77 ms from its median | 31-35 ms, 21-25 ms | variable |
| Presented playhead, idle | error within 8.4-9.7 ms of its median 95 % of the time (a 60 Hz frame holds each position) | the same | the display's |
| Saved mark minus the source heard at the key's `timeStamp`, with and without 40 ms of work before the key | within 0.076 ms | within 0.026 ms | variable, negligible |
| Clicks with 450 ms stalls every 1.3 s | 4 of 19 missing | none missing; every click on its sample | — |
| Key to first sample heard, from a stop | 46.5-47.6 ms (p50) | 45.5-47.9 ms | constant (30 ms ahead plus the output) |
| Main thread busy while playing at fine zoom (10 s) | 16-24 % | 10-13 % | — |
| Garbage collections in those 10 s | 409-521 (98-129 ms) | 188-248 (51-71 ms) | — |

In isolated lab pages (five repeats):

- A start, an offset or a loop edge between sample frames is interpolated; on whole frames the
  output is the source bit for bit. A click started between frames has its onset at its
  fractional time. Hence `planPlay`.
- Online, 5 ms after each output stamp, the clock model as the workspace feeds it (the newest
  stamp read every 25 ms) is within 0.016-0.040 ms (p95) of the whole-run line, and within
  0.010-0.030 ms if fed every stamp; the newest stamp alone is within 0.067-0.084 ms. The model is
  1.9-4.8 times better at every hint and repeat, and all are far inside the target on this
  timer-driven stream. CoreAudio's stamps may be noisier.
- Latency hints change the reported base and output latency (16, 24, 32 ms) and the stamp
  cadence, not the stamps' noise.
- A Web Animation is presented about a frame sooner than a canvas drawn from the same frame time
  while the main thread is idle (5.6-7.6 ms against 21.8-22.5 ms after the time it shows), and as
  late as the canvas with main-thread work in its frames: its display delay changes by up to a
  frame with load.
- With 80 ms stalls, a canvas or a script-moved element freezes for the whole stall (gaps of
  61-81 ms). A Web Animation in a page with no animation-frame loop is not held at all; with a
  frame loop it is held about one extra frame per stall (gaps of 30-35 ms). With no frame loop
  but a text readout changed every 100 ms from a timer, as the HUD does, it was not held in one
  repeat and held like the frame loop in the other (two repeats).
- A position computed from `performance.now()` in an animation-frame callback is 2-3 ms ahead of
  one from the frame's time stamp (callbacks start that late), and noisier, except right after a
  stall, when the late callback's frame time stamp is old. The compositor samples the playhead
  at its own frame time, so stalls do not age it.

What these runs did not show:

- That the engine without a frame loop does better in the app than with one: in these runs the
  harness sampled output stamps from a frame loop of its own in every scenario, so the page
  always had one. It now runs only while positions are read.
- Anything about CoreAudio, the real display, Arc, FineTune or the keyboard: a muted page plays
  into Chromium's fake output stream, driven by a timer, and headless swap times are not light.
  `owner-stamps.js` records the output stamps in Arc on the real device;
  `calibration-session.mjs` writes ticks for setting the playhead offset by eye.

Switching to this engine moves the drawn playhead by about 2 ms of source for the same offset (it
draws the source heard at the frame's time stamp, where the old playhead drew it at its callback
time, about 2 ms later), so the offset that matches comes out about 2 ms smaller in headless
Chrome; the compositor's presentation can differ from the old canvas by up to a frame. Check the
offset again after switching.

## FineTune in the output path

The owner keeps FineTune, an EQ app, in the browser's output path. Its onset gate arms after
200 ms with every buffer's peak at or below 1e-4 (about −80 dBFS): the first louder buffer is
muted and the next 40 ms fade in (FineTune 1.9.0, `ProcessTapController.swift`; not measured
here, since the harness runs muted). What follows for the engine:

- A start from a stop arms the gate (a stopped page sends digital silence). The minimum pre-roll
  of 120 ms of real audio covers the muted buffer and the fade (about 51 ms with 512-frame
  buffers at 48 kHz), so an onset at the requested start is heard at full gain if the pre-roll
  audio is louder than −80 dBFS.
- An onset after near-silence inside the music is softened whatever the pre-roll. The HUD warns
  of such a stretch (`nearSilence` in `waveform.ts`, at the gate's threshold).
- Clicks on the listener's beats in near-silent stretches are muted or softened.
- Ticks in digital silence are each heard late by where they fall in FineTune's buffer (0-10.7 ms,
  changing from tick to tick), so calibrate the playhead offset on ticks over a floor:
  `node apps/inspector/benchmarks/timing/calibration-session.mjs DIR` writes such a session
  (ticks at whole seconds on noise at a peak of −60 dBFS, at 48 and 44.1 kHz).
- FineTune's own delay is invisible to `getOutputTimestamp()` and constant while it runs: the
  playhead offset absorbs it.

## Harness

`apps/inspector/benchmarks/timing/` measures several builds in the same job:

```sh
apps/inspector/benchmarks/timing/mac-run.sh OUT [REPEATS] [LABEL=REF ...]
```

The default builds are `baseline=4954249` and `engine=HEAD`. It builds one timing bundle per
build from a temporary worktree, runs `run.mjs lab` (skipped with `LAB=0`) and then `run.mjs app`
for each build in turn within each repeat, in headless Chromium with `--mute-audio`, and writes
raw JSON and `summary.md` (`analyze.mjs DIR --json summary.json`). It needs Node 22.18+ and
downloads `playwright-core` into a temporary directory; the repository does not depend on
Playwright. Ports 4190-4199.

Limits of the harness, which the owner's measurements cover:

- A muted page renders into Chromium's fake output stream, driven by a timer: output latency,
  the device clock and its stamps are not CoreAudio's.
- Headless Chromium has no display; screencast swap times stand in for light.
- It drives Google Chrome or Playwright's Chromium, not Arc.
