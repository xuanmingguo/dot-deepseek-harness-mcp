import { randomUUID } from 'node:crypto'
import { mkdir, open, rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readJsonFileStrict } from './strict-utf8.mjs'

const BUILD_LOCK_SCHEMA_VERSION = 1
const MAX_MUTATION_WAIT_MS = 5_000

export class BuildLockError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'BuildLockError'
    this.code = 'BUILD_LOCK_ERROR'
  }
}

export function processStartIdentity(pid = process.pid, uptimeMs = process.uptime() * 1000) {
  return new Date(Date.now() - uptimeMs).toISOString()
}

export function defaultProcessProbe(processId, signalProcess = process.kill) {
  if (!Number.isSafeInteger(processId) || processId <= 0) return 'unknown'
  try {
    signalProcess(processId, 0)
    return 'alive'
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead'
    if (error?.code === 'EPERM') return 'alive'
    return 'unknown'
  }
}

export async function acquireBuildLock(lockPath, options = {}) {
  const settings = lockSettings(options)
  const now = options.now ?? (() => new Date())
  const deadline = Date.now() + settings.timeoutMs
  const record = {
    schemaVersion: BUILD_LOCK_SCHEMA_VERSION,
    ownerToken: randomUUID(),
    processId: options.processId ?? process.pid,
    processStartedAt: options.processStartedAt ?? processStartIdentity(),
    acquiredAt: now().toISOString(),
  }
  await mkdir(dirname(lockPath), { recursive: true })
  while (true) {
    const acquired = await withMutationGate(lockPath, settings, deadline, async () => {
      const existing = await inspectBuildLock(lockPath)
      if (existing.present) {
        // Liveness must be proven while holding the same gate as every writer.
        // An alive PID with a different startup identity may have been reused;
        // it is deliberately never reclaimed.
        if (!existing.valid || settings.probe(existing.record.processId) !== 'dead') return false
        const outcome = await deleteMatchingLock(lockPath, existing.record)
        if (!outcome.deleted && outcome.reason !== 'missing') return false
      }
      await writeRecord(lockPath, record)
      return true
    })
    if (acquired) return buildLockLease(lockPath, record, options)
    if (Date.now() >= deadline) {
      throw new BuildLockError(`timed out acquiring build lock (the owner may still be building): ${lockPath}`)
    }
    await settings.sleep(Math.min(settings.retryMs, Math.max(1, deadline - Date.now())))
  }
}

export async function withBuildLock(lockPath, operation, options = {}) {
  const lease = await acquireBuildLock(lockPath, options)
  try {
    return await operation()
  } finally {
    await lease.release()
  }
}

export async function inspectBuildLock(lockPath) {
  try {
    const record = await readJsonFileStrict(lockPath)
    if (!isRecord(record) || typeof record.ownerToken !== 'string' || record.ownerToken.length === 0
      || !Number.isSafeInteger(record.processId) || record.processId <= 0
      || typeof record.processStartedAt !== 'string' || typeof record.acquiredAt !== 'string') {
      return { present: true, valid: false, record: null, detail: 'malformed-record' }
    }
    return { present: true, valid: true, record, detail: null }
  } catch (error) {
    if (isCode(error, 'ENOENT')) return { present: false, valid: false, record: null, detail: 'missing' }
    if (/UTF-8/u.test(error?.message ?? '')) throw error
    return { present: true, valid: false, record: null, detail: 'malformed-record' }
  }
}

/** Compare and unlink while holding the gate. A mismatch never moves the path. */
export async function reclaimBuildLock(lockPath, expected, options = {}) {
  const settings = lockSettings(options)
  await mkdir(dirname(lockPath), { recursive: true })
  return withMutationGate(lockPath, settings, Date.now() + settings.timeoutMs,
    () => deleteMatchingLock(lockPath, expected))
}

