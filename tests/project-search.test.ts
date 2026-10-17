import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Dir } from 'node:fs'
import { mkdir, mkdtemp, open, rename, rm, symlink, truncate, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { HarnessGatewayFacade, type HarnessGatewayProvider, type TypertGatewayPort } from '../src/harness-gateway/index.js'
import { NativeControlError, NativeControlFacade, PROJECT_SEARCH_LIMITS, registerNativeControlTools } from '../src/native-control/index.js'
import { searchProjectText, type ProjectSearchInput } from '../src/native-control/project-search.js'

function facade(root: string, roots: string[] = []) {
  const gateway = new HarnessGatewayFacade({ listWorkspaces: async () => ({
    items: [{ workspaceId: 'project', path: root, title: '', sessionIds: [], createdAt: '', updatedAt: '' }], archivedSessionIds: [],
  }) } as unknown as HarnessGatewayProvider)
  return new NativeControlFacade({ gateway, typert: {} as TypertGatewayPort, allowedWorkspaceRoots: roots })
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'project-search-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, control: facade(root) }
}
const code = (expected: string) => (error: unknown) => {
  assert(error instanceof NativeControlError)
  assert.equal(error.code, expected)
  assert.equal('matches' in error.details, false)
  assert.equal('text' in error.details, false)
  return true
}
const cp = (value: string) => { let count = 0; for (const _ of value) count++; return count }

test('literal lexical DFS, path-line order and raw SHA expand through read_project_text', async t => {
  const { root, control } = await fixture(t)
  await mkdir(join(root, 'a'))
  await writeFile(join(root, 'a', 'z'), 'needle twice needle\nno\nneedle last\n')
  await writeFile(join(root, 'a.txt'), 'needle\n')
  await writeFile(join(root, 'z'), 'not present')
  const result = await control.searchProjectText({ workspace: 'project', query: 'needle', maxResults: 2 })
  // Selection is DFS by directory entry name; final presentation is path-line.
  assert.deepEqual(result.matches.map(match => [match.path, match.lineNumber]), [['a/z', 1], ['a/z', 3]])
  assert.equal(result.matchedLines, 3)
  assert.equal(result.matchedFiles, 2)
  assert.equal(result.filesConsidered, 3)
  assert.equal(result.filesSearched, 3)
  assert.equal(result.entriesScanned, 4)
  assert.equal(result.scanComplete, true)
  assert.equal(result.resultsTruncated, true)
  assert.equal(result.lastScannedPath, 'z')
  assert.equal(result.order, 'path-line')
  assert.equal(result.sourceTrust, 'untrusted')
  const all = await control.searchProjectText({ workspace: root, query: 'needle', maxResults: 100 })
  assert.deepEqual(all.matches.map(match => match.path), ['a.txt', 'a/z', 'a/z'])
  assert.equal(all.resultsTruncated, false)
  for (const match of all.matches) {
    const expanded = await control.readProjectText({ workspace: root, path: match.path, startLine: match.lineNumber, lineCount: 1, expectedSha256: match.sha256 })
    assert.equal(expanded.lines[0]?.text, match.text)
    assert.equal(match.excerptStart, 0)
    assert.equal(match.truncated, false)
  }
  const zero = await control.searchProjectText({ workspace: root, query: 'absent' })
  assert.deepEqual(zero.matches, [])
  assert.equal(zero.scanComplete, true)
  assert.deepEqual(zero.incompleteReasons, [])
})

test('UTF-8 BOM, Unicode case folding, CRLF/lone CR and literal regex-like punctuation', async t => {
  const { root, control } = await fixture(t)
  const raw = Buffer.from('\ufeff\u03b1\ud83d\ude00 NEEDLE\r\nneedle\rCR\n\n.*+[x]?^$(){}|\\\n\u212aelvin\n')
  await writeFile(join(root, 'text'), raw)
  const folded = await control.searchProjectText({ workspace: root, query: 'needle' })
  assert.deepEqual(folded.matches.map(match => [match.lineNumber, match.text]), [[1, '\u03b1\ud83d\ude00 NEEDLE'], [2, 'needle\rCR']])
  assert.equal(folded.matches[0]?.sha256, createHash('sha256').update(raw).digest('hex'))
  assert.equal((await control.searchProjectText({ workspace: root, query: 'needle', caseSensitive: true })).matchedLines, 1)
  assert.equal((await control.searchProjectText({ workspace: root, query: 'kelvin' })).matches[0]?.lineNumber, 5)
  assert.equal((await control.searchProjectText({ workspace: root, query: 'kelvin', caseSensitive: true })).matchedLines, 0)
  assert.equal((await control.searchProjectText({ workspace: root, query: '.*+[x]?^$(){}|\\' })).matchedLines, 1)
  assert.equal((await control.searchProjectText({ workspace: root, query: '\ufeff' })).matchedLines, 0)
})

test('excerpts count original codepoints, include the full query and never split surrogate pairs', async t => {
  const { root, control } = await fixture(t)
  const query = '\ud83d\ude80'.repeat(256)
  const line = '\ud83d\ude00'.repeat(1000) + query + 'x'.repeat(1000)
  await writeFile(join(root, 'text'), line + '\n' + 'x'.repeat(800) + '\u212a' + 'x'.repeat(800))
  const result = await control.searchProjectText({ workspace: root, query })
  const match = result.matches[0]!
  assert.equal(cp(match.text), 600)
  assert.equal(match.excerptStart, 920)
  assert.equal(match.truncated, true)
  assert(match.text.includes(query))
  assert.equal([...line].slice(match.excerptStart, match.excerptStart + 600).join(''), match.text)
  const folded = (await control.searchProjectText({ workspace: root, query: 'k' })).matches[0]!
  assert.equal(folded.excerptStart, 720)
  assert.equal(folded.text[80], '\u212a')
  const endQuery = '\ud83d\ude00'.repeat(10)
  await writeFile(join(root, 'text'), 'a'.repeat(1000) + endQuery)
  const last = (await control.searchProjectText({ workspace: root, query: endQuery })).matches[0]!
  assert.equal(cp(last.text), 600)
  assert.equal(last.excerptStart, 410)
  assert(last.text.endsWith(endQuery))
})

test('hidden names, fixed exclusions, explicit excluded root and depth zero preserve scope', async t => {
  const { root, control } = await fixture(t)
  await writeFile(join(root, 'visible'), 'hit')
  await writeFile(join(root, '.hidden'), 'hit')
  for (const name of ['.git', 'node_modules', 'dist', 'build', 'coverage', '.secret', 'sub']) {
    await mkdir(join(root, name))
    await writeFile(join(root, name, 'text'), 'hit')
  }
  await mkdir(join(root, 'sub', '.nested'))
  await writeFile(join(root, 'sub', '.nested', 'text'), 'hit')
  const result = await control.searchProjectText({ workspace: root, query: 'hit' })
  assert.equal(result.matchedFiles, 2)
  assert.equal(result.scanComplete, true)
  assert.equal(result.skippedEntries.hidden, 3)
  assert.equal(result.skippedEntries.excludedDirectories, 5)
  const hidden = await control.searchProjectText({ workspace: root, query: 'hit', includeHidden: true })
  assert.equal(hidden.matchedFiles, 5)
  assert.equal(hidden.skippedEntries.excludedDirectories, 5)
  assert.equal(hidden.skippedEntries.hidden, 0)
  const selected = await control.searchProjectText({ workspace: root, path: './node_modules//', query: 'hit' })
  assert.equal(selected.path, 'node_modules')
  assert.equal(selected.matches[0]?.path, 'node_modules/text')
  const shallow = await control.searchProjectText({ workspace: root, query: 'hit', maxDepth: 0 })
  assert.equal(shallow.matchedFiles, 1)
  assert.equal(shallow.scanComplete, false)
  assert.deepEqual(shallow.incompleteReasons, ['depth_limit'])
  assert.equal(shallow.depthLimitedDirectories, 1)
  const zero = await control.searchProjectText({ workspace: root, query: 'absent', maxDepth: 0 })
  assert.equal(zero.matchedLines, 0)
  assert.equal(zero.scanComplete, false)
})

test('result and serialized JSON caps keep scanning and counting every eligible hit', async t => {
  const { root, control } = await fixture(t)
  const line = '\u0001'.repeat(80) + 'hit' + '\u0001'.repeat(517)
  await writeFile(join(root, 'a'), (line + '\n').repeat(120))
  await writeFile(join(root, 'b'), 'hit\n')
  const one = await control.searchProjectText({ workspace: root, query: 'hit', maxResults: 1 })
  assert.equal(one.matches.length, 1)
  assert.equal(one.matchedLines, 121)
  assert.equal(one.matchedFiles, 2)
  assert.equal(one.filesSearched, 2)
  assert.equal(one.scanComplete, true)
  const limited = await control.searchProjectText({ workspace: root, query: 'hit', maxResults: 100 })
  assert(limited.matches.length > 0 && limited.matches.length < 100)
  assert.equal(limited.matchedLines, 121)
  assert.equal(limited.matchedFiles, 2)
  assert.equal(limited.scanComplete, true)
  assert.equal(limited.resultsTruncated, true)
  assert(Buffer.byteLength(JSON.stringify(limited)) <= PROJECT_SEARCH_LIMITS.outputBytes)
  await writeFile(join(root, 'a'), 'hit\n'.repeat(110))
  const hundred = await control.searchProjectText({ workspace: root, query: 'hit', maxResults: 100 })
  assert.equal(hundred.matches.length, 100)
  assert.equal(hundred.matchedLines, 111)
  assert.equal(hundred.filesSearched, 2)
})

test('real entry and regular-file budgets yield honest incomplete scans', async t => {
  const { root, control } = await fixture(t)
  await mkdir(join(root, 'entries'))
  for (let batch = 0; batch < 20; batch++) await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(root, 'entries', '.f' + (batch * 100 + index)), 'hit')))
  await writeFile(join(root, 'entries', 'visible'), 'hit')
  const entries = await control.searchProjectText({ workspace: root, path: 'entries', query: 'hit' })
  assert.equal(entries.entriesScanned, 2000)
  assert.equal(entries.bytesRead, 0)
  assert.equal(entries.filesConsidered, 0)
  assert.equal(entries.scanComplete, false)
  assert.deepEqual(entries.incompleteReasons, ['entry_limit'])
  await mkdir(join(root, 'files'))
  for (let batch = 0; batch < 5; batch++) await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(root, 'files', String(batch * 100 + index).padStart(4, '0')), 'hit')))
  await writeFile(join(root, 'files', 'last'), 'hit')
  const files = await control.searchProjectText({ workspace: root, path: 'files', query: 'hit', maxResults: 1 })
  assert.equal(files.entriesScanned, 501)
  assert.equal(files.filesConsidered, 500)
  assert.equal(files.filesSearched, 500)
  assert.equal(files.matchedLines, 500)
  assert.equal(files.scanComplete, false)
  assert.deepEqual(files.incompleteReasons, ['file_limit'])
})

