#!/usr/bin/env bash
set -euo pipefail

mkdir -p /run/cups /var/spool/cups/tmp /var/log/cups /tmp/printjobs
rm -f /run/cups/cupsd.pid

# Servizio CUPS interno (in ascolto solo su localhost / socket unix)
cupsd -f &
CUPS_PID=$!

for _ in $(seq 1 30); do
  if lpstat -r >/dev/null 2>&1; then break; fi
  sleep 1
done

# Un solo worker (la conversione LibreOffice e' serializzata), piu' thread
# (servono anche per le miniature dell'anteprima, che arrivano a raffica)
gunicorn --bind 0.0.0.0:8080 --workers 1 --threads 8 --timeout 300 \
  --access-logfile - --error-logfile - app:app &
APP_PID=$!

shutdown() {
  kill -TERM "$APP_PID" "$CUPS_PID" 2>/dev/null || true
  wait || true
  exit 0
}
trap shutdown TERM INT

wait -n "$CUPS_PID" "$APP_PID" || true
echo "Un processo e' terminato: arresto del container" >&2
kill -TERM "$APP_PID" "$CUPS_PID" 2>/dev/null || true
exit 1
