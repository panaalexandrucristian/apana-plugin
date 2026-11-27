"""Cold-boot a disposable test AVD without loading or saving snapshots."""

import argparse
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time


def available_port():
    for port in range(5554, 5683, 2):
        try:
            with socket.socket() as console, socket.socket() as transport:
                console.bind(("127.0.0.1", port))
                transport.bind(("127.0.0.1", port + 1))
                return port
        except OSError:
            continue
    raise SystemExit("No free emulator console and ADB port pair")


def wait_for_boot(process, adb, serial, timeout):
    deadline = time.monotonic() + timeout
    while process.poll() is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        try:
            result = subprocess.run(
                [adb, "-s", serial, "shell", "getprop", "sys.boot_completed"],
                capture_output=True, text=True, timeout=min(4, remaining),
            )
            if result.returncode == 0 and result.stdout.strip() == "1":
                return process.poll() is None
        except subprocess.TimeoutExpired:
            pass
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    return False


def stop(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def handle_termination(signum, _frame):
    raise SystemExit(128 + signum)


def print_startup_log(log, booted):
    markers = ("android emulator version", "graphics backend", "graphics api version",
               "gpu mode", "gpu emulation", "gpu vendor", "gpu renderer", "gpu version",
               "using vulkan externalmemorymode", "hypervisor.framework")
    diagnostic_levels = {"warning", "error", "fatal"}
    diagnostics = []
    for line in log:
        normalized = line.lower().removeprefix("emulator: ")
        level, separator, message = normalized.partition("|")
        if not separator:
            level, _, _ = normalized.partition(":")
            message = normalized
        if message.lstrip().startswith(markers):
            print(line.rstrip())
        elif not booted and level.strip() in diagnostic_levels:
            diagnostics.append(line.rstrip())
    for line in diagnostics[-20:]:
        print(line)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", type=Path, required=True, help="Android SDK path")
    parser.add_argument("--avd", required=True, help="Disposable test AVD name")
    parser.add_argument("--gpu", help="Optional emulator renderer override, e.g. host")
    parser.add_argument("--timeout", type=int, default=90, help="Boot deadline in seconds")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")

    sdk = args.sdk.expanduser().resolve()
    emulator = sdk / "emulator" / "emulator"
    adb = sdk / "platform-tools" / "adb"
    for binary in (emulator, adb):
        if not binary.is_file():
            parser.error(f"missing SDK binary: {binary}")

    subprocess.run([adb, "start-server"], check=True, timeout=10)
    port = available_port()
    serial = f"emulator-{port}"
    cmd = [emulator, "-avd", args.avd, "-port", str(port), "-read-only",
           "-no-snapshot", "-no-window"]
    if args.gpu:
        cmd.extend(["-gpu", args.gpu])

    signal.signal(signal.SIGTERM, handle_termination)
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT)
        try:
            booted = wait_for_boot(process, adb, serial, args.timeout)
            exit_code = process.poll()
        finally:
            stop(process)

        log.seek(0)
        print_startup_log(
            (line.decode(errors="replace") for line in log), booted,
        )

    if not booted:
        reason = f"process exited with code {exit_code}" if exit_code is not None else "boot timed out"
        raise SystemExit(f"{args.avd}: {reason} before sys.boot_completed=1")

    print(f"{args.avd}: sys.boot_completed=1; smoke-test instance stopped")


if __name__ == "__main__":
    main()
