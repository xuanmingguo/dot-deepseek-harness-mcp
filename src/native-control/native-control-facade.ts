import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ExternalPathGrant, TaskScopeDeclaration } from '../types.js'
import { grantContains, validateExternalTaskScope } from '../external-paths.js'
import type { HarnessGatewayFacade, TypertGatewayPort } from '../harness-gateway/index.js'
import { HostRpcError, typertGatewayError } from '../harness-gateway/index.js'
import { SessionRoutingFacade } from '../session-routing/index.js'
import { NativeControlError } from './errors.js'
import { readSessionContext, type HistoryContextInput, type HistoryContextResult } from './history-context.js'
import { searchSessionHistory, type HistorySearchInput, type HistorySearchResult, type SearchWorkspace } from './history-search.js'
import { listProjectFiles, type ProjectFilesInput, type ProjectFilesResult } from './project-files.js'
import { readProjectText, type ProjectTextInput, type ProjectTextResult } from './project-text.js'
import { searchProjectText, type ProjectSearchInput, type ProjectSearchResult } from './project-search.js'
export { NativeControlError } from './errors.js'

export const MAX_NATIVE_JSON_BYTES = 512 * 1024
export const MAX_ARTIFACT_BYTES = 64 * 1024
export const MAX_ARTIFACT_FILE_BYTES = 16 * 1024 * 1024
export const MAX_CLEAR_QUEUE_ITEMS = 100

export interface NativeControlOptions {
  gateway: HarnessGatewayFacade
  typert: TypertGatewayPort
  allowedWorkspaceRoots: string[]
  externalPathPolicy?: ExternalPathGrant[]
}
export interface HistoryInput { sessionId: string; cursor?: string | undefined; maxMessages?: number | undefined }
export interface ArtifactInput { workspace: string; path: string; offsetBytes?: number | undefined; maxBytes?: number | undefined }
export interface ScopedArtifactInput extends ArtifactInput { scope: TaskScopeDeclaration | undefined }
export interface NativeHistoryRecord { type: 'event'; event: Record<string, unknown> & { seq: number } }
export interface HistoryResult {
  sessionId: string
  throughSeq: number
  records: NativeHistoryRecord[]
  hasMore: boolean
  nextCursor: string | null
}
export interface QueueItem extends Record<string, unknown> { id: string; content: unknown[] }
export interface QueueSnapshot { sessionId: string; asOfSeq: number; nextTurn: QueueItem[]; nextStep: QueueItem[] }
interface HistoryCursor { v: 1; s: string; t: number; b: number }

/**
 * Public Typert Session Controller operations. No native methods are replaced.
 * Cursors are restart-stable data, not credentials or authorization. Every use
 * revalidates its session against the current Harness workspace registry.
 * Artifact roots follow Relay's configured-roots / registered-workspaces policy.
 */
export class NativeControlFacade {
  private readonly steering = new Map<string, 'dispatching' | 'uncertain' | 'accepted'>()
  constructor(private readonly options: NativeControlOptions) {}

  async readSessionContext(input: HistoryContextInput): Promise<HistoryContextResult> {
    try {
      return await readSessionContext(input, {
        workspace: workspace => this.searchWorkspace(workspace),
        page: request => this.invoke('page', { request }),
      })
    } catch (error) {
      if (error instanceof NativeControlError) throw error
      if (error instanceof HostRpcError) throw new NativeControlError(error.code, 'Native session context could not read the registered history', { retryable: error.retryable })
      fail('NATIVE_HISTORY_CONTEXT_FAILED', 'Native session context failed; no complete context result is available')
    }
  }

  async searchSessionHistory(input: HistorySearchInput): Promise<HistorySearchResult> {
    try {
      return await searchSessionHistory(input, {
        workspace: workspace => this.searchWorkspace(workspace),
        read: page => this.readSessionHistory(page),
        cursor: (s, t, b) => encodeCursor({ v: 1, s, t, b }),
        validateCursor: (cursor, sessionId) => { decodeCursor(cursor, sessionId) },
      })
    } catch (error) {
      if (error instanceof NativeControlError) throw error
      // Preserve explicit gateway codes without returning arbitrary native error text.
      if (error instanceof HostRpcError) throw new NativeControlError(error.code, 'Native history search could not read the registered history', { retryable: error.retryable })
      fail('NATIVE_HISTORY_SEARCH_FAILED', 'Native history search failed; no complete search result is available')
    }
  }

