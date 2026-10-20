#!/usr/bin/env bash
# Start an AVD with a measured, disposable low-RAM configuration.
set -euo pipefail

AVD="${1:?usage: start-low-ram.sh <AVD-name> [RAM_MB] [quick|no-save|disposable]}"
RAM_MB="${2:-1536}"
SNAPSHOT_MODE="${3:-quick}"
SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
EMULATOR="${EMULATOR:-$SDK_ROOT/emulator/emulator}"
HEADLESS="${HEADLESS:-0}"
LOWRAM="${LOWRAM:-0}"

[[ -x "$EMULATOR" ]] || { echo "emulator not found: $EMULATOR" >&2; exit 2; }
args=(-avd "$AVD" -memory "$RAM_MB" -gpu auto -no-audio -no-boot-anim)
case "$SNAPSHOT_MODE" in
  quick) ;;
  no-save) args+=(-no-snapshot-save) ;;
  disposable) args+=(-no-snapshot) ;;
  *) echo "snapshot mode must be quick, no-save or disposable" >&2; exit 2 ;;
esac
[[ "$HEADLESS" == 1 ]] && args+=(-no-window)
[[ "$LOWRAM" == 1 ]] && args+=(-lowram)

echo "Starting $AVD: RAM=${RAM_MB}MB snapshot=$SNAPSHOT_MODE headless=$HEADLESS lowram=$LOWRAM"
exec "$EMULATOR" "${args[@]}"
