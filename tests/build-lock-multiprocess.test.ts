import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireBuildLock, defaultProcessProbe, inspectBuildLock, reclaimBuildLock } from '../scripts/build-lock.mjs'

const moduleUrl = new URL('../scripts/build-lock.mjs', import.meta.url).href
const childSource = `
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
const { acquireBuildLock, inspectBuildLock, reclaimBuildLock } = await import(${JSON.stringify(moduleUrl)})
const [directory, mode, id] = process.argv.slice(2)
const lockPath = join(directory, 'build.lock')
const queued = []
let waiter
process.on('message', message => {
  if (waiter) { const resolve = waiter; waiter = undefined; resolve(message) }
  else queued.push(message)
})
const command = () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => { waiter = resolve })
const send = message => process.send(message)
try {
  if (mode === 'stale') {
    const expected = (await inspectBuildLock(lockPath)).record
    assert.ok(expected)
    send({ event: 'ready' })
    await command()
    const token = expected.ownerToken
    Object.defineProperty(expected, 'ownerToken', { get() {
      writeFileSync(join(directory, id + '.comparing'), '')
      const deadline = Date.now() + 8000
      while (!existsSync(join(directory, id + '.resume'))) {
        if (Date.now() > deadline) throw new Error('comparison barrier timed out')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
      return token
    } })
    const outcome = await reclaimBuildLock(lockPath, expected, { timeoutMs: 4000, retryMs: 2 })
    send({ event: 'done', outcome })
  } else if (mode === 'holder' || mode === 'crash') {
    const lease = await acquireBuildLock(lockPath, { timeoutMs: 4000, retryMs: 2 })
    if (mode === 'crash') { send({ event: 'acquired' }); process.exit(0) }
    await mkdir(join(directory, 'critical'))
    let watching = true
    let samples = 0
    const monitor = (async () => {
      while (watching) {
        const record = JSON.parse(await readFile(lockPath, 'utf8'))
        assert.equal(record.ownerToken, lease.ownerToken, 'holder lock disappeared or changed')
        samples++
        await new Promise(resolve => setImmediate(resolve))
      }
    })()
    send({ event: 'acquired', ownerToken: lease.ownerToken })
    await command()
    watching = false
    await monitor
    await rm(join(directory, 'critical'), { recursive: true })
    assert.equal(await lease.release(), true)
    send({ event: 'released', samples })
  } else if (mode === 'contender') {
    send({ event: 'ready' })
    await command()
    await assert.rejects(acquireBuildLock(lockPath, { timeoutMs: 100, retryMs: 2 }), { name: 'BuildLockError' })
    send({ event: 'blocked' })
    await command()
    const lease = await acquireBuildLock(lockPath, { timeoutMs: 4000, retryMs: 2 })
    await mkdir(join(directory, 'critical'))
    send({ event: 'acquired' })
    await command()
    await rm(join(directory, 'critical'), { recursive: true })
    assert.equal(await lease.release(), true)
    send({ event: 'released' })
  }
  process.disconnect()
} catch (error) {
  send({ event: 'error', message: error.stack })
  process.exitCode = 1
  process.disconnect()
}
`

type Message = { event: string; ownerToken?: string; outcome?: { deleted: boolean; reason: string }; samples?: number; message?: string }

async function fixture(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-build-gate-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'worker.mjs'), childSource)
  return directory
}

function worker(t: test.TestContext, directory: string, mode: string, id: string) {
  const child: ChildProcess = fork(join(directory, 'worker.mjs'), [directory, mode, id], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const messages: Message[] = []
  const waiters: Array<() => void> = []
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  child.on('message', message => {
    messages.push(message as Message)
    for (const wake of waiters.splice(0)) wake()
  })
  child.on('exit', () => { for (const wake of waiters.splice(0)) wake() })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await once(child, 'exit')
    }
  })
  return {
    child,
    send: () => child.send('continue'),
    next: async (event: string): Promise<Message> => {
      const deadline = Date.now() + 10_000
      while (true) {
        const error = messages.find(message => message.event === 'error')
        assert.equal(error, undefined, error?.message)
        const index = messages.findIndex(message => message.event === event)
        if (index >= 0) return messages.splice(index, 1)[0]!
        assert.equal(child.exitCode, null, `child exited before ${event}: ${stderr}`)
        assert.ok(Date.now() < deadline, `waiting for ${id}: ${event}; ${stderr}`)
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { const index = waiters.indexOf(wake); if (index >= 0) waiters.splice(index, 1); resolve() }, 20)
          const wake = () => { clearTimeout(timer); resolve() }
          waiters.push(wake)
        })
      }
    },
  }
}

