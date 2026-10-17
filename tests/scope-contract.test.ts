import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.js'
import { RelayError, RelayFacade } from '../src/relay-broker/index.js'
import { resolveTaskScope, type StartRunInput } from '../src/relay-broker/run-input.js'

function invalid(field: string, reason: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RelayError)
    const result = error.toStructuredContent()
    assert.equal(result.code, 'TASK_SCOPE_INVALID')
    assert.equal(result.field, field)
    assert.equal(result.reason, reason)
    assert.equal(result.retryable, false)
    return true
  }
}

test('scope syntax failures expose a stable code and the precise field', () => {
  const workspace = process.cwd()
  const input = { workspace, reviewTargets: ['docs/plan.md'], contextReadScope: ['.'] }
  assert.throws(() => resolveTaskScope({ workspace, contextReadScope: ['.'] }), invalid('reviewTargets', 'required'))
  assert.throws(() => resolveTaskScope({ workspace, reviewTargets: ['plan.md'] }), invalid('contextReadScope', 'required'))
  assert.throws(() => resolveTaskScope({ ...input, reviewTargets: ['docs/plan.md', '../outside'] }), invalid('reviewTargets[1]', 'path_outside_workspace'))
  assert.throws(() => resolveTaskScope({ ...input, contextReadScope: ['..'] }), invalid('contextReadScope[0]', 'path_outside_workspace'))
  assert.throws(() => resolveTaskScope({ ...input, excludedPaths: ['../outside'] }), invalid('excludedPaths[0]', 'path_outside_workspace'))
  assert.throws(() => resolveTaskScope({ ...input, writeScope: ['file'] }), invalid('writeScope', 'read_only_write'))
  assert.throws(() => resolveTaskScope({ ...input, permissionPreset: 'workspace-write' }), invalid('writeScope', 'required'))
  assert.throws(() => resolveTaskScope({ ...input, contextReadScope: ['src'] }), invalid('reviewTargets[0]', 'target_outside_context'))
  assert.throws(() => resolveTaskScope({ ...input, excludedPaths: ['docs'] }), invalid('reviewTargets[0]', 'target_excluded'))
  assert.throws(() => resolveTaskScope({ ...input, reviewTargets: ['plan.md', '\0'] }), invalid('reviewTargets[1]', 'invalid_path'))
  assert.throws(() => resolveTaskScope({ ...input, reviewTargets: 'plan.md' } as unknown as StartRunInput), invalid('reviewTargets', 'invalid_type'))
  assert.throws(() => resolveTaskScope({ ...input, contextReadScope: [null] } as unknown as StartRunInput), invalid('contextReadScope[0]', 'invalid_path'))
  if (process.platform !== 'win32') {
    for (const target of ['C:\\external\\plan.md', 'C:/external/plan.md', 'C:plan.md', '\\\\server\\share\\plan.md']) {
      assert.throws(() => resolveTaskScope({ ...input, reviewTargets: [target] }), invalid('reviewTargets[0]', 'unsupported_path_platform'))
    }
    assert.deepEqual(resolveTaskScope({ ...input, reviewTargets: ['..\\literal-name'] })?.reviewTargets, ['..\\literal-name'])
  }
})

test('invalid mixed targets and symlink escapes never create a native session or prompt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'scope-admission-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'project'), outside = join(root, 'outside')
  await mkdir(workspace); await mkdir(outside)
  await mkdir(join(workspace, 'docs'))
  await writeFile(join(workspace, 'docs', 'plan.md'), 'fixture')
  await writeFile(join(outside, 'secret'), 'fixture')
  await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(join(outside, 'missing'), join(workspace, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
  const nativeMethods: string[] = []
  const native: typeof fetch = async (_url, init) => {
    const { method, rpcId } = JSON.parse(String(init?.body))
    nativeMethods.push(method)
    assert.equal(method, 'workspace.list', 'invalid scope must not cause native session or permission changes')
    return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { items: [{ workspaceId: 'project', path: workspace, sessionIds: [] }], archivedSessionIds: [] } } }))
  }
  const relay = new RelayFacade(resolveConfig({ DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace, DSH_RELAY_STATE_FILE: join(root, 'state.json') }), native)
  for (const [target, reason] of [
    [join(outside, 'secret'), 'path_outside_workspace'],
    ['../outside/secret', 'path_outside_workspace'],
    ['escape/secret', 'path_outside_workspace'],
    ['dangling/child', 'path_outside_workspace'],
  ] as const) {
    const input = { workspace, task: 'review named paths', reviewTargets: ['docs/plan.md', target], contextReadScope: ['.'] }
    await assert.rejects(relay.startRun(input), invalid('reviewTargets[1]', reason))
    await assert.rejects(relay.validateTaskScope(input), invalid('reviewTargets[1]', reason))
  }
  const valid = await relay.validateTaskScope({ workspace, reviewTargets: ['docs/plan.md', 'docs/new-plan.md'], contextReadScope: ['docs'] })
  assert.equal(valid.valid, true)
  assert.equal(valid.executionStatus, 'not_started')
  assert.deepEqual(valid.taskScope?.reviewTargets, ['docs/plan.md', 'docs/new-plan.md'])
  assert.deepEqual(new Set(nativeMethods), new Set(['workspace.list']))
  assert.deepEqual(await relay.listRuns(), [])
})
