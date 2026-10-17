import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveConfig, type RelayConfig } from '../src/config.js'
import { RelayFacade } from '../src/relay-broker/index.js'
import { incrementalStartSeq } from '../src/relay-broker/run-reconciler.js'
import type { FilePermissionBackend } from '../src/state-repository/index.js'
import type { RpcEvent } from '../src/types.js'

const workspace = fileURLToPath(new URL('../', import.meta.url))

const noopPermissions: FilePermissionBackend = {
  platform: 'linux',
  async restrict(): Promise<void> {},
  async check() { return { restricted: true } },
}

function relayOf(stateFile: string, fixture: Fixture): RelayFacade {
  return new RelayFacade(config(stateFile), fixture.fetch, undefined, { stateStore: { permissions: noopPermissions } })
}

test('pulls only new history from the highest loaded seq after the first refresh', async () => {
  const stateDirectory = await tempDirectory()
  const fixture = createFixture()
  const relay = relayOf(join(stateDirectory, 'state.json'), fixture)

  const started = await relay.startRun({ workspace, task: 'review' })
  assert.equal(started.status, 'running')

  fixture.grow(250, { terminal: false })
  const afterFirstRefresh = await relay.getRun(started.runId)
  assert.equal(afterFirstRefresh.lastEventSeq, 251)
  assert.equal(pagedCalls(fixture).length, 1 + 3, 'first refresh pages the whole backlog')

  fixture.grow(3, { terminal: false })
  const afterSecondRefresh = await relay.getRun(started.runId)
  assert.equal(afterSecondRefresh.lastEventSeq, 254)
  assert.ok(afterSecondRefresh.lastEventSeq > afterFirstRefresh.lastEventSeq, 'after cursor increases')
  const tail = pagedCalls(fixture).at(-1)!
  assert.equal(pagedCalls(fixture).length, 1 + 3 + 1, 'incremental refresh pulls a single tail page')
  assert.equal(tail.seqs.filter(seq => seq > 251).length, 3, 'incremental refresh returns only the new events')

  await rm(stateDirectory, { recursive: true, force: true })
})

test('steady-state refreshes never replay the backlog and preserve dedup', async () => {
  const stateDirectory = await tempDirectory()
  const fixture = createFixture()
  const relay = relayOf(join(stateDirectory, 'state.json'), fixture)
  const started = await relay.startRun({ workspace, task: 'review' })
  fixture.grow(120, { terminal: false })

  const runs = await relay.listRuns()
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.status, 'running')
  const steady = await relay.getRun(started.runId)
  assert.equal(steady.lastEventSeq, 121)
  const second = await relay.getRun(started.runId)
  assert.equal(second.lastEventSeq, 121)
  const pages = pagedCalls(fixture)
  assert.equal(pages.length, 1 + 2 + 1 + 1, 'backlog is paged once; later refreshes read one tail page each')
  for (const page of pages.slice(-2)) {
    assert.equal(page.seqs.filter(seq => seq > 121).length, 0, 'no new events are replayed in steady state')
  }
  await rm(stateDirectory, { recursive: true, force: true })
})

