#!/usr/bin/env bash
# ver_en_vlc.sh — arranca el cliente CY365 y abre el video en VLC (en el Mac).
#
# Lee la configuracion de `.env` (el mismo archivo que usa docker compose).
#
# IMPORTANTE: cierra la app CY365 en el movil. Si la app esta abierta, la camara
# no atiende el descubrimiento LAN y ademas corta las sesiones que ya hay.
#
# Uso:  ./ver_en_vlc.sh          (puerto de .env, o 8091)
#       ./ver_en_vlc.sh 8092
set -euo pipefail
cd "$(dirname "$0")"

PORT_ARG="${1:-}"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
else
  echo "aviso: no hay .env; copia .env.example y rellena DID y contrasena" >&2
  echo "       cp .env.example .env && \$EDITOR .env" >&2
  exit 1
fi

DID="${CY365_DID:?falta CY365_DID en .env}"
PORT="${PORT_ARG:-${CY365_HTTP_PORT:-8091}}"
LOG="${TMPDIR:-/tmp}/cy365-client.log"

ARGS=(--did "$DID" --user "${CY365_USER:-admin}" --pwd "${CY365_PASSWORD:-6666}" --http "$PORT")
[ -n "${CY365_CAM_IP:-}" ] && ARGS+=(--cam-ip "$CY365_CAM_IP")
[ -n "${CY365_AUTH:-}" ] && ARGS+=(--auth "$CY365_AUTH")
[ -n "${CY365_DEBUG:-}" ] && ARGS+=(--debug)

echo "Camara: $DID   servidor: http://localhost:$PORT"
echo "Cierra la app CY365 en el movil si aun la tienes abierta."
echo

node client/cy365-mjpeg.js "${ARGS[@]}" > "$LOG" 2>&1 &
CLIENT=$!
trap 'kill $CLIENT 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://localhost:$PORT/" && break
  sleep 0.5
done

echo "Esperando el primer frame (la camara puede tardar si esta dormida)..."
for _ in $(seq 1 120); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/snapshot")" = "200" ]; then
    echo "Primer frame recibido. Abriendo VLC."
    break
  fi
  sleep 1
done

open -a VLC "http://localhost:$PORT/stream" 2>/dev/null || open "http://localhost:$PORT/"
echo
echo "VLC muestra el stream MJPEG. Log del cliente: $LOG"
echo "Ctrl+C para terminar."
wait $CLIENT
