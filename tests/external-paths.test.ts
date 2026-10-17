import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.js'
import { parseExternalPaths, pathContains, validateExternalPathPolicy, validateExternalTaskScope } from '../src/external-paths.js'
import { cloneRun } from '../src/relay-broker/helpers.js'
import { inheritTaskScope, resolveTaskScope } from '../src/relay-broker/run-input.js'
import { RelayError } from '../src/relay-broker/errors.js'
import type { ExternalPathGrant, RunSnapshot } from '../src/types.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'relay-external-paths-'))
  const workspace = join(root, 'workspace')
  const external = join(root, 'external')
  mkdirSync(workspace)
  mkdirSync(external)
  const file = join(external, 'adapter.mjs')
  writeFileSync(file, 'fixture')
  return { root, workspace, external, file, close: () => rmSync(root, { recursive: true, force: true }) }
}

const denied = { code: 'EXTERNAL_PATH_DENIED' }

test('an explicit external file needs matching owner policy and cannot authorize its sibling', async () => {
  const f = fixture()
  try {
    const grant: ExternalPathGrant = { path: f.file, access: 'read', kind: 'file' }
    const scope = resolveTaskScope({ workspace: f.workspace, reviewTargets: [f.file], contextReadScope: [f.file], externalPaths: [grant] })
    assert.deepEqual(scope?.reviewTargets, [f.file])
    await validateExternalTaskScope(scope, [grant])
    await assert.rejects(validateExternalTaskScope(scope), denied)
    await assert.rejects(validateExternalPathPolicy([{ ...grant, path: join(f.external, 'sibling.mjs') }], [grant]), denied)
    assert.throws(() => resolveTaskScope({ workspace: f.workspace, reviewTargets: [f.file], contextReadScope: [f.file] }), /escapes workspace/u)
  } finally { f.close() }
})

test('read and write grants remain distinct and external writes require full access', async () => {
  const f = fixture()
  try {
    const read: ExternalPathGrant = { path: f.file, access: 'read', kind: 'file' }
    const write: ExternalPathGrant = { ...read, access: 'write' }
    await validateExternalPathPolicy([read], [write])
    await assert.rejects(validateExternalPathPolicy([write], [read]), denied)
    const input = { workspace: f.workspace, reviewTargets: [f.file], contextReadScope: [f.file], writeScope: [f.file], externalPaths: [write] }
    assert.throws(() => resolveTaskScope({ ...input, permissionPreset: 'workspace-write' }), { code: 'EXTERNAL_WRITE_REQUIRES_FULL_ACCESS' })
    assert.throws(() => resolveTaskScope({ ...input, permissionPreset: 'read-only' }), /cannot declare external write/u)
    assert.throws(() => resolveTaskScope({ ...input, permissionPreset: 'danger-full-access', externalPaths: [read] }), /writeScope path escapes/u)
    await validateExternalTaskScope(resolveTaskScope({ ...input, permissionPreset: 'danger-full-access' }), [write])
  } finally { f.close() }
})

