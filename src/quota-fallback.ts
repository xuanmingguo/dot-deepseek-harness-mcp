import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { HistoryInput, HistoryResult } from './native-control/index.js'
import type { ModelSelection, OperationRecord, PermissionPreset, RunSnapshot } from './types.js'

export type QuotaFailureReason = 'http-429' | 'rate-limit' | 'quota-exhausted'
export interface QuotaFallbackRelayPort {
  getRun(runId: string, principal?: string): Promise<RunSnapshot>
  getOperation(operationId: string): Promise<OperationRecord>
  listRuns(serviceId?: string, principal?: string): Promise<RunSnapshot[]>
  replyRun(runId: string, input: {
    task: string
    provider: string
    model: string
    reasoningEffort: string
    permissionPreset: PermissionPreset
    confirmedDangerousPermission: boolean
    idempotencyKey: string
    openBrowser: boolean
  }, principal?: string): Promise<RunSnapshot>
}
export interface QuotaFallbackHistoryPort { readSessionHistory(input: HistoryInput): Promise<HistoryResult> }
export interface QuotaFallbackResult {
  originalRunId: string
  idempotencyKey: string
  fallbackReason: { classification: QuotaFailureReason; originalError: string; from: ModelSelection; to: ModelSelection }
  audit: { promptSeq: number; throughSeq: number; inspectedEvents: number } | null
  reused: boolean
  run: RunSnapshot
}
export class QuotaFallbackError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'QuotaFallbackError'
  }
}

/** Explicit provider quota signals only; ambiguous transport outcomes never qualify. */
export function classifyQuotaFailure(error: string | null): QuotaFailureReason | null {
  if (error === null || /timeout|timed[ -]?out|unknown|ECONN|connection[ -](?:lost|reset)|network[ -]error/iu.test(error)) return null
  if (/\b(?:http\s*)?429\b/iu.test(error)) return 'http-429'
  if (/\brate[-_ ]limit(?:ed|ing|[-_ ]exceeded)?\b/iu.test(error)) return 'rate-limit'
  if (/\binsufficient[-_ ]quota\b|\bquota[-_ ](?:exhausted|depleted|exceeded)\b|(?:额度|配额).{0,12}(?:耗尽|用尽|不足|超限)|余额不足/iu.test(error)) return 'quota-exhausted'
  return null
}

/**
 * One explicit, opt-in retry. Relay's durable idempotency key owns cross-process
 * deduplication; retained in-flight/uncertain promises prevent local blind replay.
 * This is not an automatic model-selection or provider-routing policy.
 */
export class QuotaFallbackController {
  private readonly attempts = new Map<string, Promise<QuotaFallbackResult>>()
  constructor(
    private readonly relay: QuotaFallbackRelayPort,
    private readonly nativeControl?: QuotaFallbackHistoryPort,
    private readonly enabled = false,
    private readonly principal?: string,
  ) {}

  async retryRunWithFallback(runId: string): Promise<QuotaFallbackResult> {
    if (!this.enabled) fail('QUOTA_FALLBACK_DISABLED', 'Quota fallback is disabled; no retry was submitted')
    if (typeof runId !== 'string' || runId.length === 0 || runId.length > 512) fail('INVALID_RUN_ID', 'runId must be a nonempty bounded identifier')
    const prior = this.attempts.get(runId)
    if (prior !== undefined) {
      try {
        const result = await prior
        return { ...result, reused: true, run: await this.relay.getRun(result.run.runId, this.principal) }
      } catch {
        // A submission can persist its run before its response is lost. Inspect
        // the same durable key, but never call replyRun again from this path.
        return this.retryOnce(runId, () => {}, false)
      }
    }
    let dispatched = false
    const attempt = this.retryOnce(runId, () => { dispatched = true })
    this.attempts.set(runId, attempt)
    try { return await attempt }
    catch (error) {
      // Evidence-read failures may be inspected again. Once replyRun was called,
      // even a rejected promise is retained: its native outcome may be unknown.
      if (!dispatched && this.attempts.get(runId) === attempt) this.attempts.delete(runId)
      throw error
    }
  }

