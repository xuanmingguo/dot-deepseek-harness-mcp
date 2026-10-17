import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { HarnessGatewayFacade, type HarnessGatewayProvider, type TypertGatewayPort, type SessionSummary } from '../src/harness-gateway/index.js'
import { MAX_NATIVE_JSON_BYTES, NativeControlFacade, registerNativeControlTools, type NativeHistoryRecord, type HistorySearchInput } from '../src/native-control/index.js'

type Call = { namespace: string; method: string; args: Readonly<Record<string, unknown>>; signal?: AbortSignal }
function event(seq: number, type: string, data: Record<string, unknown>): NativeHistoryRecord {
  return { type: 'event', event: { seq, type, data, time: 1000 + seq } }
}
const assistant = (seq: number, text: string) => event(seq, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
class HistoryPort implements TypertGatewayPort {
  histories = new Map<string, NativeHistoryRecord[]>([['session-a', []]])
  calls: Call[] = []
  override?: unknown
  failure?: Error
  page(sessionId: string, cut: number, before: number | undefined, max: number) {
    const eligible = (this.histories.get(sessionId) ?? []).filter(record => record.event.seq <= cut && (before === undefined || record.event.seq < before))
    return { records: structuredClone(eligible.slice(-max)), hasMore: eligible.length > max }
  }
  async invoke(call: Call): Promise<unknown> {
    this.calls.push(call)
    assert.equal(call.namespace, 'session')
    assert.equal(call.method, 'page')
    if (this.failure) throw this.failure
    const request = call.args.request as { address: { sessionId: string }; throughSeq: number; beforeSeq: number; maxMessages: number }
    assert.equal(request.maxMessages, 10)
    return this.override ?? this.page(request.address.sessionId, request.throughSeq, request.beforeSeq, request.maxMessages)
  }
  async stream(call: Call): Promise<AsyncIterable<unknown>> {
    this.calls.push(call)
    assert.equal(call.namespace, 'session')
    assert.equal(call.method, 'follow')
    if (this.failure) throw this.failure
    const request = call.args.request as { address: { sessionId: string }; maxMessages: number }
    const sessionId = request.address.sessionId
    const cursor = this.histories.get(sessionId)?.at(-1)?.event.seq ?? 0
    const snapshot = this.override ?? { type: 'snapshot', header: { id: sessionId }, cursor, ...this.page(sessionId, cursor, undefined, request.maxMessages) }
    return (async function* () { yield snapshot })()
  }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'history-search-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'project')
  const other = join(root, 'outside')
  await mkdir(workspace)
  await mkdir(other)
  const port = new HistoryPort()
  const catalog: { items: Array<{ workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string }>; archivedSessionIds: string[] } = { items: [
    { workspaceId: 'project', path: workspace, title: '', sessionIds: ['session-a'], createdAt: '', updatedAt: '' },
    { workspaceId: 'outside', path: other, title: '', sessionIds: ['foreign'], createdAt: '', updatedAt: '' },
  ], archivedSessionIds: [] }
  const native: { sessions?: SessionSummary[] } = {}
  const gateway = new HarnessGatewayFacade({
    listWorkspaces: async () => structuredClone(catalog),
    listSessions: async () => native.sessions ?? [...port.histories.keys()].map(sessionId => ({ sessionId, updatedAt: 0, running: false, blank: false })),
  } as unknown as HarnessGatewayProvider)
  const roots = [workspace]
  const create = () => new NativeControlFacade({ gateway, typert: port, allowedWorkspaceRoots: roots })
  const control = create()
  const search = (input: Partial<HistorySearchInput> = {}) => control.searchSessionHistory({ workspace: 'project', query: 'needle', ...input })
  return { root, workspace, other, port, catalog, native, roots, control, create, search }
}
const code = (expected: string) => (error: unknown) => {
  assert(error instanceof Error && 'code' in error)
  assert.equal(error.code, expected)
  return true
}
function rewriteCursor(input: string, edit: (value: Record<string, unknown>) => void): string {
  const payload = input.split('.')[1]!
  const value = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>
  edit(value)
  const changed = Buffer.from(JSON.stringify(value)).toString('base64url')
  return 'sh1.' + changed + '.' + createHash('sha256').update(changed).digest('base64url')
}

test('search extracts original user/assistant text shapes and excludes plugins, reasoning, tools and media', async t => {
  const f = await fixture(t)
  f.port.histories.set('session-a', [
    event(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'needle task' }] }),
    assistant(2, 'needle result'),
    event(3, 'user/message', { message: { content: 'needle nested task' } }),
    event(4, 'assistant/message', { content: 'needle string result' }),
    event(5, 'assistant/message', { text: 'needle fallback' }),
    event(6, 'user/message', { source: { kind: 'plugin', plugin: 'context' }, content: 'needle private context' }),
    event(7, 'user/message', { message: { source: { kind: 'plugin' }, content: 'needle plugin' } }),
    event(8, 'assistant/message', { message: { content: [
      { type: 'reasoning', text: 'needle reasoning' }, { type: 'tool-call', text: 'needle call' },
      { type: 'tool-result', text: 'needle result' }, { type: 'image', text: 'needle image' },
    ] }, text: 'needle must not fall through', arbitrary: 'needle must not stringify' }),
    event(9, 'tool/result', { content: 'needle result' }),
    event(10, 'assistant/reasoning', { text: 'needle reasoning' }),
    event(11, 'assistant/message', { message: { content: [{ type: 'image', text: 'needle image' }, { type: 'text', text: 'needle real text' }] } }),
  ])
  const result = await f.search()
  assert.deepEqual(result.matches.map(match => match.seq), [11, 5, 4, 3, 2, 1])
  assert.equal(result.matches[0]?.textBlockIndex, 1)
  assert.deepEqual(result.matches.map(match => match.role), ['assistant', 'assistant', 'assistant', 'user', 'assistant', 'user'])
  assert(result.matches.every(match => match.throughSeq === 11 && match.time === 1000 + match.seq && match.eventType === match.role + '/message'))
  assert.equal(result.pagesRead, 2)
  assert.equal(result.recordsScanned, 11)
  assert.equal(result.scanComplete, true)
  assert.equal(result.sourceTrust, 'untrusted')
  assert.deepEqual((await f.search({ role: 'user' })).matches.map(match => match.seq), [3, 1])
  assert.deepEqual((await f.search({ role: 'assistant' })).matches.map(match => match.seq), [11, 5, 4, 2])
})