  async readSessionHistory(input: HistoryInput): Promise<HistoryResult> {
    validId(input.sessionId, 'sessionId')
    const maxMessages = boundedInteger(input.maxMessages ?? 25, 1, 50, 'maxMessages')
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor, input.sessionId)
    await this.assertKnownSession(input.sessionId)
    let throughSeq: number
    let page: unknown
    if (cursor === undefined) {
      const snapshot = await this.firstSnapshot(input.sessionId, maxMessages)
      throughSeq = boundedInteger(snapshot.cursor, 0, Number.MAX_SAFE_INTEGER, 'snapshot cursor', 'NATIVE_API_INCOMPATIBLE')
      if (isRecord(snapshot.header) && snapshot.header.id !== input.sessionId) fail('NATIVE_API_INCOMPATIBLE', 'session.follow returned a different session')
      page = snapshot
    } else {
      throughSeq = cursor.t
      page = await this.invoke('page', {
        request: { address: { kind: 'session', sessionId: input.sessionId }, throughSeq, beforeSeq: cursor.b, maxMessages },
      })
    }
    if (!isRecord(page) || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') fail('NATIVE_API_INCOMPATIBLE', 'Session history page is not a native records page')
    const records: NativeHistoryRecord[] = []
    let previous = -1
    for (const record of page.records) {
      if (!isRecord(record) || record.type !== 'event' || !isRecord(record.event)) fail('NATIVE_API_INCOMPATIBLE', 'Session history contains an unsupported record shape')
      const seq = boundedInteger(record.event.seq, 0, throughSeq, 'record seq', 'NATIVE_API_INCOMPATIBLE')
      if (seq <= previous || (cursor !== undefined && seq >= cursor.b)) fail('NATIVE_API_INCOMPATIBLE', 'Session history order or cursor bounds are invalid')
      previous = seq
      // Preserve complete native records including unknown future event fields.
      records.push(record as unknown as NativeHistoryRecord)
    }
    const first = records[0]?.event.seq
    if (page.hasMore && (first === undefined || first <= 0)) fail('NATIVE_API_INCOMPATIBLE', 'Session history cannot advance its backwards cursor')
    return boundedJson({
      sessionId: input.sessionId, throughSeq, records, hasMore: page.hasMore,
      nextCursor: page.hasMore ? encodeCursor({ v: 1, s: input.sessionId, t: throughSeq, b: first! }) : null,
    })
  }

