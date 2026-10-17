import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { PermissionGatewayFacade, type PermissionPreset } from '../src/permission-gateway/index.js'
import { RelayError, RelayFacade } from '../src/relay-broker/index.js'
import { RelayStateStore } from '../src/state-store.js'
import { createHttpHarnessGateway } from '../src/harness-gateway/index.js'
import type { OperationRecord, PersistedRelayStateV3, RpcEvent } from '../src/types.js'

const workspace = fileURLToPath(new URL('../', import.meta.url))

for (const stage of ['submitted', 'correlation'] as const) {
  test(`failure persisting ${stage} before dispatch stays unsubmitted across replay and restart`, async t => {
    const fixture = await setup(t)
    fixture.mintRpcId = stage === 'correlation'
    const input = { workspace, task: 'never sent', idempotencyKey: `checkpoint-${stage}` }
    const save = RelayStateStore.prototype.save
    let injected = false
    t.mock.method(RelayStateStore.prototype, 'save', async function (this: RelayStateStore, state: Parameters<RelayStateStore['save']>[0]) {
      const target = state.operations.find(op => op.idempotencyKey === input.idempotencyKey)
      const boundary = target?.state === 'submitted' && (stage === 'submitted' || target.rpcId.endsWith('-native'))
      if (!injected && boundary) {
        injected = true
        throw new Error(`synthetic ${stage} checkpoint failure`)
      }
      return save.call(this, state)
    })
    const original = await failure(fixture.relay.startRun(input))
    assert.equal(injected, true)
    assert.equal(original.code, 'OPERATION_FAILED')
    assert.equal(original.details.promptAdmission, 'not_submitted')
    assert.equal(original.details.lastKnownState, 'failed')
    assert.equal(fixture.prompts, 0)
    const persisted = await fixture.state()
    assert.equal(persisted.operations[0]!.failure?.promptAdmission, 'not_submitted')
    assert.equal(persisted.runs[0]!.snapshot.status, 'failed')
    const calls = fixture.nativeCalls
    const duplicates = await Promise.all(Array.from({ length: 3 }, () => failure(fixture.relay.startRun(input))))
    duplicates.push(await failure(fixture.restore().startRun(input)))
    for (const replay of duplicates) assert.deepEqual(replay.toStructuredContent(), original.toStructuredContent())
    assert.equal(fixture.nativeCalls, calls)
    assert.equal(fixture.prompts, 0)
  })
}

test('definitive prompt rejection retains its error and admission when the run snapshot is missing', async t => {
  const fixture = await setup(t)
  fixture.rejectPrompt = true
  const input = { workspace, task: 'rejected prompt', idempotencyKey: 'native-rejection' }
  const original = await fixture.relay.startRun(input)
  assert.equal(original.status, 'failed')
  assert.equal(original.promptAdmission, 'rejected')
  const duplicate = await fixture.relay.startRun(input)
  assert.deepEqual(duplicate, original)
  const persisted = await fixture.state()
  assert.equal(persisted.operations[0]!.failure?.code, 'INVALID_REQUEST')
  persisted.runs = []
  await writeFile(fixture.config.stateFile, JSON.stringify(persisted))
  const replay = await failure(fixture.restore().startRun(input))
  assert.equal(replay.code, 'INVALID_REQUEST')
  assert.equal(replay.details.promptAdmission, 'rejected')
  assert.equal(replay.details.lastKnownState, 'failed')
  assert.equal(replay.details.nextAction, 'none')
  assert.equal(fixture.prompts, 0)
})

test('failure after the prompt reaches the transport remains unknown and never redispatches', async t => {
  const fixture = await setup(t)
  fixture.failMethod = 'session.prompt'
  const input = { workspace, task: 'lost prompt response', idempotencyKey: 'transport-unknown' }
  const original = await fixture.relay.startRun(input)
  assert.equal(fixture.promptAttempts, 1)
  assert.equal(original.promptAdmission, 'unknown')
  const persisted = await fixture.state()
  assert.equal(persisted.operations[0]!.state, 'unknown')
  assert.equal(persisted.operations[0]!.failure, undefined)
  persisted.runs = []
  await writeFile(fixture.config.stateFile, JSON.stringify(persisted))
  const replay = await failure(fixture.restore().startRun(input))
  assert.equal(replay.code, 'OPERATION_UNKNOWN')
  assert.equal(replay.details.promptAdmission, 'unknown')
  assert.equal(fixture.promptAttempts, 1)
})