test('matching is literal, case aware and Unicode safe with original bounded excerpts', async t => {
  const f = await fixture(t)
  const text = '😀'.repeat(800) + '中 文 NeEdLe [a-z]+.*? 😀尾' + '🧬'.repeat(900)
  f.port.histories.set('session-a', [assistant(1, text), assistant(2, 'different abc')])
  for (const query of ['needle', '中 文', '[a-z]+.*?', '😀尾']) {
    const result = await f.search({ query })
    assert.equal(result.matches.length, 1)
    const match = result.matches[0]!
    assert.equal(Array.from(match.excerpt).length, 600)
    assert.equal(match.textLength, Array.from(text).length)
    assert.equal(match.truncated, true)
    assert.equal(match.excerpt, Array.from(text).slice(match.excerptStart, match.excerptStart + 600).join(''))
    assert(!match.excerpt.includes('\ufffd'))
    assert(match.excerpt.toLowerCase().includes(query.toLowerCase()))
  }
  assert.equal((await f.search({ query: 'needle', caseSensitive: true })).matches.length, 0)
  assert.equal((await f.search({ query: 'NeEdLe', caseSensitive: true })).matches.length, 1)
  assert.equal((await f.search({ query: 'abc.*' })).matches.length, 0)
  f.port.histories.set('session-a', [assistant(1, 'abc KELVIN 尾')])
  assert.equal((await f.search({ query: 'kelvin' })).matches[0]?.excerpt, 'abc KELVIN 尾')
})

test('workspace registration, exact path, session membership and current root policy gate every search', async t => {
  const f = await fixture(t)
  f.port.histories.set('session-a', [assistant(1, 'needle')])
  assert.equal((await f.search({ workspace: f.workspace })).matches.length, 1)
  const before = f.port.calls.length
  await assert.rejects(f.search({ workspace: f.root }), code('WORKSPACE_DENIED'))
  await assert.rejects(f.search({ workspace: f.workspace + '/' }), code('WORKSPACE_DENIED'))
  await assert.rejects(f.search({ workspace: 'outside' }), code('WORKSPACE_DENIED'))
  await assert.rejects(f.search({ sessionId: 'foreign' }), code('SESSION_NOT_REGISTERED'))
  await assert.rejects(f.search({ sessionId: 'unknown' }), code('SESSION_NOT_REGISTERED'))
  assert.equal(f.port.calls.length, before)
  f.catalog.items[0]!.sessionIds = []
  assert.equal((await f.search()).sessionsTotal, 0)
  assert.equal(f.port.calls.length, before)
  f.catalog.items[0]!.sessionIds = ['session-a']
  f.port.histories.set('session-a', Array.from({ length: 12 }, (_, i) => assistant(i + 1, 'needle')))
  const first = await f.search({ limit: 1 })
  assert(first.nextCursor)
  f.roots[0] = f.other
  const count = f.port.calls.length
  await assert.rejects(f.search({ cursor: first.nextCursor }), code('WORKSPACE_DENIED'))
  assert.equal(f.port.calls.length, count)
})

