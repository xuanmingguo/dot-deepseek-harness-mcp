import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { RunSnapshot } from './types.js'

export interface RunTerminalControl { close(sessionId: string): Promise<object> }
export interface RunTerminalRelayPort {
  getRun(runId: string, principal?: string): Promise<RunSnapshot>
  reconcilePermissions(sessionId: string): Promise<{ sessionId: string; restored: boolean }>
}
export interface RunTerminalCloseResult {
  sessionId: string
  snapshotIds: string[]
  closedIds: string[]
  alreadyClosingIds: string[]
  failures: Array<{ sessionId: string; code: string; message: string }>
  remainingIds: string[]
  stillOwnerActivity: boolean
  ownerIdle: boolean
  quiescent: boolean
}
export class RunTerminalError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RunTerminalError' }
}
interface NativeAgent {
  readonly id: string
  readonly status: unknown
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}
interface NativeTerminals {
  list(owner: NativeAgent): unknown
  kill(owner: NativeAgent, id: string, reason: string): Promise<unknown>
  hasOwnerActivity(owner: NativeAgent): unknown
}

/**
 * Public owner-scoped PTY service, not browser terminalController.close.
 * No agent is created/resumed and no terminal outside this exact Agent is read
 * or killed. A maintenance claim prevents a new waking turn during cleanup.
 * Agent idle does not prove PTY command idle or that a PTY began in this run;
 * callers must explicitly choose to discard this session's published shells.
 */
export function createNativeRunTerminalControl(context: unknown): RunTerminalControl {
  return {
    async close(sessionId: string): Promise<RunTerminalCloseResult> {
      const ctx = object(context, 'Harness context')
      const agents = object(ctx.agents, 'native agents')
      const presets = object(ctx.agentPresets, 'native agentPresets')
      if (typeof agents.get !== 'function' || typeof presets.serviceFor !== 'function') fail('RUN_TERMINALS_UNAVAILABLE', 'Native agents/agentPresets services are unavailable')
      const get = agents.get
      const getAgent = (): unknown => get.call(agents, sessionId)
      const owner = object(getAgent(), 'live native Agent') as unknown as NativeAgent
      if (owner.id !== sessionId) fail('RUN_TERMINALS_OWNER_MISMATCH', 'Native Agent identity does not match the run session')
      if (owner.status !== 'idle') fail('RUN_TERMINALS_ACTIVE', 'The native Agent is active or its idle status is unknown; no terminals were closed')
      if (typeof owner.runMaintenance !== 'function') fail('RUN_TERMINALS_UNAVAILABLE', 'Native true-idle maintenance is unavailable; no terminals were closed')
      const service = object(presets.serviceFor.call(presets, owner, 'terminals'), 'owner-scoped terminal service') as unknown as NativeTerminals
      if (typeof service.list !== 'function' || typeof service.kill !== 'function' || typeof service.hasOwnerActivity !== 'function') fail('RUN_TERMINALS_UNAVAILABLE', 'Public owner-scoped terminal list/kill/activity methods are unavailable')
      let result: RunTerminalCloseResult
      try {
        result = await owner.runMaintenance(async signal => {
          if (signal.aborted || getAgent() !== owner || owner.status !== 'idle') fail('RUN_TERMINALS_ACTIVE', 'Native ownership or idle state changed before cleanup')
          const snapshotIds = terminalIds(service.list(owner))
          const closedIds: string[] = []
          const alreadyClosingIds: string[] = []
          const failures: RunTerminalCloseResult['failures'] = []
          for (const id of snapshotIds) {
            // Never continue into a newly active/replaced owner or canceled task.
            if (signal.aborted || getAgent() !== owner || owner.status !== 'idle') {
              failures.push({ sessionId: id, code: 'OWNER_ACTIVITY_CHANGED', message: 'Cleanup stopped because native owner activity changed' })
              break
            }
            try {
              const closed = await service.kill(owner, id, 'MCP permission recovery')
              if (typeof closed !== 'boolean') throw new Error('Native terminal kill returned an unsupported receipt')
              if (closed) closedIds.push(id)
              else alreadyClosingIds.push(id)
            } catch (error) {
              failures.push({ sessionId: id, code: errorCode(error), message: error instanceof Error ? error.message : 'Native terminal cleanup failed' })
            }
          }
          const remainingIds = terminalIds(service.list(owner))
          const activity = ownerActivity(service, owner) || remainingIds.length > 0
          const ownerIdle = !signal.aborted && getAgent() === owner && owner.status === 'idle'
          return {
            sessionId, snapshotIds, closedIds, alreadyClosingIds, failures, remainingIds,
            stillOwnerActivity: activity, ownerIdle,
            quiescent: ownerIdle && !activity && failures.length === 0,
          }
        })
      } catch (error) {
        if (error instanceof RunTerminalError) throw error
        fail('RUN_TERMINALS_IDLE_CLAIM_FAILED', 'Native idle maintenance could not complete; no permission restoration was attempted')
      }
      // Waking work may start when the maintenance claim releases. Recheck the
      // exact owner after that release, before reporting restoration readiness.
      const ownerIdle = getAgent() === owner && owner.status === 'idle'
      const remainingIds = terminalIds(service.list(owner))
      const activity = ownerActivity(service, owner) || remainingIds.length > 0
      return {
        ...result, ownerIdle, remainingIds, stillOwnerActivity: activity,
        quiescent: result.quiescent && ownerIdle && !activity,
      }
    },
  }
}