test('real 1 MiB per-file and 16 MiB aggregate byte bounds and invalid text are explicit', async t => {
  const { root, control } = await fixture(t)
  await mkdir(join(root, 'large'))
  const content = Buffer.alloc(PROJECT_SEARCH_LIMITS.fileBytes, 120)
  content.write('hit')
  for (let i = 0; i < 17; i++) await writeFile(join(root, 'large', String(i).padStart(2, '0')), content)
  const bytes = await control.searchProjectText({ workspace: root, path: 'large', query: 'hit' })
  assert.equal(bytes.bytesRead, PROJECT_SEARCH_LIMITS.bytes)
  assert.equal(bytes.filesSearched, 16)
  assert.equal(bytes.matchedLines, 16)
  assert.equal(bytes.scanComplete, false)
  assert.deepEqual(bytes.incompleteReasons, ['byte_limit'])
  await mkdir(join(root, 'invalid'))
  await writeFile(join(root, 'invalid', 'a'), 'hit')
  await writeFile(join(root, 'invalid', 'oversized'), 'hit')
  await truncate(join(root, 'invalid', 'oversized'), PROJECT_SEARCH_LIMITS.fileBytes + 1)
  await writeFile(join(root, 'invalid', 'nul'), 'hit\0')
  await writeFile(join(root, 'invalid', 'utf8'), Buffer.from([0x68, 0x69, 0x74, 0xff]))
  await writeFile(join(root, 'invalid', 'bom-only'), '\ufeff')
  const skipped = await control.searchProjectText({ workspace: root, path: 'invalid', query: 'hit' })
  assert.equal(skipped.filesConsidered, 5)
  assert.equal(skipped.filesSearched, 2)
  assert.equal(skipped.matchedLines, 1)
  assert.equal(skipped.scanComplete, false)
  assert.deepEqual(skipped.incompleteReasons, ['invalid_text', 'oversized'])
  assert.deepEqual(skipped.skippedFiles, { oversized: 1, invalidText: 2 })
})

