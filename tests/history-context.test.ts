import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { HarnessGatewayFacade, type HarnessGatewayProvider, type TypertGatewayPort, type SessionSummary } from '../src/harness-gateway/index.js'
import { NativeControlFacade, registerNativeControlTools, type NativeHistoryRecord, type HistoryContextInput } from '../src/native-control/index.js'

type Call = { namespace: string; method: string; args: Readonly<Record<string, unknown>>; signal?: AbortSignal }
type Request = { address: { kind: 'session'; sessionId: string }; throughSeq: number; beforeSeq?: number; maxMessages: number }
function event(seq: number, type: string, data: unknown = {}): NativeHistoryRecord { return { type: 'event', event: { seq, type, data, time: 1000 + seq } } }
const assistant = (seq: number, text: string) => event(seq, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
const plugin = (seq: number) => event(seq, 'user/message', { source: { kind: 'plugin' }, content: 'private plugin text' })
class ContextPort implements TypertGatewayPort {
  histories = new Map<string, NativeHistoryRecord[]>([['session-a', []]])
  calls: Call[] = []
  override?: unknown
  overrides: unknown[] = []
  failure?: Error
  async invoke(call: Call): Promise<unknown> {
    this.calls.push(call)
    assert.equal(call.namespace, 'session')
    assert.equal(call.method, 'page')
    if (this.failure) throw this.failure
    const request = call.args.request as Request
    assert.equal(request.maxMessages, 10)
    if (this.overrides.length > 0) return this.overrides.shift()
    if (this.override !== undefined) return this.override
    const eligible = (this.histories.get(request.address.sessionId) ?? []).filter(record => record.event.seq <= request.throughSeq && (request.beforeSeq === undefined || record.event.seq < request.beforeSeq))
    let start = 0
    let count = 0
    for (let index = eligible.length - 1; index >= 0; index -= 1) {
      const type = eligible[index]!.event.type
      if (type === 'user/message' || type === 'assistant/message') count += 1
      if (count === request.maxMessages) { start = index; break }
    }
    return { records: structuredClone(eligible.slice(start)), hasMore: start > 0 }
  }
  async stream(): Promise<AsyncIterable<unknown>> { throw new Error('Context must never follow the newest tail') }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'history-context-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'project')
  const other = join(root, 'other')
  await mkdir(workspace)
  await mkdir(other)
  const port = new ContextPort()
  const catalog = { items: [
    { workspaceId: 'project', path: workspace, title: '', sessionIds: ['session-a'], createdAt: '', updatedAt: '' },
    { workspaceId: 'other', path: other, title: '', sessionIds: ['foreign'], createdAt: '', updatedAt: '' },
  ], archivedSessionIds: [] as string[] }
  const native: { sessions?: SessionSummary[] } = {}
  const roots = [workspace]
  const gateway = new HarnessGatewayFacade({
    listWorkspaces: async () => structuredClone(catalog),
    listSessions: async () => native.sessions ?? [...port.histories.keys()].map(sessionId => ({ sessionId, updatedAt: 0, running: false, blank: false })),
  } as unknown as HarnessGatewayProvider)
  const create = () => new NativeControlFacade({ gateway, typert: port, allowedWorkspaceRoots: roots })
  const control = create()
  const input: HistoryContextInput = { workspace: 'project', sessionId: 'session-a', anchorSeq: 100, throughSeq: 200 }
  const read = (overrides: Partial<HistoryContextInput> = {}) => control.readSessionContext({ ...input, ...overrides })
  return { root, workspace, other, port, catalog, native, roots, create, control, input, read }
}
const code = (expected: string) => (error: unknown) => { assert(error instanceof Error && 'code' in error); assert.equal(error.code, expected); return true }

test('ancient anchor seeks directly, selects nearest text chronologically, and pins cut across append/restart', async t => {
  const f = await fixture(t)
  f.port.histories.set('session-a', [assistant(2, 'earliest'), assistant(30, 'prior'), event(40, 'metadata'), event(80, 'user/message', { content: 'task' }), assistant(100, 'anchor'), assistant(101, 'later'), assistant(9999, 'tail')])
  const first = await f.read()
  assert.deepEqual(first.messages.map(message => message.seq), [30, 80, 100])
  assert.equal(first.hasEarlier, true)
  assert.equal(first.returnedBeforeMessages, 2)
  assert.equal(first.pagesRead, 1)
  assert.equal(first.recordsScanned, 4)
  assert.deepEqual(f.port.calls[0]!.args.request, { address: { kind: 'session', sessionId: 'session-a' }, throughSeq: 200, beforeSeq: 101, maxMessages: 10 })
  f.port.histories.get('session-a')!.push(assistant(10000, 'new tail'))
  assert.deepEqual(await f.create().readSessionContext(f.input), first)
  assert(first.messages.every(message => message.seq <= first.anchorSeq))
  assert.equal(first.contextComplete, true)
  assert.equal(first.sourceTrust, 'untrusted')
  assert.equal(first.order, 'oldest-first')
})

test('latest, zero and MAX_SAFE anchors omit beforeSeq when anchor equals cut', async t => {
  const f = await fixture(t)
  for (const anchorSeq of [0, 100, Number.MAX_SAFE_INTEGER]) {
    f.port.histories.set('session-a', [assistant(anchorSeq, 'anchor')])
    const result = await f.read({ anchorSeq, throughSeq: anchorSeq })
    assert.deepEqual(result.messages.map(message => message.seq), [anchorSeq])
    assert.equal(result.returnedBeforeMessages, 0)
    assert.equal(result.hasEarlier, false)
    assert(!Object.hasOwn(f.port.calls.at(-1)!.args.request as object, 'beforeSeq'))
  }
  f.port.histories.set('session-a', [assistant(Number.MAX_SAFE_INTEGER - 1, 'anchor')])
  await f.read({ anchorSeq: Number.MAX_SAFE_INTEGER - 1, throughSeq: Number.MAX_SAFE_INTEGER, beforeMessages: 0 })
  assert.equal((f.port.calls.at(-1)!.args.request as Request).beforeSeq, Number.MAX_SAFE_INTEGER)
})

test('continuation retains contiguous metadata, skips plugin/media/empty messages and finds exact requested count', async t => {
  const f = await fixture(t)
  const records = [assistant(1, 'earliest'), assistant(3, 'nearest prior'), ...Array.from({ length: 19 }, (_, i) => plugin(10 + i)),
    event(40, 'assistant/message', { content: [{ type: 'image', text: 'media' }] }), event(41, 'metadata'), assistant(50, ''), assistant(100, 'anchor')]
  f.port.histories.set('session-a', records)
  const result = await f.read({ beforeMessages: 1 })
  assert.deepEqual(result.messages.map(message => message.seq), [3, 100])
  assert.equal(result.pagesRead, 3)
  assert.equal(result.recordsScanned, records.length - 1)
  assert.equal(result.hasEarlier, true)
  const requests = f.port.calls.map(call => call.args.request as Request)
  assert(requests.slice(1).every((request, index) => request.beforeSeq! < requests[index]!.beforeSeq!))
  const all = await f.read({ beforeMessages: 10 })
  assert.deepEqual(all.messages.map(message => message.seq), [1, 3, 100])
  assert.equal(all.returnedBeforeMessages, 2)
  assert.equal(all.hasEarlier, false)
})

test('beforeMessages zero preserves raw-prefix uncertainty, including noise-only earlier events', async t => {
  const f = await fixture(t)
  f.port.histories.set('session-a', [event(1, 'metadata'), assistant(100, 'anchor')])
  const result = await f.read({ beforeMessages: 0 })
  assert.deepEqual(result.messages.map(message => message.seq), [100])
  assert.equal(result.recordsScanned, 1)
  assert.equal(result.hasEarlier, true)
})

test('maximum window returns exactly ten earlier messages and the anchor, without claiming earlier exhaustion', async t => {
  const f = await fixture(t)
  f.port.histories.set('session-a', [...Array.from({ length: 15 }, (_, index) => assistant(index + 1, 'prior')), assistant(100, 'anchor')])
  const result = await f.read({ beforeMessages: 10 })
  assert.deepEqual(result.messages.map(message => message.seq), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 100])
  assert.equal(result.returnedBeforeMessages, 10)
  assert.equal(result.pagesRead, 2)
  assert.equal(result.hasEarlier, true)
})