test('mid-page limit continues without skips or duplicates, supports replay, restart and pinned append cut', async t => {
  const f = await fixture(t)
  f.port.histories.set('session-a', Array.from({ length: 23 }, (_, i) => assistant(i + 1, 'needle ' + (i + 1))))
  const first = await f.search({ limit: 3 })
  assert.deepEqual(first.matches.map(match => match.seq), [23, 22, 21])
  assert.equal(first.recordsScanned, 3)
  assert.equal(first.pagesRead, 1)
  assert(first.nextCursor)
  f.port.histories.get('session-a')!.push(assistant(24, 'needle new arrival'))
  const second = await f.search({ cursor: first.nextCursor, limit: 4 })
  const replay = await f.create().searchSessionHistory({ workspace: 'project', query: 'needle', cursor: first.nextCursor, limit: 4 })
  assert.deepEqual(second, replay)
  assert.deepEqual(second.matches.map(match => match.seq), [20, 19, 18, 17])
  assert(second.matches.every(match => match.throughSeq === 23))
  const sequences = [...first.matches, ...second.matches].map(match => match.seq)
  let cursor = second.nextCursor
  while (cursor !== null) {
    const page = await f.search({ cursor, limit: 4, scanPages: 1 })
    sequences.push(...page.matches.map(match => match.seq))
    cursor = page.nextCursor
    assert.equal(page.scanComplete, cursor === null)
    assert.equal(page.hasMore, cursor !== null)
  }
  assert.deepEqual(sequences, Array.from({ length: 23 }, (_, i) => 23 - i))
  assert(f.port.calls.every(call => call.method === 'follow' || call.method === 'page'))
  assert.equal(f.port.calls.filter(call => call.method === 'follow').length, 1)
})

test('empty-match budget continues to older matches and eventual completeness across lexical sessions', async t => {
  const f = await fixture(t)
  f.catalog.items[0]!.sessionIds = ['session-z', 'session-a']
  f.port.histories.set('session-a', Array.from({ length: 22 }, (_, i) => assistant(i + 1, i === 0 ? 'needle oldest' : 'other')))
  f.port.histories.set('session-z', [assistant(1000, 'needle newer timestamp')])
  const first = await f.search({ scanPages: 1 })
  assert.deepEqual(first.matches, [])
  assert.equal(first.scanComplete, false)
  assert.equal(first.hasMore, true)
  assert.equal(first.recordsScanned, 10)
  assert.equal(first.sessionsVisited, 1)
  assert.equal(first.sessionsTotal, 2)
  assert(first.nextCursor)
  const second = await f.search({ cursor: first.nextCursor, scanPages: 1 })
  assert.deepEqual(second.matches, [])
  assert(second.nextCursor)
  const third = await f.search({ cursor: second.nextCursor, scanPages: 2 })
  assert.deepEqual(third.matches.map(match => [match.sessionId, match.seq]), [['session-a', 1], ['session-z', 1000]])
  assert.equal(third.sessionsVisited, 2)
  assert.equal(third.recordsScanned, 3)
  assert.equal(third.scanComplete, true)
  assert.equal(third.nextCursor, null)
})

test('unvisited sessions capture their cut on first visit and explicit selected session scope stays isolated', async t => {
  const f = await fixture(t)
  f.catalog.items[0]!.sessionIds = ['session-z', 'session-a']
  f.port.histories.set('session-a', [assistant(1, 'needle a')])
  f.port.histories.set('session-z', [assistant(2, 'needle z')])
  const first = await f.search({ limit: 1 })
  assert(first.nextCursor)
  f.port.histories.get('session-z')!.push(assistant(3, 'needle newly arrived z'))
  const next = await f.search({ cursor: first.nextCursor })
  assert.deepEqual(next.matches.map(match => match.seq), [3, 2])
  const selected = await f.search({ sessionId: 'session-z' })
  assert.equal(selected.sessionsTotal, 1)
  assert(selected.matches.every(match => match.sessionId === 'session-z'))
})

