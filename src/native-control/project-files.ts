import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, posix, win32 } from 'node:path'
import { TextDecoder } from 'node:util'
import { NativeControlError } from './errors.js'

export const MAX_PROJECT_DIRECTORY_ENTRIES = 2000
export const MAX_PROJECT_FILES_BYTES = 512 * 1024
export interface ProjectFilesInput {
  workspace: string
  path?: string | undefined
  limit?: number | undefined
  includeHidden?: boolean | undefined
  cursor?: string | undefined
}
export interface ProjectFileEntry { name: string; path: string; kind: 'file' | 'directory' | 'symlink' | 'other' }
export interface ProjectFilesResult {
  workspace: string; path: string; includeHidden: boolean; entries: ProjectFileEntry[]
  totalEntries: number; scannedEntries: number; hasMore: boolean; nextCursor: string | null
  order: 'name-lexical'; sourceTrust: 'untrusted'
}
interface Cursor { v: 1; w: string; p: string; h: boolean; d: string; o: number; n: string }
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const denied = () => fail('PROJECT_PATH_DENIED', 'Project path must name a directory inside the authorized workspace without symlink components')
const changed = () => fail('PROJECT_DIRECTORY_CHANGED', 'Project directory changed; start a fresh listing without a cursor')

/** Names are untrusted data. Cursors are checksummed data, never authorization. */
export async function listProjectFiles(input: ProjectFilesInput, authorize: (workspace: string) => Promise<string>): Promise<ProjectFilesResult> {
  const path = normalizePath(input.path ?? '.')
  const limit = input.limit ?? 50
  const includeHidden = input.includeHidden ?? false
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof includeHidden !== 'boolean') fail('INVALID_ARGUMENT', 'Project file listing limits or filters are invalid')
  const handles: { handle: FileHandle; path: string; identity: string }[] = []
  try {
    const workspace = await authorize(input.workspace)
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor, workspace, path, includeHidden)
    if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) fail('PROJECT_FILES_PLATFORM_UNSUPPORTED', 'Safe descriptor-anchored project listing requires Linux')
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    let expected = workspace
    let directory: FileHandle | undefined
    for (const component of ['', ...(path === '.' ? [] : path.split('/'))]) {
      const location = directory === undefined ? workspace : '/proc/self/fd/' + directory.fd + '/' + component
      if (component) expected = posix.join(expected, component)
      let handle: FileHandle
      try { handle = await open(location, flags) }
      catch (error) {
        if (fsCode(error) === 'ELOOP' || fsCode(error) === 'ENOTDIR') denied()
        throw error
      }
      // Register immediately, including before a failed validation, to close every descriptor.
      const pinned = { handle, path: expected, identity: '' }
      handles.push(pinned)
      if (await realpath('/proc/self/fd/' + handle.fd) !== expected) changed()
      pinned.identity = identity(await handle.stat({ bigint: true }))
      directory = handle
    }
    const entries: ProjectFileEntry[] = []
    let filenameBytes = 0
    // Linux Node 22 supports raw names, although Node's declaration omits this encoding.
    const stream = await opendir('/proc/self/fd/' + directory!.fd, { encoding: 'buffer' as BufferEncoding, bufferSize: 1 })
    try {
      for (;;) {
        const entry = await stream.read()
        if (entry === null) break
        if (entries.length === MAX_PROJECT_DIRECTORY_ENTRIES) fail('PROJECT_DIRECTORY_TOO_LARGE', 'Project directory exceeds the 2000-entry scan limit; no listing was returned')
        // Node's opendir declaration retains string names even for encoding: buffer.
        const raw: unknown = entry.name
        if (!Buffer.isBuffer(raw)) fail('PROJECT_FILENAME_UNSUPPORTED', 'Project directory contains a filename that cannot be safely represented')
        filenameBytes += raw.length
        if (filenameBytes > MAX_PROJECT_FILES_BYTES) outputTooLarge()
        let name: string
        try { name = decoder.decode(raw) }
        catch { fail('PROJECT_FILENAME_UNSUPPORTED', 'Project directory contains a filename that cannot be safely represented') }
        const kind = entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
        entries.push({ name, path: path === '.' ? name : path + '/' + name, kind })
      }
    } finally { await stream.close() }
    // Check every pinned namespace component after enumeration. Metadata remains private.
    for (const pinned of handles) {
      try {
        if (await realpath('/proc/self/fd/' + pinned.handle.fd) !== pinned.path || identity(await pinned.handle.stat({ bigint: true })) !== pinned.identity) changed()
      } catch (error) {
        if (error instanceof NativeControlError) throw error
        changed()
      }
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const digest = hash(JSON.stringify([handles.at(-1)!.identity, entries.map(entry => [entry.name, entry.kind])]))
    if (cursor !== undefined && cursor.d !== digest) changed()
    const visible = includeHidden ? entries : entries.filter(entry => !entry.name.startsWith('.'))
    const offset = cursor?.o ?? 0
    if (cursor !== undefined && (offset >= visible.length || visible[offset - 1]?.name !== cursor.n)) invalidCursor()
    const page = visible.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    const hasMore = nextOffset < visible.length
    const result: ProjectFilesResult = {
      workspace, path, includeHidden, entries: page, totalEntries: visible.length, scannedEntries: entries.length, hasMore,
      nextCursor: hasMore ? encodeCursor({ v: 1, w: workspace, p: path, h: includeHidden, d: digest, o: nextOffset, n: page.at(-1)!.name }) : null,
      order: 'name-lexical', sourceTrust: 'untrusted',
    }
    if ((result.nextCursor !== null && result.nextCursor.length > 16000) || Buffer.byteLength(JSON.stringify(result)) > MAX_PROJECT_FILES_BYTES) outputTooLarge()
    return result
  } catch (error) {
    if (error instanceof NativeControlError) throw error
    fail('PROJECT_FILES_READ_FAILED', 'Unable to safely open or list this project directory', { fsCode: fsCode(error) })
  } finally { await Promise.allSettled(handles.reverse().map(pinned => pinned.handle.close())) }
}
function normalizePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) fail('INVALID_ARGUMENT', 'Project path must be a nonempty bounded string')
  if (isAbsolute(value) || win32.isAbsolute(value) || value.split('/').includes('..')) denied()
  const normalized = posix.normalize(value).replace(/\/$/, '')
  return normalized || '.'
}
function identity(value: { dev: bigint; ino: bigint; mode: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return [value.dev, value.ino, value.mode, value.mtimeNs, value.ctimeNs].join(':')
}
function hash(value: string): string { return createHash('sha256').update(value).digest('base64url') }
function encodeCursor(value: Cursor): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
  return 'pf1.' + payload + '.' + hash(payload)
}
function decodeCursor(input: string, workspace: string, path: string, includeHidden: boolean): Cursor {
  try {
    if (typeof input !== 'string' || input.length > 16000) invalidCursor()
    const [prefix, payload, checksum, ...extra] = input.split('.')
    if (prefix !== 'pf1' || !payload || !checksum || extra.length || !/^[A-Za-z0-9_-]+$/.test(payload) || hash(payload) !== checksum) invalidCursor()
    const value = JSON.parse(decoder.decode(Buffer.from(payload, 'base64url'))) as Cursor
    if (value === null || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'd,h,n,o,p,v,w' || value.v !== 1 || value.w !== workspace || value.p !== path || value.h !== includeHidden || typeof value.d !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.d) || !Number.isSafeInteger(value.o) || value.o < 1 || value.o >= MAX_PROJECT_DIRECTORY_ENTRIES || typeof value.n !== 'string' || value.n.length === 0 || encodeCursor({ v: 1, w: workspace, p: path, h: includeHidden, d: value.d, o: value.o, n: value.n }) !== input) invalidCursor()
    return value
  } catch { invalidCursor() }
}
function fsCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return typeof code === 'string' && ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EIO', 'EMFILE', 'ENFILE', 'ENAMETOOLONG', 'EINVAL', 'EBUSY', 'ESTALE', 'EBADF'].includes(code) ? code : 'UNKNOWN'
}
function invalidCursor(): never { return fail('INVALID_PROJECT_FILES_CURSOR', 'Project files cursor is malformed or belongs to a different listing') }
function outputTooLarge(): never { return fail('PROJECT_FILES_OUTPUT_TOO_LARGE', 'Project file listing exceeds the 512 KiB byte limit; no listing was returned') }
function fail(code: string, message: string, details?: Record<string, unknown>): never { throw new NativeControlError(code, message, details) }