test('reply permission admission failures retain their original IDs and error across concurrent replay and restart', async t => {
  const fixture = await setup(t)
  const parent = await fixture.relay.startRun({ workspace, task: 'parent' })
  fixture.complete(parent.sessionId)
  assert.equal((await fixture.relay.getRun(parent.runId)).status, 'succeeded')
  fixture.denyPermission = true
  let entered!: () => void
  let release!: () => void
  const enteredPermission = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  fixture.beforePermission = async () => { entered(); await gate }
  const input = { task: 'reply', permissionPreset: 'workspace-write' as const, idempotencyKey: 'failed-reply' }
  const first = failure(fixture.relay.replyRun(parent.runId, input))
  await enteredPermission
  const concurrent = await failure(fixture.relay.replyRun(parent.runId, input))
  assert.equal(concurrent.code, 'OPERATION_IN_PROGRESS')
  release()
  const original = await first
  assert.equal(original.code, 'PERMISSION_DENIED')
  assert.equal(original.details.promptAdmission, 'not_submitted')
  assert.equal(original.details.lastKnownState, 'failed')
  assert.ok(original.details.operationId)
  assert.ok(original.details.runId)
  assert.notEqual(original.details.runId, parent.runId)
  const state = await fixture.state()
  const operation = state.operations.find(item => item.operationId === original.details.operationId)!
  assert.equal(operation.kind, 'reply')
  assert.equal(operation.failure?.code, 'PERMISSION_DENIED')
  assert.equal(state.runs.some(item => item.snapshot.runId === operation.runId), false)
  const callerCopy = await fixture.relay.getOperation(operation.operationId)
  callerCopy.failure!.message = 'caller mutation must not change the journal'
  const selects = fixture.permissionSelections
  const nativeCalls = fixture.nativeCalls
  const duplicates = await Promise.all(Array.from({ length: 3 }, () => failure(fixture.relay.replyRun(parent.runId, input))))
  // A recorded rejection must remain available while the native Host is down.
  fixture.failMethod = 'workspace.list'
  const restarted = await failure(fixture.restore().replyRun(parent.runId, input))
  for (const replay of [...duplicates, restarted]) assert.deepEqual(replay.toStructuredContent(), original.toStructuredContent())
  assert.equal(fixture.permissionSelections, selects)
  // Recorded failures replay without depending on native connectivity.
  assert.equal(fixture.nativeCalls, nativeCalls)
  assert.equal(fixture.prompts, 1)
})

test('post-claim service and session admission errors are durably replayed as unsubmitted', async t => {
  for (const stage of ['host.describe', 'session.create']) {
    await t.test(stage, async t => {
      const fixture = await setup(t)
      fixture.failMethod = stage
      const input = { workspace, task: 'never submitted', idempotencyKey: stage }
      const original = await failure(fixture.relay.startRun(input))
      assert.equal(original.details.promptAdmission, 'not_submitted')
      assert.equal(original.details.lastKnownState, 'failed')
      assert.ok(original.details.operationId)
      assert.ok(original.details.runId)
      const nativeCalls = fixture.nativeCalls
      fixture.failMethod = undefined
      const replay = await failure(fixture.restore().startRun(input))
      assert.deepEqual(replay.toStructuredContent(), original.toStructuredContent())
      assert.equal(fixture.nativeCalls, nativeCalls)
      assert.equal(fixture.prompts, 0)
      assert.equal((await fixture.state()).operations.length, 1)
    })
  }
})

