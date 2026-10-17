import { isAbsolute, relative, resolve } from 'node:path'
import type { ExternalPathGrant, PermissionPreset, PromptPart, TaskScopeDeclaration } from '../types.js'
import { grantContains, parseExternalPaths, pathContains, unsupportedHostPath } from '../external-paths.js'
import type { SessionMode } from '../session-routing/index.js'
import { RelayError } from './errors.js'

export interface StartRunInput {
  task?: string
  content?: PromptPart[]
  workspace: string
  sessionId?: string
  sessionMode?: SessionMode
  provider?: string
  model?: string
  reasoningEffort?: string
  agentPreset?: string
  permissionPreset?: PermissionPreset
  openBrowser?: boolean
  parentRunId?: string
  idempotencyKey?: string
  confirmedDangerousPermission?: boolean
  operationKind?: 'start' | 'reply'
  reviewTargets?: string[]
  contextReadScope?: string[]
  excludedPaths?: string[]
  writeScope?: string[]
  externalPaths?: ExternalPathGrant[] | undefined
  authorizationBasis?: 'explicit-user-request'
}

export function validateStartRunInput(input: StartRunInput): void {
  if (input.sessionId !== undefined && input.sessionMode !== undefined) {
    throw new RelayError('INVALID_ARGUMENT', 'sessionId and sessionMode cannot be supplied together', false)
  }
  if ((input.provider === undefined) !== (input.model === undefined)) throw new RelayError('INVALID_ARGUMENT', 'provider and model must be supplied together', false)
  if (input.reasoningEffort !== undefined && (input.provider === undefined || input.model === undefined)) {
    throw new RelayError('INVALID_ARGUMENT', 'reasoningEffort requires provider and model', false)
  }
  if (input.permissionPreset === 'danger-full-access' && input.confirmedDangerousPermission !== true) {
    throw new RelayError('DANGEROUS_PERMISSION_CONFIRMATION_REQUIRED', 'danger-full-access requires confirmedDangerousPermission=true', false, { nextAction: 'confirm' })
  }
  resolveTaskScope(input)
}

export function resolveTaskScope(input: StartRunInput): TaskScopeDeclaration | undefined {
  const supplied = [input.reviewTargets, input.contextReadScope, input.excludedPaths, input.writeScope, input.externalPaths]
    .some(value => value !== undefined)
  if (!supplied) return undefined
  if (input.reviewTargets === undefined || (Array.isArray(input.reviewTargets) && input.reviewTargets.length === 0)) {
    invalidScope('reviewTargets', 'required', 'reviewTargets is required when a structured task scope is supplied')
  }
  if (input.contextReadScope === undefined || (Array.isArray(input.contextReadScope) && input.contextReadScope.length === 0)) {
    invalidScope('contextReadScope', 'required', 'contextReadScope is required when a structured task scope is supplied')
  }
  const externalPaths = input.externalPaths === undefined ? [] : parseExternalPaths(input.externalPaths)
  const externalWrite = externalPaths.findIndex(grant => grant.access === 'write')
  if ((input.permissionPreset ?? 'read-only') === 'read-only' && externalWrite !== -1) invalidScope(`externalPaths[${externalWrite}].access`, 'read_only_write', 'read-only tasks cannot declare external write grants')
  if (input.permissionPreset === 'workspace-write' && externalWrite !== -1) throw new RelayError('EXTERNAL_WRITE_REQUIRES_FULL_ACCESS', 'External writes require danger-full-access; Harness exposes no per-run additional writable roots', false, { field: `externalPaths[${externalWrite}].access`, reason: 'external_write_requires_full_access', nextAction: 'none' })
  const scope: TaskScopeDeclaration = {
    reviewTargets: normalizePaths(input.workspace, input.reviewTargets, 'reviewTargets', externalPaths),
    contextReadScope: normalizePaths(input.workspace, input.contextReadScope, 'contextReadScope', externalPaths),
    excludedPaths: normalizePaths(input.workspace, input.excludedPaths ?? [], 'excludedPaths', externalPaths),
    writeScope: normalizePaths(input.workspace, input.writeScope ?? [], 'writeScope', externalPaths.filter(grant => grant.access === 'write')),
    ...(input.externalPaths === undefined ? {} : { externalPaths }),
    enforcement: 'instruction-only',
  }
  for (const [index, target] of scope.reviewTargets.entries()) {
    if (!scope.contextReadScope.some(context => containsPath(context, target))) {
      invalidScope(`reviewTargets[${index}]`, 'target_outside_context', `reviewTargets entry is outside contextReadScope: ${target}`, target)
    }
    if (scope.excludedPaths.some(excluded => containsPath(excluded, target))) {
      invalidScope(`reviewTargets[${index}]`, 'target_excluded', `reviewTargets entry is excluded: ${target}`, target)
    }
  }
  if ((input.permissionPreset ?? 'read-only') === 'read-only' && scope.writeScope.length > 0) {
    invalidScope('writeScope', 'read_only_write', 'writeScope must be empty when permissionPreset is read-only')
  }
  if ((input.permissionPreset ?? 'read-only') !== 'read-only' && scope.writeScope.length === 0) {
    invalidScope('writeScope', 'required', 'writeScope is required for a structured write-capable task scope')
  }
  return scope
}