test('unchanged trailing history cannot keep a silent run alive', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const directory = await tempDirectory()
  try {
    const fixture = createFixture()
    const relay = relayOf(join(directory, 'state.json'), fixture)
    const started = await relay.startRun({ workspace, task: 'observe a silent run' })
    fixture.grow(1, { terminal: false })
    const progress = await relay.getRun(started.runId)
    t.mock.timers.tick(60_001)
    const stalled = await relay.getRun(started.runId)
    assert.equal(stalled.status, 'needs_attention')
    assert.equal(stalled.attentionReason, 'run_stalled')
    assert.equal(stalled.lastProgressAt, progress.lastProgressAt)
    t.mock.timers.tick(1_000)
    assert.equal((await relay.getRun(started.runId)).attentionReason, 'run_stalled')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a changed mutable trailing event recovers a run without a new sequence', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const directory = await tempDirectory()
  try {
    const fixture = createFixture()
    const relay = relayOf(join(directory, 'state.json'), fixture)
    const started = await relay.startRun({ workspace, task: 'observe streaming progress' })
    fixture.grow(1, { terminal: false })
    const before = await relay.getRun(started.runId)
    t.mock.timers.tick(60_001)
    assert.equal((await relay.getRun(started.runId)).attentionReason, 'run_stalled')
    fixture.reviseTrailing('streaming continued')
    t.mock.timers.tick(1)
    const recovered = await relay.getRun(started.runId)
    assert.equal(recovered.status, 'running')
    assert.equal(recovered.attentionReason, undefined)
    assert.equal(recovered.lastEventSeq, before.lastEventSeq)
    assert.equal(recovered.assistantText, 'streaming continued')
    assert.notEqual(recovered.lastProgressAt, before.lastProgressAt)
    t.mock.timers.tick(60_001)
    assert.equal((await relay.getRun(started.runId)).attentionReason, 'run_stalled')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a restarted stalled run does not mistake reloaded history for new progress', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const directory = await tempDirectory()
  try {
    const fixture = createFixture()
    const stateFile = join(directory, 'state.json')
    const first = relayOf(stateFile, fixture)
    const started = await first.startRun({ workspace, task: 'preserve stalled progress' })
    fixture.grow(1, { terminal: false })
    const before = await first.getRun(started.runId)
    t.mock.timers.tick(60_001)
    // The restart must also detect silence if the old process never polled it.
    const restarted = relayOf(stateFile, fixture)
    const stalled = await restarted.getRun(started.runId)
    assert.equal(stalled.attentionReason, 'run_stalled')
    assert.equal(stalled.lastProgressAt, before.lastProgressAt)
    const again = relayOf(stateFile, fixture)
    assert.equal((await again.getRun(started.runId)).attentionReason, 'run_stalled')
    fixture.grow(1, { terminal: false })
    t.mock.timers.tick(1)
    assert.equal((await again.getRun(started.runId)).status, 'running')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('concurrent polls for one run share an in-flight native refresh', async () => {
  const stateDirectory = await tempDirectory()
  const fixture = createFixture()
  const relay = relayOf(join(stateDirectory, 'state.json'), fixture)
  const started = await relay.startRun({ workspace, task: 'review' })
  fixture.grow(3, { terminal: false })

  let releaseHistory!: () => void
  let markHistoryStarted!: () => void
  let secondPoll: ReturnType<RelayFacade['getRun']> | undefined
  let listedRuns: ReturnType<RelayFacade['listRuns']> | undefined
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve })
  const historyStarted = new Promise<void>(resolve => { markHistoryStarted = resolve })
  fixture.beforeHistory = async () => {
    markHistoryStarted()
    await historyGate
  }
  const sessionsBefore = fixture.sessionListCalls
  const historyBefore = fixture.historyCalls.length

  const first = relay.getRun(started.runId)
  try {
    await historyStarted
    secondPoll = relay.getRun(started.runId)
    listedRuns = relay.listRuns()
    await new Promise<void>(resolve => setImmediate(resolve))

    assert.equal(fixture.sessionListCalls, sessionsBefore + 1, 'overlapping calls reuse one session listing')
    releaseHistory()
    const [one, two, runs] = await Promise.all([first, secondPoll, listedRuns])
    assert.equal(one.status, 'running')
    assert.equal(two.status, 'running')
    assert.equal(runs[0]!.status, 'running')
    assert.equal(fixture.historyCalls.length, historyBefore + 1, 'overlapping calls reuse one history read')
  } finally {
    releaseHistory()
    await Promise.allSettled([first, ...(secondPoll === undefined ? [] : [secondPoll]), ...(listedRuns === undefined ? [] : [listedRuns])])
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test('a rejected native refresh is removed so the next poll retries', async () => {
  const stateDirectory = await tempDirectory()
  const fixture = createFixture()
  const relay = relayOf(join(stateDirectory, 'state.json'), fixture)
  const started = await relay.startRun({ workspace, task: 'retry refresh' })
  const sessionsBefore = fixture.sessionListCalls
  const historyBefore = fixture.historyCalls.length
  let rejectOnce = true
  fixture.beforeHistory = async () => {
    if (!rejectOnce) return
    rejectOnce = false
    throw new Error('transient history failure')
  }
  try {
    await assert.rejects(relay.getRun(started.runId), /transient history failure/u)
    const retried = await relay.getRun(started.runId)
    assert.equal(retried.status, 'running')
    assert.equal(fixture.sessionListCalls, sessionsBefore + 2, 'retry starts a fresh native refresh')
    assert.equal(fixture.historyCalls.length, historyBefore + 1, 'retry re-reads history after the rejection')
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test('a slow refresh for one run does not block another run', async () => {
  const stateDirectory = await tempDirectory()
  const fixture = createFixture()
  const relay = relayOf(join(stateDirectory, 'state.json'), fixture)
  const firstRun = await relay.startRun({ workspace, task: 'slow refresh' })
  const secondRun = await relay.startRun({ workspace, task: 'independent refresh' })
  let releaseSlowHistory!: () => void
  let markSlowHistoryStarted!: () => void
  let slowPoll: ReturnType<RelayFacade['getRun']> | undefined
  let independentPoll: ReturnType<RelayFacade['getRun']> | undefined
  const slowGate = new Promise<void>(resolve => { releaseSlowHistory = resolve })
  const slowStarted = new Promise<void>(resolve => { markSlowHistoryStarted = resolve })
  fixture.beforeHistory = async sessionId => {
    if (sessionId !== firstRun.sessionId) return
    markSlowHistoryStarted()
    await slowGate
  }
  try {
    slowPoll = relay.getRun(firstRun.runId)
    await slowStarted
    independentPoll = relay.getRun(secondRun.runId)
    const result = await Promise.race([
      independentPoll,
      new Promise<null>(resolve => setTimeout(() => resolve(null), 1_000)),
    ])
    assert.ok(result !== null, 'another run refresh completes while the first history read is pending')
    assert.equal(result.status, 'running')
  } finally {
    releaseSlowHistory()
    await Promise.allSettled([...(slowPoll === undefined ? [] : [slowPoll]), ...(independentPoll === undefined ? [] : [independentPoll])])
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test('after a restart the first refresh resumes from the persisted checkpoint', async () => {
  const stateDirectory = await tempDirectory()
  const stateFile = join(stateDirectory, 'state.json')
  const fixture = createFixture()
  const first = relayOf(stateFile, fixture)
  const started = await first.startRun({ workspace, task: 'review' })
  fixture.grow(50, { terminal: false })
  await first.getRun(started.runId)

  fixture.grow(70, { terminal: true })
  const recovered = relayOf(stateFile, fixture)
  const resumed = await recovered.getRun(started.runId)
  assert.equal(resumed.status, 'succeeded')
  assert.ok(resumed.lastEventSeq >= 121)
  const pages = pagedCalls(fixture)
  const beforeRestart = pages.length
  const steady = await recovered.getRun(started.runId)
  assert.equal(steady.status, 'succeeded', 'terminal runs stay terminal')
  assert.equal(pagedCalls(fixture).length, beforeRestart, 'terminal runs do not reread history')
  await rm(stateDirectory, { recursive: true, force: true })
})

test('incrementalStartSeq is monotonic and falls back to baselineSeq on restore', () => {
  const baselineSeq = 40
  assert.equal(incrementalStartSeq([], baselineSeq), baselineSeq)
  const loaded = [event(41), event(45)]
  const cursor = incrementalStartSeq(loaded, baselineSeq)
  assert.equal(cursor, 44, 'the mutable trailing event remains inside the next incremental window')
  assert.ok(incrementalStartSeq([...loaded, event(46)], baselineSeq) > cursor)
  assert.equal(incrementalStartSeq([], baselineSeq), 40)
})

function event(seq: number): RpcEvent {
  return { type: 'user/message', seq, time: seq, data: {} }
}

function pagedCalls(fixture: Fixture): Fixture['historyCalls'] {
  return fixture.historyCalls.filter(call => call.maxMessages !== 1)
}

interface Fixture {
  fetch: typeof fetch
  historyCalls: Array<{ maxMessages: number; beforeSeq: number | undefined; returned: number; seqs: number[] }>
  sessionListCalls: number
  createdSessions: string[]
  beforeHistory(sessionId: string): Promise<void>
  grow(count: number, options: { terminal: boolean }): void
  reviseTrailing(text: string): void
}

function createFixture(): Fixture {
  const fixture: Fixture = {
    historyCalls: [],
    sessionListCalls: 0,
    createdSessions: [],
    beforeHistory: async () => {},
    fetch: async () => { throw new Error('unreachable') },
    grow: () => { throw new Error('unreachable') },
    reviseTrailing: () => { throw new Error('unreachable') },
  }
  const history: RpcEvent[] = []
  let sequence = 0

  const push = (event: RpcEvent): void => {
    history.push(event)
    sequence = Math.max(sequence, event.seq)
  }
  fixture.grow = (count, options) => {
    for (let index = 0; index < count; index += 1) {
      sequence += 1
      push(assistantEvent(sequence, `progress ${sequence}`))
    }
    if (options.terminal && history.every(item => item.type !== 'turn/end')) {
      sequence += 1
      push(turnEnd(sequence, 'completed'))
    }
  }
  fixture.reviseTrailing = text => {
    const trailing = history.at(-1)!
    assert.equal(trailing.type, 'assistant/message')
    history[history.length - 1] = assistantEvent(trailing.seq, text)
  }

  fixture.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      method: string
      rpcId: string
      payload: Record<string, unknown>
    }
    let value: unknown
    switch (request.method) {
      case 'host.describe':
        value = { version: 'rc.8', home: 'D:\\Harness\\profiles\\web' }
        break
      case 'workspace.list':
        value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: [] }], archivedSessionIds: [] }
        break
      case 'workspace.create':
        value = { workspace: { workspaceId: 'workspace-1', path: workspace, sessionIds: [] } }
        break
      case 'session.create': {
        const sessionId = `session-${fixture.createdSessions.length + 1}`
        fixture.createdSessions.push(sessionId)
        value = { sessionId, agentPreset: 'standard' }
        break
      }
      case 'session.list':
        fixture.sessionListCalls += 1
        value = { items: fixture.createdSessions.map(sessionId => ({ sessionId, running: true, projections: { asOfSeq: sequence } })) }
        break
      case 'session.history': {
        const sessionId = request.payload.sessionId as string
        await fixture.beforeHistory(sessionId)
        const maxMessages = request.payload.maxMessages as number
        const beforeSeq = request.payload.beforeSeq as number | undefined
        const pool = beforeSeq === undefined ? history : history.filter(event => event.seq < beforeSeq)
        const page = pool.slice(-maxMessages)
        fixture.historyCalls.push({
          maxMessages,
          beforeSeq,
          returned: page.length,
          seqs: page.map(event => event.seq),
        })
        value = {
          events: page.map(event => ({ event })),
          hasMore: pool.length > maxMessages,
          projections: { values: { permissions: { currentValue: 'read-only' } } },
        }
        break
      }
      case 'session.prompt':
        sequence += 1
        push(userEvent(sequence, request.rpcId, `start-message-${sequence}`))
        value = { accepted: true, messageId: `start-message-${sequence}` }
        break
      default:
        throw new Error(`unexpected method: ${request.method}`)
    }
    return response(request.rpcId, value)
  }
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

function response(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function config(stateFile: string): RelayConfig {
  return resolveConfig({
    DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/',
    DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace,
    DSH_RELAY_STATE_FILE: stateFile,
    DSH_RELAY_RPC_TIMEOUT_MS: '1000',
    DSH_RELAY_POLL_INTERVAL_MS: '100',
    DSH_RELAY_RUN_STALL_MS: '60000',
  })
}

async function tempDirectory(): Promise<string> {
  const directory = join(tmpdir(), `dsh-reconciler-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  return directory
}