  private async retryOnce(runId: string, markDispatch: () => void, allowDispatch = true): Promise<QuotaFallbackResult> {
    const original = await this.relay.getRun(runId, this.principal)
    if (original.runId !== runId || original.status !== 'failed') fail('QUOTA_FALLBACK_INELIGIBLE', 'Only an explicitly failed original run can use quota fallback')
    if (original.modelSelection?.provider !== 'zai' || original.modelSelection.model !== 'glm-5.3-flash') fail('QUOTA_FALLBACK_MODEL_MISMATCH', 'Quota fallback applies only to zai/glm-5.3-flash')
    const classification = classifyQuotaFailure(original.error)
    if (classification === null) fail('QUOTA_FALLBACK_NOT_QUOTA', 'The failure is not an explicit quota or rate-limit rejection')
    if (!original.taskPersisted || original.taskImageCount !== 0 || typeof original.task !== 'string' || original.task.trim().length === 0) fail('QUOTA_FALLBACK_TASK_UNSAFE', 'Fallback requires a persisted pure-text task without images')
    if (original.permissionPreset !== 'read-only' && original.permissionPreset !== 'workspace-write' && original.permissionPreset !== 'danger-full-access') fail('QUOTA_FALLBACK_TASK_UNSAFE', 'The original native permission preset is unknown')
    const idempotencyKey = 'quota-fallback:' + runId
    const reason = {
      classification, originalError: original.error!, from: { ...original.modelSelection },
      to: { provider: 'cliproxy', model: 'deepseek-flash', reasoningEffort: 'max' },
    }
    let rpcId: string | undefined
    if (original.operationId !== undefined) {
      const operation = await this.relay.getOperation(original.operationId)
      if (operation.runId !== runId || (operation.kind !== 'start' && operation.kind !== 'reply')
        || (this.principal !== undefined && operation.clientPrincipalId !== this.principal)) {
        fail('QUOTA_FALLBACK_CORRELATION_MISSING', 'The original run operation does not match this caller/run')
      }
      rpcId = operation.rpcId
    }
    const existing = (await this.relay.listRuns(undefined, this.principal)).filter(run => run.idempotencyKey === idempotencyKey)
    if (existing.length > 1) fail('QUOTA_FALLBACK_UNCERTAIN', 'Multiple runs claim this fallback key; inspect the original operation', { originalRunId: runId, idempotencyKey, doNotReplay: true })
    if (existing[0] !== undefined) {
      const run = existing[0]
      if (run.parentRunId !== runId || run.sessionId !== original.sessionId || run.workspace !== original.workspace
        || run.permissionPreset !== original.permissionPreset || run.operationId === undefined
        || (run.modelSelection !== null && (run.modelSelection.provider !== 'cliproxy'
          || run.modelSelection.model !== 'deepseek-flash' || run.modelSelection.reasoningEffort !== 'max'))) {
        fail('QUOTA_FALLBACK_UNCERTAIN', 'The existing fallback key has conflicting run metadata', { originalRunId: runId, idempotencyKey, doNotReplay: true })
      }
      const operation = await this.relay.getOperation(run.operationId)
      if (operation.runId !== run.runId || operation.kind !== 'reply' || operation.idempotencyKey !== idempotencyKey
        || (this.principal !== undefined && operation.clientPrincipalId !== this.principal)) {
        fail('QUOTA_FALLBACK_UNCERTAIN', 'The existing fallback operation cannot be verified', { originalRunId: runId, idempotencyKey, doNotReplay: true })
      }
      return { originalRunId: runId, idempotencyKey, fallbackReason: reason, audit: null, reused: true, run: await this.relay.getRun(run.runId, this.principal) }
    }
    if (!allowDispatch) fail('QUOTA_FALLBACK_UNCERTAIN', 'No confirmed run exists for the prior fallback submission; inspect the fixed-key Relay operation without replaying it', { originalRunId: runId, idempotencyKey, doNotReplay: true })
    if (this.nativeControl === undefined) fail('QUOTA_FALLBACK_HISTORY_UNAVAILABLE', 'Native history is required to exclude earlier tool/subagent effects')
    const audit = await auditHistory(this.nativeControl, original, rpcId)
    // Recheck durable status immediately before dispatch; history itself is a
    // fixed cut, so concurrent new turns must not silently change this task.
    const current = await this.relay.getRun(runId, this.principal)
    if (current.status !== 'failed' || current.sessionId !== original.sessionId || current.task !== original.task
      || current.lastEventSeq > audit.throughSeq || current.error !== original.error
      || current.permissionPreset !== original.permissionPreset || current.modelSelection?.provider !== 'zai'
      || current.modelSelection.model !== 'glm-5.3-flash' || !current.taskPersisted || current.taskImageCount !== 0) {
      fail('QUOTA_FALLBACK_CONCURRENT_CHANGE', 'The original run changed after history inspection; no retry was submitted')
    }
    markDispatch()
    try {
      const run = await this.relay.replyRun(runId, {
        task: original.task, provider: 'cliproxy', model: 'deepseek-flash', reasoningEffort: 'max',
        permissionPreset: original.permissionPreset, confirmedDangerousPermission: original.permissionPreset === 'danger-full-access',
        idempotencyKey, openBrowser: false,
      }, this.principal)
      return { originalRunId: runId, idempotencyKey, fallbackReason: reason, audit, reused: false, run }
    } catch {
      fail('QUOTA_FALLBACK_UNCERTAIN', 'The fallback submission did not return a confirmed run; inspect the fixed-key Relay operation instead of resubmitting', { originalRunId: runId, idempotencyKey, doNotReplay: true })
    }
  }
}

