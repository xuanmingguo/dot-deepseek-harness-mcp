import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { RelayError, RelayFacade } from '../src/relay-broker/index.js'
import type { OperationRecord, RpcEvent } from '../src/types.js'

const workspace = fileURLToPath(new URL('../', import.meta.url))
const input = { task: 'focus next step', idempotencyKey: 'steer-once' }

test('steer ACK without a user message persists a receipt and duplicate/restarted calls never resend', async t => {
  const fixture = await setup(t)
  const run = await fixture.relay.startRun({ workspace, task: 'original' })
  const first = await fixture.relay.steerRun(run.runId, input) as Receipt
  assertReceipt(first, false)
  assert.equal(first.messageId, null)
  assert.equal(first.replayed, false)
  const stored = (await fixture.operations()).find(operation => operation.operationId === first.operationId)!
  assert.equal(stored.state, 'acknowledged')
  assert.equal(stored.messageId, null)
  assert.equal(stored.error, null)
  assert.equal(first.rpcId, fixture.steerRpcId)
  const duplicate = await fixture.relay.steerRun(run.runId, input) as Receipt
  assertReceipt(duplicate, false)
  assert.equal(duplicate.operationId, first.operationId)
  assert.equal(duplicate.replayed, true)
  assert.equal(duplicate.rpcId, first.rpcId)
  const recovered = fixture.restore()
  const restored = await recovered.steerRun(run.runId, input) as Receipt
  assertReceipt(restored, false)
  assert.equal(restored.operationId, first.operationId)
  assert.equal(fixture.steerCalls, 1)
  fixture.observeSteer()
  const observed = await recovered.getOperation(first.operationId)
  assert.equal(observed.state, 'reconciled')
  assert.equal(observed.rpcId, first.rpcId)
  assert.equal(observed.messageId, 'steer-message')
  const afterHistory = await recovered.steerRun(run.runId, input) as Receipt
  assertReceipt(afterHistory, true)
  assert.equal(fixture.steerCalls, 1)
})

test('steer transport ambiguity remains unknown and retries only reconcile the original rpc', async t => {
  const fixture = await setup(t)
  const run = await fixture.relay.startRun({ workspace, task: 'original' })
  fixture.loseResponse = true
  let operationId = ''
  await assert.rejects(fixture.relay.steerRun(run.runId, input), error => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'OPERATION_UNKNOWN')
    operationId = error.details.operationId!
    return true
  })
  assert.equal((await fixture.relay.getOperation(operationId)).state, 'unknown')
  await assert.rejects(fixture.relay.steerRun(run.runId, input), errorCode('OPERATION_UNKNOWN'))
  const recovered = fixture.restore()
  await assert.rejects(recovered.steerRun(run.runId, input), errorCode('OPERATION_UNKNOWN'))
  assert.equal(fixture.steerCalls, 1)
  fixture.observeSteer()
  const reconciled = await recovered.reconcileOperation(operationId)
  assert.equal(reconciled.operation.state, 'reconciled')
  assert.equal(reconciled.operation.rpcId, fixture.steerRpcId)
  const receipt = await recovered.steerRun(run.runId, input) as Receipt
  assertReceipt(receipt, true)
  assert.equal(fixture.steerCalls, 1)
})

test('a definitive steer rejection replays as failed rather than an unknown receipt', async t => {
  const fixture = await setup(t)
  const run = await fixture.relay.startRun({ workspace, task: 'original' })
  fixture.rejectSteer = true
  await assert.rejects(fixture.relay.steerRun(run.runId, input), /INVALID_PROMPT/)
  const operation = (await fixture.operations()).find(operation => operation.kind === 'steer')!
  assert.equal(operation.state, 'failed')
  await assert.rejects(fixture.relay.steerRun(run.runId, input), errorCode('OPERATION_FAILED'))
  assert.equal(fixture.steerCalls, 1)
})

test('steer ACK carrying messageId still distinguishes acceptance from history observation', async t => {
  const fixture = await setup(t)
  fixture.ackMessageId = true
  const run = await fixture.relay.startRun({ workspace, task: 'original' })
  const receipt = await fixture.relay.steerRun(run.runId, input) as Receipt
  assertReceipt(receipt, false)
  assert.equal(receipt.messageId, 'steer-message')
  const duplicate = await fixture.relay.steerRun(run.runId, input) as Receipt
  assertReceipt(duplicate, false)
  assert.equal((await fixture.relay.getOperation(receipt.operationId)).state, 'acknowledged')
  fixture.observeSteer()
  assert.equal((await fixture.relay.reconcileOperation(receipt.operationId)).operation.state, 'reconciled')
  assertReceipt(await fixture.relay.steerRun(run.runId, input) as Receipt, true)
  assert.equal(fixture.steerCalls, 1)
})