test('filename byte guard is independently bounded, including before UTF-8 decode', async t => {
  const { root, control } = await fixture(t)
  await writeFile(join(root, 'a'), 'hit')
  const original = Dir.prototype.read
  let reads = 0
  const mocked = t.mock.method(Dir.prototype, 'read', async function(this: Dir) {
    reads++
    const entry = await Reflect.apply(original, this, [])
    // NAME_MAX makes 512 KiB unreachable with <=2000 real Linux names.
    // Simulate a raw dirent at the API boundary to exercise the independent guard.
    if (entry) Object.assign(entry, { name: Buffer.alloc(PROJECT_SEARCH_LIMITS.filenameBytes + 1, 255) })
    return entry
  })
  try {
    const result = await control.searchProjectText({ workspace: root, query: 'hit' })
    assert.equal(reads, 1)
    assert.equal(result.entriesScanned, 1)
    assert.equal(result.filesSearched, 0)
    assert.equal(result.scanComplete, false)
    assert.deepEqual(result.incompleteReasons, ['filename_bytes_limit'])
  } finally { mocked.mock.restore() }
})

test('malformed filename bytes fail explicitly without exposing any success content', async t => {
  const { root, control } = await fixture(t)
  await writeFile(Buffer.concat([Buffer.from(root + '/'), Buffer.from([0xff])]), 'hit')
  await assert.rejects(control.searchProjectText({ workspace: root, query: 'hit' }), code('PROJECT_SEARCH_FILENAME_UNSUPPORTED'))
})

