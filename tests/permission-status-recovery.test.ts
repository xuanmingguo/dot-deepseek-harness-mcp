import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { PermissionGatewayFacade } from '../src/permission-gateway/index.js'
import { PermissionController } from '../src/relay-broker/permission-controller.js'
import { RelayFacade } from '../src/relay-broker/index.js'
import { cloneRun } from '../src/relay-broker/helpers.js'
import type { PermissionLease, PermissionPreset, PersistedRelayState, RpcEvent, RunSnapshot } from '../src/types.js'

const workspace = fileURLToPath(new URL('../', import.meta.url))
const restoreWarning = 'Permission restoration requires attention before this session is reused'
const cases = [
  { native: 'completed', status: 'succeeded', error: null },
  { native: 'max-tokens', status: 'incomplete', error: null },
  { native: 'error', status: 'failed', error: 'MODEL_FAILURE: native failure' },
  { native: 'aborted', status: 'cancelled', error: null },
] as const

test('concurrent permission restore callers share one in-flight lease mutation', async () => {
  const sessionId = 'session-restore'
  const ownerOperationId = 'operation-restore'
  const lease: PermissionLease = {
    leaseId: 'lease-restore',
    sessionId,
    ownerOperationId,
    previousPermission: 'workspace-write',
    grantedPermission: 'read-only',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'acquired',
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  let current: PermissionPreset = 'read-only'
  let restoreCalls = 0
  let releaseRestore!: () => void
  let markRestoreStarted!: () => void
  const restoreGate = new Promise<void>(resolve => { releaseRestore = resolve })
  const restoreStarted = new Promise<void>(resolve => { markRestoreStarted = resolve })
  const gateway = new PermissionGatewayFacade({
    readCurrent: async () => current,
    select: async (_session, preset) => {
      restoreCalls += 1
      markRestoreStarted()
      await restoreGate
      current = preset
      return { accepted: true }
    },
  })
  const controller = new PermissionController(gateway, new Map([[lease.leaseId, lease]]), async () => {}, 60_000)
  const ownerRestore = controller.restoreSession(sessionId, ownerOperationId)
  let concurrentRestore: Promise<boolean> | undefined
  try {
    await restoreStarted
    concurrentRestore = controller.restoreSession(sessionId, ownerOperationId)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(restoreCalls, 1, 'the same permission lease is selected only once while restoration is pending')
    releaseRestore()
    assert.deepEqual(await Promise.all([ownerRestore, concurrentRestore]), [true, true])
    assert.equal(lease.state, 'released')
  } finally {
    releaseRestore()
    await Promise.allSettled([ownerRestore, ...(concurrentRestore === undefined ? [] : [concurrentRestore])])
  }
})

for (const outcome of cases) {
  test(`explicit permission recovery restores the actual native ${outcome.status} status in memory and on disk`, async t => {
    const fixture = await setup(t)
    fixture.nextOutcome = outcome.native
    const blocked = await fixture.relay.startRun({ workspace, task: 'native task' })
    assert.equal(blocked.status, 'needs_attention')
    assert.equal(blocked.attentionReason, 'permission_restore_failed')
    assert.notEqual(blocked.finishedAt, null)
    assert.deepEqual(blocked.executionOutcome, { status: outcome.status, error: outcome.error, finishedAt: blocked.finishedAt })
    assert.equal(blocked.permissionRestoration, 'failed')
    assert(blocked.warnings.includes(restoreWarning))
    // Permission-controller writes during finalization must not leave a false
    // terminal on disk while the same-process snapshot still needs attention.
    assert.equal((await fixture.state()).runs[0]!.snapshot.status, 'needs_attention')
    assert.deepEqual((await fixture.state()).runs[0]!.snapshot.executionOutcome, blocked.executionOutcome)
    assert.equal((await fixture.state()).runs[0]!.snapshot.permissionRestoration, 'failed')
    const restartedBlocked = fixture.restore(async () => { throw new Error('attention result must be retained without native reads') })
    assert.deepEqual((await restartedBlocked.getRun(blocked.runId)).executionOutcome, blocked.executionOutcome)
    // A caller cannot alter the retained execution result through a snapshot.
    const exposedOutcome: { error: string | null } = blocked.executionOutcome!
    exposedOutcome.error = 'caller mutation'
    fixture.blockRestore = false
    assert.deepEqual(await fixture.relay.reconcilePermissions(blocked.sessionId), { sessionId: blocked.sessionId, restored: true })
    // Check persistence BEFORE any getter can repair the in-memory snapshot.
    const persisted = (await fixture.state()).runs.find(run => run.snapshot.runId === blocked.runId)!.snapshot
    assertRecovered(persisted, outcome.status, outcome.error, blocked.finishedAt)
    assert.equal(persisted.permissionRestoration, 'complete')
    assert.equal(persisted.executionOutcome?.error, outcome.error)
    assertRecovered(await fixture.relay.getRun(blocked.runId), outcome.status, outcome.error, blocked.finishedAt)
    const summary = (await fixture.relay.listRuns()).find(run => run.runId === blocked.runId)!
    assertRecovered(summary, outcome.status, outcome.error, blocked.finishedAt)
    const restored = fixture.restore(async () => { throw new Error('persisted terminal must not require Host reads') })
    assertRecovered(await restored.getRun(blocked.runId), outcome.status, outcome.error, blocked.finishedAt)
    assert.equal(fixture.promptCalls, 1)
    const selectionCount = fixture.permissionCalls.length
    assert.deepEqual(await fixture.relay.reconcilePermissions(blocked.sessionId), { sessionId: blocked.sessionId, restored: true })
    assert.equal(fixture.permissionCalls.length, selectionCount)
    assertRecovered(await fixture.relay.getRun(blocked.runId), outcome.status, outcome.error, blocked.finishedAt)
  })
}

test('resolved .7 permission warnings are removed after reload without dropping other warnings', async t => {
  const fixture = await setup(t)
  const blocked = await fixture.relay.startRun({ workspace, task: 'native task' })
  fixture.blockRestore = false
  await fixture.relay.reconcilePermissions(blocked.sessionId)
  const state = await fixture.state()
  const legacy = state.runs[0]!.snapshot
  legacy.warnings = [restoreWarning, 'Unrelated admission warning']
  await fixture.writeState(state)
  const restored = fixture.restore(async () => { throw new Error('terminal snapshot needs no native query') })
  const snapshot = await restored.getRun(blocked.runId)
  assert.deepEqual(snapshot.warnings, ['Unrelated admission warning'])
  assert.deepEqual((await restored.listRuns())[0]!.warnings, ['Unrelated admission warning'])
  assert.deepEqual((await fixture.state()).runs[0]!.snapshot.warnings, ['Unrelated admission warning'])
  assert.equal(fixture.promptCalls, 1)
  const stillBlocked = cloneRun({ ...blocked, warnings: [restoreWarning, 'Unrelated admission warning'] })
  assert.deepEqual(stillBlocked.warnings, [restoreWarning, 'Unrelated admission warning'])
})

test('permission recovery that still fails preserves the attention state and can be retried', async t => {
  const fixture = await setup(t)
  const blocked = await fixture.relay.startRun({ workspace, task: 'native task' })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await fixture.relay.reconcilePermissions(blocked.sessionId)).restored, false)
    const same = await fixture.relay.getRun(blocked.runId)
    assert.equal(same.status, 'needs_attention')
    assert.equal(same.attentionReason, 'permission_restore_failed')
    assert.equal(same.finishedAt, blocked.finishedAt)
    const persisted = await fixture.state()
    assert.equal(persisted.permissionLeases[0]!.state, 'needs_attention')
    assert.equal(persisted.runs[0]!.snapshot.status, 'needs_attention')
  }
  fixture.blockRestore = false
  assert.equal((await fixture.relay.reconcilePermissions(blocked.sessionId)).restored, true)
  assertRecovered(await fixture.relay.getRun(blocked.runId), 'succeeded', null, blocked.finishedAt)
  assert.equal(fixture.promptCalls, 1)
})

