# Runs the OpenCode terminal UI inside a pseudo-terminal against the local stand-in provider (no model, no credentials).
# Usage: tui-driver.py <unused> <workspace> <session root> <prompt>. Types the prompt, presses Enter, waits until the stub has logged
# two requests (the main one and the title one) or 90 s, then quits. Called by tui.mjs, which prepares the isolated folders and the stub.
import json, os, pty, select, signal, subprocess, sys, time

root, ws, cfgroot = sys.argv[1], sys.argv[2], sys.argv[3]
prompt = sys.argv[4]
log = os.path.join(cfgroot, "requests.jsonl")
env = {k: os.environ[k] for k in ("PATH", "HOME") if k in os.environ}
env.update({"XDG_CONFIG_HOME": cfgroot + "/config", "XDG_DATA_HOME": cfgroot + "/data", "XDG_CACHE_HOME": cfgroot + "/cache", "XDG_STATE_HOME": cfgroot + "/state", "TMPDIR": cfgroot + "/tmp", "TERM": "xterm-256color", "COLUMNS": "120", "LINES": "40"})
pid, fd = pty.fork()
if pid == 0:
    os.chdir(ws)
    os.execvpe("opencode", ["opencode", "--standalone"], env)
import fcntl, struct, termios
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
buf = b""
def pump(seconds):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            buf += data
    return True
def seen_requests():
    try:
        return sum(1 for line in open(log) if line.strip())
    except OSError:
        return 0
pump(12)                      # let the UI and the server start
os.write(fd, prompt.encode() + b"\r")
deadline = time.time() + 90
while time.time() < deadline and seen_requests() < 2:
    pump(1)
pump(4)
try:
    os.write(fd, b"\x03"); pump(1); os.write(fd, b"\x03")
except OSError:
    pass
pump(2)
try:
    os.killpg(os.getpgid(pid), signal.SIGKILL)
except Exception:
    pass
print("requests seen by the stub:", seen_requests())
open(os.path.join(cfgroot, "tui-screen.txt"), "wb").write(buf[-6000:])
