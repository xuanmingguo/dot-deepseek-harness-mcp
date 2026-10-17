import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, posix, win32 } from 'node:path'
import { TextDecoder } from 'node:util'
import { NativeControlError } from './errors.js'

export const MAX_PROJECT_TEXT_FILE_BYTES = 16 * 1024 * 1024
export const MAX_PROJECT_TEXT_BYTES = 32 * 1024
export const MAX_PROJECT_TEXT_OUTPUT_BYTES = 64 * 1024
export interface ProjectTextInput {
  workspace: string; path: string; startLine?: number | undefined; lineCount?: number | undefined
  tail?: boolean | undefined; expectedSha256?: string | undefined
}
export interface ProjectTextResult {
  reference: { workspace: string; path: string; sizeBytes: number; modifiedAt: string; sha256: string }
  encoding: 'utf-8'; sourceTrust: 'untrusted'; bom: boolean; totalLines: number
  startLine: number; endLine: number | null; lines: { lineNumber: number; text: string }[]
  hasMore: boolean; nextStartLine: number | null; hasEarlier: boolean; outputLimited: boolean
}
interface Pinned { handle: FileHandle; path: string; identity: string }
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const denied = () => fail('PROJECT_TEXT_PATH_DENIED', 'Project text path must stay inside the authorized workspace without symlinks or traversal')
const changed = () => fail('PROJECT_TEXT_CHANGED', 'Project text changed; no content was returned. Start a fresh read or verify the expected SHA-256')

