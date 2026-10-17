import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { type TestContext } from 'node:test'
import { resolveConfig } from '../src/config.js'
import { RelayFacade, RelayError } from '../src/relay-broker/index.js'
import { RelayStateStore } from '../src/state-store.js'
import type { PersistedRelayState, RunSnapshot } from '../src/types.js'

test('compact discovery filters exact recorded values and returns empty pages', async t => {
  const fixture = await setup(t, [run(1), run(2, { serviceId: 'other', workspace: '/exact/other', sessionId: 'second', status: 'failed' })])
  for (const input of [{ serviceId: 'other' }, { workspace: '/exact/other' }, { sessionId: 'second' }, { status: 'failed' as const },
    { serviceId: 'other', workspace: '/exact/other', sessionId: 'second', status: 'failed' as const }]) {
    assert.deepEqual((await fixture.relay.listRunSummaries(input)).runs.map(item => item.runId), ['run-002'])
  }
  for (const input of [{ workspace: '/exact/other/' }, { workspace: '/exact/../exact/other' }, { workspace: '/EXACT/other' }, { sessionId: 'absent' }]) {
    assert.deepEqual(await fixture.relay.listRunSummaries(input), { runs: [], hasMore: false, nextCursor: null })
  }
  assert.equal(fixture.calls.length, 0, 'recorded-path filters do not resolve paths or read native history')
})

