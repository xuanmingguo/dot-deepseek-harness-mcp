import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { resolveConfig, type RelayConfig } from '../src/config.js'
import { createProductToolCatalog, createServer } from '../src/mcp-server/mcp-server-factory.js'
import type { RelayFacade } from '../src/relay-broker/index.js'
import { validateStartRunInput, type StartRunInput } from '../src/relay-broker/run-input.js'
import type { PermissionPreset, RunSnapshot } from '../src/types.js'

const runId = '5f502f03-3a5e-4e3d-9b18-373306961a79'

for (const trustedOperator of [undefined, 'false', 'true']) {
  test(`MCP defaults and explicit permission/confirmation overrides with trusted operator ${trustedOperator ?? 'unset'}`, async () => {
    const config = resolveConfig(trustedOperator === undefined ? {} : { DSH_RELAY_TRUSTED_OPERATOR: trustedOperator })
    const f = await fixture(config)
    try {
      const tools = (await f.client.listTools()).tools
      const schema = tools.find(tool => tool.name === 'start_run')!.inputSchema.properties!
      const expectedDefault = trustedOperator === 'true' ? 'danger-full-access' : 'read-only'
      assert.equal((schema.permissionPreset as { default: string }).default, expectedDefault)
      assert.equal((schema.confirmedDangerousPermission as { default: boolean }).default, trustedOperator === 'true')
      const capabilities = (await f.client.callTool({ name: 'get_operational_capabilities', arguments: {} })).structuredContent as {
        permissionDefaults: { startRun: { permissionPreset: string; confirmedDangerousPermission: boolean }; trustedOperator: boolean }
      }
      assert.equal(capabilities.permissionDefaults.trustedOperator, trustedOperator === 'true')
      assert.deepEqual(capabilities.permissionDefaults.startRun, {
        permissionPreset: expectedDefault, confirmedDangerousPermission: trustedOperator === 'true',
      })
      for (const preset of [undefined, 'read-only', 'workspace-write', 'danger-full-access'] as const) {
        for (const confirmed of [undefined, false, true]) {
          const effectivePreset = preset ?? expectedDefault
          const effectiveConfirmed = confirmed ?? (trustedOperator === 'true')
          const result = await f.client.callTool({ name: 'start_run', arguments: {
            workspace: '/test/workspace', task: 'Synthetic permission contract check',
            ...(preset === undefined ? {} : { permissionPreset: preset }),
            ...(confirmed === undefined ? {} : { confirmedDangerousPermission: confirmed }),
          } })
          const shouldReject = effectivePreset === 'danger-full-access' && !effectiveConfirmed
          assert.equal(result.isError === true, shouldReject, `${preset}/${confirmed}`)
          if (shouldReject) {
            assert.equal((result.structuredContent as { code: string }).code, 'DANGEROUS_PERMISSION_CONFIRMATION_REQUIRED')
          } else {
            assert.equal((result.structuredContent as { permissionPreset: string }).permissionPreset, effectivePreset)
          }
        }
      }
      const review = await f.client.callTool({ name: 'start_review', arguments: {
        workspace: '/test/workspace', task: 'Synthetic review', provider: 'test', model: 'test',
        authorizationBasis: 'explicit-user-request',
      } })
      assert.equal((review.structuredContent as { permissionPreset: string }).permissionPreset, 'read-only')
      assert.equal((await f.client.callTool({ name: 'validate_task_scope', arguments: {
        workspace: '/test/workspace', reviewTargets: ['src'], contextReadScope: ['src'],
      } })).isError, undefined)
      assert.equal(f.validated[0]?.permissionPreset, 'read-only')
    } finally { await f.close() }
  })
}

test('reply_run keeps parent inheritance distinct from configured defaults and requires its own full-access confirmation', async () => {
  for (const trustedOperator of ['false', 'true']) {
    const f = await fixture(resolveConfig({ DSH_RELAY_TRUSTED_OPERATOR: trustedOperator }))
    try {
      for (const parentPreset of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
        f.parentPreset = parentPreset
        for (const preset of [undefined, 'read-only', 'workspace-write', 'danger-full-access'] as const) {
          for (const confirmed of [undefined, false, true]) {
            const effective = preset ?? parentPreset
            const result = await f.client.callTool({ name: 'reply_run', arguments: {
              runId, task: 'Synthetic continuation',
              ...(preset === undefined ? {} : { permissionPreset: preset }),
              ...(confirmed === undefined ? {} : { confirmedDangerousPermission: confirmed }),
            } })
            assert.equal(result.isError === true, effective === 'danger-full-access' && confirmed !== true)
            // The MCP layer must leave omission intact for Relay's recorded-parent inheritance.
            assert.equal(f.replies.at(-1)?.permissionPreset, preset)
            if (result.isError !== true) assert.equal((result.structuredContent as { permissionPreset: string }).permissionPreset, effective)
          }
        }
      }
    } finally { await f.close() }
  }
})

test('checked-in catalog exactly matches generated unconfigured schemas, independent of process environment', async () => {
  const previous = process.env.DSH_RELAY_TRUSTED_OPERATOR
  process.env.DSH_RELAY_TRUSTED_OPERATOR = 'true'
  try {
    const catalog = await createProductToolCatalog()
    const stored = JSON.parse(await readFile(new URL('../docs/tool-catalog.json', import.meta.url), 'utf8'))
    // JSON wire catalogs omit optional SDK properties whose value is undefined.
    assert.deepEqual(stored, JSON.parse(JSON.stringify(catalog)))
    assert.equal((catalog.find(tool => tool.name === 'start_run')!.inputSchema.properties!.permissionPreset as { default: string }).default, 'read-only')
  } finally {
    if (previous === undefined) delete process.env.DSH_RELAY_TRUSTED_OPERATOR
    else process.env.DSH_RELAY_TRUSTED_OPERATOR = previous
  }
})

async function fixture(config: RelayConfig) {
  const validated: StartRunInput[] = []
  const replies: Partial<StartRunInput>[] = []
  const state = { parentPreset: 'read-only' as PermissionPreset }
  async function startRun(input: StartRunInput): Promise<RunSnapshot> {
    validateStartRunInput(input)
    return { runId, status: 'succeeded', permissionPreset: input.permissionPreset ?? 'read-only' } as RunSnapshot
  }
  const server = createServer({
    startRun,
    async replyRun(_runId: string, input: StartRunInput) {
      replies.push(input)
      return startRun({ ...input, workspace: '/test/workspace', permissionPreset: input.permissionPreset ?? state.parentPreset })
    },
    async validateTaskScope(input: StartRunInput) { validated.push(input); return { valid: true } },
  } as unknown as RelayFacade, config)
  const client = new Client({ name: 'permission-defaults-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client, validated, replies,
    set parentPreset(value: PermissionPreset) { state.parentPreset = value },
    close: async () => { await client.close(); await server.close() },
  }
}
