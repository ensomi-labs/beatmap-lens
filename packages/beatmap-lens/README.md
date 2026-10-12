# beatmap-lens

A TypeScript toolkit for 4K-10K `osu!mania` beatmaps, released independently from the
Inspector and annotation tooling.

```ts
import {
  createRenderDocument,
  createRenderScene,
  iterateOsz,
  parseBeatmap,
  parseOsz,
  parseOsu,
  renderSvg,
  renderSvgPages,
  serializeSvg,
  serializeSvgPages,
  toManiaChart,
} from "beatmap-lens";

const beatmap = parseBeatmap(osuSource);
const sceneOptions = {
  range: beatmap.chart.range,
};
const svg = renderSvg(beatmap.chart, sceneOptions);

// Advanced path: use each stage independently.
const parsedOsu = parseOsu(osuSource);
const chart = toManiaChart(parsedOsu);
const scene = createRenderScene(chart, { range: chart.range });
const sameSvg = serializeSvg(scene);

// Fixed-size static review pages.
const pages = renderSvgPages(beatmap.chart, {
  range: beatmap.chart.range,
});

// Advanced document path: inspect resolved layout before serialization.
const document = createRenderDocument(beatmap.chart, {
  range: beatmap.chart.range,
});
const samePages = serializeSvgPages(document);

const beatmapSet = await parseOsz(oszBytes);

for await (const loadedBeatmap of iterateOsz(oszBytes, { maxConcurrency: 1 })) {
  // Each beatmap is complete and already linked to its shared audio when present.
}
```

`parseBeatmap` is the ordinary entry point: retain its `Beatmap`, then pass `beatmap.chart` to
`renderSvg` for one scene or `renderSvgPages` for a fixed-size review document.
`parseOsu`/`toManiaChart`, `createRenderScene`/`serializeSvg`, and
`createRenderDocument`/`serializeSvgPages` remain the advanced, composable boundaries.

Every render describes one bounded, contiguous source-time interval. `range` is the only required
`RenderSceneOptions` field and uses half-open `[startMs, endMs)` membership. Use `chart.range` for
an intentional complete-chart render; there is no zero-option, implicitly unbounded render. Time
runs from bottom to top by default, placing `startMs` at the lower edge and later time progressively
higher. Set `timeDirection: "top-to-bottom"` for the opposite presentation.

`pixelsPerSecond`, `playfield`, `timeDirection`, and `theme` are optional. The linear scale defaults
to `240 px/s`, while the playfield defaults to the complete scene size `{ widthPx: 640 }`. A supplied
playfield must choose exactly one sizing mode:

```ts
const sceneOptions = {
  range: { startMs: 60_000, endMs: 75_000 },
  playfield: { laneWidthPx: 72 }, // Or: { widthPx: 640 }, never both.
  theme: {
    metrics: {
      paddingPx: { top: 32, bottom: 32 },
      laneGapPx: 6,
      noteHeightPx: 10,
    },
  },
};

const svg = renderSvg(beatmap.chart, sceneOptions, { title: "60s to 75s" });
```

`theme.metrics` is nested and partial: unspecified padding sides and metrics retain their defaults.
`theme.tailShortenMs` draws each long note ending that many milliseconds before its end time, never
before its start, as shortened-tail skins do; `0` draws the full length. It changes the drawing
only: glyph `startMs`, `endMs` and `continuesAfter` keep the chart's times.
SVG-only metadata such as `title` is a separate serializer option, accepted by the third argument
of `renderSvg` or the second argument of `serializeSvg`.

### Render defaults

| Input | Required | Default |
| --- | --- | --- |
| `range` | Yes | None; use `chart.range` intentionally for the complete chart |
| `pixelsPerSecond` | No | `240` |
| `playfield` | No | `{ widthPx: 640 }` |
| `timeDirection` | No | `"bottom-to-top"` |
| `theme.metrics.paddingPx` | No | `{ top: 24, right: 16, bottom: 24, left: 16 }` |
| `theme.metrics.laneGapPx` | No | `4` |
| `theme.metrics.noteHeightPx` | No | `8` |
| `theme.metrics.noteInsetPx` | No | `5` |
| `theme.metrics.noteRadiusPx` | No | `2` |
| `theme.tailShortenMs` | No | `10`; finite and non-negative |
| serializer `title` | No | Metadata artist/title/version plus the key-count label; the key-count label alone when metadata is absent |

