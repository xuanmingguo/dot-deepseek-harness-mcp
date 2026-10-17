import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, posix, win32 } from 'node:path'
import { TextDecoder } from 'node:util'
import { NativeControlError } from './errors.js'

export const PROJECT_SEARCH_LIMITS = Object.freeze({
  entries: 2000, files: 500, fileBytes: 1024 * 1024, bytes: 16 * 1024 * 1024,
  filenameBytes: 512 * 1024, outputBytes: 64 * 1024,
} as const)
export const PROJECT_SEARCH_EXCLUDED_DIRECTORIES = ['.git', 'node_modules', 'dist', 'build', 'coverage'] as const
export interface ProjectSearchInput {
  workspace: string; query: string; path?: string | undefined; caseSensitive?: boolean | undefined
  includeHidden?: boolean | undefined; maxDepth?: number | undefined; maxResults?: number | undefined
}
export interface ProjectSearchMatch { path: string; lineNumber: number; text: string; excerptStart: number; truncated: boolean; sha256: string }
type IncompleteReason = 'entry_limit' | 'file_limit' | 'byte_limit' | 'filename_bytes_limit' | 'depth_limit' | 'oversized' | 'invalid_text'
export interface ProjectSearchResult {
  workspace: string; path: string; query: string; caseSensitive: boolean; includeHidden: boolean; maxDepth: number; maxResults: number
  matches: ProjectSearchMatch[]; matchedLines: number; matchedFiles: number; filesConsidered: number; filesSearched: number
  entriesScanned: number; bytesRead: number; scanComplete: boolean; incompleteReasons: IncompleteReason[]
  resultsTruncated: boolean; lastScannedPath: string | null; excludedDirectoryNames: string[]
  skippedEntries: { hidden: number; excludedDirectories: number; symlinks: number; special: number }
  skippedFiles: { oversized: number; invalidText: number }; depthLimitedDirectories: number
  order: 'path-line'; sourceTrust: 'untrusted'
}
interface Pinned { handle: FileHandle; path: string; identity: string }
interface Entry { name: string; kind: 'directory' | 'file' | 'symlink' | 'special' }
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const denied = () => fail('PROJECT_SEARCH_PATH_DENIED', 'Project search path must stay inside the authorized workspace without symlinks or traversal')
const changed = () => fail('PROJECT_SEARCH_CHANGED', 'Project search inputs changed during the scan; no content was returned. Start a fresh search')

