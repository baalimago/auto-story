#!/usr/bin/env bash
# Prepare Pi, build and size-check the package, set secrets, deploy.
#
#   scripts/deploy.sh
#
# The app has no secrets: visitors bring their Wasmer token and model keys.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
die() { echo "error: $*" >&2; exit 1; }

who=$(wasmer whoami 2>&1) || die "not logged in: run 'wasmer login' or export WASMER_TOKEN"
case "$who" in *"registry wasmer.io"*) ;; *) die "unexpected registry: $who" ;; esac
echo "$who"
owner=${OWNER:-$(sed -n 's/^owner: *//p' app.yaml)}
app="$owner/$(sed -n 's/^name: *//p' app.yaml)"

npm ci --prefix pi --ignore-scripts --no-bin-links --no-audit --no-fund
npm run --prefix pi prepare:wasmer

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
wasmer package build . -o "$tmp/auto-story.webc" >/dev/null
size=$(( $(stat -c %s "$tmp/auto-story.webc") / 1048576 ))
echo "package: ${size} MiB"
[ "$size" -le 64 ] || die "package exceeds 64 MiB; check .wasmerignore"

args=(--non-interactive)
[ -n "${OWNER:-}" ] && args+=(--owner "$OWNER")
wasmer deploy "${args[@]}"


url=$(wasmer app get "$app" -f json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).url))')
echo "healthz: $(curl -s -m 30 "$url/healthz")"
echo "live: $url"
