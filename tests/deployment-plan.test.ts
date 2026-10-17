import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { prepareDeployment, type DeploymentSpec } from '../src/deployment-plan.js'

function spec(workspace = resolve('/deployment-workspace')): DeploymentSpec {
  return {
    workspace,
    objective: 'Deploy adapter and its service definition',
    files: [
      { source: './staged/adapter.mjs', target: '/opt/harness/adapter.mjs', sourceSha256: 'AB'.repeat(32) },
      { source: 'staged/service.conf', target: '/etc/systemd/system/harness.service' },
    ],
    backupDirectory: '/var/backups/harness/deployment-42',
    receiptPath: './receipts/deployment-42.json',
    preflightChecks: ['Confirm the service is idle and the remote host is reachable'],
    applySteps: ['Copy the two mapped files', 'ssh deploy-host systemctl restart harness.service'],
    verificationChecks: ['ssh deploy-host systemctl is-active harness.service'],
    rollbackSteps: ['Restore both prior targets and restart harness.service only after a definite failure'],
    externalPaths: [
      { path: '/opt/harness/adapter.mjs', access: 'write', kind: 'file' },
      { path: '/etc/systemd/system/harness.service', access: 'write', kind: 'file' },
      { path: '/var/backups/harness/deployment-42', access: 'write', kind: 'directory' },
    ],
  }
}

