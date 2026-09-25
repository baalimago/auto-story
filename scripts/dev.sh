#!/usr/bin/env bash
# Run the builder locally under Wasmer on :8080. Extra --env flags are passed through.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
args=(--net --volume ./data:/data)
exec wasmer run . "${args[@]}" "$@"
