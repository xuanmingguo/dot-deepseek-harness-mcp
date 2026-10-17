import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { HarnessGatewayFacade, type HarnessGatewayProvider, type TypertGatewayPort } from '../src/harness-gateway/index.js'
import { MAX_ARTIFACT_BYTES, MAX_ARTIFACT_FILE_BYTES, MAX_NATIVE_JSON_BYTES, NativeControlError, NativeControlFacade, registerNativeControlTools, type NativeHistoryRecord, type QueueItem } from '../src/native-control/index.js'

type Call = { namespace: string; method: string; args: Readonly<Record<string, unknown>>; signal?: AbortSignal }
const item = (id: string): QueueItem => ({ id, content: [{ type: 'text', text: 'native ' + id }], source: { kind: 'user', rpcId: 'rpc-' + id } })
const event = (seq: number, text = 'event ' + seq): NativeHistoryRecord => ({
  type: 'event', event: { seq, type: 'assistant/message', time: seq, data: { text }, surfaceOp: 'append', unknownNativeField: { keep: true } },
})

class FakeTypert implements TypertGatewayPort {
  records = [1, 2, 3, 4, 5, 6].map(seq => event(seq))
  nextTurn = [item('turn-a'), item('turn-b')]
  nextStep = [item('step-a')]
  calls: Call[] = []
  closed = 0
  beforeUpdate?: (itemId: string, action: string) => void
  failUpdate?: Error & { code?: string }
  projectionOverride: unknown = undefined
  pageOverride: unknown = undefined
  async invoke(call: Call): Promise<unknown> {
    this.calls.push(call)
    assert.equal(call.namespace, 'session')
    const request = call.args.request as Record<string, unknown>
    if (call.method === 'projections') {
      assert.deepEqual(request, { sessionId: 'session-1' })
      return this.projectionOverride === undefined
        ? structuredClone({ kind: 'sequenced', asOfSeq: this.records.at(-1)?.event.seq ?? 0, values: { inbox: { 'next-turn': this.nextTurn, 'next-step': this.nextStep } } })
        : this.projectionOverride
    }
    if (call.method === 'page') {
      assert.deepEqual(request.address, { kind: 'session', sessionId: 'session-1' })
      return this.pageOverride ?? this.page(request.throughSeq as number, request.beforeSeq as number | undefined, request.maxMessages as number)
    }
    if (call.method === 'updateQueue') {
      const id = request.itemId as string
      const action = (request.action as { kind: string }).kind
      assert.equal(request.sessionId, 'session-1')
      this.beforeUpdate?.(id, action)
      if (this.failUpdate !== undefined) throw this.failUpdate
      if (![...this.nextTurn, ...this.nextStep].some(entry => entry.id === id)) throw Object.assign(new Error('not pending'), { code: 'session/queue-item-not-found' })
      if (action === 'steer' && !this.nextTurn.some(entry => entry.id === id)) throw Object.assign(new Error('not steerable'), { code: 'session/steer-unavailable' })
      this.nextTurn = this.nextTurn.filter(entry => entry.id !== id)
      this.nextStep = this.nextStep.filter(entry => entry.id !== id)
      return { accepted: true }
    }
    throw Object.assign(new Error('method unavailable'), { code: 'gateway/method-unavailable' })
  }
  async stream(call: Call): Promise<AsyncIterable<unknown>> {
    this.calls.push(call)
    assert.equal(call.method, 'follow')
    const request = call.args.request as { address: unknown; maxMessages: number }
    assert.deepEqual(request.address, { kind: 'session', sessionId: 'session-1' })
    const cut = this.records.at(-1)?.event.seq ?? 0
    const snapshot = { type: 'snapshot', header: { id: 'session-1' }, cursor: cut, ...this.page(cut, undefined, request.maxMessages) }
    const fake = this
    return (async function* () { try { yield snapshot } finally { fake.closed += 1 } })()
  }
  private page(cut: number, before: number | undefined, max: number) {
    const eligible = this.records.filter(record => record.event.seq <= cut && (before === undefined || record.event.seq < before))
    return { records: eligible.slice(-max), hasMore: eligible.length > max }
  }
  mutations() { return this.calls.filter(call => call.method === 'updateQueue') }
}
function control(typert = new FakeTypert(), roots: string[] = [], workspace = '/synthetic/project') {
  const gateway = new HarnessGatewayFacade({
    listWorkspaces: async () => ({
      items: [{ workspaceId: 'workspace-1', path: workspace, title: 'synthetic', sessionIds: ['session-1'], createdAt: '', updatedAt: '' }], archivedSessionIds: [],
    }),
  } as unknown as HarnessGatewayProvider)
  return new NativeControlFacade({ gateway, typert, allowedWorkspaceRoots: roots })
}
const rejectsCode = (code: string) => (error: unknown) => {
  assert(error instanceof Error && 'code' in error)
  assert.equal(error.code, code)
  return true
}