test('default and maximum page sizes, page bounds, deterministic ties and nonoverlapping traversal', async t => {
  const snapshots = Array.from({ length: 55 }, (_, index) => run(index, { startedAt: '2026-10-15T00:00:00.000Z' }))
  const { relay, calls } = await setup(t, snapshots.reverse())
  assert.equal((await relay.listRunSummaries()).runs.length, 20)
  assert.equal((await relay.listRunSummaries({ limit: 50 })).runs.length, 50)
  for (const limit of [0, 51, 1.5, NaN, Infinity]) await assert.rejects(relay.listRunSummaries({ limit }), { code: 'INVALID_RUN_LIMIT' })
  const all: string[] = []
  let cursor: string | undefined
  do {
    const page = await relay.listRunSummaries({ limit: 7, cursor })
    all.push(...page.runs.map(item => item.runId))
    assert.equal(page.hasMore, page.nextCursor !== null)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  assert.deepEqual(all, snapshots.map(item => item.runId).sort().reverse())
  assert.equal(new Set(all).size, 55)
  assert.equal(calls.length, 0, 'terminal runs do not incur native reads')
})

test('cursor survives restored facades and excludes newly inserted newer runs', async t => {
  const snapshots = [run(1), run(2), run(3), run(4)]
  const fixture = await setup(t, snapshots)
  const first = await fixture.relay.listRunSummaries({ limit: 2 })
  assert.deepEqual(first.runs.map(item => item.runId), ['run-004', 'run-003'])
  // A later recorded run arrives before the next facade instance restores the state.
  await fixture.save([...snapshots, run(99)])
  const restored = fixture.restore()
  const second = await restored.listRunSummaries({ cursor: first.nextCursor!, limit: 2 })
  assert.deepEqual(second.runs.map(item => item.runId), ['run-002', 'run-001'])
  assert.equal(second.hasMore, false)
  assert.equal(second.nextCursor, null)
  assert.equal((await restored.listRunSummaries()).runs[0]?.runId, 'run-099')
  assert.equal(fixture.calls.length, 0)
})

test('a new start_run in the same facade does not enter an existing traversal', async t => {
  const fixture = await setup(t, [run(1), run(2), run(3)])
  const first = await fixture.relay.listRunSummaries({ limit: 1 })
  const workspace = fileURLToPath(new URL('../', import.meta.url))
  const added = await fixture.relay.startRun({ workspace, task: 'authorized test task' })
  assert(added.startedAt > first.runs[0]!.startedAt)
  const continued = await fixture.relay.listRunSummaries({ limit: 50, cursor: first.nextCursor! })
  assert.deepEqual(continued.runs.map(item => item.runId), ['run-002', 'run-001'])
  assert.equal(continued.nextCursor, null)
  assert.equal((await fixture.relay.listRunSummaries({ limit: 1 })).runs[0]?.runId, added.runId)
})

test('malformed, tampered, noncanonical, cross-filter and overlong cursors fail before native calls or persistence', async t => {
  const fixture = await setup(t, [run(1), run(2), run(3, { status: 'running', finishedAt: null })])
  const first = await fixture.relay.listRunSummaries({ status: 'succeeded', limit: 1 })
  const cursor = first.nextCursor!
  const bytes = await readFile(fixture.stateFile, 'utf8')
  fixture.calls.length = 0
  const [encoded, digest] = cursor.split('.')
  const payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as Record<string, unknown>
  const signed = (value: unknown) => {
    const json = JSON.stringify(value)
    return `${Buffer.from(json).toString('base64url')}.${createHash('sha256').update(json).digest('base64url')}`
  }
  for (const invalid of ['', 'not-a-cursor', `${encoded}.${digest?.startsWith('a') ? 'b' : 'a'}${digest?.slice(1)}`, 'x'.repeat(20_001),
    signed({ ...payload, v: 2 }), signed({ ...payload, extra: true }), signed({ ...payload, after: ['invalid-date', 'run'] }),
    signed({ ...payload, after: ['2099-01-01T00:00:00.000Z', 'run'] })]) {
    await assert.rejects(fixture.relay.listRunSummaries({ status: 'succeeded', cursor: invalid }), error => error instanceof RelayError && error.code === 'INVALID_RUN_CURSOR')
  }
  for (const filters of [{}, { status: 'failed' as const }, { status: 'succeeded' as const, workspace: '/exact/workspace' },
    { status: 'succeeded' as const, sessionId: 'session-1' }, { status: 'succeeded' as const, serviceId: 'service-1' }]) {
    await assert.rejects(fixture.relay.listRunSummaries({ ...filters, cursor }), { code: 'INVALID_RUN_CURSOR' })
  }
  assert.equal(fixture.calls.length, 0)
  assert.equal(await readFile(fixture.stateFile, 'utf8'), bytes, 'invalid cursors never save state')
})

test('discovery excludes sensitive text while retaining actionable monitoring fields and legacy list_runs', async t => {
  const secret = 'PRIVATE-TASK-ASSISTANT-ERROR'.repeat(20_000)
  const snapshot = run(1, {
    status: 'needs_attention', attentionReason: 'permission_restore_failed', error: secret,
    task: secret, assistantText: secret, warnings: [secret, secret], operationId: 'operation-1',
    permissionRestoration: 'failed', executionOutcome: { status: 'failed', error: secret, finishedAt: '2026-10-15T00:01:00.000Z' },
    modelSelection: { provider: 'provider', model: 'model', reasoningEffort: 'high' },
  })
  const { relay } = await setup(t, [snapshot])
  const page = await relay.listRunSummaries()
  const entry = page.runs[0]!
  assert.equal(entry.operationId, 'operation-1')
  assert.equal(entry.warningCount, 2)
  assert.equal(entry.nextAction, 'reconcile-permissions')
  assert.equal(entry.recovery?.arguments.sessionId, snapshot.sessionId)
  assert.equal(entry.model, 'model')
  assert.deepEqual(entry.executionOutcome, { status: 'failed', finishedAt: snapshot.executionOutcome!.finishedAt })
  const serialized = JSON.stringify(page)
  assert.equal(serialized.includes('PRIVATE'), false)
  assert.equal(serialized.includes('assistantText'), false)
  assert.equal(serialized.includes('"task"'), false)
  assert.equal(serialized.includes('"error"'), false)
  assert(serialized.length < 2000)
  const legacy = await relay.listRuns('service-1')
  assert.equal(legacy[0]?.assistantText, secret)
  assert.equal(legacy[0]?.error, secret)
})

test('refreshes only relevant active candidates through one lookahead and evaluates status after reconciliation', async t => {
  const fixture = await setup(t, [
    ...Array.from({ length: 33 }, (_, index) => run(index)),
    run(40, { status: 'running', finishedAt: null }), run(41, { status: 'running', finishedAt: null }),
    run(42, { status: 'running', finishedAt: null }), run(43, { serviceId: 'foreign', status: 'running', finishedAt: null }),
  ], true)
  const page = await fixture.relay.listRunSummaries({ serviceId: 'service-1', status: 'succeeded', limit: 1 })
  assert.deepEqual(page.runs.map(item => item.runId), ['run-042'])
  assert.equal(page.hasMore, true)
  assert.deepEqual(fixture.calls.filter(call => call.method === 'session.history').map(call => call.sessionId), ['session-42', 'session-41'])
  assert.equal(fixture.calls.filter(call => call.method === 'session.list').length, 2)
})

function run(index: number, patch: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: `run-${String(index).padStart(3, '0')}`, serviceId: 'service-1', sessionId: `session-${index}`,
    sessionReused: false, parentRunId: null, workspace: '/exact/workspace', webUrl: 'http://localhost/',
    status: 'succeeded', modelSelection: null, permissionPreset: 'read-only', agentPreset: null,
    modelDefaultRestore: 'not-needed', warnings: [], task: '', taskPersisted: true, taskImageCount: 0,
    cancelRequested: false, startedAt: new Date(Date.UTC(2026, 9, 15, 0, 0, index)).toISOString(),
    finishedAt: '2026-10-15T01:00:00.000Z', promptAdmission: 'accepted', promptMessageId: `message-${index}`,
    assistantText: '', assistantTextBytes: 0, assistantTextTruncated: false, lastEventSeq: 0, error: null,
    ...patch,
  }
}

