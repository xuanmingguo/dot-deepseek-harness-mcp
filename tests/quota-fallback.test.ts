import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { classifyQuotaFailure, QuotaFallbackController, QuotaFallbackError, registerQuotaFallbackTool, type QuotaFallbackHistoryPort, type QuotaFallbackRelayPort } from '../src/quota-fallback.js'
import type { HistoryInput, HistoryResult, NativeHistoryRecord } from '../src/native-control/index.js'
import type { OperationRecord, RunSnapshot } from '../src/types.js'

const originalId = 'original-run'
const task = 'Inspect the authorized synthetic project and report findings.'
const fixedKey = 'quota-fallback:' + originalId
const original = (): RunSnapshot => ({
  runId: originalId, operationId: 'original-operation', serviceId: 'service', sessionId: 'synthetic-session',
  sessionReused: false, parentRunId: null, workspace: '/synthetic/project', webUrl: 'https://synthetic.invalid/session',
  status: 'failed', modelSelection: { provider: 'zai', model: 'glm-5.3-flash', reasoningEffort: 'max' },
  permissionPreset: 'read-only', agentPreset: null, modelDefaultRestore: 'restored', warnings: [],
  task, taskPersisted: true, taskImageCount: 0, cancelRequested: false,
  startedAt: '2026-10-15T00:00:00.000Z', finishedAt: '2026-10-15T00:00:01.000Z',
  promptAdmission: 'accepted', promptMessageId: 'original-prompt', assistantText: '', assistantTextBytes: 0,
  assistantTextTruncated: false, lastEventSeq: 7, error: 'HTTP 429: rate_limit_exceeded',
})
const operation = (runId = originalId, key = 'original-key'): OperationRecord => ({
  operationId: runId === originalId ? 'original-operation' : 'fallback-operation', clientPrincipalId: 'alice',
  idempotencyKey: key, requestFingerprint: 'synthetic-fingerprint', runId, kind: runId === originalId ? 'start' : 'reply',
  rpcId: runId === originalId ? 'original-rpc' : 'fallback-rpc', fencingEpoch: 1, state: 'acknowledged',
  messageId: runId === originalId ? 'original-prompt' : 'fallback-prompt', error: null, createdAt: '', updatedAt: '',
})
const record = (seq: number, type: string, data: Record<string, unknown>): NativeHistoryRecord => ({ type: 'event', event: { seq, type, data, time: seq } })

class FakeHistory implements QuotaFallbackHistoryPort {
  calls: HistoryInput[] = []
  throwRead = false
  truncate = false
  chunkSize = 3
  records = [
    record(1, 'turn/start', { turn: 1 }),
    record(2, 'user/message', { id: 'original-prompt', role: 'user', source: { kind: 'user', rpcId: 'original-rpc' }, content: [{ type: 'text', text: task }] }),
    record(3, 'step/start', { turn: 1, step: 1 }),
    record(4, 'request/header', { reason: 'initial', header: { tools: [{ name: 'read', parameters: {} }] } }),
    record(5, 'assistant/attempt', { turn: 1, step: 1, stream: [] }),
    record(6, 'step/end', { turn: 1, step: 1 }),
    record(7, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'HTTP 429: rate limit exceeded' } } }),
  ]
  async readSessionHistory(input: HistoryInput): Promise<HistoryResult> {
    this.calls.push(structuredClone(input))
    assert.equal(input.sessionId, 'synthetic-session')
    assert.equal(input.maxMessages, 50)
    if (this.throwRead) throw new Error('native output too large')
    const before = input.cursor === undefined ? Infinity : Number(input.cursor.replace('before-', ''))
    const eligible = this.records.filter(entry => entry.event.seq < before)
    const records = eligible.slice(-this.chunkSize)
    const hasMore = !this.truncate && eligible.length > records.length
    return {
      sessionId: input.sessionId, throughSeq: this.records.at(-1)?.event.seq ?? 0,
      records: structuredClone(records), hasMore, nextCursor: hasMore ? 'before-' + records[0]!.event.seq : null,
    }
  }
  insert(type: string, data: Record<string, unknown>) {
    this.records.splice(-1, 0, record(0, type, data))
    this.records.forEach((entry, index) => { entry.event.seq = index + 1 })
  }
}

