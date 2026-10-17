import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { permissionDefaults, type RelayConfig } from './config.js'
import { prepareDeployment } from './deployment-plan.js'
import { RelayError, type RelayFacade } from './relay-broker/index.js'
import type { NativeControlFacade } from './native-control/index.js'
import { withHostPollContract } from './mcp-server/index.js'

export const externalPathGrantSchema = z.object({
  path: z.string().trim().min(1).max(4096).describe('Exact absolute external file or directory path. Requires an operator policy grant.'),
  access: z.enum(['read', 'write']), kind: z.enum(['file', 'directory']),
}).strict()
const paths = z.array(z.string().trim().min(1).max(4096)).max(1024)
const scope = {
  reviewTargets: paths.min(1), contextReadScope: paths.min(1), excludedPaths: paths.default([]), writeScope: paths.default([]),
  externalPaths: z.array(externalPathGrantSchema).max(64).optional(),
}
const steps = z.array(z.string().trim().min(1).max(4096)).min(1).max(64)
const deployment = {
  workspace: z.string().min(1).max(4096), objective: z.string().trim().min(1).max(4096),
  files: z.array(z.object({ source: z.string().min(1).max(4096), target: z.string().min(1).max(4096), host: z.string().regex(/^[a-z\d][a-z\d._-]*$/iu).max(253).optional(), sourceSha256: z.string().regex(/^[a-f\d]{64}$/iu).optional() }).strict()).min(1).max(256),
  backupDirectory: z.string().min(1).max(4096), receiptPath: z.string().min(1).max(4096),
  preflightChecks: steps, applySteps: steps, verificationChecks: steps, rollbackSteps: steps,
  contextPaths: paths.max(256).optional(), writePaths: paths.max(256).optional(),
  externalPaths: z.array(externalPathGrantSchema).max(64).optional(),
}
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