async function setup(t: TestContext, snapshots: RunSnapshot[], complete = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-run-discovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFile = join(directory, 'state.json')
  const store = new RelayStateStore(stateFile)
  const save = async (runs: RunSnapshot[]) => store.save({
    schemaVersion: 2, services: [], operations: [], permissionLeases: [],
    runs: runs.map(snapshot => ({ snapshot, baselineSeq: 0, promptRpcId: `rpc-${snapshot.sessionId}` })),
  } satisfies PersistedRelayState)
  await save(snapshots)
  const calls: Array<{ method: string; sessionId?: string }> = []
  const workspace = fileURLToPath(new URL('../', import.meta.url))
  let promptedRpc: string | undefined
  const fakeFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; rpcId: string; payload: { sessionId?: string } }
    calls.push({ method: request.method, ...request.payload })
    let value: unknown
    if (request.method === 'host.describe') value = {}
    else if (request.method === 'workspace.list') value = { items: [{ workspaceId: 'workspace-new', path: workspace, sessionIds: [] }] }
    else if (request.method === 'session.create') value = { sessionId: 'session-new', agentPreset: 'standard' }
    else if (request.method === 'commands/execute') value = { commandId: 'command', result: { kind: 'success' } }
    else if (request.method === 'session.prompt') { promptedRpc = request.rpcId; value = { accepted: true, messageId: 'message-new' } }
    else if (request.method === 'session.list') value = { items: [
      ...snapshots.map(snapshot => ({ sessionId: snapshot.sessionId, running: !complete })),
      ...(promptedRpc === undefined ? [] : [{ sessionId: 'session-new', running: true }]),
    ] }
    else if (request.method === 'session.history' && request.payload.sessionId === 'session-new') value = {
      events: promptedRpc === undefined ? [] : [{ event: { type: 'user/message', seq: 1, time: 1, data: { id: 'message-new', source: { rpcId: promptedRpc } } } }],
      hasMore: false, projections: { values: { permissions: { currentValue: 'read-only' } } },
    }
    else if (request.method === 'session.history') value = {
      events: [
        { event: { type: 'user/message', seq: 1, time: 1, data: { id: 'message', source: { rpcId: `rpc-${request.payload.sessionId}` } } } },
        ...(complete ? [{ event: { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'completed' } } } }] : []),
      ], hasMore: false,
    }
    else throw new Error(`unexpected native method: ${request.method}`)
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }), { headers: { 'content-type': 'application/json' } })
  }
  const config = resolveConfig({ DSH_RELAY_STATE_FILE: stateFile, DSH_RELAY_PERSIST_PROMPT_TEXT: 'true' })
  const restore = () => new RelayFacade(config, fakeFetch)
  return { relay: restore(), restore, calls, stateFile, save }
}