class FakeRelay implements QuotaFallbackRelayPort {
  runs = new Map<string, RunSnapshot>([[originalId, original()]])
  operations = new Map<string, OperationRecord>([['original-operation', operation()]])
  replies: Array<{ runId: string; input: Parameters<QuotaFallbackRelayPort['replyRun']>[1]; principal?: string | undefined }> = []
  reads: string[] = []
  rejectReply = false
  persistBeforeReject = false
  async getRun(runId: string, _principal?: string) {
    this.reads.push(runId)
    const run = this.runs.get(runId)
    assert(run)
    return structuredClone(run)
  }
  async getOperation(id: string) {
    const op = this.operations.get(id)
    assert(op)
    return structuredClone(op)
  }
  async listRuns(_serviceId?: string, _principal?: string) { return structuredClone([...this.runs.values()]) }
  async replyRun(runId: string, input: Parameters<QuotaFallbackRelayPort['replyRun']>[1], principal?: string) {
    this.replies.push({ runId, input: structuredClone(input), principal })
    const existing = [...this.runs.values()].find(run => run.idempotencyKey === input.idempotencyKey)
    if (existing !== undefined) return structuredClone(existing)
    const fallback: RunSnapshot = {
      ...original(), runId: 'fallback-run', operationId: 'fallback-operation', idempotencyKey: input.idempotencyKey,
      parentRunId: runId, modelSelection: { provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort },
      permissionPreset: input.permissionPreset, status: 'running', error: null, promptMessageId: 'fallback-prompt',
    }
    if (!this.rejectReply || this.persistBeforeReject) {
      this.runs.set(fallback.runId, fallback)
      this.operations.set('fallback-operation', operation(fallback.runId, input.idempotencyKey))
    }
    if (this.rejectReply) throw new Error('lost response after possible submission')
    return structuredClone(fallback)
  }
}
function setup() {
  const relay = new FakeRelay()
  const history = new FakeHistory()
  return { relay, history, controller: new QuotaFallbackController(relay, history, true, 'alice') }
}
const rejectsCode = (code: string) => (error: unknown) => {
  assert(error instanceof QuotaFallbackError)
  assert.equal(error.code, code)
  return true
}

test('classifies only explicit quota and rate-limit errors, rejecting ambiguous transport failures', () => {
  for (const text of ['HTTP 429', 'HTTP429 Too Many Requests', 'status: 429', 'rate_limit_exceeded', 'rate-limit', 'Rate limit exceeded', 'insufficient_quota', 'insufficient quota', 'quota exhausted', 'Quota exceeded', '额度已耗尽', '配额不足']) assert.notEqual(classifyQuotaFailure(text), null, text)
  for (const text of [null, '', 'unknown outcome', 'timeout', 'timed out after 429', '429 unknown outcome', 'connection lost: rate limit', 'HTTP 500', 'HTTP 4290', 'budget problem', 'invalid model']) assert.equal(classifyQuotaFailure(text), null, String(text))
})

test('fallback is disabled by default and performs no Relay reads or writes', async () => {
  const relay = new FakeRelay()
  await assert.rejects(new QuotaFallbackController(relay, new FakeHistory()).retryRunWithFallback(originalId), rejectsCode('QUOTA_FALLBACK_DISABLED'))
  assert.deepEqual(relay.reads, [])
  assert.deepEqual(relay.replies, [])
})

test('audits paginated raw history then retries exact persisted text with fixed key and explicit model', async () => {
  const { relay, history, controller } = setup()
  const result = await controller.retryRunWithFallback(originalId)
  assert.equal(history.calls.length, 2)
  assert.deepEqual(result.audit, { promptSeq: 2, throughSeq: 7, inspectedEvents: 6 })
  assert.equal(result.originalRunId, originalId)
  assert.equal(result.idempotencyKey, fixedKey)
  assert.equal(result.fallbackReason.classification, 'http-429')
  assert.equal(result.fallbackReason.originalError, original().error)
  assert.equal(result.run.runId, 'fallback-run')
  assert.deepEqual(relay.replies, [{
    runId: originalId, principal: 'alice', input: {
      task, provider: 'cliproxy', model: 'deepseek-flash', reasoningEffort: 'max',
      permissionPreset: 'read-only', confirmedDangerousPermission: false, idempotencyKey: fixedKey, openBrowser: false,
    },
  }])
})

test('retains the original write permission and dangerous-permission confirmation truthfully', async () => {
  for (const preset of ['workspace-write', 'danger-full-access'] as const) {
    const { relay, controller } = setup()
    relay.runs.get(originalId)!.permissionPreset = preset
    await controller.retryRunWithFallback(originalId)
    assert.equal(relay.replies[0]?.input.permissionPreset, preset)
    assert.equal(relay.replies[0]?.input.confirmedDangerousPermission, preset === 'danger-full-access')
  }
})

