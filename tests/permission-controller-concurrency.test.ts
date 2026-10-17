import assert from 'node:assert/strict'
import test from 'node:test'
import { PermissionGatewayFacade } from '../src/permission-gateway/index.js'
import { PermissionController } from '../src/relay-broker/permission-controller.js'
import type { PermissionLease, PermissionPreset } from '../src/types.js'

const options = { timeout: 5_000 }

test('a shared failed restore can retry with a fresh in-flight mutation', options, async () => {
  const lease = makeLease('retry')
  const started = gate()
  const release = gate()
  let selections = 0
  let current: PermissionPreset = 'read-only'
  const persisted: string[] = []
  const controller = new PermissionController(new PermissionGatewayFacade({
    readCurrent: async () => current,
    select: async (_session, preset) => {
      selections += 1
      if (selections === 1) {
        started.open()
        await release.promise
        throw new Error('first restore denied')
      }
      current = preset
      return { accepted: true }
    },
  }), new Map([[lease.leaseId, lease]]), async () => { persisted.push(lease.state) }, 60_000)
  const pending = [controller.restoreSession(lease.sessionId, lease.ownerOperationId)]
  try {
    await bounded(started.promise)
    pending.push(controller.restoreSession(lease.sessionId, lease.ownerOperationId))
    assert.deepEqual(persisted, ['restoring'], 'concurrent callers must not start another mutation')
    release.open()
    assert.deepEqual(await bounded(Promise.all(pending)), [false, false])
    assert.equal(selections, 1)
    assert.equal(lease.state, 'needs_attention')
    assert.match(lease.error!, /first restore denied/)
    assert.equal(await bounded(controller.restoreSession(lease.sessionId, lease.ownerOperationId)), true)
    assert.equal(selections, 2, 'a failed in-flight entry must not poison a later retry')
    assert.equal(lease.state, 'released')
    assert.equal(lease.error, null)
    assert.deepEqual(persisted, ['restoring', 'needs_attention', 'restoring', 'released'])
  } finally {
    release.open()
    await bounded(Promise.allSettled(pending))
  }
})

test('an owner mismatch neither joins nor interferes with the correct owner restore', options, async () => {
  const lease = makeLease('owner')
  const started = gate()
  const release = gate()
  let selections = 0
  let persistCalls = 0
  let current: PermissionPreset = 'read-only'
  const controller = new PermissionController(new PermissionGatewayFacade({
    readCurrent: async () => current,
    select: async (_session, preset) => {
      selections += 1
      started.open()
      await release.promise
      current = preset
      return { accepted: true }
    },
  }), new Map([[lease.leaseId, lease]]), async () => { persistCalls += 1 }, 60_000)
  assert.equal(await bounded(controller.restoreSession(lease.sessionId, 'another-operation')), true)
  assert.equal(lease.state, 'acquired')
  assert.equal(selections, 0)
  assert.equal(persistCalls, 0)
  const pending = [controller.restoreSession(lease.sessionId, lease.ownerOperationId)]
  try {
    await bounded(started.promise)
    assert.equal(await bounded(controller.restoreSession(lease.sessionId, 'another-operation')), true)
    assert.equal(lease.state, 'restoring', 'a mismatched owner must leave the active restore alone')
    pending.push(controller.restoreSession(lease.sessionId, lease.ownerOperationId))
    pending.push(controller.restoreSession(lease.sessionId))
    assert.equal(persistCalls, 1, 'owner-specific and unscoped recovery must share the same lease mutation')
    release.open()
    assert.deepEqual(await bounded(Promise.all(pending)), [true, true, true])
    assert.equal(selections, 1)
    assert.equal(persistCalls, 2)
    assert.equal(lease.state, 'released')
  } finally {
    release.open()
    await bounded(Promise.allSettled(pending))
  }
})

test('a blocked restore does not serialize an independent session lease', options, async () => {
  const blockedLease = makeLease('blocked')
  const freeLease = makeLease('free')
  const started = gate()
  const release = gate()
  const current = new Map<string, PermissionPreset>([
    [blockedLease.sessionId, 'read-only'], [freeLease.sessionId, 'read-only'],
  ])
  const selections: string[] = []
  const controller = new PermissionController(new PermissionGatewayFacade({
    readCurrent: async sessionId => current.get(sessionId),
    select: async (sessionId, preset) => {
      selections.push(sessionId)
      if (sessionId === blockedLease.sessionId) {
        started.open()
        await release.promise
      }
      current.set(sessionId, preset)
      return { accepted: true }
    },
  }), new Map([blockedLease, freeLease].map(lease => [lease.leaseId, lease])), async () => {}, 60_000)
  const pending = [controller.restoreSession(blockedLease.sessionId, blockedLease.ownerOperationId)]
  try {
    await bounded(started.promise)
    const freeRestore = controller.restoreSession(freeLease.sessionId, freeLease.ownerOperationId)
    pending.push(freeRestore)
    assert.equal(await bounded(freeRestore), true, 'another lease must complete before the blocked gate opens')
    assert.equal(freeLease.state, 'released')
    assert.equal(blockedLease.state, 'restoring')
    assert.deepEqual(selections, [blockedLease.sessionId, freeLease.sessionId])
    release.open()
    assert.deepEqual(await bounded(Promise.all(pending)), [true, true])
  } finally {
    release.open()
    await bounded(Promise.allSettled(pending))
  }
})

