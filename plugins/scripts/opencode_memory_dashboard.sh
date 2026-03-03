#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-start}"
PORT="${2:-37777}"

DASHBOARD_DIR="${HOME}/.opencode/memory/dashboard"
CONTAINER_NAME="opencode-memory-dashboard"
PY_PID_FILE="${DASHBOARD_DIR}/.httpserver.pid"
PY_LOG_FILE="${DASHBOARD_DIR}/.httpserver.log"

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

is_port_listening() {
  if ! has_cmd lsof; then
    return 1
  fi
  lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P >/dev/null 2>&1
}

docker_ready() {
  has_cmd docker && docker info >/dev/null 2>&1
}

python_ready() {
  has_cmd python3
}

ensure_dashboard_dir() {
  mkdir -p "${DASHBOARD_DIR}"
  if [[ ! -f "${DASHBOARD_DIR}/index.html" ]]; then
    cat > "${DASHBOARD_DIR}/index.html" <<'HTML'
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Memory Dashboard</title></head>
<body>
  <h3>Memory dashboard file not generated yet.</h3>
  <p>Run your OpenCode memory plugin once, then refresh this page.</p>
</body>
</html>
HTML
  fi
}

start_with_docker() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  docker run -d \
    --name "${CONTAINER_NAME}" \
    -p "${PORT}:80" \
    -v "${DASHBOARD_DIR}:/usr/share/nginx/html:ro" \
    nginx:alpine >/dev/null
  echo "Started with Docker: http://127.0.0.1:${PORT}"
}

start_with_python() {
  if [[ -f "${PY_PID_FILE}" ]]; then
    OLD_PID="$(cat "${PY_PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" >/dev/null 2>&1; then
      echo "Python server already running (PID ${OLD_PID}): http://127.0.0.1:${PORT}"
      return
    fi
  fi

  (
    cd "${DASHBOARD_DIR}"
    nohup python3 -m http.server "${PORT}" --bind 127.0.0.1 > "${PY_LOG_FILE}" 2>&1 &
    echo $! > "${PY_PID_FILE}"
  )
  echo "Started with Python: http://127.0.0.1:${PORT}"
}

stop_all() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

  if [[ -f "${PY_PID_FILE}" ]]; then
    PID="$(cat "${PY_PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${PID}" ]] && kill -0 "${PID}" >/dev/null 2>&1; then
      kill "${PID}" >/dev/null 2>&1 || true
    fi
    rm -f "${PY_PID_FILE}"
  fi

  echo "Stopped dashboard services (if running)."
}

status_all() {
  DOCKER_STATE="stopped"
  PY_STATE="stopped"

  if has_cmd docker; then
    if docker ps --filter "name=^${CONTAINER_NAME}$" --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
      DOCKER_STATE="running"
    fi
  fi

  if [[ -f "${PY_PID_FILE}" ]]; then
    PID="$(cat "${PY_PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${PID}" ]] && kill -0 "${PID}" >/dev/null 2>&1; then
      PY_STATE="running (PID ${PID})"
    fi
  fi

  echo "Docker: ${DOCKER_STATE}"
  echo "Python: ${PY_STATE}"
  if is_port_listening; then
    echo "Port ${PORT}: listening"
  else
    echo "Port ${PORT}: not listening"
  fi
  echo "URL: http://127.0.0.1:${PORT}"
}

case "${ACTION}" in
  start)
    ensure_dashboard_dir
    if is_port_listening; then
      echo "Port ${PORT} is already in use. Use: $0 status ${PORT}"
      exit 1
    fi
    if docker_ready; then
      start_with_docker
    elif python_ready; then
      start_with_python
    else
      echo "Neither Docker nor python3 is available."
      exit 1
    fi
    ;;
  stop)
    stop_all
    ;;
  status)
    status_all
    ;;
  *)
    echo "Usage: $0 [start|stop|status] [port]"
    exit 1
    ;;
esac
