import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const python = process.platform === 'win32' ? 'python' : 'python3'
const script = new URL('../skills/delegate-to-deepseek-harness/scripts/build_task_manifest.py', import.meta.url)
const scriptPath = fileURLToPath(script)

test('task manifest exposes only authorized locations and scope without reading source contents', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-relay-task-contract-'))
  try {
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'secret.ts'), 'const SOURCE_BODY_MUST_NOT_LEAVE_WORKSPACE = true\n', 'utf8')

    const execution = runManifest([
      workspace,
      '--path', 'src',
      '--context-path', '.',
      '--exclude-path', 'dist',
      '--scope', '审查 src 中的任务契约并返回可复现发现',
    ])
    assert.equal(execution.status, 0, execution.stderr)
    const manifest = JSON.parse(execution.stdout) as Record<string, unknown>
    assert.deepEqual(Object.keys(manifest), [
      'schemaVersion',
      'sourceTransferPolicy',
      'workspaceRoot',
      'permissionMode',
      'scope',
      'reviewTargets',
      'contextReadScope',
      'excludedPaths',
      'writeScope',
      'scopeEnforcement',
    ])
    assert.equal(manifest.schemaVersion, 3)
    assert.equal(manifest.sourceTransferPolicy, 'path-reference-only')
    assert.equal(manifest.permissionMode, 'read-only')
    assert.deepEqual(manifest.reviewTargets, ['src'])
    assert.deepEqual(manifest.contextReadScope, ['.'])
    assert.deepEqual(manifest.excludedPaths, ['dist'])
    assert.deepEqual(manifest.writeScope, [])
    assert.equal(manifest.scopeEnforcement, 'instruction-only')
    assert.doesNotMatch(execution.stdout, /SOURCE_BODY_MUST_NOT_LEAVE_WORKSPACE|sha256|fileCount|bytes|lines/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('write authorization keeps the same path-reference-only contract and requires explicit write locations', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-relay-write-contract-'))
  try {
    mkdirSync(join(workspace, 'src'))
    const valid = runManifest([
      workspace,
      '--path', 'src',
      '--context-path', 'src',
      '--write-path', 'src',
      '--scope', '在 src 内实施已请求的修改并运行相关测试',
      '--permission-mode', 'workspace-write',
    ])
    assert.equal(valid.status, 0, valid.stderr)
    const manifest = JSON.parse(valid.stdout) as { sourceTransferPolicy: string; writeScope: string[] }
    assert.equal(manifest.sourceTransferPolicy, 'path-reference-only')
    assert.deepEqual(manifest.writeScope, ['src'])

    const missingWriteLocation = runManifest([
      workspace,
      '--path', 'src',
      '--context-path', 'src',
      '--scope', '在 src 内实施已请求的修改',
      '--permission-mode', 'workspace-write',
    ])
    assert.notEqual(missingWriteLocation.status, 0)
    assert.match(missingWriteLocation.stderr, /require at least one --write-path/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('task manifest rejects multiline payloads and workspace escapes', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-relay-scope-contract-'))
  try {
    const multiline = runManifest([
      workspace,
      '--path', '.',
      '--context-path', '.',
      '--scope', 'review\nconst embedded = true',
    ])
    assert.notEqual(multiline.status, 0)
    assert.match(multiline.stderr, /single-line instructions/u)

    const escaped = runManifest([
      workspace,
      '--path', '..',
      '--context-path', '.',
      '--scope', 'review parent',
    ])
    assert.notEqual(escaped.status, 0)
    assert.match(escaped.stderr, /path escapes workspace/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('task manifest rejects a context symlink that resolves outside the workspace', t => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-relay-symlink-contract-'))
  const outside = mkdtempSync(join(tmpdir(), 'dsh-relay-outside-'))
  try {
    try {
      symlinkSync(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`symlink creation is unavailable: ${String(error)}`)
      return
    }
    const escaped = runManifest([
      workspace,
      '--path', '.',
      '--context-path', 'escape',
      '--scope', 'review workspace context',
    ])
    assert.notEqual(escaped.status, 0)
    assert.match(escaped.stderr, /path escapes workspace/u)

    mkdirSync(join(workspace, 'docs'))
    writeFileSync(join(workspace, 'docs', 'plan.md'), '# plan\n', 'utf8')
    mkdirSync(join(workspace, 'src'))
    const targetOutsideContext = runManifest([
      workspace,
      '--path', 'docs/plan.md',
      '--context-path', 'src',
      '--scope', 'review plan against source',
    ])
    assert.notEqual(targetOutsideContext.status, 0)
    assert.match(targetOutsideContext.stderr, /review target is outside context read scope/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('external file read grants preserve path-only manifests and reject undeclared siblings', () => {
  withExternalFixture((workspace, outside) => {
    const source = join(outside, 'source.ts')
    const sibling = join(outside, 'sibling.ts')
    const base = [workspace, '--external-read-file', source, '--scope', 'review the declared external source']
    const valid = runManifest([...base, '--path', source, '--context-path', source])
    assert.equal(valid.status, 0, valid.stderr)
    const manifest = JSON.parse(valid.stdout)
    const canonical = realpathSync(source).replaceAll('\\', '/')
    assert.equal(manifest.schemaVersion, 4)
    assert.deepEqual(manifest.externalPaths, [{ path: canonical, access: 'read', kind: 'file' }])
    assert.deepEqual(manifest.reviewTargets, [canonical])
    assert.deepEqual(manifest.contextReadScope, [canonical])
    assert.doesNotMatch(valid.stdout, /EXTERNAL_SOURCE_BODY_MUST_NOT_LEAVE/u)

    for (const args of [
      ['--path', sibling, '--context-path', source],
      ['--path', source, '--context-path', outside],
      ['--path', source, '--context-path', source, '--exclude-path', sibling],
    ]) {
      const invalid = runManifest([...base, ...args])
      assert.notEqual(invalid.status, 0)
      assert.match(invalid.stderr, /path escapes workspace/u)
    }
    const outsideContext = runManifest([...base, '--path', source, '--context-path', '.'])
    assert.notEqual(outsideContext.status, 0)
    assert.match(outsideContext.stderr, /review target is outside context read scope/u)
  })
})

test('external directory grants allow children but do not authorize relative workspace traversal', () => {
  withExternalFixture((workspace, outside) => {
    const source = join(outside, 'source.ts')
    const valid = runManifest([
      workspace, '--external-read-directory', outside,
      '--path', source, '--context-path', outside, '--scope', 'review external sources',
    ])
    assert.equal(valid.status, 0, valid.stderr)
    assert.deepEqual(JSON.parse(valid.stdout).externalPaths, [
      { path: realpathSync(outside).replaceAll('\\', '/'), access: 'read', kind: 'directory' },
    ])
    const traversal = runManifest([
      workspace, '--external-read-directory', outside,
      '--path', relative(workspace, source), '--context-path', outside, '--scope', 'review external sources',
    ])
    assert.notEqual(traversal.status, 0)
    assert.match(traversal.stderr, /path escapes workspace/u)
  })
})

test('external write grants require danger-full-access and never follow from read grants', () => {
  withExternalFixture((workspace, outside) => {
    const source = join(outside, 'source.ts')
    for (const mode of ['read-only', 'workspace-write']) {
      const invalid = runManifest([
        workspace, '--external-write-file', source, '--path', source, '--context-path', source,
        '--write-path', source, '--permission-mode', mode, '--scope', 'modify external source',
      ])
      assert.notEqual(invalid.status, 0)
      assert.match(invalid.stderr, /external write grants require --permission-mode danger-full-access/u)
    }
    const readOnlyGrant = runManifest([
      workspace, '--external-read-directory', outside, '--path', source, '--context-path', outside,
      '--write-path', source, '--permission-mode', 'danger-full-access', '--scope', 'modify external source',
    ])
    assert.notEqual(readOnlyGrant.status, 0)
    assert.match(readOnlyGrant.stderr, /path escapes workspace/u)

    const valid = runManifest([
      workspace, '--external-write-file', source, '--path', source, '--context-path', source,
      '--write-path', source, '--permission-mode', 'danger-full-access', '--scope', 'modify external source',
    ])
    assert.equal(valid.status, 0, valid.stderr)
    const canonical = realpathSync(source).replaceAll('\\', '/')
    assert.deepEqual(JSON.parse(valid.stdout).externalPaths, [{ path: canonical, access: 'write', kind: 'file' }])
    assert.deepEqual(JSON.parse(valid.stdout).writeScope, [canonical])

    const sibling = runManifest([
      workspace, '--external-write-file', source, '--path', source, '--context-path', source,
      '--write-path', join(outside, 'sibling.ts'), '--permission-mode', 'danger-full-access', '--scope', 'modify external source',
    ])
    assert.notEqual(sibling.status, 0)
    assert.match(sibling.stderr, /path escapes workspace/u)
  })
})

test('repeatable external grants support a new write target inside a declared directory', () => {
  withExternalFixture((workspace, outside) => {
    const source = join(outside, 'source.ts')
    const sibling = join(outside, 'sibling.ts')
    const output = join(outside, 'output')
    mkdirSync(output)
    const valid = runManifest([
      workspace, '--external-read-file', source, '--external-read-file', sibling,
      '--external-write-directory', output, '--external-write-directory', output,
      '--path', source, '--path', sibling, '--context-path', source, '--context-path', sibling, '--context-path', output,
      '--write-path', join(output, 'new.ts'), '--permission-mode', 'danger-full-access', '--scope', 'write derived external output',
    ])
    assert.equal(valid.status, 0, valid.stderr)
    const manifest = JSON.parse(valid.stdout)
    assert.equal(manifest.externalPaths.length, 3)
    assert.deepEqual(manifest.writeScope, [`${realpathSync(output).replaceAll('\\', '/')}/new.ts`])
  })
})

test('external directory grants reject a symlink child escaping the declared directory', t => {
  withExternalFixture((workspace, outside) => {
    const allowed = join(outside, 'allowed')
    const escaped = join(outside, 'escaped')
    mkdirSync(allowed)
    mkdirSync(escaped)
    writeFileSync(join(escaped, 'secret.ts'), 'EXTERNAL_SOURCE_BODY_MUST_NOT_LEAVE', 'utf8')
    const link = join(allowed, 'link')
    try {
      symlinkSync(escaped, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`symlink creation is unavailable: ${String(error)}`)
      return
    }
    for (const access of ['read', 'write']) {
      const invalid = runManifest([
        workspace, `--external-${access}-directory`, allowed,
        '--path', access === 'read' ? join(link, 'secret.ts') : allowed, '--context-path', allowed,
        ...(access === 'write' ? ['--write-path', join(link, 'new.ts'), '--permission-mode', 'danger-full-access'] : []),
        '--scope', 'access a declared directory child',
      ])
      assert.notEqual(invalid.status, 0)
      assert.match(invalid.stderr, /path escapes workspace/u)
    }
  })
})

test('external grant declarations require absolute paths and matching kinds, and help explains server policy', () => {
  withExternalFixture((workspace, outside) => {
    for (const declaration of [
      ['--external-read-file', 'relative.ts'],
      ['--external-read-file', outside],
      ['--external-read-directory', join(outside, 'source.ts')],
    ]) {
      const invalid = runManifest([workspace, '--path', '.', '--context-path', '.', '--scope', 'review workspace', ...declaration])
      assert.notEqual(invalid.status, 0)
      assert.match(invalid.stderr, /external paths must be absolute|does not match kind/u)
    }
  })
  const help = runManifest(['--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout.replaceAll(/\s+/gu, ' '), /server checks its own configured external-path policy/u)
})

function withExternalFixture(run: (workspace: string, outside: string) => void) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-manifest-workspace-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-manifest-external-')))
  try {
    writeFileSync(join(outside, 'source.ts'), 'EXTERNAL_SOURCE_BODY_MUST_NOT_LEAVE', 'utf8')
    writeFileSync(join(outside, 'sibling.ts'), 'EXTERNAL_SOURCE_BODY_MUST_NOT_LEAVE', 'utf8')
    run(workspace, outside)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
}

function runManifest(args: string[]) {
  return spawnSync(python, ['-X', 'utf8', scriptPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
}

// Ensure the packaged script itself remains strict UTF-8 without a BOM.
assert.equal(readFileSync(script).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false)