test('history preserves raw records/order and pins pages across append and facade restart', async () => {
  const typert = new FakeTypert()
  const first = await control(typert).readSessionHistory({ sessionId: 'session-1', maxMessages: 2 })
  assert.deepEqual(first.records, typert.records.slice(-2))
  assert.equal(first.throughSeq, 6)
  assert.equal(typert.closed, 1)
  assert(typert.calls[0]?.signal?.aborted)
  assert(first.nextCursor)
  typert.records.push(event(7), event(8))
  const restarted = control(typert)
  const second = await restarted.readSessionHistory({ sessionId: 'session-1', cursor: first.nextCursor, maxMessages: 2 })
  assert.deepEqual(second.records.map(record => record.event.seq), [3, 4])
  assert.equal(second.throughSeq, 6)
  const lastCall = typert.calls.at(-1)!
  assert.deepEqual(lastCall.args, { request: { address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 6, beforeSeq: 5, maxMessages: 2 } })
  assert(second.nextCursor)
  const third = await restarted.readSessionHistory({ sessionId: 'session-1', cursor: second.nextCursor, maxMessages: 2 })
  assert.deepEqual(third.records.map(record => record.event.seq), [1, 2])
  assert.equal(third.nextCursor, null)
  assert.equal(third.hasMore, false)
  assert.equal(typert.calls.filter(call => call.method === 'follow').length, 1)
})

test('history validates session/cursor/limits before native reads', async () => {
  const typert = new FakeTypert()
  const facade = control(typert)
  const first = await facade.readSessionHistory({ sessionId: 'session-1', maxMessages: 2 })
  assert(first.nextCursor)
  const count = typert.calls.length
  await assert.rejects(facade.readSessionHistory({ sessionId: 'other', cursor: first.nextCursor }), rejectsCode('INVALID_HISTORY_CURSOR'))
  await assert.rejects(facade.readSessionHistory({ sessionId: 'session-1', cursor: first.nextCursor + 'x' }), rejectsCode('INVALID_HISTORY_CURSOR'))
  for (const b of [-1, 0, 100, 1.5]) {
    const payload = Buffer.from(JSON.stringify({ v: 1, s: 'session-1', t: 6, b })).toString('base64url')
    const cursor = 'nh1.' + payload + '.' + createHash('sha256').update(payload).digest('base64url')
    await assert.rejects(facade.readSessionHistory({ sessionId: 'session-1', cursor }), rejectsCode('INVALID_HISTORY_CURSOR'))
  }
  await assert.rejects(facade.readSessionHistory({ sessionId: 'unknown' }), rejectsCode('SESSION_NOT_REGISTERED'))
  for (const maxMessages of [0, 51, 1.5]) await assert.rejects(facade.readSessionHistory({ sessionId: 'session-1', maxMessages }), rejectsCode('INVALID_ARGUMENT'))
  assert.equal(typert.calls.length, count)
})

