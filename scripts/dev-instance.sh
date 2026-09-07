#!/usr/bin/env bash
# Run a second, isolated vault-service instance for developing the research agents
# extension next to the live service (docs/agents/SPEC.md, section 14).
#
#   scripts/dev-instance.sh                      # tsx from source (npm start), port 8421
#   scripts/dev-instance.sh npm run start:prod   # the built JS instead
#
# Its port, SQLite database, watch folder and Telegram wiring stay separate from the live
# service (Telegram allows one poller per token, and the live bot owns it). The credential
# file is shared on purpose. Any variable can be overridden from the environment.
#
# THE VAULT IS NOT SEPARATE ANY MORE (2026-09-07). The seeded demo vault was archived and
# this instance now runs against the real vault, which the live service also writes to. Each
# service holds its own in-process commit mutex, so the two cannot serialise against each
# other: do not let both write at once. In practice that means stopping the live service
# (`systemctl --user stop vault-service`) before a Fellow run or an ingest here, or keeping
# this instance read-only while the live one is up.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${CURIOUS_DATA:-$HOME/.local/share/curious}"

export PORT="${PORT:-8421}"
export VAULT_ROOT="${VAULT_ROOT:-$HOME/vault}"
export DB_PATH="${DB_PATH:-$DATA/jobs.db}"
export WATCH_FOLDER="${WATCH_FOLDER:-$DATA/inbox}"
export OBSIDIAN_VAULT_NAME="${OBSIDIAN_VAULT_NAME:-vault}"
export TELEGRAM_BOT_TOKEN=""
export AGENTS_ENABLED="${AGENTS_ENABLED:-1}"
# nvm's node is not on PATH in non-interactive shells.
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"

# Without DB_PATH the server falls back to the live service's database (db/index.ts,
# defaultDbPath). That happened once: two Fellows and their runs ended up in the live file,
# where nothing reads them. Refuse rather than repeat it.
case "$DB_PATH" in
  *"/.local/share/vault-service/jobs.db")
    echo "error: DB_PATH points at the live service's database ($DB_PATH)" >&2
    echo "       this instance keeps its own; unset DB_PATH or point it inside $DATA" >&2
    exit 1
    ;;
esac

mkdir -p "$DATA" "$WATCH_FOLDER"
if [ ! -d "$VAULT_ROOT/wiki" ] || [ ! -d "$VAULT_ROOT/skills" ]; then
  echo "error: no claude-obsidian vault at $VAULT_ROOT (see docs/agents/SPEC.md, section 14)" >&2
  exit 1
fi

# The vault plugin commits on its own ("wiki: auto-commit …") unless this flag exists. The
# service must own every run's commit (hard rule 1), or a run's pages are committed out from
# under it and its row shows no pages. The live vault carries the same flag.
mkdir -p "$VAULT_ROOT/.vault-meta"
[ -e "$VAULT_ROOT/.vault-meta/auto-commit.disabled" ] || touch "$VAULT_ROOT/.vault-meta/auto-commit.disabled"

cd "$REPO"
if [ $# -eq 0 ]; then set -- npm start; fi
echo "dev instance: port $PORT, vault $VAULT_ROOT, db $DB_PATH, inbox $WATCH_FOLDER"
exec "$@"
