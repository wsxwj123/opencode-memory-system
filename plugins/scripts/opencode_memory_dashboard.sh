#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-start}"
PORT="${2:-37777}"
PARENT_PID="${3:-0}"
OPENCODE_PORT="${4:-4096}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SCRIPT="${SCRIPT_DIR}/opencode_memory_dashboard.mjs"

if [[ ! -f "${NODE_SCRIPT}" ]]; then
  echo "Dashboard node script not found: ${NODE_SCRIPT}" >&2
  exit 1
fi

# Delegate all lifecycle operations to the Node dashboard service.
exec node "${NODE_SCRIPT}" "${ACTION}" "${PORT}" "${PARENT_PID}" "${OPENCODE_PORT}"