  async listSessionQueue(sessionId: string): Promise<QueueSnapshot> {
    validId(sessionId, 'sessionId')
    await this.assertKnownSession(sessionId)
    return this.readQueue(sessionId)
  }
  async removeQueueItem(sessionId: string, itemId: string) {
    validId(itemId, 'itemId')
    const before = await this.listSessionQueue(sessionId)
    if (!queueIds(before).includes(itemId)) return { sessionId, itemId, status: 'already-absent' as const, pending: false }
    const applied = await this.removePending(sessionId, itemId)
    const after = await this.readQueue(sessionId)
    const pending = queueIds(after).includes(itemId)
    return { sessionId, itemId, status: pending ? 'still-pending' as const : applied ? 'removed' as const : 'already-absent' as const, pending }
  }
  async clearSessionQueue(sessionId: string) {
    const before = await this.listSessionQueue(sessionId)
    const snapshotIds = queueIds(before)
    if (snapshotIds.length > MAX_CLEAR_QUEUE_ITEMS) fail('QUEUE_TOO_LARGE', 'Queue snapshot exceeds the 100-item clear limit; no items were removed', { count: snapshotIds.length, maxItems: MAX_CLEAR_QUEUE_ITEMS })
    const removedIds: string[] = []
    const alreadyAbsentIds: string[] = []
    // Remove only observed occurrences: never bulk clear or cancel an active turn.
    for (const itemId of snapshotIds) {
      try {
        if (await this.removePending(sessionId, itemId)) removedIds.push(itemId)
        else alreadyAbsentIds.push(itemId)
      } catch (error) {
        // Preserve partial receipts and reconcile read-only; do not replay an
        // uncertain removal or continue mutating after a failed request.
        let remaining: QueueSnapshot | undefined
        let remainingReadError: string | undefined
        try { remaining = await this.readQueue(sessionId) }
        catch (readError) { remainingReadError = errorCode(readError) ?? 'QUEUE_READ_FAILED' }
        throw new NativeControlError(errorCode(error) ?? 'QUEUE_CLEAR_FAILED', error instanceof Error ? error.message : 'Queue clear failed', {
          ...(error instanceof NativeControlError ? error.details : {}),
          sessionId, snapshotIds, removedIds, alreadyAbsentIds, failedItemId: itemId, historyDeleted: false,
          ...(remaining === undefined ? { remainingReadError } : {
            remaining,
            newArrivalIds: queueIds(remaining).filter(id => !snapshotIds.includes(id)),
            stillPendingSnapshotIds: snapshotIds.filter(id => queueIds(remaining).includes(id)),
          }),
        })
      }
    }
    const remaining = await this.readQueue(sessionId)
    const remainingIds = queueIds(remaining)
    return boundedJson({
      sessionId, snapshotIds, removedIds, alreadyAbsentIds, remaining,
      newArrivalIds: remainingIds.filter(itemId => !snapshotIds.includes(itemId)),
      stillPendingSnapshotIds: snapshotIds.filter(itemId => remainingIds.includes(itemId)),
      historyDeleted: false as const,
    })
  }
  async steerQueueItem(sessionId: string, itemId: string) {
    validId(sessionId, 'sessionId')
    validId(itemId, 'itemId')
    await this.assertKnownSession(sessionId)
    const key = JSON.stringify([sessionId, itemId])
    const prior = this.steering.get(key)
    if (prior === 'accepted') return steeringReceipt(sessionId, itemId, true)
    if (prior !== undefined) fail('NATIVE_ACTION_UNCERTAIN', 'Steering may already have reached Harness; inspect native history and queue before another action', { sessionId, itemId, action: 'steer', doNotReplay: true })
    this.steering.set(key, 'dispatching')
    try {
      const before = await this.readQueue(sessionId)
      if (!before.nextTurn.some(item => item.id === itemId)) fail('QUEUE_ITEM_NOT_STEERABLE', 'Steering requires a pending next-turn item; no request was sent', { sessionId, itemId })
      await this.updateQueue(sessionId, itemId, 'steer')
      this.steering.set(key, 'accepted')
      return steeringReceipt(sessionId, itemId, false)
    } catch (error) {
      if (error instanceof NativeControlError && error.code === 'NATIVE_ACTION_UNCERTAIN') this.steering.set(key, 'uncertain')
      else this.steering.delete(key)
      throw error
    }
  }
  async listProjectFiles(input: ProjectFilesInput): Promise<ProjectFilesResult> {
    return listProjectFiles(input, workspace => this.authorizedWorkspace(workspace))
  }

  async readProjectText(input: ProjectTextInput): Promise<ProjectTextResult> {
    return readProjectText(input, workspace => this.authorizedWorkspace(workspace))
  }

  async searchProjectText(input: ProjectSearchInput): Promise<ProjectSearchResult> {
    return searchProjectText(input, workspace => this.authorizedWorkspace(workspace))
  }

