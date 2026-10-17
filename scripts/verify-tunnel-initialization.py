#!/usr/bin/env python3
"""Isolated installed-binary tunnel handshake proof; no hosted control plane."""
import concurrent.futures
import json
import os
from pathlib import Path
import signal
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

BIN = os.environ.get('TUNNEL_CLIENT', 'tunnel-client')

def child(log_path):
    ready = False
    for line in sys.stdin:
        msg = json.loads(line)
        method = msg.get('method')
        with open(log_path, 'a') as log:
            log.write(json.dumps({'method': method, 'id': msg.get('id')}) + '\n')
        if method == 'notifications/initialized':
            ready = True
            continue
        if 'id' not in msg:
            continue
        reply = {'jsonrpc': '2.0', 'id': msg['id']}
        if method == 'initialize':
            ready = False
            reply['result'] = {'protocolVersion': '2025-11-25', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'isolated-stdio-fixture', 'version': '1'}}
        elif method == 'ping':
            reply['result'] = {}
        elif not ready:
            reply['error'] = {'code': -32003, 'message': 'fixture-not-initialized'}
        elif method == 'tools/list':
            reply['result'] = {'tools': [{'name': 'echo', 'description': 'synthetic echo', 'inputSchema': {'type': 'object'}}]}
        elif method == 'tools/call':
            reply['result'] = {'content': [{'type': 'text', 'text': json.dumps(msg.get('params', {}).get('arguments', {}))}]}
        else:
            reply['error'] = {'code': -32601, 'message': 'unknown method'}
        print(json.dumps(reply), flush=True)

def case(shim):
    with tempfile.TemporaryDirectory(prefix='dsh-tunnel-guard-') as folder:
        root = Path(folder)
        config = root / 'profile.yaml'
        messages = root / 'child.jsonl'
        info_file = root / 'connection.json'
        command = shlex.join([sys.executable, str(Path(__file__).resolve()), '--child', str(messages)])
        config.write_text('mcp:\n  stdio_send_initialized_notification: ' + str(shim).lower() + '\n  commands:\n    - command: ' + json.dumps(command) + '\n      channel: main\n')
        clean_env = {k: v for k, v in os.environ.items() if not k.startswith(('CONTROL_PLANE_', 'MCP_', 'TUNNEL_', 'DSH_'))}
        with (root / 'proxy.log').open('w+') as log:
            proc = subprocess.Popen([BIN, 'dev', 'proxy', '--profile-file', str(config), '--url-file', str(info_file), '--duration', '45s', '--response-timeout', '5s'], env=clean_env, stdout=log, stderr=log, start_new_session=True)
            try:
                until = time.monotonic() + 12
                while not info_file.exists():
                    if proc.poll() is not None or time.monotonic() > until:
                        log.seek(0)
                        raise RuntimeError('local proxy failed: ' + log.read()[-3000:])
                    time.sleep(.05)
                info = json.loads(info_file.read_text())
                url = info['mcp_url']
                def rpc(method, ident=None, params=None):
                    body = {'jsonrpc': '2.0', 'method': method}
                    if ident is not None: body['id'] = ident
                    if params is not None: body['params'] = params
                    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
                    try:
                        response = urllib.request.urlopen(request, timeout=8)
                    except urllib.error.HTTPError as error:
                        response = error
                    with response:
                        data = response.read().decode()
                        if data.startswith('event:') or data.startswith('data:'):
                            data = next(line[5:].strip() for line in data.splitlines() if line.startswith('data:'))
                        return response.status, json.loads(data) if data.strip() else None
                tool = lambda ident: rpc('tools/call', ident, {'name': 'echo', 'arguments': {'nonce': ident}})
                def success(result, ident):
                    assert result[0] == 200 and 'result' in result[1], result
                    assert json.loads(result[1]['result']['content'][0]['text'])['nonce'] == ident, result
                def blocked(result):
                    assert result[0] == 409 and 'mcp_initialization_required' in json.dumps(result[1]), result
                blocked(tool('before-init'))
                rounds = []
                for epoch in range(3):
                    init = rpc('initialize', 'init-' + str(epoch), {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'isolated-proof', 'version': '1'}})
                    assert init[0] == 200 and 'result' in init[1], init
                    ident = 'post-init-' + str(epoch)
                    after_init = tool(ident)
                    if shim: success(after_init, ident)
                    else: blocked(after_init)
                    notified = rpc('notifications/initialized')
                    assert 200 <= notified[0] < 300, notified
                    ids = ['echo-%s-%s' % (epoch, i) for i in range(4)]
                    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                        for ident, result in zip(ids, pool.map(tool, ids)): success(result, ident)
                    rounds.append({'epoch': epoch, 'afterInitializeStatus': after_init[0], 'concurrentEchoesPassed': 4})
                observed = [json.loads(line) for line in messages.read_text().splitlines()]
                methods = [row['method'] for row in observed]
                assert methods.count('initialize') == 3, observed
                assert methods.count('notifications/initialized') == 3, observed
                assert methods.count('tools/call') == (15 if shim else 12), observed
                assert not any(row['id'] == 'before-init' for row in observed), observed
                assert len({row['id'] for row in observed if row['method'] == 'tools/call'}) == methods.count('tools/call'), observed
                return {'shim': shim, 'preInitializeStatus': 409, 'rounds': rounds, 'childInitializeCount': 3, 'childInitializedCount': 3, 'childToolCallCount': methods.count('tools/call'), 'rejectedCallsNeverForwarded': True, 'noDuplicateNotificationsOrCalls': True}
            finally:
                if proc.poll() is None: os.killpg(proc.pid, signal.SIGTERM)
                try: proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait(timeout=5)

if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--child':
        child(sys.argv[2])
    else:
        results = [case(False), case(True)]
        receipt = {'binaryVersion': subprocess.check_output([BIN, '--version'], text=True).strip(), 'mode': 'dev proxy; local synthetic control plane; no production credentials', 'results': results}
        print(json.dumps(receipt, indent=2))
