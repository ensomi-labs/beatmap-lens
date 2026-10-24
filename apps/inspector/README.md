# Inspector

Inspector is the local browser app for reading `osu!mania` charts against their
audio and recording human judgments about them. It is a Vue and Vite app. Parsing
and scene projection come from the [`beatmap-lens`](../../packages/beatmap-lens/README.md)
package, which stays DOM-free; file access, playback and review live here.
Interface conventions are in [DESIGN.md](DESIGN.md).

## Run it

From the repository root:

```sh
pnpm install
pnpm dev
```

Open the address Vite prints. The dev and preview servers also provide Inspector's
local services, which read the absolute or `~/` paths you type into a form. They
answer only same-origin requests from this machine. A static build served from
anywhere else has no file access: Annotate falls back to browser folder pickers
and Compare cannot open.

## Workspaces

The mode switch moves between five workspaces:

| Workspace | What it is for |
| --- | --- |
| **Inspect** | Paste or open one chart and check its parse, diagnostics and rendered SVG. |
| **Annotate** | Judge selected sections of catalog charts into a local dataset folder; see the [root README](../../README.md#development). |
| **Review** | Open `.osu` files, frozen tasks and agent handoffs from disk and record human review. |
| **Compare** | Judge two generated charts of the same song by listening, without knowing which model made which. |
| **Timing** | Mark beats and non-beats in passages of the source audio, with blind timing proposals drawn over it. |

`/compare` and `/timing` open Compare and Timing directly. The connected Review inbox at `/review` is served
by `pnpm review:workspace` instead; see [agent–human review](../../docs/annotation/agent-workflow.md).

## Compare

Compare plays one song under two charts and asks which follows the music better.
It is for judging chart generators by ear; it does not write annotations.

1. Open **Compare** (or `/compare?manifest=<path>` to prefill the path).
2. Enter a [comparison manifest](../../docs/inspector/model-comparison.md), or choose
   **Two chart files** and enter two `.osu` paths plus a verdict folder. In that mode
   the audio is the first chart's `AudioFilename`.
3. Pick an excerpt from the queue and loop it. **A**, **B** and **Side by side**
   share one audio clock, so switching views never restarts the music. Audio rate
   keeps pitch; visual speed changes only how far apart the notes are drawn.
4. Read the white energy and blue onset-rise curves across to the notes at the same
   height. They are listening aids, not scores.
5. Choose **A better**, **B better**, **No difference** or **Can't tell**. A note is
   optional and must be written first. The choice is saved at once and only then
   are the model names shown. **Next excerpt** moves to the next unjudged excerpt,
   across songs.

Keyboard: <kbd>Space</kbd> loops or pauses, <kbd>A</kbd>, <kbd>B</kbd> and
<kbd>S</kbd> switch the view. Verdicts have no shortcut, so a stray key cannot
record one.

Reopening the same manifest restores judged excerpts with the A/B assignment they
were judged under. On narrow screens, **Source**, **Preview** and **Details** switch
between the queue, the charts and the verdict.

## Timing

Timing labels where the beats of a passage are. It plays the source recording as
float32 PCM at its own rate and channel count (no decoder, resampler, fade or
downmix in the page), draws a spectrogram and both waveform channels on one exact
time axis, and draws each timing proposal as anonymous coloured bars. Proposals
are silent. Their names come back only through **Reveal names**, after the
passage's current marks are saved. The input format is
[timing sessions](../../docs/inspector/timing-sessions.md).

Run it from `pnpm dev` at `/timing`, or with plain Node and no install from a
built bundle:

```sh
# On a machine with the repository and pnpm: build the page and the server files.
pnpm --filter @ensomi/beatmap-lens-inspector timing:bundle -- --out ~/timing-app
# Anywhere with Node 22.18+ or 24+ (the bundle is platform independent):
node ~/timing-app/server/timing-server.ts --session /path/to/session.timing.json --port 4177
```

Open the printed address; it opens the session directly. Marks append to
`<session>.timing.marks.jsonl` beside the session.

- Click on the spectrogram or waveform places a beat, right-click an unbeat;
  <kbd>B</kbd> and <kbd>N</kbd> place them at the playhead. A click near a mark
  selects it. Marks can be placed only inside the passage; the shaded context
  around it is for listening.
- <kbd>←</kbd>/<kbd>→</kbd> nudge the selected mark (or step the playhead) by
  1 ms, with <kbd>Shift</kbd> 0.1 ms; <kbd>,</kbd>/<kbd>.</kbd> by one sample.
  <kbd>[</kbd>/<kbd>]</kbd> visit marks, <kbd>K</kbd> flips beat and unbeat,
  <kbd>Delete</kbd> removes, <kbd>Cmd/Ctrl+Z</kbd> undoes and
  <kbd>Cmd/Ctrl+Shift+Z</kbd> redoes.
- <kbd>Space</kbd> plays or pauses, <kbd>Shift+Space</kbd> plays the loop region
  once, <kbd>L</kbd> loops it, <kbd>I</kbd>/<kbd>O</kbd> set its edges,
  <kbd>Shift</kbd>+drag selects it and <kbd>X</kbd> loops 500 ms around the
  selected mark. Every start plays at least 120 ms of the preceding audio first.
  <kbd>Esc</kbd> stops at once.
- Wheel pans, <kbd>Ctrl</kbd>+wheel or pinch zooms at the pointer, <kbd>+</kbd>,
  <kbd>−</kbd> and <kbd>0</kbd> zoom around the selected mark or the playhead,
  <kbd>Z</kbd> toggles 0.5 ms per pixel, and the overview strip jumps. <kbd>F</kbd>
  toggles follow.
- <kbd>1</kbd>–<kbd>9</kbd> switch proposals, <kbd>P</kbd> hides all of them and
  brings them back. <kbd>Cmd/Ctrl+S</kbd> or <kbd>Enter</kbd> saves; the first save
  needs the playback setup line (headphones, EQ app state, device rate).

The moving playhead follows the audio output clock and the playhead offset,
which corrects delay the browser cannot see. It shows which beat is sounding to
about one display frame; place and check marks on the still waveform. After an
output device or rate change, choose **Reopen audio after a device change** (or
the current passage again) and check the offset.

## Code map

| Path | Responsibility |
| --- | --- |
| `src/App.vue` | Picks the workspace from the URL and the mode switch |
| `src/*Workspace.vue` | One component per workspace |
| `src/annotation/` | Annotation contracts, dataset storage, playback clocks, scene buffering |
| `src/compare/` | Comparison contracts, excerpt proposals, audio envelope |
| `src/timing/` | Timing formats, time axis, marks, spectrogram, audio engine and output clock |
| `server/local-service.ts` | Localhost-only request guard and helpers shared by both services |
| `server/local-files.ts` | Full-path dataset, catalog and corpus access for Annotate |
| `server/comparisons.ts` | Blind comparison sessions and verdict files for Compare |
| `server/timing.ts` | Blind timing sessions, PCM serving, marks files and guarded reveal |
| `server/timing-server.ts` | The plain-Node server for a timing bundle |
| `server/review-workspace.mjs` | The connected Review service behind `/review` |

Run `pnpm check` from the repository root before merging; the
[contribution guide](../../CONTRIBUTING.md) lists what it covers.