### Fixed-size static review documents

`renderSvgPages` returns a deterministic array because document layout may need more than one
image. Every page uses the same exact size; panels run chronologically from left to right and then
continue on the next page. A panel remains an ordinary bounded `RenderScene` with half-open range
membership and its own narrow source-time axis.

```ts
const pages = renderSvgPages(beatmap.chart, {
  range: { startMs: 60_000, endMs: 70_000 },
  page: {
    size: { widthPx: 1600, heightPx: 900 },
    columns: "auto",
  },
  panel: {
    playfield: { laneWidthPx: 48 },
    maxNoteRows: 32,
    maxSourceDurationMs: 10_000,
  },
  scale: { type: "linear", pixelsPerSecond: 240 },
});
```

Page width controls how many panels fit, while `maxNoteRows` controls where one panel may break.
Simultaneous notes count as one row. The default document is `1600 x 900px`, uses `24px` page
padding, a `12px` panel gap, a `48px` lane width, up to 32 note rows and 10 seconds per panel,
bottom-to-top time, linear `240px/s`, auto columns, and an attached left-side `32px` axis. Import
`renderDefaults` to
inspect the exported baseline values; inspect `document.resolved` for the chart-specific runtime
result.

Three scale modes keep their intent explicit:

- `linear` uses one hard pixels-per-second value and adds panels or pages when needed;
- `fit` remains true linear time and chooses one global value between its preferred and minimum
  scales to attain the minimum reachable page count;
- `row-aware` uses a piecewise-linear projection, expands dense distinct rows, and compresses only
  empty time that contains no active long note.

```ts
const compactPages = renderSvgPages(beatmap.chart, {
  range: { startMs: 60_000, endMs: 70_000 },
  scale: {
    type: "row-aware",
    basePixelsPerSecond: 240,
    minRowGapPx: 12,
    maxEmptyGapPx: 72,
  },
});
```

Row-aware axis labels still show true source time, but visual distance is intentionally non-linear.
Its SVG panels carry `data-time-scale="row-aware"`, and enabled axes mark compressed ranges.
`RenderTimeProjection` is a discriminated union; narrow on `projection.type` before reading the
linear-only `pixelsPerSecond` field.

### Animated WebP and GIF (Node.js)

`renderAnimation` from `beatmap-lens/node` exports an in-memory animated image. Only `range` is
required; the default is a lossless WebP at 640 × 480, 30 fps, with osu!lazer scroll speed 20 and
infinite looping. Sharp is included as a dependency; no browser, external executable, or encoder
setup is needed on its supported Node.js platforms.

```ts
import { writeFile } from "node:fs/promises";
import { parseBeatmap } from "beatmap-lens";
import { renderAnimation } from "beatmap-lens/node";

const { chart } = parseBeatmap(osuSource);
const image = await renderAnimation(chart, {
  range: { startMs: 60_000, endMs: 65_000 },
  viewport: { widthPx: 640, heightPx: 480 },
  scrollSpeed: 22,
  fps: 30,
  format: "webp", // Or "gif".
});
await writeFile("preview.webp", image.data);
// image also exposes format, mimeType, size, frameCount and durationMs.
```

`range` is the half-open **playback interval**, not a crop of the notes. Each frame shows the
upcoming time window starting at its current source time. Current time stays at the lower padded
edge by default, so future notes move down toward it. `timeDirection: "top-to-bottom"` reverses
this movement. Upcoming notes after `range.endMs` can be visible, and active long notes remain
clipped to the viewport. There is no preroll, trailing pause, audio, or simulated key input.

