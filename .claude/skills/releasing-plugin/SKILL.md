---
name: releasing-plugin
description: Releases a new version of the apana plugin from this repository (version bump in 4 files, PRIVATE.md paragraph, release commit, tag, push and CI check). Use when the owner asks to release, ship, publish, tag or bump the version of the plugin, or says facem release.
---

# Releasing the apana plugin

Follow the steps in order. Push and tag only when the owner asked for a release or said to push; if they asked only to prepare or bump, stop after step 5 and ask.

1. **Fresh worktree from origin/main.** Never release from the main checkout: its local `main` may differ from `origin/main`.
   ```sh
   git fetch origin
   git worktree add -b release-X.Y.Z ../apana-plugin-relXYZ origin/main
   ```
   If the changes are commits made elsewhere, `git cherry-pick <sha> ...` them in the worktree. They must apply without a conflict; if not, stop and tell the owner.
2. **Version.** Read the current one with `grep '"version"' .claude-plugin/plugin.json`. The new one follows the owner's rule unless they named one: new functionality raises the minor number and sets the patch to 0 (`0.2.0` to `0.3.0`); a release that only fixes a bug raises the patch number (`0.2.0` to `0.2.1`). If a release has both, it counts as new functionality.
3. **Bump the same number in 4 files** (macOS `sed`; OLD is the current version with its dots escaped, for example `0\.1\.0`, and NEW the new one; the `grep -F` below takes OLD without the backslashes):
   ```sh
   sed -i '' 's/OLD/NEW/g' .claude-plugin/plugin.json .claude-plugin/marketplace.json \
     private/explica-clar/test/skill.test.mjs private/logic-test-debug/test/manifest.test.mjs
   grep -rnF OLD --include='*.mjs' --include='*.json' . | grep -v node_modules
   ```
   The grep must print nothing.
4. **`PRIVATE.md`.** (a) In the paragraph under `### Plugin version`, add the clause `` `X.Y.Z` for <what> (see «<section>») `` before the last sentence. (b) Add a paragraph about the change in the section of its feature, and a «Measured on <date>» paragraph when it was measured. (c) Update any count it quotes (tests, cases). Label every number measured, calculated or guessed, and give n. `private/logic-test-debug/test/manifest.test.mjs` reads `PRIVATE.md`: do not rewrite the sentences it matches.
5. **Test and commit.**
   ```sh
   npm test
   npm run test:claude-auto
   git add <the files you changed>
   git commit -m "Plugin X.Y.Z: <what changed, one line>"
   git log -1 --format=%B | grep -iE "claude|council|consiliu|co-authored"
   ```
   Run the Node suite alone, not at the same time as the Python ones. The last command must print nothing: no trailer, no mention of Claude or a council.
6. **Tag and push** (only on the owner's word). The push must be a fast-forward; if it is rejected, fetch and put your commits on top of `origin/main`. Never force-push `main`.
   ```sh
   git tag -a plugin-vX.Y.Z -m "Plugin X.Y.Z: <short>"
   git push origin release-X.Y.Z:main
   git push origin plugin-vX.Y.Z
   ```
7. **CI.** Always pass `-R panaalexandrucristian/apana-plugin`.
   ```sh
   gh run list -R panaalexandrucristian/apana-plugin --limit 3
   gh run view <id> -R panaalexandrucristian/apana-plugin --json status,conclusion
   ```
   A run takes a few minutes. Report the result as it is; if it fails, say so with the failing job.
8. **Tell the owner** to update on each machine: `claude plugin marketplace update apana-private && claude plugin update apana@apana-private`. Leave the worktree in place; delete it only when asked.