test('errors after prompt acknowledgement preserve accepted admission even without a snapshot', async t => {
  const fixture = await setup(t)
  fixture.failAfterPrompt = true
  const input = { workspace, task: 'accepted before read failed', idempotencyKey: 'accepted-error' }
  const original = await failure(fixture.relay.startRun(input))
  assert.equal(original.details.promptAdmission, 'accepted')
  assert.equal(original.details.lastKnownState, 'acknowledged')
  const state = await fixture.state()
  assert.equal(state.operations[0]!.failure?.promptAdmission, 'accepted')
  assert.equal(state.operations[0]!.messageId, 'message-1')
  state.runs = []
  await writeFile(fixture.config.stateFile, JSON.stringify(state))
  fixture.failAfterPrompt = false
  const replay = await failure(fixture.restore().startRun(input))
  assert.deepEqual(replay.toStructuredContent(), original.toStructuredContent())
  assert.equal(fixture.prompts, 1)
})

test('missing snapshots fail closed and use positive acceptance evidence instead of inferring rejection', async t => {
  const cases: Array<{ state: OperationRecord['state']; messageId: string | null; code: string; admission: string }> = [
    { state: 'failed', messageId: null, code: 'OPERATION_FAILED', admission: 'unknown' },
    { state: 'failed', messageId: 'durable-message', code: 'OPERATION_FAILED', admission: 'accepted' },
    { state: 'submitted', messageId: null, code: 'OPERATION_UNKNOWN', admission: 'unknown' },
    { state: 'unknown', messageId: null, code: 'OPERATION_UNKNOWN', admission: 'unknown' },
    { state: 'acknowledged', messageId: null, code: 'OPERATION_UNKNOWN', admission: 'accepted' },
    { state: 'reconciled', messageId: 'durable-message', code: 'OPERATION_UNKNOWN', admission: 'accepted' },
    { state: 'prepared', messageId: null, code: 'OPERATION_UNKNOWN', admission: 'unknown' },
  ]
  for (const expected of cases) {
    await t.test(`${expected.state}/${expected.messageId ?? 'no message'}`, async t => {
      const fixture = await setup(t)
      const input = { workspace, task: 'original', idempotencyKey: 'original' }
      await fixture.relay.startRun(input)
      const state = await fixture.state()
      const operation = state.operations[0]!
      operation.state = expected.state
      operation.messageId = expected.messageId
      operation.error = 'legacy original error'
      operation.updatedAt = '2020-01-01T00:00:00.000Z'
      state.runs = []
      await writeFile(fixture.config.stateFile, JSON.stringify(state))
      const relay = fixture.restore()
      const errors = await Promise.all(Array.from({ length: 3 }, () => failure(relay.startRun(input))))
      errors.push(await failure(fixture.restore().startRun(input)))
      for (const error of errors) {
        assert.equal(error.code, expected.code)
        assert.equal(error.details.promptAdmission, expected.admission)
        assert.equal(error.details.operationId, operation.operationId)
        assert.equal(error.details.runId, operation.runId)
        assert.equal(error.details.nextAction, 'reconcile')
      }
      assert.equal(fixture.prompts, 1)
      assert.equal((await fixture.state()).operations.length, 1)
    })
  }
})

test('expired submitted or prepared snapshots never cause a second prompt dispatch', async t => {
  for (const operationState of ['prepared', 'submitted'] as const) {
    await t.test(operationState, async t => {
      const fixture = await setup(t)
      const input = { workspace, task: 'original', idempotencyKey: 'once' }
      await fixture.relay.startRun(input)
      const state = await fixture.state()
      const operation = state.operations[0]!
      operation.state = operationState
      operation.messageId = null
      operation.updatedAt = '2020-01-01T00:00:00.000Z'
      state.runs[0]!.snapshot.promptAdmission = 'pending'
      state.runs[0]!.snapshot.promptMessageId = null
      fixture.events.clear()
      await writeFile(fixture.config.stateFile, JSON.stringify(state))
      const error = await failure(fixture.restore().startRun(input))
      assert.equal(error.code, 'OPERATION_UNKNOWN')
      assert.equal(error.details.promptAdmission, 'unknown')
      assert.equal(fixture.prompts, 1)
    })
  }
})

interface Fixture {
  config: ReturnType<typeof resolveConfig>
  relay: RelayFacade
  denyPermission: boolean
  permissionSelections: number
  nativeCalls: number
  prompts: number
  promptAttempts: number
  failMethod: string | undefined
  failAfterPrompt: boolean
  mintRpcId: boolean
  rejectPrompt: boolean
  beforePermission?: () => Promise<void>
  events: Map<string, RpcEvent[]>
  restore(): RelayFacade
  complete(sessionId: string): void
  state(): Promise<PersistedRelayStateV3>
}

