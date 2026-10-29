"""Read CLIProxyAPI request evidence without retaining authentication headers.

The installed proxy writes finalized logs and active source fragments below its
private auth/logs directory. This is a transport observer, not an oracle for
whether a provider stopped its internal computation.
"""
import hashlib
import json
from pathlib import Path
import re


SECTION = re.compile(r'^=== API (REQUEST|RESPONSE) ([1-9][0-9]*) ===$')


def fingerprint(body):
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


def parse_log(text, partial=False):
    """Keep only upstream JSON bodies and response type/ID metadata, never headers."""
    records = {}
    current, kind, awaiting_body = None, None, False
    for line in text.splitlines():
        if line.startswith('==='):
            match = SECTION.fullmatch(line)
            kind, current, awaiting_body = None, None, False
            if match:
                kind, number = match.group(1), int(match.group(2))
                current = records.setdefault(number, {'attempt': number, 'response_types': [], 'response_id': None})
            continue
        if current is None:
            continue
        if kind == 'REQUEST':
            if line.startswith('Timestamp: ') and 'request_timestamp' not in current:
                current['request_timestamp'] = line.removeprefix('Timestamp: ')
            elif line == 'Body:':
                awaiting_body = True
            elif awaiting_body and line.strip():
                try:
                    body = json.loads(line)
                    if not isinstance(body, dict):
                        raise ValueError('Upstream request body is not an object')
                except ValueError:
                    if partial:
                        continue
                    raise
                current['body'] = body
                current['fingerprint'] = fingerprint(body)
                awaiting_body = False
        elif kind == 'RESPONSE' and line.startswith('Status: ') and 'upstream_status' not in current:
            current['upstream_status'] = int(line.removeprefix('Status: '))
        elif kind == 'RESPONSE' and line.startswith('data: {'):
            try:
                event, end = json.JSONDecoder().raw_decode(line[6:])
                # The proxy appends its cancellation error without a newline.
                # Never discard arbitrary suffixes: they could hide completion.
                suffix = line[6 + end:].strip()
                if suffix not in ('', 'Error: context canceled'):
                    raise ValueError('Unexpected content after upstream SSE event')
            except ValueError:
                if partial:
                    continue
                raise
            current['response_types'].append(event.get('type'))
            if event.get('type') == 'response.created':
                current['response_id'] = event.get('response', {}).get('id')
    return [record for record in records.values() if 'body' in record]


def delegated_task(body):
    """Recognize the exact structured collaborator prompt, not a quoted substring."""
    for item in body.get('input', []):
        if item.get('role') != 'user':
            continue
        for block in item.get('content', []):
            if block.get('type') != 'input_text' or not isinstance(block.get('text'), str):
                continue
            try:
                value = json.loads(block['text'])
            except ValueError:
                continue
            if isinstance(value, dict) and isinstance(value.get('task'), str) and isinstance(value.get('instructions'), str):
                return value['task']
    return None


def _fragment(directory):
    parts = list(directory.glob('*.tmp'))
    if len(parts) != 1:
        return None  # Never guess the order of unsupported multipart source files.
    try:
        return parts[0].read_text()
    except (FileNotFoundError, UnicodeDecodeError):
        return None  # Source removal or a partially written UTF-8 character: retry.


def active_request(directory, task):
    directory = Path(directory)
    requests = list(directory.glob('request-log-parts-api-request-*'))
    responses = list(directory.glob('request-log-parts-api-response-*'))
    if len(requests) != 1 or len(responses) != 1:
        return None  # Ambiguous concurrent sources cannot establish a cancellation barrier.
    request, response = _fragment(requests[0]), _fragment(responses[0])
    if request is None or response is None:
        return None
    records = parse_log(request + '\n' + response, partial=True)
    if len(records) != 1:
        return None
    record = records[0]
    types = record['response_types']
    # Native model.complete is non-streaming downstream: body chunks are logged
    # only after ReadAll. Upstream HTTP success is observable before that and
    # proves the provider acknowledged the request, unlike registry claim alone.
    if (delegated_task(record['body']) == task and record.get('request_timestamp') and
            record.get('upstream_status') == 200 and 'response.completed' not in types):
        return record
    return None


def finalized_requests(directory):
    records = []
    for path in sorted(Path(directory).glob('*.log')):
        # The writer creates the file before filling it. Incomplete reads cannot
        # establish a body/response identity; the caller retries until finalized.
        text = path.read_text()
        if '=== RESPONSE ===' not in text.splitlines():
            continue
        for record in parse_log(text):
            records.append(dict(record, log=path.name))
    return records


def cancelled_request(directory, started):
    for record in finalized_requests(directory):
        same_request = (started.get('request_timestamp') and record.get('request_timestamp') == started['request_timestamp'] and
                        record['fingerprint'] == started['fingerprint'])
        same_response = not started['response_id'] or record['response_id'] == started['response_id']
        if same_request and same_response:
            assert record.get('upstream_status') == 200, 'Upstream acknowledgement disappeared from the final log'
            assert 'response.completed' not in record['response_types'], 'Upstream completed before cancellation was observed'
            return record
    return None


def audit(records, task, owner_secret, help_secret):
    isolated, owner = [], []
    for record in records:
        body = record['body']
        text = json.dumps(body)
        if delegated_task(body) == task:
            assert owner_secret not in text, 'Private owner sentinel reached the isolated upstream request'
            assert help_secret in text, 'Delegation sentinel missing from isolated upstream request'
            assert not body.get('tools'), 'Proxy added tools to an isolated tool-free request'
            isolated.append(record)
        else:
            assert help_secret not in text, 'Assistance-only sentinel reached the host-owner upstream request'
            owner.append(record)
    owner_text = json.dumps([record['body'] for record in owner])
    if not isolated or owner_secret not in owner_text or 'Private owner context probe:' not in owner_text:
        return None
    return {'isolated_requests': len(isolated), 'owner_requests': len(owner),
            'scope': 'OpenAI proxy upstream JSON bodies; not direct-provider traffic or provider internal state'}
