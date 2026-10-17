import { createHash } from 'node:crypto'
import { NativeControlError } from './errors.js'
import { historyText } from './history-text.js'
import type { HistoryInput, HistoryResult, NativeHistoryRecord } from './native-control-facade.js'

export interface HistorySearchInput {
  workspace: string
  query: string
  sessionId?: string | undefined
  role?: 'user' | 'assistant' | 'both' | undefined
  caseSensitive?: boolean | undefined
  limit?: number | undefined
  scanPages?: number | undefined
  cursor?: string | undefined
}
export interface HistorySearchMatch {
  sessionId: string
  role: 'user' | 'assistant'
  eventType: 'user/message' | 'assistant/message'
  seq: number
  throughSeq: number
  time?: string | number
  textBlockIndex: number
  excerpt: string
  textLength: number
  excerptStart: number
  truncated: boolean
}
export interface HistorySearchResult {
  workspace: string
  workspaceId: string
  query: string
  role: 'user' | 'assistant' | 'both'
  caseSensitive: boolean
  matches: HistorySearchMatch[]
  pagesRead: number
  recordsScanned: number
  sessionsVisited: number
  sessionsTotal: number
  scanComplete: boolean
  hasMore: boolean
  nextCursor: string | null
  order: 'session-id-lexical/newest-first'
  sourceTrust: 'untrusted'
}
export interface SearchWorkspace { workspaceId: string; path: string; sessionIds: string[] }
interface SearchPorts {
  workspace(input: string): Promise<SearchWorkspace>
  read(input: HistoryInput): Promise<HistoryResult>
  cursor(sessionId: string, throughSeq: number, beforeSeq: number): string
  validateCursor(cursor: string, sessionId: string): void
}
interface SearchCursor { v: 1; f: string; m: string; i: number; n: string | null }

/** Indexless search: one match per native message, from one original text block.
 * Sessions have lexical ID order, not global recency order. The active session's
 * native cut is pinned; each unvisited session captures its cut on first visit.
 */
export async function searchSessionHistory(input: HistorySearchInput, ports: SearchPorts): Promise<HistorySearchResult> {
  boundedString(input.workspace, 'workspace', 4096)
  boundedString(input.query, 'query', 256)
  if (input.sessionId !== undefined) boundedString(input.sessionId, 'sessionId', 512)
  const role = input.role ?? 'both'
  if (!['user', 'assistant', 'both'].includes(role)) fail('INVALID_ARGUMENT', 'role must be user, assistant or both')
  const caseSensitive = input.caseSensitive ?? false
  if (typeof caseSensitive !== 'boolean') fail('INVALID_ARGUMENT', 'caseSensitive must be boolean')
  const limit = integer(input.limit ?? 10, 1, 25, 'limit')
  const scanPages = integer(input.scanPages ?? 5, 1, 10, 'scanPages')
  const cursor = input.cursor === undefined ? undefined : decode(input.cursor)
  const scope = await ports.workspace(input.workspace)
  if (input.sessionId !== undefined && !scope.sessionIds.includes(input.sessionId)) {
    if (cursor !== undefined) fail('SEARCH_SCOPE_CHANGED', 'Selected session is no longer registered in the workspace; start a fresh search')
    fail('SESSION_NOT_REGISTERED', 'Session must belong to the selected registered workspace')
  }
  const sessions = [...new Set(input.sessionId === undefined ? scope.sessionIds : [input.sessionId])].sort()
  const fingerprint = hash(JSON.stringify([input.workspace, scope.workspaceId, scope.path, input.query, role, caseSensitive, input.sessionId ?? null]))
  const membership = hash(JSON.stringify(sessions))
  if (cursor !== undefined) {
    if (cursor.f !== fingerprint) fail('INVALID_SEARCH_CURSOR', 'Search cursor belongs to different workspace or search filters')
    if (cursor.m !== membership) fail('SEARCH_SCOPE_CHANGED', 'Registered search session membership changed; start a fresh search')
    if (cursor.i >= sessions.length) fail('INVALID_SEARCH_CURSOR', 'Search cursor session index is out of bounds')
    if (cursor.n !== null) {
      try { ports.validateCursor(cursor.n, sessions[cursor.i]!) }
      catch { fail('INVALID_SEARCH_CURSOR', 'Search cursor contains an invalid native history position') }
    }
  }
  const pattern = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'u' : 'iu')
  let index = cursor?.i ?? 0
  let nativeCursor = cursor?.n ?? undefined
  let pagesRead = 0
  let recordsScanned = 0
  const visited = new Set<string>()
  const matches: HistorySearchMatch[] = []
  while (index < sessions.length && pagesRead < scanPages && matches.length < limit) {
    const sessionId = sessions[index]!
    visited.add(sessionId)
    const page = await ports.read({ sessionId, cursor: nativeCursor, maxMessages: 10 })
    pagesRead += 1
    let remaining = page.hasMore
    for (let recordIndex = page.records.length - 1; recordIndex >= 0; recordIndex -= 1) {
      const record = page.records[recordIndex]!
      recordsScanned += 1
      const match = findMatch(record, sessionId, page.throughSeq, role, pattern)
      if (match !== null) matches.push(match)
      remaining = recordIndex > 0 || page.hasMore
      nativeCursor = remaining ? ports.cursor(sessionId, page.throughSeq, record.event.seq) : undefined
      if (matches.length >= limit) break
    }
    if (!remaining) { index += 1; nativeCursor = undefined }
    else if (matches.length < limit) nativeCursor = page.nextCursor ?? undefined
  }
  const hasMore = index < sessions.length
  return {
    workspace: scope.path, workspaceId: scope.workspaceId, query: input.query, role, caseSensitive, matches,
    pagesRead, recordsScanned, sessionsVisited: visited.size, sessionsTotal: sessions.length,
    scanComplete: !hasMore, hasMore,
    nextCursor: hasMore ? encode({ v: 1, f: fingerprint, m: membership, i: index, n: nativeCursor ?? null }) : null,
    order: 'session-id-lexical/newest-first', sourceTrust: 'untrusted',
  }
}

