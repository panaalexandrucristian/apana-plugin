---
name: android-ui-step
description: "When you drive an Android emulator or device from the shell (open an app screen, tap a tab or button, check what a screen shows) with the `android` CLI or `adb`: use this skill's ui-step.mjs. ONE command taps a label, waits until the screen stops changing and prints a short one-line-per-element digest of the new screen, instead of `adb shell input tap` + sleep + `android layout` + `android screen capture` (3-4 commands and the whole raw layout JSON). Load it together with android-cli whenever you are about to run `android layout`, `android screen capture` or `adb shell input tap`."
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/ui-step.mjs *)
---

# android-ui-step

One navigation step per command on a running Android emulator or device. Needs node and the `android` CLI (and `adb`) on the PATH. Answer in the user's language.

    node ${CLAUDE_SKILL_DIR}/scripts/ui-step.mjs --tap "<label>" [--region top|bottom]

Write every command in full as one plain command with literal paths: no `$VAR` (not even `$TMPDIR`), no `$(...)`, no `;`, no `&&`. A pipe into `head` or `grep` is fine. Such a command matches the allowed-tools rule above and runs without a permission prompt; a command with a variable does not.

- `--tap "<label>"`: taps the element whose text or content description is exactly `<label>`, written as the visible text (`Deals`, not `Deals tab`). `--region top` (y < 500) or `--region bottom` (y > 2100) picks one when the same label appears in several places (a tab bar and a card). Two different elements with the label and no `--region` is refused (exit 3).
- `--back` presses Back. `--swipe` scrolls once. No action: reads the current screen.
- `--shot <file>.jpg` (a literal path, for example in the session scratchpad directory) also saves a 540 px JPEG of the screen; Read it only when you need to see the screen. The shrinking needs macOS (`sips`); elsewhere the command says so and keeps the full-size PNG. Always add it when the question is how something LOOKS (a progress bar, a colour, a check mark, which of two overlapping cards is visible): the digest lists elements that are in the layout but not visible (an adjacent pager page, a covered card layer).
- `--serial <id>` for a device other than `emulator-5554`. `--safe` is a read-only mode written for the Dollar General QA app: it taps only the bottom tabs (Home, Deals, myDG Wallet, List, Cart) and the Deals sub-tabs (Coupons & Cash Back, Weekly Ads, Rewards, Rebates), refuses labels such as Activate, Add, Redeem, Send and Delete, and stops on a login, verify or error screen; any other label is refused (exit 3). Add it only when the user asked for a read-only check of that app.

The output is `ui-step: <action>; settled (N layout reads)` followed by the digest, one line per element: `Class | label | center x,y | actions`. Pipe it through `grep` for the value you need. Exit 0 = done; 3 = stopped (label not found, ambiguous, or `--safe` refusal): read the message, then fix the label or `--region`, do not retry the same command; 2 = bad arguments.

Not covered: typing text (`adb shell input text`), installing or starting an app, starting the emulator (use the android-cli skill for those). Taps that change the account (Activate, Clip, Redeem, Send, Checkout) are the user's decision, not a navigation step.
