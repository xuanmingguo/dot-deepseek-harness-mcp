import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import type { SettingsDescription } from '../src/harness-gateway/index.js'
import { ModelSelectionFacade } from '../src/model-selection.js'
import type { ModelSelection } from '../src/types.js'

const previous = { provider: 'original-provider', model: 'original-model', reasoningEffort: 'high' }
const selected = { provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'xhigh' }
const userChoice = { provider: 'user-provider', model: 'user-model', reasoningEffort: 'low' }

class DelayedSettingsGateway {
  revision = 9
  user: Record<string, unknown> = { ...previous }
  describes = 0
  selections = 0
  writes: Array<{ kind: 'replace' | 'unset'; expectedRevision: number; section?: Record<string, unknown> }> = []
  onSelect?: () => void
  beforeReplace?: () => void
  async describeSettings(): Promise<SettingsDescription> {
    this.describes += 1
    return { writable: true, namespaces: [{ ns: 'agent-default-model', user: structuredClone(this.user), revision: this.revision }] }
  }
  async selectSessionModel(sessionId: string, _selection: ModelSelection): Promise<ModelSelection> {
    assert.equal(sessionId, 'synthetic-session')
    this.selections += 1
    this.onSelect?.()
    // Match native normalization, which can resolve an omitted effort.
    return { ...selected }
  }
  async replaceSettings(namespace: string, section: Record<string, unknown>, expectedRevision: number): Promise<void> {
    assert.equal(namespace, 'agent-default-model')
    this.beforeReplace?.()
    this.writes.push({ kind: 'replace', section: structuredClone(section), expectedRevision })
    if (this.revision !== expectedRevision) throw new Error('settings revision conflict')
    this.user = structuredClone(section)
    this.revision += 1
  }
  async mutateSettings(_namespace: string, _ops: Array<Record<string, unknown>>, expectedRevision: number): Promise<void> {
    this.writes.push({ kind: 'unset', expectedRevision })
    if (this.revision !== expectedRevision) throw new Error('settings revision conflict')
    this.user = {}
    this.revision += 1
  }
}

test('observes native delayed persistence before CAS-restoring the previous default', async () => {
  const gateway = new DelayedSettingsGateway()
  let backgroundSave: Promise<void> | undefined
  gateway.onSelect = () => {
    backgroundSave = delay(40).then(() => { gateway.user = { ...selected }; gateway.revision = 10 })
  }
  const result = await new ModelSelectionFacade(gateway).select('synthetic-session', { provider: selected.provider, model: selected.model })
  await backgroundSave
  assert.equal(result.restore, 'restored')
  assert.deepEqual(result.selected, selected)
  assert.deepEqual(gateway.user, previous)
  assert.deepEqual(gateway.writes, [{ kind: 'replace', section: previous, expectedRevision: 10 }])
  assert(gateway.describes >= 3, 'must re-read after the initial unchanged revision')
  assert.equal(gateway.selections, 1, 'never replay selectModel to force persistence')
})

test('preserves a concurrent user value at old revision plus one while waiting for persistence', async () => {
  const gateway = new DelayedSettingsGateway()
  let userUpdate: Promise<void> | undefined
  gateway.onSelect = () => {
    userUpdate = delay(40).then(() => { gateway.user = { ...userChoice }; gateway.revision = 10 })
  }
  const result = await new ModelSelectionFacade(gateway).select('synthetic-session', selected)
  await userUpdate
  assert.equal(result.restore, 'skipped-concurrent-change')
  assert.deepEqual(gateway.user, userChoice)
  assert.deepEqual(gateway.writes, [])
  assert.equal(gateway.selections, 1)
})

test('preserves advanced revisions even when the value matches this selection', async () => {
  const gateway = new DelayedSettingsGateway()
  gateway.onSelect = () => { gateway.user = { ...selected }; gateway.revision = 11 }
  const result = await new ModelSelectionFacade(gateway).select('synthetic-session', selected)
  assert.equal(result.restore, 'skipped-concurrent-change')
  assert.deepEqual(gateway.writes, [])
  assert.equal(gateway.revision, 11)
})

test('preserves concurrent extra default fields rather than matching only model identity', async () => {
  const gateway = new DelayedSettingsGateway()
  gateway.onSelect = () => { gateway.user = { ...selected, concurrentUserField: true }; gateway.revision = 10 }
  const result = await new ModelSelectionFacade(gateway).select('synthetic-session', selected)
  assert.equal(result.restore, 'skipped-concurrent-change')
  assert.deepEqual(gateway.writes, [])
  assert.equal(gateway.user.concurrentUserField, true)
})

test('CAS rejection preserves a user update arriving between observation and restoration', async () => {
  const gateway = new DelayedSettingsGateway()
  gateway.onSelect = () => { gateway.user = { ...selected }; gateway.revision = 10 }
  gateway.beforeReplace = () => { gateway.user = { ...userChoice }; gateway.revision = 11 }
  const result = await new ModelSelectionFacade(gateway).select('synthetic-session', selected)
  assert.equal(result.restore, 'skipped-concurrent-change')
  assert.deepEqual(gateway.user, userChoice)
  assert.equal(gateway.writes[0]?.expectedRevision, 10)
})

test('matching original default needs no observation or restore write', async () => {
  const gateway = new DelayedSettingsGateway()
  gateway.user = { ...selected }
  const result = await new ModelSelectionFacade(gateway).select('synthetic-session', selected)
  assert.equal(result.restore, 'not-needed')
  assert.deepEqual(result.warnings, [])
  assert.equal(gateway.describes, 1)
  assert.equal(gateway.selections, 1)
  assert.deepEqual(gateway.writes, [])
})

test('unobserved background save terminates with explicit uncertainty and no settings write', { timeout: 5_000 }, async () => {
  const gateway = new DelayedSettingsGateway()
  const result = await new ModelSelectionFacade(gateway).select('synthetic-session', selected)
  assert.equal(result.restore, 'unavailable')
  assert.match(result.warnings.join(' '), /bounded observation window.*later native background save remains possible/)
  assert.equal(gateway.describes, 8, 'one baseline and seven bounded observations')
  assert.equal(gateway.selections, 1)
  assert.deepEqual(gateway.writes, [])
  assert.deepEqual(gateway.user, previous)
})