/** Bounded lexical DFS over descriptor-pinned directories; source text never grants authority. */
export async function searchProjectText(input: ProjectSearchInput, authorize: (workspace: string) => Promise<string>): Promise<ProjectSearchResult> {
  const path = normalizePath(input.path === undefined ? '.' : input.path)
  const caseSensitive = input.caseSensitive === undefined ? false : input.caseSensitive
  const includeHidden = input.includeHidden === undefined ? false : input.includeHidden
  const maxDepth = input.maxDepth === undefined ? 4 : input.maxDepth
  const maxResults = input.maxResults === undefined ? 20 : input.maxResults
  if (typeof input.workspace !== 'string' || input.workspace.length < 1 || input.workspace.length > 4096 || input.workspace.includes('\0') ||
    typeof input.query !== 'string' || input.query.length < 1 || input.query.length > 1024 || /[\r\n\0]/u.test(input.query) ||
    codepoints(input.query) > 256 || typeof caseSensitive !== 'boolean' || typeof includeHidden !== 'boolean' ||
    !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 8 || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100) {
    fail('INVALID_ARGUMENT', 'Project search requires a single-line literal query of 1-256 Unicode characters and valid bounded options')
  }
  const query = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'u' : 'iu')
  const handles: Pinned[] = []
  try {
    const workspace = await authorize(input.workspace)
    if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) fail('PROJECT_SEARCH_PLATFORM_UNSUPPORTED', 'Safe descriptor-anchored project search requires Linux')
    const result: ProjectSearchResult = {
      workspace, path, query: input.query, caseSensitive, includeHidden, maxDepth, maxResults,
      matches: [], matchedLines: 0, matchedFiles: 0, filesConsidered: 0, filesSearched: 0, entriesScanned: 0, bytesRead: 0,
      scanComplete: true, incompleteReasons: [], resultsTruncated: false, lastScannedPath: null,
      excludedDirectoryNames: [...PROJECT_SEARCH_EXCLUDED_DIRECTORIES],
      skippedEntries: { hidden: 0, excludedDirectories: 0, symlinks: 0, special: 0 },
      skippedFiles: { oversized: 0, invalidText: 0 }, depthLimitedDirectories: 0, order: 'path-line', sourceTrust: 'untrusted',
    }
    let filenameBytes = 0
    let stopped = false
    let outputStopped = false
    let matchBytes = 0
    const incomplete = (reason: IncompleteReason) => {
      result.scanComplete = false
      if (!result.incompleteReasons.includes(reason)) result.incompleteReasons.push(reason)
    }
    const pin = async (location: string, expected: string, directory: boolean, selected = false): Promise<Pinned> => {
      let handle: FileHandle
      try { handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)) }
      catch (error) {
        if (selected && ['ELOOP', 'ENOTDIR'].includes(fsCode(error))) denied()
        if (!selected && ['ELOOP', 'ENOTDIR', 'ENOENT', 'ENXIO'].includes(fsCode(error))) changed()
        throw error
      }
      const pinned = { handle, path: expected, identity: '' }
      handles.push(pinned)
      if (await realpath('/proc/self/fd/' + handle.fd) !== expected) changed()
      const metadata = await handle.stat({ bigint: true })
      if (directory ? !metadata.isDirectory() : !metadata.isFile()) changed()
      pinned.identity = identity(metadata)
      return pinned
    }
    const release = async (pinned: Pinned) => {
      await verify(handles)
      await pinned.handle.close()
      handles.pop()
    }
    let selected: Pinned | undefined
    let expected = workspace
    for (const component of ['', ...(path === '.' ? [] : path.split('/'))]) {
      if (component) expected = posix.join(expected, component)
      selected = await pin(selected ? '/proc/self/fd/' + selected.handle.fd + '/' + component : workspace, expected, true, true)
    }
    const searchFile = async (directory: Pinned, relative: string, name: string) => {
      if (result.filesConsidered >= PROJECT_SEARCH_LIMITS.files) { incomplete('file_limit'); stopped = true; return }
      result.filesConsidered++
      result.lastScannedPath = relative
      const file = await pin('/proc/self/fd/' + directory.handle.fd + '/' + name, posix.join(workspace, relative), false)
      try {
        const before = await file.handle.stat({ bigint: true })
        if (before.size > BigInt(PROJECT_SEARCH_LIMITS.fileBytes)) { result.skippedFiles.oversized++; incomplete('oversized'); return }
        const size = Number(before.size)
        const remaining = PROJECT_SEARCH_LIMITS.bytes - result.bytesRead
        if (size > remaining || remaining === 0) { incomplete('byte_limit'); stopped = true; return }
        const storage = Buffer.alloc(size + 1)
        let read = 0
        while (read < storage.length && result.bytesRead < PROJECT_SEARCH_LIMITS.bytes) {
          const part = await file.handle.read(storage, read, Math.min(storage.length - read, PROJECT_SEARCH_LIMITS.bytes - result.bytesRead), read)
          read += part.bytesRead
          result.bytesRead += part.bytesRead
          if (!part.bytesRead) break
        }
        if (read !== size) changed()
        await verify(handles)
        const raw = storage.subarray(0, read)
        let text: string
        try {
          if (raw.includes(0)) throw new Error()
          text = decoder.decode(raw)
        } catch { result.skippedFiles.invalidText++; incomplete('invalid_text'); return }
        const sha256 = createHash('sha256').update(raw).digest('hex')
        if (text.startsWith('\ufeff')) text = text.slice(1)
        result.filesSearched++
        let offset = 0
        let lineNumber = 1
        let hits = false
        while (offset < text.length) {
          const newline = text.indexOf('\n', offset)
          const end = newline === -1 ? text.length : newline
          const contentEnd = newline !== -1 && end > offset && text[end - 1] === '\r' ? end - 1 : end
          const line = text.slice(offset, contentEnd)
          const hit = query.exec(line)
          if (hit !== null) {
            result.matchedLines++
            hits = true
            if (!outputStopped && result.matches.length < maxResults) {
              const match = { path: relative, lineNumber, ...excerpt(line, hit.index, hit[0].length), sha256 }
              const length = Buffer.byteLength(JSON.stringify(match)) + 1
              // Keep bounded match accumulation, leaving room for all final counters and input metadata.
              if (matchBytes + length <= PROJECT_SEARCH_LIMITS.outputBytes - 24 * 1024) {
                result.matches.push(match)
                matchBytes += length
              } else { outputStopped = true; result.resultsTruncated = true }
            } else result.resultsTruncated = true
          }
          offset = end + 1
          lineNumber++
        }
        if (hits) result.matchedFiles++
      } finally {
        await release(file)
        if (result.bytesRead >= PROJECT_SEARCH_LIMITS.bytes) { incomplete('byte_limit'); stopped = true }
        if (result.filesConsidered >= PROJECT_SEARCH_LIMITS.files) { incomplete('file_limit'); stopped = true }
      }
    }
    const walk = async (directory: Pinned, relative: string, depth: number): Promise<void> => {
      const entries: Entry[] = []
      let inventoryComplete = true
      const stream = await opendir('/proc/self/fd/' + directory.handle.fd, { encoding: 'buffer' as BufferEncoding, bufferSize: 1 })
      try {
        for (;;) {
          if (result.entriesScanned >= PROJECT_SEARCH_LIMITS.entries) { incomplete('entry_limit'); stopped = true; inventoryComplete = false; break }
          const entry = await stream.read()
          if (entry === null) break
          result.entriesScanned++
          const raw: unknown = entry.name
          if (!Buffer.isBuffer(raw)) unsupportedFilename()
          if (filenameBytes + raw.length > PROJECT_SEARCH_LIMITS.filenameBytes) { incomplete('filename_bytes_limit'); stopped = true; inventoryComplete = false; break }
          filenameBytes += raw.length
          let name: string
          try { name = decoder.decode(raw) } catch { unsupportedFilename() }
          if (name.includes('\0')) unsupportedFilename()
          entries.push({ name, kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'special' })
          if (filenameBytes === PROJECT_SEARCH_LIMITS.filenameBytes) { incomplete('filename_bytes_limit'); stopped = true; inventoryComplete = false; break }
        }
      } finally { await stream.close() }
      await verify(handles)
      if (!inventoryComplete) return
      entries.sort((a, b) => compare(a.name, b.name))
      for (const entry of entries) {
        if (stopped) break
        const child = relative === '.' ? entry.name : relative + '/' + entry.name
        if (entry.kind === 'directory' && (PROJECT_SEARCH_EXCLUDED_DIRECTORIES as readonly string[]).includes(entry.name)) { result.skippedEntries.excludedDirectories++; continue }
        if (!includeHidden && entry.name.startsWith('.')) { result.skippedEntries.hidden++; continue }
        if (entry.kind === 'symlink') { result.skippedEntries.symlinks++; continue }
        if (entry.kind === 'special') { result.skippedEntries.special++; continue }
        if (entry.kind === 'directory') {
          if (depth === maxDepth) { result.depthLimitedDirectories++; incomplete('depth_limit'); continue }
          const childDirectory = await pin('/proc/self/fd/' + directory.handle.fd + '/' + entry.name, posix.join(workspace, child), true)
          try { await walk(childDirectory, child, depth + 1) } finally { await release(childDirectory) }
        } else await searchFile(directory, child, entry.name)
      }
      await verify(handles)
    }
    await walk(selected!, path, 0)
    await verify(handles)
    // JSON escaping can amplify bounded input strings; retain a valid final envelope even then.
    while (Buffer.byteLength(JSON.stringify(result)) > PROJECT_SEARCH_LIMITS.outputBytes && result.matches.length > 0) {
      result.matches.pop()
      result.resultsTruncated = true
    }
    if (Buffer.byteLength(JSON.stringify(result)) > PROJECT_SEARCH_LIMITS.outputBytes) fail('INVALID_ARGUMENT', 'Project search input metadata exceeds the output limit; use a shorter path or workspace')
    result.matches.sort((a, b) => compare(a.path, b.path) || a.lineNumber - b.lineNumber)
    return result
  } catch (error) {
    if (error instanceof NativeControlError) throw error
    fail('PROJECT_SEARCH_READ_FAILED', 'Unable to safely open or search this project directory', { fsCode: fsCode(error) })
  } finally { await Promise.allSettled(handles.reverse().map(pinned => pinned.handle.close())) }
}
function excerpt(line: string, index: number, matchLength: number): { text: string; excerptStart: number; truncated: boolean } {
  // Walk bounded source strings without allocating one array element per codepoint.
  let matchStart = 0
  let matched = 0
  let total = 0
  let utf16 = 0
  for (const char of line) {
    if (utf16 < index) matchStart++
    if (utf16 >= index && utf16 < index + matchLength) matched++
    utf16 += char.length
    total++
  }
  const start = Math.max(0, Math.min(matchStart - 80, total - 600))
  const end = Math.min(total, Math.max(start + 600, matchStart + matched))
  let beginOffset = 0
  let endOffset = line.length
  let count = 0
  utf16 = 0
  for (const char of line) {
    if (count === start) beginOffset = utf16
    if (count === end) { endOffset = utf16; break }
    count++
    utf16 += char.length
  }
  return { text: line.slice(beginOffset, endOffset), excerptStart: start, truncated: start > 0 || end < total }
}
function codepoints(value: string): number { let length = 0; for (const _ of value) length++; return length }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
async function verify(handles: Pinned[]): Promise<void> {
  for (const pinned of handles) {
    try {
      if (await realpath('/proc/self/fd/' + pinned.handle.fd) !== pinned.path || identity(await pinned.handle.stat({ bigint: true })) !== pinned.identity) changed()
    } catch (error) {
      if (error instanceof NativeControlError) throw error
      if (['ENOENT', 'ENOTDIR', 'ESTALE', 'EBADF'].includes(fsCode(error))) changed()
      throw error
    }
  }
}
function identity(value: BigIntStats): string { return [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].join(':') }
function normalizePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) fail('INVALID_ARGUMENT', 'Project search path must be a nonempty bounded string without NUL')
  if (isAbsolute(value) || win32.isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) denied()
  return posix.normalize(value).replace(/\/$/, '') || '.'
}
function fsCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return typeof code === 'string' && ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EIO', 'EMFILE', 'ENFILE', 'ENAMETOOLONG', 'EINVAL', 'EBUSY', 'ESTALE', 'EBADF', 'ENXIO'].includes(code) ? code : 'UNKNOWN'
}
function unsupportedFilename(): never { return fail('PROJECT_SEARCH_FILENAME_UNSUPPORTED', 'Project search encountered a filename that cannot be safely represented as UTF-8') }
function fail(code: string, message: string, details?: Record<string, unknown>): never { throw new NativeControlError(code, message, details) }
