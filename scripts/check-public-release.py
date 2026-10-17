#!/usr/bin/env python3
"""Check release inputs for common private data; this is not a complete secret audit."""
import argparse
import gzip
import io
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tarfile
import zlib

MAX_MEMBER = 16 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
MAX_HISTORY = 256 * 1024 * 1024
GENERIC_USERS = {'example', 'user', 'dev', 'deploy', 'operator', 'test', 'runner', 'username', '<user>', '${user}', '$user', '%username%'}
EMAIL = re.compile(r'(?<![\w.+-])[\w.!#$%&*+/=?^`{|}~-]+@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?![\w-]|\.[\w-])', re.I)
HOME = re.compile(r'(?:/(?:home|Users)/|[a-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+)([^/\\\s\x00"\x27`<>]+)', re.I)
IP = re.compile(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])')
PRIVATE_NETS = tuple(ipaddress.ip_network('.'.join(octets) + '/' + bits) for octets, bits in (
    (('10', '0', '0', '0'), '8'), (('172', '16', '0', '0'), '12'),
    (('192', '168', '0', '0'), '16'), (('169', '254', '0', '0'), '16'),
    (('100', '64', '0', '0'), '10'),
))
# A bare dotted property expression is not evidence of a deployed hostname.
HOST_CONTEXT = re.compile(r"""(?:["'`]|(?:[a-z][a-z0-9+.-]*:)?//(?:[^/\s"'`]*@)?|\b(?:host(?:name)?|server|endpoint|url|origin)["'`]?\s*[:=]\s*)$""", re.I)
PATTERNS = {
    'private-hostname': re.compile(r'(?<![\w.-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:local|internal)(?![\w.-])', re.I),
    'runtime-id': re.compile(r'\b(?:asdk_app_|resp_|call_)[A-Za-z0-9_-]{20,}\b'),
    'private-key': re.compile(r'-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----'),
    'openai-key': re.compile(r'\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b'),
    'github-key': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b'),
    'aws-key': re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    'slack-key': re.compile(r'\bxox[baprs]-[A-Za-z0-9-]{24,}\b'),
    'jwt': re.compile(r'\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}\b'),
}


def safe_path(value):
    if not value or '\\' in value or any(ord(c) < 32 or ord(c) == 127 for c in value) or value.startswith('/') or re.match(r'^[A-Za-z]:', value):
        return False
    return all(part not in ('', '.', '..') for part in value.rstrip('/').split('/'))


def private_path(value):
    parts = PurePosixPath(value).parts
    lower = [part.lower() for part in parts]
    if any(part in {'.agent', '.evidence-private', '.runtime', 'screenshots'} for part in lower):
        return True
    if any(lower[i:i + 2] in (['deploy', 'live'], ['.agents', 'project-id']) for i in range(len(lower) - 1)):
        return True
    name = lower[-1] if lower else ''
    return (name == 'project.yaml' or (name.startswith('.env') and name != '.env.example')
            or name.endswith(('.log', '.tgz', '.sqlite', '.sqlite3', '.db'))
            or bool(re.fullmatch(r'(?:credentials?|secrets?|tokens?)(?:\.[^.]+)*', name))
            or bool(re.match(r'screenshot(?:[._-]|$)', name)))


class Scan:
    def __init__(self):
        self.findings = []
        self.counts = {'source_files': 0, 'history_objects': 0, 'archive_members': 0, 'bytes': 0}

    def finding(self, path, rule, lines=()):
        # Invalid paths are never echoed: they can contain arbitrary host paths or controls.
        display = path if safe_path(path) and not any(ord(c) < 32 for c in path) else '<unsafe-path>'
        item = {'path': display, 'rule': rule, 'line_count': len(set(lines))}
        if lines:
            item['lines'] = sorted(set(lines))
        self.findings.append(item)

    def path(self, value, display=None):
        if not safe_path(value):
            self.finding(display or '<unsafe-path>', 'unsafe-path')
            return False
        if private_path(value):
            self.finding(display or value, 'private-path')
        self.content(display or value, value.encode('utf-8', errors='surrogateescape'))
        return True

    def content(self, path, data):
        self.counts['bytes'] += len(data)
        hits = {}
        for number, line in enumerate(data.decode('utf-8', errors='replace').splitlines(), 1):
            for rule, regex in PATTERNS.items():
                matches = regex.finditer(line)
                if any(rule != 'private-hostname' or HOST_CONTEXT.search(line[:match.start()]) for match in matches):
                    hits.setdefault(rule, []).append(number)
            for match in EMAIL.finditer(line):
                domain = match.group(1).lower()
                allowed = domain == 'localhost' or domain == 'users.noreply.github.com' or domain.endswith('.users.noreply.github.com')
                allowed = allowed or any(domain == suffix or domain.endswith('.' + suffix) for suffix in ('example.com', 'example.org', 'example.net', 'test', 'invalid'))
                if '.' in domain and not allowed:
                    hits.setdefault('email-address', []).append(number)
            for match in HOME.finditer(line):
                if match.group(1).lower() not in GENERIC_USERS:
                    hits.setdefault('personal-home', []).append(number)
            for match in IP.finditer(line):
                try:
                    address = ipaddress.ip_address(match.group())
                    if any(address in network for network in PRIVATE_NETS):
                        hits.setdefault('private-ipv4', []).append(number)
                except ValueError:
                    pass
        for rule, lines in hits.items():
            self.finding(path, rule, lines)


