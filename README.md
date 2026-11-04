# Camarita espía — ver la CYCAM T99 en el Mac sin la nube

**Solución corta:** cierra la app CY365 en el móvil y ejecuta `./ver_en_vlc.sh`.
Vídeo en vivo (MJPEG 640×480) en `http://localhost:8091/stream`, abierto en VLC.
Detalles en la [sección ✅ Solución](#-solución-que-funciona-3-nov-2026).

El resto del documento es el diario de diagnóstico: por qué RTSP/ONVIF/P2P no sirven
en esta unidad y cómo se llegó al cliente que sí funciona.

## Estado del último escaneo (3 nov 2026)

Subred `192.168.1.0/24`, Mac en `192.168.1.21`:

| IP | Qué es |
|---|---|
| 192.168.1.1 | Router ZTE F6600P |
| 192.168.1.2 | Servidor ZimaOS (NAS) |
| 192.168.1.20 | TV Hisense (DLNA) |
| 192.168.1.21 | Este Mac |
| 192.168.1.22 / .23 / .24 | iPhones y demás móviles |
| 192.168.1.26 | **La cámara** — MAC sin fabricante asignado y **sin ningún puerto abierto** |

El escaneo cubre **las 254 IPs** de la subred por ping **y por tabla ARP** (así también ve
equipos que bloquean el ping). No hay más subredes: la máscara es /24 y la única interfaz
de red es `en0` (el `utun4` con `100.x.y.z` es un túnel de Tailscale, no una LAN).

Conclusión del escaneo: **ningún equipo de la red sirve RTSP.** El `.26` resultó ser
la cámara (confirmado desenchufándola mientras `camarita.py vigilar` corría), pero no
abre **ningún** puerto TCP/UDP: usa un protocolo P2P propietario por UDP, así que RTSP
y ONVIF están descartados de raíz. La vía que funciona está más abajo.

---

## 1. Uso rápido

**Lo que funciona hoy** (ver sección ✅ para el detalle):

```bash
cp .env.example .env         # solo la primera vez: DID y contrasena
./ver_en_vlc.sh              # puerto 8091 por defecto
./ver_en_vlc.sh 8092         # otro puerto
```

Requiere Node.js y la app CY365 **cerrada** en el móvil. Abre VLC en
`http://localhost:8091/stream`; también sirve `/snapshot` para una foto suelta.
Para tenerlo 24/7 en el NAS, ver la [sección 7](#7-servidor-en-zimaos-docker-y-ver-desde-fuera).

Herramientas de diagnóstico (RTSP/ONVIF, ya descartadas para esta cámara):

```bash
# Buscar la cámara en toda la red (254 IPs, por ping + tabla ARP)
python3 camarita.py scan

# Escanear varias subredes de golpe (si sospechas que está en otra)
python3 camarita.py scan 192.168.0 192.168.2 10.0.0

# Probar rutas y credenciales en una IP concreta
python3 camarita.py probe 192.168.1.26

# Hacer todo y abrir VLC con lo primero que funcione
python3 camarita.py auto

# Abrir una URL concreta en VLC
python3 camarita.py open "rtsp://admin:admin@192.168.1.26:554/live/0/onvif.sdp"

# Guardar un frame de prueba (sirve para verificar sin VLC)
python3 camarita.py foto "rtsp://admin:admin@192.168.1.26:554/live/0/onvif.sdp" foto.jpg

# Identificar una IP: desenchufa la cámara mientras corre esto
python3 camarita.py vigilar 192.168.1.26

# Ver si la cámara abre algún puerto (mientras la app está viendo en vivo)
python3 camarita.py puertos 192.168.1.26 180
```

Flujo recomendado: **enciende la cámara** → `python3 camarita.py auto`.

## 2. Abrir en VLC a mano

1. Abre VLC.
2. `Archivo → Abrir ubicación de red…` (o `⌘N`).
3. Pega la URL, por ejemplo:

   ```
   rtsp://admin:admin@192.168.1.26:554/live/0/onvif.sdp
   ```

4. En «Opciones avanzadas» / «Mostrar más opciones» marca **Transmisión RTSP por TCP**
   (evita el 90 % de los cortes y pantallas negras).

Desde terminal, con TCP forzado:

```bash
/Applications/VLC.app/Contents/MacOS/VLC --rtsp-tcp --network-caching=800 \
  "rtsp://admin:admin@192.168.1.26:554/live/0/onvif.sdp"
```

Para grabar mientras ves:

```bash
/Applications/VLC.app/Contents/MacOS/VLC --rtsp-tcp \
  "rtsp://admin:admin@192.168.1.26:554/live/0/onvif.sdp" \
  --sout="#std{access=file,mux=mp4,dst=/tmp/camara.mp4}" --run-time=60 vlc://quit
```

## 3. Alternativas a VLC

| Programa | Cómo |
|---|---|
| **ffplay** (ya lo tienes, viene con ffmpeg) | `ffplay -rtsp_transport tcp "rtsp://…"` |
| **IINA** | Igual que VLC: `⌘N` y pegar la URL |
| **mpv** | `mpv --rtsp-transport=tcp "rtsp://…"` |
| **ffmpeg** (grabar) | `ffmpeg -rtsp_transport tcp -i "rtsp://…" -c copy -t 60 salida.mp4` |

## 4. Rutas y credenciales que prueba la herramienta

Rutas (en orden de probabilidad para CYCAM T99):

```
/live/0/onvif.sdp      ← la más reportada para CYCAM
/live/1/onvif.sdp
/live/0/h264.sdp
/live/1/h264.sdp
/live/0/mpeg4.sdp
/onvif.sdp
/cam/realmonitor?channel=1&subtype=0   ← XMEye/Xiongmai
/live/ch0                              ← V380
/video1, /11, /12
/Streaming/Channels/101                ← Hikvision
/h264/ch1/main/av_stream
/stream1, /live.sdp, /h264 …
```

Credenciales: `admin:admin`, `admin:` (vacía), `admin:1212`, `admin:1313`,
`admin:12345`, `admin:123456`, `admin:888888`, `root:`, `root:root`, `888888:888888`.

Puertos: RTSP `554`, `8554`, `10554`; app/P2P `34567` (XMEye), `37777` (Dahua),
`8800` (V380); web `80/8080/8000/8009`.

## 5. Si `scan` no encuentra la cámara

Revisa en este orden:

1. **¿Está encendida y conectada al Wi-Fi de 2,4 GHz?** Casi todas estas cámaras no
   ven redes de 5 GHz. Si tu router tiene la misma SSID en 2,4 y 5 GHz, sepáralas.
2. **¿Está en una red de invitados o VLAN?** El aislamiento de clientes impide que el
   Mac la vea. Conéctala a la red principal.
3. **Activa RTSP/ONVIF en la app.** En cámaras baratas suele estar en
   `Ajustes → ONVIF`, `Configuración avanzada → RTSP`, `Modo PC` o `Modo NVR`.
   Si la firmware no trae esa opción, **no hay RTSP**: solo funciona por la app/nube.
4. **¿Está en modo AP (punto de acceso)?** Si emite su propia red (`CYCAM_xxxx`,
   `V380_xxxx`), conéctate a esa red y la IP será `192.168.1.1` o `192.168.4.1`.
5. **Mira la lista DHCP del router** en `http://192.168.1.1` para ver todas las IP
   asignadas (incluida la MAC de la cámara) aunque no tenga puertos abiertos.
6. **Reservado el puerto RTSP a otro rango:** mira la app o el manual para el
   «puerto de medios» (a veces 10554).
7. **Contraseña cambiada:** la pusiste tú al configurarla en la app. Prueba
   `python3 camarita.py probe 192.168.1.26` editando `CREDENCIALES` en `camarita.py`.

### ¿Y si está en otra IP?

No hace falta adivinar: `python3 camarita.py scan` recorre las 254 direcciones y las
cruza con la tabla ARP. Si sospechas de otra subred (red de invitados, repetidor,
segundo router), pásasela: `python3 camarita.py scan 192.168.0` (o las que sean, separadas
por espacios). Y para confirmar cuál es cuál, `python3 camarita.py vigilar 192.168.1.26`
mientras desenchufas la cámara: si esa IP deja de responder, es ella.

La forma definitiva, sin adivinar: en la app **Cy365 → Ajustes del dispositivo →
Información del dispositivo** sale la IP y la MAC reales.

## 6. Tu caso: app **Cy365**

Cy365 / YCC365 es la app de estas cámaras con chip **PPPP (P2P)**. Consecuencias:

- La cámara **no abre puertos entrantes**: sale a internet y el vídeo va por *hole punching*.
  Por eso `192.168.1.26` responde a ping pero rechaza todo (es casi seguro tu cámara).
- Para verla por RTSP hay que **activar ONVIF/RTSP dentro de la app**:
  `Cy365 → Ajustes del dispositivo (⚙) → ONVIF` o `Configuración avanzada → RTSP / NVR`.
  Si esa opción no aparece, el firmware **no tiene RTSP** y solo se puede ver por la app
  (o por la nube del fabricante).
- Rutas/puerto típicos de YCC365 una vez activado:

  ```
  rtsp://admin:@192.168.1.26:554/h264_stream
  rtsp://admin:@192.168.1.26:5544/h264_stream
  rtsp://admin:@192.168.1.26:554/stream1
  rtsp://admin:123456@192.168.1.26:554/h264_stream
  ```

  (usuario `admin`, contraseña vacía o `123456`; la contraseña real es la que pusiste
  al emparejar la cámara en la app).

**Comprobación rápida de que `.26` es la cámara:** en la app, `Ajustes del dispositivo →
Información del dispositivo` muestra la IP y la MAC. Si dice `192.168.1.26`, es ella.
(Confirmado el 3 nov 2026: al desenchufarla, `192.168.1.26` dejó de responder.)

### Vías reales para verla en el Mac (ordenadas por esfuerzo)
| Vía | Requisito | Estado |
|---|---|---|
| **1. Activar ONVIF/RTSP en la app** | que la app/firmware tenga esa opción | pendiente de comprobar |
| **2. Espejo del móvil** (iPhone + QuickTime, o Android + `scrcpy`) | cable USB | funciona ya, sin tocar la cámara |
| **3. Emulador Android** (BlueStacks / Android Studio) con la APK de CY365 | instalar emulador | funciona, más pesado |
| **4. Cliente PPPP open-source** (`aiopppp`) | cámara con **UDP 32108** abierto | **descartado**: cerrado en tu cámara |

Experimento del 3 nov 2026: se monitorizaron todos los puertos de `192.168.1.26`
(incluido barrido completo 1–10000) durante 3 minutos **con la app CY365 transmitiendo
en vivo**: no se abrió ni un solo puerto. La cámara es 100 % saliente hacia su nube.

Sobre la vía 2: con un **iPhone** no hace falta instalar nada —
`QuickTime Player → Archivo → Nueva grabación de película →` elige el iPhone como
cámara y fuente de audio. Se ve la pantalla del móvil (y por tanto la app CY365) en el Mac.
Con **Android**: `brew install scrcpy` y `scrcpy --video-codec=h264`.

Sobre la vía 4: `aiopppp` funciona con cámaras A9/X5 (prefijos DGOK, PTZA, BATE…).
Tu cámara no expone UDP 32108 ni 20190, así que usa otro P2P propietario y **no** sirve.

### ✅ Solución que funciona (3 nov 2026)

El cliente del repo funciona, pero con **dos correcciones**:

1. **Cierra la app CY365 en el móvil.** Si la app está abierta (aunque no la estés
   mirando), la cámara no acepta el descubrimiento LAN. Al cerrarla, contesta al
   `LanSearch` en menos de un segundo.
2. **No mandar `check_user`.** En esta unidad (firmware `CYCAM T99 v32 0226`),
   el paquete `check_user` hace que la cámara cierre la sesión
   (`0xf0 Close`) a los ~4 s y no llegue ni un frame. Mandando **solo**
   `{"pro":"stream","cmd":111,...}` el vídeo fluye a 640×480 MJPEG, ~10 fps.

Uso:

```bash
cd camarita_espia
./ver_en_vlc.sh            # arranca el cliente y abre VLC
```

Parches aplicados en `CY365-wifi-camera-reverse-engineering/cy365-mjpeg.js`:

| cambio | motivo |
|---|---|
| `check_user` solo con `--with-check` | ese paquete provoca `0xf0 Close` |
| impresión cruda del canal 0 | para depurar respuestas del firmware |
| flags `--devmac`, `--video`, `--camsmode`, `--fmt`, `--onlycheck`, `--onlystream`, `--nocontrol` | experimentos |

Verificado: `/snapshot` → HTTP 200, JPEG 640×480 de ~13 KB; VLC reproduce
`http://localhost:8091/stream` con cientos de frames sin cortes.

### Historial: los dos falsos diagnósticos

Antes de dar con ello, el mismo cliente parecía no funcionar. Se clonó y se ejecutó
(`./run-cy365.sh`, con el DID real de la app, y la app CY365 transmitiendo en vivo
en el móvil). Resultado de aquella primera tanda:

| prueba | resultado |
|---|---|
| cliente arranca y sirve la web | ✅ `GET /` → HTTP 200 |
| frames de vídeo | ❌ `/snapshot` → HTTP 503 |
| `LanSearch` enviados | 100+ por intento (broadcast, broadcast de subred y unicast) |
| respuestas de la cámara | **0** |
| UDP 32108 (también 32100, 20190, 8800, 34567) | **ICMP port unreachable** = nadie escucha |

Datos que sí eran correctos y sirven de referencia:

- El `LanSearch` **no lleva DID** (`pkt(T.LanSearch)` va con payload vacío); el DID solo se
  usa en `PunchPkt`/`P2pRdy`, **después** de que la cámara conteste. Por eso un DID
  equivocado no puede explicar el silencio.
- `ICMP port unreachable` (y no timeout) significa que el paquete **sí llega** a la pila IP
  de la cámara y que **no hay ningún socket escuchando**. No es un firewall.
- La cámara no abre **ni un solo puerto** mientras transmite: el port-monitor no vio nada.
  Por eso RTSP, ONVIF y `aiopppp` están muertos: no hay servidor al que conectarse.

**Conclusión corregida:** el silencio del `LanSearch` era **la app CY365 abierta**,
que se queda la cámara y le impide atender el descubrimiento LAN. Al cerrarla, la
cámara hace `0x41` (punch) en menos de un segundo. Y el segundo fallo —`0xf0 Close` a
los 4 s— era el `check_user`. Con la app cerrada y sin `check_user`, el stream es
estable indefinidamente.

---

## 7. Servidor en ZimaOS (Docker) y ver desde fuera

### El requisito que manda: `network_mode: host`

La cámara **no escucha** en ningún puerto: busca al cliente y le "puncha" de vuelta
al puerto UDP efímero desde el que salió el `LanSearch`. Eso rompe dos cosas de
Docker por defecto:

1. el broadcast (`255.255.255.255` y `192.168.1.255:32108`) no sale de una red bridge;
2. el punch de vuelta llegaría a un puerto que el contenedor no publica.

Por eso el `docker-compose.yml` usa `network_mode: host`. En Linux (ZimaOS) funciona
tal cual; en Docker Desktop de macOS **no** (ahí usa `./ver_en_vlc.sh`).

### Arranque en el NAS

```bash
# en el ZimaOS, por SSH, dentro de la carpeta del proyecto
cp .env.example .env
vi .env                 # CY365_DID, CY365_PASSWORD, CY365_CAM_IP, CY365_AUTH
docker compose up -d --build
docker compose logs -f  # hasta ver "[SESSION] up" y frames
```

Luego `http://192.168.1.2:8091/` desde la LAN (VLC o navegador).
`restart: unless-stopped` + el watchdog del cliente hacen el resto: si la cámara
duerme y despierta, se reengancha sola sin tocar nada.

### Parámetros (todo por `.env`)

| variable | obligatoria | por defecto |
|---|---|---|
| `CY365_DID` | **sí** | — |
| `CY365_PASSWORD` | no | `6666` |
| `CY365_USER` | no | `admin` |
| `CY365_CAM_IP` | no | descubrir por broadcast |
| `CY365_HTTP_PORT` | no | `8091` |
| `CY365_AUTH` | no (pero recomendada) | sin auth |
| `CY365_DEBUG` | no | apagado |

**El DID no es automatizable.** Se probó con `--did EEE-111111-AAAAA`: la cámara
hace el `0x41` pero ignora nuestro `P2pRdy` (no valida el bloque), así que no hay
sesión y no hay frames. El DID va dentro del handshake; hay que sacarlo de la app.

### Acceso desde fuera de la casa

Recomendado: **Tailscale**, que ya tienes en el Mac. Instálalo en el ZimaOS
(app store o `curl -fsSL https://tailscale.com/install.sh | sh`), y desde cualquier
lugar entras a `http://<ip-tailscale-del-nas>:8091/stream`. Sin abrir puertos en el
router y sin exponer la cámara a internet.

Si prefieres no usar Tailscale: Cloudflare Tunnel (app de la tienda de ZimaOS) o
WireGuard en el router. **Evita** el port forwarding directo: el stream MJPEG no
tiene autenticación salvo la que actives con `CY365_AUTH`, y va en HTTP plano.

### Límites reales (importante)

- **Una sola sesión con la cámara.** Mientras el contenedor transmite, la app CY365
  del móvil no ve nada (y al revés). Si quieres conservar la app para la familia,
  el contenedor no puede estar siempre conectado.
- **La cámara duerme.** Es de batería: si está dormida no contesta al `LanSearch`
  (comprobado: 60 s de sondeo sin respuesta hasta que la despierta la app o el PIR).
  El contenedor no la despierta; se engancha cuando ella despierta.
- **640×480 a ~10 fps**, MJPEG. No esperes RTSP ni 1080p: este firmware no los da.
- **Batería**: dejarla transmitiendo 24/7 se la come. Para uso continuo, mejor
  alimentarla por USB.

---

## Licencia y créditos

El cliente (`client/cy365-mjpeg.js`) es de
[26medias/CY365-wifi-camera-reverse-engineering](https://github.com/26medias/CY365-wifi-camera-reverse-engineering),
MIT © Julien Loutre, con los parches descritos en `client/UPSTREAM.md`.
El resto del proyecto va bajo MIT (ver `LICENSE`).

Los DID, contraseñas, IPs y MACs de este documento son de ejemplo; los reales
viven en `.env`, que no se versiona.
