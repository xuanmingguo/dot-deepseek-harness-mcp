import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, rename, rm, symlink, truncate, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { HarnessGatewayFacade, type HarnessGatewayProvider, type TypertGatewayPort } from '../src/harness-gateway/index.js'
import { MAX_PROJECT_TEXT_FILE_BYTES, NativeControlError, NativeControlFacade, registerNativeControlTools } from '../src/native-control/index.js'

function facade(root: string, roots: string[] = []) {
  const gateway = new HarnessGatewayFacade({ listWorkspaces: async () => ({
    items: [{ workspaceId: 'project', path: root, title: '', sessionIds: [], createdAt: '', updatedAt: '' }], archivedSessionIds: [],
  }) } as unknown as HarnessGatewayProvider)
  return new NativeControlFacade({ gateway, typert: {} as TypertGatewayPort, allowedWorkspaceRoots: roots })
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'project-text-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, control: facade(root) }
}
const code = (expected: string) => (error: unknown) => {
  assert(error instanceof NativeControlError)
  assert.equal(error.code, expected)
  assert.equal('lines' in error.details, false)
  return true
}

test('UTF-8 text preserves Unicode, BOM/hash, CRLF, lone CR and blank-line boundaries', async t => {
  const { root, control } = await fixture(t)
  const raw = Buffer.from('\ufeffα😀\r\n\nkeep\rCR\n\ufeffinside\n\n')
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'sub', 'text'), raw)
  const result = await control.readProjectText({ workspace: 'project', path: './sub//text' })
  assert.deepEqual(result.lines, [
    { lineNumber: 1, text: 'α😀' }, { lineNumber: 2, text: '' }, { lineNumber: 3, text: 'keep\rCR' },
    { lineNumber: 4, text: '\ufeffinside' }, { lineNumber: 5, text: '' },
  ])
  assert.deepEqual(result.reference, { workspace: root, path: 'sub/text', sizeBytes: raw.length, modifiedAt: result.reference.modifiedAt, sha256: createHash('sha256').update(raw).digest('hex') })
  assert.equal(result.bom, true)
  assert.equal(result.totalLines, 5)
  assert.equal(result.encoding, 'utf-8')
  assert.equal(result.sourceTrust, 'untrusted')
  assert.equal(result.endLine, 5)
  assert.equal(result.hasMore, false)
  assert.equal(result.hasEarlier, false)
  assert.equal(result.nextStartLine, null)
  for (const [value, expected] of [['', []], ['\ufeff', []], ['\n', ['']], ['\n\n', ['', '']], ['a', ['a']], ['a\n', ['a']], ['a\r', ['a\r']]] as const) {
    await writeFile(join(root, 'text'), value)
    const page = await control.readProjectText({ workspace: root, path: 'text' })
    assert.equal(page.totalLines, expected.length)
    assert.deepEqual(page.lines.map(line => line.text), expected)
    assert.equal(page.endLine, expected.length || null)
    assert.equal(page.startLine, 1)
  }
})

test('range, EOF, stateless replay and tail use numbered lines and expected raw hash', async t => {
  const { root, control } = await fixture(t)
  await writeFile(join(root, 'text'), 'a\nb\nc\nd\ne')
  const first = await control.readProjectText({ workspace: root, path: 'text', lineCount: 2 })
  assert.equal(first.nextStartLine, 3)
  assert.equal(first.outputLimited, false)
  const request = { workspace: root, path: 'text', startLine: first.nextStartLine!, lineCount: 2, expectedSha256: first.reference.sha256 }
  const next = await facade(root).readProjectText(request)
  assert.deepEqual(next.lines, [{ lineNumber: 3, text: 'c' }, { lineNumber: 4, text: 'd' }])
  assert.equal(next.hasEarlier, true)
  assert.deepEqual(await facade(root).readProjectText(request), next)
  const tail = await control.readProjectText({ workspace: root, path: 'text', tail: true, lineCount: 2 })
  assert.equal(tail.startLine, 4)
  assert.equal(tail.endLine, 5)
  assert.equal(tail.hasMore, false)
  assert.equal(tail.nextStartLine, null)
  assert.equal(tail.hasEarlier, true)
  assert.deepEqual(tail.lines.map(line => line.text), ['d', 'e'])
  const eof = await control.readProjectText({ workspace: root, path: 'text', startLine: 6 })
  assert.deepEqual(eof.lines, [])
  assert.equal(eof.endLine, null)
  assert.equal(eof.hasMore, false)
  await assert.rejects(control.readProjectText({ workspace: root, path: 'text', startLine: 7 }), code('INVALID_ARGUMENT'))
  await writeFile(join(root, 'text'), 'changed')
  await assert.rejects(control.readProjectText(request), code('PROJECT_TEXT_CHANGED'))
})

