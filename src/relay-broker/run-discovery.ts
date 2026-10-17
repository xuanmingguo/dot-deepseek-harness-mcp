import { createHash } from 'node:crypto'
import { MonitoringFacade, type RunSummary } from '../monitoring/index.js'
import type { RunSnapshot, RunStatus } from '../types.js'
import { RelayError } from './errors.js'

export const RUN_DISCOVERY_STATUSES = ['running', 'needs_attention', 'succeeded', 'incomplete', 'failed', 'cancelled', 'unknown'] as const satisfies readonly RunStatus[]

export interface RunDiscoveryInput {
  serviceId?: string | undefined
  workspace?: string | undefined
  sessionId?: string | undefined
  status?: RunStatus | undefined
  limit?: number | undefined
  cursor?: string | undefined
}

type Filters = { serviceId: string | null; workspace: string | null; sessionId: string | null; status: RunStatus | null }
type Key = [startedAt: string, runId: string]
interface Cursor { v: 1; filters: Filters; upper: Key; after: Key }
export type CompactRunSummary = Omit<RunSummary, 'executionOutcome' | 'attention'> & {
  serviceId: string
  operationId?: string
  workspace: string
  sessionId: string
  warningCount: number
  executionOutcome?: { status: NonNullable<RunSummary['executionOutcome']>['status']; finishedAt: string }
  attention?: { reason: NonNullable<RunSummary['attention']>['reason'] }
}
export interface RunDiscoveryPage { runs: CompactRunSummary[]; hasMore: boolean; nextCursor: string | null }

/** Exact recorded paths only: no filesystem lookup, resolution, or case folding. */
export function prepareRunDiscovery(input: RunDiscoveryInput) {
  const limit = input.limit ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RelayError('INVALID_RUN_LIMIT', 'limit must be an integer from 1 to 50', false, { field: 'limit' })
  for (const field of ['serviceId', 'workspace', 'sessionId'] as const) {
    const value = input[field]
    if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.length > 4096)) {
      throw new RelayError('INVALID_RUN_FILTER', `Invalid ${field} filter`, false, { field })
    }
  }
  if (input.status !== undefined && !RUN_DISCOVERY_STATUSES.includes(input.status)) throw new RelayError('INVALID_RUN_FILTER', 'Invalid status filter', false, { field: 'status' })
  const filters: Filters = { serviceId: input.serviceId ?? null, workspace: input.workspace ?? null, sessionId: input.sessionId ?? null, status: input.status ?? null }
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor, filters)
  return { limit, filters, cursor }
}

export function matchesDiscoveryScope(snapshot: RunSnapshot, filters: Filters): boolean {
  return (filters.serviceId === null || snapshot.serviceId === filters.serviceId)
    && (filters.workspace === null || snapshot.workspace === filters.workspace)
    && (filters.sessionId === null || snapshot.sessionId === filters.sessionId)
}

export function runDiscoveryKey(snapshot: RunSnapshot): Key { return [snapshot.startedAt, snapshot.runId] }

/** Ascending key comparison; discovery reverses this for newest first. */
export function compareDiscoveryKeys(left: Key, right: Key): number {
  const time = Date.parse(left[0]) - Date.parse(right[0])
  return time || (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0)
}

export function runDiscoveryCursor(filters: Filters, upper: Key, after: Key): string {
  const payload = JSON.stringify({ v: 1, filters, upper, after } satisfies Cursor)
  return `${Buffer.from(payload).toString('base64url')}.${checksum(payload)}`
}

function checksum(payload: string): string { return createHash('sha256').update(payload).digest('base64url') }

function decodeCursor(value: string, filters: Filters): Cursor {
  const invalid = () => new RelayError('INVALID_RUN_CURSOR', 'Invalid run discovery cursor or filters; restart discovery without a cursor', false, { field: 'cursor', nextAction: 'none' })
  try {
    if (typeof value !== 'string' || value.length > 20_000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw invalid()
    const [encoded, digest] = value.split('.')
    const payload = Buffer.from(encoded!, 'base64url').toString('utf8')
    if (Buffer.from(payload).toString('base64url') !== encoded || checksum(payload) !== digest) throw invalid()
    const parsed = JSON.parse(payload) as Cursor
    const validKey = (key: unknown): key is Key => Array.isArray(key) && key.length === 2
      && typeof key[0] === 'string' && key[0].length <= 64 && Number.isFinite(Date.parse(key[0]))
      && typeof key[1] === 'string' && key[1].length > 0 && key[1].length <= 256
    if (parsed.v !== 1 || !validKey(parsed.upper) || !validKey(parsed.after)
      || compareDiscoveryKeys(parsed.after, parsed.upper) > 0
      || JSON.stringify(parsed.filters) !== JSON.stringify(filters)
      || payload !== JSON.stringify({ v: 1, filters, upper: parsed.upper, after: parsed.after })) throw invalid()
    return parsed
  } catch { throw invalid() }
}

const monitoring = new MonitoringFacade()

export function compactRunSummary(snapshot: RunSnapshot): CompactRunSummary {
  // The normal summary may contain raw error text in attention and executionOutcome.
  const { attention, executionOutcome, ...summary } = monitoring.project({ ...snapshot, error: null })
  return {
    ...summary,
    ...(attention === undefined ? {} : { attention: { reason: attention.reason } }),
    ...(executionOutcome === undefined ? {} : { executionOutcome: { status: executionOutcome.status, finishedAt: executionOutcome.finishedAt } }),
    serviceId: snapshot.serviceId,
    ...(snapshot.operationId === undefined ? {} : { operationId: snapshot.operationId }),
    workspace: snapshot.workspace,
    sessionId: snapshot.sessionId,
    warningCount: Math.min(snapshot.warnings.length, Number.MAX_SAFE_INTEGER),
  }
}