test('workspace path/ID, live membership, roots and archived sessions use search policy', async t => {
  const f = await fixture(t)
  f.catalog.items[0]!.sessionIds = ['session-a', 'archived', 'stale', 'child', 'foreign-cwd']
  f.catalog.archivedSessionIds = ['archived']
  f.native.sessions = [
    { sessionId: 'session-a', updatedAt: 0, running: false, blank: false, cwd: f.workspace + '/.' },
    { sessionId: 'archived', updatedAt: 0, running: false, blank: false },
    { sessionId: 'child', updatedAt: 0, running: false, blank: false, origin: 'subagent', cwd: f.workspace },
    { sessionId: 'foreign-cwd', updatedAt: 0, running: false, blank: false, cwd: f.other },
  ]
  f.port.histories.set('session-a', [assistant(100, 'anchor')])
  f.port.histories.set('archived', [assistant(100, 'archive')])
  assert.equal((await f.read({ workspace: f.workspace })).workspace, f.workspace)
  assert.equal((await f.read({ sessionId: 'archived' })).messages[0]!.textBlocks[0]!.text, 'archive')
  const count = f.port.calls.length
  for (const sessionId of ['stale', 'child', 'foreign-cwd', 'foreign', 'missing']) await assert.rejects(f.read({ sessionId }), code('SESSION_NOT_REGISTERED'))
  for (const workspace of [f.root, f.workspace + '/', 'other']) await assert.rejects(f.read({ workspace }), code('WORKSPACE_DENIED'))
  f.roots[0] = f.other
  await assert.rejects(f.read(), code('WORKSPACE_DENIED'))
  assert.equal(f.port.calls.length, count)
})