test('history rejects oversized JSON without truncating native history', async () => {
  const typert = new FakeTypert()
  typert.records = [event(1, 'x'.repeat(MAX_NATIVE_JSON_BYTES))]
  const original = structuredClone(typert.records)
  await assert.rejects(control(typert).readSessionHistory({ sessionId: 'session-1', maxMessages: 1 }), rejectsCode('NATIVE_OUTPUT_TOO_LARGE'))
  assert.deepEqual(typert.records, original)
  assert.equal(typert.mutations().length, 0)
})
test('history rejects native pages violating anchor/order rather than dropping records', async () => {
  const typert = new FakeTypert()
  const facade = control(typert)
  const first = await facade.readSessionHistory({ sessionId: 'session-1', maxMessages: 2 })
  assert(first.nextCursor)
  for (const records of [[event(7)], [event(4), event(3)], [event(5)]]) {
    typert.pageOverride = { records, hasMore: false }
    await assert.rejects(facade.readSessionHistory({ sessionId: 'session-1', cursor: first.nextCursor }), rejectsCode('NATIVE_API_INCOMPATIBLE'))
  }
})
test('queue lists original next-turn/next-step content and removes only pending membership idempotently', async () => {
  const typert = new FakeTypert()
  const facade = control(typert)
  const queue = await facade.listSessionQueue('session-1')
  assert.deepEqual(queue.nextTurn, typert.nextTurn)
  assert.deepEqual(queue.nextStep, typert.nextStep)
  assert.equal((await facade.removeQueueItem('session-1', 'turn-a')).status, 'removed')
  assert.equal((await facade.removeQueueItem('session-1', 'turn-a')).status, 'already-absent')
  assert.equal((await facade.removeQueueItem('session-1', 'not-in-queue')).status, 'already-absent')
  assert.deepEqual(typert.mutations().map(call => call.args.request), [{ sessionId: 'session-1', itemId: 'turn-a', action: { kind: 'remove' } }])
})
test('removal tolerates an occurrence consumed between projection and native removal', async () => {
  const typert = new FakeTypert()
  typert.beforeUpdate = id => { typert.nextTurn = typert.nextTurn.filter(entry => entry.id !== id) }
  assert.equal((await control(typert).removeQueueItem('session-1', 'turn-a')).status, 'already-absent')
})
test('clear snapshots IDs, preserves new arrivals and all history, reports consumed occurrences', async () => {
  const typert = new FakeTypert()
  const original = structuredClone(typert.records)
  typert.beforeUpdate = id => {
    if (id === 'turn-a') {
      typert.nextTurn.push(item('new-arrival'))
      typert.nextTurn = typert.nextTurn.filter(entry => entry.id !== 'turn-b')
    }
  }
  const result = await control(typert).clearSessionQueue('session-1')
  assert.deepEqual(result.snapshotIds, ['turn-a', 'turn-b', 'step-a'])
  assert.deepEqual(result.removedIds, ['turn-a', 'step-a'])
  assert.deepEqual(result.alreadyAbsentIds, ['turn-b'])
  assert.deepEqual(result.newArrivalIds, ['new-arrival'])
  assert.deepEqual(result.remaining.nextTurn.map(entry => entry.id), ['new-arrival'])
  assert.deepEqual(result.stillPendingSnapshotIds, [])
  assert.equal(result.historyDeleted, false)
  assert.deepEqual(typert.records, original)
  assert.equal(typert.calls.some(call => /cancel|purge|clear|delete/i.test(call.method)), false)
})
test('clear stops after an uncertain removal and returns partial receipts plus read-only reconciliation', async () => {
  const typert = new FakeTypert()
  typert.beforeUpdate = id => {
    if (id === 'turn-b') {
      typert.nextTurn.push(item('new-arrival'))
      typert.failUpdate = Object.assign(new Error('lost acknowledgement'), { code: 'gateway/transport' })
    }
  }
  await assert.rejects(control(typert).clearSessionQueue('session-1'), error => {
    assert(error instanceof NativeControlError)
    assert.equal(error.code, 'NATIVE_ACTION_UNCERTAIN')
    assert.equal(error.details.doNotReplay, true)
    assert.equal(error.details.failedItemId, 'turn-b')
    assert.deepEqual(error.details.removedIds, ['turn-a'])
    assert.deepEqual(error.details.newArrivalIds, ['new-arrival'])
    assert.deepEqual(error.details.stillPendingSnapshotIds, ['turn-b', 'step-a'])
    return true
  })
  assert.equal(typert.mutations().length, 2)
  assert.equal(typert.nextStep.some(entry => entry.id === 'step-a'), true)
})
test('clear refuses more than 100 IDs before any mutation', async () => {
  const typert = new FakeTypert()
  typert.nextTurn = Array.from({ length: 101 }, (_, index) => item('item-' + index))
  typert.nextStep = []
  await assert.rejects(control(typert).clearSessionQueue('session-1'), rejectsCode('QUEUE_TOO_LARGE'))
  assert.equal(typert.mutations().length, 0)
})
test('steer uses native steer once and explicitly distinguishes steering from queued execution', async () => {
  const typert = new FakeTypert()
  const facade = control(typert)
  await assert.rejects(facade.steerQueueItem('session-1', 'step-a'), rejectsCode('QUEUE_ITEM_NOT_STEERABLE'))
  const receipt = await facade.steerQueueItem('session-1', 'turn-a')
  assert.equal(receipt.execution, 'current-turn-steering')
  assert.equal(receipt.queuedExecution, false)
  assert.equal((await facade.steerQueueItem('session-1', 'turn-a')).replayedReceipt, true)
  assert.equal(typert.mutations().length, 1)
  assert.deepEqual(typert.mutations()[0]?.args.request, { sessionId: 'session-1', itemId: 'turn-a', action: { kind: 'steer' } })
})
test('uncertain steer is never retried, including a concurrent/repeated call', async () => {
  const typert = new FakeTypert()
  typert.failUpdate = Object.assign(new Error('connection lost after dispatch'), { code: 'gateway/transport' })
  const facade = control(typert)
  const outcomes = await Promise.allSettled([facade.steerQueueItem('session-1', 'turn-a'), facade.steerQueueItem('session-1', 'turn-a')])
  assert(outcomes.every(result => result.status === 'rejected' && result.reason instanceof NativeControlError && result.reason.code === 'NATIVE_ACTION_UNCERTAIN'))
  await assert.rejects(facade.steerQueueItem('session-1', 'turn-a'), error => {
    assert(error instanceof NativeControlError)
    assert.equal(error.details.doNotReplay, true)
    return true
  })
  assert.equal(typert.mutations().length, 1)
  assert.equal(typert.nextTurn.some(entry => entry.id === 'turn-a'), true)
})
test('unsupported projections/services return explicit errors', async () => {
  const typert = new FakeTypert()
  const facade = control(typert)
  for (const projection of [null, { kind: 'migration-required', values: {} }, { kind: 'sequenced', asOfSeq: 1, values: {} }]) {
    typert.projectionOverride = projection
    await assert.rejects(facade.listSessionQueue('session-1'), error => {
      assert(error instanceof NativeControlError)
      assert(['SESSION_NOT_FOUND', 'QUEUE_UNAVAILABLE'].includes(error.code))
      return true
    })
  }
  typert.projectionOverride = undefined
  typert.failUpdate = Object.assign(new Error('unsupported method'), { code: 'gateway/method-unavailable' })
  await assert.rejects(facade.removeQueueItem('session-1', 'turn-a'), rejectsCode('gateway/method-unavailable'))
})

