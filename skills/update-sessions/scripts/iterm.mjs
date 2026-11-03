// The only part of update-sessions that touches the terminal: AppleScript calls to iTerm2. The tty and the text go in as arguments of the script, never inside its text,
// and every script first asks whether iTerm2 is running, so that a call never launches it.
import { spawnSync } from "node:child_process";

export class ItermError extends Error {}

const RUNNING = 'if not (application "iTerm2" is running) then error "iTerm2 is not running"';
const EACH_SESSION = (body) => `
on run argv
  ${RUNNING}
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
${body}
        end repeat
      end repeat
    end repeat
  end tell
  error "no iTerm2 session on " & (item 1 of argv)
end run`;

const LIST = `
on run argv
  ${RUNNING}
  set sep to ASCII character 9 -- not the word tab: inside the tell below it names the iTerm2 class
  set out to ""
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          set out to out & (tty of s) & sep & (name of s) & linefeed
        end repeat
      end repeat
    end repeat
  end tell
  return out
end run`;
const READ = EACH_SESSION("          if (tty of s) is (item 1 of argv) then return contents of s");
const WRITE = EACH_SESSION(`          if (tty of s) is (item 1 of argv) then
            tell s to write text (item 2 of argv)
            return "ok"
          end if`);

/** `run(args)` runs osascript with args and returns { status, stdout, stderr }; a failure becomes an ItermError that says what to do when it is the Automation permission. */
export function createIterm(run) {
  const call = (script, ...args) => {
    const r = run(["-e", script, ...args]);
    if (r.status === 0) return String(r.stdout ?? "").replace(/\r\n?/g, "\n");
    const message = String(r.stderr ?? "").trim() || "osascript failed";
    if (/-1743|not authori[sz]ed to send apple events/i.test(message)) {
      throw new ItermError("macOS did not allow this program to control iTerm2: open System Settings, Privacy & Security, Automation, allow the app that runs claude to control iTerm2, then run the command again");
    }
    throw new ItermError(message);
  };
  return {
    /** [{ tty, name }] of every iTerm2 session. */
    sessions: () => call(LIST).split("\n").filter(Boolean).map((row) => { const tab = row.indexOf("\t"); return { tty: row.slice(0, tab), name: row.slice(tab + 1) }; }),
    /** The whole text of the session on `tty`, scrollback included. */
    read: (tty) => call(READ, tty),
    /** Types `text` and Return into the session on `tty`. */
    write: (tty, text) => { call(WRITE, tty, text); },
  };
}

export const runOsascript = (args) => spawnSync("osascript", args, { encoding: "utf8", timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
