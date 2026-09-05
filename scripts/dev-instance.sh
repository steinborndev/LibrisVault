#!/usr/bin/env bash
# Run a second, isolated vault-service instance for developing the research agents
# extension next to the live service (docs/agents/SPEC.md, section 14).
#
#   scripts/dev-instance.sh                      # tsx from source (npm start), port 8421
#   scripts/dev-instance.sh npm run start:prod   # the built JS instead
#
# Everything this instance touches is separate from the live service: its own port, its
# own SQLite database, its own vault clone and watch folder, and no Telegram token (Telegram
# allows one poller per token, and the live bot owns it). The credential file is shared on
# purpose. Any variable can be overridden from the environment.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${CURIOUS_DATA:-$HOME/.local/share/curious}"

export PORT="${PORT:-8421}"
export VAULT_ROOT="${VAULT_ROOT:-$HOME/vault-curious}"
export DB_PATH="${DB_PATH:-$DATA/jobs.db}"
export WATCH_FOLDER="${WATCH_FOLDER:-$DATA/inbox}"
export OBSIDIAN_VAULT_NAME="${OBSIDIAN_VAULT_NAME:-vault-curious}"
export TELEGRAM_BOT_TOKEN=""
export AGENTS_ENABLED="${AGENTS_ENABLED:-1}"
# nvm's node is not on PATH in non-interactive shells.
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"

mkdir -p "$DATA" "$WATCH_FOLDER"
if [ ! -d "$VAULT_ROOT/wiki" ] || [ ! -d "$VAULT_ROOT/skills" ]; then
  echo "error: no claude-obsidian vault at $VAULT_ROOT (see docs/agents/SPEC.md, section 14)" >&2
  exit 1
fi

cd "$REPO"
if [ $# -eq 0 ]; then set -- npm start; fi
echo "dev instance: port $PORT, vault $VAULT_ROOT, db $DB_PATH, inbox $WATCH_FOLDER"
exec "$@"