| Input | Default | Meaning |
| --- | --- | --- |
| `range` | Required | Source-time playback interval in milliseconds |
| `viewport` | `{ widthPx: 640, heightPx: 480 }` | Logical scene dimensions; the lanes fill this width |
| `pixelRatio` | `1` | Raster scale; `2` exports 1280 × 960 from the default viewport without changing timing or spacing |
| `scrollSpeed` | `20` | osu!lazer baseline speed, 1–40, using the landscape viewport |
| `pixelsPerSecond` | Unset | Explicit logical pixel speed instead of `scrollSpeed`; also supports portrait viewports |
| `fps` | `30` | Requested samples per source second; fractional rates are supported |
| `format` | `"webp"` | `"webp"` or `"gif"` |
| `loop` | `0` | Total plays; `0` repeats forever, `1` plays once |
| `theme`, `timeDirection` | Scene defaults | The same partial metrics and time direction as static rendering |

Choose either `scrollSpeed` or `pixelsPerSecond`. The former reuses the existing
`osuLazerManiaPixelsPerSecond` adapter; it models constant visual speed, without timing/SV or rate
mods. `viewport` and `theme` use logical pixels. The output size rounds each
`viewport dimension × pixelRatio` to the nearest integer, with a minimum of one pixel.

Format-specific controls are available through `webp` or `gif`, using Sharp's corresponding
encoder options except `loop`, `delay`, and `force`. Delays belong to the frame pipeline.
For example, use `webp: { lossless: false, quality: 85, effort: 4 }` or
`format: "gif", gif: { colours: 64, dither: 0 }`. GIF defaults to no dithering and retains
duplicate frames. The TypeScript options prevent mixing GIF and WebP controls.

Frame timestamps come from their index, and the final sample is shortened to the remaining
duration. Encoding rounds cumulative frame boundaries to WebP's 1ms or GIF's 10ms units, avoiding
drift at rates such as 30 fps. Samples shorter than 11ms for WebP or 20ms for GIF are coalesced;
a short remainder extends the previous frame. This avoids the much longer pauses imposed on
tiny delays by encoders and players. Prefer WebP for 60 fps; GIF works best at 50 fps or below.
A GIF shorter than 20ms lasts 20ms. A single-frame or entirely stationary WebP can become a still
image with no stored duration. Result `frameCount` and `durationMs` describe the encoded file,
including coalescing and that zero-duration still-image case. Player scheduling can vary.

The core frame APIs work in browsers and Node.js without importing Sharp:

```ts
import {
  createAnimationScene,
  createRenderAnimation,
  iterateAnimationFrames,
  serializeSvg,
} from "beatmap-lens";
import { encodeAnimation } from "beatmap-lens/node";

const animation = createRenderAnimation(chart, {
  range: { startMs: 60_000, endMs: 65_000 },
  viewport: { widthPx: 640, heightPx: 480 },
  pixelsPerSecond: 700,
});
// Inspect animation.resolved for the scale, visible duration, metrics and sample count.
const previewSvg = serializeSvg(createAnimationScene(animation, 61_234.5));

function* customFrames() {
  for (const frame of iterateAnimationFrames(animation)) {
    // Every frame exposes index, timeMs, durationMs and an ordinary RenderScene.
    yield {
      ...frame,
      scene: {
        ...frame.scene,
        notes: frame.scene.notes.map((note) => ({ ...note, fill: "#a78bfa" })),
      },
    };
  }
}
const gif = await encodeAnimation(customFrames(), { format: "gif" });
```

`createRenderAnimation` retains the chart by reference and resolves parameters without allocating
frames. `createAnimationScene` samples any time in the playback range independently of `fps`.
`iterateAnimationFrames` is lazy and repeatable. Treat the retained chart as immutable while
using the plan. Browser consumers can serialize scenes or draw their geometry themselves.

`encodeAnimation` accepts synchronous or asynchronous iterables of `{ scene, durationMs }`;
all scenes must have the same size and durations must be positive. This is the boundary for
custom styling, frame selection, timing, or caller-owned progress/cancellation logic. The Node
encoder rasterizes one scene at a time and retains compressed PNG frames before encoding, so
memory still grows with clip length and resolution. The package returns bytes; the caller owns
file writes or HTTP responses. Native encoding stays behind the `beatmap-lens/node` subpath.

