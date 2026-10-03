#!/usr/bin/env bash
# run_api.sh — manage the ANPR HTTP API, its watchdog and the live-frame worker. Everything stays inside this folder.
#   ./run_api.sh keygen    create .env with a new random ANPR_API_KEY (chmod 600); refuses to overwrite
#   ./run_api.sh rotate    replace the API key (keeps other .env lines; clients must be updated)
#   ./run_api.sh start     start the watchdog (it starts/restarts api_server.py and reports status)
#                          and the live-frame worker (detect_worker.py, skipped when the file is absent)
#   ./run_api.sh stop | restart | status
#   ./run_api.sh ensure    start whichever of the watchdog and the worker is not running, each checked on its
#                          own (used by cron: a dead worker is restarted without touching the watchdog/API)
set -euo pipefail
cd "$(dirname "$0")"
PY=venv/bin/python
WPID=watchdog.pid
APID=api.pid
DPID=worker.pid

newkey() { $PY -c 'import secrets; print(secrets.token_urlsafe(40))'; }

keygen() {
  umask 077
  cat > .env <<EOF
# ANPR API config — secret, do not copy anywhere except the dashboard's server-side env
ANPR_API_KEY=$(newkey)
ANPR_API_HOST=100.64.0.1
ANPR_API_PORT=8765
ANPR_API_DETECTOR=deim50k
ANPR_API_OCR=raw35
ANPR_API_THRESHOLD=0.3
EOF
  chmod 600 .env
  echo "wrote .env (key not printed)"
}

alive() { [[ -f $1 ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

start_watchdog() {
  if alive $WPID; then echo "watchdog already running (pid $(cat $WPID))"; return 0; fi
  [[ -f .env ]] || { echo "no .env — run ./run_api.sh keygen"; return 1; }
  nohup $PY watchdog.py >> watchdog.stdout.log 2>&1 &
  echo $! > $WPID
  sleep 3
  if alive $WPID; then echo "watchdog started (pid $(cat $WPID)); api comes up in ~10 s"; else echo "watchdog failed — see watchdog.log"; return 1; fi
}

# The live-frame worker only dials out (Supabase); it needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.
start_worker() {
  [[ -f detect_worker.py ]] || return 0
  if alive $DPID; then echo "worker already running (pid $(cat $DPID))"; return 0; fi
  [[ -f .env ]] || return 0
  nohup $PY detect_worker.py >> worker.stdout.log 2>&1 &
  echo $! > $DPID
  sleep 2
  if alive $DPID; then echo "worker started (pid $(cat $DPID))"; else echo "worker failed — see worker.log and worker.stdout.log"; rm -f $DPID; return 1; fi
}

start() {
  local rc=0
  start_watchdog || rc=$?
  start_worker || true        # the worker is optional: its failure never fails the API start
  return "$rc"
}

ensure() {
  local rc=0
  alive $WPID || start_watchdog || rc=$?
  alive $DPID || start_worker || true
  return "$rc"
}

stop_worker() {
  if alive $DPID; then
    kill "$(cat $DPID)" 2>/dev/null || true
    for _ in $(seq 1 40); do alive $DPID || break; sleep 0.5; done     # it finishes the frame in flight first
    if alive $DPID; then kill -9 "$(cat $DPID)" 2>/dev/null || true; fi
  fi
  rm -f $DPID
}

stop() {
  stop_worker
  if alive $WPID; then kill "$(cat $WPID)"; for _ in $(seq 1 20); do alive $WPID || break; sleep 0.5; done; fi
  rm -f $WPID
  if alive $APID; then kill "$(cat $APID)" 2>/dev/null || true; fi
  rm -f $APID
  echo stopped
}

status() {
  if alive $WPID; then echo "watchdog running (pid $(cat $WPID))"; else echo "watchdog not running"; fi
  if alive $APID; then echo "api running (pid $(cat $APID))"; else echo "api not running"; fi
  if [[ ! -f detect_worker.py ]]; then echo "worker not installed (detect_worker.py missing)"
  elif alive $DPID; then echo "worker running (pid $(cat $DPID))"
  else echo "worker not running"; fi
}

case "${1:-status}" in
  keygen) if [[ -f .env ]]; then echo ".env exists — use rotate"; exit 1; fi; keygen ;;
  rotate)
    [[ -f .env ]] || { keygen; exit 0; }
    umask 077; k=$(newkey)
    grep -v '^ANPR_API_KEY=' .env > .env.tmp; { echo "ANPR_API_KEY=$k"; cat .env.tmp; } > .env; rm -f .env.tmp; chmod 600 .env
    echo "key rotated (not printed) — run ./run_api.sh restart and update the dashboard's DETECTION_API_KEY" ;;
  start) start ;;
  ensure) ensure ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "usage: $0 keygen|rotate|start|stop|restart|status|ensure"; exit 2 ;;
esac
