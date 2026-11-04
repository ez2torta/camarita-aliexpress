# Origen del cliente y que cambiamos

`cy365-mjpeg.js` es una copia de:

- Repo: <https://github.com/26medias/CY365-wifi-camera-reverse-engineering>
- Commit: `82440b3` ("Link the exact AliExpress listing…")
- Licencia: MIT (© Julien Loutre) — copia en `LICENSE`.

Se vendoriza (en vez de clonar en tiempo de build) para que la imagen sea
reproducible sin depender de que el repo upstream siga publicado.

## Cambios sobre el original

Todos son locales a esta unidad (`CYCAM_T99 v32 0226`, DID `EEE-000000-XXXXX`:
el tuyo va en `.env`).

| cambio | motivo |
|---|---|
| `check_user` desactivado por defecto (solo con `--with-check`) | con ese paquete la camara contesta `0xf0 Close` a los ~4 s y no llega ni un frame |
| `--devmac`, `--video`, `--camsmode`, `--fmt`, `--onlycheck`, `--onlystream`, `--nocontrol` | flags de diagnostico usados durante la ingenieria inversa |
| volcado crudo del canal 0 en `--debug` | el firmware no contestaba JSON; ver el hex fue lo que permitio descartar contrasena y framing |
| `--auth user:pass` (HTTP Basic, opcional) | el stream no trae autenticacion propia; hace falta si el puerto sale de la LAN |

## Como re-sincronizar con upstream

```bash
git clone https://github.com/26medias/CY365-wifi-camera-reverse-engineering /tmp/cy365
cd /tmp/cy365 && git log --oneline -5
# diff contra el archivo vendorizado:
diff -u cy365-mjpeg.js /ruta/a/camarita_espia/client/cy365-mjpeg.js | less
```

Si upstream cambia algo interesante, reaplica a mano los cuatro cambios de la
tabla. Son pequenos y estan comentados en el codigo con `OJO:`.