test('a rejected initial persistence is shared and does not leave a stale in-flight restore', options, async () => {
  const lease = makeLease('persist-retry')
  const started = gate()
  const release = gate()
  const failure = new Error('initial persistence failed')
  let persistCalls = 0
  let selections = 0
  let current: PermissionPreset = 'read-only'
  const controller = new PermissionController(new PermissionGatewayFacade({
    readCurrent: async () => current,
    select: async (_session, preset) => {
      selections += 1
      current = preset
      return { accepted: true }
    },
  }), new Map([[lease.leaseId, lease]]), async () => {
    persistCalls += 1
    if (persistCalls === 1) {
      started.open()
      await release.promise
      throw failure
    }
  }, 60_000)
  const pending = [controller.restoreSession(lease.sessionId, lease.ownerOperationId)]
  try {
    await bounded(started.promise)
    pending.push(controller.restoreSession(lease.sessionId, lease.ownerOperationId))
    assert.equal(persistCalls, 1)
    assert.equal(selections, 0, 'permission selection must wait for the initial durable state')
    const rejections = pending.map(promise => assert.rejects(promise, error => error === failure))
    release.open()
    await bounded(Promise.all(rejections))
    assert.equal(await bounded(controller.restoreSession(lease.sessionId, lease.ownerOperationId)), true)
    assert.equal(selections, 1)
    assert.equal(persistCalls, 3)
    assert.equal(lease.state, 'released')
  } finally {
    release.open()
    await bounded(Promise.allSettled(pending))
  }
})

test('a caller arriving during final persistence shares its eventual failure', options, async () => {
  const lease = makeLease('terminal-persist')
  const started = gate()
  const release = gate()
  let persistCalls = 0
  let selections = 0
  let current: PermissionPreset = 'read-only'
  const controller = new PermissionController(new PermissionGatewayFacade({
    readCurrent: async () => current,
    select: async (_session, preset) => {
      selections += 1
      current = preset
      return { accepted: true }
    },
  }), new Map([[lease.leaseId, lease]]), async () => {
    persistCalls += 1
    if (persistCalls === 2) {
      started.open()
      await release.promise
      throw new Error('terminal persistence failed')
    }
  }, 60_000)
  const pending = [controller.restoreSession(lease.sessionId, lease.ownerOperationId)]
  try {
    await bounded(started.promise)
    assert.equal(lease.state, 'released', 'the race starts after the in-memory terminal state changes')
    let lateSettled = false
    pending.push(controller.restoreSession(lease.sessionId, lease.ownerOperationId).then(value => {
      lateSettled = true
      return value
    }))
    // Drain the already queued fulfillment callback; no elapsed-time assumption is needed.
    await Promise.resolve()
    assert.equal(lateSettled, false, 'late caller must await the pending terminal persistence')
    release.open()
    assert.deepEqual(await bounded(Promise.all(pending)), [false, false])
    assert.equal(selections, 1)
    assert.equal(lease.state, 'needs_attention')
    assert.match(lease.error!, /terminal persistence failed/)
  } finally {
    release.open()
    await bounded(Promise.allSettled(pending))
  }
})

test('a new run cannot acquire the session lease until the prior final persistence completes', options, async () => {
  const lease = makeLease('new-run')
  const started = gate()
  const release = gate()
  let persistCalls = 0
  let selections = 0
  let current: PermissionPreset = 'read-only'
  const controller = new PermissionController(new PermissionGatewayFacade({
    readCurrent: async () => current,
    select: async (_session, preset) => {
      selections += 1
      current = preset
      return { accepted: true }
    },
  }), new Map([[lease.leaseId, lease]]), async () => {
    persistCalls += 1
    if (persistCalls === 2) {
      started.open()
      await release.promise
    }
  }, 60_000)
  const restore = controller.restoreSession(lease.sessionId, lease.ownerOperationId)
  const pending: Promise<unknown>[] = [restore]
  try {
    await bounded(started.promise)
    const acquireWhileRestoring = controller.selectForRun(lease.sessionId, 'new-operation', 'read-only', true)
    pending.push(acquireWhileRestoring)
    await bounded(assert.rejects(acquireWhileRestoring, { code: 'PERMISSION_LEASE_CONFLICT' }))
    assert.equal(selections, 1, 'a new run must not change permission while the restore is still being persisted')
    release.open()
    assert.equal(await bounded(restore), true)
    const acquireAfterRestore = controller.selectForRun(lease.sessionId, 'new-operation', 'read-only', true)
    pending.push(acquireAfterRestore)
    const acquired = await bounded(acquireAfterRestore)
    assert.notEqual(acquired, null)
    assert.equal(acquired!.ownerOperationId, 'new-operation')
    assert.equal(acquired!.state, 'acquired')
    assert.equal(acquired!.previousPermission, 'workspace-write')
    assert.equal(selections, 2)
    assert.equal(lease.state, 'released')
  } finally {
    release.open()
    await bounded(Promise.allSettled(pending))
  }
})

function makeLease(name: string): PermissionLease {
  return {
    leaseId: `lease-${name}`,
    sessionId: `session-${name}`,
    ownerOperationId: `operation-${name}`,
    previousPermission: 'workspace-write',
    grantedPermission: 'read-only',
    expiresAt: '2099-01-01T00:00:00.000Z',
    state: 'acquired',
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('test promise did not settle within 2 seconds')), 2_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
