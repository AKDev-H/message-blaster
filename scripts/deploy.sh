#!/usr/bin/env bash
set -euo pipefail

# Wrapped in a function so bash reads the whole script before `git pull` can rewrite it.
main() {
    cd "$(dirname "$0")/.."

    node_major="$(node -p 'process.versions.node.split(".")[0]')"
    if (( node_major < 24 )); then
        echo "Node $(node -v) found; message-blaster needs Node 24. Upgrade Node (e.g. nvm install 24 / NodeSource) and rerun." >&2
        exit 1
    fi

    if [[ -f scripts/check-idle.mjs ]]; then
        node scripts/check-idle.mjs
    fi

    git pull --ff-only
    npm ci --omit=dev
    npm run setup
    pm2 startOrReload ecosystem.config.cjs --update-env
    pm2 save
}

main "$@"