async function waitComparing(directory: string, ids: string[]): Promise<string> {
  const deadline = Date.now() + 5_000
  while (true) {
    const names = await readdir(directory)
    const ready = ids.find(id => names.includes(`${id}.comparing`))
    if (ready) return ready
    assert.ok(Date.now() < deadline, 'stale reclaimer did not reach comparison barrier')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function record(ownerToken: string, processId = process.pid) {
  return { schemaVersion: 1, ownerToken, processId, processStartedAt: '2000-01-01T00:00:00.000Z', acquiredAt: '2000-01-01T00:00:00.000Z' }
}

async function writeRecord(path: string, ownerToken: string, processId = process.pid) {
  const value = record(ownerToken, processId)
  await writeFile(path, JSON.stringify(value))
  return value
}

test('two stale reclaimers cannot move C’s live lock or admit D while comparing obsolete identities', { timeout: 15_000 }, async t => {
  const directory = await fixture(t)
  const lockPath = join(directory, 'build.lock')
  const stale = await writeRecord(lockPath, 'stale', 2_147_483_647)
  const a = worker(t, directory, 'stale', 'a')
  const b = worker(t, directory, 'stale', 'b')
  await Promise.all([a.next('ready'), b.next('ready')])
  assert.equal((await reclaimBuildLock(lockPath, stale)).deleted, true)
  const c = worker(t, directory, 'holder', 'c')
  const owner = await c.next('acquired')
  const d = worker(t, directory, 'contender', 'd')
  await d.next('ready')
  a.send()
  b.send()
  const first = await waitComparing(directory, ['a', 'b'])
  d.send()
  await d.next('blocked')
  for (let sample = 0; sample < 20; sample++) {
    assert.equal((await inspectBuildLock(lockPath)).record?.ownerToken, owner.ownerToken)
  }
  await writeFile(join(directory, `${first}.resume`), '')
  const second = first === 'a' ? 'b' : 'a'
  await waitComparing(directory, [second])
  assert.equal((await inspectBuildLock(lockPath)).record?.ownerToken, owner.ownerToken)
  await writeFile(join(directory, `${second}.resume`), '')
  const outcomes = await Promise.all([a.next('done'), b.next('done')])
  for (const result of outcomes) assert.deepEqual(result.outcome, { deleted: false, reason: 'record-changed' })
  c.send()
  assert.ok((await c.next('released')).samples! > 0)
  d.send()
  await d.next('acquired')
  d.send()
  await d.next('released')
  assert.equal((await inspectBuildLock(lockPath)).present, false)
  assert.equal((await readdir(directory)).some(name => name.includes('.stale-')), false)
})

test('release racing a stale reclaimer can retry a gate timeout and concurrent release deletes only once', { timeout: 10_000 }, async t => {
  const directory = await fixture(t)
  const lockPath = join(directory, 'build.lock')
  const first = await acquireBuildLock(lockPath, { timeoutMs: 150, retryMs: 2 })
  const stale = worker(t, directory, 'stale', 'stale-release')
  await stale.next('ready')
  assert.equal(await first.release(), true)
  const current = await acquireBuildLock(lockPath, { timeoutMs: 100, retryMs: 2 })
  stale.send()
  await waitComparing(directory, ['stale-release'])
  const blocked = await Promise.allSettled([current.release(), current.release()])
  assert.ok(blocked.every(result => result.status === 'rejected' && /mutation gate blocked/u.test(String(result.reason))))
  assert.equal((await inspectBuildLock(lockPath)).record?.ownerToken, current.ownerToken)
  await writeFile(join(directory, 'stale-release.resume'), '')
  assert.equal((await stale.next('done')).outcome?.deleted, false)
  assert.deepEqual(await Promise.all([current.release(), current.release()]), [true, false])
  assert.equal(await current.release(), false)
})

test('a builder crashed outside the gate is recovered using its actually dead PID', { timeout: 10_000 }, async t => {
  const directory = await fixture(t)
  const lockPath = join(directory, 'build.lock')
  const crashed = worker(t, directory, 'crash', 'crash')
  const exited = once(crashed.child, 'exit')
  await crashed.next('acquired')
  await exited
  assert.equal(defaultProcessProbe(crashed.child.pid), 'dead')
  const next = await acquireBuildLock(lockPath, { timeoutMs: 500, retryMs: 2 })
  assert.equal(await next.release(), true)
})

test('unknown and reused live main owner PIDs fail closed and preserve the record', async t => {
  const directory = await fixture(t)
  const lockPath = join(directory, 'build.lock')
  await writeRecord(lockPath, 'unknown')
  await assert.rejects(acquireBuildLock(lockPath, { timeoutMs: 30, retryMs: 2, probe: () => 'unknown' }), /timed out acquiring build lock/u)
  assert.equal((await inspectBuildLock(lockPath)).record?.ownerToken, 'unknown')
  await writeRecord(lockPath, 'reused-live-pid')
  await assert.rejects(acquireBuildLock(lockPath, { timeoutMs: 30, retryMs: 2 }), /timed out acquiring build lock/u)
  assert.equal((await inspectBuildLock(lockPath)).record?.ownerToken, 'reused-live-pid')
})

test('dead, unknown, missing, malformed and live mutation gates are never reclaimed', async t => {
  const directory = await fixture(t)
  const lockPath = join(directory, 'build.lock')
  const gatePath = `${lockPath}.mutation-gate`
  const ownerPath = join(gatePath, 'owner.json')
  const original = await writeRecord(lockPath, 'preserved')
  for (const kind of ['dead', 'unknown', 'missing', 'malformed', 'live']) {
    await mkdir(gatePath)
    if (kind === 'malformed') await writeFile(ownerPath, '{invalid')
    else if (kind !== 'missing') await writeRecord(ownerPath, `gate-${kind}`, kind === 'dead' ? 2_147_483_647 : process.pid)
    const options = { timeoutMs: 30, retryMs: kind === 'live' ? 10_000 : 2, ...(kind === 'unknown' ? { probe: () => 'unknown' } : {}) }
    await assert.rejects(acquireBuildLock(lockPath, options), /mutation gate blocked.*stop all builders.*offline/u)
    await assert.rejects(reclaimBuildLock(lockPath, original, options), /mutation gate blocked/u)
    assert.equal((await inspectBuildLock(lockPath)).record?.ownerToken, 'preserved')
    assert.equal((await readdir(directory)).includes('build.lock.mutation-gate'), true)
    // Offline cleanup is restricted to this isolated fixture after operations end.
    await rm(gatePath, { recursive: true })
  }
})
