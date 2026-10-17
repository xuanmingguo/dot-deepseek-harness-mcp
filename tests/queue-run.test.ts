import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, type RelayConfig } from '../src/config.js'
import { RelayFacade, RelayError } from '../src/relay-broker/index.js'
import type { OperationRecord, RpcEvent, RunSnapshot } from '../src/types.js'

const workspace = fileURLToPath(new URL('../', import.meta.url))

test('queue ACK without messageId is persisted and duplicate/restarted callers never resubmit', async t => {
  const fixture = await setup(t)
  const run = await fixture.relay.startRun({ workspace, task: 'original' })
  const input = { task: 'do this next', idempotencyKey: 'queue-once' }
  const queued = await fixture.relay.queueRun(run.runId, input) as QueueResult
  assert.equal(queued.accepted, true)
  assert.equal(queued.mode, 'queue')
  assert.equal(queued.executionStatus, 'not_observed')
  assert.equal(queued.messageId, null)
  assert.equal(queued.durable, false)
  assert.equal(queued.run.runId, run.runId)
  assert.equal(queued.run.sessionId, run.sessionId)
  assert.equal(queued.run.task, 'original')
  assert.equal((await fixture.relay.getOperation(queued.operationId)).kind, 'queue')
  assert.equal((await fixture.relay.getOperation(queued.operationId)).state, 'acknowledged')
  const duplicate = await fixture.relay.queueRun(run.runId, input) as QueueResult
  assert.equal(duplicate.operationId, queued.operationId)
  assert.equal(duplicate.replayed, true)
  const restored = fixture.restore()
  const recovered = await restored.queueRun(run.runId, input) as QueueResult
  assert.equal(recovered.operationId, queued.operationId)
  assert.equal(recovered.messageId, null)
  assert.equal(fixture.prompts.length, 2)
  assert.ok(fixture.prompts.every(prompt => prompt.mode === 'queue'))
  assert.equal((await restored.listRuns()).length, 1)
  await assert.rejects(restored.queueRun(run.runId, { ...input, task: 'a different task' }), errorCode('OPERATION_CONFLICT'))
})

test('ambiguous queue response reconciles history and never blindly resends, including after restart', async t => {
  const fixture = await setup(t)
  const run = await fixture.relay.startRun({ workspace, task: 'original' })
  fixture.failNextQueue = true
  const input = { task: 'future', idempotencyKey: 'ambiguous' }
  let operationId = ''
  await assert.rejects(fixture.relay.queueRun(run.runId, input), error => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'OPERATION_UNKNOWN')
    operationId = error.details.operationId!
    return true
  })
  assert.equal((await fixture.relay.getOperation(operationId)).state, 'unknown')
  await assert.rejects(fixture.relay.queueRun(run.runId, input), errorCode('OPERATION_UNKNOWN'))
  const restored = fixture.restore()
  await assert.rejects(restored.queueRun(run.runId, input), errorCode('OPERATION_UNKNOWN'))
  assert.equal(fixture.prompts.length, 2)
  const queuedRpcId = fixture.prompts[1]!.rpcId
  fixture.events.get(run.sessionId)!.push(userEvent(2, queuedRpcId, 'future-message'))
  const recovered = await restored.queueRun(run.runId, input) as QueueResult
  assert.equal(recovered.accepted, true)
  assert.equal(recovered.durable, true)
  assert.equal(recovered.messageId, 'future-message')
  assert.equal((await restored.getOperation(operationId)).state, 'reconciled')
  assert.equal(fixture.prompts.length, 2)
})

test('future queued turn cannot replace the original run output or terminal outcome', async t => {
  const fixture = await setup(t)
  const run = await fixture.relay.startRun({ workspace, task: 'original' })
  await fixture.relay.queueRun(run.runId, { task: 'future', idempotencyKey: 'future-turn' })
  fixture.events.get(run.sessionId)!.push(
    assistantEvent(2, 'original answer'), turnEnd(3, 'completed'),
    userEvent(4, fixture.prompts[1]!.rpcId, 'future-message'),
    assistantEvent(5, 'future answer'), turnEnd(6, 'cancelled'),
  )
  const completed = await fixture.relay.getRun(run.runId)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.assistantText, 'original answer')
  const replay = await fixture.relay.queueRun(run.runId, { task: 'future', idempotencyKey: 'future-turn' }) as QueueResult
  assert.equal(replay.accepted, true)
  assert.equal(fixture.prompts.length, 2)
})