### osu!lazer mania visual speed

Use `osuLazerManiaPixelsPerSecond` to match lazer's baseline note spacing for its standard desktop
landscape playfield:

```ts
const pixelsPerSecond = osuLazerManiaPixelsPerSecond({
  scrollSpeed: 22,
  gameplayViewport: { widthPx: 1710, heightPx: 1112 },
}); // ≈ 1783.944 px/s
```

Pass the final landscape gameplay rectangle. Its dimensions and the returned speed use the same
pixel coordinate space; physical DPI/PPI is not an input.

The adapter result can also be passed as a hard document scale:

```ts
const pages = renderSvgPages(beatmap.chart, {
  range: { startMs: 60_000, endMs: 70_000 },
  scale: { type: "linear", pixelsPerSecond },
});
```

Here the simulated gameplay viewport is not the export page size. Using the value as
`row-aware.basePixelsPerSecond` only makes it a local spacing reference; that non-linear output no
longer matches osu!lazer scroll distance.

Use the scene's canonical projection for every time/scene coordinate conversion:

```ts
import { projectTime, unprojectTime } from "beatmap-lens";

const yPx = projectTime(scene.projection, chart.range.startMs);
const sourceMs = unprojectTime(scene.projection, yPx);
```

`projectTime` and `unprojectTime` use scene-local Y coordinates. Their geometric domain is closed,
so both projection endpoints are valid even though note membership is half-open. Non-finite or
out-of-domain inputs throw `RangeError`. `RenderScene` retains resolved numeric precision; the SVG
serializer preserves finite JavaScript numeric values when encoding text.

The package is ESM-only, DOM-free, and performs no implicit file or network reads. It detects the
key count of valid `osu!mania` files from `[Difficulty] CircleSize` and supports 4K-10K normal
notes, long notes, bounded render scenes, SVG serialization, animation frames, Node.js WebP/GIF
encoding, and in-memory `.osz` archives.

`Beatmap` composes `.osu` source, its parsed document, its normalized chart, and an optional pointer
to `BeatmapAudio`. `connectBeatmapAudio` creates that connection without copying audio bytes.
`parseOsz` asynchronously returns a `BeatmapSet` whose difficulties already point to shared
referenced audio objects. Missing audio is valid and leaves the pointer undefined. `iterateOsz`
yields the same complete beatmaps one at a time when a caller does not need to wait for the whole
set.

Archive loading inflates `.osu` entries and only audio referenced by supported beatmaps. It never
loads backgrounds, videos, hitsounds, or unrelated audio. Inflation is asynchronous and limited to
two concurrent entries by default. Set `maxConcurrency` from 1 through 8 to trade throughput for
transient memory use.

The cumulative uncompressed size selected from one archive is capped at 256 MiB by default. Set
`maxInflatedBytes` on `parseOsz` or `iterateOsz` to choose another finite non-negative budget. The
loader rejects before crossing the limit; `NaN`, infinity, and negative budgets are invalid.

Archive entry names currently use UTF-8 decoding; legacy Shift-JIS filename fallback is not yet
included.

Audio byte arrays are shared by reference and are never copied or mutated by Beatmap Lens after
connection. Callers remain responsible for the arrays and for any browser resources created from
them.

The package boundary is every integer key count from 4K through 10K. The normalized chart,
diagnostics, render scene, analysis, and serialization stages share one key-count-aware pipeline
rather than separate per-key-count APIs. The first-party Inspector prioritizes 4K-7K at the app
layer; that narrower delivery priority does not reduce the package range.

Semantic chart-quality findings and synchronized audio playback remain project direction, not
current package features. See the [repository](https://github.com/ensomi-labs/beatmap-lens) for the
status and architecture.

One `RenderScene` intentionally covers one range and one playfield. Fixed-size solving, horizontal
layout, pagination, and readable spacing live in the separate `RenderDocument` layer. Beat-aligned
pagination, full timing/SV scroll-speed parity, and standalone PNG exports remain deferred.