test('restart recovery repairs an already released lease using native history instead of guessing success', async t => {
  const fixture = await setup(t)
  fixture.nextOutcome = 'error'
  const blocked = await fixture.relay.startRun({ workspace, task: 'failed native task' })
  const state = await fixture.state()
  state.runs[0]!.snapshot = { ...blocked }
  state.permissionLeases[0]!.state = 'released'
  state.permissionLeases[0]!.error = null
  await fixture.writeState(state)
  fixture.currentPermissions.set(blocked.sessionId, 'workspace-write')
  fixture.blockRestore = false
  const restored = fixture.restore()
  assert.equal((await restored.reconcilePermissions(blocked.sessionId)).restored, true)
  assertRecovered(await restored.getRun(blocked.runId), 'failed', 'MODEL_FAILURE: native failure', blocked.finishedAt)
  assert.equal((await fixture.state()).runs[0]!.snapshot.status, 'failed')
  assert.equal(fixture.promptCalls, 1)
})

test('native history failure preserves attention after the lease is restored, and a later explicit retry recovers', async t => {
  const fixture = await setup(t)
  const blocked = await fixture.relay.startRun({ workspace, task: 'native task' })
  fixture.blockRestore = false
  fixture.historyFailures.add(blocked.sessionId)
  await assert.rejects(fixture.relay.reconcilePermissions(blocked.sessionId), /native history unavailable/)
  const state = await fixture.state()
  assert.equal(state.permissionLeases[0]!.state, 'released')
  const snapshot = state.runs[0]!.snapshot
  assert.equal(snapshot.status, 'needs_attention')
  assert.equal(snapshot.attentionReason, 'permission_restore_failed')
  assert.equal(snapshot.error, blocked.error)
  assert.equal(snapshot.finishedAt, blocked.finishedAt)
  const restored = fixture.restore()
  assert.equal((await restored.getRun(blocked.runId)).status, 'needs_attention')
  fixture.historyFailures.clear()
  assert.equal((await restored.reconcilePermissions(blocked.sessionId)).restored, true)
  assertRecovered(await restored.getRun(blocked.runId), 'succeeded', null, blocked.finishedAt)
  assert.equal(fixture.promptCalls, 1)
})