test('concurrent starts respect the cap, duplicate keys work when full, and terminal runs free slots without poisoning rejected keys', async t => {
  const fixture = await setup(t, 2)
  const inputs = Array.from({ length: 4 }, (_, index) => ({ workspace, task: `task-${index}`, idempotencyKey: `start-${index}` }))
  const results = await Promise.allSettled(inputs.map(input => fixture.relay.startRun(input)))
  const accepted = results.filter((result): result is PromiseFulfilledResult<RunSnapshot> => result.status === 'fulfilled')
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  assert.equal(accepted.length, 2)
  assert.equal(rejected.length, 2)
  assert.notEqual(accepted[0]!.value.sessionId, accepted[1]!.value.sessionId)
  for (const result of rejected) {
    assert.ok(result.reason instanceof RelayError)
    assert.equal(result.reason.code, 'CONCURRENCY_LIMIT')
    assert.equal(result.reason.retryable, true)
  }
  assert.equal(fixture.events.size, 2)
  assert.equal((await fixture.state()).operations.length, 2)
  const original = accepted[0]!.value
  const duplicateInput = inputs.find(input => input.idempotencyKey === original.idempotencyKey)!
  const duplicate = await fixture.relay.startRun(duplicateInput)
  assert.equal(duplicate.runId, original.runId)
  assert.equal(fixture.prompts.length, 2)
  fixture.complete(original.sessionId)
  const rejectedInput = inputs[results.findIndex(result => result.status === 'rejected')]!
  const replacement = await fixture.relay.startRun(rejectedInput)
  assert.equal(replacement.status, 'running')
  assert.equal(replacement.idempotencyKey, rejectedInput.idempotencyKey)
  assert.equal((await fixture.relay.getRun(original.runId)).status, 'succeeded')
  assert.equal((await fixture.state()).operations.length, 3)
})

test('start admission releases before a pending prompt response so different sessions progress concurrently', async t => {
  const fixture = await setup(t, 2)
  let dispatch!: () => void
  const dispatched = new Promise<void>(resolve => { dispatch = resolve })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  fixture.beforeAck = async prompt => {
    if (prompt.sessionId === 'session-1') { dispatch(); await gate }
  }
  const first = fixture.relay.startRun({ workspace, task: 'slow ACK' })
  await dispatched
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const second = await Promise.race([
      fixture.relay.startRun({ workspace, task: 'independent' }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('admission held while awaiting prompt ACK')), 2_000) }),
    ])
    assert.equal(second.sessionId, 'session-2')
    assert.equal(second.status, 'running')
  } finally {
    clearTimeout(timeout)
    release()
    await first
  }
})

test('slow native setup reserves a slot without blocking another session admission', async t => {
  const fixture = await setup(t, 2)
  let entered!: () => void
  const setupEntered = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let creations = 0
  fixture.beforeCreate = async () => {
    if (++creations === 1) { entered(); await gate }
  }
  const first = fixture.relay.startRun({ workspace, task: 'slow setup' })
  await setupEntered
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const second = await Promise.race([
      fixture.relay.startRun({ workspace, task: 'independent setup' }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('native setup held admission')), 2_000) }),
    ])
    assert.equal(second.status, 'running')
    await assert.rejects(fixture.relay.startRun({ workspace, task: 'reservation fills the other slot' }), errorCode('CONCURRENCY_LIMIT'))
    assert.equal((await fixture.state()).operations.length, 2)
  } finally {
    clearTimeout(timeout)
    release()
    await first
  }
})

test('default cap is four and unrelated native Harness sessions do not consume Relay slots', async t => {
  const fixture = await setup(t)
  for (let index = 0; index < 6; index += 1) fixture.events.set(`external-${index}`, [])
  const runs = await Promise.all(Array.from({ length: 4 }, (_, index) => fixture.relay.startRun({ workspace, task: `relay-${index}` })))
  assert.equal(runs.length, 4)
  await assert.rejects(fixture.relay.startRun({ workspace, task: 'one too many' }), errorCode('CONCURRENCY_LIMIT'))
  assert.equal(fixture.prompts.length, 4)
})

