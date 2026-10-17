import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  hasPendingArtifactPromotion,
  promoteArtifacts,
  recoverArtifactPromotion,
  removePromotedBackup,
} from '../scripts/artifact-publication.mjs'

const publicationModule = new URL('../scripts/artifact-publication.mjs', import.meta.url).href
const oldTree = { 'entry.mjs': 'old entry\n', 'types/entry.d.ts': 'old declarations\n', 'metadata.json': '{"build":"old"}\n' }
const newTree = { 'entry.mjs': 'new entry\n', 'types/entry.d.ts': 'new declarations\n', 'metadata.json': '{"build":"new"}\n' }

async function writeTree(directory: string, tree: Record<string, string>): Promise<void> {
  await mkdir(directory, { recursive: true })
  for (const [name, content] of Object.entries(tree)) {
    await mkdir(join(directory, name, '..'), { recursive: true })
    await writeFile(join(directory, name), content)
  }
}

async function assertTree(directory: string, expected: Record<string, string>): Promise<void> {
  const actual: Record<string, string> = {}
  async function visit(relative: string): Promise<void> {
    for (const name of await readdir(join(directory, relative))) {
      const entry = join(relative, name)
      const info = await lstat(join(directory, entry))
      if (info.isDirectory()) await visit(entry)
      else {
        assert.equal(info.isFile(), true)
        actual[entry] = await readFile(join(directory, entry), 'utf8')
      }
    }
  }
  await visit('')
  assert.deepEqual(actual, expected)
  assert.equal((await lstat(directory)).isDirectory(), true)
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, previous = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-artifact-publication-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const dist = join(directory, 'dist')
  const staging = join(directory, 'staging')
  if (previous) await writeTree(dist, oldTree)
  await writeTree(staging, newTree)
  return { directory, dist, staging, journal: `${dist}.promotion.json` }
}

