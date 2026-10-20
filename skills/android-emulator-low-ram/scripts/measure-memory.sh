#!/usr/bin/env bash
# Read-only host and guest memory snapshot for Android Emulator.
set -euo pipefail

SERIAL="${1:-emulator-5554}"
SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ADB="${ADB:-$SDK_ROOT/platform-tools/adb}"
if [[ ! -x "$ADB" ]]; then ADB="$(command -v adb || true)"; fi
if [[ -z "$ADB" || ! -x "$ADB" ]]; then
  echo "adb was not found; set ADB, ANDROID_HOME or ANDROID_SDK_ROOT." >&2
  exit 2
fi

echo "== host =="
uname -a
if command -v sysctl >/dev/null 2>&1; then
  printf 'physical-memory-bytes: '
  sysctl -n hw.memsize 2>/dev/null || true
fi
if command -v vm_stat >/dev/null 2>&1; then
  vm_stat | awk '/Pages free|Pages active|Pages inactive|Pages purgeable|Pages wired down/{print}'
fi

echo "== emulator processes =="
pids="$(pgrep -f 'qemu-system.*' || true)"
if [[ -z "$pids" ]]; then
  echo "no qemu-system process found"
else
  for pid in $pids; do
    ps -p "$pid" -o pid=,ppid=,rss=,vsz=,etime=,command=
    if command -v footprint >/dev/null 2>&1; then
      echo "-- footprint PID $pid --"
      footprint -p "$pid" 2>/dev/null | grep -i -E 'physical footprint|resident|dirty|compressed' || true
    fi
  done
fi

echo "== device $SERIAL =="
"$ADB" devices
if ! "$ADB" -s "$SERIAL" get-state >/dev/null 2>&1; then
  echo "$SERIAL is not online; guest metrics unavailable"
  exit 0
fi
"$ADB" -s "$SERIAL" shell 'getprop ro.build.version.sdk; getprop ro.product.cpu.abi; grep -E "Mem(Total|Available|Free)|Swap(Total|Free)|Zram" /proc/meminfo' | tr -d '\r'
echo "-- total PSS by process --"
"$ADB" -s "$SERIAL" shell dumpsys meminfo 2>/dev/null | sed -n '/Total PSS by process/,/^$/p' | head -30 | tr -d '\r'
