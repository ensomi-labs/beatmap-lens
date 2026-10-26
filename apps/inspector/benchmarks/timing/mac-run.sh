#!/bin/zsh
# Runs the Timing engine latency harness end to end on a Mac: installs, builds one timing bundle per
# LABEL=REF (each from its own temporary worktree), runs the lab and every build in headless, muted
# Chromium, in turn within each repeat, and writes raw JSON plus a summary under OUT.
#
#   apps/inspector/benchmarks/timing/mac-run.sh OUT [REPEATS] [LABEL=REF ...]
#
# The default builds are baseline=4954249 (the version before the engine) and engine=HEAD.
# Ports 4190-4199 only. Nothing is committed; the temporary worktrees and servers are removed.
set -euo pipefail

here=${0:A:h}
repo=${here:h:h:h:h}
out=${1:?usage: mac-run.sh OUT [REPEATS] [LABEL=REF ...]}
repeats=${2:-1}
builds=("${@:3}")
(( ${#builds} )) || builds=(baseline=4954249 engine=HEAD)
pnpm=(npx -y pnpm@11.9.0)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/timing-latency.XXXXXX")
mkdir -p "$out"

cleanup() {
  for build in $builds; do
    git -C "$repo" worktree remove --force "$scratch/src-${build%%=*}" 2>/dev/null || true
  done
  rm -rf "$scratch"
}
trap cleanup EXIT

node -e 'const [a, b] = process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 18)) { console.error("Node 22.18+ is needed, found " + process.version); process.exit(1); }'

commits=()
for build in $builds; do
  label=${build%%=*}
  ref=${build#*=}
  echo "== install and build $label ($ref)"
  git -C "$repo" worktree add --detach "$scratch/src-$label" "$ref"
  (cd "$scratch/src-$label" && $pnpm install --frozen-lockfile && $pnpm --filter @ensomi/beatmap-lens-inspector timing:bundle -- --out "$scratch/app-$label")
  commits+=("\"$label\": \"$(git -C "$scratch/src-$label" rev-parse HEAD)\"")
done

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
  echo "  \"harness_commit\": \"$(git -C "$repo" rev-parse HEAD)\","
  echo "  \"builds\": { ${(j:, :)commits} },"
  echo "  \"browser\": \"$BENCH_BROWSER\","
  echo "  \"macos\": \"$(sw_vers -productVersion 2>/dev/null || uname -r)\","
  echo "  \"hardware\": \"$(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)\","
  echo "  \"node\": \"$(node --version)\","
  echo "  \"started\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  echo "}"
} > "$out/environment.json"

for i in $(seq 1 "$repeats"); do
  echo "== lab $i"
  nice -n 10 node "$here/run.mjs" lab --label "lab-$i" --out "$out" --port 4199
  port=4190
  for build in $builds; do
    label=${build%%=*}
    echo "== $label $i"
    nice -n 10 node "$here/run.mjs" app --app "$scratch/app-$label" --label "$label-$i" --out "$out" --port $port
    port=$((port + 1))
  done
done

echo "== analysis"
node "$here/analyze.mjs" "$out" --json "$out/summary.json" > "$out/summary.md" || echo "analysis failed; raw JSON is kept"
echo "Results in $out"