/** Register a visible, explicitly invoked fallback; disabled unless configured. */
export function registerQuotaFallbackTool(
  server: McpServer,
  relay: QuotaFallbackRelayPort,
  nativeControl?: QuotaFallbackHistoryPort,
  enabled = false,
  principal?: string,
): void {
  const control = new QuotaFallbackController(relay, nativeControl, enabled, principal)
  server.registerTool('retry_run_with_fallback', {
    title: 'Explicitly retry one quota-rejected GLM run',
    description: 'Opt-in only; disabled by default. Retry a failed zai/glm-5.3-flash pure-text run once with cliproxy/deepseek-flash/max after complete native history excludes tool/subagent effects and assistant tool calls. Unknown, truncated, timeout or ambiguous outcomes are refused. Uses the fixed quota-fallback:<originalRunId> key and original permissions; never silently changes a model.',
    inputSchema: { runId: z.string().min(1).max(512) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async input => {
    try {
      const value = await control.retryRunWithFallback(input.runId)
      const structuredContent = { ...value }
      return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent }
    } catch (error) {
      const structuredContent = error instanceof QuotaFallbackError
        ? { code: error.code, message: error.message, retryable: false, ...error.details }
        : { code: 'QUOTA_FALLBACK_EVIDENCE_UNAVAILABLE', message: 'Unable to verify the original run, operation, or complete native history; no automatic retry is safe', retryable: false }
      return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: true }
    }
  })
}

