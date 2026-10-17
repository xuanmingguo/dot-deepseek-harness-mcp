import { lstat, readlink, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ExternalPathGrant, TaskScopeDeclaration } from './types.js'
import { RelayError } from './relay-broker/errors.js'

/** Foreign Windows drive/UNC names must not become ordinary POSIX filenames. */
export function unsupportedHostPath(path: string): boolean {
  return process.platform !== 'win32' && (/^[A-Za-z]:/u.test(path) || path.startsWith('\\\\'))
}

export function parseExternalPaths(value: unknown, label = 'externalPaths'): ExternalPathGrant[] {
  if (!Array.isArray(value) || value.length > 64) invalid(`${label} must be an array of at most 64 path grants`, label, 'invalid_type')
  return value.map((entry, index) => {
    const field = `${label}[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) invalid(`${label} entries must be path grants`, field, 'invalid_type')
    const grant = entry as Record<string, unknown>
    if (Object.keys(grant).some(key => !['path', 'access', 'kind'].includes(key))) invalid(`${label} entries contain an unknown field`, field, 'unknown_field')
    if (typeof grant.path !== 'string' || grant.path.trim() !== grant.path || grant.path.includes('\0')) invalid(`${label} requires a non-empty absolute path with no NUL`, `${field}.path`, 'invalid_path')
    if (unsupportedHostPath(grant.path)) invalid(`${label} path is not supported on this host: ${grant.path}`, `${field}.path`, 'unsupported_path_platform', grant.path)
    if (!isAbsolute(grant.path)) invalid(`${label} requires an absolute path`, `${field}.path`, 'absolute_path_required', grant.path)
    if (grant.access !== 'read' && grant.access !== 'write') invalid(`${label} requires access=read|write`, `${field}.access`, 'invalid_access')
    if (grant.kind !== 'file' && grant.kind !== 'directory') invalid(`${label} requires kind=file|directory`, `${field}.kind`, 'invalid_kind')
    return { path: resolve(grant.path), access: grant.access, kind: grant.kind }
  })
}

export function pathContains(parent: string, child: string): boolean {
  const local = relative(parent, child)
  return local === '' || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local))
}

export function grantContains(grant: ExternalPathGrant, path: string): boolean {
  return grant.kind === 'directory' ? pathContains(grant.path, path) : relative(grant.path, path) === ''
}

/** Admission check only. Native permissions and the agent's scope instructions still govern execution. */
export async function validateExternalPathPolicy(requested: ExternalPathGrant[] = [], policy: ExternalPathGrant[] = []): Promise<void> {
  if (requested.length === 0) return
  const grants = parseExternalPaths(requested)
  const allowed = parseExternalPaths(policy, 'external path policy')
  for (const [index, grant] of grants.entries()) await validateGrantPolicy(grant, allowed, `externalPaths[${index}].path`)
}

async function validateGrantPolicy(grant: ExternalPathGrant, allowed: ExternalPathGrant[], field: string): Promise<void> {
  const canonical = await canonicalGrant(grant, field)
  for (const [index, rule] of allowed.entries()) {
    if (grant.access === 'write' && rule.access !== 'write') continue
    if (grant.kind === 'directory' && rule.kind !== 'directory') continue
    // Both declared names and resolved locations must be covered. A symlink
    // cannot introduce an alias to another operator-authorized directory.
    if (!grantContains(rule, grant.path)) continue
    const resolvedRule = await canonicalGrant(rule, `external path policy[${index}].path`)
    if (grantContains(resolvedRule, canonical.path)) return
  }
  throw new RelayError('EXTERNAL_PATH_DENIED', `External ${grant.access} path is outside the configured policy: ${grant.path}`, false, { field, path: grant.path, reason: 'outside_external_policy', nextAction: 'none' })
}

export async function validateExternalTaskScope(scope: TaskScopeDeclaration | undefined, policy: ExternalPathGrant[] = [], workspace?: string): Promise<void> {
  if (scope === undefined) return
  await validateExternalPathPolicy(scope.externalPaths, policy)
  const canonicalWorkspace = workspace === undefined ? undefined : await canonicalGrant({ path: resolve(workspace), access: 'read', kind: 'directory' }, 'workspace')
  for (const [field, access] of [['reviewTargets', 'read'], ['contextReadScope', 'read'], ['writeScope', 'write']] as const) {
    for (const [index, path] of scope[field].entries()) {
      const entry = `${field}[${index}]`
      if (!isAbsolute(path) && workspace === undefined) continue
      const target = isAbsolute(path) ? path : resolve(workspace!, path)
      let info
      try { info = await stat(target) }
      catch (error) {
        if (!hasCode(error, 'ENOENT')) invalid(`Cannot resolve scope path: ${path}`, entry, 'path_unresolvable', path)
      }
      const grant: ExternalPathGrant = { path: target, access, kind: info?.isDirectory() ? 'directory' : 'file' }
      if (!isAbsolute(path)) {
        const canonical = await canonicalGrant(grant, entry)
        if (!pathContains(canonicalWorkspace!.path, canonical.path)) invalid(`Scope path escapes workspace through a symbolic link: ${path}`, entry, 'path_outside_workspace', path)
        continue
      }
      // Check referenced children as well as grant roots, including symlink children.
      await validateGrantPolicy(grant, scope.externalPaths ?? [], entry)
      await validateGrantPolicy(grant, policy, entry)
    }
  }
}

async function canonicalGrant(grant: ExternalPathGrant, field: string): Promise<ExternalPathGrant> {
  let current = grant.path
  let links = 0
  const missing: string[] = []
  while (true) {
    try {
      const path = await realpath(current)
      const info = await stat(path)
      if (missing.length === 0 && (grant.kind === 'directory' ? !info.isDirectory() : !info.isFile())) invalid(`External path does not match kind=${grant.kind}: ${grant.path}`, field, 'path_kind_mismatch', grant.path)
      if (missing.length > 0 && !info.isDirectory()) invalid(`External path parent is not a directory: ${grant.path}`, field, 'parent_not_directory', grant.path)
      return { ...grant, path: resolve(path, ...missing.slice().reverse()) }
    } catch (error) {
      if (error instanceof RelayError) throw error
      if (!hasCode(error, 'ENOENT')) invalid(`Cannot resolve scope path: ${grant.path}`, field, 'path_unresolvable', grant.path)
    }
    // realpath also returns ENOENT for a dangling symlink. Resolve that link
    // before appending missing suffixes, otherwise its future target can escape.
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        if (++links > 40) invalid(`Cannot resolve symbolic link chain: ${grant.path}`, field, 'path_unresolvable', grant.path)
        current = resolve(dirname(current), await readlink(current))
        continue
      }
    } catch (error) {
      if (error instanceof RelayError) throw error
      if (!hasCode(error, 'ENOENT')) invalid(`Cannot resolve scope path: ${grant.path}`, field, 'path_unresolvable', grant.path)
    }
    const parent = dirname(current)
    if (parent === current) invalid(`Cannot resolve scope path: ${grant.path}`, field, 'path_unresolvable', grant.path)
    missing.push(relative(parent, current))
    current = parent
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function invalid(message: string, field: string, reason: string, path?: string): never {
  throw new RelayError(field.startsWith('external path policy') ? 'INVALID_ARGUMENT' : 'TASK_SCOPE_INVALID', message, false, { field, reason, ...(path === undefined ? {} : { path }), nextAction: 'none' })
}
