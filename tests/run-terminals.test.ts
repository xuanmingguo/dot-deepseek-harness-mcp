import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createNativeRunTerminalControl, registerRunTerminalTools, RunTerminalError, type RunTerminalControl, type RunTerminalRelayPort } from '../src/run-terminals.js'
import type { RunSnapshot } from '../src/types.js'

class FakeAgent {
  status = 'idle'
  busyMaintenance = false
  maintenanceCount = 0
  onRelease?: () => void
  constructor(readonly id: string) {}
  async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.status !== 'idle' || this.busyMaintenance) throw new Error('Agent is not truly idle')
    this.maintenanceCount += 1
    this.busyMaintenance = true
    try { return await task(new AbortController().signal) }
    finally { this.busyMaintenance = false; this.onRelease?.() }
  }
}
class FakeTerminals {
  sessions = new Map<FakeAgent, string[]>()
  pending = new Set<FakeAgent>()
  failIds = new Set<string>()
  alreadyClosing = new Set<string>()
  kills: Array<{ owner: FakeAgent; id: string; reason: string }> = []
  lists: FakeAgent[] = []
  onKill?: (owner: FakeAgent, id: string) => void
  list(owner: FakeAgent) {
    this.lists.push(owner)
    return (this.sessions.get(owner) ?? []).map(sessionId => ({ sessionId, type: 'synthetic-pty', status: { kind: 'running' } }))
  }
  hasOwnerActivity(owner: FakeAgent) { return this.pending.has(owner) || (this.sessions.get(owner)?.length ?? 0) > 0 }
  async kill(owner: FakeAgent, id: string, reason: string) {
    assert(owner.busyMaintenance, 'kill must hold the native true-idle boundary')
    this.kills.push({ owner, id, reason })
    assert(this.sessions.get(owner)?.includes(id), 'only this exact owner may be killed')
    this.onKill?.(owner, id)
    if (this.failIds.has(id)) throw Object.assign(new Error('synthetic cleanup failed: ' + id), { code: 'CLEANUP_FAILED' })
    this.sessions.set(owner, this.sessions.get(owner)!.filter(entry => entry !== id))
    return !this.alreadyClosing.has(id)
  }
}
function fixture() {
  const owner = new FakeAgent('session-1')
  const other = new FakeAgent('session-2')
  const agents = new Map([[owner.id, owner], [other.id, other]])
  const terminals = new FakeTerminals()
  terminals.sessions.set(owner, [])
  terminals.sessions.set(other, ['other-owner-terminal'])
  const lookups: Array<{ owner: FakeAgent; name: string }> = []
  const context = {
    agents: { get: (id: string) => agents.get(id) },
    agentPresets: { serviceFor: (agent: FakeAgent, name: string) => { lookups.push({ owner: agent, name }); return terminals } },
  }
  return { owner, other, agents, terminals, lookups, context, control: createNativeRunTerminalControl(context) }
}
const rejectsCode = (code: string) => (error: unknown) => {
  assert(error instanceof RunTerminalError)
  assert.equal(error.code, code)
  return true
}

