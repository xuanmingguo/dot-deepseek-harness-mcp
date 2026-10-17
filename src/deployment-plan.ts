import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'
import type { StartRunInput } from './relay-broker/index.js'
import type { ExternalPathGrant } from './types.js'

export interface DeploymentSpec {
  workspace: string
  objective: string
  files: { source: string; target: string; host?: string | undefined; sourceSha256?: string | undefined }[]
  backupDirectory: string
  receiptPath: string
  preflightChecks: string[]
  applySteps: string[]
  verificationChecks: string[]
  rollbackSteps: string[]
  contextPaths?: string[] | undefined
  writePaths?: string[] | undefined
  externalPaths?: ExternalPathGrant[] | undefined
}

export interface PreparedDeployment {
  input: StartRunInput
  manifest: DeploymentSpec
  checksExecuted: false
  executionStatus: 'not_started'
}

/** Builds instructions and path references only; performs no I/O or execution. */
export function prepareDeployment(spec: DeploymentSpec): PreparedDeployment {
  if (spec === null || typeof spec !== 'object') throw new Error('deployment spec must be an object')
  if (typeof spec.workspace !== 'string' || !isAbsolute(spec.workspace)) throw new Error('workspace must be an absolute path')
  const workspace = resolve(text(spec.workspace, 'workspace', 4096))
  const objective = text(spec.objective, 'objective', 4096)
  if (!Array.isArray(spec.files) || spec.files.length === 0 || spec.files.length > 256) {
    throw new Error('files must contain between 1 and 256 mappings')
  }
  const files = spec.files.map((file, index) => {
    if (file === null || typeof file !== 'object') throw new Error(`files[${index}] must be a mapping`)
    const source = normalizePath(workspace, file.source, `files[${index}].source`, true, true)
    const host = file.host === undefined ? undefined : text(file.host, `files[${index}].host`, 253)
    if (host !== undefined && !/^[a-z\d][a-z\d._-]*$/iu.test(host)) throw new Error('Remote host must be an exact existing SSH alias or hostname, without shell syntax')
    const target = host === undefined ? normalizePath(workspace, file.target, `files[${index}].target`, false, true) : remotePath(file.target)
    if (file.sourceSha256 !== undefined && (typeof file.sourceSha256 !== 'string' || !/^[a-f\d]{64}$/iu.test(file.sourceSha256))) {
      throw new Error(`files[${index}].sourceSha256 must be a 64-character SHA-256 hex digest`)
    }
    return { source, target, ...(host === undefined ? {} : { host }), ...(file.sourceSha256 === undefined ? {} : { sourceSha256: file.sourceSha256.toLowerCase() }) }
  })
  const sources = new Set(files.map(file => identity(workspace, file.source)))
  const targets = new Set<string>()
  for (const file of files) {
    const target = file.host === undefined ? identity(workspace, file.target) : `${file.host}:${file.target}`
    if (targets.has(target)) throw new Error(`duplicate deployment target: ${file.target}`)
    if (sources.has(target)) throw new Error(`deployment source-target collision: ${file.target}`)
    targets.add(target)
  }
  const backupDirectory = normalizePath(workspace, spec.backupDirectory, 'backupDirectory', false, false)
  const receiptPath = normalizePath(workspace, spec.receiptPath, 'receiptPath', true, true)
  const receipt = identity(workspace, receiptPath)
  if (sources.has(receipt) || targets.has(receipt) || receipt === identity(workspace, backupDirectory)) {
    throw new Error('receiptPath must be distinct from sources, targets, and backupDirectory')
  }
  const manifest: DeploymentSpec = {
    workspace, objective, files, backupDirectory, receiptPath,
    preflightChecks: steps(spec.preflightChecks, 'preflightChecks'),
    applySteps: steps(spec.applySteps, 'applySteps'),
    verificationChecks: steps(spec.verificationChecks, 'verificationChecks'),
    rollbackSteps: steps(spec.rollbackSteps, 'rollbackSteps'),
    ...(spec.contextPaths === undefined ? {} : { contextPaths: extraPaths(workspace, spec.contextPaths, 'contextPaths') }),
    ...(spec.writePaths === undefined ? {} : { writePaths: extraPaths(workspace, spec.writePaths, 'writePaths') }),
    ...(spec.externalPaths === undefined ? {} : { externalPaths: grants(spec.externalPaths) }),
  }
  const input: StartRunInput = {
    workspace,
    permissionPreset: 'danger-full-access',
    reviewTargets: unique(files.map(file => file.source)),
    contextReadScope: unique([...files.flatMap(file => file.host === undefined ? [file.source, file.target] : [file.source]), backupDirectory, receiptPath, ...(manifest.contextPaths ?? []), ...(manifest.writePaths ?? [])]),
    writeScope: unique([...files.filter(file => file.host === undefined).map(file => file.target), backupDirectory, receiptPath, ...(manifest.writePaths ?? [])]),
    ...(manifest.externalPaths === undefined ? {} : { externalPaths: manifest.externalPaths.map(grant => ({ ...grant })) }),
    task: [
      'Execute this bounded deployment through the existing Harness runtime. The JSON below contains path references and instructions, not source contents. Preparation executed no checks; execution has not started.',
      'Preflight every mapping and every listed preflight check before making deployment changes. Resolve actual paths and confirm the declared read/write scopes and external path grants cover them. Require each source and existing target to be a regular file; reject symlink escapes, ambiguous paths, and unsafe source/target/backup/receipt overlaps. Require receiptPath to be a workspace-relative regular intended file, not a directory or symlink.',
      'Compute and record SHA-256 hashes of every mapped source and every existing target before apply; record absent targets explicitly. Compare each supplied sourceSha256 with the actual source hash and stop on any mismatch. Recheck sources before apply if they may have changed.',
      'Before any apply step, back up ALL existing mapped targets under backupDirectory using distinct recoverable names, record original paths and hashes, and verify every backup. Record absent targets so rollback can remove only files created by this deployment. Do not overwrite unrelated backups. Stop before apply if any preflight, hash, or backup fails.',
      'Perform only the listed applySteps, including only the service or remote operations explicitly listed there. Do not invent additional deployment, service, remote, provider, credential, or control-plane changes. Preserve unrelated tasks, sessions, files, and services.',
      'A mapping with host names a remote deployment target on that exact existing SSH alias/host; its target is NOT a local path. Use only the existing authorized remote route and listed steps, never create credentials or another runtime. Preflight, back up, hash, apply and verify each remote target on that host, retaining local backup/evidence under the declared paths. Auxiliary local scripts/configuration/release pins are limited to contextPaths/writePaths.',
      'After apply, verify EACH source-to-target mapping with recorded SHA-256 hashes (targets must match the mapped sources), then run every listed verification check. Record actual commands, outcomes, and errors without claiming an unexecuted check passed.',
      'On definite failure after changes, perform the listed rollbackSteps and restore only this deployment\'s own changes from verified backups; verify and record rollback results and final target hashes. If an apply, remote, service, or rollback outcome is unknown, preserve request IDs, evidence, and live work, do not blindly replay or destructively roll back an uncertain operation, and report the unknown outcome for reconciliation.',
      'Write a JSON receipt at receiptPath containing the objective, execution status, every mapping\'s source/target before-and-after hashes, expected source hashes, absent-target state, backup paths/hashes/results, preflight/apply/verification results, rollback actions/results, errors, unknown outcomes, and retained request IDs. Record receipt-write failure if it cannot be written. Report the true overall outcome: succeeded only if all mappings and checks are verified, otherwise failed, rolled_back, or unknown as supported by evidence.',
      'Deployment manifest:',
      JSON.stringify(manifest, null, 2),
    ].join('\n\n'),
  }
  return { input, manifest, checksExecuted: false, executionStatus: 'not_started' }
}

