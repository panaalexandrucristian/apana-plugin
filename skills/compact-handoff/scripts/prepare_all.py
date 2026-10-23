#!/usr/bin/env python3
"""prepare_all.py SESSION.jsonl --cwd DIR --out DIR [--with-subagents]   (otherwise the options of handoff-verify's prepare.py)

prepare.py builds the chunks for VERIFICATION: it leaves out what a verifier must not count as source (the skill's own calls and results, the 'runs' that follow a note, the note's own edits). For a start context that continues the work those exclusions delete real conversation: every turn in which the skill's files were read, run or edited disappears with its answer. This wrapper switches the two exclusion functions off in this process only and then runs prepare.py unchanged (sanitization and chunking stay). It changes no file of the skill.
prepare.py appends the transcripts of the session's subagents after the main conversation, so the END of the chunks is then subagent work, not the last thing the main conversation did, and their text
(for example the payload of a batch they sent to a tool) is mostly noise for whoever continues. What a subagent found comes back to the main conversation as its result. So they are left out unless --with-subagents.
A message that the user typed while the model was working is an `attachment` record, which prepare.py does not read: it is turned into a user record before prepare.py loads the transcript (see _typed_while_busy)."""
import os, sys
def _hv_scripts():
    """handoff-verify's scripts: HV_SCRIPTS, else the copy of them next to this file (handoff_verify/, see its VENDORED.md)."""
    here = os.path.dirname(os.path.abspath(__file__))
    cands = [os.environ.get("HV_SCRIPTS"), os.path.join(here, "handoff_verify")]
    for c in cands:
        if c and os.path.exists(os.path.join(c, "prepare.py")): return os.path.abspath(c)
    sys.exit("handoff-verify's scripts (prepare.py) not found: restore scripts/handoff_verify/ or set HV_SCRIPTS to their folder")
sys.path.insert(0, _hv_scripts())
import omissions as O
import discover
if "--with-subagents" in sys.argv: sys.argv.remove("--with-subagents")
else: discover.subagent_files = lambda session_path: []
O.common_exclusions = lambda records, note=None: set()
O.generated_events = lambda records: set()
def _typed_while_busy(d):
    """A message that the user typed while the model was working is stored as an `attachment` record (type queued_command, origin human, commandMode prompt, the text in `prompt`), and often nowhere else.
    prepare.py reads only the user and assistant records, so it would drop it; here that record becomes an ordinary user record. Any other queued_command (a task notification, a message of a peer session,
    an origin that is missing) and a blank text stay as they were."""
    a = d.get("attachment")
    if d.get("type") != "attachment" or not isinstance(a, dict) or a.get("type") != "queued_command": return d
    o, p = a.get("origin"), a.get("prompt")
    if not (isinstance(o, dict) and o.get("kind") == "human" and a.get("commandMode") == "prompt" and isinstance(p, str) and p.strip()): return d
    return dict({k: v for k, v in d.items() if k != "attachment"}, type="user", message={"role": "user", "content": p})
_load_jsonl = discover.load_jsonl
discover.load_jsonl = lambda path: [_typed_while_busy(d) for d in _load_jsonl(path)]
import prepare
# Preserve structured record boundaries before chunking; quoted headers are payload.
_derive = prepare.derive
def _derive_with_boundaries(*args, **kwargs):
    p = _derive(*args, **kwargs)
    starts, offset = [], 0
    for chunk, text in zip(p["chunks_meta"], p["chunk_texts"]):
        starts.extend(offset + e["start"] for e in chunk["entries"] if e["eoff"] == 0)
        offset += len(text)
    if p["work"]:
        import json, hashlib
        text = "".join(p["chunk_texts"])
        with open(os.path.join(p["work"], "record-boundaries.json"), "w") as f:
            json.dump(dict(sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(), starts=starts), f)
    return p
prepare.derive = _derive_with_boundaries
sys.exit(prepare.main())