export function buildLockLease(lockPath, expected, options = {}) {
  let released = false
  let releasing
  return {
    ownerToken: expected.ownerToken,
    release: async () => {
      if (released) return false
      if (releasing) {
        await releasing
        return false
      }
      releasing = reclaimBuildLock(lockPath, expected, options)
      try {
        const outcome = await releasing
        released = true
        return outcome.deleted
      } finally {
        // In particular, failure to enter the gate does not consume the lease.
        releasing = undefined
      }
    },
  }
}

async function deleteMatchingLock(lockPath, expected) {
  const current = await inspectBuildLock(lockPath)
  if (!current.present) return { deleted: false, reason: 'missing' }
  if (!current.valid || !recordMatches(current.record, expected)) return { deleted: false, reason: 'record-changed' }
  await unlink(lockPath)
  return { deleted: true, reason: 'deleted' }
}

/**
 * The gate itself is never reclaimed, even for a dead owner. Reclaiming a gate
 * by its pathname would reproduce the same ABA race one level down. A crash
 * here therefore requires offline cleanup after all builders have stopped.
 */
async function withMutationGate(lockPath, settings, operationDeadline, operation) {
  const gatePath = `${lockPath}.mutation-gate`
  const ownerPath = join(gatePath, 'owner.json')
  const deadline = Math.min(operationDeadline, Date.now() + MAX_MUTATION_WAIT_MS)
  const owner = {
    schemaVersion: BUILD_LOCK_SCHEMA_VERSION,
    ownerToken: randomUUID(),
    processId: process.pid,
    processStartedAt: processStartIdentity(),
    acquiredAt: new Date().toISOString(),
  }
  while (true) {
    try {
      await mkdir(gatePath, { mode: 0o700 })
      break
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error
    }
    let current
    try {
      current = await inspectBuildLock(ownerPath)
    } catch (error) {
      throw gateError(gatePath, `unreadable owner metadata: ${error.message}`)
    }
    if (current.valid) {
      const status = settings.probe(current.record.processId)
      if (status !== 'alive') throw gateError(gatePath, `${status === 'dead' ? 'dead' : 'unknown'} owner`)
    }
    if (Date.now() >= deadline) {
      throw gateError(gatePath, current.valid ? 'timed out waiting for a live owner' : 'missing or malformed owner metadata')
    }
    // mkdir precedes the metadata write, and cleanup removes metadata before
    // rmdir. These harmless gaps must be allowed to complete, never stolen.
    await settings.sleep(Math.min(settings.retryMs, Math.max(1, deadline - Date.now())))
  }
  try {
    await writeRecord(ownerPath, owner)
    return await operation()
  } finally {
    // Only this successful mkdir owner removes the gate. Never recursively
    // remove an unexpected entry or another generation's metadata.
    const current = await inspectBuildLock(ownerPath)
    if (current.present && (!current.valid || !recordMatches(current.record, owner))) {
      throw gateError(gatePath, 'owner metadata changed during mutation')
    }
    if (current.present) await unlink(ownerPath)
    await rmdir(gatePath)
  }
}

function gateError(gatePath, reason) {
  return new BuildLockError(`build lock mutation gate blocked (${reason}): ${gatePath}. Never auto-remove this gate; stop all builders and lock users, verify none remain, then remove the orphaned gate offline and retry.`)
}

async function writeRecord(path, record) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: 'utf8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function lockSettings(options) {
  return {
    timeoutMs: positiveInteger(options.timeoutMs ?? 900_000, 'timeoutMs'),
    retryMs: positiveInteger(options.retryMs ?? 100, 'retryMs'),
    probe: options.probe ?? defaultProcessProbe,
    sleep: options.sleep ?? delay,
  }
}

function recordMatches(left, right) {
  return isRecord(left) && isRecord(right)
    && left.ownerToken === right.ownerToken
    && left.processId === right.processId
    && left.processStartedAt === right.processStartedAt
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}

function isCode(error, code) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function delay(timeoutMs) {
  return new Promise(resolve => setTimeout(resolve, timeoutMs))
}
