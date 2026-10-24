#!/usr/bin/env bash
set -euo pipefail
cd /app
umask 077
python=/app/voice/.venv/bin/python
active_pid=

cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$active_pid" ]]; then
    kill -TERM "$active_pid" 2>/dev/null || true
    wait "$active_pid" 2>/dev/null || true
  fi
  "$python" scripts/voice-stack.py down || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_step() {
  "$python" scripts/voice-stack.py "$1" &
  active_pid=$!
  local status=0
  wait "$active_pid" || status=$?
  active_pid=
  return "$status"
}

# The volume keeps downloaded models and generated credentials between starts.
# The pinned server is seeded from the image; no Docker socket is needed.
mkdir -p .local/bin .local/pids
cp /opt/liniya/livekit-server .local/bin/livekit-server
chmod 755 .local/bin/livekit-server
rm -f .local/pids/*.json
printf '%s\n' 'Preparing local Qwen and speech recognition. First setup downloads about 1.3 GB; later starts reuse this volume.'
run_step setup
if ! run_step up; then
  printf '%s\n' 'Voice services are not ready. The web interface will still start so you can edit knowledge and inspect readiness.'
fi
printf '%s\n' 'Starting the browser interface at http://localhost:3000'
run_step web