test('artifact reads bounded explicit base64 ranges with project reference metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(join(project, 'output'), { recursive: true })
  const bytes = Buffer.from([0, 255, 1, 2, 3, 4])
  await writeFile(join(project, 'output', 'result.bin'), bytes)
  const facade = control(new FakeTypert(), [], project)
  const first = await facade.readArtifact({ workspace: 'workspace-1', path: 'output/result.bin', maxBytes: 3 })
  assert.equal(first.encoding, 'base64')
  assert.deepEqual(Buffer.from(first.data, 'base64'), bytes.subarray(0, 3))
  assert.equal(first.reference.path, 'output/result.bin')
  assert.equal(first.reference.sizeBytes, bytes.length)
  assert.equal(first.nextOffsetBytes, 3)
  assert.equal(first.eof, false)
  const last = await facade.readArtifact({ workspace: project, path: 'output/result.bin', offsetBytes: 3 })
  assert.deepEqual(Buffer.from(last.data, 'base64'), bytes.subarray(3))
  assert.equal(last.nextOffsetBytes, null)
  assert.equal(last.eof, true)
  await assert.rejects(facade.readArtifact({ workspace: project, path: 'output/result.bin', offsetBytes: 7 }), rejectsCode('INVALID_ARGUMENT'))
  await assert.rejects(facade.readArtifact({ workspace: project, path: 'output/result.bin', maxBytes: MAX_ARTIFACT_BYTES + 1 }), rejectsCode('INVALID_ARGUMENT'))
})
test('artifact rejects traversal, prefix sibling escapes, file and directory symlinks, directories, oversized files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const sibling = join(root, 'project-other')
  await mkdir(project)
  await mkdir(sibling)
  await writeFile(join(sibling, 'outside.txt'), 'synthetic outside data')
  await writeFile(join(project, 'inside.txt'), 'inside')
  await symlink(join(sibling, 'outside.txt'), join(project, 'file-link'))
  await symlink(sibling, join(project, 'directory-link'))
  await symlink(join(project, 'inside.txt'), join(project, 'inside-link'))
  const huge = await open(join(project, 'huge'), 'w')
  await huge.truncate(MAX_ARTIFACT_FILE_BYTES + 1)
  await huge.close()
  const facade = control(new FakeTypert(), [], project)
  for (const path of ['../project-other/outside.txt', join(sibling, 'outside.txt')]) await assert.rejects(facade.readArtifact({ workspace: project, path }), rejectsCode('ARTIFACT_PATH_DENIED'))
  for (const path of ['file-link', 'directory-link/outside.txt', 'inside-link']) await assert.rejects(facade.readArtifact({ workspace: project, path }), rejectsCode('ARTIFACT_READ_FAILED'))
  await assert.rejects(facade.readArtifact({ workspace: project, path: 'huge' }), rejectsCode('ARTIFACT_TOO_LARGE'))
  await mkdir(join(project, 'directory'))
  await assert.rejects(facade.readArtifact({ workspace: project, path: 'directory' }), rejectsCode('ARTIFACT_NOT_REGULAR'))
  await assert.rejects(facade.readArtifact({ workspace: sibling, path: 'outside.txt' }), rejectsCode('WORKSPACE_DENIED'))
})
test('configured project roots permit contained project directories and reject registered outside roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const allowed = join(root, 'allowed')
  const project = join(allowed, 'project')
  const outside = join(root, 'outside')
  await mkdir(project, { recursive: true })
  await mkdir(outside)
  await writeFile(join(project, 'result.txt'), 'inside')
  await writeFile(join(outside, 'result.txt'), 'outside')
  const facade = control(new FakeTypert(), [allowed], outside)
  assert.equal(Buffer.from((await facade.readArtifact({ workspace: project, path: 'result.txt' })).data, 'base64').toString(), 'inside')
  await assert.rejects(facade.readArtifact({ workspace: 'workspace-1', path: 'result.txt' }), rejectsCode('WORKSPACE_DENIED'))
})
test('MCP registration exposes eleven native tools and explicit unavailable responses without a port', async () => {
  const server = new McpServer({ name: 'native-fixture', version: '1' })
  registerNativeControlTools(server)
  const client = new Client({ name: 'native-fixture-client', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['clear_session_queue', 'list_project_files', 'list_session_queue', 'read_artifact', 'read_project_text', 'read_session_context', 'read_session_history', 'remove_queue_item', 'search_project_text', 'search_session_history', 'steer_queue_item'])
    const response = await client.callTool({ name: 'read_session_history', arguments: { sessionId: 'session-1' } })
    assert.equal(response.isError, true)
    assert.equal((response.structuredContent as Record<string, unknown>)?.code, 'NATIVE_CONTROL_UNAVAILABLE')
  } finally { await Promise.allSettled([client.close(), server.close()]) }
})
test('MCP history tool exposes original native records using public facade', async () => {
  const typert = new FakeTypert()
  const server = new McpServer({ name: 'native-fixture', version: '1' })
  registerNativeControlTools(server, control(typert))
  const client = new Client({ name: 'native-fixture-client', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    const response = await client.callTool({ name: 'read_session_history', arguments: { sessionId: 'session-1', maxMessages: 1 } })
    assert.notEqual(response.isError, true)
    assert.deepEqual((response.structuredContent as Record<string, unknown>)?.records, typert.records.slice(-1))
  } finally { await Promise.allSettled([client.close(), server.close()]) }
})
