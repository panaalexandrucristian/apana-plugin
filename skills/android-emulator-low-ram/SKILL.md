---
name: android-emulator-low-ram
description: "Use when an Android Emulator causes RAM pressure, swapping or slow builds, or before creating/tuning an AVD to use less memory. On macOS: emulator consumes RAM, qemu-system-aarch64, Apple Silicon, low-RAM AVD. Measure host footprint and guest memory first; keep a Google Play AVD for Chrome, login, Billing and Play Store flows."
---
# android-emulator-low-ram

Tune Android Emulator memory without silently changing what the test proves. Answer in the user's language. This skill is macOS-first, but its scripts gather safe metrics on Linux too.

## First: define the test lane

Pick the leanest image that still covers the requested behavior:

- **AOSP ATD**: instrumentation and app logic only. Google documents reduced CPU/RAM: ATDs remove apps, disable background services and hardware rendering. Do not use for browser, SystemUI, camera, graphics, Google account or Play Store flows.
- **Google ATD**: instrumentation that needs Play services, still not realistic UI/browser coverage.
- **Google APIs**: Maps, FCM or Google Sign-In when Chrome/Play Store are not required.
- **Google Play**: Chrome Custom Tabs, real login, Billing, Play Store, Google account or production-like visual coverage. Keep one stock AVD for this even if it costs more RAM.

Do not change an AVD configuration while qemu is running. Never type credentials, a password, payment details or 2FA; stop for the user at login.

## Measure before and after

Wait 60 seconds after boot at the same idle screen, then run:

    bash ${CLAUDE_SKILL_DIR}/scripts/measure-memory.sh emulator-5554

Record the AVD, system image, emulator version, launch flags, qemu RSS/footprint, guest `MemTotal`, `MemAvailable`, swap and the highest guest PSS processes. Run the same measurement after every individual change. qemu RSS and guest PSS are different accounting systems; do not add them.

On macOS, `footprint -p <qemu-pid>` and `vmmap -summary <qemu-pid>` are stronger signals than RSS alone. `dumpsys meminfo` PSS attributes shared guest memory better than summing RSS values.

## Apply only measured reductions

1. **Prefer a separate lean AVD**, never mutate the only user-login/Play Store device. A smaller profile/resolution may reduce display buffers but Android does not promise a host-RAM saving: prove it.
2. **Set guest RAM at launch**; `-memory <MB>` overrides AVD settings. Start interactive Google Play tests at 2048 MB and lower by 256 MB only after a boot and smoke test. The documented supported floor is 1536 MB, but images can enforce more: API 26+ can impose a floor, Android Q can require 2 GB, and API 37 phone AVDs require 4 GB. Always verify the running guest `MemTotal`; a value in `config.ini` is not proof it applied.
3. **Use accelerated graphics first.** `-gpu auto` is the baseline; test `-gpu host` only if it is stable and lowers measured pressure. Do not assume software graphics (`software`, `lavapipe`, `swiftshader`, `swangle`) saves memory.
4. **Remove nonessential runtime work only if coverage allows it:** `-no-audio`, `-no-boot-anim`, and `-no-window` (headless CI only). These controls do not have a documented material steady-state RAM saving, so keep them only when measured.
5. **Snapshots improve startup, not steady-state RAM.** Snapshot load/save can spike memory. Use `-no-snapshot` for disposable cold-boot tests, or `-no-snapshot-save` to load an existing snapshot without saving a new state. Do not claim either reduces qemu RAM unless the before/after measurement says so.
6. **Treat `-lowram` as an experiment.** It changes Android low-RAM behavior and can change process management/features; use it only for an explicitly low-RAM-device test, never to validate a normal-device UX.

Start a disposable low-RAM AVD with:

    bash ${CLAUDE_SKILL_DIR}/scripts/start-low-ram.sh <AVD-name> 1536 disposable

The third argument is `quick`, `no-save` or `disposable`. The script uses `-gpu auto`, `-no-audio` and `-no-boot-anim`; it does not edit any AVD file. Add `HEADLESS=1` only for non-visual CI. Use `LOWRAM=1` only after the user has explicitly asked to test the low-RAM-device behavior.

## Package pruning: disposable AVD only

First identify actual consumers:

    adb -s emulator-5554 shell 'dumpsys meminfo; pm list packages -3; pm list packages -s -e'

Disable one optional package at a time, measure again and record the rollback:

    adb -s emulator-5554 shell 'pm disable-user --user 0 <package>'
    adb -s emulator-5554 shell 'pm enable --user 0 <package>'

Potential candidates depend on the image and test: Photos, Messaging, Dialer, TTS or a search app. Do **not** disable Chrome, WebView, Gboard/IME, Google Play services, Play Store, account/auth providers, SystemUI, Launcher, Settings, package installer or network components when the flow can use them. Package disabling persists in AVD userdata until re-enabled or wiped.

Stop and roll back on a failed boot, account/login, FCM, Maps, Billing, WebView, permission/system-dialog or required UI test.

## Verify and report

Keep a change only when all are true:

- same boot mode, image, idle delay and smoke test show materially lower host footprint/RSS;
- guest `MemAvailable` and PSS show no new pressure;
- requested integration/UI coverage passes;
- the exact rollback is documented.

Report measured values with their sample size `n`, the image/flags used, coverage intentionally omitted, and anything not verified.

## Sources

- Android Emulator command-line options: https://developer.android.com/studio/run/emulator-commandline
- AVD/image configuration: https://developer.android.com/studio/run/managing-avds
- Snapshot behavior: https://developer.android.com/studio/run/emulator-snapshots
- Emulator RAM floors and release notes: https://developer.android.com/studio/releases/emulator
- Automated Test Devices: https://developer.android.com/studio/test/managed-devices
