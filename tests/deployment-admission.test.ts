import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.js'
import { prepareDeployment } from '../src/deployment-plan.js'
import { RelayFacade } from '../src/relay-broker/index.js'
import { HarnessGatewayFacade, type HarnessGatewayProvider, type TypertGatewayPort } from '../src/harness-gateway/index.js'
import { NativeControlFacade } from '../src/native-control/index.js'
import type { ExternalPathGrant } from '../src/types.js'

test('external deployment admission persists its grants, replays once and inherits after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deployment-admission-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'project'), target = join(root, 'runtime', 'service.py')
  await mkdir(workspace); await mkdir(join(root, 'runtime'))
  const grant: ExternalPathGrant = { path: target, access: 'write', kind: 'file' }
  const config = resolveConfig({ DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace, DSH_RELAY_STATE_FILE: join(root, 'state.json'), DSH_RELAY_EXTERNAL_PATHS_JSON: JSON.stringify([grant]) })
  let prompts = 0
  const histories = new Map<string, unknown[]>()
  const methods: string[] = []
  const fakeFetch: typeof fetch = async (_url, init) => {
    const { method, payload, rpcId } = JSON.parse(String(init?.body))
    methods.push(method)
    const sessionId = String(payload.sessionId)
    let value: unknown
    switch (method) {
      case 'workspace.list': value = { items: [{ workspaceId: 'project', path: workspace, sessionIds: [...histories.keys()] }], archivedSessionIds: [] }; break
      case 'host.describe': value = {}; break
      case 'session.create': { const id = `session-${histories.size}`; histories.set(id, []); value = { sessionId: id, agentPreset: 'standard' }; break }
      case 'session.list': value = { items: [...histories.keys()].map(id => ({ sessionId: id, running: false })) }; break
      case 'session.history': value = { events: (histories.get(sessionId) ?? []).map(event => ({ event })), hasMore: false, projections: { values: { permissions: { currentValue: 'danger-full-access' } } } }; break
      case 'session.prompt': {
        prompts++
        const events = histories.get(sessionId)!
        const seq = events.length
        events.push({ type: 'user/message', seq: seq + 1, time: 1, data: { id: 'prompt-' + prompts, source: { kind: 'user', rpcId } } },
          { type: 'assistant/message', seq: seq + 2, time: 2, data: { message: { content: [{ type: 'text', text: 'fixture deployment result' }] } } },
          { type: 'turn/end', seq: seq + 3, time: 3, data: { reason: { kind: 'completed' } } })
        value = { accepted: true }; break
      }
      default: throw new Error('Unexpected native method ' + method)
    }
    return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const input = prepareDeployment({ workspace, objective: 'fixture only', files: [{ source: 'service.py', target }], backupDirectory: 'backups', receiptPath: 'receipt.json', preflightChecks: ['fixture preflight'], applySteps: ['fixture apply'], verificationChecks: ['fixture verification'], rollbackSteps: ['fixture rollback'], externalPaths: [grant] }).input
  input.confirmedDangerousPermission = true
  input.idempotencyKey = 'external-deploy-fixture'
  const relay = new RelayFacade(config, fakeFetch)
  const denied = new RelayFacade({ ...config, externalPathPolicy: [] }, fakeFetch)
  await assert.rejects(denied.startRun(input), { code: 'EXTERNAL_PATH_DENIED' })
  assert.equal(methods.includes('session.create'), false)
  assert.equal(prompts, 0)
  const started = await relay.startRun(input)
  assert.equal(started.status, 'succeeded')
  assert.deepEqual(started.taskScope?.externalPaths, [grant])
  assert.equal((await relay.startRun(input)).runId, started.runId)
  assert.equal(prompts, 1)
  const persisted = JSON.parse(await readFile(config.stateFile, 'utf8'))
  assert.deepEqual(persisted.runs[0].snapshot.taskScope.externalPaths, [grant])
  const restarted = new RelayFacade(config, fakeFetch)
  assert.deepEqual((await restarted.getRun(started.runId)).taskScope?.externalPaths, [grant])
  const continued = await restarted.replyRun(started.runId, { task: 'inspect original deployment receipt only', confirmedDangerousPermission: true, idempotencyKey: 'external-deploy-continue' })
  assert.deepEqual(continued.taskScope, started.taskScope)
  assert.equal(continued.sessionId, started.sessionId)
  assert.equal(prompts, 2)
})

test('recorded artifact scope reads the exact external target, honors exclusions and policy revocation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deployment-evidence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'project'), runtime = join(root, 'runtime'), target = join(runtime, 'service.py')
  await mkdir(workspace); await mkdir(runtime)
  await writeFile(target, 'verified deployed bytes'); await writeFile(join(runtime, 'sibling'), 'must not read')
  const grant: ExternalPathGrant = { path: target, access: 'write', kind: 'file' }
  const scope = { reviewTargets: ['service.py'], contextReadScope: ['service.py', target], writeScope: [target], excludedPaths: [], externalPaths: [grant], enforcement: 'instruction-only' as const }
  const gateway = new HarnessGatewayFacade({ listWorkspaces: async () => ({ items: [{ workspaceId: 'project', path: workspace, sessionIds: [] }] }) } as unknown as HarnessGatewayProvider)
  const makeControl = (policy = [grant]) => new NativeControlFacade({ gateway, typert: {} as TypertGatewayPort, allowedWorkspaceRoots: [workspace], externalPathPolicy: policy })
  const result = await makeControl().readScopedArtifact({ workspace, path: target, scope, maxBytes: 8 })
  assert.equal(Buffer.from(result.data, 'base64').toString(), 'verified')
  assert.equal(result.reference.path, target)
  assert.equal(result.nextOffsetBytes, 8)
  await assert.rejects(makeControl().readArtifact({ workspace, path: target }), { code: 'ARTIFACT_PATH_DENIED' })
  await assert.rejects(makeControl().readScopedArtifact({ workspace, path: join(runtime, 'sibling'), scope }), { code: 'ARTIFACT_PATH_DENIED' })
  await assert.rejects(makeControl().readScopedArtifact({ workspace, path: target, scope: { ...scope, excludedPaths: [target] } }), { code: 'ARTIFACT_PATH_DENIED' })
  await assert.rejects(makeControl([]).readScopedArtifact({ workspace, path: target, scope }), { code: 'EXTERNAL_PATH_DENIED' })
  await assert.rejects(makeControl().readScopedArtifact({ workspace, path: target, scope: undefined }), { code: 'ARTIFACT_SCOPE_REQUIRED' })
  await symlink(target, join(runtime, 'alias'))
  const directory: ExternalPathGrant = { path: runtime, access: 'read', kind: 'directory' }
  const aliasScope = { ...scope, contextReadScope: [runtime], writeScope: [], externalPaths: [directory] }
  await assert.rejects(makeControl([directory]).readScopedArtifact({ workspace, path: join(runtime, 'alias'), scope: aliasScope }), { code: 'ARTIFACT_READ_FAILED' })
})