test('without an owned native terminal, permission recovery cannot promote the run to a guessed terminal state', async t => {
  const fixture = await setup(t)
  const blocked = await fixture.relay.startRun({ workspace, task: 'native task' })
  fixture.blockRestore = false
  fixture.events.set(blocked.sessionId, fixture.events.get(blocked.sessionId)!.filter(event => event.type !== 'turn/end'))
  // A restart removes the process-local cached terminal, matching unavailable durable evidence.
  const state = await fixture.state()
  state.runs[0]!.snapshot = { ...blocked }
  await fixture.writeState(state)
  const restored = fixture.restore()
  assert.equal((await restored.reconcilePermissions(blocked.sessionId)).restored, true)
  const result = await restored.getRun(blocked.runId)
  assert.equal(result.status, 'needs_attention')
  assert.equal(result.attentionReason, 'permission_restore_failed')
  assert.equal(result.error, blocked.error)
  assert.equal(result.finishedAt, blocked.finishedAt)
  assert.equal(fixture.promptCalls, 1)
})

test('all stale runs in one session recover their own outcomes without touching a newer active run or another session', async t => {
  const fixture = await setup(t)
  fixture.blockRestore = false
  const first = await fixture.relay.startRun({ workspace, task: 'first completed' })
  fixture.nextOutcome = 'error'
  const second = await fixture.relay.startRun({ workspace, sessionId: first.sessionId, task: 'second failed' })
  fixture.nextOutcome = 'active'
  const active = await fixture.relay.startRun({ workspace, sessionId: first.sessionId, task: 'third active' })
  const other = await fixture.relay.startRun({ workspace, task: 'other session attention' })
  const state = await fixture.state()
  for (const snapshot of state.runs.map(run => run.snapshot)) {
    if (snapshot.runId === first.runId || snapshot.runId === second.runId) {
      snapshot.status = 'needs_attention'
      snapshot.attentionReason = 'permission_restore_failed'
      snapshot.error = 'The run completed, but the previous Harness permission preset could not be restored'
    } else if (snapshot.runId === other.runId) {
      snapshot.status = 'needs_attention'
      snapshot.attentionReason = 'run_stalled'
      snapshot.error = 'Other session requires attention for stalled progress'
    }
  }
  const otherBefore = state.runs.find(run => run.snapshot.runId === other.runId)!.snapshot
  await fixture.writeState(state)
  const restored = fixture.restore()
  const permissionCalls = fixture.permissionCalls.length
  assert.equal((await restored.reconcilePermissions(first.sessionId)).restored, true)
  const after = await fixture.state()
  assertRecovered(after.runs.find(run => run.snapshot.runId === first.runId)!.snapshot, 'succeeded', null, first.finishedAt)
  assertRecovered(after.runs.find(run => run.snapshot.runId === second.runId)!.snapshot, 'failed', 'MODEL_FAILURE: native failure', second.finishedAt)
  assert.equal((await restored.getRun(active.runId)).status, 'running')
  assert.equal(restored.interactionOwner(active.sessionId)?.runId, active.runId)
  assert.deepEqual(after.runs.find(run => run.snapshot.runId === other.runId)!.snapshot, otherBefore)
  assert.equal(fixture.permissionCalls.length, permissionCalls)
  assert.equal(fixture.currentPermissions.get(active.sessionId), 'read-only')
  assert.equal(after.permissionLeases.find(lease => lease.ownerOperationId === active.operationId)!.state, 'acquired')
  // Repeating the recovery must not restore the newer active run's permission lease.
  assert.equal((await restored.reconcilePermissions(first.sessionId)).restored, false)
  assert.equal(fixture.permissionCalls.length, permissionCalls)
  assert.equal(restored.interactionOwner(active.sessionId)?.runId, active.runId)
  assert.equal(fixture.promptCalls, 4)
})