async function auditHistory(history: QuotaFallbackHistoryPort, original: RunSnapshot, rpcId?: string) {
  if (!original.promptMessageId && !rpcId) fail('QUOTA_FALLBACK_CORRELATION_MISSING', 'The original prompt has no durable message/RPC correlation')
  let cursor: string | undefined
  let throughSeq: number | undefined
  let expectedSeq: number | undefined
  let inspectedEvents = 0
  let terminal = false
  const cursors = new Set<string>()
  for (;;) {
    let page: HistoryResult
    try { page = await history.readSessionHistory({ sessionId: original.sessionId, maxMessages: 50, ...(cursor === undefined ? {} : { cursor }) }) }
    catch { fail('QUOTA_FALLBACK_HISTORY_UNAVAILABLE', 'Complete native history could not be read; oversized or truncated evidence cannot authorize a retry') }
    if (page.sessionId !== original.sessionId || !Number.isSafeInteger(page.throughSeq) || page.throughSeq < original.lastEventSeq
      || (throughSeq !== undefined && page.throughSeq !== throughSeq) || !Array.isArray(page.records) || page.records.length === 0) {
      fail('QUOTA_FALLBACK_HISTORY_INCOMPLETE', 'Native history is empty, stale, truncated, or changed its anchor')
    }
    throughSeq ??= page.throughSeq
    expectedSeq ??= throughSeq
    for (const record of [...page.records].reverse()) {
      const event = record.event
      if (record.type !== 'event' || !isRecord(event) || !Number.isSafeInteger(event.seq) || event.seq !== expectedSeq
        || typeof event.type !== 'string' || !isRecord(event.data)) fail('QUOTA_FALLBACK_HISTORY_INCOMPLETE', 'Native history has a gap or unsupported event shape')
      expectedSeq -= 1
      inspectedEvents += 1
      const data = event.data
      if (event.type === 'user/message') {
        const source = isRecord(data.source) ? data.source : {}
        const matchesId = original.promptMessageId === null || data.id === original.promptMessageId
        const matchesRpc = rpcId === undefined || source.rpcId === rpcId
        if (!matchesId || !matchesRpc || source.kind !== 'user') fail('QUOTA_FALLBACK_CORRELATION_MISSING', 'A different or uncorrelated prompt appears after the original run boundary')
        if (plainText(data.content) !== original.task) fail('QUOTA_FALLBACK_TASK_UNSAFE', 'Native prompt content is not the exact persisted pure-text task')
        if (!terminal) fail('QUOTA_FALLBACK_HISTORY_INCOMPLETE', 'No explicit native quota-failed turn closure was observed')
        return { promptSeq: event.seq, throughSeq, inspectedEvents }
      }
      if (/tool|subagent/iu.test(event.type)) fail('QUOTA_FALLBACK_SIDE_EFFECTS', 'Native history contains tool/subagent activity; replay is prohibited', { eventType: event.type, seq: event.seq })
      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        inspectAssistant(data, event.type === 'assistant/message')
      } else if (event.type === 'turn/end') {
        const reason = isRecord(data.reason) ? data.reason : {}
        const failure = isRecord(reason.error) ? reason.error : {}
        const nativeFailure = [failure.code, failure.message, failure.status].filter(value => typeof value === 'string' || typeof value === 'number').join(' ')
        if (terminal || reason.kind !== 'error' || classifyQuotaFailure(nativeFailure) === null) fail('QUOTA_FALLBACK_HISTORY_INCOMPLETE', 'Native turn closure is not one unambiguous quota failure')
        terminal = true
      } else if (event.type === 'system/message' || event.type === 'developer/message') {
        const message = isRecord(data.message) ? data.message : {}
        if (plainText(message.content) === null) fail('QUOTA_FALLBACK_UNKNOWN_RISK', 'Native system/developer message contains unsupported blocks')
      } else if (!['step/start', 'step/end', 'request/header', 'request/context', 'llm/retry', 'llm/retry-started', 'permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type)) {
        fail('QUOTA_FALLBACK_UNKNOWN_RISK', 'Native history contains an unclassified event; replay is prohibited', { eventType: event.type, seq: event.seq })
      }
    }
    if (page.hasMore !== true || typeof page.nextCursor !== 'string' || page.nextCursor.length === 0 || cursors.has(page.nextCursor)) fail('QUOTA_FALLBACK_CORRELATION_MISSING', 'The original prompt was not found in complete advancing history')
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
}

function inspectAssistant(data: Record<string, unknown>, requireMessage: boolean): void {
  if (requireMessage && !isRecord(data.message)) fail('QUOTA_FALLBACK_UNKNOWN_RISK', 'Assistant message is missing or truncated')
  if (containsToolSignal(data)) fail('QUOTA_FALLBACK_SIDE_EFFECTS', 'Assistant history contains a tool call or subagent signal')
  if (data.message !== undefined) {
    if (!isRecord(data.message) || !Array.isArray(data.message.content)) fail('QUOTA_FALLBACK_UNKNOWN_RISK', 'Assistant message content is missing or unsupported')
    for (const block of data.message.content) inspectTextBlock(block)
  }
  if (!Array.isArray(data.stream)) fail('QUOTA_FALLBACK_UNKNOWN_RISK', 'Assistant raw stream is missing or truncated')
  for (const record of data.stream) {
    if (!isRecord(record)) fail('QUOTA_FALLBACK_UNKNOWN_RISK', 'Assistant stream contains an unsupported record')
    if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
      if (!Array.isArray(record.texts) || record.texts.length === 0 || record.texts.some(value => typeof value !== 'string')
        || !Number.isSafeInteger(record.time0) || !Number.isSafeInteger(record.index) || (record.index as number) < 0
        || !Array.isArray(record.dt) || record.dt.length !== record.texts.length - 1 || record.dt.some(value => !Number.isSafeInteger(value))) fail('QUOTA_FALLBACK_UNKNOWN_RISK', 'Assistant compact stream is incomplete')
    } else if (record.type === 'chunk' && isRecord(record.chunk)) {
      const chunk = record.chunk
      if (chunk.type === 'block-start') {
        if (chunk.blockType !== 'text' && chunk.blockType !== 'reasoning') fail('QUOTA_FALLBACK_UNKNOWN_RISK', 'Assistant stream began an unsupported block')
      } else if (chunk.type === 'block-end') inspectTextBlock(chunk.block)
      else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        if (typeof chunk.text !== 'string') fail('QUOTA_FALLBACK_UNKNOWN_RISK', 'Assistant delta is incomplete')
      } else if (chunk.type === 'finish') {
        if (!isRecord(chunk.reason) || !['stop', 'max-tokens', 'error', 'aborted'].includes(String(chunk.reason.kind))) fail('QUOTA_FALLBACK_UNKNOWN_RISK', 'Assistant finish reason is unsupported')
      } else if (chunk.type !== 'usage') fail('QUOTA_FALLBACK_UNKNOWN_RISK', 'Assistant stream contains an unsupported chunk')
    } else fail('QUOTA_FALLBACK_UNKNOWN_RISK', 'Assistant stream contains an unsupported record')
  }
}
function containsToolSignal(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsToolSignal)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, child]) =>
    ((key === 'type' || key === 'kind' || key === 'blockType') && typeof child === 'string' && /tool[-_/ ]?call|subagent/iu.test(child))
    || (/tool[_-]?calls?/iu.test(key) && child !== null && child !== undefined && (!Array.isArray(child) || child.length > 0))
    || containsToolSignal(child))
}
function inspectTextBlock(block: unknown): void {
  if (!isRecord(block) || (block.type !== 'text' && block.type !== 'reasoning') || typeof block.text !== 'string') fail('QUOTA_FALLBACK_UNKNOWN_RISK', 'Assistant content has an unsupported block')
}
function plainText(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0 || content.some(block => !isRecord(block) || block.type !== 'text' || typeof block.text !== 'string')) return null
  return content.map(block => (block as { text: string }).text).join('\n')
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function fail(code: string, message: string, details: Record<string, unknown> = {}): never { throw new QuotaFallbackError(code, message, details) }