test('text and serialized caps preserve whole lines, exact continuation and final tail semantics', async t => {
  const { root, control } = await fixture(t)
  const a = '😀'.repeat(4096)
  await writeFile(join(root, 'text'), a + '\n' + a + '\nlast')
  const first = await control.readProjectText({ workspace: root, path: 'text' })
  assert.equal(first.lines.length, 2)
  assert.equal(first.outputLimited, true)
  assert.equal(first.nextStartLine, 3)
  assert.equal(first.endLine, 2)
  assert(Buffer.byteLength(JSON.stringify(first)) <= 64 * 1024)
  const last = await control.readProjectText({ workspace: root, path: 'text', startLine: first.nextStartLine! })
  assert.deepEqual(last.lines, [{ lineNumber: 3, text: 'last' }])
  await assert.rejects(control.readProjectText({ workspace: root, path: 'text', tail: true }), code('PROJECT_TEXT_OUTPUT_TOO_LARGE'))
  assert.deepEqual((await control.readProjectText({ workspace: root, path: 'text', tail: true, lineCount: 1 })).lines, [{ lineNumber: 3, text: 'last' }])
  await writeFile(join(root, 'text'), 'x'.repeat(32769))
  await assert.rejects(control.readProjectText({ workspace: root, path: 'text' }), code('PROJECT_TEXT_LINE_TOO_LONG'))
  await writeFile(join(root, 'text'), 'ok\n' + '\u0001'.repeat(12000) + '\nfinal')
  const escaped = await control.readProjectText({ workspace: root, path: 'text' })
  assert.deepEqual(escaped.lines, [{ lineNumber: 1, text: 'ok' }])
  assert.equal(escaped.nextStartLine, 2)
  assert.equal(escaped.outputLimited, true)
  await assert.rejects(control.readProjectText({ workspace: root, path: 'text', startLine: 2 }), code('PROJECT_TEXT_LINE_TOO_LONG'))
})

test('16 MiB whole-file cap and 200 line cap work without allocating one array element per file line', async t => {
  const { root, control } = await fixture(t)
  await writeFile(join(root, 'text'), Buffer.alloc(MAX_PROJECT_TEXT_FILE_BYTES, 10))
  const full = await control.readProjectText({ workspace: root, path: 'text', lineCount: 200 })
  assert.equal(full.totalLines, MAX_PROJECT_TEXT_FILE_BYTES)
  assert.equal(full.lines.length, 200)
  assert.equal(full.nextStartLine, 201)
  assert.equal(full.outputLimited, false)
  await truncate(join(root, 'text'), MAX_PROJECT_TEXT_FILE_BYTES + 1)
  await assert.rejects(control.readProjectText({ workspace: root, path: 'text' }), code('PROJECT_TEXT_TOO_LARGE'))
})

