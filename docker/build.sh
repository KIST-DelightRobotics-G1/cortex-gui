#!/usr/bin/env bash
# Build the renderer image (run from anywhere).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

exec docker build -f docker/Dockerfile -t kist-cortex-gui "$@" .