test('rejects non-failed states, different source models and non-quota errors before retry', async () => {
  for (const [change, code] of [
    [{ status: 'unknown' }, 'QUOTA_FALLBACK_INELIGIBLE'],
    [{ status: 'running' }, 'QUOTA_FALLBACK_INELIGIBLE'],
    [{ modelSelection: { provider: 'zai', model: 'other' } }, 'QUOTA_FALLBACK_MODEL_MISMATCH'],
    [{ modelSelection: { provider: 'other', model: 'glm-5.3-flash' } }, 'QUOTA_FALLBACK_MODEL_MISMATCH'],
    [{ error: 'timeout' }, 'QUOTA_FALLBACK_NOT_QUOTA'],
    [{ error: 'unknown 429 result' }, 'QUOTA_FALLBACK_NOT_QUOTA'],
    [{ taskPersisted: false }, 'QUOTA_FALLBACK_TASK_UNSAFE'],
    [{ taskImageCount: 1 }, 'QUOTA_FALLBACK_TASK_UNSAFE'],
  ] as const) {
    const { relay, controller } = setup()
    Object.assign(relay.runs.get(originalId)!, change)
    await assert.rejects(controller.retryRunWithFallback(originalId), rejectsCode(code))
    assert.equal(relay.replies.length, 0)
  }
})

test('accepts native pure-text/reasoning compact streams with n-minus-one time deltas', async () => {
  const { relay, history, controller } = setup()
  history.insert('assistant/message', {
    message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'A prefix' }] },
    stream: [
      { type: 'reasoning-chunks', index: 0, time0: 100, dt: [], texts: ['Thinking'] },
      { type: 'text-chunks', index: 1, time0: 101, dt: [2], texts: ['A ', 'prefix'] },
    ],
  })
  await controller.retryRunWithFallback(originalId)
  assert.equal(relay.replies.length, 1)
})

test('rejects native tool/subagent events and assistant tool-call blocks or packed chunks', async () => {
  for (const [type, data] of [
    ['tool/call', { callId: 'call', name: 'write', arguments: '{}' }],
    ['tool/result', { message: { role: 'tool', content: [] } }],
    ['subagent/spawned', { childSessionId: 'child' }],
    ['assistant/message', { message: { content: [{ type: 'tool-call', id: 'call', name: 'write', arguments: '{}' }] }, stream: [] }],
    ['assistant/attempt', { stream: [{ type: 'tool-call-chunks', index: 0, time0: 1, dt: [0], id: 'call', args: ['{}'] }] }],
    ['assistant/attempt', { stream: [{ type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } }] }],
    ['assistant/message', { message: { content: [{ type: 'text', text: 'prefix' }], tool_calls: [{ id: 'call' }] }, stream: [] }],
  ] as Array<[string, Record<string, unknown>]>) {
    const { relay, history, controller } = setup()
    history.insert(type, data)
    await assert.rejects(controller.retryRunWithFallback(originalId), rejectsCode('QUOTA_FALLBACK_SIDE_EFFECTS'))
    assert.equal(relay.replies.length, 0, type)
  }
})

test('rejects unknown event/assistant shapes rather than assuming no side effects', async () => {
  for (const [type, data] of [
    ['future/plugin-event', {}],
    ['assistant/message', { stream: [] }],
    ['assistant/attempt', {}],
    ['assistant/attempt', { stream: [{ type: 'unknown-packed-stream' }] }],
    ['assistant/attempt', { stream: [{ type: 'text-chunks', index: 0, time0: 1, dt: [0], texts: ['truncated'] }] }],
    ['assistant/message', { message: { content: [{ type: 'future-block' }] }, stream: [] }],
  ] as Array<[string, Record<string, unknown>]>) {
    const { relay, history, controller } = setup()
    history.insert(type, data)
    await assert.rejects(controller.retryRunWithFallback(originalId), rejectsCode('QUOTA_FALLBACK_UNKNOWN_RISK'))
    assert.equal(relay.replies.length, 0)
  }
})

