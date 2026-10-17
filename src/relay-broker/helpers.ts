import { createHash } from 'node:crypto'
import type { RunSnapshot } from '../types.js'

export const PERMISSION_RESTORE_WARNING = 'Permission restoration requires attention before this session is reused'

export function currentRunWarnings(run: RunSnapshot): string[] {
  const resolved = run.permissionRestoration === 'complete'
    && ['succeeded', 'failed', 'incomplete', 'cancelled'].includes(run.status)
    && run.attentionReason !== 'permission_restore_failed'
  return run.warnings.filter(warning => !resolved || warning !== PERMISSION_RESTORE_WARNING)
}

export function cloneRun(run: RunSnapshot): RunSnapshot {
  return {
    ...run,
    modelSelection: run.modelSelection === null ? null : { ...run.modelSelection },
    warnings: currentRunWarnings(run),
    ...(run.executionOutcome === undefined ? {} : { executionOutcome: { ...run.executionOutcome } }),
    ...(run.taskScope === undefined ? {} : {
      taskScope: {
        ...run.taskScope,
        reviewTargets: [...run.taskScope.reviewTargets],
        contextReadScope: [...run.taskScope.contextReadScope],
        excludedPaths: [...run.taskScope.excludedPaths],
        writeScope: [...run.taskScope.writeScope],
        ...(run.taskScope.externalPaths === undefined ? {} : { externalPaths: run.taskScope.externalPaths.map(grant => ({ ...grant })) }),
      },
    }),
  }
}

export function persistedSnapshot(run: RunSnapshot, persistPromptText: boolean): RunSnapshot {
  const snapshot = cloneRun(run)
  if (persistPromptText) return snapshot
  snapshot.task = '[prompt text not persisted]'
  snapshot.taskPersisted = false
  return snapshot
}

export function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex')
}

export function delay(timeoutMs: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, timeoutMs))
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
