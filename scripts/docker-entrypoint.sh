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
  wait "$active_pid"
  active_pid=
}

# The volume keeps downloaded models and generated credentials between starts.
# The pinned server is seeded from the image; no Docker socket is needed.
mkdir -p .local/bin .local/pids
cp /opt/liniya/livekit-server .local/bin/livekit-server
chmod 755 .local/bin/livekit-server
rm -f .local/pids/*.json
printf '%s\n' 'Preparing verified local models. The first start downloads about 1.3 GB; later starts reuse this volume.'
run_step setup
run_step up
printf '%s\n' 'Starting the browser interface at http://localhost:3000'
run_step web