/** Explicit per-run cleanup; never automatically closes a terminal on failure. */
export function registerRunTerminalTools(
  server: McpServer,
  relay: RunTerminalRelayPort,
  control?: RunTerminalControl,
  principal?: string,
): void {
  server.registerTool('close_run_terminals', {
    title: 'Close one idle run owner’s persistent terminals',
    description: 'Explicit permission recovery for a terminal run, or needs_attention with permission_restore_failed. Reject active native Agents. Discard this exact Agent session’s published PTY snapshot, including shells retained from prior runs; Agent idle cannot prove commands inside those shells are idle. Preserve other owners and unpublished/new terminal activity. Reconcile the original permission lease only after confirmed quiescence and return the updated original run. Never clears Inbox/history.',
    inputSchema: { runId: z.string().min(1).max(512) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try {
      const run = await relay.getRun(input.runId, principal)
      if (run.runId !== input.runId) fail('RUN_TERMINALS_OWNER_MISMATCH', 'The requested run identity could not be verified')
      if (!['succeeded', 'incomplete', 'failed', 'cancelled'].includes(run.status)
        && !(run.status === 'needs_attention' && run.attentionReason === 'permission_restore_failed')) {
        fail('RUN_TERMINALS_RUN_ACTIVE', 'Only a terminal run or idle permission-restoration failure can close its terminals')
      }
      if (control === undefined) fail('RUN_TERMINALS_UNAVAILABLE', 'Native owner-scoped terminal control is unavailable')
      const closeResult = await control.close(run.sessionId)
      const closed = object(closeResult, 'native terminal close result')
      const ready = closed.sessionId === run.sessionId && closed.quiescent === true
        && closed.stillOwnerActivity === false && closed.ownerIdle === true
      let permissions: { attempted: boolean; restored: boolean; error?: string } = { attempted: false, restored: false }
      if (ready) {
        try {
          const result = await relay.reconcilePermissions(run.sessionId)
          permissions = { attempted: true, restored: result.sessionId === run.sessionId && result.restored === true }
        } catch (error) {
          permissions = { attempted: true, restored: false, error: error instanceof Error ? error.message : 'Permission reconciliation failed' }
        }
      }
      let updatedRun: RunSnapshot | undefined
      let runReadError: string | undefined
      try {
        const snapshot = await relay.getRun(run.runId, principal)
        if (snapshot.runId !== run.runId || snapshot.sessionId !== run.sessionId) fail('RUN_TERMINALS_OWNER_MISMATCH', 'The recovered run identity could not be verified')
        updatedRun = snapshot
      } catch (error) {
        runReadError = error instanceof Error ? error.message : 'Updated run could not be read'
      }
      const structuredContent = {
        runId: run.runId, ...closed, permissions,
        ...(updatedRun === undefined ? {} : { run: updatedRun }),
        ...(runReadError === undefined ? {} : { runReadError }),
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent }
    } catch (error) {
      const structuredContent = {
        code: error instanceof RunTerminalError ? error.code : 'RUN_TERMINALS_FAILED',
        message: error instanceof Error ? error.message : 'Run terminal recovery failed', retryable: false,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: true }
    }
  })
}

function terminalIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => !isRecord(item) || typeof item.sessionId !== 'string' || item.sessionId.length === 0)) fail('RUN_TERMINALS_API_INCOMPATIBLE', 'Native terminal list must contain owner-scoped sessionId snapshots')
  return [...new Set(value.map(item => (item as { sessionId: string }).sessionId))]
}
function ownerActivity(service: NativeTerminals, owner: NativeAgent): boolean {
  const value = service.hasOwnerActivity(owner)
  if (typeof value !== 'boolean') fail('RUN_TERMINALS_API_INCOMPATIBLE', 'Native terminal owner activity is unknown')
  return value
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail('RUN_TERMINALS_UNAVAILABLE', label + ' is unavailable')
  return value
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function errorCode(error: unknown): string { return isRecord(error) && typeof error.code === 'string' ? error.code : 'TERMINAL_KILL_FAILED' }
function fail(code: string, message: string): never { throw new RunTerminalError(code, message) }
