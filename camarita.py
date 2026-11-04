#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
camarita.py - Descubridor y conector RTSP para camaras IP baratas (CYCAM T99, V380, XMEye, etc.)

Uso:
    python3 camarita.py scan                  # busca camaras en la red local
    python3 camarita.py scan 192.168.0 10.0.0  # varias subredes a la vez
    python3 camarita.py probe 192.168.0.26    # prueba rutas y credenciales en una IP
    python3 camarita.py auto                  # scan + probe + abre VLC si encuentra algo
    python3 camarita.py esperar 192.168.0.26  # reintenta hasta que aparezca el RTSP
    python3 camarita.py vigilar 192.168.0.26  # ver si una IP responde (para identificarla)
    python3 camarita.py puertos 192.168.0.26  # ver si la camara abre algun puerto
    python3 camarita.py open "rtsp://..."     # abre una URL concreta en VLC
    python3 camarita.py foto "rtsp://..." f.jpg   # guarda un frame de prueba

Solo usa la libreria estandar de Python 3 y (opcionalmente) ffmpeg/VLC para reproducir.
"""

import base64
import hashlib
import os
import re
import socket
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

# ----------------------------------------------------------------------------
# Configuracion: rutas y credenciales tipicas de camaras genericas
# ----------------------------------------------------------------------------
RUTAS = [
    # CYCAM / T99 / ONVIF genericas
    "/live/0/onvif.sdp",
    "/live/1/onvif.sdp",
    "/live/0/h264.sdp",
    "/live/1/h264.sdp",
    "/live/0/mpeg4.sdp",
    "/onvif.sdp",
    "/onvif1",
    "/onvif2",
    # Cy365 / YCC365 (PPPP) - las mas probables en este caso
    "/h264_stream",
    "/h264_stream2",
    "/mjpeg_stream",
    "/stream=0",
    "/stream=1",
    # XMEye / Xiongmai (las mas comunes en camaras baratas)
    "/cam/realmonitor?channel=1&subtype=0",
    "/cam/realmonitor?channel=1&subtype=1",
    # V380 / Vstarcam
    "/live/ch0",
    "/live/ch1",
    "/video1",
    "/video2",
    "/11",
    "/12",
    # Hikvision / Dahua / TP-Link / genericas
    "/Streaming/Channels/101",
    "/h264/ch1/main/av_stream",
    "/stream1",
    "/stream2",
    "/live.sdp",
    "/live0.264",
    "/av0_0",
    "/mpeg4",
    "/h264",
]

CREDENCIALES = [
    "admin:admin",
    "admin:",
    "admin:1212",
    "admin:1313",
    "admin:12345",
    "admin:123456",
    "admin:888888",
    "admin:admin123",
    "root:",
    "root:root",
    "888888:888888",
]

PUERTOS_RTSP = [554, 5544, 8554, 10554]
PUERTOS_WEB = [80, 8080, 8000, 8008, 88, 8899, 5000]
PUERTOS_APP = [34567, 37777, 8800]  # XMEye / Dahua / V380

VLC = "/Applications/VLC.app/Contents/MacOS/VLC"


# ----------------------------------------------------------------------------
# Utilidades de red
# ----------------------------------------------------------------------------
def ip_local():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def puerto_abierto(ip, puerto, timeout=0.4):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        return s.connect_ex((ip, puerto)) == 0
    finally:
        s.close()


def onvif_discovery(timeout=4):
    """WS-Discovery: las camaras ONVIF contestan con su IP real y sus servicios."""
    msg = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" '
        'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" '
        'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" '
        'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
        "<e:Header><w:MessageID>uuid:%s</w:MessageID>"
        "<w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>"
        "<w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>"
        "</e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types>"
        "</d:Probe></e:Body></e:Envelope>" % uuid.uuid4()
    )
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    s.settimeout(1)
    s.sendto(msg.encode(), ("239.255.255.250", 3702))
    encontrados = {}
    fin = time.time() + timeout
    while time.time() < fin:
        try:
            data, addr = s.recvfrom(65535)
        except socket.timeout:
            continue
        texto = data.decode("utf-8", "ignore")
        xaddr = re.search(r"<[^>]*XAddrs>([^<]+)<", texto)
        nombre = re.search(r"<[^>]*Scopes>([^<]+)<", texto)
        encontrados[addr[0]] = {
            "xaddr": xaddr.group(1) if xaddr else "",
            "scopes": (nombre.group(1) if nombre else "")[:160],
        }
    s.close()
    return encontrados


# ----------------------------------------------------------------------------
# Cliente RTSP minimo (DESCRIBE) con soporte Basic y Digest
# ----------------------------------------------------------------------------
def _md5(txt):
    return hashlib.md5(txt.encode()).hexdigest()


def _cabecera_auth(www, usuario, password, metodo, uri):
    """Construye la cabecera Authorization a partir del WWW-Authenticate."""
    if not www:
        return None
    esquema = www.split(" ", 1)[0].lower()
    if esquema == "basic":
        token = base64.b64encode(("%s:%s" % (usuario, password)).encode()).decode()
        return "Basic " + token
    if esquema == "digest":
        campos = dict(re.findall(r'(\w+)="?([^",]+)"?', www))
        realm = campos.get("realm", "")
        nonce = campos.get("nonce", "")
        qop = campos.get("qop", "")
        ha1 = _md5("%s:%s:%s" % (usuario, realm, password))
        ha2 = _md5("%s:%s" % (metodo, uri))
        if "auth" in qop:
            nc = "00000001"
            cnonce = uuid.uuid4().hex[:8]
            resp = _md5("%s:%s:%s:%s:%s:%s" % (ha1, nonce, nc, cnonce, "auth", ha2))
            return (
                'Digest username="%s", realm="%s", nonce="%s", uri="%s", '
                'response="%s", qop=auth, nc=%s, cnonce="%s"'
                % (usuario, realm, nonce, uri, resp, nc, cnonce)
            )
        resp = _md5("%s:%s:%s" % (ha1, nonce, ha2))
        return 'Digest username="%s", realm="%s", nonce="%s", uri="%s", response="%s"' % (
            usuario, realm, nonce, uri, resp
        )
    return None


def rtsp_describe(ip, puerto, ruta, usuario="", password="", timeout=2.5):
    """Devuelve (codigo, motivo, cabecera_www_authenticate)."""
    uri = "rtsp://%s:%d%s" % (ip, puerto, ruta)
    host = "%s:%d" % (ip, puerto)

    def peticion(auth=None):
        lineas = [
            "DESCRIBE %s RTSP/1.0" % uri,
            "CSeq: 1",
            "User-Agent: camarita/1.0",
            "Accept: application/sdp",
            "Require: implicit-play",
        ]
        if auth:
            lineas.append("Authorization: " + auth)
        crudo = "\r\n".join(lineas) + "\r\n\r\n"
        s = socket.socket()
        s.settimeout(timeout)
        try:
            s.connect((ip, puerto))
            s.sendall(crudo.encode())
            datos = s.recv(4096).decode("utf-8", "ignore")
        finally:
            s.close()
        codigo = 0
        m = re.match(r"RTSP/\d\.\d\s+(\d+)", datos)
        if m:
            codigo = int(m.group(1))
        www = ""
        m = re.search(r"(?im)^WWW-Authenticate:\s*(.+)$", datos)
        if m:
            www = m.group(1).strip()
        return codigo, datos, www

    codigo, datos, www = peticion()
    if codigo == 401 and usuario:
        auth = _cabecera_auth(www, usuario, password, "DESCRIBE", uri)
        if auth:
            codigo, datos, www = peticion(auth)
    motivo = ""
    m = re.match(r"RTSP/\d\.\d\s+\d+\s*(.*)", datos)
    if m:
        motivo = m.group(1).strip()
    return codigo, motivo, www


# ----------------------------------------------------------------------------
# Comandos
# ----------------------------------------------------------------------------
def hosts_vivos(base, timeout_ms=400):
    """Ping sweep + tabla ARP.

    La tabla ARP es la fuente fiable: un equipo puede bloquear ICMP (ping) y aun asi
    estar presente en la red; en ese caso aparece en ARP con su MAC.
    """
    def p(i):
        ip = "%s.%d" % (base, i)
        r = subprocess.run(["ping", "-c", "1", "-W", str(timeout_ms), ip],
                           capture_output=True)
        return ip if r.returncode == 0 else None

    vivos = []
    with ThreadPoolExecutor(max_workers=128) as ex:
        for r in ex.map(p, range(1, 255)):
            if r:
                vivos.append(r)

    # Sumar todo lo que tenga entrada ARP valida en esa subred (aunque no responda ping)
    for ip, mac in tabla_arp().items():
        if ip.startswith(base + ".") and mac and mac != "(incomplete)":
            if ip not in vivos:
                vivos.append(ip)
    return sorted(vivos, key=lambda x: int(x.split(".")[-1]))


def tabla_arp():
    salida = subprocess.run(["arp", "-an"], capture_output=True, text=True).stdout
    mapa = {}
    for linea in salida.splitlines():
        m = re.search(r"\(([\d.]+)\) at ([0-9a-f:]+)", linea)
        if m:
            mapa[m.group(1)] = m.group(2)
    return mapa


def cmd_scan(redes=None):
    ip = ip_local()
    if redes:
        bases = []
        for r in re.split(r"[,\s]+", redes.strip()):
            if not r:
                continue
            bases.append(".".join(r.split(".")[:3]) if r.count(".") >= 2 else r)
    else:
        bases = [".".join(ip.split(".")[:3])]

    print("Tu IP: %s" % ip)
    for b in bases:
        print("Subred a escanear: %s.0/24  (254 direcciones)" % b)

    print("\n[1/3] Buscando camaras ONVIF por multicast ...")
    onvif = onvif_discovery()
    if onvif:
        for host, info in onvif.items():
            print("   ONVIF: %s  %s" % (host, info["xaddr"]))
            print("          %s" % info["scopes"])
    else:
        print("   Ninguna camara respondio al descubrimiento ONVIF.")

    candidatos_totales = []
    for base in bases:
        print("\n[2/3] Equipos presentes en %s.0/24 (ping + tabla ARP) ..." % base)
        vivos = hosts_vivos(base)
        macs = tabla_arp()
        if not vivos:
            print("   Nada. Ni ping ni ARP devolvieron equipos en esta subred.")
        for h in vivos:
            mac = macs.get(h, "?")
            nota = ""
            if mac.lower().startswith("00:00:00"):
                nota = "  <-- MAC tipica de camara/embebido"
            print("   %-15s %-18s%s" % (h, mac, nota))

        print("\n[3/3] Puertos de camara y prueba RTSP ...")
        puertos = sorted(set(PUERTOS_RTSP + PUERTOS_WEB + PUERTOS_APP))

        def chk(t):
            h, p = t
            return (h, p) if puerto_abierto(h, p, 0.7) else None

        tareas = [(h, p) for h in vivos for p in puertos]
        encontrados = {}
        with ThreadPoolExecutor(max_workers=250) as ex:
            for r in ex.map(chk, tareas):
                if r:
                    encontrados.setdefault(r[0], []).append(r[1])

        if not encontrados:
            print("   Ningun equipo de esta subred tiene puertos de camara abiertos.")
        for h in sorted(encontrados, key=lambda x: int(x.split(".")[-1])):
            ps = sorted(encontrados[h])
            etiqueta = []
            if set(ps) & set(PUERTOS_RTSP):
                etiqueta.append("RTSP")
            if set(ps) & set(PUERTOS_APP):
                etiqueta.append("APP/P2P")
            if set(ps) & set(PUERTOS_WEB):
                etiqueta.append("web")
            print("   %-15s puertos %s   [%s]" % (h, ps, ",".join(etiqueta)))

        candidatos = [h for h, ps in encontrados.items() if set(ps) & set(PUERTOS_RTSP)]
        candidatos += [h for h in onvif if h not in candidatos]
        candidatos_totales += candidatos
        for h in candidatos:
            cmd_probe(h)

    candidatos_totales = list(dict.fromkeys(candidatos_totales))
    if not candidatos_totales:
        print("\nResumen: ninguna camara sirviendo RTSP en %s." %
              ", ".join("%s.0/24" % b for b in bases))
        print("Si la camara esta encendida y en la misma red, su firmware no publica RTSP")
        print("(tipico en PPPP/Cy365) hasta que lo actives en la app o use otro protocolo.")
    return candidatos_totales


def cmd_probe(ip, rutas=None, credenciales=None, silencioso=False):
    rutas = rutas or RUTAS
    credenciales = credenciales or CREDENCIALES
    hallados = []
    con_auth = []

    for puerto in PUERTOS_RTSP:
        if not puerto_abierto(ip, puerto, 0.8):
            continue
        if not silencioso:
            print("\n== Probando %s:%d" % (ip, puerto))
        for ruta in rutas:
            # Primero sin credenciales: si responde 200, la camara es abierta
            codigo, motivo, www = rtsp_describe(ip, puerto, ruta, "", "")
            if codigo == 200:
                url = "rtsp://%s:%d%s" % (ip, puerto, ruta)
                print("   OK  %s   (sin usuario)" % url)
                hallados.append(url)
                continue
            if codigo == 401:
                if ruta not in con_auth:
                    con_auth.append((ruta, www))
                for cred in credenciales:
                    usuario, _, password = cred.partition(":")
                    c2, m2, _ = rtsp_describe(ip, puerto, ruta, usuario, password)
                    if c2 == 200:
                        url = "rtsp://%s:%s@%s:%d%s" % (usuario, password, ip, puerto, ruta)
                        print("   OK  %s" % url)
                        hallados.append(url)
                        break

    if not silencioso and con_auth:
        print("\n   Rutas que existen (piden autenticacion):")
        for ruta, www in con_auth:
            esquema = www.split(" ", 1)[0] if www else "?"
            print("      %-45s auth=%s" % (ruta, esquema))
        print("   (existen, pero ninguna credencial de la lista funciono)")

    if not hallados:
        if not silencioso:
            print("\nNo encontre ninguna combinacion valida en %s." % ip)
            print("Prueba: activar ONVIF/RTSP en la app de la camara (Ajustes > ONVIF / RTSP / Modo PC).")
        return []
    if not silencioso:
        print("\nURLs que funcionan:")
        for u in hallados:
            print("   " + u)
    return hallados


def cmd_open(url):
    if not os.path.exists(VLC):
        print("No encuentro VLC en %s" % VLC)
        print("Instala VLC desde https://www.videolan.org o abre la URL manualmente.")
        return 1
    print("Abriendo en VLC: %s" % url)
    subprocess.Popen([VLC, "--rtsp-tcp", "--network-caching=800", url])
    return 0


def cmd_foto(url, destino="foto.jpg"):
    cmd = [
        "ffmpeg", "-y", "-rtsp_transport", "tcp", "-i", url,
        "-frames:v", "1", "-q:v", "2", destino,
    ]
    print(" ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode == 0:
        print("Guardado: %s" % destino)
        return 0
    print("Fallo:")
    print(r.stderr[-800:])
    return 1


def cmd_puertos(ip, segundos=180, intervalo=2):
    """Vigila que puertos se abren/cierran en la camara.

    Sirve para comprobar si la camara expone algo (RTSP, HTTP...) mientras la app
    esta viendo el video en vivo.
    """
    conocidos = sorted(set(PUERTOS_RTSP + PUERTOS_WEB + PUERTOS_APP +
                           [5000, 6668, 32108, 8800, 9000, 80, 8080, 8888]))
    print("Vigilando puertos de %s durante %d s. Abre la app CY365 y pon el video EN VIVO."
          % (ip, segundos))
    abiertos_prev = set()
    fin = time.time() + segundos
    vuelta = 0
    while time.time() < fin:
        vuelta += 1
        actuales = set(p for p in conocidos if puerto_abierto(ip, p, 0.5))
        for p in sorted(actuales - abiertos_prev):
            print("%s  ABRE  puerto %d" % (time.strftime("%H:%M:%S"), p))
        for p in sorted(abiertos_prev - actuales):
            print("%s  cierra puerto %d" % (time.strftime("%H:%M:%S"), p))
        abiertos_prev = actuales

        # Barrido amplio cada 15 s (por si usa un puerto raro)
        if vuelta % 8 == 1:
            def chk(p):
                return p if puerto_abierto(ip, p, 0.35) else None
            with ThreadPoolExecutor(max_workers=600) as ex:
                raros = [p for p in ex.map(chk, range(1, 10001))
                         if p and p not in conocidos]
            for p in raros:
                print("%s  ABRE  puerto %d (no habitual)" % (time.strftime("%H:%M:%S"), p))
                conocidos.append(p)
        time.sleep(intervalo)
    print("Fin del monitor. Puertos abiertos al terminar: %s" %
          (sorted(abiertos_prev) or "ninguno"))
    return 0


def cmd_vigilar(ip, intervalo=1.0):
    """Muestra si una IP responde, en tiempo real.

    Truco para identificar la camara: ejecuta esto y desenchufala. Si deja de responder
    justo cuando la apagas, esa IP es la camara.
    """
    print("Vigilando %s (Ctrl+C para salir)." % ip)
    print("Desenchufa la camara y observa: cuando pase a 'NO responde', es ella.\n")
    estado = None
    try:
        while True:
            vivo = subprocess.run(["ping", "-c", "1", "-W", "700", ip],
                                  capture_output=True).returncode == 0
            if vivo != estado:
                print("%s  %s" % (time.strftime("%H:%M:%S"),
                                  "RESPONDE" if vivo else "NO responde"))
                estado = vivo
            time.sleep(intervalo)
    except KeyboardInterrupt:
        print("\nfin")
    return 0


def cmd_esperar(ip, intervalo=10):
    """Reintenta hasta que actives ONVIF/RTSP en la app (Ctrl+C para salir)."""
    print("Vigilando %s cada %d s. Activa ONVIF/RTSP en la app Cy365..." % (ip, intervalo))
    print("(Ctrl+C para salir)\n")
    intento = 0
    while True:
        intento += 1
        urls = cmd_probe(ip, silencioso=True)
        if urls:
            print("\nEncontrado tras %d intentos:" % intento)
            for u in urls:
                print("   " + u)
            cmd_open(urls[0])
            return 0
        print("   intento %d: %s sin RTSP todavia" % (intento, ip))
        time.sleep(intervalo)


def cmd_auto():
    print("== 1. Escaneo de red ==")
    candidatos = cmd_scan()
    if not candidatos:
        return 1
    print("\n== 2. Prueba y apertura ==")
    for ip in candidatos:
        urls = cmd_probe(ip, silencioso=True)
        if urls:
            cmd_open(urls[0])
            return 0
    print("Ningun candidato acepto una combinacion de ruta/credenciales.")
    return 1


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 0
    cmd = sys.argv[1].lower()
    if cmd == "scan":
        cmd_scan(sys.argv[2] if len(sys.argv) > 2 else None)
    elif cmd == "probe":
        if len(sys.argv) < 3:
            print("Falta la IP. Ej: python3 camarita.py probe 192.168.0.26")
            return 1
        cmd_probe(sys.argv[2])
    elif cmd == "auto":
        cmd_auto()
    elif cmd == "esperar":
        return cmd_esperar(sys.argv[2] if len(sys.argv) > 2 else "192.168.0.26")
    elif cmd == "vigilar":
        return cmd_vigilar(sys.argv[2] if len(sys.argv) > 2 else "192.168.0.26")
    elif cmd == "puertos":
        return cmd_puertos(sys.argv[2] if len(sys.argv) > 2 else "192.168.0.26",
                           int(sys.argv[3]) if len(sys.argv) > 3 else 180)
    elif cmd == "open":
        if len(sys.argv) < 3:
            print('Falta la URL. Ej: python3 camarita.py open "rtsp://admin:admin@192.168.0.26:554/live/0/onvif.sdp"')
            return 1
        return cmd_open(sys.argv[2])
    elif cmd == "foto":
        if len(sys.argv) < 3:
            print("Falta la URL.")
            return 1
        return cmd_foto(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "foto.jpg")
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