function findMatch(record: NativeHistoryRecord, sessionId: string, throughSeq: number, role: string, pattern: RegExp): HistorySearchMatch | null {
  const event = record.event
  const extracted = historyText(record)
  if (extracted === null) return null
  const { eventType, role: eventRole, blocks } = extracted
  if (role !== 'both' && role !== eventRole) return null
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const text = blocks[blockIndex]
    if (text === null || text === undefined) continue
    const match = pattern.exec(text)
    if (match === null) continue
    const characters = Array.from(text)
    const matchStart = Array.from(text.slice(0, match.index)).length
    const matchLength = Array.from(match[0]).length
    const excerptStart = Math.max(0, Math.min(matchStart - Math.floor((600 - matchLength) / 2), characters.length - 600))
    const excerpt = characters.slice(excerptStart, excerptStart + 600).join('')
    return {
      sessionId, role: eventRole, eventType, seq: event.seq, throughSeq,
      ...(typeof event.time === 'string' || (typeof event.time === 'number' && Number.isFinite(event.time)) ? { time: event.time } : {}),
      textBlockIndex: blockIndex, excerpt, textLength: characters.length, excerptStart, truncated: characters.length > 600,
    }
  }
  return null
}
function hash(value: string): string { return createHash('sha256').update(value).digest('base64url') }
function encode(cursor: SearchCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  return 'sh1.' + payload + '.' + hash(payload)
}
function decode(input: string): SearchCursor {
  try {
    if (typeof input !== 'string' || input.length > 16000) throw new Error()
    const [prefix, payload, checksum, ...extra] = input.split('.')
    if (prefix !== 'sh1' || !payload || !/^[A-Za-z0-9_-]+$/.test(payload) || checksum !== hash(payload) || extra.length !== 0) throw new Error()
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'f,i,m,n,v' || value.v !== 1 || typeof value.f !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.f) || typeof value.m !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.m) || (value.n !== null && typeof value.n !== 'string')) throw new Error()
    const cursor: SearchCursor = { v: 1, f: value.f, m: value.m, i: integer(value.i, 0, Number.MAX_SAFE_INTEGER, 'cursor index'), n: value.n }
    if (encode(cursor) !== input) throw new Error()
    return cursor
  } catch { fail('INVALID_SEARCH_CURSOR', 'Search cursor is malformed, noncanonical or has an invalid checksum') }
}
function integer(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_ARGUMENT', name + ' is out of bounds')
  return value
}
function boundedString(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0')) fail('INVALID_ARGUMENT', name + ' must be a nonblank bounded string')
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function fail(code: string, message: string): never { throw new NativeControlError(code, message) }