test('canonical checks reject symlink children escaping an allowed directory', async t => {
  const f = fixture()
  try {
    const outside = join(f.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'outside fixture')
    try { symlinkSync(outside, join(f.external, 'escape'), process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) { t.skip(`symlink unavailable: ${String(error)}`); return }
    const grant: ExternalPathGrant = { path: f.external, access: 'read', kind: 'directory' }
    const child = join(f.external, 'escape/secret.txt')
    const scope = resolveTaskScope({ workspace: f.workspace, reviewTargets: [child], contextReadScope: [f.external], externalPaths: [grant] })
    await assert.rejects(validateExternalTaskScope(scope, [grant]), denied)
  } finally { f.close() }
})

test('a missing deployment target is admitted through an existing authorized parent', async () => {
  const f = fixture()
  try {
    const directory: ExternalPathGrant = { path: f.external, access: 'write', kind: 'directory' }
    const target = join(f.external, 'not-created/subdirectory/adapter.mjs')
    const scope = resolveTaskScope({
      workspace: f.workspace, permissionPreset: 'danger-full-access', reviewTargets: ['staged.mjs'],
      contextReadScope: ['staged.mjs', target], writeScope: [target], externalPaths: [{ path: target, access: 'write', kind: 'file' }],
    })
    await validateExternalTaskScope(scope, [directory])
  } finally { f.close() }
})

test('project context dot does not include an absolute external review target', () => {
  const f = fixture()
  try {
    assert.throws(() => resolveTaskScope({
      workspace: f.workspace, reviewTargets: [f.file], contextReadScope: ['.'],
      externalPaths: [{ path: f.file, access: 'read', kind: 'file' }],
    }), /outside contextReadScope/u)
  } finally { f.close() }
})

test('inherited scopes and snapshot clones keep independent path arrays and external grants', () => {
  const f = fixture()
  try {
    const original = resolveTaskScope({
      workspace: f.workspace, permissionPreset: 'danger-full-access', reviewTargets: [f.file],
      contextReadScope: [f.file], excludedPaths: ['private'], writeScope: [f.file],
      externalPaths: [{ path: f.file, access: 'write', kind: 'file' }],
    })!
    const expected = structuredClone(original)
    for (const override of [{}, { excludedPaths: ['another-private'] }]) {
      const inherited = inheritTaskScope({ workspace: f.workspace, task: 'continue', ...override }, original)
      assert.deepEqual(inherited.externalPaths, expected.externalPaths)
      inherited.reviewTargets!.push('new-target')
      inherited.contextReadScope!.push('new-context')
      inherited.writeScope!.push('new-write')
      inherited.externalPaths![0]!.path = join(f.external, 'different')
      assert.deepEqual(original, expected)
    }
    const run = { taskScope: original, modelSelection: null, warnings: ['original'] } as RunSnapshot
    const clone = cloneRun(run)
    clone.taskScope!.reviewTargets.push('clone-target')
    clone.taskScope!.externalPaths![0]!.access = 'read'
    clone.warnings.push('clone-warning')
    assert.deepEqual(original, expected)
    assert.deepEqual(run.warnings, ['original'])
  } finally { f.close() }
})

test('operator policy config accepts JSON or file and rejects ambiguity and malformed grants', () => {
  const f = fixture()
  try {
    const grants: ExternalPathGrant[] = [{ path: f.file, access: 'read', kind: 'file' }]
    const json = JSON.stringify(grants)
    const file = join(f.root, 'policy.json')
    writeFileSync(file, json)
    assert.deepEqual(resolveConfig({ DSH_RELAY_EXTERNAL_PATHS_JSON: json }).externalPathPolicy, grants)
    assert.deepEqual(resolveConfig({ DSH_RELAY_EXTERNAL_PATHS_FILE: file }).externalPathPolicy, grants)
    assert.deepEqual(resolveConfig({}).externalPathPolicy, [])
    assert.throws(() => resolveConfig({ DSH_RELAY_EXTERNAL_PATHS_JSON: json, DSH_RELAY_EXTERNAL_PATHS_FILE: file }), /only one/u)
    assert.throws(() => resolveConfig({ DSH_RELAY_EXTERNAL_PATHS_JSON: '{' }), SyntaxError)
    assert.throws(() => resolveConfig({ DSH_RELAY_EXTERNAL_PATHS_JSON: JSON.stringify([{ ...grants[0], path: 'relative' }]) }), { code: 'INVALID_ARGUMENT' })
    assert.throws(() => parseExternalPaths([{ ...grants[0], access: 'execute' }]), { code: 'TASK_SCOPE_INVALID' })
    assert.throws(() => parseExternalPaths([{ ...grants[0], unexpected: true }]), { code: 'TASK_SCOPE_INVALID' })
    assert.throws(() => parseExternalPaths(Array.from({ length: 65 }, () => grants[0])), { code: 'TASK_SCOPE_INVALID' })
  } finally { f.close() }
})

function scopeFailure(code: string, field: string, reason: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RelayError)
    const details = error.toStructuredContent()
    assert.equal(details.code, code)
    assert.equal(details.field, field)
    assert.equal(details.reason, reason)
    assert.equal(details.retryable, false)
    assert.equal(details.nextAction, 'none')
    return true
  }
}

