import { NativeControlError } from './errors.js'
import { historyText } from './history-text.js'
import type { NativeHistoryRecord } from './native-control-facade.js'
import type { SearchWorkspace } from './history-search.js'

export interface HistoryContextInput {
  workspace: string
  sessionId: string
  anchorSeq: number
  throughSeq: number
  beforeMessages?: number | undefined
  maxMessageChars?: number | undefined
}
export interface HistoryContextTextBlock { textBlockIndex: number; text: string; textLength: number; truncated: boolean }
export interface HistoryContextMessage {
  role: 'user' | 'assistant'
  eventType: 'user/message' | 'assistant/message'
  seq: number
  time?: string | number
  textBlocks: HistoryContextTextBlock[]
  textLength: number
  omittedTextBlocks: number
  messageTruncated: boolean
}
export interface HistoryContextResult {
  workspace: string
  workspaceId: string
  sessionId: string
  anchorSeq: number
  throughSeq: number
  beforeMessages: number
  returnedBeforeMessages: number
  maxMessageChars: number
  messages: HistoryContextMessage[]
  pagesRead: number
  recordsScanned: number
  hasEarlier: boolean
  contextComplete: true
  sourceTrust: 'untrusted'
  order: 'oldest-first'
}
interface ContextPorts {
  workspace(input: string): Promise<SearchWorkspace>
  page(request: { address: { kind: 'session'; sessionId: string }; throughSeq: number; beforeSeq?: number; maxMessages: 10 }): Promise<unknown>
}
const MAX_PAGE_BYTES = 512 * 1024

/** Seek the exact source position directly, then scan only its earlier prefix. */
export async function readSessionContext(input: HistoryContextInput, ports: ContextPorts): Promise<HistoryContextResult> {
  boundedString(input.workspace, 'workspace', 4096)
  boundedString(input.sessionId, 'sessionId', 512)
  const anchorSeq = integer(input.anchorSeq, 0, Number.MAX_SAFE_INTEGER, 'anchorSeq')
  const throughSeq = integer(input.throughSeq, anchorSeq, Number.MAX_SAFE_INTEGER, 'throughSeq')
  const beforeMessages = integer(input.beforeMessages ?? 2, 0, 10, 'beforeMessages')
  const maxMessageChars = integer(input.maxMessageChars ?? 2000, 1, 4000, 'maxMessageChars')
  const scope = await ports.workspace(input.workspace)
  if (!scope.sessionIds.includes(input.sessionId)) fail('SESSION_NOT_REGISTERED', 'Session must belong to the selected registered workspace')
  let beforeSeq = anchorSeq < throughSeq ? anchorSeq + 1 : undefined
  let pagesRead = 0
  let recordsScanned = 0
  const messages: HistoryContextMessage[] = []
  let hasEarlier = false
  while (pagesRead < 5) {
    const raw = await ports.page({ address: { kind: 'session', sessionId: input.sessionId }, throughSeq, ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages: 10 })
    pagesRead += 1
    const page = validatePage(raw, throughSeq, beforeSeq)
    if (pagesRead === 1) {
      const anchor = page.records.find(record => record.event.seq === anchorSeq)
      if (anchor === undefined) fail('CONTEXT_ANCHOR_NOT_FOUND', 'The exact anchor event is absent from the native history page')
      if (contextMessage(anchor, maxMessageChars) === null) fail('CONTEXT_ANCHOR_NOT_TEXT', 'The exact anchor event is not eligible user or assistant text')
    }
    for (let index = page.records.length - 1; index >= 0; index -= 1) {
      const record = page.records[index]!
      recordsScanned += 1
      const message = contextMessage(record, maxMessageChars)
      if (message !== null) messages.push(message)
      hasEarlier = index > 0 || page.hasMore
      if (messages.length === beforeMessages + 1) return result()
    }
    if (!page.hasMore) return result()
    beforeSeq = page.records[0]!.event.seq
  }
  fail('CONTEXT_SCAN_LIMIT', 'The requested earlier text window could not be established within five native pages')

  function result(): HistoryContextResult {
    return {
      workspace: scope.path, workspaceId: scope.workspaceId, sessionId: input.sessionId, anchorSeq, throughSeq,
      beforeMessages, returnedBeforeMessages: messages.length - 1, maxMessageChars, messages: messages.reverse(),
      pagesRead, recordsScanned, hasEarlier, contextComplete: true, sourceTrust: 'untrusted', order: 'oldest-first',
    }
  }
}
function validatePage(raw: unknown, throughSeq: number, beforeSeq: number | undefined): { records: NativeHistoryRecord[]; hasMore: boolean } {
  try {
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_PAGE_BYTES) fail('CONTEXT_OUTPUT_TOO_LARGE', 'Native context page exceeds the 512 KiB limit')
  } catch (error) {
    if (error instanceof NativeControlError) throw error
    fail('CONTEXT_NATIVE_API_INCOMPATIBLE', 'Native context page cannot be represented as JSON')
  }
  if (!isRecord(raw) || !Array.isArray(raw.records) || typeof raw.hasMore !== 'boolean') fail('CONTEXT_NATIVE_API_INCOMPATIBLE', 'Native context page is not a records page')
  let previous = -1
  for (const record of raw.records) {
    if (!isRecord(record) || record.type !== 'event' || !isRecord(record.event) || typeof record.event.type !== 'string' || record.event.type.length === 0) fail('CONTEXT_NATIVE_API_INCOMPATIBLE', 'Native context page contains an unsupported event shape')
    const seq = record.event.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seq > throughSeq || seq <= previous || (beforeSeq !== undefined && seq >= beforeSeq)) fail('CONTEXT_NATIVE_API_INCOMPATIBLE', 'Native context page order or position bounds are invalid')
    previous = seq
  }
  const records = raw.records as NativeHistoryRecord[]
  if (raw.hasMore && (records.length === 0 || records[0]!.event.seq === 0)) fail('CONTEXT_NATIVE_API_INCOMPATIBLE', 'Native context page cannot advance its earlier position')
  return { records, hasMore: raw.hasMore }
}
function contextMessage(record: NativeHistoryRecord, maxMessageChars: number): HistoryContextMessage | null {
  const extracted = historyText(record)
  if (extracted === null) return null
  const original = extracted.blocks.flatMap((text, textBlockIndex) => text === null || text.length === 0 ? [] : [{ textBlockIndex, characters: Array.from(text) }])
  if (original.length === 0) return null
  const textBlocks: HistoryContextTextBlock[] = []
  let remaining = maxMessageChars
  for (const block of original) {
    if (remaining === 0 || textBlocks.length === 10) break
    const text = block.characters.slice(0, remaining).join('')
    textBlocks.push({ textBlockIndex: block.textBlockIndex, text, textLength: block.characters.length, truncated: block.characters.length > remaining })
    remaining -= Math.min(remaining, block.characters.length)
  }
  const omittedTextBlocks = original.length - textBlocks.length
  const time = record.event.time
  return {
    role: extracted.role, eventType: extracted.eventType, seq: record.event.seq,
    ...(typeof time === 'string' || (typeof time === 'number' && Number.isFinite(time)) ? { time } : {}),
    textBlocks, textLength: original.reduce((total, block) => total + block.characters.length, 0), omittedTextBlocks,
    messageTruncated: omittedTextBlocks > 0 || textBlocks.some(block => block.truncated),
  }
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