class FakeRelay implements RunTerminalRelayPort {
  run = { runId: 'run-1', sessionId: 'session-1', status: 'needs_attention', attentionReason: 'permission_restore_failed' } as RunSnapshot
  reads: Array<{ id: string; principal: string | undefined }> = []
  reconciles: string[] = []
  reconcileError = false
  restored = true
  onReconcile?: () => void
  async getRun(id: string, principal?: string) { this.reads.push({ id, principal }); return { ...this.run } }
  async reconcilePermissions(sessionId: string) {
    this.reconciles.push(sessionId)
    if (this.reconcileError) throw new Error('synthetic native permission restore failed')
    this.onReconcile?.()
    return { sessionId, restored: this.restored }
  }
}
async function callTool(relay: RunTerminalRelayPort, control?: RunTerminalControl) {
  const server = new McpServer({ name: 'terminals-fixture', version: '1' })
  registerRunTerminalTools(server, relay, control, 'alice')
  const client = new Client({ name: 'terminals-fixture-client', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    return await client.callTool({ name: 'close_run_terminals', arguments: { runId: 'run-1' } })
  } finally { await Promise.allSettled([client.close(), server.close()]) }
}
const structured = (value: Awaited<ReturnType<typeof callTool>>) => value.structuredContent as Record<string, unknown>

test('an empty idle owner is quiescent without touching another owner or any browser controller', async () => {
  const f = fixture()
  const result = await f.control.close('session-1') as Record<string, unknown>
  assert.deepEqual(result.closedIds, [])
  assert.equal(result.stillOwnerActivity, false)
  assert.equal(result.quiescent, true)
  assert.equal(f.owner.maintenanceCount, 1)
  assert.deepEqual(f.terminals.kills, [])
  assert(f.terminals.lists.every(owner => owner === f.owner))
  assert.deepEqual(f.lookups, [{ owner: f.owner, name: 'terminals' }])
  assert.deepEqual(f.terminals.sessions.get(f.other), ['other-owner-terminal'])
})

test('explicit cleanup returns the original run after recovery without another caller query', async () => {
  const f = fixture()
  const relay = new FakeRelay()
  relay.onReconcile = () => {
    relay.run = { ...relay.run, status: 'failed', error: 'MODEL_FAILURE: original error', assistantText: 'retained answer', permissionRestoration: 'complete' }
    delete relay.run.attentionReason
  }
  const result = structured(await callTool(relay, f.control))
  const run = result.run as RunSnapshot
  assert.equal(run.status, 'failed')
  assert.equal(run.error, 'MODEL_FAILURE: original error')
  assert.equal(run.assistantText, 'retained answer')
  assert.equal(run.permissionRestoration, 'complete')
  assert.equal(relay.reads.length, 2)
})

test('a failed final run read preserves the successful cleanup receipt without returning a stale run', async () => {
  const f = fixture()
  const relay = new FakeRelay()
  f.terminals.sessions.set(f.owner, ['own-a'])
  relay.onReconcile = () => { relay.getRun = async () => { throw new Error('synthetic history unavailable') } }
  const result = structured(await callTool(relay, f.control))
  assert.deepEqual(result.closedIds, ['own-a'])
  assert.deepEqual(result.permissions, { attempted: true, restored: true })
  assert.equal(result.run, undefined)
  assert.equal(result.runReadError, 'synthetic history unavailable')
})

test('multiple terminals are awaited and closed only for the exact owning Agent', async () => {
  const f = fixture()
  f.terminals.sessions.set(f.owner, ['own-a', 'own-b'])
  const result = await f.control.close('session-1') as Record<string, unknown>
  assert.deepEqual(result.closedIds, ['own-a', 'own-b'])
  assert.equal(result.quiescent, true)
  assert.deepEqual(f.terminals.kills.map(entry => [entry.owner.id, entry.id, entry.reason]), [
    ['session-1', 'own-a', 'MCP permission recovery'], ['session-1', 'own-b', 'MCP permission recovery'],
  ])
  assert.deepEqual(f.terminals.sessions.get(f.other), ['other-owner-terminal'])
})

test('an already-closing native terminal is awaited and reported separately', async () => {
  const f = fixture()
  f.terminals.sessions.set(f.owner, ['own-a'])
  f.terminals.alreadyClosing.add('own-a')
  const result = await f.control.close('session-1') as Record<string, unknown>
  assert.deepEqual(result.closedIds, [])
  assert.deepEqual(result.alreadyClosingIds, ['own-a'])
  assert.equal(result.quiescent, true)
})

test('active Agents and active maintenance cannot be entered or killed', async () => {
  const f = fixture()
  f.terminals.sessions.set(f.owner, ['own-a'])
  f.owner.status = 'running'
  await assert.rejects(f.control.close('session-1'), rejectsCode('RUN_TERMINALS_ACTIVE'))
  assert.equal(f.lookups.length, 0)
  f.owner.status = 'idle'
  f.owner.busyMaintenance = true
  await assert.rejects(f.control.close('session-1'), rejectsCode('RUN_TERMINALS_IDLE_CLAIM_FAILED'))
  assert.equal(f.terminals.kills.length, 0)
})

test('unpublished spawn activity is retained and blocks permission reconciliation', async () => {
  const f = fixture()
  const relay = new FakeRelay()
  f.terminals.pending.add(f.owner)
  const response = await callTool(relay, f.control)
  const result = structured(response)
  assert.equal(result.stillOwnerActivity, true)
  assert.equal(result.quiescent, false)
  assert.deepEqual(result.closedIds, [])
  assert.deepEqual(result.permissions, { attempted: false, restored: false })
  assert.deepEqual(relay.reconciles, [])
  assert.equal(f.terminals.pending.has(f.owner), true)
})

test('new published arrivals after the snapshot are preserved', async () => {
  const f = fixture()
  f.terminals.sessions.set(f.owner, ['own-a'])
  f.terminals.onKill = owner => { f.terminals.sessions.get(owner)!.push('new-arrival') }
  const result = await f.control.close('session-1') as Record<string, unknown>
  assert.deepEqual(result.snapshotIds, ['own-a'])
  assert.deepEqual(result.closedIds, ['own-a'])
  assert.deepEqual(result.remainingIds, ['new-arrival'])
  assert.equal(result.stillOwnerActivity, true)
  assert.equal(result.quiescent, false)
  assert.equal(f.terminals.kills.length, 1)
})

test('kill failures return partial results and preserve remaining owner activity', async () => {
  const f = fixture()
  const relay = new FakeRelay()
  f.terminals.sessions.set(f.owner, ['own-a', 'own-b'])
  f.terminals.failIds.add('own-a')
  const response = await callTool(relay, f.control)
  const result = structured(response)
  assert.deepEqual(result.closedIds, ['own-b'])
  assert.deepEqual(result.remainingIds, ['own-a'])
  assert.deepEqual(result.failures, [{ sessionId: 'own-a', code: 'CLEANUP_FAILED', message: 'synthetic cleanup failed: own-a' }])
  assert.equal(result.quiescent, false)
  assert.deepEqual(relay.reconciles, [])
})

test('owner replacement or new active work stops further closes', async () => {
  const f = fixture()
  f.terminals.sessions.set(f.owner, ['own-a', 'own-b'])
  f.terminals.onKill = owner => { owner.status = 'running' }
  const result = await f.control.close('session-1') as Record<string, unknown>
  assert.deepEqual(result.closedIds, ['own-a'])
  assert.deepEqual(result.remainingIds, ['own-b'])
  assert.equal(result.ownerIdle, false)
  assert.equal(result.quiescent, false)
  assert.equal(f.terminals.kills.length, 1)
})

test('waking work released behind maintenance prevents restoration readiness', async () => {
  const f = fixture()
  const relay = new FakeRelay()
  f.owner.onRelease = () => { f.owner.status = 'running' }
  const response = await callTool(relay, f.control)
  const result = structured(response)
  assert.equal(result.ownerIdle, false)
  assert.equal(result.quiescent, false)
  assert.deepEqual(relay.reconciles, [])
})

test('tool checks run identity/status/principal before any terminal cleanup', async () => {
  for (const status of ['running', 'unknown', 'needs_attention'] as const) {
    const f = fixture()
    const relay = new FakeRelay()
    relay.run.status = status
    if (status === 'needs_attention') relay.run.attentionReason = 'await_user_answer'
    f.terminals.sessions.set(f.owner, ['own-a'])
    const result = await callTool(relay, f.control)
    assert.equal(result.isError, true)
    assert.equal(structured(result).code, 'RUN_TERMINALS_RUN_ACTIVE')
    assert.deepEqual(relay.reads, [{ id: 'run-1', principal: 'alice' }])
    assert.equal(f.lookups.length, 0)
    assert.equal(f.terminals.kills.length, 0)
    assert.deepEqual(relay.reconciles, [])
  }
})

test('terminal runs and idle permission-restoration failures can explicitly restore the lease', async () => {
  for (const status of ['succeeded', 'failed', 'incomplete', 'cancelled', 'needs_attention'] as const) {
    const f = fixture()
    const relay = new FakeRelay()
    relay.run.status = status
    f.terminals.sessions.set(f.owner, ['own-a'])
    const response = await callTool(relay, f.control)
    assert.notEqual(response.isError, true)
    assert.deepEqual(structured(response).permissions, { attempted: true, restored: true })
    assert.deepEqual(relay.reconciles, ['session-1'])
    assert.deepEqual(f.terminals.sessions.get(f.other), ['other-owner-terminal'])
  }
})

test('reconciliation failure preserves successful cleanup evidence and reports restoration false', async () => {
  for (const throwError of [true, false]) {
    const f = fixture()
    const relay = new FakeRelay()
    f.terminals.sessions.set(f.owner, ['own-a'])
    relay.reconcileError = throwError
    relay.restored = false
    const response = await callTool(relay, f.control)
    const result = structured(response)
    assert.deepEqual(result.closedIds, ['own-a'])
    const permissions = result.permissions as Record<string, unknown>
    assert.equal(permissions.attempted, true)
    assert.equal(permissions.restored, false)
    if (throwError) assert.match(String(permissions.error), /permission restore failed/)
  }
})

test('missing control or native public services fail explicitly without reconciliation', async () => {
  const relay = new FakeRelay()
  const response = await callTool(relay)
  assert.equal(response.isError, true)
  assert.equal(structured(response).code, 'RUN_TERMINALS_UNAVAILABLE')
  assert.deepEqual(relay.reconciles, [])
  await assert.rejects(createNativeRunTerminalControl({}).close('session-1'), rejectsCode('RUN_TERMINALS_UNAVAILABLE'))
  const f = fixture()
  f.agents.delete('session-1')
  await assert.rejects(f.control.close('session-1'), rejectsCode('RUN_TERMINALS_UNAVAILABLE'))
})
