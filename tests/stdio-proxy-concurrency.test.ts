import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioProxyFacade } from '../src/stdio-proxy/index.js'

for (const status of [409, 503]) {
  test(`request-local HTTP ${status} preserves a healthy sibling and reconnects without replay`, { timeout: 10_000 }, async t => {
    const fixture = await remoteFixture(t)
    const { client } = await fixture.connect()
    const held = fixture.hold('held')
    const failing = fixture.hold('failing')
    const healthyResult = client.callTool({ name: 'held', arguments: {} })
    await held.received
    const failedResult = client.callTool({ name: 'failing', arguments: {} })
    await failing.received

    failing.fail(status)
    assertRouteFailure(await failedResult)
    assert.equal(fixture.calls.get('failing'), 1, 'a failed call must not be replayed')
    assert.equal(fixture.initializations, 1)

    const later = await client.callTool({ name: 'quick', arguments: {} })
    assert.deepEqual(later.structuredContent, { tool: 'quick' })
    assert.equal(fixture.initializations, 2, 'the next request reconnects exactly once')
    held.succeed()
    const result = await healthyResult
    assert.equal(result.isError, undefined, 'the sibling must survive another request invalidating its client')
    assert.deepEqual(result.structuredContent, { tool: 'held' })
    assert.equal(fixture.calls.get('held'), 1)
    assert.equal(fixture.calls.get('failing'), 1)
    assert.equal(fixture.initializations, 2, 'settling an old successful request must preserve the fresh client')
  })
}

test('overlapping old failures cannot invalidate a fresh client with an active request', { timeout: 10_000 }, async t => {
  const fixture = await remoteFixture(t)
  const { client } = await fixture.connect()
  const first = fixture.hold('first-failure')
  const stale = fixture.hold('stale-failure')
  const fresh = fixture.hold('fresh-held')
  const firstResult = client.callTool({ name: 'first-failure', arguments: {} })
  const staleResult = client.callTool({ name: 'stale-failure', arguments: {} })
  await Promise.all([first.received, stale.received])

  first.fail(409)
  assertRouteFailure(await firstResult)
  const freshResult = client.callTool({ name: 'fresh-held', arguments: {} })
  await fresh.received
  assert.equal(fixture.initializations, 2)

  stale.fail(503)
  const staleFailure = await staleResult
  assertRouteFailure(staleFailure)
  assert.equal((staleFailure.structuredContent as { reasonCode?: string }).reasonCode, 'REMOTE_DRAINING',
    'the old request must receive its own HTTP failure rather than a sibling-induced abort')
  fresh.succeed()
  assert.deepEqual((await freshResult).structuredContent, { tool: 'fresh-held' })
  assert.deepEqual((await client.callTool({ name: 'quick', arguments: {} })).structuredContent, { tool: 'quick' })
  assert.equal(fixture.initializations, 2, 'a stale failure must not cause a third initialization')
  for (const name of ['first-failure', 'stale-failure', 'fresh-held']) assert.equal(fixture.calls.get(name), 1)
})

test('a failed remote tool listing preserves a concurrent tool and reconnects once', { timeout: 10_000 }, async t => {
  const fixture = await remoteFixture(t)
  const { client } = await fixture.connect()
  const held = fixture.hold('held')
  const listing = fixture.hold('tools/list')
  const healthyResult = client.callTool({ name: 'held', arguments: {} })
  await held.received
  const listed = client.listTools()
  await listing.received

  listing.fail(503)
  const fallback = await listed
  assert.ok(fallback.tools.some(tool => tool.name === 'doctor'))
  assert.ok(fallback.tools.some(tool => tool.name === 'start_run'))
  assert.equal(fixture.toolLists, 2, 'a failed listing must not be replayed')
  assert.deepEqual((await client.callTool({ name: 'quick', arguments: {} })).structuredContent, { tool: 'quick' })
  assert.equal(fixture.initializations, 2)
  held.succeed()
  assert.deepEqual((await healthyResult).structuredContent, { tool: 'held' })
  assert.equal(fixture.toolLists, 3, 'only the replacement handshake may add a tool listing')
  assert.equal(fixture.calls.get('held'), 1)
})