test('cursor rejects changed membership, cross-filter reuse, tampering and bad native positions before native reads', async t => {
  const f = await fixture(t)
  f.port.histories.set('session-a', Array.from({ length: 12 }, (_, i) => assistant(i + 1, 'needle')))
  const first = await f.search({ limit: 1 })
  assert(first.nextCursor)
  const cursor = first.nextCursor
  const before = f.port.calls.length
  for (const input of [
    { cursor: cursor + 'x' }, { cursor: 'x'.repeat(16001) }, { cursor, query: 'other' },
    { cursor, role: 'user' as const }, { cursor, caseSensitive: true }, { cursor, workspace: f.workspace },
    { cursor, sessionId: 'session-a' }, { cursor: rewriteCursor(cursor, value => { value.i = 5 }) },
    { cursor: rewriteCursor(cursor, value => { value.n = 'not-native' }) },
    { cursor: rewriteCursor(cursor, value => { value.extra = true }) },
  ]) await assert.rejects(f.search(input), code('INVALID_SEARCH_CURSOR'))
  const nested = rewriteCursor(cursor, value => {
    const payload = Buffer.from(JSON.stringify({ v: 1, s: 'foreign', t: 12, b: 12 })).toString('base64url')
    value.n = 'nh1.' + payload + '.' + createHash('sha256').update(payload).digest('base64url')
  })
  await assert.rejects(f.search({ cursor: nested }), code('INVALID_SEARCH_CURSOR'))
  assert.equal(f.port.calls.length, before)
  f.catalog.items[0]!.sessionIds.push('session-new')
  f.port.histories.set('session-new', [])
  await assert.rejects(f.search({ cursor }), code('SEARCH_SCOPE_CHANGED'))
  assert.equal(f.port.calls.length, before)
  f.catalog.items[0]!.sessionIds = ['session-a']
  const selected = await f.search({ sessionId: 'session-a', limit: 1 })
  assert(selected.nextCursor)
  const count = f.port.calls.length
  f.catalog.items[0]!.sessionIds = []
  await assert.rejects(f.search({ cursor: selected.nextCursor, sessionId: 'session-a' }), code('SEARCH_SCOPE_CHANGED'))
  assert.equal(f.port.calls.length, count)
})

test('search membership follows visible native sessions, excludes stale/subagent/foreign cwd, and includes archives', async t => {
  const f = await fixture(t)
  f.catalog.items[0]!.sessionIds = ['session-a', 'stale', 'subagent', 'foreign-cwd', 'archived']
  f.catalog.archivedSessionIds = ['archived']
  f.native.sessions = [
    { sessionId: 'session-a', updatedAt: 0, running: false, blank: false, cwd: f.workspace + '/.' },
    { sessionId: 'subagent', updatedAt: 0, running: false, blank: false, origin: 'subagent', cwd: f.workspace },
    { sessionId: 'foreign-cwd', updatedAt: 0, running: false, blank: false, cwd: f.other },
    { sessionId: 'archived', updatedAt: 0, running: false, blank: false },
  ]
  for (const sessionId of f.catalog.items[0]!.sessionIds) f.port.histories.set(sessionId, [assistant(1, 'needle ' + sessionId), assistant(2, 'needle newer')])
  const complete = await f.search()
  assert.equal(complete.sessionsTotal, 2)
  assert.deepEqual(complete.matches.map(match => match.sessionId), ['archived', 'archived', 'session-a', 'session-a'])
  const before = f.port.calls.length
  for (const sessionId of ['stale', 'subagent', 'foreign-cwd']) await assert.rejects(f.search({ sessionId }), code('SESSION_NOT_REGISTERED'))
  assert.equal(f.port.calls.length, before)
  assert.equal((await f.search({ sessionId: 'archived' })).matches.length, 2)
  const first = await f.search({ limit: 1 })
  assert(first.nextCursor)
  const count = f.port.calls.length
  f.native.sessions = f.native.sessions.filter(session => session.sessionId !== 'session-a')
  await assert.rejects(f.search({ cursor: first.nextCursor }), code('SEARCH_SCOPE_CHANGED'))
  assert.equal(f.port.calls.length, count)
})

