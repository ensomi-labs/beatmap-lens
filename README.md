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
The MIT snapshot [v3](https://huggingface.co/datasets/sed-i/mania-pattern-annotations/tree/b22a7a443783e05fee4db4b1d22b8e573ad448ae) contains 592 human records and
4,403 independently audited Astra judgments across 545 annotated charts.
The human layer is the default; the opt-in machine layer selects only eligible
judgments from the latest 1,000-section campaign, with exact human precedence.
The [frozen method](annotation/methods/astra-1000-20260912/README.md) records
`gpt-6-astra`, skill and harness hashes, prompts, and independent auditor identities.
Machine audit is not human confirmation or a measured accuracy claim. Earlier
machine layers remain available at their immutable historical dataset versions.
Dataset releases are independent of the npm package.
The [publication pipeline](docs/annotation/dataset-publication.md) builds compact
Parquet snapshots with pinned GitHub artifacts and hash-verified external chart references.
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

## License

MIT