test('external admission reports the offending grant or target field', async () => {
  const f = fixture()
  try {
    const directory: ExternalPathGrant = { path: f.external, access: 'read', kind: 'directory' }
    const sibling = join(f.root, 'ungranted')
    assert.throws(() => parseExternalPaths([{ path: 'relative', access: 'read', kind: 'file' }]), scopeFailure('TASK_SCOPE_INVALID', 'externalPaths[0].path', 'absolute_path_required'))
    assert.throws(() => parseExternalPaths([{ ...directory, access: 'execute' }]), scopeFailure('TASK_SCOPE_INVALID', 'externalPaths[0].access', 'invalid_access'))
    await assert.rejects(validateExternalPathPolicy([directory, { path: sibling, access: 'read', kind: 'file' }], [directory]), scopeFailure('EXTERNAL_PATH_DENIED', 'externalPaths[1].path', 'outside_external_policy'))
    const outside = join(f.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret'), 'fixture')
    symlinkSync(outside, join(f.external, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const scope = resolveTaskScope({ workspace: f.workspace, reviewTargets: [f.file, join(f.external, 'alias', 'secret')], contextReadScope: [f.external], externalPaths: [directory] })
    await assert.rejects(validateExternalTaskScope(scope, [directory]), scopeFailure('EXTERNAL_PATH_DENIED', 'reviewTargets[1]', 'outside_external_policy'))
    await assert.rejects(validateExternalPathPolicy([{ ...directory, path: f.file }], [directory]), scopeFailure('TASK_SCOPE_INVALID', 'externalPaths[0].path', 'path_kind_mismatch'))
  } finally { f.close() }
})

test('missing targets cannot escape policy through a dangling symlink', async () => {
  const f = fixture()
  try {
    const outside = join(f.root, 'not-created')
    symlinkSync(outside, join(f.external, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
    const directory: ExternalPathGrant = { path: f.external, access: 'write', kind: 'directory' }
    for (const path of [join(f.external, 'dangling'), join(f.external, 'dangling', 'child')]) {
      await assert.rejects(validateExternalPathPolicy([{ path, access: 'write', kind: 'file' }], [directory]), scopeFailure('EXTERNAL_PATH_DENIED', 'externalPaths[0].path', 'outside_external_policy'))
    }
  } finally { f.close() }
})

test('canonical local scope accepts children and internal symlinks, rejects external and dangling aliases', async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.workspace, 'src'))
    writeFileSync(join(f.workspace, 'src', 'child'), 'fixture')
    symlinkSync(join(f.workspace, 'src'), join(f.workspace, 'inside'), process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(f.external, join(f.workspace, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(join(f.external, 'not-created'), join(f.workspace, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
    const local = resolveTaskScope({ workspace: f.workspace, reviewTargets: ['src/child', 'inside/child', 'src/not-created/child'], contextReadScope: ['.'] })
    await validateExternalTaskScope(local, [], f.workspace)
    for (const target of ['outside/adapter.mjs', 'dangling', 'dangling/child']) {
      const scope = resolveTaskScope({ workspace: f.workspace, reviewTargets: ['src/child', target], contextReadScope: ['.'] })
      await assert.rejects(validateExternalTaskScope(scope, [], f.workspace), scopeFailure('TASK_SCOPE_INVALID', 'reviewTargets[1]', 'path_outside_workspace'))
    }
    const workspaceAlias = join(f.root, 'workspace-alias')
    symlinkSync(f.workspace, workspaceAlias, process.platform === 'win32' ? 'junction' : 'dir')
    await validateExternalTaskScope(local, [], workspaceAlias)
  } finally { f.close() }
})

test('native path containment does not confuse siblings or POSIX backslashes', () => {
  const f = fixture()
  try {
    assert.equal(pathContains(f.external, f.file), true)
    assert.equal(pathContains(f.external, join(f.root, 'external-sibling', 'file')), false)
    if (process.platform !== 'win32') {
      assert.equal(pathContains(f.external, join(f.external, '..\\ordinary-file')), true)
      assert.throws(() => parseExternalPaths([{ path: 'C:\\tools\\file', access: 'read', kind: 'file' }]), scopeFailure('TASK_SCOPE_INVALID', 'externalPaths[0].path', 'unsupported_path_platform'))
    }
  } finally { f.close() }
})
