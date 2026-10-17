#!/usr/bin/env python3
"""Behavioral release-gate checks using disposable repositories and packages."""
import gzip
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

GUARD = Path(__file__).resolve().parents[1] / 'scripts' / 'check-public-release.py'


class PublicReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repo'
        self.root.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Release Test')
        self.git('config', 'user.email', 'test@users.noreply.github.com')
        self.write('README.md', 'Public example repository.\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Initial example')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')

    def check(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(GUARD), '--root', str(self.root), *map(str, args)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0 if ok else 1, report)
        self.assertEqual(report['ok'], ok)
        # The report must not expose repository or input absolute paths.
        self.assertNotIn(self.temp.name, result.stdout)
        return report

    def rules(self, report):
        return {finding['rule'] for finding in report['findings']}

    def leak(self):
        return 'release-person' + '@' + 'mail-provider.org'

    def test_safe_examples_and_noreply_history(self):
        self.write('examples.md', '\n'.join([
            'user@example.com example@example.org test@example.net',
            'anyone@example.test nobody@localhost invalid@example.invalid',
            '/home/user/project /Users/deploy/project /home/USER/project',
            'C:' + '\\Users\\runner\\project',
            '127.0.0.1 192.0.2.4 198.51.100.8 203.0.113.9',
            'resp_fake call_short asdk_app_example',
        ]))
        self.git('add', '.')
        self.git('commit', '-qm', 'Document examples')
        report = self.check('--history')
        self.assertEqual(report['counts']['source_files'], 2)
        self.assertGreater(report['counts']['history_objects'], 2)

    def test_version_references_pass_and_real_email_still_fails(self):
        references = '\n'.join([
            'uses: actions/checkout@v7.0.1',
            'uses: pnpm/setup@v3.1.1',
            'runtime: node@22.23.1',
            "'@scope/package@1.2.3':",
            "'library@4.5.6-beta.2':",
            "'library@4.5.6(peer@7.8.9)':",
        ])
        self.write('release-input.txt', references)
        self.git('add', '.')
        self.check()
        addresses = [self.leak(), 'release+tag' + '@' + 'mail-provider.co.uk',
                     'release.person' + '@' + 'mail-provider.museum']
        self.write('release-input.txt', references + '\n' + '\n'.join(address + '.' for address in addresses))
        report = self.check(ok=False)
        self.assertEqual(self.rules(report), {'email-address'})
        finding = report['findings'][0]
        self.assertEqual(finding['path'], 'release-input.txt')
        self.assertEqual(finding['line_count'], len(addresses))
        self.assertTrue(all(address not in json.dumps(report) for address in addresses))

    def test_javascript_properties_pass_and_private_host_contexts_fail(self):
        javascript = '\n'.join([
            'const flag = t.local;',
            'const value = t.local();',
            'if (t.local && object.internal) consume(t.local);',
            'const nested = value.settings.local;',
        ])
        self.write('bundle.js', javascript)
        self.git('add', '.')
        self.check()
        hosts = ['db' + '.local', 'service' + '.internal', 'bridge' + '.internal',
                 'storage' + '.local', 'backup' + '.internal']
        private_settings = '\n'.join([
            'const address = "' + hosts[0] + '";',
            'const endpoint = "https://' + hosts[1] + '/api";',
            'host: ' + hosts[2],
            'connect(https://' + hosts[3] + '/api)',
            'const first = t.local; const target = `' + hosts[4] + '`;',
        ])
        self.write('bundle.js', javascript + '\n' + private_settings)
        report = self.check(ok=False)
        self.assertEqual(self.rules(report), {'private-hostname'})
        self.assertEqual(report['findings'][0]['line_count'], len(hosts))
        self.assertTrue(all(host not in json.dumps(report) for host in hosts))

    def test_untracked_input_is_outside_source_set(self):
        self.write('untracked.txt', self.leak())
        self.check()

    def test_empty_index_fails_closed(self):
        self.git('rm', '--cached', 'README.md')
        self.assertIn('no-tracked-files', self.rules(self.check(ok=False)))

    def test_tracked_private_content_reports_rules_without_values(self):
        prohibited = [
            self.leak(),
            '/home/' + 'private-person' + '/project',
            '/Users/' + 'private-person' + '/project',
            'C:' + '\\Users\\' + 'private-person' + '\\project',
            '.'.join(['192', '168', '4', '8']),
            'host=bridge' + '.internal',
            'resp_' + 'a' * 24,
            'sk-' + 'A' * 40,
        ]
        self.write('example.txt', '\n'.join(prohibited))
        self.git('add', 'example.txt')
        report = self.check(ok=False)
        self.assertTrue({'email-address', 'personal-home', 'private-ipv4', 'private-hostname', 'runtime-id', 'openai-key'} <= self.rules(report))
        encoded = json.dumps(report)
        for value in prohibited:
            self.assertNotIn(value, encoded)
        home = next(f for f in report['findings'] if f['rule'] == 'personal-home')
        self.assertEqual(home['line_count'], 3)

    def test_credential_families(self):
        credentials = [
            '-----BEGIN ' + 'PRIVATE KEY-----',
            'ghp_' + 'B' * 36,
            'AK' + 'IA' + 'C' * 16,
            'xox' + 'b-' + 'D' * 30,
            'ey' + 'J' + 'E' * 20 + '.' + 'F' * 20 + '.' + 'G' * 25,
        ]
        self.write('payload.txt', '\n'.join(credentials))
        self.git('add', '.')
        self.assertTrue({'private-key', 'github-key', 'aws-key', 'slack-key', 'jwt'} <= self.rules(self.check(ok=False)))

    def test_private_filenames_and_legitimate_module_names(self):
        for name in ('src/token-store.ts', 'src/state-repository.ts', '.env.example'):
            self.write(name, 'example\n')
        self.git('add', '.')
        self.check()
        for name in ('.runtime/state.json', 'deploy/live/config.json', '.agents/project-id', '.env', 'project.yaml', 'secrets.json', 'data.sqlite', 'capture.log', 'screenshots/view.png', 'bundle.tgz'):
            self.write(name, 'example\n')
        self.git('add', '.')
        report = self.check(ok=False)
        self.assertEqual(sum(f['rule'] == 'private-path' for f in report['findings']), 10)

    def test_missing_and_symlink_sources_fail_closed(self):
        (self.root / 'README.md').unlink()
        self.assertIn('missing-or-nonregular-source', self.rules(self.check(ok=False)))
        outside = Path(self.temp.name) / 'outside'
        outside.write_text(self.leak(), encoding='utf-8')
        (self.root / 'README.md').symlink_to(outside)
        report = self.check(ok=False)
        self.assertEqual(self.rules(report), {'missing-or-nonregular-source'})

    def test_deleted_history_and_commit_metadata_are_checked(self):
        self.write('retired.txt', self.leak())
        self.git('add', '.')
        self.git('commit', '-qm', 'Add retired data')
        self.git('rm', '-q', 'retired.txt')
        self.git('commit', '-qm', 'Remove retired data')
        self.check()
        report = self.check('--history', ok=False)
        self.assertIn('email-address', self.rules(report))
        self.assertTrue(all(f['path'].startswith('history/') for f in report['findings']))
        self.git('-c', 'user.email=' + self.leak(), 'commit', '--allow-empty', '-qm', 'Metadata only')
        report = self.check('--history', ok=False)
        self.assertGreaterEqual(sum(f['rule'] == 'email-address' for f in report['findings']), 2)

    def test_annotated_tag_contents_are_checked(self):
        self.git('tag', '-a', 'example', '-m', self.leak())
        self.assertIn('email-address', self.rules(self.check('--history', ok=False)))

    def make_archive(self, members):
        path = Path(self.temp.name) / 'package.tgz'
        with tarfile.open(path, 'w:gz') as package:
            for name, content, kind in members:
                member = tarfile.TarInfo(name)
                if kind == 'symlink':
                    member.type = tarfile.SYMTYPE
                    member.linkname = '../outside'
                    package.addfile(member)
                elif kind == 'hardlink':
                    member.type = tarfile.LNKTYPE
                    member.linkname = 'package/README.md'
                    package.addfile(member)
                else:
                    data = content.encode('utf-8')
                    member.size = len(data)
                    package.addfile(member, io.BytesIO(data))
        return path

    def test_valid_package(self):
        archive = self.make_archive([('package/README.md', 'user@example.com\n', 'file')])
        report = self.check('--archive', archive)
        self.assertEqual(report['counts']['archive_members'], 1)

    def test_archive_traversal_absolute_and_links_fail_closed(self):
        for name, kind in (('../outside', 'file'), ('/absolute', 'file'), ('C:/absolute', 'file'), ('package/link', 'symlink'), ('package/link', 'hardlink')):
            with self.subTest(name=name, kind=kind):
                archive = self.make_archive([(name, 'example', kind)])
                rules = self.rules(self.check('--archive', archive, ok=False))
                self.assertTrue({'unsafe-path', 'nonregular-archive-member'} & rules)
        self.assertFalse((Path(self.temp.name) / 'outside').exists())

    def test_archive_content_and_paths_are_checked(self):
        archive = self.make_archive([('package/README.md', self.leak(), 'file'), ('package/.env', 'example', 'file')])
        report = self.check('--archive', archive, ok=False)
        self.assertTrue({'email-address', 'private-path'} <= self.rules(report))
        self.assertNotIn(self.leak(), json.dumps(report))

    def test_oversized_and_malformed_archives_fail_closed(self):
        archive = self.make_archive([('package/large.txt', 'x' * (17 * 1024 * 1024), 'file')])
        self.assertIn('archive-member-size-limit', self.rules(self.check('--archive', archive, ok=False)))
        archive.write_bytes(gzip.compress(b'x' * (33 * 1024 * 1024)))
        self.assertIn('archive-size-limit', self.rules(self.check('--archive', archive, ok=False)))
        archive.write_bytes(b'not a gzip stream')
        self.assertIn('unreadable-archive', self.rules(self.check('--archive', archive, ok=False)))
        archive.write_bytes(b'\x1f\x8b\x08\x00' + b'\x00' * 6 + b'invalid deflate')
        self.assertIn('unreadable-archive', self.rules(self.check('--archive', archive, ok=False)))


if __name__ == '__main__':
    unittest.main()