import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readdir, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { readJsonFileStrict } from './strict-utf8.mjs'

const SCHEMA_VERSION = 1
const fingerprintPattern = /^[a-f0-9]{64}$/u
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u

/** All callers must hold the build lock, including recovery and cleanup callers. */
export async function hasPendingArtifactPromotion(distDir) {
  return (await optionalStat(journalPath(resolve(distDir)))) !== null
}

/**
 * Publish physical directories, retaining durable recovery intent and a verified
 * cleanup receipt. The intent fields never change during a transaction.
 * The two directory renames have an observable ENOENT window. This protocol
 * recovers process termination; filesystem/directory sync support varies, so it
 * does not promise portable power-loss durability or uninterrupted readers.
 */
export async function promoteArtifacts(stagingDir, distDir, options = {}) {
  stagingDir = resolve(stagingDir)
  distDir = resolve(distDir)
  if (dirname(stagingDir) !== dirname(distDir) || stagingDir === distDir) {
    throw new Error('artifact staging and dist must be distinct sibling directories')
  }
  await recoverArtifactPromotion(distDir, options)
  const previousFingerprint = await treeFingerprint(distDir)
  const newFingerprint = await treeFingerprint(stagingDir)
  if (newFingerprint === null) throw new Error(`artifact staging directory is missing: ${stagingDir}`)
  const id = randomUUID()
  const record = {
    schemaVersion: SCHEMA_VERSION,
    id,
    staging: basename(stagingDir),
    backup: `${basename(distDir)}.backup-${id}`,
    hadPrevious: previousFingerprint !== null,
    previousFingerprint,
    newFingerprint,
    cleanupVerified: false,
  }
  validateJournal(record, distDir)
  const backup = join(dirname(distDir), record.backup)
  if (await optionalStat(backup)) throw new Error(`artifact backup already exists: ${backup}`)
  await writeJournal(distDir, record)
  const renameImpl = options.rename ?? rename
  try {
    if (record.hadPrevious) {
      await renameImpl(distDir, backup)
      await syncDirectory(dirname(distDir))
    }
    await renameImpl(stagingDir, distDir)
    await syncDirectory(dirname(distDir))
    // Recovery verifies the installed tree before removing this record's backup.
    await recoverArtifactPromotion(distDir, options)
  } catch (error) {
    try {
      await recoverArtifactPromotion(distDir, options)
    } catch (recoveryError) {
      throw new Error(
        `artifact promotion failed (${error?.message ?? error}); recovery requires attention: ${recoveryError?.message ?? recoveryError}`,
        { cause: error },
      )
    }
    throw error
  }
}

/** Resolve only the exact journaled transaction; unknown trees are preserved. */
export async function recoverArtifactPromotion(distDir, options = {}) {
  distDir = resolve(distDir)
  const journal = journalPath(distDir)
  const journalStat = await optionalStat(journal)
  if (journalStat === null) return { recovered: false }
  if (!journalStat.isFile()) throw new Error(`artifact promotion journal is not a regular file: ${journal}`)
  const record = await readJsonFileStrict(journal)
  validateJournal(record, distDir)
  const parent = dirname(distDir)
  const staging = join(parent, record.staging)
  const backup = join(parent, record.backup)
  // Inspect every owned tree before any mutation, including trees that would
  // otherwise be irrelevant to the selected recovery branch.
  const installed = await treeFingerprint(distDir)
  const staged = await treeFingerprint(staging)
  const saved = await treeFingerprint(backup)
  if (staged !== null && staged !== record.newFingerprint) fail('staging tree changed', journal)
  if (record.cleanupVerified && installed !== record.newFingerprint) fail('verified installed tree changed', journal)
  if (saved !== null && (!record.hadPrevious || (!record.cleanupVerified && saved !== record.previousFingerprint))) fail('backup tree changed', journal)
  let outcome
  if (installed === record.newFingerprint) {
    outcome = 'new'
    if (saved !== null) {
      // Persist that both complete trees were verified before recursive cleanup.
      // A killed rm may leave only part of this exact owned backup. On retry,
      // this receipt plus a fresh new-tree verification permits cleanup to resume.
      if (!record.cleanupVerified) {
        await writeJournal(distDir, { ...record, cleanupVerified: true })
      }
      await (options.rm ?? rm)(backup, { recursive: true, force: false })
      if (await optionalStat(backup)) fail('backup cleanup did not remove the backup', journal)
      await syncDirectory(parent)
    }
  } else if (record.hadPrevious && installed === record.previousFingerprint && saved === null) {
    outcome = 'previous'
  } else if (record.hadPrevious && installed === null && saved === record.previousFingerprint) {
    await (options.rename ?? rename)(backup, distDir)
    await syncDirectory(parent)
    if (await treeFingerprint(distDir) !== record.previousFingerprint) fail('restored tree verification failed', journal)
    outcome = 'previous'
  } else if (!record.hadPrevious && installed === null && staged === record.newFingerprint) {
    await (options.rename ?? rename)(staging, distDir)
    await syncDirectory(parent)
    if (await treeFingerprint(distDir) !== record.newFingerprint) fail('installed tree verification failed', journal)
    outcome = 'new'
  } else {
    fail('unknown or conflicting artifact trees', journal)
  }
  // Remove the journal last. A retained staging tree remains useful evidence.
  await unlink(journal)
  await syncDirectory(parent)
  return { recovered: true, outcome }
}