test('invalid UTF-8 and NUL anywhere in the file fail without returning even valid selected lines', async t => {
  const { root, control } = await fixture(t)
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc3]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('good\n\0'), Buffer.from([0x61, 10, 0xff])]) {
    await writeFile(join(root, 'text'), bytes)
    await assert.rejects(control.readProjectText({ workspace: root, path: 'text', lineCount: 1 }), error => {
      assert(code('PROJECT_TEXT_NOT_UTF8')(error))
      assert.match((error as Error).message, /UTF-8 without NUL/)
      return true
    })
  }
})

test('nonregular files and FIFOs fail without blocking; missing paths return sanitized allowlisted codes', { timeout: 5000 }, async t => {
  const { root, control } = await fixture(t)
  await mkdir(join(root, 'directory'))
  await assert.rejects(control.readProjectText({ workspace: root, path: 'directory' }), code('PROJECT_TEXT_NOT_REGULAR'))
  await assert.rejects(control.readProjectText({ workspace: root, path: '.' }), code('PROJECT_TEXT_NOT_REGULAR'))
  await promisify(execFile)('mkfifo', [join(root, 'fifo')])
  await assert.rejects(control.readProjectText({ workspace: root, path: 'fifo' }), code('PROJECT_TEXT_NOT_REGULAR'))
  for (const workspace of [root, join(root, 'missing-workspace')]) await assert.rejects(control.readProjectText({ workspace, path: 'private-missing-file' }), error => {
    assert(code('PROJECT_TEXT_READ_FAILED')(error))
    assert.deepEqual((error as NativeControlError).details, { fsCode: 'ENOENT' })
    assert.equal((error as Error).message, 'Unable to safely open or read this project text')
    return true
  })
})

test('registered IDs and configured roots retain existing artifact authority with no external grants', async t => {
  const { root, control } = await fixture(t)
  await writeFile(join(root, 'text'), 'root')
  assert.equal((await control.readProjectText({ workspace: 'project', path: 'text' })).reference.workspace, root)
  await mkdir(join(root, 'inside'))
  await writeFile(join(root, 'inside', 'text'), 'inside')
  await assert.rejects(control.readProjectText({ workspace: join(root, 'inside'), path: 'text' }), code('WORKSPACE_DENIED'))
  assert.equal((await facade(root, [root]).readProjectText({ workspace: join(root, 'inside'), path: 'text' })).lines[0]?.text, 'inside')
  await assert.rejects(facade(root, [join(root, 'inside')]).readProjectText({ workspace: 'project', path: 'text' }), code('WORKSPACE_DENIED'))
  const sibling = root + '-sibling'
  await mkdir(sibling)
  t.after(() => rm(sibling, { recursive: true, force: true }))
  await writeFile(join(sibling, 'text'), 'outside')
  await assert.rejects(facade(root, [root]).readProjectText({ workspace: sibling, path: 'text' }), code('WORKSPACE_DENIED'))
})

test('absolute paths, traversal, ambiguous backslashes and symlink parents/files are denied', async t => {
  const { root, control } = await fixture(t)
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'text'), 'private')
  await symlink('text', join(root, 'link'))
  await symlink('sub', join(root, 'parent-link'))
  await symlink('/etc', join(root, 'outside'))
  for (const path of ['/etc/passwd', root, '../text', 'sub/../text', 'sub/../../text', 'C:\\Windows', '..\\text', 'sub\\text', 'link', 'parent-link/text', 'outside/passwd']) {
    await assert.rejects(control.readProjectText({ workspace: root, path }), code('PROJECT_TEXT_PATH_DENIED'))
  }
})

test('invalid direct arguments are rejected before filesystem reads', async t => {
  const { root, control } = await fixture(t)
  const valid = { workspace: root, path: 'missing' }
  for (const patch of [
    { workspace: '' }, { workspace: 'x'.repeat(4097) }, { path: '' }, { path: 'x'.repeat(4097) }, { path: 'nul\0' },
    { startLine: 0 }, { startLine: 1.5 }, { startLine: Number.MAX_SAFE_INTEGER + 1 }, { lineCount: 0 }, { lineCount: 201 }, { lineCount: NaN },
    { tail: true, startLine: 1 }, { expectedSha256: 'A'.repeat(64) }, { expectedSha256: '0'.repeat(63) },
  ]) await assert.rejects(control.readProjectText({ ...valid, ...patch }), code('INVALID_ARGUMENT'))
})

