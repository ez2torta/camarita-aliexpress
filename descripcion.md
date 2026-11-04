en mi red tengo una camara de estas características. es probable que su ip sea 192.168.1.26 o algo similar.

Claro, te preparo un **prompt estructurado** para que puedas usarlo con un asistente de IA o una herramienta de configuración y obtener directamente la cadena de conexión RTSP para tu cámara **CYCAM T99 v32 0226**.

### 📝 Prompt para conexión directa

Puedes copiar y pegar el siguiente texto:

```text
Actúa como un ingeniero de redes especializado en cámaras IP genéricas.

Necesito establecer una conexión directa (RTSP) con una cámara de seguridad Wi-Fi de bajo costo. Los datos de identificación del firmware son:

- Rama/Familia: CYCAM
- Modelo de hardware/placa: T99
- Versión de firmware: v32
- Fecha de build: 0226 (26 de febrero)

Con esta información, proporcióname:

1. La URL RTSP completa y exacta (incluyendo usuario, contraseña, IP por defecto y puerto) para acceder al stream principal.
2. Las credenciales por defecto más probables (usuario/contraseña).
3. Las rutas RTSP alternativas que suelen usar las cámaras basadas en CYCAM (por ejemplo, variantes con /onvif.sdp, /h264.sdp, /mpeg4.sdp, etc.).
4. Los pasos básicos para descubrir la dirección IP real de la cámara en la red local (si no es la IP por defecto).
5. Cualquier consideración sobre el puerto RTSP (normalmente 554) y si el firmware v32 0226 requiere algún parámetro adicional en la URL.

Devuelve la respuesta en formato de lista clara, priorizando la URL que tenga mayor probabilidad de funcionar según el modelo T99.
```

### 🔍 Información clave que ya se conoce (para que contrastes)

Aunque el prompt está pensado para que la IA lo resuelva, los resultados de búsqueda ya arrojan pistas muy sólidas:

- La ruta RTSP más común para las cámaras CYCAM es **`/live/0/onvif.sdp`**.
- La URL típica de ejemplo es:  
  **`rtsp://admin:admin@192.168.1.188:554/live/0/onvif.sdp`**.
- Otra fuente confirma que el **puerto por defecto es 554** y la ruta suele ser `/live/0/onvif.sdp`.
- Como credenciales por defecto, se ha reportado **`admin`** (sin contraseña o con `admin`) y también contraseñas numéricas como **`1212`** o **`1313`** en algunos modelos genéricos.

Con el prompt anterior, la IA debería devolverte una URL como la siguiente (sustituyendo la IP por la que tenga tu cámara en tu red):

```
rtsp://admin:admin@192.168.1.188:554/live/0/onvif.sdp
```

Si al probar esa URL no funciona, el prompt también le pedirá que te dé **rutas alternativas** (por ejemplo, `/live/0/h264.sdp` o `/live_mpeg4.sdp`) para que puedas ir descartando hasta dar con la correcta.
