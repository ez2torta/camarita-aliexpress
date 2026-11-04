#!/bin/sh
# Traduce las variables de entorno (pensadas para .env / docker compose) a los
# argumentos que espera cy365-mjpeg.js. Asi el mismo cliente sirve en el Mac y
# en el contenedor.
set -eu

if [ -z "${CY365_DID:-}" ]; then
	echo "[entrypoint] falta CY365_DID (el ID que muestra la app CY365: EEE-XXXXXX-XXXXX)" >&2
	exit 1
fi

PORT="${CY365_HTTP_PORT:-8091}"

set -- node /app/cy365-mjpeg.js \
	--did "$CY365_DID" \
	--user "${CY365_USER:-admin}" \
	--pwd "${CY365_PASSWORD:-6666}" \
	--http "$PORT"

if [ -n "${CY365_CAM_IP:-}" ]; then
	set -- "$@" --cam-ip "$CY365_CAM_IP"
fi
if [ -n "${CY365_AUTH:-}" ]; then
	set -- "$@" --auth "$CY365_AUTH"
fi
if [ -n "${CY365_DEBUG:-}" ]; then
	set -- "$@" --debug
fi

if [ -n "${CY365_AUTH:-}" ]; then
	echo "[entrypoint] camara=$CY365_DID  http=0.0.0.0:$PORT  auth=si"
else
	echo "[entrypoint] camara=$CY365_DID  http=0.0.0.0:$PORT  auth=NO (sin contrasena)"
fi

exec "$@"