test('close aborts held requests on both retired and current remote clients', { timeout: 10_000 }, async t => {
  const fixture = await remoteFixture(t)
  const { proxy, client } = await fixture.connect()
  const retired = fixture.hold('held')
  const failing = fixture.hold('failing')
  const fresh = fixture.hold('fresh-held')
  const retiredResult = assert.rejects(client.callTool({ name: 'held', arguments: {} }))
  await retired.received
  const failedResult = client.callTool({ name: 'failing', arguments: {} })
  await failing.received
  failing.fail(409)
  assertRouteFailure(await failedResult)
  const freshResult = assert.rejects(client.callTool({ name: 'fresh-held', arguments: {} }))
  await fresh.received
  assert.equal(fixture.initializations, 2)

  await proxy.close()
  await bounded(Promise.all([retired.closed, fresh.closed]), 'close did not abort every remote client')
  await Promise.all([retiredResult, freshResult])
  assert.equal(fixture.calls.get('held'), 1)
  assert.equal(fixture.calls.get('fresh-held'), 1)
  assert.equal(fixture.initializations, 2)
})

test('close cancels an initial remote handshake before its candidate can become live', { timeout: 10_000 }, async t => {
  const fixture = await remoteFixture(t, true)
  const proxy = fixture.makeProxy()
  const [, proxyTransport] = InMemoryTransport.createLinkedPair()
  const connecting = proxy.connect(proxyTransport)
  // Cleanup releases even a broken implementation before closing its late candidate.
  t.after(async () => {
    fixture.releaseInitialize()
    await connecting
    await proxy.close()
  })
  await fixture.initializeReceived
  await proxy.close()
  await bounded(fixture.initializeClosed, 'close did not abort the in-progress remote initialization')
  fixture.releaseInitialize()
  await connecting
  assert.equal(fixture.toolLists, 0, 'a closed proxy must not promote its initializing candidate')
})

function assertRouteFailure(result: Awaited<ReturnType<Client['callTool']>>): void {
  assert.equal(result.isError, true)
  assert.equal((result.structuredContent as { code?: string }).code, 'RELAY_ROUTE_UNAVAILABLE')
}

type RpcRequest = {
  id?: string | number
  method: string
  params?: { protocolVersion?: string; name?: string }
}

type HeldRequest = {
  received: Promise<void>
  closed: Promise<void>
  succeed(): void
  fail(status: number): void
}