test('original block indices, Unicode prefixes, cumulative character limit and omitted block counts are explicit', async t => {
  const f = await fixture(t)
  f.port.histories.set('session-a', [event(100, 'assistant/message', { content: [
    { type: 'reasoning', text: 'hidden' }, { type: 'text', text: '' }, { type: 'text', text: '😀中🧬' }, { type: 'text', text: '尾😀abc' }, { type: 'text', text: 'omitted' },
  ] })])
  const message = (await f.read({ maxMessageChars: 5 })).messages[0]!
  assert.deepEqual(message.textBlocks, [
    { textBlockIndex: 2, text: '😀中🧬', textLength: 3, truncated: false },
    { textBlockIndex: 3, text: '尾😀', textLength: 5, truncated: true },
  ])
  assert.equal(message.textLength, 15)
  assert.equal(message.omittedTextBlocks, 1)
  assert.equal(message.messageTruncated, true)
  assert.equal(message.time, 1100)
  f.port.histories.set('session-a', [event(100, 'assistant/message', { content: Array.from({ length: 12 }, () => ({ type: 'text', text: '😀' })) })])
  const many = (await f.read()).messages[0]!
  assert.equal(many.textBlocks.length, 10)
  assert.equal(many.omittedTextBlocks, 2)
  assert.equal(many.textLength, 12)
  assert.equal(many.messageTruncated, true)
  assert(many.textBlocks.every(block => !block.truncated))
})

test('context matches legacy search extraction shapes without stringifying data or accepting plugin/tool text', async t => {
  const f = await fixture(t)
  const eligible = [
    event(1, 'user/message', { content: 'needle user' }), event(2, 'assistant/message', { message: { content: 'needle nested' } }),
    event(3, 'assistant/message', { text: 'needle fallback' }), event(4, 'assistant/message', { message: { content: null }, content: 'needle outer fallback' }),
    event(5, 'assistant/message', { content: [{ type: 'image', text: 'hidden' }, { type: 'text', text: 'needle actual' }] }),
  ]
  const excluded = [plugin(10), event(11, 'user/message', { message: { source: { kind: 'plugin' }, content: 'needle plugin' } }),
    event(12, 'assistant/message', { content: [{ type: 'tool-call', text: 'needle' }, { type: 'reasoning', text: 'needle' }], text: 'needle no fallback' }),
    event(13, 'tool/result', { content: 'needle' }), event(14, 'assistant/reasoning', { text: 'needle' }), assistant(15, '')]
  f.port.histories.set('session-a', [...eligible, ...excluded, assistant(100, 'anchor')])
  const result = await f.read({ beforeMessages: 10 })
  assert.deepEqual(result.messages.map(message => message.seq), [1, 2, 3, 4, 5, 100])
  for (const record of excluded) await assert.rejects(f.read({ anchorSeq: record.event.seq }), code('CONTEXT_ANCHOR_NOT_TEXT'))
  assert.equal(result.messages[4]!.textBlocks[0]!.textBlockIndex, 1)
})

test('missing exact anchor never falls back and invalid input positions fail before native calls', async t => {
  const f = await fixture(t)
  f.port.histories.set('session-a', [assistant(99, 'nearby'), assistant(101, 'later')])
  await assert.rejects(f.read(), code('CONTEXT_ANCHOR_NOT_FOUND'))
  const count = f.port.calls.length
  for (const input of [
    { anchorSeq: -1 }, { anchorSeq: 0.5 }, { anchorSeq: Number.MAX_SAFE_INTEGER + 1 }, { throughSeq: 99 }, { throughSeq: NaN },
    { beforeMessages: -1 }, { beforeMessages: 11 }, { beforeMessages: 0.5 }, { maxMessageChars: 0 }, { maxMessageChars: 4001 },
    { workspace: '' }, { workspace: '\0' }, { workspace: 'x'.repeat(4097) }, { sessionId: '' }, { sessionId: 'x'.repeat(513) },
  ]) await assert.rejects(f.read(input), code('INVALID_ARGUMENT'))
  assert.equal(f.port.calls.length, count)
})