test('symlinks and FIFO are never read, and selected symlink roots/escapes are denied', { timeout: 5000 }, async t => {
  const { root, control } = await fixture(t)
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'sub', 'text'), 'hit')
  await symlink('sub', join(root, 'link'))
  await symlink('/etc', join(root, 'outside'))
  await symlink('sub/text', join(root, 'file-link'))
  await promisify(execFile)('mkfifo', [join(root, 'fifo')])
  const result = await control.searchProjectText({ workspace: root, query: 'hit' })
  assert.equal(result.matchedFiles, 1)
  assert.equal(result.filesConsidered, 1)
  assert.equal(result.skippedEntries.symlinks, 3)
  assert.equal(result.skippedEntries.special, 1)
  assert.equal(result.scanComplete, true)
  for (const path of ['link', 'link/sub', 'outside', '/etc', '../sub', 'sub/..', 'C:\\Windows', 'sub\\text']) {
    await assert.rejects(control.searchProjectText({ workspace: root, path, query: 'hit' }), code('PROJECT_SEARCH_PATH_DENIED'))
  }
})

test('workspace callback retains existing registered/configured-root authority exactly', async t => {
  const { root, control } = await fixture(t)
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'sub', 'text'), 'hit')
  assert.equal((await control.searchProjectText({ workspace: 'project', query: 'hit' })).workspace, root)
  await assert.rejects(control.searchProjectText({ workspace: join(root, 'sub'), query: 'hit' }), code('WORKSPACE_DENIED'))
  assert.equal((await facade(root, [root]).searchProjectText({ workspace: join(root, 'sub'), query: 'hit' })).matchedFiles, 1)
  await assert.rejects(facade(root, [join(root, 'sub')]).searchProjectText({ workspace: 'project', query: 'hit' }), code('WORKSPACE_DENIED'))
  let called = 0
  const direct = await searchProjectText({ workspace: 'opaque-id', query: 'hit' }, async workspace => { assert.equal(workspace, 'opaque-id'); called++; return root })
  assert.equal(called, 1)
  assert.equal(direct.workspace, root)
})

