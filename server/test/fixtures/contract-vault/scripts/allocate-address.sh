#!/usr/bin/env bash
# Reserves the next address of the form c-NNNNNN and increments the counter.
set -euo pipefail
current=$(cat "$(dirname "$0")/../.vault-meta/address-counter.txt")
printf 'c-%06d\n' "$current"
