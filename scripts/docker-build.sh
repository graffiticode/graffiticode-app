#!/usr/bin/env bash
# Builds a service image without gc-deploy (CI, a local check), from the same
# Dockerfile a release uses.
#
#   scripts/docker-build.sh <app|console|mcp|openapi> [tag]
#
# Each Dockerfile copies .gc-profile/, the installation profile gc-deploy puts
# in a release's build context (@graffiticode/deploy README, "Installation
# profiles"). Without gc-deploy there is no profile, so this creates the
# directory empty for the build and removes it afterwards: gc-deploy refuses a
# workspace that has anything at .gc-profile, so none may be left behind.
set -euo pipefail
service="${1:?usage: scripts/docker-build.sh <app|console|mcp|openapi> [tag]}"
tag="${2:-gc-$service}"
cd "$(git rev-parse --show-toplevel)"
if [ -e .gc-profile ] || [ -L .gc-profile ]; then
  echo "docker-build: .gc-profile already exists; it is reserved for gc-deploy's release profile. Remove it first." >&2
  exit 1
fi
mkdir .gc-profile
# rmdir, not rm -r: anything that appeared inside is left for a person to see.
trap 'rmdir .gc-profile' EXIT
docker build -f "configs/Dockerfile.$service.yaml" -t "$tag" .