test('invalid direct arguments reject before authorization or filesystem IO', async () => {
  const base = { workspace: 'project', query: 'hit' }
  for (const patch of [
    { workspace: '' }, { workspace: 'x'.repeat(4097) }, { workspace: 'x\0' }, { query: '' }, { query: 'x'.repeat(257) },
    { query: '\ud83d\ude00'.repeat(257) }, { query: 'x\n' }, { query: 'x\r' }, { query: 'x\0' }, { query: 1 },
    { path: '' }, { path: '\0' }, { path: 'x'.repeat(4097) }, { path: null }, { caseSensitive: 1 }, { caseSensitive: null },
    { includeHidden: null }, { maxDepth: -1 }, { maxDepth: 9 }, { maxDepth: 0.5 }, { maxDepth: null },
    { maxResults: 0 }, { maxResults: 101 }, { maxResults: NaN }, { maxResults: null },
  ]) await assert.rejects(searchProjectText({ ...base, ...patch } as ProjectSearchInput, async () => { assert.fail('must not authorize invalid input') }), code('INVALID_ARGUMENT'))
})

test('read-time writes/replacements/parent swaps reject accumulated matches without partial success', async t => {
  const { root, control } = await fixture(t)
  await writeFile(join(root, 'a'), 'hit earlier')
  await mkdir(join(root, 'dir'))
  const path = join(root, 'dir', 'b')
  for (const mutate of [
    async () => writeFile(path, 'changed'),
    async () => { await rename(path, path + '.old'); await writeFile(path, 'replacement') },
    async () => { await rename(join(root, 'dir'), join(root, 'moved')); await mkdir(join(root, 'dir')); await writeFile(path, 'replacement') },
  ]) {
    await writeFile(path, 'hit original')
    const probe = await open(path)
    const prototype = Object.getPrototypeOf(probe)
    const original = prototype.read
    await probe.close()
    let calls = 0
    const mocked = t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: Parameters<FileHandle['read']>) {
      const result = await Reflect.apply(original, this, args)
      // First file is read with a content read plus EOF read; mutate the second.
      if (++calls === 3) await mutate()
      return result
    })
    try { await assert.rejects(control.searchProjectText({ workspace: root, query: 'hit' }), code('PROJECT_SEARCH_CHANGED')) }
    finally { mocked.mock.restore() }
  }
})

test('unknown read errors fail sanitized with allowlisted fsCode, not silent no-match', async t => {
  const { root, control } = await fixture(t)
  await writeFile(join(root, 'text'), 'hit')
  await assert.rejects(control.searchProjectText({ workspace: root, path: 'missing-private-path', query: 'hit' }), error => {
    assert(code('PROJECT_SEARCH_READ_FAILED')(error))
    assert.deepEqual((error as NativeControlError).details, { fsCode: 'ENOENT' })
    assert(!String(error).includes('missing-private-path'))
    return true
  })
  const probe = await open(join(root, 'text'))
  const prototype = Object.getPrototypeOf(probe)
  await probe.close()
  for (const fsCode of ['EACCES', 'PRIVATE_SECRET']) {
    const mocked = t.mock.method(prototype, 'read', async () => { throw Object.assign(new Error('private file contents'), { code: fsCode }) })
    try {
      await assert.rejects(control.searchProjectText({ workspace: root, query: 'hit' }), error => {
        assert(code('PROJECT_SEARCH_READ_FAILED')(error))
        assert.deepEqual((error as NativeControlError).details, { fsCode: fsCode === 'EACCES' ? fsCode : 'UNKNOWN' })
        assert(!String(error).includes('private file contents'))
        return true
      })
    } finally { mocked.mock.restore() }
  }
})