for (const failRestore of [false, true]) {
  test(
    `public permission reconciliation joins normal finalization with ${failRestore ? 'retry after a shared restore failure' : 'one successful restore'}`,
    { timeout: 10_000 },
    async t => {
      const fixture = await setup(t)
      const pause = createRestorePause()
      fixture.restorePause = pause
      const starting = fixture.relay.startRun({ workspace, task: 'racing terminal restore' })
      let reconciliation: Promise<{ sessionId: string; restored: boolean }> | undefined
      try {
        await pause.started
        const sessionId = [...fixture.events.keys()][0]!
        reconciliation = fixture.relay.reconcilePermissions(sessionId)
        // The ready promise is already fulfilled; this drains the reconciliation
        // continuation so it joins the restore before the test opens the gate.
        await Promise.resolve()
        const workspaceWriteCalls = () => fixture.permissionCalls.filter(call =>
          call.sessionId === sessionId && call.preset === 'workspace-write').length
        assert.equal(workspaceWriteCalls(), 1, 'the normal finalizer has started the single native restore')

        if (failRestore) {
          pause.release()
          const [attention, result] = await Promise.all([starting, reconciliation])
          assert.equal(result.restored, false)
          assert.equal(attention.status, 'needs_attention')
          assert.equal(attention.attentionReason, 'permission_restore_failed')
          const failedState = await fixture.state()
          assert.equal(failedState.permissionLeases.find(lease => lease.sessionId === sessionId)!.state, 'needs_attention')
          assert.equal(failedState.runs.find(run => run.snapshot.runId === attention.runId)!.snapshot.status, 'needs_attention')
          assert.equal(workspaceWriteCalls(), 1, 'the public recovery call shares the failed in-flight restore')

          fixture.blockRestore = false
          fixture.restorePause = null
          assert.deepEqual(await fixture.relay.reconcilePermissions(sessionId), { sessionId, restored: true })
          const recovered = await fixture.relay.getRun(attention.runId)
          assertRecovered(recovered, 'succeeded', null, attention.finishedAt)
          assert.equal((await fixture.state()).permissionLeases.find(lease => lease.sessionId === sessionId)!.state, 'released')
          assert.equal(workspaceWriteCalls(), 2, 'a later explicit retry performs exactly one new native restore')
        } else {
          fixture.blockRestore = false
          pause.release()
          const [finished, result] = await Promise.all([starting, reconciliation])
          assert.equal(result.restored, true)
          assertRecovered(finished, 'succeeded', null, finished.finishedAt)
          const state = await fixture.state()
          assert.equal(state.runs.find(run => run.snapshot.runId === finished.runId)!.snapshot.status, 'succeeded')
          assert.equal(state.permissionLeases.find(lease => lease.sessionId === sessionId)!.state, 'released')
          assert.equal(workspaceWriteCalls(), 1, 'normal finalization and public recovery share one native restore')
        }
        assert.equal(fixture.currentPermissions.get(sessionId), 'workspace-write')
        assert.equal(fixture.promptCalls, 1)
      } finally {
        pause.release()
        await Promise.allSettled([starting, ...(reconciliation === undefined ? [] : [reconciliation])])
      }
    },
  )
}

function assertRecovered(snapshot: RunSnapshot, status: string, error: string | null, finishedAt: string | null): void {
  assert.equal(snapshot.status, status)
  assert.equal(snapshot.error, error)
  assert.equal(snapshot.attentionReason, undefined)
  assert.equal(snapshot.finishedAt, finishedAt)
  assert.equal(snapshot.assistantText, 'native answer')
  assert(!snapshot.warnings.includes(restoreWarning), 'resolved permission restoration must not retain an active recovery warning')
}

type NativeOutcome = 'completed' | 'max-tokens' | 'error' | 'aborted' | 'active'
interface RestorePause {
  started: Promise<void>
  wait: Promise<void>
  markStarted(): void
  release(): void
}

