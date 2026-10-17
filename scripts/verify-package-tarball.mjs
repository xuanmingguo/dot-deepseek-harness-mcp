import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePackageDocLinks } from './package-doc-links.mjs'
import { validateManifestWhitelist, validatePackageFiles } from './package-manifest-policy.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(path.join(tmpdir(), 'harness-package-check-'))
try {
  // prepack runs separately in CI; pack the exact built files without recursive hooks.
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root))[0]
  const archive = path.join(temporary, path.basename(packed.filename))
  const entries = run('tar', ['-tzf', archive], root).trim().split('\n')
  if (entries.some(entry => !entry.startsWith('package/') || entry.split('/').includes('..'))) {
    throw new Error('Unexpected path outside package/ in tarball')
  }
  const extraction = path.join(temporary, 'extracted')
  await mkdir(extraction)
  run('tar', ['-xzf', archive, '-C', extraction], root)
  const packageRoot = path.join(extraction, 'package')
  run('python3', [path.join(root, 'scripts/check-public-release.py'), '--root', root, '--archive', archive], root)
  const records = []
  const documents = []
  const secretFindings = []
  // Same content patterns as scan-source-secrets.py; report locations, never values.
  const secretRules = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['openai-shaped-key', /\bsk-(?:proj-|admin-|svcacct-)?[A-Za-z0-9_-]{40,}\b/],
    ['github-shaped-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{45,})\b/],
    ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ]
  await collect(packageRoot)
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  const whitelist = validateManifestWhitelist(manifest.files)
  const contents = validatePackageFiles(records)
  const links = validatePackageDocLinks(documents, records.map(record => record.path))
  const errors = [...whitelist.errors, ...contents.errors, ...links.errors,
    ...secretFindings.map(finding => `${finding.path}: sensitive content (${finding.rule})`)]
  const report = {
    valid: errors.length === 0, filename: packed.filename,
    sha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
    fileCount: records.length, totalBytes: contents.totalBytes, maxBytes: contents.maxBytes,
    markdownFiles: documents.length, localLinks: links.localLinks, secretFindings, errors,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.valid) process.exitCode = 1

  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const stats = await lstat(absolute)
      if (stats.isSymbolicLink()) throw new Error('Symbolic link in tarball')
      if (stats.isDirectory()) { await collect(absolute); continue }
      if (!stats.isFile()) throw new Error('Non-regular file in tarball')
      const relative = path.relative(packageRoot, absolute).split(path.sep).join('/')
      records.push({ path: relative, bytes: stats.size })
      const text = await readFile(absolute, 'utf8')
      for (const [rule, pattern] of secretRules) {
        if (pattern.test(text)) secretFindings.push({ path: relative, rule })
      }
      if (/\.md$/i.test(relative)) documents.push([relative, text])
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}