test('changes, replacement and parent rename during the bounded read return no content', async t => {
  const { root, control } = await fixture(t)
  await mkdir(join(root, 'dir'))
  const path = join(root, 'dir', 'text')
  for (const mutate of [
    async () => writeFile(path, 'different'),
    async () => { await rename(path, path + '.old'); await writeFile(path, 'replacement') },
    async () => { await rename(join(root, 'dir'), join(root, 'moved')); await mkdir(join(root, 'dir')); await writeFile(path, 'replacement') },
  ]) {
    await writeFile(path, 'original')
    const probe = await open(path)
    const prototype = Object.getPrototypeOf(probe)
    const original = prototype.read
    await probe.close()
    let mutated = false
    const mocked = t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: Parameters<FileHandle['read']>) {
      const result = await Reflect.apply(original, this, args)
      if (!mutated) { mutated = true; await mutate() }
      return result
    })
    try { await assert.rejects(control.readProjectText({ workspace: root, path: 'dir/text' }), code('PROJECT_TEXT_CHANGED')) }
    finally { mocked.mock.restore() }
  }
})

test('MCP advertises precise read-only schemas, validates input and guards errors without success content', async t => {
  const { root, control } = await fixture(t)
  await writeFile(join(root, 'text'), 'hello😀\nworld')
  for (const current of [control, undefined]) {
    const server = new McpServer({ name: 'project-text-test', version: '1' })
    registerNativeControlTools(server, current)
    const client = new Client({ name: 'project-text-client', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    try {
      await client.connect(clientTransport)
      const tool = (await client.listTools()).tools.find(tool => tool.name === 'read_project_text')!
      assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
      assert(tool.outputSchema)
      assert.equal((tool.inputSchema.properties?.lineCount as { maximum: number }).maximum, 200)
      assert.equal((tool.inputSchema.properties?.startLine as { default?: number }).default, undefined)
      assert.deepEqual(tool.inputSchema.required, ['workspace', 'path'])
      const response = await client.callTool({ name: 'read_project_text', arguments: { workspace: 'project', path: 'text' } })
      if (current) {
        assert.notEqual(response.isError, true)
        const structured = response.structuredContent as Record<string, unknown>
        assert.equal(structured.sourceTrust, 'untrusted')
        assert.deepEqual(structured.lines, [{ lineNumber: 1, text: 'hello😀' }, { lineNumber: 2, text: 'world' }])
        for (const [args, expected] of [
          [{ path: '../outside' }, 'PROJECT_TEXT_PATH_DENIED'], [{ expectedSha256: '0'.repeat(64) }, 'PROJECT_TEXT_CHANGED'], [{ tail: true, startLine: 1 }, 'INVALID_ARGUMENT'],
        ] as const) {
          const denied = await client.callTool({ name: 'read_project_text', arguments: { ...{ workspace: root, path: 'text' }, ...args } })
          assert.equal(denied.isError, true)
          assert.equal(denied.structuredContent, undefined)
          assert.equal(JSON.parse((denied.content as { text: string }[])[0]!.text).code, expected)
        }
        const invalid = await client.callTool({ name: 'read_project_text', arguments: { workspace: root, path: 'text', lineCount: 201 } })
        assert.equal(invalid.isError, true)
      } else {
        assert.equal(response.isError, true)
        assert.equal(response.structuredContent, undefined)
        assert.equal(JSON.parse((response.content as { text: string }[])[0]!.text).code, 'NATIVE_CONTROL_UNAVAILABLE')
      }
    } finally { await Promise.allSettled([client.close(), server.close()]) }
  }
})