def git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def source(scan, root):
    names = git(root, 'ls-files', '-z').split(b'\0')
    names = [os.fsdecode(name) for name in names if name]
    if not names:
        scan.finding('source', 'no-tracked-files')
    for name in names:
        if not scan.path(name):
            continue
        target = root
        try:
            for part in PurePosixPath(name).parts:
                target = target / part
                mode = target.lstat().st_mode
                if stat.S_ISLNK(mode):
                    raise ValueError('symlink')
            if not stat.S_ISREG(mode):
                raise ValueError('special')
            if target.stat().st_size > MAX_MEMBER:
                scan.finding(name, 'source-size-limit')
                continue
            data = target.read_bytes()
        except (OSError, ValueError):
            scan.finding(name, 'missing-or-nonregular-source')
            continue
        scan.counts['source_files'] += 1
        scan.content(name, data)


def history(scan, root):
    objects = git(root, 'rev-list', '--objects', '--all', '--no-object-names').splitlines()
    total = 0
    for oid in dict.fromkeys(objects):
        if not re.fullmatch(rb'[a-f0-9]{40,64}', oid):
            raise ValueError('invalid object identifier')
        info = subprocess.run(['git', '-C', str(root), 'cat-file', '--batch-check=%(objecttype) %(objectsize)'], input=oid + b'\n', check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.split()
        kind, size = info[0], int(info[1])
        if kind not in (b'blob', b'commit', b'tag'):
            continue
        label = 'history/' + oid.decode('ascii')
        total += size
        if size > MAX_MEMBER or total > MAX_HISTORY:
            scan.finding(label, 'history-size-limit')
            return
        scan.counts['history_objects'] += 1
        scan.content(label, git(root, 'cat-file', kind.decode('ascii'), oid.decode('ascii')))
        if kind == b'commit':
            for raw in git(root, 'ls-tree', '-rz', '--name-only', oid.decode('ascii')).split(b'\0'):
                if raw:
                    scan.path(os.fsdecode(raw), label)


def archive(scan, path):
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_TOTAL:
            scan.finding('archive', 'invalid-archive-input')
            return
        with gzip.open(path, 'rb') as stream:
            data = stream.read(MAX_TOTAL + 1)
        if len(data) > MAX_TOTAL:
            scan.finding('archive', 'archive-size-limit')
            return
        before = scan.counts['archive_members']
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as package:
            for member in package:
                scan.counts['archive_members'] += 1
                label = 'archive/' + member.name
                valid = scan.path(member.name, label)
                if not (member.isfile() or member.isdir()) or member.issparse():
                    scan.finding(label, 'nonregular-archive-member')
                    continue
                if member.size > MAX_MEMBER:
                    scan.finding(label, 'archive-member-size-limit')
                    continue
                if valid and member.isfile():
                    stream = package.extractfile(member)
                    scan.content(label, stream.read(MAX_MEMBER + 1))
        if scan.counts['archive_members'] == before:
            scan.finding('archive', 'empty-archive')
    except (OSError, EOFError, tarfile.TarError, ValueError, zlib.error):
        scan.finding('archive', 'unreadable-archive')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--history', action='store_true')
    parser.add_argument('--archive', type=Path)
    args = parser.parse_args()
    scan = Scan()
    try:
        root = args.root.resolve(strict=True)
        source(scan, root)
        if args.history:
            history(scan, root)
    except (OSError, ValueError, subprocess.CalledProcessError, IndexError):
        scan.finding('source', 'git-input-error')
    if args.archive:
        archive(scan, args.archive)
    print(json.dumps({'ok': not scan.findings, 'counts': scan.counts, 'findings': scan.findings}, sort_keys=True))
    return bool(scan.findings)


if __name__ == '__main__':
    raise SystemExit(main())