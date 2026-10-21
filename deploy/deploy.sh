#!/usr/bin/env bash
set -euo pipefail

# Deploy image-processing.
#
#   ./deploy/deploy.sh
#
# DO NOT RUN `sam build` FOR THIS STACK. It re-runs `npm install` in .aws-sam/build, which on a Mac
# installs the DARWIN build of `sharp` and overwrites the linux-x64 one that is committed in src/.
# Lambda then cannot load the module at all, every image upload on the platform fails at init, and the
# only symptom a caller sees is an image that uploads and never appears.
#
# That is not hypothetical: it happened on 2026-10-20 and took image processing down for about three
# minutes until the stack was redeployed straight from src/.
#
# `sam deploy` with no prior build packages CodeUri as-is, which is exactly what this stack wants --
# the correct binaries are already in src/node_modules/@img/.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REQUIRED="src/node_modules/@img/sharp-linux-x64"
if [[ ! -d "$REQUIRED" ]]; then
  echo "ABORT: $REQUIRED is missing." >&2
  echo "Lambda runs linux-x64. Reinstall it with:" >&2
  echo "  (cd src && npm install --os=linux --cpu=x64 --include=optional sharp)" >&2
  exit 1
fi

if [[ -d .aws-sam ]]; then
  # A stale build directory is the thing that causes this, so it is removed rather than warned about.
  echo "==> Removing .aws-sam (a sam build artifact would ship the wrong sharp)"
  rm -rf .aws-sam
fi

echo "==> sharp: $(ls src/node_modules/@img/ | tr '\n' ' ')"
echo "==> deploy (packaging src/ directly, NOT via sam build)"
sam deploy "$@"
