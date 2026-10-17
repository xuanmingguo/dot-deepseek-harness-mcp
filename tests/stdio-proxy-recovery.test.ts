import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { resolveConfig, type RelayConfig } from '../src/config.js'
import { McpHttpFacade } from '../src/mcp-http/index.js'
import { createServer } from '../src/mcp-server/index.js'
import { MonitoringFacade } from '../src/monitoring/index.js'
import { RelayFacade } from '../src/relay-broker/index.js'
import { StdioProxyFacade } from '../src/stdio-proxy/index.js'
import type { RpcEvent } from '../src/types.js'

test('same proxy degrades locally and reconnects after the Host restarts', async t => {
  ;(globalThis as Record<string, unknown>).__DSH_RELAY_VERSION__ = 'test'
  const root = await temporaryDirectory(t)
  const token = 'R'.repeat(43)
  const tokenFile = join(root, 'relay.token')
  const descriptorFile = join(root, 'relay-endpoint.json')
  const stateFile = join(root, 'state.json')
  await writeFile(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })

  let brokerCreations = 0
  let mcpAdapterCreations = 0
  let promptCount = 0
  let sessionCreated = false
  const events: RpcEvent[] = []
  const native: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.list': value = { items: [{ workspaceId: 'fixture-workspace', path: root, sessionIds: sessionCreated ? ['fixture-session'] : [] }], archivedSessionIds: [] }; break
      case 'session.create': sessionCreated = true; value = { sessionId: 'fixture-session', agentPreset: 'standard' }; break
      case 'session.list': value = { items: [{ sessionId: 'fixture-session', running: false }] }; break
      case 'settings.describe': value = { writable: false, namespaces: [] }; break
      case 'session.selectModel': value = { selected: { provider: request.payload.provider, model: request.payload.model, reasoningEffort: request.payload.reasoningEffort } }; break
      case 'session.history': value = { events: events.map(event => ({ event })), hasMore: false, projections: { values: { permissions: { currentValue: 'read-only' } } } }; break
      case 'session.prompt':
        promptCount += 1
        events.push(
          { type: 'user/message', seq: 1, time: 1, data: { id: 'fixture-message', source: { rpcId: request.rpcId } } },
          { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'completed' } } },
        )
        value = { accepted: true, messageId: 'fixture-message' }
        break
      default: throw new Error(`Unexpected fixture native method: ${request.method}`)
    }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }))
  }
  const config = resolveConfig({
    DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/',
    DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: root,
    DSH_RELAY_STATE_FILE: stateFile,
  })
  const firstHost = await startHost(config, token, 0, () => { brokerCreations += 1 }, () => { mcpAdapterCreations += 1 }, native)
  t.after(async () => { await firstHost.facade.drain(); await close(firstHost.http) })
  const port = portOf(firstHost.http)
  await writeDescriptor(descriptorFile, tokenFile, port, 1)

  const firstConnection = await connectProxy(descriptorFile)
  t.after(async () => { await Promise.allSettled([firstConnection.client.close(), firstConnection.proxy.close()]) })
  const firstTools = await firstConnection.client.listTools()
  assert.ok(firstTools.tools.some(tool => tool.name === 'doctor'))
  await firstConnection.client.listTools()
  await firstConnection.client.listTools()
  assert.equal(brokerCreations, 1)
  assert.ok(mcpAdapterCreations >= 4)
  const originalInput = { workspace: root, task: 'synthetic fixture', idempotencyKey: 'original-connection-test' }
  const submitted = await firstConnection.client.callTool({ name: 'start_run', arguments: originalInput })
  assert.notEqual(submitted.isError, true, JSON.stringify(submitted.content))
  const original = submitted.structuredContent as { runId: string; operationId: string; status: string }
  assert.equal(original.status, 'succeeded')
  assert.equal(promptCount, 1)

  await firstHost.facade.drain()
  const degradedTools = (await firstConnection.client.listTools()).tools.map(tool => tool.name)
  assert.ok(degradedTools.includes('doctor'))
  assert.ok(degradedTools.includes('start_review'))
  assert.ok(degradedTools.includes('wait_run'))
  const degradedDoctor = await firstConnection.client.callTool({ name: 'doctor', arguments: {} })
  assert.equal((degradedDoctor.structuredContent as { errorCode?: unknown }).errorCode, 'REMOTE_DRAINING')
  const unavailable = await firstConnection.client.callTool({ name: 'start_run', arguments: {} })
  assert.equal(unavailable.isError, true)
  assert.equal((unavailable.structuredContent as { code?: unknown }).code, 'RELAY_ROUTE_UNAVAILABLE')
  await close(firstHost.http)

  const secondHost = await startHost(config, token, port, () => { brokerCreations += 1 }, () => { mcpAdapterCreations += 1 }, native)
  t.after(async () => { await secondHost.facade.drain(); await close(secondHost.http) })
  await writeDescriptor(descriptorFile, tokenFile, port, 2)

  let recoveredDoctor = await firstConnection.client.callTool({ name: 'doctor', arguments: {} })
  for (let attempt = 0; attempt < 20 && (recoveredDoctor.structuredContent as { ok?: unknown }).ok !== true; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    recoveredDoctor = await firstConnection.client.callTool({ name: 'doctor', arguments: {} })
  }
  const recoveredTools = await firstConnection.client.listTools()
  assert.ok(recoveredTools.tools.some(tool => tool.name === 'doctor'))
  assert.ok(recoveredTools.tools.some(tool => tool.name === 'start_run'))
  assert.equal((recoveredDoctor.structuredContent as { ok?: unknown }).ok, true)
  assert.equal(brokerCreations, 2)
  assert.ok(mcpAdapterCreations >= 7)
  const recoveredRun = await firstConnection.client.callTool({ name: 'get_run', arguments: { runId: original.runId } })
  assert.equal((recoveredRun.structuredContent as Record<string, unknown>).runId, original.runId)
  assert.equal((recoveredRun.structuredContent as Record<string, unknown>).status, 'succeeded')
  const recoveredOperation = await firstConnection.client.callTool({ name: 'get_operation', arguments: { operationId: original.operationId } })
  assert.equal((recoveredOperation.structuredContent as { operation: { operationId: string } }).operation.operationId, original.operationId)
  const replay = await firstConnection.client.callTool({ name: 'start_run', arguments: originalInput })
  assert.equal((replay.structuredContent as Record<string, unknown>).runId, original.runId)
  assert.equal(promptCount, 1, 'connection recovery must query the original run without creating another turn')
})