/** Compatibility cleanup: unjournaled backups are never ours to delete. */
export async function removePromotedBackup(distDir, options = {}) {
  return recoverArtifactPromotion(distDir, options)
}

function journalPath(distDir) {
  return `${distDir}.promotion.json`
}

function validateJournal(record, distDir) {
  const validName = value => typeof value === 'string' && value.length > 0
    && value !== '.' && value !== '..' && !/[\\/\u0000]/u.test(value)
  if (record === null || typeof record !== 'object' || Array.isArray(record)
    || record.schemaVersion !== SCHEMA_VERSION || !idPattern.test(record.id ?? '')
    || !validName(record.staging) || !validName(record.backup)
    || record.staging === basename(distDir) || record.staging === record.backup
    || record.staging === basename(journalPath(distDir))
    || record.backup !== `${basename(distDir)}.backup-${record.id}`
    || typeof record.hadPrevious !== 'boolean'
    || typeof record.cleanupVerified !== 'boolean'
    || (record.cleanupVerified && !record.hadPrevious)
    || !fingerprintPattern.test(record.newFingerprint ?? '')
    || (record.hadPrevious ? !fingerprintPattern.test(record.previousFingerprint ?? '') : record.previousFingerprint !== null)) {
    throw new Error(`invalid artifact promotion journal: ${journalPath(distDir)}`)
  }
}

async function writeJournal(distDir, record) {
  const journal = journalPath(distDir)
  const temporary = `${journal}.tmp-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // Under the build lock no other publisher can replace the fixed journal.
  await rename(temporary, journal)
  await syncDirectory(dirname(distDir))
}

async function treeFingerprint(root) {
  const rootStat = await optionalStat(root)
  if (rootStat === null) return null
  if (!rootStat.isDirectory()) throw new Error(`artifact tree must be a physical directory: ${root}`)
  const digest = createHash('sha256')
  async function visit(path, relative, info) {
    if (info.isDirectory()) {
      digest.update(`${JSON.stringify(['directory', relative, info.mode & 0o777])}\n`)
      const names = await readdir(path)
      names.sort()
      for (const name of names) await visit(join(path, name), relative ? `${relative}/${name}` : name, await lstat(join(path, name)))
    } else if (info.isFile()) {
      const contentHash = createHash('sha256')
      const handle = await open(path, 'r')
      try {
        for await (const bytes of handle.createReadStream({ autoClose: false })) contentHash.update(bytes)
      } finally {
        await handle.close()
      }
      digest.update(`${JSON.stringify(['file', relative, info.mode & 0o777, info.size, contentHash.digest('hex')])}\n`)
    } else {
      throw new Error(`artifact tree contains a symlink or nonregular entry: ${path}`)
    }
  }
  await visit(root, '', rootStat)
  return digest.digest('hex')
}

async function optionalStat(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function syncDirectory(path) {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    const unsupported = ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']
    if (process.platform === 'win32') unsupported.push('EPERM', 'EACCES', 'EISDIR')
    if (!unsupported.includes(error?.code)) throw error
  } finally {
    await handle?.close()
  }
}

function fail(reason, journal) {
  throw new Error(`artifact promotion recovery refused (${reason}); preserved ${journal}`)
}
