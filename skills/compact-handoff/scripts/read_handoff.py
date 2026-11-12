#!/usr/bin/env python3
"""Portable, lossless recovery of archived UTF-8 text in bounded JSONL pages.

Lines are 1-based LF-delimited lines; columns are 0-based Unicode code points.
Each data record carries its starting position and a JSON-escaped text fragment.
Concatenating decoded `text` values reproduces the requested bytes, including CRLF.
The final record has `next` (a cursor or null) and `eof`. No dependencies outside stdlib.
"""
import argparse
import json
import sys

MAX_RESPONSE_BYTES = 12000
MAX_SEGMENT_BYTES = 1400
READ_BUDGET = 40000


def text_lines(text):
    """LF is the read tool's delimiter; a trailing LF does not invent another line."""
    parts = text.split('\n')
    return [part + '\n' for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def reading_plan(lines, budget=READ_BUDGET, max_lines=400):
    """Bound the visible UTF-8 response, including labels; long lines use recovery.

OpenCode clamps a line at 2000 UTF-16 units. Taking 2000 code points here is a
conservative overestimate for astral characters. The suffix and labels have room.
"""
    chunks, start, size, count = [], 1, 0, 0
    for number, line in enumerate(lines, 1):
        clamped = len(line.encode('utf-16-le')) > 4000
        visible = line[:2000] + ('... (line truncated to 2000 chars)' if clamped else '')
        cost = len(visible.encode('utf-8')) + len(str(number)) + 3
        if count and (size + cost > budget or count >= max_lines):
            chunks.append((start, count)); start, size, count = number, 0, 0
        size += cost; count += 1
    if count: chunks.append((start, count))
    return chunks


def _json(record):
    return json.dumps(record, ensure_ascii=False) + '\n'


def read_page(path, line=1, column=0, stop_line=None):
    with open(path, encoding='utf-8', newline='') as f:
        lines = text_lines(f.read())
    if line < 1 or line > len(lines) + 1 or column < 0:
        raise ValueError('invalid line or column')
    if stop_line is not None and (stop_line < line or stop_line > len(lines)):
        raise ValueError('invalid stop-line')
    if (line > len(lines) and column) or (line <= len(lines) and column >= len(lines[line - 1])):
        raise ValueError('column is outside the line')
    stop = len(lines) if stop_line is None else stop_line
    output, size = [], 0
    while line <= stop:
        # Bound each physical output line too, even with JSON control escapes.
        remaining = lines[line - 1][column:column + 1000]
        lo, hi = 1, len(remaining)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            encoded = _json({'line': line, 'column': column, 'text': remaining[:mid]})
            if len(encoded.encode('utf-8')) <= MAX_SEGMENT_BYTES: lo = mid
            else: hi = mid - 1
        encoded = _json({'line': line, 'column': column, 'text': remaining[:lo]})
        length = len(encoded.encode('utf-8'))
        if size + length > MAX_RESPONSE_BYTES - 512: break
        output.append(encoded); size += length; column += lo
        if column == len(lines[line - 1]): line += 1; column = 0
    cursor = {'line': line, 'column': column} if line <= stop else None
    output.append(_json({'next': cursor, 'eof': line > len(lines)}))
    result = ''.join(output)
    assert len(result.encode('utf-8')) <= MAX_RESPONSE_BYTES
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file')
    parser.add_argument('--line', type=int, default=1)
    parser.add_argument('--column', type=int, default=0)
    parser.add_argument('--stop-line', type=int)
    args = parser.parse_args()
    try:
        sys.stdout.write(read_page(args.file, args.line, args.column, args.stop_line))
    except (OSError, ValueError) as error:
        parser.exit(2, 'read_handoff: %s\n' % str(error)[:300])


if __name__ == '__main__':
    main()
