#!/usr/bin/env bash
# Read-only exact exception for the separately owned deletion cutoff helper.
boardsesh_sync_cutoff_contract_sql() {
  local runtime_role="$1"
  [[ "$runtime_role" =~ ^[a-z_][a-z0-9_]*$ ]] || return 1
  local contract_path
  contract_path="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/packages/db/scripts/sync-deletions-cutoff-contract.sql"
  sed "s/__SYNC_RUNTIME_ROLE__/$runtime_role/g" "$contract_path"
}
