import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RelayStateStore } from '../src/state-store.js'
import type { PersistedRelayState, PersistedRun, RunStatus } from '../src/types.js'

const BEFORE = '2026-08-19T00:00:29.000Z'
const STALLED_AT = '2026-08-19T00:00:30.000Z'
const RECOVERED_AT = '2026-08-19T00:00:31.000Z'
const LATER = '2026-08-19T00:00:32.000Z'

for (const order of ['attention-first', 'progress-first'] as const) {
  test(`new durable progress survives a stale stalled writer and restart (${order})`, async () => {
    await withStore(async path => {
      const attention = stalled(5)
      const progress = run('running', 6, RECOVERED_AT, 'new durable output')
      const records = order === 'attention-first' ? [attention, progress] : [progress, attention]
      await saveAll(path, records)
      const actual = await loadRun(path)
      assert.equal(actual.snapshot.status, 'running')
      assert.equal(actual.snapshot.lastEventSeq, 6)
      assert.equal(actual.snapshot.lastProgressAt, RECOVERED_AT)
      assert.equal(actual.snapshot.assistantText, 'new durable output')
      assert.equal(actual.snapshot.attentionReason, undefined)
      assert.equal(actual.snapshot.error, null)
    })
  })

  test(`projection-only progress can recover at the same event sequence (${order})`, async () => {
    await withStore(async path => {
      // Projections can progress without changing the retained text or the
      // snapshot's event high-water mark; lastProgressAt is the new evidence.
      const attention = stalled(5)
      const progress = run('running', 5, RECOVERED_AT)
      await saveAll(path, order === 'attention-first' ? [attention, progress] : [progress, attention])
      const actual = await loadRun(path)
      assert.equal(actual.snapshot.status, 'running')
      assert.equal(actual.snapshot.lastEventSeq, 5)
      assert.equal(actual.snapshot.lastProgressAt, RECOVERED_AT)
      assert.equal(actual.snapshot.attentionReason, undefined)
    })
  })

  for (const [label, sequence, progressAt] of [
    ['equal timestamp despite a higher sequence', 99, STALLED_AT],
    ['older timestamp despite a higher sequence', 99, BEFORE],
    ['sequence regression despite a later timestamp', 4, RECOVERED_AT],
  ] as const) {
    test(`stalled attention resists ${label} (${order})`, async () => {
      await withStore(async path => {
        const attention = stalled(5)
        const progress = run('running', sequence, progressAt, 'unqualified output')
        await saveAll(path, order === 'attention-first' ? [attention, progress] : [progress, attention])
        assert.deepEqual(await loadRun(path), attention)
      })
    })
  }

  for (const status of ['succeeded', 'incomplete', 'failed', 'cancelled', 'needs_attention'] as const) {
    test(`later running progress cannot demote ${status === 'needs_attention' ? 'permission failure' : status} (${order})`, async () => {
      await withStore(async path => {
        const protectedRun = run(status, 5, STALLED_AT, 'protected result')
        if (status === 'needs_attention') {
          protectedRun.snapshot.attentionReason = 'permission_restore_failed'
          protectedRun.snapshot.error = 'permission restoration failed'
        }
        const progress = run('running', 99, LATER, 'unrelated newer output')
        await saveAll(path, order === 'attention-first' ? [protectedRun, progress] : [progress, protectedRun])
        assert.deepEqual(await loadRun(path), protectedRun)
      })
    })
  }
}

test('a genuinely recovered run can re-stall after restart and resist stale running writers', async () => {
  await withStore(async path => {
    const firstStall = stalled(5)
    const recovered = run('running', 6, RECOVERED_AT, 'new durable output')
    await saveAll(path, [firstStall, recovered])
    const restarted = await loadRun(path)
    assert.equal(restarted.snapshot.status, 'running')

    // A stall records no new progress. It retains the latest progress time
    // and sequence, so the former recovery is now an equal-time stale writer.
    const secondStall = structuredClone(restarted)
    secondStall.snapshot.status = 'needs_attention'
    secondStall.snapshot.attentionReason = 'run_stalled'
    secondStall.snapshot.error = 'no durable progress after recovery'
    await saveAll(path, [secondStall, recovered, firstStall])
    assert.deepEqual(await loadRun(path), secondStall)

    const recoveredAgain = run('running', 7, LATER, 'progress after second stall')
    await saveAll(path, [recoveredAgain, secondStall])
    assert.deepEqual(await loadRun(path), recoveredAgain)
  })
})

async function withStore(check: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pr1-stalled-adversarial-'))
  try {
    await check(join(directory, 'state.json'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function saveAll(path: string, records: PersistedRun[]): Promise<void> {
  // A fresh store per write models separate stale writers rather than sharing
  // one in-memory write queue. loadRun also constructs a fresh store to restart.
  for (const record of records) {
    const state: PersistedRelayState = {
      schemaVersion: 2, services: [], runs: [record], operations: [], permissionLeases: [],
    }
    await new RelayStateStore(path).save(state)
  }
}

async function loadRun(path: string): Promise<PersistedRun> {
  const loaded = await new RelayStateStore(path).load()
  assert.equal(loaded?.runs.length, 1)
  return loaded!.runs[0]!
}

function stalled(sequence: number): PersistedRun {
  const record = run('needs_attention', sequence, STALLED_AT)
  record.snapshot.attentionReason = 'run_stalled'
  record.snapshot.error = 'no durable progress before stall timeout'
  return record
}

function run(status: RunStatus, lastEventSeq: number, lastProgressAt: string, assistantText = 'partial'): PersistedRun {
  return {
    baselineSeq: 0,
    promptRpcId: 'rpc-1',
    snapshot: {
      runId: 'run-1', serviceId: 'service-1', sessionId: 'session-1',
      sessionReused: false, parentRunId: null, workspace: 'C:\\workspace',
      webUrl: 'http://127.0.0.1:3080/?sessionId=session-1', status,
      modelSelection: null, permissionPreset: 'read-only', agentPreset: null,
      modelDefaultRestore: 'not-needed', warnings: [], task: '[prompt text not persisted]',
      taskPersisted: false, taskImageCount: 0, cancelRequested: false,
      startedAt: '2026-08-19T00:00:00.000Z', lastProgressAt,
      finishedAt: status === 'running' || status === 'needs_attention' ? null : '2026-08-19T00:01:00.000Z',
      promptAdmission: 'accepted', promptMessageId: 'message-1', assistantText,
      assistantTextBytes: Buffer.byteLength(assistantText, 'utf8'), assistantTextTruncated: false,
      lastEventSeq, error: null,
    },
  }
}