test('a history read error after a clear steer ACK preserves acceptance instead of reporting unknown', async t => {
  const fixture = await setup(t)
  fixture.failHistoryAfterAck = true
  const run = await fixture.relay.startRun({ workspace, task: 'original' })
  const receipt = await fixture.relay.steerRun(run.runId, input) as Receipt
  assertReceipt(receipt, false)
  assert.equal((await fixture.operations()).find(operation => operation.operationId === receipt.operationId)!.state, 'acknowledged')
  const duplicate = await fixture.relay.steerRun(run.runId, input) as Receipt
  assertReceipt(duplicate, false)
  assert.equal(fixture.steerCalls, 1)
})

test('a steer message observed during the receipt window is durable without claiming execution', async t => {
  const fixture = await setup(t)
  fixture.observeOnSubmit = true
  const run = await fixture.relay.startRun({ workspace, task: 'original' })
  const receipt = await fixture.relay.steerRun(run.runId, input) as Receipt
  assertReceipt(receipt, true)
  assert.equal(receipt.messageId, 'steer-message')
  assert.equal((await fixture.relay.getOperation(receipt.operationId)).state, 'reconciled')
})

interface Receipt {
  accepted: boolean
  mode: string
  executionStatus: string
  userMessageObserved: boolean
  receiptPersisted: boolean
  rpcId: string
  operationId: string
  messageId: string | null
  durable: boolean
  replayed: boolean
}
function assertReceipt(receipt: Receipt, observed: boolean): void {
  assert.equal(receipt.accepted, true)
  assert.equal(receipt.mode, 'steer')
  assert.equal(receipt.executionStatus, 'not_observed')
  assert.equal(receipt.userMessageObserved, observed)
  assert.equal(receipt.receiptPersisted, true)
  assert.equal(receipt.durable, observed)
  assert.ok(receipt.rpcId.length > 0)
  assert.ok(receipt.operationId.length > 0)
}
interface Fixture {
  relay: RelayFacade
  steerCalls: number
  steerRpcId: string
  ackMessageId: boolean
  loseResponse: boolean
  rejectSteer: boolean
  observeOnSubmit: boolean
  failHistoryAfterAck: boolean
  restore(): RelayFacade
  observeSteer(): void
  operations(): Promise<OperationRecord[]>
}
async function setup(t: TestContext): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'relay-steer-receipt-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = {
    ...resolveConfig({ DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace, DSH_RELAY_STATE_FILE: join(directory, 'state.json') }),
    rpcTimeoutMs: 50, pollIntervalMs: 5,
  }
  const events: RpcEvent[] = []
  const fixture = { steerCalls: 0, steerRpcId: '', ackMessageId: false, loseResponse: false, rejectSteer: false, observeOnSubmit: false, failHistoryAfterAck: false } as Fixture
  fixture.observeSteer = () => {
    events.push({ type: 'user/message', seq: events.length + 1, time: events.length + 1, data: { id: 'steer-message', source: { kind: 'user', rpcId: fixture.steerRpcId } } })
  }
  const fakeFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; rpcId: string; payload: Record<string, unknown> }
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: ['session-1'] }], archivedSessionIds: [] }; break
      case 'session.create': value = { sessionId: 'session-1', agentPreset: 'standard' }; break
      case 'session.list': value = { items: [{ sessionId: 'session-1', running: true }] }; break
      case 'session.history': {
        if (fixture.steerCalls > 0 && fixture.failHistoryAfterAck) throw new Error('history temporarily unavailable')
        value = { events: events.map(event => ({ event })), hasMore: false, projections: { values: { permissions: { currentValue: 'read-only' } } } }
        break
      }
      case 'session.prompt': {
        if (request.payload.mode === 'steer') {
          fixture.steerCalls += 1
          fixture.steerRpcId = request.rpcId
          if (fixture.loseResponse) throw new Error('steer transport response lost')
          if (fixture.rejectSteer) return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId,
            result: { ok: false, error: { code: 'INVALID_PROMPT', message: 'steer rejected' } } }), { status: 200 })
          if (fixture.observeOnSubmit) fixture.observeSteer()
          value = { accepted: true, ...(fixture.ackMessageId ? { messageId: 'steer-message' } : {}) }
        } else {
          events.push({ type: 'user/message', seq: 1, time: 1, data: { id: 'start-message', source: { kind: 'user', rpcId: request.rpcId } } })
          value = { accepted: true, messageId: 'start-message' }
        }
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
  fixture.operations = async () => (JSON.parse(await readFile(config.stateFile, 'utf8')) as { operations: OperationRecord[] }).operations
  return fixture
}
function errorCode(code: string): (error: unknown) => boolean {
  return error => error instanceof RelayError && error.code === code
}