// The IPC handshake stops inside the injected rename wrapper. No timing sleep
// decides whether the child is killed before or after a filesystem operation.
async function crashAt(staging: string, dist: string, boundary: string, rollback = false): Promise<void> {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { rename, rm } from 'node:fs/promises';
    import { promoteArtifacts } from ${JSON.stringify(publicationModule)};
    // Keep the IPC channel referenced while awaiting the parent's SIGKILL;
    // an unsettled top-level await alone lets Node exit with code 13.
    process.on('message', () => {});
    let count = 0;
    async function pause(boundary) {
      if (boundary === process.argv[3]) {
        process.send({ boundary });
        await new Promise(() => {});
      }
    }
    await promoteArtifacts(process.argv[1], process.argv[2], {
      rename: async (from, to) => {
        const index = ++count;
        await pause('before-' + index);
        if (${rollback} && index === 2) throw new Error('injected publication failure');
        await rename(from, to);
        await pause('after-' + index);
      },
      rm: async (backup, options) => {
        if (process.argv[3] === 'cleanup-partial') {
          await rm(backup + '/entry.mjs');
          await pause('cleanup-partial');
        }
        await rm(backup, options);
      },
    });
  `, staging, dist, boundary], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr?.on('data', bytes => { stderr += String(bytes) })
  const exited = once(child, 'exit')
  const timeout = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
  try {
    const message = await Promise.race([
      once(child, 'message').then(([value]) => value as { boundary: string }),
      exited.then(() => { throw new Error(`publication child exited before ${boundary}: ${stderr}`) }),
    ])
    assert.equal(message.boundary, boundary)
    child.kill('SIGKILL')
    const [code, signal] = await exited
    assert.equal(code, null)
    assert.equal(signal, 'SIGKILL')
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
  }
}

for (const boundary of ['before-1', 'after-1', 'before-2', 'after-2']) {
  test(`SIGKILL ${boundary} recovers a complete multi-file publication`, { skip: process.platform === 'win32' }, async t => {
    const { directory, dist, staging } = await fixture(t)
    await crashAt(staging, dist, boundary)
    assert.equal(await hasPendingArtifactPromotion(dist), true)
    if (boundary === 'after-1' || boundary === 'before-2') {
      // A physical directory swap is recoverable, but is not gap-free.
      await assert.rejects(lstat(dist), { code: 'ENOENT' })
    }
    const expected = boundary === 'after-2' ? newTree : oldTree
    const result = await recoverArtifactPromotion(dist)
    assert.equal(result.recovered, true)
    await assertTree(dist, expected)
    assert.equal(await hasPendingArtifactPromotion(dist), false)
    assert.deepEqual((await readdir(directory)).filter(name => name.includes('.backup-')), [])
    assert.deepEqual(await recoverArtifactPromotion(dist), { recovered: false })
  })
}

for (const boundary of ['before-1', 'after-1']) {
  test(`initial publication SIGKILL ${boundary} completes the verified staged tree`, { skip: process.platform === 'win32' }, async t => {
    const { dist, staging } = await fixture(t, false)
    await crashAt(staging, dist, boundary)
    assert.equal((await recoverArtifactPromotion(dist)).outcome, 'new')
    await assertTree(dist, newTree)
    assert.equal(await hasPendingArtifactPromotion(dist), false)
  })
}

for (const boundary of ['before-3', 'after-3']) {
  test(`SIGKILL ${boundary} during catch rollback is recoverable`, { skip: process.platform === 'win32' }, async t => {
    const { dist, staging } = await fixture(t)
    await crashAt(staging, dist, boundary, true)
    assert.equal((await recoverArtifactPromotion(dist)).outcome, 'previous')
    await assertTree(dist, oldTree)
    await assertTree(staging, newTree)
  })
}

test('ordinary rename failure rolls back and retains the original error and staging', async t => {
  const { dist, staging } = await fixture(t)
  await assert.rejects(promoteArtifacts(staging, dist, {
    rename: async (from: string, to: string) => {
      if (from === staging) throw new Error('injected directory rename failure')
      await rename(from, to)
    },
  }), /injected directory rename failure/u)
  await assertTree(dist, oldTree)
  await assertTree(staging, newTree)
  assert.equal(await hasPendingArtifactPromotion(dist), false)
})

test('backup deletion occurs only after the installed complete tree verifies', async t => {
  const { dist, staging } = await fixture(t)
  let cleaned = false
  await promoteArtifacts(staging, dist, {
    rm: async (backup: string, options: { recursive: boolean, force: boolean }) => {
      await assertTree(dist, newTree)
      await assertTree(backup, oldTree)
      assert.equal(await hasPendingArtifactPromotion(dist), true)
      cleaned = true
      await rm(backup, options)
    },
  })
  assert.equal(cleaned, true)
  assert.equal(await hasPendingArtifactPromotion(dist), false)
})

test('changed installed tree preserves backup, journal, and all conflicting content', async t => {
  const { directory, dist, staging, journal } = await fixture(t)
  await assert.rejects(promoteArtifacts(staging, dist, {
    rename: async (from: string, to: string) => {
      await rename(from, to)
      if (from === staging) await writeFile(join(dist, 'entry.mjs'), 'unknown partial output\n')
    },
  }), /recovery requires attention/u)
  const record = JSON.parse(await readFile(journal, 'utf8')) as { backup: string }
  await assertTree(join(directory, record.backup), oldTree)
  await assert.rejects(recoverArtifactPromotion(dist), /unknown or conflicting/u)
  assert.equal(await readFile(join(dist, 'entry.mjs'), 'utf8'), 'unknown partial output\n')
  assert.equal(await hasPendingArtifactPromotion(dist), true)
})

test('failed cleanup keeps the journal and known backup for a later retry', async t => {
  const { directory, dist, staging, journal } = await fixture(t)
  await assert.rejects(promoteArtifacts(staging, dist, {
    rm: async () => { throw new Error('injected cleanup failure') },
  }), /injected cleanup failure/u)
  const record = JSON.parse(await readFile(journal, 'utf8')) as { backup: string }
  await assertTree(join(directory, record.backup), oldTree)
  await assertTree(dist, newTree)
  await recoverArtifactPromotion(dist)
  assert.equal(await hasPendingArtifactPromotion(dist), false)
})

test('SIGKILL during recursive cleanup resumes only after a durable verification receipt', { skip: process.platform === 'win32' }, async t => {
  const { directory, dist, staging, journal } = await fixture(t)
  await crashAt(staging, dist, 'cleanup-partial')
  const record = JSON.parse(await readFile(journal, 'utf8')) as { backup: string, cleanupVerified: boolean }
  assert.equal(record.cleanupVerified, true)
  const backup = join(directory, record.backup)
  await assert.rejects(lstat(join(backup, 'entry.mjs')), { code: 'ENOENT' })
  assert.equal(await readFile(join(backup, 'types', 'entry.d.ts'), 'utf8'), oldTree['types/entry.d.ts'])
  await assertTree(dist, newTree)
  assert.equal((await recoverArtifactPromotion(dist)).outcome, 'new')
  await assertTree(dist, newTree)
  await assert.rejects(lstat(backup), { code: 'ENOENT' })
  assert.equal(await hasPendingArtifactPromotion(dist), false)
})

test('cleanup receipt cannot authorize deleting backup when installed output has changed', { skip: process.platform === 'win32' }, async t => {
  const { directory, dist, staging, journal } = await fixture(t)
  await crashAt(staging, dist, 'cleanup-partial')
  const record = JSON.parse(await readFile(journal, 'utf8')) as { backup: string }
  await writeFile(join(dist, 'entry.mjs'), 'changed after commit')
  await assert.rejects(recoverArtifactPromotion(dist), /verified installed tree changed/u)
  assert.equal(await readFile(join(directory, record.backup, 'types', 'entry.d.ts'), 'utf8'), oldTree['types/entry.d.ts'])
  assert.equal(await hasPendingArtifactPromotion(dist), true)
})

test('unjournaled backup directories are preserved by compatibility cleanup and publication', async t => {
  const { directory, dist, staging } = await fixture(t)
  const unowned = join(directory, 'dist.backup-unowned')
  await writeTree(unowned, { 'evidence.txt': 'unowned evidence' })
  await removePromotedBackup(dist)
  await promoteArtifacts(staging, dist)
  await removePromotedBackup(dist)
  await assertTree(unowned, { 'evidence.txt': 'unowned evidence' })
})

test('malformed, unsupported, and path-escaping journals fail closed without modification', async t => {
  const { dist, staging, journal } = await fixture(t)
  for (const text of ['{broken', JSON.stringify({ schemaVersion: 99 }), JSON.stringify({ schemaVersion: 1, staging: '../outside' })]) {
    await writeFile(journal, text)
    assert.equal(await hasPendingArtifactPromotion(dist), true)
    await assert.rejects(recoverArtifactPromotion(dist))
    await assert.rejects(promoteArtifacts(staging, dist))
    assert.equal(await readFile(journal, 'utf8'), text)
    await assertTree(dist, oldTree)
    await assertTree(staging, newTree)
  }
})

test('corrupt staging or backup after a crash is preserved and blocks recovery', { skip: process.platform === 'win32' }, async t => {
  for (const target of ['staging', 'backup']) {
    const { directory, dist, staging, journal } = await fixture(t)
    await crashAt(staging, dist, 'after-1')
    const record = JSON.parse(await readFile(journal, 'utf8')) as { backup: string }
    const changed = target === 'staging' ? staging : join(directory, record.backup)
    await writeFile(join(changed, 'entry.mjs'), 'changed evidence')
    await assert.rejects(recoverArtifactPromotion(dist), /tree changed/u)
    await assert.rejects(lstat(dist), { code: 'ENOENT' })
    assert.equal(await hasPendingArtifactPromotion(dist), true)
    assert.equal(await readFile(join(changed, 'entry.mjs'), 'utf8'), 'changed evidence')
  }
})

test('symlinks and non-sibling staging are rejected before publication', { skip: process.platform === 'win32' }, async t => {
  const { directory, dist, staging } = await fixture(t)
  await symlink(join(dist, 'entry.mjs'), join(staging, 'linked.mjs'))
  await assert.rejects(promoteArtifacts(staging, dist), /symlink or nonregular/u)
  await assertTree(dist, oldTree)
  assert.equal(await hasPendingArtifactPromotion(dist), false)
  await assert.rejects(promoteArtifacts(join(directory, 'nested', 'staging'), dist), /sibling/u)
})