  async readArtifact(input: ArtifactInput) {
    validId(input.path, 'path', 4096)
    const workspace = await this.authorizedWorkspace(input.workspace)
    const candidate = resolve(workspace, input.path)
    if (!contains(workspace, candidate) || candidate === workspace) fail('ARTIFACT_PATH_DENIED', 'Artifact must name a file inside the authorized project')
    return this.readArtifactRange(input, workspace, workspace, candidate)
  }
  async readScopedArtifact(input: ScopedArtifactInput) {
    validId(input.path, 'path', 4096)
    const workspace = await this.authorizedWorkspace(input.workspace)
    if (input.scope === undefined) fail('ARTIFACT_SCOPE_REQUIRED', 'Run has no recorded task scope; use read_artifact for project files')
    await validateExternalTaskScope(input.scope, this.options.externalPathPolicy)
    const candidate = resolve(workspace, input.path)
    const allowed = [...input.scope.contextReadScope, ...input.scope.writeScope].some(path => contains(resolve(workspace, path), candidate))
    const excluded = input.scope.excludedPaths.some(path => contains(resolve(workspace, path), candidate))
    if (!allowed || excluded || candidate === workspace) fail('ARTIFACT_PATH_DENIED', 'Artifact is outside the recorded run scope or excluded')
    const internal = contains(workspace, candidate)
    if (!internal && !input.scope.externalPaths?.some(grant => grantContains(grant, candidate))) fail('ARTIFACT_PATH_DENIED', 'Artifact has no recorded external path grant')
    // An exact file grant never turns its parent directory into a read grant.
    return this.readArtifactRange(input, workspace, internal ? workspace : dirname(candidate), candidate)
  }
  private async readArtifactRange(input: ArtifactInput, workspace: string, root: string, candidate: string) {
    const offsetBytes = boundedInteger(input.offsetBytes ?? 0, 0, Number.MAX_SAFE_INTEGER, 'offsetBytes')
    const maxBytes = boundedInteger(input.maxBytes ?? MAX_ARTIFACT_BYTES, 1, MAX_ARTIFACT_BYTES, 'maxBytes')
    const components = relative(root, candidate).split(sep)
    const handles: FileHandle[] = []
    try {
      // Pin each Linux directory descriptor and prohibit symlinks at every step.
      if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) fail('ARTIFACT_PLATFORM_UNSUPPORTED', 'Safe descriptor-anchored artifact reads require Linux')
      let directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      handles.push(directory)
      if (await realpath('/proc/self/fd/' + directory.fd) !== root) fail('ARTIFACT_PATH_DENIED', 'Artifact root changed during resolution')
      for (const component of components.slice(0, -1)) {
        directory = await open('/proc/self/fd/' + directory.fd + '/' + component, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        handles.push(directory)
      }
      const file = await open('/proc/self/fd/' + directory.fd + '/' + components.at(-1)!, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      handles.push(file)
      const openedPath = await realpath('/proc/self/fd/' + file.fd)
      if (!contains(root, openedPath) || openedPath !== candidate) fail('ARTIFACT_PATH_DENIED', 'Artifact changed or escaped its scope during resolution')
      const before = await file.stat()
      if (!before.isFile()) fail('ARTIFACT_NOT_REGULAR', 'Artifact must be a regular file')
      if (before.size > MAX_ARTIFACT_FILE_BYTES) fail('ARTIFACT_TOO_LARGE', 'Artifact exceeds the 16 MiB file limit', { sizeBytes: before.size, maxFileBytes: MAX_ARTIFACT_FILE_BYTES })
      if (offsetBytes > before.size) fail('INVALID_ARGUMENT', 'offsetBytes exceeds the artifact size')
      const bytes = Buffer.alloc(Math.min(maxBytes, before.size - offsetBytes))
      let bytesRead = 0
      while (bytesRead < bytes.length) {
        const part = await file.read(bytes, bytesRead, bytes.length - bytesRead, offsetBytes + bytesRead)
        if (part.bytesRead === 0) break
        bytesRead += part.bytesRead
      }
      const after = await file.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await realpath('/proc/self/fd/' + file.fd) !== openedPath) fail('ARTIFACT_CHANGED', 'Artifact changed while being read; no content was returned')
      const nextOffsetBytes = offsetBytes + bytesRead
      return {
        reference: { workspace, path: contains(workspace, candidate) ? relative(workspace, candidate) : candidate, sizeBytes: before.size, modifiedAt: before.mtime.toISOString() },
        encoding: 'base64' as const, data: bytes.subarray(0, bytesRead).toString('base64'),
        offsetBytes, bytesRead, nextOffsetBytes: nextOffsetBytes < before.size ? nextOffsetBytes : null,
        eof: nextOffsetBytes >= before.size,
      }
    } catch (error) {
      if (error instanceof NativeControlError) throw error
      fail('ARTIFACT_READ_FAILED', 'Unable to safely open or read this project artifact', { fsCode: errorCode(error) ?? 'UNKNOWN' })
    } finally { await Promise.allSettled(handles.reverse().map(handle => handle.close())) }
  }
  private async assertKnownSession(sessionId: string): Promise<void> {
    const catalog = await this.options.gateway.listWorkspaces()
    if (!catalog.items.some(workspace => workspace.sessionIds.includes(sessionId))) fail('SESSION_NOT_REGISTERED', 'Session must belong to a known registered Harness workspace', { sessionId })
  }
  private async searchWorkspace(input: string): Promise<SearchWorkspace> {
    const catalog = await this.options.gateway.listWorkspaces()
    const registered = catalog.items.find(item => item.workspaceId === input || (isAbsolute(input) && item.path === input))
    if (registered === undefined) fail('WORKSPACE_DENIED', 'History search requires an exact registered workspace path or workspace ID')
    try {
      if (!isAbsolute(registered.path)) fail('WORKSPACE_DENIED', 'Registered workspace must have an absolute project path')
      const path = await realpath(registered.path)
      if (!(await stat(path)).isDirectory()) fail('WORKSPACE_DENIED', 'Registered workspace must be a project directory')
      if (this.options.allowedWorkspaceRoots.length > 0) {
        const roots = await Promise.all(this.options.allowedWorkspaceRoots.map(root => realpath(root)))
        if (!roots.some(root => contains(root, path))) fail('WORKSPACE_DENIED', 'Workspace is outside the configured project roots')
      }
      for (const sessionId of registered.sessionIds) validId(sessionId, 'registered sessionId')
      // Match public workspace discovery: omit stale, subagent and foreign-cwd
      // entries, but retain archived sessions for historical searches.
      const visible = await new SessionRoutingFacade(this.options.gateway).list(registered, catalog.archivedSessionIds)
      return { workspaceId: registered.workspaceId, path, sessionIds: visible.map(session => session.sessionId) }
    } catch (error) {
      if (error instanceof NativeControlError) throw error
      fail('WORKSPACE_DENIED', 'Unable to validate the registered workspace against current project roots')
    }
  }
  private async authorizedWorkspace(input: string): Promise<string> {
    validId(input, 'workspace', 4096)
    const catalog = await this.options.gateway.listWorkspaces()
    const registered = catalog.items.find(item => item.workspaceId === input)
    const path = registered?.path ?? input
    if (!isAbsolute(path)) fail('WORKSPACE_DENIED', 'Workspace must be a registered workspace ID or an absolute project directory')
    const workspace = await realpath(path)
    if (!(await stat(workspace)).isDirectory()) fail('WORKSPACE_DENIED', 'Workspace must be a project directory')
    if (this.options.allowedWorkspaceRoots.length > 0) {
      const roots = await Promise.all(this.options.allowedWorkspaceRoots.map(root => realpath(root)))
      if (!roots.some(root => contains(root, workspace))) fail('WORKSPACE_DENIED', 'Workspace is outside the configured project roots')
    } else {
      const registeredPaths = await Promise.all(catalog.items.map(item => realpath(item.path).catch(() => null)))
      if (!registeredPaths.includes(workspace)) fail('WORKSPACE_DENIED', 'Workspace is not registered in Harness')
    }
    return workspace
  }
  private async firstSnapshot(sessionId: string, maxMessages: number): Promise<Record<string, unknown>> {
    const abort = new AbortController()
    let iterator: AsyncIterator<unknown> | undefined
    try {
      const stream = await this.options.typert.stream({
        namespace: 'session', method: 'follow',
        args: { request: { address: { kind: 'session', sessionId }, maxMessages } }, signal: abort.signal,
      })
      iterator = stream[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done || !isRecord(first.value) || first.value.type !== 'snapshot') fail('NATIVE_API_INCOMPATIBLE', 'session.follow did not provide its opening snapshot')
      return first.value
    } catch (error) {
      if (error instanceof NativeControlError) throw error
      throw typertGatewayError('session.follow', error)
    } finally {
      abort.abort()
      await iterator?.return?.().catch(() => {})
    }
  }
  private async invoke(method: string, args: Record<string, unknown>): Promise<unknown> {
    try { return await this.options.typert.invoke({ namespace: 'session', method, args }) }
    catch (error) { throw typertGatewayError('session.' + method, error) }
  }
  private async readQueue(sessionId: string): Promise<QueueSnapshot> {
    const projection = await this.invoke('projections', { request: { sessionId } })
    if (projection === null) fail('SESSION_NOT_FOUND', 'Native session projection is absent', { sessionId })
    if (!isRecord(projection) || projection.kind !== 'sequenced' || !isRecord(projection.values)) fail('QUEUE_UNAVAILABLE', 'Native sequenced session projections are unavailable; migration or a newer native service may be required')
    const asOfSeq = boundedInteger(projection.asOfSeq, 0, Number.MAX_SAFE_INTEGER, 'projection cursor', 'NATIVE_API_INCOMPATIBLE')
    const inbox = projection.values.inbox
    if (!isRecord(inbox)) fail('QUEUE_UNAVAILABLE', 'The native Inbox projection is not available')
    return boundedJson({ sessionId, asOfSeq, nextTurn: queueItems(inbox['next-turn']), nextStep: queueItems(inbox['next-step']) })
  }
  private async removePending(sessionId: string, itemId: string): Promise<boolean> {
    try { await this.updateQueue(sessionId, itemId, 'remove'); return true }
    catch (error) {
      if (errorCode(error) === 'session/queue-item-not-found') return false
      throw error
    }
  }
  private async updateQueue(sessionId: string, itemId: string, kind: 'remove' | 'steer'): Promise<void> {
    try {
      const value = await this.options.typert.invoke({ namespace: 'session', method: 'updateQueue', args: { request: { sessionId, itemId, action: { kind } } } })
      if (!isRecord(value) || value.accepted !== true) throw new Error('Native queue update returned no acceptance receipt')
    } catch (error) {
      const code = errorCode(error)
      // Business rejection is explicit. Other failures may follow dispatch.
      if (code?.startsWith('session/') || code === 'gateway/method-unavailable' || code === 'gateway/lookup-not-found') throw typertGatewayError('session.updateQueue', error)
      fail('NATIVE_ACTION_UNCERTAIN', 'Native queue action has an unknown outcome; inspect queue/history before further action', { sessionId, itemId, action: kind, doNotReplay: true, nativeCode: code ?? 'UNKNOWN' })
    }
  }
}
function steeringReceipt(sessionId: string, itemId: string, replayedReceipt: boolean) {
  return { sessionId, itemId, status: 'steering-requested' as const, execution: 'current-turn-steering' as const, queuedExecution: false as const, replayedReceipt }
}
function queueItems(value: unknown): QueueItem[] {
  if (!Array.isArray(value) || value.some(item => !isRecord(item) || typeof item.id !== 'string' || item.id.length === 0 || !Array.isArray(item.content))) fail('NATIVE_API_INCOMPATIBLE', 'Native Inbox items lack their pending ID/content')
  return value as QueueItem[]
}
function queueIds(queue: QueueSnapshot): string[] { return [...new Set([...queue.nextTurn, ...queue.nextStep].map(item => item.id))] }
function boundedJson<T extends object>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_NATIVE_JSON_BYTES) fail('NATIVE_OUTPUT_TOO_LARGE', 'Native JSON exceeds the 512 KiB response limit; request a smaller history page or inspect native Harness', { maxJsonBytes: MAX_NATIVE_JSON_BYTES })
  return value
}
function encodeCursor(cursor: HistoryCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  return 'nh1.' + payload + '.' + createHash('sha256').update(payload).digest('base64url')
}
function decodeCursor(input: string, sessionId: string): HistoryCursor {
  try {
    if (input.length > 2048) throw new Error()
    const [prefix, payload, checksum, ...extra] = input.split('.')
    if (prefix !== 'nh1' || !payload || !checksum || extra.length !== 0 || !/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error()
    if (createHash('sha256').update(payload).digest('base64url') !== checksum) throw new Error()
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!isRecord(parsed) || Object.keys(parsed).sort().join(',') !== 'b,s,t,v' || parsed.v !== 1 || parsed.s !== sessionId) throw new Error()
    const t = boundedInteger(parsed.t, 0, Number.MAX_SAFE_INTEGER, 'cursor throughSeq')
    const b = boundedInteger(parsed.b, 1, t, 'cursor beforeSeq')
    const cursor: HistoryCursor = { v: 1, s: sessionId, t, b }
    if (encodeCursor(cursor) !== input) throw new Error()
    return cursor
  } catch { fail('INVALID_HISTORY_CURSOR', 'History cursor is malformed, out of bounds, or belongs to another session') }
}
function validId(value: unknown, name: string, max = 512): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0')) fail('INVALID_ARGUMENT', name + ' must be a nonempty bounded string')
}
function boundedInteger(value: unknown, min: number, max: number, name: string, code = 'INVALID_ARGUMENT'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(code, name + ' is out of bounds', { min, max })
  return value
}
function contains(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child))
}
function errorCode(error: unknown): string | undefined { return isRecord(error) && typeof error.code === 'string' ? error.code : undefined }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function fail(code: string, message: string, details: Record<string, unknown> = {}): never { throw new NativeControlError(code, message, details) }