test('deployment preparation preserves multiple targets, remote steps, hashes, and bounded scopes', () => {
  const original = spec()
  const prepared = prepareDeployment(original)
  assert.equal(prepared.checksExecuted, false)
  assert.equal(prepared.executionStatus, 'not_started')
  assert.equal(prepared.input.permissionPreset, 'danger-full-access')
  assert.equal(Object.hasOwn(prepared.input, 'confirmedDangerousPermission'), false)
  assert.equal(Object.hasOwn(prepared.input, 'authorizationBasis'), false)
  assert.deepEqual(prepared.input.reviewTargets, ['staged/adapter.mjs', 'staged/service.conf'])
  assert.deepEqual(prepared.input.writeScope, [
    '/opt/harness/adapter.mjs', '/etc/systemd/system/harness.service',
    '/var/backups/harness/deployment-42', 'receipts/deployment-42.json',
  ])
  for (const path of [...prepared.input.reviewTargets!, ...prepared.input.writeScope!]) {
    assert.ok(prepared.input.contextReadScope?.includes(path))
  }
  assert.deepEqual(prepared.input.externalPaths, original.externalPaths)
  assert.equal(prepared.manifest.files[0]?.sourceSha256, 'ab'.repeat(32))
  assert.equal(prepared.manifest.receiptPath, 'receipts/deployment-42.json')
  assert.match(prepared.input.task!, /ssh deploy-host systemctl restart harness\.service/u)
  assert.match(prepared.input.task!, /back up ALL existing mapped targets/u)
  assert.match(prepared.input.task!, /verify EACH source-to-target mapping/u)
  assert.match(prepared.input.task!, /do not blindly replay/u)
  assert.match(prepared.input.task!, /Write a JSON receipt/u)
  assert.match(prepared.input.task!, /sourceSha256/u)
  assert.match(prepared.input.task!, /"abababab/u)
  assert.equal(original.files[0]?.source, './staged/adapter.mjs')
  assert.equal(original.files[0]?.sourceSha256, 'AB'.repeat(32))
  prepared.manifest.applySteps.push('another step')
  assert.equal(original.applySteps.length, 2)
})

test('preparation performs no file changes, source reads, source dumps, or listed commands', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'deployment-plan-'))
  try {
    const source = join(workspace, 'source.txt')
    writeFileSync(source, 'SOURCE_CONTENT_MUST_NOT_BE_IN_TASK')
    const original = spec(workspace)
    original.files = [{ source: 'source.txt', target: 'target.txt' }, { source: 'not-created.txt', target: 'second.txt' }]
    original.backupDirectory = 'backups'
    original.applySteps = [`touch ${join(workspace, 'COMMAND_MUST_NOT_RUN')}`]
    const prepared = prepareDeployment(original)
    assert.deepEqual(readdirSync(workspace), ['source.txt'])
    assert.equal(readFileSync(source, 'utf8'), 'SOURCE_CONTENT_MUST_NOT_BE_IN_TASK')
    assert.doesNotMatch(prepared.input.task!, /SOURCE_CONTENT_MUST_NOT_BE_IN_TASK/u)
    assert.equal(prepared.manifest.files[0]?.sourceSha256, undefined)
    assert.deepEqual(prepared.input.writeScope, ['target.txt', 'second.txt', 'backups', 'receipts/deployment-42.json'])
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('absolute references inside workspace normalize to relative file paths', () => {
  const original = spec()
  original.files = [{ source: join(original.workspace, 'staged/adapter.mjs'), target: join(original.workspace, 'live/adapter.mjs') }]
  original.backupDirectory = join(original.workspace, 'backups')
  original.receiptPath = join(original.workspace, 'receipts/result.json')
  const prepared = prepareDeployment(original)
  assert.deepEqual(prepared.manifest.files, [{ source: 'staged/adapter.mjs', target: 'live/adapter.mjs' }])
  assert.equal(prepared.manifest.backupDirectory, 'backups')
  assert.equal(prepared.manifest.receiptPath, 'receipts/result.json')
})

test('remote file mappings stay in their host namespace and auxiliary local paths stay explicit', () => {
  const original = spec()
  original.files = [
    { source: 'src/bridge.py', host: 'existing-mac', target: '/Users/deploy/bridge.py' },
    { source: 'src/service.py', target: '/opt/harness/service.py' },
  ]
  original.contextPaths = ['work/deploy.py']
  original.writePaths = ['/opt/harness/release.json']
  const prepared = prepareDeployment(original)
  assert.equal(prepared.manifest.files[0]?.host, 'existing-mac')
  assert.equal(prepared.input.contextReadScope?.includes('/Users/deploy/bridge.py'), false)
  assert.equal(prepared.input.writeScope?.includes('/Users/deploy/bridge.py'), false)
  assert.ok(prepared.input.contextReadScope?.includes('work/deploy.py'))
  assert.ok(prepared.input.writeScope?.includes('/opt/harness/release.json'))
  assert.match(prepared.input.task!, /NOT a local path/u)
  assert.throws(() => prepareDeployment({ ...original, files: [{ source: 'src/bridge.py', host: 'mac; command', target: '/Users/deploy/bridge.py' }] }), /Remote host/u)
  assert.throws(() => prepareDeployment({ ...original, files: [{ source: 'src/bridge.py', host: 'mac', target: '/' + 'Users' + '/../bridge.py' }] }), /Remote target/u)
})

test('invalid or missing steps, objectives, hashes, and excessive inputs are rejected', () => {
  for (const field of ['preflightChecks', 'applySteps', 'verificationChecks', 'rollbackSteps'] as const) {
    for (const value of [undefined, [], [' '], Array.from({ length: 65 }, () => 'step')]) {
      assert.throws(() => prepareDeployment({ ...spec(), [field]: value } as DeploymentSpec), new RegExp(field, 'u'))
    }
  }
  assert.throws(() => prepareDeployment({ ...spec(), objective: ' ' }), /objective/u)
  assert.throws(() => prepareDeployment({ ...spec(), files: [] }), /files/u)
  assert.throws(() => prepareDeployment({ ...spec(), files: [{ source: 'source', target: 'target', sourceSha256: 'not-a-hash' }] }), /sourceSha256/u)
  assert.throws(() => prepareDeployment({ ...spec(), applySteps: ['x'.repeat(4097)] }), /applySteps/u)
})

test('traversal, outside sources/receipts, and non-file receipt references are rejected', () => {
  for (const source of ['../source', 'staged/../source', '/outside/source', 'staged\\..\\source', '.', 'staged/']) {
    assert.throws(() => prepareDeployment({ ...spec(), files: [{ source, target: 'live/target' }] }), /source/u)
  }
  for (const receiptPath of ['../receipt.json', '/outside/receipt.json', '.', 'receipts/', 'receipts/.', 'receipts/../receipt.json']) {
    assert.throws(() => prepareDeployment({ ...spec(), receiptPath }), /receiptPath/u)
  }
  assert.throws(() => prepareDeployment({ ...spec(), backupDirectory: '../backups' }), /backupDirectory/u)
})

test('normalized duplicate targets and cross-mapping source-target collisions are rejected', () => {
  const original = spec()
  original.files = [{ source: 'one', target: './live/target' }, { source: 'two', target: join(original.workspace, 'live/target') }]
  assert.throws(() => prepareDeployment(original), /duplicate deployment target/u)
  original.files = [{ source: 'one', target: 'two' }, { source: './two', target: 'three' }]
  assert.throws(() => prepareDeployment(original), /source-target collision/u)
  original.files = [{ source: 'one', target: 'target' }]
  assert.throws(() => prepareDeployment({ ...original, receiptPath: './target' }), /receiptPath must be distinct/u)
})