/** Read one bounded regular file through pinned Linux descriptors; text is data, never authority. */
export async function readProjectText(input: ProjectTextInput, authorize: (workspace: string) => Promise<string>): Promise<ProjectTextResult> {
  const path = normalizePath(input.path)
  const startLine = input.startLine === undefined ? 1 : input.startLine
  const lineCount = input.lineCount === undefined ? 100 : input.lineCount
  const tail = input.tail === undefined ? false : input.tail
  if (typeof input.workspace !== 'string' || input.workspace.length < 1 || input.workspace.length > 4096 || input.workspace.includes('\0') ||
    !Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > 200 || typeof tail !== 'boolean' ||
    (tail && input.startLine !== undefined) || (input.expectedSha256 !== undefined && (typeof input.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedSha256)))) {
    fail('INVALID_ARGUMENT', 'Project text workspace, line range, tail or expectedSha256 is invalid; tail cannot include startLine')
  }
  const handles: Pinned[] = []
  try {
    const workspace = await authorize(input.workspace)
    if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) fail('PROJECT_TEXT_PLATFORM_UNSUPPORTED', 'Safe descriptor-anchored project text reads require Linux')
    const components = path === '.' ? [] : path.split('/')
    let expected = workspace
    let parent: FileHandle | undefined
    for (let index = -1; index < components.length; index++) {
      const component = components[index]
      const location = parent === undefined ? workspace : '/proc/self/fd/' + parent.fd + '/' + component
      if (component !== undefined) expected = posix.join(expected, component)
      const directory = index === -1 || index < components.length - 1
      let handle: FileHandle
      try { handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)) }
      catch (error) {
        if (fsCode(error) === 'ELOOP' || fsCode(error) === 'ENOTDIR') denied()
        if (!directory && fsCode(error) === 'ENXIO') fail('PROJECT_TEXT_NOT_REGULAR', 'Project text must be a regular file')
        throw error
      }
      const pinned = { handle, path: expected, identity: '' }
      handles.push(pinned)
      if (await realpath('/proc/self/fd/' + handle.fd) !== expected) changed()
      const metadata = await handle.stat({ bigint: true })
      pinned.identity = identity(metadata)
      parent = handle
    }
    const file = handles.at(-1)!.handle
    const before = await file.stat({ bigint: true })
    if (!before.isFile()) fail('PROJECT_TEXT_NOT_REGULAR', 'Project text must be a regular file')
    if (before.size > BigInt(MAX_PROJECT_TEXT_FILE_BYTES)) fail('PROJECT_TEXT_TOO_LARGE', 'Project text exceeds the 16 MiB file limit; use read_artifact')
    const sizeBytes = Number(before.size)
    // One extra byte detects growth without an unbounded read or allocation.
    const storage = Buffer.alloc(sizeBytes + 1)
    let bytesRead = 0
    while (bytesRead < storage.length) {
      const part = await file.read(storage, bytesRead, storage.length - bytesRead, bytesRead)
      if (part.bytesRead === 0) break
      bytesRead += part.bytesRead
    }
    if (bytesRead !== sizeBytes) changed()
    const raw = storage.subarray(0, bytesRead)
    const sha256 = createHash('sha256').update(raw).digest('hex')
    await verify(handles)
    if (input.expectedSha256 !== undefined && input.expectedSha256 !== sha256) changed()
    if (raw.includes(0)) invalidText()
    try { decoder.decode(raw) } catch { invalidText() }
    const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
    const bytes = raw.subarray(bom ? 3 : 0)
    let totalLines = bytes.length > 0 && bytes.at(-1) !== 10 ? 1 : 0
    for (let offset = bytes.indexOf(10); offset !== -1; offset = bytes.indexOf(10, offset + 1)) totalLines++
    const effectiveStart = tail ? Math.max(1, totalLines - lineCount + 1) : startLine
    if (effectiveStart > totalLines + 1) fail('INVALID_ARGUMENT', 'startLine exceeds the project text EOF line')
    const result: ProjectTextResult = {
      reference: { workspace, path, sizeBytes, modifiedAt: new Date(Number(before.mtimeMs)).toISOString(), sha256 },
      encoding: 'utf-8', sourceTrust: 'untrusted', bom, totalLines, startLine: effectiveStart, endLine: null,
      lines: [], hasMore: effectiveStart <= totalLines, nextStartLine: effectiveStart <= totalLines ? effectiveStart : null,
      hasEarlier: effectiveStart > 1 && totalLines > 0, outputLimited: false,
    }
    let textBytes = 0
    let lineNumber = 1
    let offset = 0
    const lastSelected = Math.min(totalLines, effectiveStart + lineCount - 1)
    while (lineNumber <= lastSelected) {
      const newline = bytes.indexOf(10, offset)
      const end = newline === -1 ? bytes.length : newline
      // Only CR immediately followed by LF is a line terminator.
      const contentEnd = newline !== -1 && end > offset && bytes[end - 1] === 13 ? end - 1 : end
      if (lineNumber >= effectiveStart) {
        const length = contentEnd - offset
        let limited = textBytes + length > MAX_PROJECT_TEXT_BYTES
        if (!limited) {
          const line = { lineNumber, text: decoder.decode(bytes.subarray(offset, contentEnd)) }
          result.lines.push(line)
          updateRange(result, lineNumber + 1)
          limited = Buffer.byteLength(JSON.stringify(result)) > MAX_PROJECT_TEXT_OUTPUT_BYTES
          if (limited) result.lines.pop()
        }
        if (limited) {
          if (tail) outputTooLarge()
          if (result.lines.length === 0) fail('PROJECT_TEXT_LINE_TOO_LONG', 'The first selected line exceeds the text output limit; use read_artifact')
          result.outputLimited = true
          updateRange(result, lineNumber)
          break
        }
        textBytes += length
      }
      offset = end + 1
      lineNumber++
    }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_PROJECT_TEXT_OUTPUT_BYTES) outputTooLarge()
    await verify(handles)
    return result
  } catch (error) {
    if (error instanceof NativeControlError) throw error
    fail('PROJECT_TEXT_READ_FAILED', 'Unable to safely open or read this project text', { fsCode: fsCode(error) })
  } finally { await Promise.allSettled(handles.reverse().map(pinned => pinned.handle.close())) }
}
function updateRange(result: ProjectTextResult, next: number): void {
  result.endLine = result.lines.at(-1)?.lineNumber ?? null
  result.hasMore = next <= result.totalLines
  result.nextStartLine = result.hasMore ? next : null
}
async function verify(handles: Pinned[]): Promise<void> {
  for (const pinned of handles) {
    try {
      if (await realpath('/proc/self/fd/' + pinned.handle.fd) !== pinned.path || identity(await pinned.handle.stat({ bigint: true })) !== pinned.identity) changed()
    } catch { changed() }
  }
}
function normalizePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) fail('INVALID_ARGUMENT', 'Project text path must be a nonempty bounded string without NUL')
  if (isAbsolute(value) || win32.isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) denied()
  return posix.normalize(value).replace(/\/$/, '') || '.'
}
function identity(value: BigIntStats): string { return [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].join(':') }
function fsCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return typeof code === 'string' && ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EIO', 'EMFILE', 'ENFILE', 'ENAMETOOLONG', 'EINVAL', 'EBUSY', 'ESTALE', 'EBADF', 'ENXIO'].includes(code) ? code : 'UNKNOWN'
}
function invalidText(): never { return fail('PROJECT_TEXT_NOT_UTF8', 'Project text must be valid UTF-8 without NUL bytes; use read_artifact') }
function outputTooLarge(): never { return fail('PROJECT_TEXT_OUTPUT_TOO_LARGE', 'Requested project text exceeds the output byte limit; use a smaller lineCount or read_artifact') }
function fail(code: string, message: string, details?: Record<string, unknown>): never { throw new NativeControlError(code, message, details) }
