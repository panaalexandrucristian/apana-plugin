#!/bin/sh
set -eu
mkdir -p src/shared src/banner src/theme src/reader test
git init -q

commit_at() {
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git -c user.name='Review Plan Fixture' -c user.email=fixture@example.test -c commit.gpgSign=false -c core.hooksPath=/dev/null commit -qm "$2"
}

cat > AGENTS.md <<'EOT'
# Working here

- Tests live in `test/`. Use the built-in `node:test` runner.
- Keep the public wire format unchanged unless the requirement changes it.
EOT
cat > src/shared/config.mjs <<'EOT'
export function deserializeConfig(text, Config) {
  return new Config(JSON.parse(text));
}
EOT
cat > src/theme/config.mjs <<'EOT'
import { deserializeConfig } from '../shared/config.mjs';

export async function fetchThemeConfigText(fetchConfig) {
  return (await fetchConfig()).text();
}
EOT
git add -- AGENTS.md src/shared/config.mjs src/theme/config.mjs
commit_at '2020-01-01T00:00:00Z' 'Seed shared config and theme transport'

write_banner() {
  cat > src/banner/config.mjs <<EOT
import { deserializeConfig } from '../shared/config.mjs';

export class BannerConfig {
  constructor({ banner }) {
    this.label = typeof banner?.label === 'string' ? banner.label : '$1';
  }
}

export async function loadBannerConfig(fetchConfig) {
  return deserializeConfig(await (await fetchConfig()).text(), BannerConfig);
}
EOT
}
write_banner ''
git add -- src/banner/config.mjs
commit_at '2020-02-01T00:00:00Z' 'Implement banner HTTP config'

cat >> src/theme/config.mjs <<'EOT'

export class ThemeConfig {
  constructor({ theme }) {
    this.name = typeof theme?.name === 'string' ? theme.name : 'light';
  }
}

export async function loadThemeConfig(fetchConfig) {
  return deserializeConfig(await fetchThemeConfigText(fetchConfig), ThemeConfig);
}
EOT
git add -- src/theme/config.mjs
commit_at '2020-03-01T00:00:00Z' 'Implement theme HTTP config'

write_banner 'Today'
git add -- src/banner/config.mjs
commit_at '2020-04-01T00:00:00Z' 'Change banner default label'

cat > src/reader/config.mjs <<'EOT'
export async function fetchReaderConfigText(fetchConfig) {
  return (await fetchConfig()).text();
}
EOT
cat > test/reader-config.test.mjs <<'EOT'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchReaderConfigText } from '../src/reader/config.mjs';

test('reads the HTTP response text unchanged', async () => {
  const text = '{"reader":{"refreshSeconds":15}}';
  assert.equal(await fetchReaderConfigText(async () => ({ text: async () => text })), text);
});
EOT
cat > PLAN.md <<'EOT'
# Plan: expose reader refresh settings from HTTP config

## Requirement
The existing HTTP JSON body may now include a `reader` object. Expose `refreshSeconds` as a positive integer. Use 60 when the object or field is absent or the field is invalid. Preserve the HTTP wire format and existing response-text retrieval.

## Steps
1. In `src/reader/config.mjs`, add `loadReaderConfig(fetchConfig)` using `fetchReaderConfigText`. Parse the outer JSON, extract the `reader` object, stringify it and parse that string by hand in the same function. Return a plain object with `refreshSeconds`; guard missing and invalid values with the default of 60. Do not add a model class.
2. Extend `test/reader-config.test.mjs` to check a valid value, an absent `reader`, an absent field and a non-positive or non-integer field.

## Acceptance criteria
- Criterion — reader refresh settings / steps 1–2: with a valid value of 15, an absent `reader`, an absent field, a value of 0 or a value of 1.5, the loader exposes respectively 15, 60, 60, 60 and 60, and the unchanged HTTP text test still passes. Check: `node --test test/reader-config.test.mjs`. Evidence: test output. Status: planned, not run.
EOT
git add -- src/reader/config.mjs test/reader-config.test.mjs PLAN.md
commit_at '2020-05-01T00:00:00Z' 'Seed reader plan and test'