async function startHost(
  config: RelayConfig,
  token: string,
  port: number,
  onBroker: () => void,
  onAdapter: () => void,
  native: typeof fetch = async () => { throw new Error('Harness API is not needed for handshake tests') },
): Promise<{ http: HttpServer; facade: McpHttpFacade }> {
  onBroker()
  const relay = new RelayFacade(config, native)
  const monitoring = new MonitoringFacade()
  let facade: McpHttpFacade
  const http = createHttpServer((req, res) => { void facade.handle(req, res) })
  await listen(http, port)
  const address = http.address()
  assert(address !== null && typeof address === 'object')
  facade = new McpHttpFacade({
    token,
    allowedHosts: [`127.0.0.1:${address.port}`],
    allowedOrigins: [],
    maxBodyBytes: 64 * 1024,
    maxConcurrent: 8,
    requestsPerMinute: 1_000,
    drainTimeoutMs: 100,
  }, principal => {
    onAdapter()
    return createServer(relay, config, monitoring, principal)
  })
  return { http, facade }
}

async function connectProxy(descriptorFile: string): Promise<{ proxy: StdioProxyFacade; client: Client }> {
  const proxy = new StdioProxyFacade({ descriptorFile, clientPrincipalId: 'codex:user', requestTimeoutMs: 1_000 })
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
  await proxy.connect(proxyTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  return { proxy, client }
}

async function writeDescriptor(descriptorFile: string, tokenFile: string, port: number, ownerEpoch: number): Promise<void> {
  const authorityId = `authority-${ownerEpoch}`
  await writeFile(descriptorFile, JSON.stringify({
    schemaVersion: 1,
    authorityId,
    mode: 'embedded',
    mcpUrl: `http://127.0.0.1:${port}/plugins/dsh-relay/mcp`,
    tokenFilePath: tokenFile,
    hostWebUrl: `http://127.0.0.1:${port}/`,
    ownerEpoch,
    updatedAt: new Date().toISOString(),
  }), { encoding: 'utf8' })
  await writeFile(join(dirname(descriptorFile), 'relay-status.json'), JSON.stringify({
    schemaVersion: 1,
    state: 'ready',
    authorityId,
    mode: 'embedded',
    instanceId: authorityId,
    ownerPid: process.pid,
    processStartedAt: '2026-08-20T00:00:00.000Z',
    ownerEpoch,
    hostIdentity: `http://127.0.0.1:${port}/`,
    profile: 'web',
    dshHome: dirname(descriptorFile),
    updatedAt: new Date().toISOString(),
    lastError: null,
  }), { encoding: 'utf8' })
}

function portOf(server: HttpServer): number {
  const address = server.address()
  assert(address !== null && typeof address === 'object')
  return address.port
}

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolveListen() })
  })
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolveClose, reject) => {
    if (!server.listening) return resolveClose()
    server.close(error => { if (error === undefined) resolveClose(); else reject(error) })
  })
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `dsh-relay-proxy-recovery-${randomUUID()}-`))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  return directory
}
