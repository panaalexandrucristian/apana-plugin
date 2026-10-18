# Copy of 15 modules of handoff-verify

Byte-for-byte copy of these files of `skills/handoff-verify/scripts/` in `panaalexandrucristian/jev-mcp-private`, taken at commit `1a047da` (jev plugin 0.13.10):

`advice.py audit.py discover.py jevref.py ledger.py omissions.py opencode.py prepare.py refs.py report.py sanitize.py schema_check.py scope.py slice.py versions.py report.schema.json`

They are what `prepare.py` imports, directly or not (measured: the import closure of `prepare.py`, 15 modules, 5,811 lines). `compact-handoff` runs `prepare.py` and loads `sanitize.py`. Nothing here calls Jev: `jevref.py` only reads a session log.

Do not edit these files here. To refresh them, copy them again from a checkout of `jev-mcp-private` and compare:

    SRC=<checkout of jev-mcp-private>/skills/handoff-verify/scripts
    for f in $(ls *.py report.schema.json); do cmp "$SRC/$f" "$f"; done

The tests of these modules stay in `jev-mcp-private`. Here they are exercised by the self tests of `compact-handoff`.
