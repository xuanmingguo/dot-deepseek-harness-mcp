import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { resolveConfig } from '../src/config.js'
import type { DeploymentSpec } from '../src/deployment-plan.js'
import type { RelayFacade } from '../src/relay-broker/index.js'
import { resolveTaskScope, validateStartRunInput, type StartRunInput } from '../src/relay-broker/run-input.js'
import { createServer } from '../src/server.js'
import type { RunSnapshot } from '../src/types.js'

const runId = '5f502f03-3a5e-4e3d-9b18-373306961a79'

function deployment(): DeploymentSpec {
  return {
    workspace: resolve('/test/workspace'), objective: 'Deploy adapter and service configuration',
    files: [{ source: 'stage/adapter.mjs', target: '/opt/harness/adapter.mjs', sourceSha256: 'ab'.repeat(32) },
      { source: 'stage/harness.service', target: '/etc/systemd/system/harness.service' }],
    backupDirectory: 'backups/deployment-42', receiptPath: 'receipts/deployment-42.json',
    preflightChecks: ['Verify idle service and source hashes'],
    applySteps: ['Install both mapped targets', 'ssh deployment-host systemctl restart harness.service'],
    verificationChecks: ['Check each deployed file and service health'], rollbackSteps: ['Restore both targets and restart the service after definite failure'],
    externalPaths: [{ path: '/opt/harness/adapter.mjs', access: 'write', kind: 'file' },
      { path: '/etc/systemd/system/harness.service', access: 'write', kind: 'file' }],
  }
}