async function setup(t: TestContext): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'relay-failed-admission-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = resolveConfig({ DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace, DSH_RELAY_STATE_FILE: join(directory, 'state.json') })
  const events = new Map<string, RpcEvent[]>()
  const running = new Map<string, boolean>()
  let permission: PermissionPreset = 'read-only'
  let sessions = 0
  const fixture = {
    config, events, denyPermission: false, permissionSelections: 0, nativeCalls: 0, prompts: 0, promptAttempts: 0,
    failMethod: undefined, failAfterPrompt: false, mintRpcId: false, rejectPrompt: false,
  } as Fixture
  const permissions = new PermissionGatewayFacade({
    readCurrent: async () => permission,
    select: async (_sessionId, preset) => {
      fixture.permissionSelections += 1
      await fixture.beforePermission?.()
      if (fixture.denyPermission && preset !== 'read-only') return { accepted: false }
      permission = preset
      return { accepted: true }
    },
  })
  const fakeFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; rpcId: string; payload: Record<string, unknown> }
    const sessionId = String(request.payload.sessionId)
    if (request.method === 'session.prompt') fixture.promptAttempts += 1
    if (request.method !== 'workspace.list') fixture.nativeCalls += 1
    if (request.method === fixture.failMethod || (fixture.failAfterPrompt && fixture.prompts > 0 && request.method === 'session.list')) {
      throw new Error(`fixture failure: ${request.method}`)
    }
    let value: unknown
    switch (request.method) {
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: [...running.keys()] }], archivedSessionIds: [] }; break
      case 'host.describe': value = {}; break
      case 'session.create': {
        const id = `session-${++sessions}`
        events.set(id, [])
        running.set(id, false)
        value = { sessionId: id, agentPreset: 'standard' }
        break
      }
      case 'session.list': value = { items: [...running].map(([sessionId, running]) => ({ sessionId, running })) }; break
      case 'session.history': value = {
        events: (events.get(sessionId) ?? []).map(event => ({ event })), hasMore: false,
      }; break
      case 'session.prompt': {
        if (fixture.rejectPrompt) return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: false, error: { code: 'INVALID_REQUEST', message: 'synthetic prompt rejection' } } }), { headers: { 'content-type': 'application/json' } })
        fixture.prompts += 1
        running.set(sessionId, true)
        events.get(sessionId)!.push({ type: 'user/message', seq: 1, time: 1, data: { id: `message-${fixture.prompts}`, source: { kind: 'user', rpcId: request.rpcId } } })
        value = { accepted: true, messageId: `message-${fixture.prompts}` }
        break
      }
      default: throw new Error(`unexpected method: ${request.method}`)
    }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }), {
      headers: { 'content-type': 'application/json' },
    })
  }
  fixture.restore = () => {
    const gateway = createHttpHarnessGateway(config.hostUrl, config.rpcTimeoutMs, fakeFetch)
    const submit = gateway.submitPrompt.bind(gateway)
    gateway.submitPrompt = async (sessionId, mode, content, preferredRpcId, beforeDispatch) => {
      if (!fixture.mintRpcId) return submit(sessionId, mode, content, preferredRpcId, beforeDispatch)
      const actualRpcId = `${preferredRpcId}-native`
      await beforeDispatch?.(actualRpcId)
      return submit(sessionId, mode, content, actualRpcId)
    }
    return new RelayFacade(config, fakeFetch, gateway, { permissionGateway: permissions })
  }
  fixture.relay = fixture.restore()
  fixture.complete = sessionId => {
    events.get(sessionId)!.push({ type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'completed' } } })
    running.set(sessionId, false)
  }
  fixture.state = async () => JSON.parse(await readFile(config.stateFile, 'utf8'))
  return fixture
}

async function failure(promise: Promise<unknown>): Promise<RelayError> {
  try { await promise }
  catch (error) {
    assert.ok(error instanceof RelayError)
    return error
  }
  assert.fail('expected a RelayError')
}
