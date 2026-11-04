# Camarita — cliente CY365 en un contenedor.
#
# No hace falta `npm install`: el cliente solo usa modulos nativos de Node.
FROM node:22-alpine

WORKDIR /app

# Cliente parcheado (ver client/UPSTREAM.md para el diff respecto al original).
COPY client/cy365-mjpeg.js /app/cy365-mjpeg.js
COPY client/web /app/web

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh \
	&& adduser -D -H -u 10001 cam

USER cam

ENV CY365_HTTP_PORT=8091
EXPOSE 8091

# El streaming lo sirve el cliente; /healthz responde 200 aunque la cámara duerma.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD wget -q -O /dev/null "http://127.0.0.1:${CY365_HTTP_PORT}/healthz" || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