test('restored unknown and needs_attention runs consume admission slots', async t => {
  for (const status of ['unknown', 'needs_attention'] as const) {
    const fixture = await setup(t, 1)
    const run = await fixture.relay.startRun({ workspace, task: status })
    const state = await fixture.state()
    state.runs[0]!.snapshot.status = status
    if (status === 'needs_attention') state.runs[0]!.snapshot.attentionReason = 'run_stalled'
    await writeFile(fixture.config.stateFile, JSON.stringify(state))
    await assert.rejects(fixture.restore().startRun({ workspace, task: 'blocked' }), errorCode('CONCURRENCY_LIMIT'))
    assert.equal(fixture.prompts.length, 1)
    assert.equal(run.sessionId, 'session-1')
  }
})

interface QueueResult {
  accepted: boolean
  mode: string
  executionStatus: string
  messageId: string | null
  durable: boolean
  replayed: boolean
  operationId: string
  run: RunSnapshot
}
interface PromptCall { sessionId: string; mode: string; rpcId: string }
interface Fixture {
  relay: RelayFacade
  config: RelayConfig
  events: Map<string, RpcEvent[]>
  prompts: PromptCall[]
  failNextQueue: boolean
  beforeAck?: (prompt: PromptCall) => Promise<void>
  beforeCreate?: () => Promise<void>
  restore(): RelayFacade
  complete(sessionId: string): void
  state(): Promise<{ runs: Array<{ snapshot: RunSnapshot }>; operations: OperationRecord[] }>
}

async function setup(t: TestContext, maxActiveRuns?: number): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'relay-queue-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config: RelayConfig = {
    ...resolveConfig({ DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace, DSH_RELAY_STATE_FILE: join(directory, 'state.json') }),
    ...(maxActiveRuns === undefined ? {} : { maxActiveRuns }),
  }
  const events = new Map<string, RpcEvent[]>()
  const running = new Map<string, boolean>()
  const prompts: PromptCall[] = []
  let createdSessions = 0
  const fixture = { config, events, prompts, failNextQueue: false } as Fixture
  const fakeFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; rpcId: string; payload: Record<string, unknown> }
    const sessionId = String(request.payload.sessionId)
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: [...events.keys()] }], archivedSessionIds: [] }; break
      case 'session.create': {
        await fixture.beforeCreate?.()
        const sessionId = `session-${++createdSessions}`
        events.set(sessionId, [])
        running.set(sessionId, true)
        value = { sessionId, agentPreset: 'standard' }
        break
      }
      case 'session.list': value = { items: [...events.keys()].map(sessionId => ({ sessionId, running: running.get(sessionId) ?? true })) }; break
      case 'session.history': {
        let history = events.get(sessionId) ?? []
        if (request.payload.beforeSeq !== undefined) history = history.filter(event => event.seq < Number(request.payload.beforeSeq))
        if (request.payload.maxMessages === 1) history = history.slice(-1)
        value = { events: history.map(event => ({ event })), hasMore: false, projections: { values: { permissions: { currentValue: 'read-only' } } } }
        break
      }
      case 'session.prompt': {
        const call = { sessionId, mode: String(request.payload.mode), rpcId: request.rpcId }
        prompts.push(call)
        const history = events.get(sessionId)!
        if (history.length === 0) history.push(userEvent(1, request.rpcId, `start-${sessionId}`))
        else if (fixture.failNextQueue) { fixture.failNextQueue = false; throw new Error('lost queue response') }
        await fixture.beforeAck?.(call)
        value = { accepted: true }
        break
      }
      default: throw new Error(`unexpected fake gateway method: ${request.method}`)
    }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  fixture.restore = () => new RelayFacade(config, fakeFetch)
  fixture.relay = fixture.restore()
  fixture.complete = sessionId => {
    const history = events.get(sessionId)!
    history.push(assistantEvent(history.length + 1, 'done'), turnEnd(history.length + 2, 'completed'))
    running.set(sessionId, false)
  }
  fixture.state = async () => JSON.parse(await readFile(config.stateFile, 'utf8'))
  return fixture
}

function userEvent(seq: number, rpcId: string, id: string): RpcEvent {
  return { type: 'user/message', seq, time: seq, data: { id, source: { kind: 'user', rpcId } } }
}
function assistantEvent(seq: number, text: string): RpcEvent {
  return { type: 'assistant/message', seq, time: seq, data: { message: { content: [{ type: 'text', text }] } } }
}
function turnEnd(seq: number, kind: string): RpcEvent {
  return { type: 'turn/end', seq, time: seq, data: { reason: { kind } } }
}
function errorCode(code: string): (error: unknown) => boolean {
  return error => error instanceof RelayError && error.code === code
}
