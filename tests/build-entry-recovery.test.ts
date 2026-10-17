import assert from 'node:assert/strict'
import { execFile, fork } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const source = fileURLToPath(new URL('../', import.meta.url))
test('the actual build entry recovers a killed publication before a later compilation failure', { timeout: 20_000, skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-entry-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dist = join(root, 'dist'), staging = join(root, 'staging-interrupted')
  for (const [directory, marker] of [[dist, 'old'], [staging, 'new']]) {
    await mkdir(join(directory!, 'types'), { recursive: true })
    await writeFile(join(directory!, 'artifact.mjs'), marker!)
    await writeFile(join(directory!, 'types/index.d.ts'), marker!)
  }
  const childPath = join(root, 'interrupt.mjs')
  await writeFile(childPath, `
    import { rename } from 'node:fs/promises'
    import { acquireBuildLock, promoteArtifacts } from ${JSON.stringify(new URL('../scripts/build-lib.mjs', import.meta.url).href)}
    process.on('message', () => {})
    const lease = await acquireBuildLock(${JSON.stringify(join(root, '.build-lock'))})
    await promoteArtifacts(${JSON.stringify(staging)}, ${JSON.stringify(dist)}, { rename: async (from, to) => {
      await rename(from, to)
      if (from === ${JSON.stringify(dist)}) {
        process.send('old-moved')
        await new Promise(() => {})
      }
    } })
    await lease.release()
  `)
  const child = fork(childPath, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
  })
  const ready = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(([code]) => { throw new Error(`publication fixture exited before its barrier: ${code}`) }),
  ])
  assert.equal(ready[0], 'old-moved')
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  await assert.rejects(readFile(join(dist, 'artifact.mjs')), { code: 'ENOENT' })

  for (const name of ['build.mjs', 'build-lib.mjs', 'build-lock.mjs', 'artifact-publication.mjs', 'strict-utf8.mjs']) {
    const destination = join(root, 'scripts', name)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(source, 'scripts', name), destination)
  }
  await writeFile(join(root, 'version.json'), '{"version":"1.0.0"}\n')
  await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'dir')
  // Deliberately omit src: compilation fails, but startup recovery must already
  // have repaired the missing entry using the original transaction fingerprint.
  await assert.rejects(promisify(execFile)(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: root }), error => {
    assert.equal((error as { code?: number }).code, 1)
    return true
  })
  assert.equal(await readFile(join(dist, 'artifact.mjs'), 'utf8'), 'old')
  assert.equal(await readFile(join(dist, 'types/index.d.ts'), 'utf8'), 'old')
  await assert.rejects(readFile(`${dist}.promotion.json`), { code: 'ENOENT' })
})