test('canonical cursor rejects noncanonical JSON and base64 forms', async t => {
  const f = await fixture(t)
  f.port.histories.set('session-a', [assistant(1, 'needle'), assistant(2, 'needle')])
  const first = await f.search({ limit: 1 })
  assert(first.nextCursor)
  const cursor = first.nextCursor
  const parsed = JSON.parse(Buffer.from(cursor.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>
  const payload = Buffer.from(JSON.stringify({ n: parsed.n, i: parsed.i, m: parsed.m, f: parsed.f, v: parsed.v })).toString('base64url')
  const reordered = 'sh1.' + payload + '.' + createHash('sha256').update(payload).digest('base64url')
  const count = f.port.calls.length
  await assert.rejects(f.search({ cursor: reordered }), code('INVALID_SEARCH_CURSOR'))
  await assert.rejects(f.search({ cursor: cursor.replace('.', '.=') }), code('INVALID_SEARCH_CURSOR'))
  assert.equal(f.port.calls.length, count)
})

test('argument bounds fail before native reads', async t => {
  const f = await fixture(t)
  for (const input of [
    { query: '' }, { query: '  ' }, { query: 'x'.repeat(257) }, { query: '\0' },
    { limit: 0 }, { limit: 26 }, { limit: 1.5 }, { scanPages: 0 }, { scanPages: 11 },
    { workspace: '' }, { workspace: 'x'.repeat(4097) }, { sessionId: '' },
  ]) await assert.rejects(f.search(input), code('INVALID_ARGUMENT'))
  assert.equal(f.port.calls.length, 0)
})

test('native failures, oversized pages and invalid shapes fail explicitly without false complete results', async t => {
  const f = await fixture(t)
  f.port.failure = Object.assign(new Error('private native detail'), { code: 'gateway/transport' })
  await assert.rejects(f.search(), error => {
    assert(error instanceof Error && 'code' in error)
    assert.equal(error.code, 'gateway/transport')
    assert(!error.message.includes('private native detail'))
    return true
  })
  delete f.port.failure
  f.port.histories.set('session-a', [assistant(1, 'needle' + 'x'.repeat(MAX_NATIVE_JSON_BYTES))])
  await assert.rejects(f.search(), code('NATIVE_OUTPUT_TOO_LARGE'))
  for (const records of [[{ type: 'unexpected' }], [assistant(2, 'needle'), assistant(1, 'needle')], [assistant(4, 'needle')]]) {
    f.port.override = { type: 'snapshot', header: { id: 'session-a' }, cursor: 3, records, hasMore: false }
    await assert.rejects(f.search(), code('NATIVE_API_INCOMPATIBLE'))
  }
})

test('real MCP exposes read-only success schema, validates output and returns explicit search error JSON', async t => {
  const f = await fixture(t)
  f.port.histories.set('session-a', [assistant(1, 'needle answer')])
  const server = new McpServer({ name: 'history-search-fixture', version: '1' })
  registerNativeControlTools(server, f.control)
  const client = new Client({ name: 'history-search-client', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    const tool = (await client.listTools()).tools.find(item => item.name === 'search_session_history')!
    assert(tool.outputSchema)
    assert.equal(tool.annotations?.readOnlyHint, true)
    assert.equal(tool.annotations?.destructiveHint, false)
    const result = await client.callTool({ name: 'search_session_history', arguments: { workspace: 'project', query: 'needle' } })
    assert.notEqual(result.isError, true)
    const success = result.structuredContent as Record<string, unknown>
    assert.equal((success.matches as Array<{ excerpt: string }>)[0]?.excerpt, 'needle answer')
    assert.equal(success.scanComplete, true)
    const error = await client.callTool({ name: 'search_session_history', arguments: { workspace: 'project', query: 'needle', cursor: 'broken' } })
    assert.equal(error.isError, true)
    assert.equal(error.structuredContent, undefined)
    const content = error.content as Array<{ type: string; text: string }>
    assert.equal(JSON.parse(content[0]!.text).code, 'INVALID_SEARCH_CURSOR')
    const original = await client.callTool({ name: 'read_session_history', arguments: { sessionId: 'session-a', maxMessages: 1 } })
    assert.deepEqual((original.structuredContent as Record<string, unknown>).records, f.port.histories.get('session-a'))
  } finally { await Promise.allSettled([client.close(), server.close()]) }
})