test('MCP read-only schema, structured success, guarded errors, Unicode validation and unavailable control', async t => {
  const { root, control } = await fixture(t)
  await writeFile(join(root, 'text'), 'hello\ud83d\ude00')
  for (const current of [control, undefined]) {
    const server = new McpServer({ name: 'project-search-test', version: '1' })
    registerNativeControlTools(server, current)
    const client = new Client({ name: 'project-search-client', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    try {
      await client.connect(clientTransport)
      const tool = (await client.listTools()).tools.find(tool => tool.name === 'search_project_text')!
      assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
      assert(tool.outputSchema)
      assert.deepEqual(tool.inputSchema.required, ['workspace', 'query'])
      assert.equal((tool.inputSchema.properties?.query as { maxLength: number }).maxLength, 1024)
      assert.equal((tool.inputSchema.properties?.maxDepth as { default: number }).default, 4)
      const response = await client.callTool({ name: 'search_project_text', arguments: { workspace: 'project', query: 'hello' } })
      if (current) {
        assert.notEqual(response.isError, true)
        const result = response.structuredContent as Record<string, unknown>
        assert.equal(result.sourceTrust, 'untrusted')
        assert.equal(result.matchedLines, 1)
        for (const [args, expected] of [[{ path: '../escape' }, 'PROJECT_SEARCH_PATH_DENIED'], [{ query: '\ud83d\ude00'.repeat(257) }, 'INVALID_ARGUMENT'], [{ query: 'bad\nquery' }, 'INVALID_ARGUMENT']] as const) {
          const error = await client.callTool({ name: 'search_project_text', arguments: { workspace: root, query: 'hello', ...args } })
          assert.equal(error.isError, true)
          assert.equal(error.structuredContent, undefined)
          assert.equal(JSON.parse((error.content as { text: string }[])[0]!.text).code, expected)
        }
        for (const args of [{ maxDepth: 9 }, { maxResults: 101 }, { maxDepth: 0.5 }, { query: '' }, { caseSensitive: 'false' }]) {
          assert.equal((await client.callTool({ name: 'search_project_text', arguments: { workspace: root, query: 'hello', ...args } })).isError, true)
        }
      } else {
        assert.equal(response.isError, true)
        assert.equal(response.structuredContent, undefined)
        assert.equal(JSON.parse((response.content as { text: string }[])[0]!.text).code, 'NATIVE_CONTROL_UNAVAILABLE')
      }
    } finally { await Promise.allSettled([client.close(), server.close()]) }
  }
})


test('discovered children swapped to symlinks during a prior read fail before target access', async t => {
  const { root, control } = await fixture(t)
  await writeFile(join(root, 'a'), 'hit')
  await writeFile(join(root, 'b'), 'hit')
  const probe = await open(join(root, 'a'))
  const prototype = Object.getPrototypeOf(probe)
  const original = prototype.read
  await probe.close()
  let mutated = false
  const mocked = t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: Parameters<FileHandle['read']>) {
    const result = await Reflect.apply(original, this, args)
    if (!mutated) {
      mutated = true
      await rm(join(root, 'b'))
      await symlink('/etc/passwd', join(root, 'b'))
    }
    return result
  })
  try { await assert.rejects(control.searchProjectText({ workspace: root, query: 'hit' }), code('PROJECT_SEARCH_CHANGED')) }
  finally { mocked.mock.restore() }
})

test('unsupported platforms fail explicitly after existing workspace authorization', async t => {
  const { root } = await fixture(t)
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  let authorized = 0
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
  try {
    await assert.rejects(searchProjectText({ workspace: 'project', query: 'hit' }, async () => { authorized++; return root }), code('PROJECT_SEARCH_PLATFORM_UNSUPPORTED'))
    assert.equal(authorized, 1)
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})
