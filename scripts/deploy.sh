#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

git pull --ff-only
npm ci --omit=dev
npm run setup
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