test('malformed shapes, sequence order/cut/before violations and nonadvancing native pages fail explicitly', async t => {
  const f = await fixture(t)
  for (const raw of [
    null, {}, { records: [], hasMore: 'false' }, { records: [{ type: 'other' }], hasMore: false },
    { records: [{ type: 'event', event: { seq: 100 } }], hasMore: false },
    ...[[-1], [0.1], [Number.MAX_SAFE_INTEGER + 1], [101], [201], [100, 99], [99, 99]].map(seqs => ({ records: seqs.map(seq => assistant(seq, 'text')), hasMore: false })),
    { records: [], hasMore: true }, { records: [assistant(0, 'text'), assistant(100, 'anchor')], hasMore: true },
  ]) {
    f.port.override = raw
    await assert.rejects(f.read(), code('CONTEXT_NATIVE_API_INCOMPATIBLE'))
  }
  f.port.override = undefined
  f.port.overrides = [{ records: [plugin(90), assistant(100, 'anchor')], hasMore: true }, { records: [assistant(90, 'no advance')], hasMore: false }]
  await assert.rejects(f.read(), code('CONTEXT_NATIVE_API_INCOMPATIBLE'))
})

test('page byte cap, sanitized native errors and five-page scan budget never return partial success', async t => {
  const f = await fixture(t)
  f.port.override = { records: [assistant(100, 'x'.repeat(512 * 1024))], hasMore: false }
  await assert.rejects(f.read(), code('CONTEXT_OUTPUT_TOO_LARGE'))
  f.port.override = undefined
  f.port.failure = Object.assign(new Error('secret native detail'), { code: 'gateway/transport' })
  await assert.rejects(f.read(), error => {
    assert(error instanceof Error && 'code' in error)
    assert.equal(error.code, 'gateway/transport')
    assert(!JSON.stringify(error).includes('secret native detail'))
    assert(!error.message.includes('secret native detail'))
    return true
  })
  delete f.port.failure
  f.port.histories.set('session-a', [assistant(1, 'prior'), ...Array.from({ length: 60 }, (_, i) => plugin(i + 2)), assistant(100, 'anchor')])
  const before = f.port.calls.length
  await assert.rejects(f.read({ beforeMessages: 1 }), code('CONTEXT_SCAN_LIMIT'))
  assert.equal(f.port.calls.length - before, 5)
  // Completing on the final allowed page is accepted.
  f.port.histories.set('session-a', [assistant(1, 'prior'), ...Array.from({ length: 48 }, (_, i) => plugin(i + 2)), assistant(100, 'anchor')])
  assert.equal((await f.read({ beforeMessages: 1 })).pagesRead, 5)
})

test('real InMemory MCP advertises and validates context success while preserving errors and legacy tool contracts', async t => {
  const f = await fixture(t)
  f.port.histories.set('session-a', [assistant(100, 'original')])
  const server = new McpServer({ name: 'context-fixture', version: '1' })
  registerNativeControlTools(server, f.control)
  const client = new Client({ name: 'context-client', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    const tools = (await client.listTools()).tools
    const context = tools.find(tool => tool.name === 'read_session_context')!
    assert(context.outputSchema)
    assert.deepEqual(context.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    assert.equal(tools.length, 11)
    const success = await client.callTool({ name: context.name, arguments: { ...f.input, beforeMessages: 0 } })
    assert.notEqual(success.isError, true)
    assert.deepEqual((success.structuredContent as Record<string, unknown>).messages, (await f.read({ beforeMessages: 0 })).messages)
    const missing = await client.callTool({ name: context.name, arguments: { ...f.input, anchorSeq: 99 } })
    assert.equal(missing.isError, true)
    assert.equal(missing.structuredContent, undefined)
    assert.equal(JSON.parse((missing.content as { text: string }[])[0]!.text).code, 'CONTEXT_ANCHOR_NOT_FOUND')
    const invalid = await client.callTool({ name: context.name, arguments: { ...f.input, throughSeq: 99 } })
    assert.equal(invalid.isError, true)
    assert.equal(JSON.parse((invalid.content as { text: string }[])[0]!.text).code, 'INVALID_ARGUMENT')
    const legacy = await client.callTool({ name: 'read_session_history', arguments: { sessionId: 'missing' } })
    assert.equal(legacy.isError, true)
    assert.equal((legacy.structuredContent as Record<string, unknown>).code, 'SESSION_NOT_REGISTERED')
  } finally { await Promise.allSettled([client.close(), server.close()]) }
})