function remotePath(value: string): string {
  const path = text(value, 'remote target', 4096)
  if (!posix.isAbsolute(path) || path.includes('\\') || path.includes('\n') || path.split('/').includes('..') || path.endsWith('/') || path.endsWith('/.')) throw new Error('Remote target must name an absolute POSIX file without traversal')
  return posix.normalize(path)
}

function extraPaths(workspace: string, value: string[], field: string): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${field} must contain at most 256 paths`)
  return unique(value.map((path, index) => normalizePath(workspace, path, `${field}[${index}]`, false, false)))
}

function text(value: string, field: string, limit: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > limit || /[\0\r]/u.test(value)) {
    throw new Error(`${field} must be non-empty text of at most ${limit} characters without NUL or CR`)
  }
  return value.trim()
}

function normalizePath(workspace: string, value: string, field: string, localOnly: boolean, file: boolean): string {
  const path = text(value, field, 4096).replaceAll('\\', '/')
  if (path.includes('\n') || path.split('/').includes('..')) throw new Error(`${field} must not contain traversal or newlines`)
  if (win32.isAbsolute(path) && !isAbsolute(path)) throw new Error(`${field} uses an unsupported absolute path`)
  if (file && (path.endsWith('/') || path.split('/').at(-1) === '.')) throw new Error(`${field} must name a file`)
  const absolute = resolve(workspace, path)
  const local = relative(workspace, absolute)
  const outside = local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)
  if (outside && (localOnly || !isAbsolute(path))) throw new Error(`${field} path escapes workspace`)
  if (file && local === '') throw new Error(`${field} must name a file`)
  if (outside) return absolute
  return local === '' ? '.' : local.replaceAll('\\', '/')
}

function identity(workspace: string, path: string): string {
  const absolute = resolve(workspace, path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function steps(value: string[], field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error(`${field} must contain between 1 and 64 steps`)
  }
  return value.map((step, index) => text(step, `${field}[${index}]`, 4096))
}

function grants(value: ExternalPathGrant[]): ExternalPathGrant[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('externalPaths must contain at most 64 grants')
  return value.map((grant, index) => {
    if (grant === null || typeof grant !== 'object') throw new Error(`externalPaths[${index}] must be a grant`)
    text(grant.path, `externalPaths[${index}].path`, 4096)
    if (grant.access !== 'read' && grant.access !== 'write') throw new Error(`externalPaths[${index}].access must be read or write`)
    if (grant.kind !== 'file' && grant.kind !== 'directory') throw new Error(`externalPaths[${index}].kind must be file or directory`)
    return { path: grant.path, access: grant.access, kind: grant.kind }
  })
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
