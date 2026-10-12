# Beatmap Lens

Beatmap Lens develops an independent npm toolkit and an Inspector for understanding
`osu!mania` beatmaps. The longer-term direction is intelligent assistance for
mappers: inspect an arrangement, explain what it does, and help improve it.

- **[beatmap-lens](packages/beatmap-lens/README.md)** is the DOM-free TypeScript
  package. It parses `.osu` and `.osz` input, models 4K–10K charts and shared audio,
  and produces bounded render scenes, SVG review documents, and WebP/GIF animations in Node.js.
  The package README owns its API, examples, and defaults.
- **[Inspector](apps/inspector/)** is the first-party browser application. It combines
  chart inspection, audio playback, and section review with source-linked evidence
  and saved human judgments. Its current product priority is 4K–7K; the package
  retains its full 4K–10K boundary. See the [design guide](apps/inspector/DESIGN.md).

This repository also develops agent annotation and dataset production with
ensomi. The main workflow joins **whole-chart discovery
and selected-section annotation**, followed by independent agent review and human
corrections. The harness provides inspection tools; the judgment skill owns the
reading guidance. Neither numerical features nor agent agreement create human
judgments.

The annotation code and [research conclusions](docs/README.md#research) are public
so others can reuse the work and understand why the skill changes. Historical
campaigns, raw datasets, runs, and working notes can remain local. Running every
past experiment is not a public maintenance commitment.

Annotations are published on Hugging Face as
[sed-i/mania-pattern-annotations](https://huggingface.co/datasets/sed-i/mania-pattern-annotations).
The MIT snapshot [v4](https://huggingface.co/datasets/sed-i/mania-pattern-annotations/tree/102d63c485b38e7fb23af3eca64198dc607d3b6c) contains **2,860 complete five-dimension sections**,
combining 600 human records and 16,402 independently audited machine judgments
across 2,969 source identities. The human layer is the default; machine methods
remain separate opt-ins with exact human precedence. All v3 records are preserved.
Original beatmap URLs, titles, artist/mapper credits and SHA-256 identities remain
available even when the exact chart version can no longer be downloaded. Consumers
must verify the original hash before using chart bytes with these annotations.
Machine audit is not human confirmation or a measured accuracy claim.
Dataset releases are independent of the npm package.
The [publication record and pipeline](docs/annotation/dataset-publication.md) describe
scope, immutable method artifacts, source-access policy and earlier releases.
The [selection repair procedure](docs/annotation/evidence-review.md) preserves
label authority and evidence provenance, and supplements missing selections
through concurrent agent judgment and note selection.

## Repository map

| Location | Responsibility |
| --- | --- |
| `packages/beatmap-lens/` | Independent npm package |
| `apps/inspector/` | Browser UI and its local services in `server/` |
| `harness/` | Read-only inspection, queries, rendering, and example retrieval |
| `annotation/pipeline/` | Corpus preparation, discovery, selection, annotation, delivery, and revision |
| `annotation/evaluation/` | Benchmarks and skill/workflow regression gate |
| `annotation/learning/` | Natural-chart exploration and revisable reading experience |
| `annotation/roles/` | Worker role instructions |
| `.agents/skills/` | Judgment and repository-maintenance skills |
| `docs/` | Reusable workflow guides, research conclusions, and design decisions |
| `scripts/` | Repository maintenance and package validation |
| `.local/` | Local datasets, workspaces, generated artifacts, and working notes |

## Development

Use Node.js 22.18+ on the 22.x line or Node.js 24.11+, pnpm 11+, and uv.
Python 3.10 and its project dependencies are managed in the root `.venv`.

```sh
pnpm install
uv sync --locked
pnpm check
pnpm dev
```

In Inspector's **Annotate** setup, select **Full paths** and enter the existing
dataset folder for saved comments, the catalog JSON file, and the mapped corpus
folder. Absolute paths and `~/` paths are supported by the local development and
preview servers. The last paths are remembered; **Open workspace** reconnects
them. **Browse** also remains available in browsers with folder-picker support.
Chart and audio access is read-only; saves go to the selected dataset folder.

Inspector's **Compare** workspace (`/compare`) judges two generated charts of one
song blind, by listening. The [Inspector guide](apps/inspector/README.md#compare)
covers its use; [model comparison packets](docs/inspector/model-comparison.md) is
the format for jobs that produce comparisons and read the verdicts.

`pnpm check` runs engineering checks. `pnpm check:regression` separately evaluates
method changes; missing semantic replay remains missing evidence, not a quality
pass. Dataset publication checks its own frozen snapshot and declared policy.

Paired development with the neighboring ensomi checkout is the default for
annotation work. Paths and Python environments are configurable; see the
[annotation workflow](docs/annotation/corpus-annotation.md) and
[contribution guide](CONTRIBUTING.md). The npm package does not depend on ensomi.

## Compact task packets

Campaigns copy each frozen agent task packet (`task.json` from `fetch-task`) into the
labeler's delivery folder and the auditor's `sealed/` inputs. Every copy repeats the
Foundation with its calibration charts and the source chart as JSON byte arrays, about
8 MB per packet. Once a campaign has finished, store its packets once:

```sh
node apps/inspector/server/annotation-workflow.mjs compact-packets --root .local/CAMPAIGN
```

Each `*task.json` under the root keeps its path and becomes a
`beatmap-lens-local-compact-v1` envelope: the SHA-256 of the original file and a reference
to the packed task. The task, its Foundation and the chart bytes are stored once by SHA-256
in `CAMPAIGN/.workflow-objects`, in the review workspace's object format (JSON gzipped,
chart bytes as `.bin`). A packet is replaced only after its rebuild matches the original
bytes; other files are left as they are.

File readers (delivery and recovery scripts, auditors' sealed inputs, campaign exports)
need the original bytes. Before rerunning any step of a compacted campaign, restore them in
place, verified against the stored hash, and compact again afterwards:

```sh
node apps/inspector/server/annotation-workflow.mjs expand-packets --root .local/CAMPAIGN
```

`readTaskPacketFile(path, root)` in `apps/inspector/server/workflow-local-directory.mjs`
returns one packet's original text without rewriting it. Back up a compacted campaign
together with its `.workflow-objects`.

## License

MIT
