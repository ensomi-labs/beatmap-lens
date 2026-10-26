#!/bin/zsh
# Runs the Timing engine latency harness end to end on a Mac: installs, builds the engine bundle
# from this checkout and the baseline bundle from BASELINE_REF, runs the lab and both builds in
# headless, muted Chromium, and writes raw JSON plus a summary under OUT.
#
#   apps/inspector/benchmarks/timing/mac-run.sh OUT [BASELINE_REF] [REPEATS]
#
# Ports 4190-4199 only. Nothing is committed; the temporary worktree and servers are removed.
set -euo pipefail

here=${0:A:h}
repo=${here:h:h:h:h}
out=${1:?usage: mac-run.sh OUT [BASELINE_REF] [REPEATS]}
baseline_ref=${2:-4954249}
repeats=${3:-1}
pnpm=(npx -y pnpm@11.9.0)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/timing-latency.XXXXXX")
mkdir -p "$out"

cleanup() {
  git -C "$repo" worktree remove --force "$scratch/baseline-src" 2>/dev/null || true
  rm -rf "$scratch"
}
trap cleanup EXIT

node -e 'const [a, b] = process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 18)) { console.error("Node 22.18+ is needed, found " + process.version); process.exit(1); }'

echo "== install and build the engine bundle ($(git -C "$repo" rev-parse --short HEAD))"
(cd "$repo" && $pnpm install --frozen-lockfile && $pnpm --filter @ensomi/beatmap-lens-inspector timing:bundle -- --out "$scratch/engine")

echo "== install and build the baseline bundle ($baseline_ref)"
git -C "$repo" worktree add --detach "$scratch/baseline-src" "$baseline_ref"
(cd "$scratch/baseline-src" && $pnpm install --frozen-lockfile && $pnpm --filter @ensomi/beatmap-lens-inspector timing:bundle -- --out "$scratch/baseline")

echo "== playwright-core and a browser"
npm install --prefix "$scratch/pw" --no-save --no-audit --no-fund playwright-core@1.55.0 >/dev/null
export PLAYWRIGHT_CORE="$scratch/pw/node_modules/playwright-core"
if [[ -z "${BENCH_BROWSER:-}" ]]; then
  if [[ -d "/Applications/Google Chrome.app" ]]; then
    export BENCH_BROWSER=chrome
  else
    (cd "$scratch/pw" && npx -y playwright@1.55.0 install chromium)
    export BENCH_BROWSER=chromium
  fi
fi

{
  echo "{"
  echo "  \"engine_commit\": \"$(git -C "$repo" rev-parse HEAD)\","
  echo "  \"baseline_ref\": \"$baseline_ref\","
  echo "  \"baseline_commit\": \"$(git -C "$scratch/baseline-src" rev-parse HEAD)\","
  echo "  \"browser\": \"$BENCH_BROWSER\","
  echo "  \"macos\": \"$(sw_vers -productVersion 2>/dev/null || uname -r)\","
  echo "  \"hardware\": \"$(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)\","
  echo "  \"node\": \"$(node --version)\","
  echo "  \"started\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  echo "}"
} > "$out/environment.json"

echo "== lab"
nice -n 10 node "$here/run.mjs" lab --out "$out" --port 4199
for i in $(seq 1 "$repeats"); do
  echo "== baseline $i"
  nice -n 10 node "$here/run.mjs" app --app "$scratch/baseline" --label "baseline-$i" --out "$out" --port 4190
  echo "== engine $i"
  nice -n 10 node "$here/run.mjs" app --app "$scratch/engine" --label "engine-$i" --out "$out" --port 4191
done

echo "== analysis"
node "$here/analyze.mjs" "$out" --json "$out/summary.json" > "$out/summary.md" || echo "analysis failed; raw JSON is kept"
echo "Results in $out"