/** Plans are read-only. Application commands run exclusively in the existing native agent. */
export function registerOperationalTools(server: McpServer, relay: RelayFacade, config: RelayConfig, principal: string, control?: NativeControlFacade): void {
  const permissions = permissionDefaults(config)
  server.registerTool('get_operational_capabilities', {
    title: 'Inspect deployment and file-scope capabilities',
    description: 'Describe supported operations, effective MCP permission defaults, and the configured external path policy. Explicit call values override defaults; reply_run inherits its parent run. Does not grant permissions, run commands, or change services.',
    inputSchema: {}, annotations: readOnly,
  }, guarded(() => ({
    permissionDefaults: permissions,
    deployment: { planning: true, remoteMappings: 'explicit-existing-host-and-path', auxiliaryPaths: true, dispatch: 'existing-native-run', status: ['get_run', 'wait_run', 'get_operation', 'reconcile_operation'], receipt: 'explicit-workspace-path', checksRunBy: 'native-agent', automaticExecution: false },
    externalPaths: { policy: config.externalPathPolicy ?? [], required: 'operator-policy-and-explicit-task-grants', scopeEnforcement: 'instruction-only', externalWritePermission: 'danger-full-access' },
    files: { projectArtifactRead: true, scopedArtifactRead: control !== undefined, projectDirectoryList: control !== undefined, projectTextRead: control !== undefined, projectTextSearch: control !== undefined, maxSearchFileBytes: 1048576, maxSearchBytes: 16777216, maxSearchEntries: 2000, maxSearchFiles: 500, maxSearchResults: 100, maxSearchResultBytes: 65536, maxTextLines: 200, maxTextBytes: 32768, maxTextResultBytes: 65536, maxReadBytes: 65536, maxFileBytes: 16777216, symlinks: 'rejected-for-artifact-reads' },
    serviceActions: { execution: 'explicit-deployment-steps-in-native-run', relayServiceTools: 'Harness attachment records only', hostRestart: 'not-performed-by-this-tool' },
    approval: 'Native permissions and client approval review remain applicable',
  })))
  server.registerTool('validate_task_scope', {
    title: 'Preflight a task file scope without dispatch',
    description: 'Validate project admission, declared external paths and configured path policy. Does not execute task checks or commands and creates no run.',
    inputSchema: { workspace: z.string().min(1), permissionPreset: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default(permissions.validateTaskScope.permissionPreset).describe('Defaults to read-only even in a trusted-operator deployment. Supply the intended run preset explicitly when preflighting a different permission.'), ...scope }, annotations: readOnly,
  }, guarded(input => relay.validateTaskScope(input)))
  server.registerTool('plan_deployment', {
    title: 'Prepare and validate a bounded deployment plan',
    description: 'Read-only preparation of source-to-target mappings, backup location, explicit preflight/apply/verification/rollback steps and JSON receipt path. Validates scopes and operator policy. Checks are instructions and have NOT run. Never executes or grants approval.',
    inputSchema: deployment, annotations: readOnly,
  }, guarded(async input => {
    const plan = prepareDeployment(input)
    const preflight = await relay.validateTaskScope(plan.input)
    return { ...plan, preflight }
  }))
  server.registerTool('start_deployment', {
    title: 'Dispatch an explicitly authorized deployment to Harness',
    description: 'Execute the complete deployment manifest through the EXISTING Harness native agent, including backups, mapped files, listed service/remote operations, verification, rollback on definite failure and a JSON receipt. Require task-specific user authorization. Preserve unknown operation IDs; never blindly replay. Returns an ordinary durable run; keep wait_run to terminal and independently read the receipt. Preparation is not proof of deployment.',
    inputSchema: {
      ...deployment,
      authorizationBasis: z.literal('explicit-user-request'),
      confirmedDangerousPermission: z.boolean().default(permissions.startDeployment.confirmedDangerousPermission).describe('Deployment always selects danger-full-access. Confirmation defaults to DSH_RELAY_TRUSTED_OPERATOR (false when unset); explicit false still blocks dispatch. Task-specific deployment authorization is separately required.'),
      idempotencyKey: z.string().trim().min(1).max(128),
      sessionId: z.string().min(1).optional(), sessionMode: z.enum(['fresh', 'latest-idle']).optional(),
      provider: z.string().min(1).default(config.defaultProvider ?? 'zai'), model: z.string().min(1).default(config.defaultModel ?? 'glm-5.3-flash'),
      reasoningEffort: z.string().min(1).default(config.defaultReasoningEffort ?? 'max'),
    }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, guarded(async input => {
    const plan = prepareDeployment(input)
    return withHostPollContract(await relay.startRun({
      ...plan.input, authorizationBasis: input.authorizationBasis, confirmedDangerousPermission: input.confirmedDangerousPermission,
      idempotencyKey: input.idempotencyKey, provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), ...(input.sessionMode === undefined ? {} : { sessionMode: input.sessionMode }),
    }, principal))
  }))
  server.registerTool('read_scoped_artifact', {
    title: 'Read an artifact within a recorded run scope',
    description: 'Read a regular project or declared external file within a persisted run context/write scope, excluding excludedPaths. Revalidates current operator policy; no caller-supplied grant expansion. Same 64 KiB/16 MiB limits and descriptor/symlink checks as read_artifact.',
    inputSchema: { runId: z.uuid(), path: z.string().min(1).max(4096), offsetBytes: z.number().int().nonnegative().optional(), maxBytes: z.number().int().min(1).max(65536).optional() }, annotations: readOnly,
  }, guarded(async input => {
    if (control === undefined) throw new RelayError('NATIVE_CONTROL_UNAVAILABLE', 'Scoped artifacts require embedded native controls', false)
    const run = await relay.getRun(input.runId)
    return control.readScopedArtifact({ ...input, workspace: run.workspace, scope: run.taskScope })
  }))
}

function guarded<T, R extends object>(operation: (input: T) => Promise<R> | R) {
  return async (input: T) => {
    try { const structuredContent = { ...await operation(input) } as Record<string, unknown>; return { structuredContent, content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }] } }
    catch (error) {
      const structuredContent = error instanceof RelayError ? error.toStructuredContent()
        : { code: typeof error === 'object' && error !== null && 'code' in error ? error.code : 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : String(error), retryable: false }
      return { structuredContent, content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], isError: true }
    }
  }
}
