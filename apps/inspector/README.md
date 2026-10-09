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

The mode switch moves between four workspaces:

| Workspace | What it is for |
| --- | --- |
| **Inspect** | Paste or open one chart and check its parse, diagnostics and rendered SVG. |
| **Annotate** | Judge selected sections of catalog charts into a local dataset folder; see the [root README](../../README.md#development). |
| **Review** | Open `.osu` files, frozen tasks and agent handoffs from disk and record human review. |
| **Compare** | Judge two generated charts of the same song by listening, without knowing which model made which. |

`/compare` opens Compare directly. The connected Review inbox at `/review` is served
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

## Code map

| Path | Responsibility |
| --- | --- |
| `src/App.vue` | Picks the workspace from the URL and the mode switch |
| `src/*Workspace.vue` | One component per workspace |
| `src/annotation/` | Annotation contracts, dataset storage, playback clocks, scene buffering |
| `src/compare/` | Comparison contracts, excerpt proposals, audio envelope |
| `server/local-service.ts` | Localhost-only request guard and helpers shared by both services |
| `server/local-files.ts` | Full-path dataset, catalog and corpus access for Annotate |
| `server/comparisons.ts` | Blind comparison sessions and verdict files for Compare |
| `server/review-workspace.mjs` | The connected Review service behind `/review` |

Run `pnpm check` from the repository root before merging; the
[contribution guide](../../CONTRIBUTING.md) lists what it covers.
