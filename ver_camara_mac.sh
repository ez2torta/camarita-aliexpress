#!/usr/bin/env bash
# ver_camara_mac.sh — muestra la app CY365 (u otra) del Android en el Mac via scrcpy.
#
# Uso:
#   ./ver_camara_mac.sh            # espeja la pantalla tal cual
#   ./ver_camara_mac.sh cy365      # ademas abre la app CY365 automaticamente
#
# Requisitos en el movil (una sola vez):
#   1. Ajustes -> Informacion del telefono -> toca "Numero de compilacion" 7 veces
#   2. Ajustes -> Opciones de desarrollador -> activa "Depuracion USB"
#   3. Conecta el cable y acepta el aviso "Permitir depuracion USB" en el telefono
set -euo pipefail

APP_PKG="shix.cy.camera"

if ! command -v scrcpy >/dev/null; then
  echo "Falta scrcpy. Instalalo con:  brew install scrcpy" >&2
  exit 1
fi
if ! command -v adb >/dev/null; then
  echo "Falta adb. Instalalo con:  brew install --cask android-platform-tools" >&2
  exit 1
fi

adb start-server >/dev/null 2>&1 || true
DISPOSITIVOS=$(adb devices | tail -n +2 | grep -c "device$" || true)
if [ "$DISPOSITIVOS" -eq 0 ]; then
  echo "No hay ningun Android conectado." >&2
  echo "  1) Conecta el cable USB y elige 'Transferir archivos' o 'Cargar'" >&2
  echo "  2) Acepta el dialogo 'Permitir depuracion USB' en el telefono" >&2
  echo "  3) Vuelve a ejecutar este script" >&2
  adb devices
  exit 1
fi

if [ "${1:-}" = "cy365" ]; then
  echo "Abriendo $APP_PKG ..."
  adb shell monkey -p "$APP_PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || \
    echo "  (no pude abrirla sola: abrela a mano en el telefono)"
fi

echo "Espejando pantalla a 1600 px. Cierra la ventana o pulsa Ctrl+C para terminar."
exec scrcpy \
  --max-size=1600 \
  --max-fps=30 \
  --video-codec=h264 \
  --window-title="Camara CY365" \
  --stay-awake \
  --no-audio