interface Fixture {
  relay: RelayFacade
  nextOutcome: NativeOutcome
  blockRestore: boolean
  restorePause: RestorePause | null
  promptCalls: number
  permissionCalls: Array<{ sessionId: string; preset: PermissionPreset }>
  currentPermissions: Map<string, PermissionPreset>
  events: Map<string, RpcEvent[]>
  historyFailures: Set<string>
  restore(fetchOverride?: typeof fetch): RelayFacade
  state(): Promise<PersistedRelayState>
  writeState(state: PersistedRelayState): Promise<void>
}

function createRestorePause(): RestorePause {
  let markStarted!: () => void
  let release!: () => void
  return {
    started: new Promise<void>(resolve => { markStarted = resolve }),
    wait: new Promise<void>(resolve => { release = resolve }),
    markStarted: () => markStarted(),
    release: () => release(),
  }
}

async function setup(t: TestContext): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'relay-permission-status-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = resolveConfig({
    DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace, DSH_RELAY_STATE_FILE: join(directory, 'state.json'),
    DSH_RELAY_PERSIST_PROMPT_TEXT: 'true', DSH_RELAY_MAX_ACTIVE_RUNS: '8',
  })
  const fixture = {
    nextOutcome: 'completed', blockRestore: true, restorePause: null, promptCalls: 0,
    permissionCalls: [], currentPermissions: new Map(), events: new Map(), historyFailures: new Set(),
  } as unknown as Fixture
  const running = new Map<string, boolean>()
  let createdSessions = 0
  const permissionGateway = new PermissionGatewayFacade({
    readCurrent: async sessionId => fixture.currentPermissions.get(sessionId),
    select: async (sessionId, preset) => {
      fixture.permissionCalls.push({ sessionId, preset })
      if (preset === 'workspace-write' && fixture.restorePause !== null) {
        fixture.restorePause.markStarted()
        await fixture.restorePause.wait
      }
      if (fixture.blockRestore && preset === 'workspace-write') throw new Error('PTY still active; permission restore denied')
      fixture.currentPermissions.set(sessionId, preset)
      return { accepted: true }
    },
  })
  const fakeFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; rpcId: string; payload: Record<string, unknown> }
    const sessionId = String(request.payload.sessionId)
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: [...fixture.events.keys()] }], archivedSessionIds: [] }; break
      case 'session.create': {
        const sessionId = `session-${++createdSessions}`
        fixture.events.set(sessionId, [])
        fixture.currentPermissions.set(sessionId, 'workspace-write')
        running.set(sessionId, false)
        value = { sessionId, agentPreset: 'standard' }
        break
      }
      case 'session.list': value = { items: [...fixture.events.keys()].map(sessionId => ({ sessionId, running: running.get(sessionId) ?? false })) }; break
      case 'session.history': {
        if (fixture.historyFailures.has(sessionId)) throw new Error('native history unavailable')
        let history = fixture.events.get(sessionId) ?? []
        if (request.payload.beforeSeq !== undefined) history = history.filter(event => event.seq < Number(request.payload.beforeSeq))
        if (request.payload.maxMessages === 1) history = history.slice(-1)
        value = { events: history.map(event => ({ event })), hasMore: false }
        break
      }
      case 'session.prompt': {
        fixture.promptCalls += 1
        const history = fixture.events.get(sessionId)!
        const seq = history.length + 1
        history.push(
          { type: 'user/message', seq, time: seq, data: { id: `message-${seq}`, source: { kind: 'user', rpcId: request.rpcId } } },
          { type: 'assistant/message', seq: seq + 1, time: seq + 1, data: { message: { content: [{ type: 'text', text: 'native answer' }] } } },
        )
        if (fixture.nextOutcome === 'active') running.set(sessionId, true)
        else {
          running.set(sessionId, false)
          const reason = fixture.nextOutcome === 'error'
            ? { kind: 'error', error: { code: 'MODEL_FAILURE', message: 'native failure' } }
            : fixture.nextOutcome === 'aborted' ? { kind: 'aborted', reason: { kind: 'user' } }
              : { kind: fixture.nextOutcome === 'max-tokens' ? 'max-tokens' : 'completed' }
          history.push({ type: 'turn/end', seq: seq + 2, time: seq + 2, data: { reason } })
        }
        value = { accepted: true, messageId: `message-${seq}` }
        break
      }
      default: throw new Error(`unexpected fake gateway method: ${request.method}`)
    }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  fixture.restore = fetchOverride => new RelayFacade(config, fetchOverride ?? fakeFetch, undefined, { permissionGateway })
  fixture.relay = fixture.restore()
  fixture.state = async () => JSON.parse(await readFile(config.stateFile, 'utf8'))
  fixture.writeState = async state => { await writeFile(config.stateFile, JSON.stringify(state)) }
  return fixture
}