function containsPath(parent: string, child: string): boolean {
  return isAbsolute(parent) === isAbsolute(child) && pathContains(parent, child)
}

export function inheritTaskScope(input: StartRunInput, inherited?: TaskScopeDeclaration): StartRunInput {
  const supplied = [input.reviewTargets, input.contextReadScope, input.excludedPaths, input.writeScope, input.externalPaths]
    .some(value => value !== undefined)
  if (inherited === undefined) return input
  if (!supplied) return {
    ...input,
    reviewTargets: [...inherited.reviewTargets],
    contextReadScope: [...inherited.contextReadScope],
    excludedPaths: [...inherited.excludedPaths],
    writeScope: [...inherited.writeScope],
    ...(inherited.externalPaths === undefined ? {} : { externalPaths: inherited.externalPaths.map(grant => ({ ...grant })) }),
  }
  return {
    ...input,
    reviewTargets: [...(input.reviewTargets ?? inherited.reviewTargets)],
    contextReadScope: [...(input.contextReadScope ?? inherited.contextReadScope)],
    excludedPaths: [...(input.excludedPaths ?? inherited.excludedPaths)],
    writeScope: [...(input.writeScope ?? inherited.writeScope)],
    ...(input.externalPaths === undefined && inherited.externalPaths === undefined ? {} : { externalPaths: (input.externalPaths ?? inherited.externalPaths)!.map(grant => ({ ...grant })) }),
  }
}

function normalizePaths(workspace: string, values: string[], field: string, grants: ExternalPathGrant[]): string[] {
  if (!Array.isArray(values)) invalidScope(field, 'invalid_type', `${field} must be an array of paths`)
  const root = resolve(workspace)
  return [...new Set(values.map((value, index) => {
    const entry = `${field}[${index}]`
    if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) invalidScope(entry, 'invalid_path', `${field} entries must be non-empty strings and contain no NUL`)
    if (unsupportedHostPath(value)) invalidScope(entry, 'unsupported_path_platform', `${field} path is not supported on this host: ${value}`, value)
    const target = resolve(root, value)
    const local = relative(root, target)
    if (local === '..' || local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(local)) {
      if (isAbsolute(value) && grants.some(grant => grantContains(grant, target))) return scopePath(target)
      invalidScope(entry, 'path_outside_workspace', `${field} path escapes workspace: ${value}`, value)
    }
    return local === '' ? '.' : scopePath(local)
  }))]
}

function scopePath(path: string): string { return process.platform === 'win32' ? path.replaceAll('\\', '/') : path }

function invalidScope(field: string, reason: string, message: string, path?: string): never {
  throw new RelayError('TASK_SCOPE_INVALID', message, false, { field, reason, ...(path === undefined ? {} : { path }), nextAction: 'none' })
}

export function operationRequest(input: StartRunInput, summary: string, imageCount: number): object {
  const taskScope = resolveTaskScope(input)
  return {
    workspace: input.workspace,
    sessionId: input.sessionId ?? null,
    sessionMode: input.sessionMode ?? 'fresh',
    provider: input.provider ?? null,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    agentPreset: input.agentPreset ?? null,
    permissionPreset: input.permissionPreset ?? 'read-only',
    parentRunId: input.parentRunId ?? null,
    ...(taskScope === undefined ? {} : { taskScope }),
    ...(input.authorizationBasis === undefined ? {} : { authorizationBasis: input.authorizationBasis }),
    summary,
    imageCount,
  }
}