async function fixture() {
  ;(globalThis as Record<string, unknown>).__DSH_RELAY_VERSION__ = 'test'
  const started: { input: StartRunInput; principal: string }[] = []
  const validated: StartRunInput[] = []
  const config = { ...resolveConfig({}), clientPrincipalId: 'operational-tools-owner' }
  const relay = {
    async validateTaskScope(input: StartRunInput) {
      validated.push(input)
      return { valid: true, checksExecuted: false, taskScope: resolveTaskScope(input) }
    },
    async startRun(input: StartRunInput, principal: string): Promise<RunSnapshot> {
      validateStartRunInput(input)
      started.push({ input, principal })
      return snapshot(input)
    },
  } as unknown as RelayFacade
  const server = createServer(relay, config)
  const client = new Client({ name: 'operational-tools-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, started, validated, close: async () => { await client.close(); await server.close() } }
}

test('five operational tools are discoverable with planning and deployment annotations', async () => {
  const f = await fixture()
  try {
    const { tools } = await f.client.listTools()
    for (const name of ['get_operational_capabilities', 'validate_task_scope', 'plan_deployment', 'read_scoped_artifact']) {
      const tool = tools.find(item => item.name === name)
      assert.ok(tool, name)
      assert.equal(tool.annotations?.readOnlyHint, true)
      assert.equal(tool.annotations?.destructiveHint, false)
      assert.equal(tool.annotations?.openWorldHint, false)
    }
    const start = tools.find(item => item.name === 'start_deployment')
    assert.ok(start)
    assert.equal(start.annotations?.readOnlyHint, false)
    assert.equal(start.annotations?.destructiveHint, true)
    assert.equal(start.annotations?.openWorldHint, true)
    const result = await f.client.callTool({ name: 'get_operational_capabilities', arguments: {} })
    const content = result.structuredContent as { deployment: { automaticExecution: boolean; dispatch: string }; externalPaths: { externalWritePermission: string } }
    assert.equal(content.deployment.automaticExecution, false)
    assert.equal(content.deployment.dispatch, 'existing-native-run')
    assert.equal(content.externalPaths.externalWritePermission, 'danger-full-access')
    assert.equal(f.started.length, 0)
  } finally { await f.close() }
})

test('plan_deployment validates all paths but executes no checks or native run', async () => {
  const f = await fixture()
  try {
    const result = await f.client.callTool({ name: 'plan_deployment', arguments: { ...deployment() } })
    assert.notEqual(result.isError, true)
    const plan = result.structuredContent as { checksExecuted: boolean; executionStatus: string; manifest: DeploymentSpec; input: StartRunInput; preflight: { valid: boolean } }
    assert.equal(plan.checksExecuted, false)
    assert.equal(plan.executionStatus, 'not_started')
    assert.equal(plan.preflight.valid, true)
    assert.equal(plan.manifest.files.length, 2)
    assert.equal(plan.input.confirmedDangerousPermission, undefined)
    assert.equal(plan.input.authorizationBasis, undefined)
    assert.deepEqual(f.validated[0]?.externalPaths, deployment().externalPaths)
    assert.equal(f.validated.length, 1)
    assert.equal(f.started.length, 0)
  } finally { await f.close() }
})

test('start_deployment dispatches complete manifest and authorization through ordinary startRun', async () => {
  const f = await fixture()
  try {
    const result = await f.client.callTool({ name: 'start_deployment', arguments: {
      ...deployment(), authorizationBasis: 'explicit-user-request', confirmedDangerousPermission: true,
      idempotencyKey: 'deployment-operation-42', provider: 'test-provider', model: 'test-model', reasoningEffort: 'high', sessionMode: 'fresh',
    } })
    assert.notEqual(result.isError, true)
    assert.equal(f.started.length, 1)
    const call = f.started[0]!
    assert.equal(call.principal, 'operational-tools-owner')
    assert.equal(call.input.permissionPreset, 'danger-full-access')
    assert.equal(call.input.authorizationBasis, 'explicit-user-request')
    assert.equal(call.input.confirmedDangerousPermission, true)
    assert.equal(call.input.idempotencyKey, 'deployment-operation-42')
    assert.equal(call.input.provider, 'test-provider')
    assert.equal(call.input.model, 'test-model')
    assert.equal(call.input.reasoningEffort, 'high')
    assert.equal(call.input.sessionMode, 'fresh')
    assert.deepEqual(call.input.externalPaths, deployment().externalPaths)
    assert.deepEqual(call.input.reviewTargets, deployment().files.map(file => file.source))
    for (const file of deployment().files) {
      assert.ok(call.input.contextReadScope?.includes(file.source))
      assert.ok(call.input.contextReadScope?.includes(file.target))
      assert.ok(call.input.writeScope?.includes(file.target))
      assert.ok(call.input.task?.includes(JSON.stringify(file.source)))
      assert.ok(call.input.task?.includes(JSON.stringify(file.target)))
    }
    assert.ok(call.input.writeScope?.includes(deployment().backupDirectory))
    assert.ok(call.input.writeScope?.includes(deployment().receiptPath))
    assert.match(call.input.task!, /ssh deployment-host systemctl restart harness\.service/u)
    const content = result.structuredContent as { runId: string; hostPollContract: { hostMustCallWaitRunAgain: boolean; nextTool: string; runComplete: boolean } }
    assert.equal(content.runId, runId)
    assert.equal(content.hostPollContract.runComplete, false)
    assert.equal(content.hostPollContract.hostMustCallWaitRunAgain, true)
    assert.equal(content.hostPollContract.nextTool, 'wait_run')
  } finally { await f.close() }
})

test('missing rollback, task authorization, or idempotency cannot dispatch deployment', async () => {
  const f = await fixture()
  try {
    const valid = { ...deployment(), authorizationBasis: 'explicit-user-request', confirmedDangerousPermission: true, idempotencyKey: 'deployment-42' }
    for (const field of ['rollbackSteps', 'authorizationBasis', 'idempotencyKey'] as const) {
      const input: Record<string, unknown> = { ...valid }
      delete input[field]
      assert.equal((await f.client.callTool({ name: 'start_deployment', arguments: input })).isError, true, field)
    }
    assert.equal((await f.client.callTool({ name: 'start_deployment', arguments: { ...valid, rollbackSteps: [] } })).isError, true)
    assert.equal(f.started.length, 0)
  } finally { await f.close() }
})

test('validate_task_scope forwards explicit external grants without native dispatch', async () => {
  const f = await fixture()
  try {
    const externalPaths = [{ path: '/opt/harness/adapter.mjs', access: 'read', kind: 'file' }]
    const result = await f.client.callTool({ name: 'validate_task_scope', arguments: {
      workspace: deployment().workspace, reviewTargets: ['/opt/harness/adapter.mjs'],
      contextReadScope: ['/opt/harness/adapter.mjs'], externalPaths,
    } })
    assert.notEqual(result.isError, true)
    assert.deepEqual(f.validated[0]?.externalPaths, externalPaths)
    assert.equal(f.validated[0]?.permissionPreset, 'read-only')
    assert.equal(f.started.length, 0)
  } finally { await f.close() }
})

function snapshot(input: StartRunInput): RunSnapshot {
  return {
    runId, serviceId: 'service-1', sessionId: 'session-1', sessionReused: false, parentRunId: null,
    workspace: input.workspace, webUrl: 'http://127.0.0.1:3080/', status: 'running', modelSelection: null,
    permissionPreset: 'danger-full-access', agentPreset: null, modelDefaultRestore: 'not-needed', warnings: [],
    task: input.task ?? '', taskPersisted: false, taskImageCount: 0, cancelRequested: false,
    startedAt: '2026-10-15T00:00:00.000Z', finishedAt: null, promptAdmission: 'accepted', promptMessageId: 'message-1',
    assistantText: '', assistantTextBytes: 0, assistantTextTruncated: false, lastEventSeq: 1, error: null,
  }
}
