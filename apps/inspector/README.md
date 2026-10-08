# Inspector

Inspector owns local file handling, playback, and human inspection. The npm package
stays DOM-free. See [DESIGN.md](DESIGN.md) for the interface language.

## Compare two generators

From the repository root, run:

```sh
pnpm install
pnpm dev --host 127.0.0.1 --port 5174 --strictPort
```

Open **http://127.0.0.1:5174/compare**. In **Manifest path**, enter an absolute or
`~/` path, then select **Open comparison**. The Compare workspace is also available
in the Inspector mode switch. This requires the local dev or preview server;
hosting the static build alone does not provide filesystem access.

On the prepared mac worktree, if pnpm is not on PATH:

```sh
cd ~/wt/beatmap-lens-compare
PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH" \
  npm exec --yes --package=pnpm@11.9.0 -- \
  pnpm dev --host 127.0.0.1 --port 5174 --strictPort
```

For the local demo, enter:

```text
~/ensomi/ensomi-model/artifacts/audio-rows-20261008/lens-demo/comparison.json
```

It compares 5150, band 3 against band 4, seed 0. This demonstrates a visible
difference using existing exports; it is **not a matched two-model experiment**.
Its example “Can't tell” verdict is marked as an automated UI smoke test in its
note, not a human musical preference.

Choose a short excerpt from the queue and select **Loop excerpt**. **Show A**,
**Show B**, and **Side by side** share one audio clock, so switching views does
not pause or seek. **Restart** and the excerpt-position slider seek within the
loop. Speed keeps pitch; Zoom changes only the visual time scale. White audio
energy and blue onset energy rises align horizontally with the notes.

Choose **A better**, **B better**, **No difference**, or **Can't tell**. A note is
optional and must be entered before choosing. One click saves and reveals the
model names for that excerpt. **Next unheard excerpt** advances to another
unsaved excerpt, including the next song. Completed excerpts reopen with their
saved verdict and original A/B mapping. On small screens, Source, Preview, and
Details switch between the queue, playback, and verdict controls.

**Two chart paths** opens a pair without a manifest. Both paths must point to
`.osu` exports of the same song; audio is resolved beside the first chart using
its `AudioFilename`. Choose an output folder. Model names after voting are
“First input chart” and “Second input chart”, and records contain the exact paths.

Verdicts go beside the manifest by default, or into the optional **Verdict output
folder**. Inputs remain read-only. These records are separate from Foundation,
annotation datasets, and human annotation histories.

The [comparison manifest and verdict format](../../docs/inspector/model-comparison.md)
is the producer contract for ensomi-model jobs. It also documents excerpt
selection, blinding, and the limits of the audio display.

## Verification on Node 25

Node 25's experimental global Web Storage conflicts with the DOM test environment.
Disable it for the existing engineering check. A low-concurrency invocation is:

```sh
NODE_OPTIONS='--no-experimental-webstorage --v8-pool-size=1' \
UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 VITEST_MAX_WORKERS=1 \
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1 \
  pnpm check
```
