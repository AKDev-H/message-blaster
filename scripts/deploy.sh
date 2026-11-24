#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Refuse before touching code or schema while a campaign is sending.
if [[ -f scripts/check-idle.ts ]]; then node --import tsx scripts/check-idle.ts; fi

git pull --ff-only
npm ci --omit=dev
npm run setup
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