async function remoteFixture(t: TestContext, holdInitialize = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-proxy-concurrency-'))
  const descriptorFile = join(root, 'relay-endpoint.json')
  const tokenFile = join(root, 'relay.token')
  const calls = new Map<string, number>()
  const held = new Map<string, PendingRequest>()
  const initializeReceived = gate()
  const initializeClosed = gate()
  const initializeRelease = gate()
  const handlerErrors: unknown[] = []
  let initializations = 0
  let toolLists = 0
  const http = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      assert.equal(req.headers.authorization, `Bearer ${'C'.repeat(43)}`)
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      const request = JSON.parse(body) as RpcRequest
      if (request.method === 'initialize') {
        initializations += 1
        res.once('close', () => initializeClosed.open())
        initializeReceived.open()
        if (holdInitialize) await initializeRelease.promise
        respond(res, request, {
          protocolVersion: request.params?.protocolVersion,
          serverInfo: { name: 'concurrency-fixture', version: '1.0.0' },
          capabilities: { tools: {} },
        })
      } else if (request.method === 'tools/list') {
        toolLists += 1
        const pending = held.get('tools/list')
        if (pending !== undefined) {
          held.delete('tools/list')
          holdResponse(pending, request, res)
          return
        }
        respond(res, request, { tools: ['held', 'failing', 'quick', 'first-failure', 'stale-failure', 'fresh-held'].map(name => ({
          name, inputSchema: { type: 'object', properties: {} },
        })) })
      } else if (request.method === 'tools/call') {
        const name = request.params?.name
        assert.equal(typeof name, 'string')
        calls.set(name!, (calls.get(name!) ?? 0) + 1)
        const pending = held.get(name!)
        if (pending === undefined) respond(res, request, success(name!))
        else holdResponse(pending, request, res)
      } else res.writeHead(202).end()
    })().catch(error => {
      handlerErrors.push(error)
      res.writeHead(500).end('fixture error')
    })
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve() })
  })
  // Close sockets explicitly so a red regression cannot leave held HTTP requests behind.
  t.after(async () => {
    initializeRelease.open()
    http.closeAllConnections()
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
    assert.deepEqual(handlerErrors, [], 'HTTP fixture handlers must finish without errors')
  })
  const address = http.address()
  assert(address !== null && typeof address === 'object')
  const hostWebUrl = `http://127.0.0.1:${address.port}/`
  await writeFile(tokenFile, `${'C'.repeat(43)}\n`, { mode: 0o600 })
  await writeFile(descriptorFile, JSON.stringify({
    schemaVersion: 1, authorityId: 'concurrency-authority', mode: 'embedded',
    mcpUrl: `${hostWebUrl}plugins/dsh-relay/mcp`, tokenFilePath: tokenFile,
    hostWebUrl, ownerEpoch: 1, updatedAt: '2026-08-20T00:00:00.000Z',
  }))
  await writeFile(join(root, 'relay-status.json'), JSON.stringify({
    schemaVersion: 1, state: 'ready', authorityId: 'concurrency-authority', mode: 'embedded',
    instanceId: 'concurrency-authority', ownerPid: process.pid,
    processStartedAt: '2026-08-20T00:00:00.000Z', ownerEpoch: 1,
    hostIdentity: hostWebUrl, profile: 'web', dshHome: root,
    updatedAt: '2026-08-20T00:00:00.000Z', lastError: null,
  }))
  const makeProxy = () => new StdioProxyFacade({
    descriptorFile, clientPrincipalId: 'codex:concurrency', requestTimeoutMs: 3_000,
  })
  return {
    calls,
    get initializations() { return initializations },
    get toolLists() { return toolLists },
    initializeReceived: bounded(initializeReceived.promise, 'initial remote initialize was not received'),
    initializeClosed: initializeClosed.promise,
    releaseInitialize: () => initializeRelease.open(),
    makeProxy,
    async connect() {
      const proxy = makeProxy()
      const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'local-concurrency', version: '1.0.0' })
      t.after(async () => { await Promise.allSettled([client.close(), proxy.close()]) })
      await proxy.connect(proxyTransport)
      await client.connect(clientTransport)
      return { proxy, client }
    },
    hold(name: string): HeldRequest {
      const pending: PendingRequest = { arrived: gate(), closed: gate() }
      assert.equal(held.has(name), false)
      held.set(name, pending)
      return {
        received: bounded(pending.arrived.promise, `remote request ${name} was not received`),
        closed: pending.closed.promise,
        succeed() {
          assert(pending.response !== undefined && pending.request !== undefined)
          respond(pending.response, pending.request, success(name))
        },
        fail(status) {
          assert(pending.response !== undefined)
          pending.response.writeHead(status, { 'content-type': 'text/plain' }).end(`request-local ${status}`)
        },
      }
    },
  }
}

type PendingRequest = { arrived: Gate; closed: Gate; response?: ServerResponse; request?: RpcRequest }

function holdResponse(pending: PendingRequest, request: RpcRequest, response: ServerResponse): void {
  // Each gate controls one HTTP response, including failed tool listings.
  assert.equal(pending.response, undefined, 'a held request must not be replayed')
  pending.response = response
  pending.request = request
  response.once('close', () => pending.closed.open())
  pending.arrived.open()
}

function success(name: string) {
  return { content: [{ type: 'text', text: name }], structuredContent: { tool: name } }
}

function respond(response: ServerResponse, request: RpcRequest, result: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
}

type Gate = { promise: Promise<void>; open(): void }
function gate(): Gate {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), 2_000)
    })])
  } finally { clearTimeout(timeout) }
}