test('rejects unavailable, truncated or gapped history and missing prompt correlation', async () => {
  for (const mode of ['unavailable', 'truncated', 'gap', 'rpc', 'message'] as const) {
    const { relay, history, controller } = setup()
    if (mode === 'unavailable') history.throwRead = true
    if (mode === 'truncated') history.truncate = true
    if (mode === 'gap') history.records.splice(5, 1)
    if (mode === 'rpc') (history.records[1]!.event.data as Record<string, unknown>).source = { kind: 'user', rpcId: 'different-rpc' }
    if (mode === 'message') (history.records[1]!.event.data as Record<string, unknown>).id = 'different-message'
    await assert.rejects(controller.retryRunWithFallback(originalId), error => {
      assert(error instanceof QuotaFallbackError)
      assert(['QUOTA_FALLBACK_HISTORY_UNAVAILABLE', 'QUOTA_FALLBACK_CORRELATION_MISSING', 'QUOTA_FALLBACK_HISTORY_INCOMPLETE'].includes(error.code))
      return true
    })
    assert.equal(relay.replies.length, 0)
  }
})

test('rejects native file/image prompts or content that differs from the persisted task', async () => {
  for (const content of [[{ type: 'file', attachment: {} }], [{ type: 'image', attachment: {} }], [{ type: 'text', text: 'different' }]]) {
    const { relay, history, controller } = setup()
    ;(history.records[1]!.event.data as Record<string, unknown>).content = content
    await assert.rejects(controller.retryRunWithFallback(originalId), rejectsCode('QUOTA_FALLBACK_TASK_UNSAFE'))
    assert.equal(relay.replies.length, 0)
  }
})

test('requires original operation ownership when a principal is supplied', async () => {
  const { relay, history } = setup()
  await assert.rejects(new QuotaFallbackController(relay, history, true, 'bob').retryRunWithFallback(originalId), rejectsCode('QUOTA_FALLBACK_CORRELATION_MISSING'))
  assert.equal(relay.replies.length, 0)
})

test('concurrent and repeated calls share one dispatch and a restarted controller reuses the durable key', async () => {
  const { relay, history, controller } = setup()
  const [first, second] = await Promise.all([controller.retryRunWithFallback(originalId), controller.retryRunWithFallback(originalId)])
  assert.equal(first.run.runId, second.run.runId)
  assert.equal(relay.replies.length, 1)
  assert.equal((await controller.retryRunWithFallback(originalId)).run.runId, first.run.runId)
  const restarted = new QuotaFallbackController(relay, history, true, 'alice')
  history.throwRead = true
  const replay = await restarted.retryRunWithFallback(originalId)
  assert.equal(replay.reused, true)
  assert.equal(replay.audit, null)
  assert.equal(replay.run.runId, first.run.runId)
  assert.equal(relay.replies.length, 1)
})

test('a lost response is reconciled by the same key without a second replyRun call', async () => {
  const { relay, controller } = setup()
  relay.rejectReply = true
  relay.persistBeforeReject = true
  await assert.rejects(controller.retryRunWithFallback(originalId), rejectsCode('QUOTA_FALLBACK_UNCERTAIN'))
  const recovered = await controller.retryRunWithFallback(originalId)
  assert.equal(recovered.reused, true)
  assert.equal(recovered.run.runId, 'fallback-run')
  assert.equal(recovered.idempotencyKey, fixedKey)
  assert.equal(relay.replies.length, 1)
})

test('an uncertain failed request without a durable run is never blindly submitted again', async () => {
  const { relay, controller } = setup()
  relay.rejectReply = true
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(controller.retryRunWithFallback(originalId), error => {
      assert(error instanceof QuotaFallbackError)
      assert.equal(error.code, 'QUOTA_FALLBACK_UNCERTAIN')
      assert.equal(error.details.idempotencyKey, fixedKey)
      assert.equal(error.details.doNotReplay, true)
      return true
    })
  }
  assert.equal(relay.replies.length, 1)
})

test('MCP tool is discoverable while disabled and returns an explicit error without reads', async () => {
  const relay = new FakeRelay()
  const server = new McpServer({ name: 'quota-fixture', version: '1' })
  registerQuotaFallbackTool(server, relay)
  const client = new Client({ name: 'quota-fixture-client', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    assert.equal((await client.listTools()).tools[0]?.name, 'retry_run_with_fallback')
    const result = await client.callTool({ name: 'retry_run_with_fallback', arguments: { runId: originalId } })
    assert.equal(result.isError, true)
    assert.equal((result.structuredContent as Record<string, unknown>).code, 'QUOTA_FALLBACK_DISABLED')
    assert.equal(relay.reads.length, 0)
  } finally { await Promise.allSettled([client.close(), server.close()]) }
})
