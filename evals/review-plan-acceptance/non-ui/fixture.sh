#!/bin/sh
set -eu
mkdir -p src
cat > AGENTS.md <<'EOT'
# Working here

- Documentation is plain Markdown in `README.md`.
- A documentation fix is checked against the code it describes.
EOT
cat > src/config.js <<'EOT'
import { readFileSync } from "node:fs";

// The program reads its settings from this file in the working directory.
export function loadConfig() {
  return JSON.parse(readFileSync("settings.conf", "utf8"));
}
EOT
cat > README.md <<'EOT'
# Report tool

## Configuration
Create a file named `app.conf` in the folder where you start the tool. It holds the settings as JSON.

## Troubleshooting
If the tool ignores your settings, check that `app.conf` is in the folder where you started it.
EOT
cat > PLAN.md <<'EOT'
# Plan: fix the config file name in the README

## Context
The README tells people to create `app.conf`, but the program reads `settings.conf` (`src/config.js`), so a person who follows the README gets the default settings. The requirement: the README names the file the program actually reads, in every place it names a config file.

## Steps
1. In `README.md`, replace `app.conf` with `settings.conf` in the Configuration section.
2. Check the README.
EOT
