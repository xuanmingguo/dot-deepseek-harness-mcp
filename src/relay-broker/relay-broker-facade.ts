import { randomUUID } from 'node:crypto'
import { openUrl, sessionUrl } from '../browser-opener.js'
import type { RelayConfig } from '../config.js'
import { createHttpHarnessGateway, HostRpcError, type HarnessGatewayFacade } from '../harness-gateway/index.js'
import { ModelSelectionFacade } from '../model-selection.js'
import { ExternalPermissionProvider, PermissionGatewayFacade } from '../permission-gateway/index.js'
import { PACKAGE_NAME } from '../product-identity/index.js'
import { appendTaskScope, resolvePrompt } from '../prompt.js'
import { mergeEvents, stringAt, userRpcId } from '../run-events.js'
import { SessionRoutingFacade, type WorkspaceSessionSummary } from '../session-routing/index.js'
import { RelayStateStore } from '../state-store.js'
import type { ModelSelection, OperationRecord, PermissionLease, PersistedRelayState, PromptPart, RunSnapshot, ServiceSnapshot } from '../types.js'
import { WorkspaceRoutingFacade, type WorkspaceResolution } from '../workspace-routing/index.js'
import { InteractionError, type InteractionOwner, type InteractionResponse, type UserInteractionFacade } from '../user-interactions/index.js'
import { RelayError } from './errors.js'
import { validateExternalTaskScope } from '../external-paths.js'
import { cloneRun, delay, errorText, persistedSnapshot } from './helpers.js'
import type { RunRecord } from './internal-types.js'
import { OperationJournal } from './operation-journal.js'
import { PermissionController } from './permission-controller.js'
import { PromptAdmissionController } from './prompt-admission-controller.js'
import { RunReconciler } from './run-reconciler.js'
import type { RelayFacadeOptions } from './relay-facade-options.js'
import { inheritTaskScope, operationRequest, resolveTaskScope, type StartRunInput, validateStartRunInput } from './run-input.js'
import { compactRunSummary, compareDiscoveryKeys, matchesDiscoveryScope, prepareRunDiscovery, runDiscoveryCursor, runDiscoveryKey, type RunDiscoveryInput, type RunDiscoveryPage } from './run-discovery.js'

interface ServiceRecord extends ServiceSnapshot {}

export class RelayFacade {
  private readonly gateway: HarnessGatewayFacade
  private readonly modelSelection: ModelSelectionFacade
  private readonly stateStore: RelayStateStore
  private readonly ready: Promise<void>
  private readonly services = new Map<string, ServiceRecord>()
  private readonly serviceByWorkspace = new Map<string, string>()
  private readonly runs = new Map<string, RunRecord>()
  private readonly activeSessions = new Map<string, string>()
  private readonly operations = new Map<string, OperationRecord>()
  private readonly permissionLeases = new Map<string, PermissionLease>()
  private readonly serviceStarts = new Map<string, Promise<ServiceSnapshot>>()
  private readonly sessionStarts = new Set<string>()
  private startAdmission: Promise<void> = Promise.resolve()
  private readonly startReservations = new Set<string>()
  private readonly promptSubmissions = new Set<string>()
  private readonly journal: OperationJournal
  private readonly permissions: PermissionController
  private readonly reconciler: RunReconciler
  private readonly promptAdmission: PromptAdmissionController
  private readonly workspaceRouting: WorkspaceRoutingFacade
  private readonly sessionRouting: SessionRoutingFacade
  private readonly interactions: UserInteractionFacade | undefined

  constructor(private readonly config: RelayConfig, fetchImpl: typeof fetch = fetch, gateway?: HarnessGatewayFacade, options: RelayFacadeOptions = {}) {
    this.interactions = options.interactions
    this.gateway = gateway ?? createHttpHarnessGateway(config.hostUrl, config.rpcTimeoutMs, fetchImpl)
    this.modelSelection = new ModelSelectionFacade(this.gateway)
    this.stateStore = new RelayStateStore(config.stateFile, options.stateStore)
    this.journal = new OperationJournal(
      this.operations,
      () => this.persistState(),
      candidate => this.stateStore.claimOperation(candidate),
    )
    const permissionGateway = options.permissionGateway ?? new PermissionGatewayFacade(new ExternalPermissionProvider(this.gateway))
    this.permissions = new PermissionController(permissionGateway, this.permissionLeases, () => this.persistState(), config.permissionLeaseMs)
    this.reconciler = new RunReconciler(this.gateway, config, this.activeSessions, this.operations, this.journal, this.permissions,
      runId => this.interactions?.hasPending(runId) ?? false, operationId => this.promptSubmissions.has(operationId))
    this.promptAdmission = new PromptAdmissionController(this.gateway, this.journal, this.reconciler)
    this.workspaceRouting = new WorkspaceRoutingFacade(this.gateway, config.allowedWorkspaceRoots)
    this.sessionRouting = new SessionRoutingFacade(this.gateway)
    this.ready = this.restoreState()
  }

  async doctor(): Promise<object> {
    await this.ready
    const host = await this.gateway.describeHost()
    const workspacePolicy = await this.workspaceRouting.describePolicy()
    return {
      ok: true,
      package: { name: PACKAGE_NAME, version: typeof __DSH_RELAY_VERSION__ === 'string' ? __DSH_RELAY_VERSION__ : 'development' },
      host: { url: this.config.hostUrl, ...host },
      workspacePolicy: { mode: workspacePolicy.mode, roots: workspacePolicy.roots, registeredCount: workspacePolicy.registered.length },
      processOwnership: 'external-host',
      taskPolicy: { maxActiveRuns: this.config.maxActiveRuns ?? 4, queueMode: 'queue', steerMode: 'steer', queueAcknowledgement: 'acceptance-only' },
      state: {
        file: this.config.stateFile,
        services: this.services.size,
        runs: this.runs.size,
        operations: this.operations.size,
        permissionLeases: this.permissionLeases.size,
        recoveryWarning: this.stateStore.recoveryWarning,
        locks: await this.stateStore.inspectLockState(),
        sensitiveFilePermissions: await this.stateStore.checkFilePermissions(),
      },
    }
  }

  async startService(input: { workspace: string; openBrowser?: boolean }): Promise<ServiceSnapshot> {
    await this.ready
    const workspace = await this.workspaceRouting.resolve(input.workspace)
    const pending = this.serviceStarts.get(workspace.path)
    if (pending !== undefined) return pending
    const started = this.startResolvedService(workspace, input.openBrowser === true)
    this.serviceStarts.set(workspace.path, started)
    try { return await started }
    finally { this.serviceStarts.delete(workspace.path) }
  }

  private async startResolvedService(resolution: WorkspaceResolution, openBrowser: boolean): Promise<ServiceSnapshot> {
    const existingId = this.serviceByWorkspace.get(resolution.path)
    const existing = existingId === undefined ? undefined : this.services.get(existingId)
    if (existing?.status === 'running') {
      if (openBrowser) await this.open(existing, existing.webUrl)
      return { ...existing }
    }
    await this.gateway.describeHost()
    const workspace = resolution.workspace
      ?? await this.gateway.createWorkspace(resolution.path)
    const service: ServiceRecord = {
      serviceId: randomUUID(),
      workspaceId: workspace.workspaceId,
      workspace: workspace.path,
      status: 'running',
      webUrl: this.config.hostUrl,
      browserOpened: false,
      browserError: null,
      managedProcess: false,
      processId: null,
      attachedAt: new Date().toISOString(),
      stoppedAt: null,
    }
    this.services.set(service.serviceId, service)
    this.serviceByWorkspace.set(workspace.path, service.serviceId)
    if (openBrowser) await this.open(service, service.webUrl)
    await this.persistState()
    return { ...service }
  }

  async openService(serviceId: string): Promise<ServiceSnapshot> {
    await this.ready
    const service = this.requireService(serviceId)
    if (service.status !== 'running') throw new Error(`service is not running: ${serviceId}`)
    await this.open(service, service.webUrl)
    await this.persistState()
    return { ...service }
  }

  async listServices(): Promise<ServiceSnapshot[]> {
    await this.ready
    return [...this.services.values()].map(service => ({ ...service }))
  }

  async listWorkspaces(): Promise<object> {
    await this.ready
    const policy = await this.workspaceRouting.describePolicy()
    return {
      mode: policy.mode,
      roots: policy.roots,
      workspaces: policy.registered,
    }
  }

  async listWorkspaceSessions(workspacePath: string): Promise<object> {
    await this.ready
    const resolution = await this.workspaceRouting.resolve(workspacePath)
    if (resolution.workspace === null) {
      throw new Error('workspace is allowed but not registered in Harness')
    }
    const catalog = await this.workspaceRouting.listRegistered()
    const sessions: WorkspaceSessionSummary[] = await this.sessionRouting.list(
      resolution.workspace,
      catalog.archivedSessionIds,
    )
    return {
      workspace: {
        workspaceId: resolution.workspace.workspaceId,
        path: resolution.workspace.path,
        title: resolution.workspace.title,
      },
      sessions,
    }
  }

  async stopService(serviceId: string): Promise<ServiceSnapshot> {
    await this.ready
    const service = this.requireService(serviceId)
    if (service.status === 'running') {
      service.status = 'stopped'
      service.stoppedAt = new Date().toISOString()
      this.serviceByWorkspace.delete(service.workspace)
    }
    await this.persistState()
    return { ...service }
  }

  async startRun(input: StartRunInput, clientPrincipalId: string = this.config.clientPrincipalId): Promise<RunSnapshot> {
    await this.ready
    const previous = this.startAdmission
    let unlock!: () => void
    this.startAdmission = new Promise<void>(resolve => { unlock = resolve })
    await previous
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      unlock()
    }
    const reservationId = randomUUID()
    try { return await this.startAdmittedRun(input, clientPrincipalId, release, reservationId) }
    finally { this.startReservations.delete(reservationId); release() }
  }

  async validateTaskScope(input: Pick<StartRunInput, 'workspace' | 'permissionPreset' | 'reviewTargets' | 'contextReadScope' | 'excludedPaths' | 'writeScope' | 'externalPaths'>) {
    const taskScope = resolveTaskScope(input)
    const workspace = await this.workspaceRouting.resolve(input.workspace)
    await validateExternalTaskScope(taskScope, this.config.externalPathPolicy, workspace.path)
    return { valid: true as const, workspace: workspace.path, taskScope, scopeEnforcement: 'instruction-only' as const, nativePermissionPreset: input.permissionPreset ?? 'read-only', executionStatus: 'not_started' as const }
  }

  private async startAdmittedRun(input: StartRunInput, clientPrincipalId: string, release: () => void, reservationId: string): Promise<RunSnapshot> {
    validateStartRunInput(input)
    const taskScope = resolveTaskScope(input)
    const prompt = resolvePrompt(appendTaskScope(input, taskScope, input.authorizationBasis), this.config)
    // Reject before claiming an idempotency key, so a capacity retry is a fresh admission.
    // Existing keys must still reach the journal's conflict/replay checks when full.
    const existing = input.idempotencyKey === undefined ? undefined
      : (await this.stateStore.load())?.operations.find(operation => operation.clientPrincipalId === clientPrincipalId
        && operation.idempotencyKey === input.idempotencyKey)
    if (existing === undefined) {
      const resolvedWorkspace = await this.workspaceRouting.resolve(input.workspace)
      await validateExternalTaskScope(taskScope, this.config.externalPathPolicy, resolvedWorkspace.path)
      await Promise.all([...this.runs.values()].filter(run => occupiesSlot(run.snapshot)).map(run => this.reconciler.refresh(run)))
      const active = [...this.runs.values()].filter(run => occupiesSlot(run.snapshot)).length + this.startReservations.size
      const limit = this.config.maxActiveRuns ?? 4
      if (active >= limit) {
        throw new RelayError('CONCURRENCY_LIMIT', `Relay has ${active} active runs; the limit is ${limit}`, true, { nextAction: 'wait' })
      }
    }
    const prepared = await this.journal.prepare(clientPrincipalId, input.operationKind ?? 'start', randomUUID(), operationRequest(input, prompt.summary, prompt.imageCount), input.idempotencyKey)
    const operation = prepared.record
    if (!prepared.replayed) this.startReservations.add(reservationId)
    // Only capacity refresh/claim/reservation is serialized. Native setup and
    // prompt ACKs proceed concurrently across sessions, without awaiting a turn.
    release()
    if (prepared.replayed) {
      const latest = await this.stateStore.load()
      const latestOperation = latest?.operations.find(candidate => candidate.operationId === operation.operationId)
      if (latestOperation !== undefined && Date.parse(latestOperation.updatedAt) > Date.parse(operation.updatedAt)) {
        Object.assign(operation, latestOperation)
        this.operations.set(operation.operationId, operation)
      }
      const persisted = latest?.runs.find(candidate => candidate.snapshot.runId === operation.runId)
      if (persisted !== undefined && !this.runs.has(operation.runId)) {
        const snapshot = cloneRun(persisted.snapshot)
        this.runs.set(operation.runId, { snapshot, baselineSeq: persisted.baselineSeq, promptRpcId: persisted.promptRpcId, events: [] })
        const service = latest?.services.find(candidate => candidate.serviceId === snapshot.serviceId)
        if (service !== undefined) this.services.set(service.serviceId, { ...service })
        if (occupiesSlot(snapshot)) this.activeSessions.set(this.activeKey(snapshot.serviceId, snapshot.sessionId), snapshot.runId)
      }
    }
    const replay = this.runs.get(operation.runId)
    const originalFailure = this.journal.replayFailure(operation)
    // A definitive Host rejection historically returns its failed run. Keep
    // that receipt when available; the durable error also survives its loss.
    if (prepared.replayed && originalFailure !== undefined
      && !(operation.failure?.promptAdmission === 'rejected' && replay !== undefined)) throw originalFailure
    if (prepared.replayed && operation.state === 'failed' && replay === undefined) {
      throw new RelayError('OPERATION_FAILED', operation.error ?? 'The original operation failed without a recoverable run snapshot', false, {
        operationId: operation.operationId, runId: operation.runId, lastKnownState: operation.state,
        promptAdmission: this.journal.admission(operation), nextAction: 'reconcile',
      })
    }
    if (prepared.replayed && replay !== undefined) {
      release()
      if (replay.snapshot.status === 'running' && replay.snapshot.promptAdmission !== 'accepted' && operation.state === 'prepared') {
        if (Date.now() - Date.parse(operation.updatedAt) < this.config.rpcTimeoutMs) {
          throw new RelayError('OPERATION_IN_PROGRESS', 'The original caller still owns this prepared operation', true, {
            operationId: operation.operationId, runId: operation.runId, lastKnownState: operation.state, nextAction: 'wait',
          })
        }
        throw this.journal.unknown(operation, 'The prepared operation has no confirmed response; reconcile its original caller before proceeding')
      }
      await this.reconciler.refresh(replay)
      if (replay.snapshot.status === 'running' && replay.snapshot.promptAdmission !== 'accepted'
        && operation.state === 'submitted') {
        if (Date.now() - Date.parse(operation.updatedAt) < this.config.rpcTimeoutMs) {
          throw new RelayError('OPERATION_IN_PROGRESS', 'The original caller still owns this prepared operation', true, {
            operationId: operation.operationId, runId: operation.runId, lastKnownState: operation.state, nextAction: 'wait',
          })
        }
        throw this.journal.unknown(operation, 'The submitted prompt has no confirmed response; reconcile its durable history before proceeding')
      }
      return cloneRun(replay.snapshot)
    }
    if (prepared.replayed && operation.state === 'prepared' && Date.now() - Date.parse(operation.updatedAt) < this.config.rpcTimeoutMs) {
      throw new RelayError('OPERATION_IN_PROGRESS', 'The original caller has not persisted a recoverable run yet', true, {
        operationId: operation.operationId, runId: operation.runId, lastKnownState: operation.state, nextAction: 'wait',
      })
    }
    if (prepared.replayed) throw this.journal.unknown(operation, 'The original operation has no recoverable run snapshot')
    this.startReservations.add(reservationId)
    let sessionId: string | undefined
    let activeKey: string | undefined
    let ownsSessionStart = false
    let sessionLease: Awaited<ReturnType<RelayStateStore['acquireSessionLease']>> | null = null
    let run: RunRecord | null = null
    try {
      const service = await this.startService({ workspace: input.workspace })
      const catalog = await this.workspaceRouting.listRegistered()
      const workspace = catalog.items.find(item => item.workspaceId === service.workspaceId)
      if (workspace === undefined) throw new Error(`Harness workspace is no longer registered: ${service.workspaceId}`)
      const session = await this.sessionRouting.resolve(workspace, {
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.sessionMode === undefined ? {} : { sessionMode: input.sessionMode }),
        ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
        archivedSessionIds: catalog.archivedSessionIds,
      })
      sessionId = session.sessionId
      activeKey = this.activeKey(service.serviceId, session.sessionId)
      if (this.activeSessions.has(activeKey) || this.sessionStarts.has(session.sessionId)) throw new Error(`session already has an active DSH Relay run: ${session.sessionId}`)
      this.sessionStarts.add(session.sessionId)
      ownsSessionStart = true
      sessionLease = session.reused ? await this.stateStore.acquireSessionLease(session.sessionId) : null
      const runId = operation.runId
      const promptRpcId = operation.rpcId
      this.activeSessions.set(activeKey, runId)
      let selection: ModelSelection | null = null
      let restore: RunSnapshot['modelDefaultRestore'] = 'not-needed'
      const warnings: string[] = []
      if (session.reused) await this.sessionRouting.assertIdle(session.sessionId)
      if (input.provider !== undefined && input.model !== undefined) {
        const selected = await this.modelSelection.select(session.sessionId, {
          provider: input.provider,
          model: input.model,
          ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        })
        selection = selected.selected
        restore = selected.restore
        warnings.push(...selected.warnings)
      }
      const permissionPreset = input.permissionPreset ?? 'read-only'
      await this.permissions.selectForRun(session.sessionId, operation.operationId, permissionPreset, true)
      const baselineSeq = await this.reconciler.latestSeq(session.sessionId)
      const snapshot: RunSnapshot = {
        runId,
        operationId: operation.operationId,
        idempotencyKey: operation.idempotencyKey,
        serviceId: service.serviceId,
        sessionId: session.sessionId,
        sessionReused: session.reused,
        parentRunId: input.parentRunId ?? null,
        workspace: service.workspace,
        webUrl: sessionUrl(this.config.hostUrl, session.sessionId),
        status: 'running',
        modelSelection: selection,
        permissionPreset,
        agentPreset: input.agentPreset ?? session.agentPreset,
        modelDefaultRestore: restore,
        warnings,
        task: prompt.summary,
        taskPersisted: true,
        taskImageCount: prompt.imageCount,
        ...(taskScope === undefined ? {} : { taskScope }),
        cancelRequested: false,
        startedAt: new Date().toISOString(),
        lastProgressAt: new Date().toISOString(),
        finishedAt: null,
        promptAdmission: 'pending',
        promptMessageId: null,
        assistantText: '',
        assistantTextBytes: 0,
        assistantTextTruncated: false,
        lastEventSeq: baselineSeq,
        error: null,
      }
      run = { snapshot, baselineSeq, promptRpcId, events: [] }
      this.runs.set(runId, run)
      this.startReservations.delete(reservationId)
      await this.persistState()
      await this.submitRunPrompt(run, operation, prompt.content)
      if (snapshot.status === 'running') await this.reconciler.refresh(run)
      if (input.openBrowser === true) {
        try {
          await this.open(this.requireService(service.serviceId), snapshot.webUrl)
        } catch (error) {
          snapshot.warnings.push(`The run was admitted, but its browser page could not be opened: ${errorText(error)}`)
        }
      }
      await this.persistState()
      return cloneRun(snapshot)
    } catch (error) {
      const admission = operation.messageId !== null || operation.state === 'acknowledged' || operation.state === 'reconciled'
        || run?.snapshot.promptAdmission === 'accepted' ? 'accepted'
        : operation.failure?.promptAdmission ?? (operation.state === 'prepared' ? 'not_submitted'
        : run?.snapshot.promptAdmission === 'rejected' ? 'rejected' : 'unknown')
      const failure = await this.journal.fail(operation, error, admission)
      if (run === null) {
        if (activeKey !== undefined && this.activeSessions.get(activeKey) === operation.runId) this.activeSessions.delete(activeKey)
        if (sessionId !== undefined) await this.permissions.restoreSession(sessionId, operation.operationId)
      } else if (admission === 'not_submitted' || admission === 'rejected') {
        run.snapshot.promptAdmission = 'rejected'
        await this.reconciler.finalize(run, 'failed', errorText(error))
        await this.persistState()
      } else if (admission === 'unknown') {
        run.snapshot.promptAdmission = 'unknown'
        await this.persistState()
      }
      throw failure
    } finally {
      if (ownsSessionStart && sessionId !== undefined) this.sessionStarts.delete(sessionId)
      await sessionLease?.release()
    }
  }

  async replyRun(runId: string, input: Omit<StartRunInput, 'workspace' | 'sessionId' | 'sessionMode' | 'agentPreset' | 'parentRunId'>, clientPrincipalId: string = this.config.clientPrincipalId): Promise<RunSnapshot> {
    await this.ready
    const parent = this.requireRun(runId)
    await this.reconciler.refresh(parent)
    if (parent.snapshot.status === 'running') throw new Error(`run is still active: ${runId}`)
    return this.startRun(inheritTaskScope({
      ...input,
      workspace: parent.snapshot.workspace,
      sessionId: parent.snapshot.sessionId,
      permissionPreset: input.permissionPreset ?? parent.snapshot.permissionPreset,
      parentRunId: runId,
      operationKind: 'reply',
    }, parent.snapshot.taskScope), clientPrincipalId)
  }

  async steerRun(runId: string, input: { task?: string; content?: PromptPart[]; idempotencyKey?: string }, clientPrincipalId: string = this.config.clientPrincipalId): Promise<object> {
    await this.ready
    const run = this.requireRun(runId)
    const prompt = resolvePrompt(input, this.config)
    const prepared = await this.journal.prepare(clientPrincipalId, 'steer', runId, { runId, summary: prompt.summary, imageCount: prompt.imageCount }, input.idempotencyKey)
    const operation = prepared.record
    const receipt = (replayed: boolean): object => ({
      accepted: true, mode: 'steer', executionStatus: 'not_observed',
      userMessageObserved: operation.state === 'reconciled', receiptPersisted: true,
      rpcId: operation.rpcId, messageId: operation.messageId, durable: operation.state === 'reconciled',
      replayed, operationId: operation.operationId, run: cloneRun(run.snapshot),
    })
    if (prepared.replayed && (operation.state === 'acknowledged' || operation.state === 'reconciled')) return receipt(true)
    if (prepared.replayed && operation.state === 'failed') {
      throw new RelayError('OPERATION_FAILED', operation.error ?? 'The steer operation failed', false, {
        operationId: operation.operationId, runId, lastKnownState: operation.state, nextAction: 'status',
      })
    }
    if (prepared.replayed && operation.state !== 'prepared') {
      const reconciled = await this.reconcileOperation(operation.operationId)
      if (reconciled.operation.state === 'acknowledged' || reconciled.operation.state === 'reconciled') return receipt(true)
      throw this.journal.unknown(operation, 'The steer operation outcome is not yet reconciled')
    }
    if (prepared.replayed && Date.now() - Date.parse(operation.updatedAt) < this.config.rpcTimeoutMs) {
      throw new RelayError('OPERATION_IN_PROGRESS', 'The original caller still owns this prepared steer', true, { operationId: operation.operationId, runId, lastKnownState: operation.state, nextAction: 'wait' })
    }
    await this.reconciler.refresh(run)
    if (run.snapshot.status !== 'running') {
      await this.journal.transition(operation, 'failed', { error: `run is terminal: ${runId}` })
      throw new Error(`run is terminal: ${runId}`)
    }
    await this.journal.transition(operation, 'submitted')
    let accepted: { accepted: true; rpcId: string; messageId?: string }
    try {
      accepted = await this.gateway.submitPrompt(run.snapshot.sessionId, 'steer', prompt.content, operation.rpcId, actualRpcId => this.journal.correlateRpcId(operation, actualRpcId))
    } catch (error) {
      if (operation.state === 'reconciled') return receipt(false)
      if (error instanceof HostRpcError && error.definitiveRejection) {
        await this.journal.transition(operation, 'failed', { error: errorText(error) })
        throw error
      }
      await this.journal.transition(operation, 'unknown', { error: errorText(error) })
      throw this.journal.unknown(operation, 'The steer prompt response was unavailable; inspect run status before retrying')
    }
    // Acceptance is durable Relay evidence even while Harness keeps the steer in
    // next-step. Persist it before querying history so retries cannot redispatch.
    if (operation.state !== 'acknowledged' && operation.state !== 'reconciled') {
      await this.journal.transition(operation, 'acknowledged', { messageId: accepted.messageId ?? null, error: null })
    }
    if (accepted.messageId !== undefined) return receipt(false)
    const deadline = Date.now() + Math.min(this.config.rpcTimeoutMs, 10_000)
    while (Date.now() <= deadline) {
      try { run.events = mergeEvents(run.events, await this.reconciler.historySince(run)) }
      catch { break } // A history read failure cannot erase the explicit Host ACK.
      const message = run.events.find(event => userRpcId(event) === operation.rpcId)
      if (message !== undefined) {
        if (operation.state !== 'reconciled') {
          await this.journal.transition(operation, 'reconciled', { messageId: stringAt(message.data, 'id'), error: null })
        }
        break
      }
      await delay(this.config.pollIntervalMs)
    }
    return receipt(false)
  }

  /** Append a future native task to this session; acceptance does not establish execution. */
  async queueRun(runId: string, input: { task?: string; content?: PromptPart[]; idempotencyKey?: string }, clientPrincipalId: string = this.config.clientPrincipalId): Promise<object> {
    await this.ready
    const run = this.requireRun(runId)
    const prompt = resolvePrompt(input, this.config)
    const prepared = await this.journal.prepare(clientPrincipalId, 'queue', runId, { runId, content: prompt.content }, input.idempotencyKey)
    const operation = prepared.record
    const result = (replayed: boolean): object => ({
      accepted: true, mode: 'queue', executionStatus: 'not_observed',
      messageId: operation.messageId, durable: operation.state === 'reconciled', replayed,
      operationId: operation.operationId, run: cloneRun(run.snapshot),
    })
    if (prepared.replayed) {
      if (operation.state === 'acknowledged' || operation.state === 'reconciled') return result(true)
      if (operation.state === 'failed') {
        throw new RelayError('OPERATION_FAILED', operation.error ?? 'The queue operation failed', false, {
          operationId: operation.operationId, runId, lastKnownState: operation.state, nextAction: 'status',
        })
      }
      // Even a stale prepared record belongs to its original caller. Never redispatch
      // an ambiguous queue request: recover evidence first, including after restart.
      const reconciled = await this.reconcileOperation(operation.operationId)
      if (reconciled.operation.state === 'acknowledged' || reconciled.operation.state === 'reconciled') return result(true)
      if (operation.state === 'prepared') {
        throw new RelayError('OPERATION_IN_PROGRESS', 'The original caller owns this prepared queue operation', true, {
          operationId: operation.operationId, runId, lastKnownState: operation.state, nextAction: 'wait',
        })
      }
      throw this.journal.unknown(operation, 'The queue outcome is not yet reconciled; inspect status before retrying')
    }
    await this.reconciler.refresh(run)
    if (run.snapshot.status !== 'running') {
      await this.journal.transition(operation, 'failed', { error: `run is not running: ${runId}` })
      throw new Error(`run is not running: ${runId}`)
    }
    await this.journal.transition(operation, 'submitted')
    try {
      const accepted = await this.gateway.submitPrompt(run.snapshot.sessionId, 'queue', prompt.content, operation.rpcId,
        actualRpcId => this.journal.correlateRpcId(operation, actualRpcId))
      // An ACK with no messageId still confirms acceptance and must prevent replay.
      if (operation.state !== 'acknowledged' && operation.state !== 'reconciled') {
        await this.journal.transition(operation, 'acknowledged', { messageId: accepted.messageId ?? null, error: null })
      }
    } catch (error) {
      if (operation.state === 'acknowledged' || operation.state === 'reconciled') throw error
      if (error instanceof HostRpcError && error.definitiveRejection) {
        await this.journal.transition(operation, 'failed', { error: errorText(error) })
        throw error
      }
      await this.journal.transition(operation, 'unknown', { error: errorText(error) })
      throw this.journal.unknown(operation, 'The queue response was unavailable; reconcile status before retrying')
    }
    return result(false)
  }

  async getRun(runId: string, clientPrincipalId: string = this.config.clientPrincipalId): Promise<RunSnapshot> {
    await this.ready
    const run = this.requireRun(runId)
    await this.reconciler.refresh(run)
    await this.persistState()
    return this.projectInteractions(run.snapshot, clientPrincipalId)
  }

  /** Native answerers may claim only the active run's session, never a completed or foreign session. */
  interactionOwner(sessionId: string): InteractionOwner | undefined {
    for (const runId of this.activeSessions.values()) {
      const run = this.runs.get(runId)
      if (run === undefined) continue
      const snapshot = run.snapshot
      if (snapshot.sessionId !== sessionId || snapshot.cancelRequested || snapshot.finishedAt !== null
        || (snapshot.status !== 'running' && snapshot.attentionReason !== 'run_stalled')) continue
      const operation = snapshot.operationId === undefined ? undefined : this.operations.get(snapshot.operationId)
      if (operation !== undefined) return { runId: snapshot.runId, sessionId, clientPrincipalId: operation.clientPrincipalId }
    }
    return undefined
  }

  async listRunInteractions(runId: string, principal: string = this.config.clientPrincipalId): Promise<object> {
    const snapshot = await this.getRun(runId, principal)
    return { runId, supported: this.interactions !== undefined, requests: snapshot.pendingInteractions ?? [] }
  }

  async respondToRunInteraction(runId: string, requestId: string, response: InteractionResponse, principal: string = this.config.clientPrincipalId): Promise<object> {
    await this.getRun(runId, principal)
    if (this.interactions === undefined) throw new InteractionError('INTERACTIONS_UNAVAILABLE', 'Update the embedded Harness Relay Host to enable native user interactions.')
    const result = this.interactions.respond(runId, requestId, principal, response)
    return { ...result, nextTool: 'wait_run' }
  }

  private projectInteractions(snapshot: RunSnapshot, principal: string): RunSnapshot {
    const result = cloneRun(snapshot)
    const requests = this.interactions?.list(snapshot.runId, principal) ?? []
    const events = this.runs.get(snapshot.runId)?.events ?? []
    for (const request of requests) {
      if (request.kind !== 'approval' || request.callId === undefined) continue
      const call = events.find(event => event.type === 'tool/call' && event.data.callId === request.callId)
      if (call !== undefined) request.toolCall = structuredClone(call.data)
    }
    if (requests.length > 0) {
      result.status = 'needs_attention'
      result.attentionReason = requests.some(item => item.kind === 'approval') ? 'permission_confirm' : 'await_user_answer'
      result.pendingInteractions = requests
      result.error = null
    }
    return result
  }

  async openRun(runId: string): Promise<RunSnapshot> {
    await this.ready
    const run = this.requireRun(runId)
    const service = this.requireService(run.snapshot.serviceId)
    await this.open(service, run.snapshot.webUrl)
    await this.persistState()
    return cloneRun(run.snapshot)
  }

  async waitRun(runId: string, timeoutMs: number, clientPrincipalId: string = this.config.clientPrincipalId): Promise<RunSnapshot> {
    await this.ready
    const run = this.requireRun(runId)
    const deadline = Date.now() + timeoutMs
    do {
      await this.reconciler.refresh(run)
      if (run.snapshot.status !== 'running' || (this.interactions?.list(runId, clientPrincipalId).length ?? 0) > 0 || Date.now() >= deadline) break
      await delay(Math.min(this.config.pollIntervalMs, Math.max(0, deadline - Date.now())))
    } while (Date.now() <= deadline)
    await this.persistState()
    return this.projectInteractions(run.snapshot, clientPrincipalId)
  }

  async listRuns(serviceId?: string, clientPrincipalId: string = this.config.clientPrincipalId): Promise<RunSnapshot[]> {
    await this.ready
    const selected = [...this.runs.values()].filter(run => serviceId === undefined || run.snapshot.serviceId === serviceId)
    await Promise.all(selected.filter(run => occupiesSlot(run.snapshot)).map(run => this.reconciler.refresh(run)))
    await this.persistState()
    return selected.map(run => this.projectInteractions(run.snapshot, clientPrincipalId))
  }

  async listRunSummaries(input: RunDiscoveryInput = {}, clientPrincipalId: string = this.config.clientPrincipalId): Promise<RunDiscoveryPage> {
    // Cursor rejection precedes native refreshes and persistence.
    const { filters, limit, cursor } = prepareRunDiscovery(input)
    await this.ready
    const candidates = [...this.runs.values()].filter(run => matchesDiscoveryScope(run.snapshot, filters))
      .sort((left, right) => compareDiscoveryKeys(runDiscoveryKey(right.snapshot), runDiscoveryKey(left.snapshot)))
    const upper = cursor?.upper ?? (candidates[0] === undefined ? undefined : runDiscoveryKey(candidates[0].snapshot))
    const selected: RunSnapshot[] = []
    let refreshed = false
    for (const run of candidates) {
      const key = runDiscoveryKey(run.snapshot)
      if (upper === undefined || compareDiscoveryKeys(key, upper) > 0
        || (cursor !== undefined && compareDiscoveryKeys(key, cursor.after) >= 0)) continue
      if (occupiesSlot(run.snapshot)) {
        await this.reconciler.refresh(run)
        refreshed = true
      }
      // Project only the interaction status, without cloning task/assistant text.
      const requests = this.interactions?.list(run.snapshot.runId, clientPrincipalId) ?? []
      const snapshot: RunSnapshot = requests.length === 0 ? run.snapshot : {
        ...run.snapshot, status: 'needs_attention', error: null,
        attentionReason: requests.some(request => request.kind === 'approval') ? 'permission_confirm' : 'await_user_answer',
      }
      if (filters.status !== null && snapshot.status !== filters.status) continue
      selected.push(snapshot)
      if (selected.length > limit) break
    }
    if (refreshed) await this.persistState()
    const hasMore = selected.length > limit
    const page = selected.slice(0, limit)
    return {
      runs: page.map(compactRunSummary), hasMore,
      nextCursor: hasMore && upper !== undefined ? runDiscoveryCursor(filters, upper, runDiscoveryKey(page[page.length - 1]!)) : null,
    }
  }
  async getOperation(operationId: string): Promise<OperationRecord> {
    await this.ready
    const operation = this.requireOperation(operationId)
    if (operation.kind === 'steer' && (operation.state === 'unknown' || (operation.state === 'acknowledged' && operation.messageId === null))) {
      return (await this.reconcileOperation(operationId)).operation
    }
    return structuredClone(operation)
  }
  async reconcilePermissions(sessionId: string): Promise<{ sessionId: string; restored: boolean }> {
    await this.ready
    const affected = [...this.runs.values()].filter(run => run.snapshot.sessionId === sessionId
      && run.snapshot.status === 'needs_attention' && run.snapshot.attentionReason === 'permission_restore_failed')
    const lease = this.permissions.list().find(item => item.sessionId === sessionId && item.state !== 'released')
    const owner = lease === undefined ? undefined : [...this.runs.values()].find(run => run.snapshot.operationId === lease.ownerOperationId)
    const activeOwner = owner !== undefined && owner.snapshot.finishedAt === null && occupiesSlot(owner.snapshot)
    // Old attention snapshots may coexist with a newer run on this session.
    // Repair their status without restoring the newer active run's own lease.
    const restored = activeOwner ? affected.length > 0 : await this.permissions.restoreSession(sessionId)
    try {
      if (restored) {
        for (const run of affected) await this.reconciler.refresh(run, { permissionRecovery: true })
      }
    } finally {
      await this.persistState()
    }
    return { sessionId, restored }
  }

  async reconcileOperation(operationId: string): Promise<{ operation: OperationRecord; run: RunSnapshot | null }> {
    await this.ready
    const operation = this.requireOperation(operationId)
    const run = this.runs.get(operation.runId)
    if (run !== undefined) {
      await this.reconciler.refresh(run)
      if ((operation.kind === 'start' || operation.kind === 'reply') && !this.promptSubmissions.has(operation.operationId) && run.snapshot.promptMessageId !== null
        && operation.state !== 'acknowledged' && operation.state !== 'reconciled' && operation.state !== 'failed') {
        await this.journal.transition(operation, 'reconciled', { messageId: run.snapshot.promptMessageId, error: null })
      } else if ((operation.kind === 'steer' || (operation.kind === 'queue' && operation.state !== 'acknowledged'))
        && operation.state !== 'reconciled' && operation.state !== 'failed') {
        const events = mergeEvents(run.events, await this.reconciler.historySince(run))
        const message = events.find(event => userRpcId(event) === operation.rpcId)
        if (message !== undefined) await this.journal.transition(operation, 'reconciled', { messageId: stringAt(message.data, 'id'), error: null })
      } else if (operation.kind === 'cancel' && run.snapshot.status !== 'running'
        && operation.state !== 'acknowledged' && operation.state !== 'reconciled' && operation.state !== 'failed') {
        await this.journal.transition(operation, 'reconciled', { error: null })
      }
    }
    await this.persistState()
    return { operation: structuredClone(operation), run: run === undefined ? null : cloneRun(run.snapshot) }
  }

  async cancelRun(runId: string, idempotencyKey?: string, clientPrincipalId: string = this.config.clientPrincipalId): Promise<RunSnapshot> {
    await this.ready
    const run = this.requireRun(runId)
    await this.reconciler.refresh(run)
    if (run.snapshot.status !== 'running') return cloneRun(run.snapshot)
    const prepared = await this.journal.prepare(clientPrincipalId, 'cancel', runId, { runId }, idempotencyKey)
    const operation = prepared.record
    if (prepared.replayed && operation.state === 'acknowledged') return cloneRun(run.snapshot)
    if (prepared.replayed && operation.state !== 'prepared') {
      const reconciled = await this.reconcileOperation(operation.operationId)
      if (reconciled.operation.state === 'acknowledged' || reconciled.operation.state === 'reconciled') return cloneRun(run.snapshot)
      throw this.journal.unknown(operation, 'The cancel operation outcome is not yet reconciled')
    }
    if (prepared.replayed && Date.now() - Date.parse(operation.updatedAt) < this.config.rpcTimeoutMs) throw new RelayError('OPERATION_IN_PROGRESS', 'The original caller still owns this prepared cancel', true, { operationId: operation.operationId, runId, lastKnownState: operation.state, nextAction: 'wait' })
    run.snapshot.cancelRequested = true
    await this.journal.transition(operation, 'submitted')
    try {
      await this.gateway.cancelSession(run.snapshot.sessionId, operation.rpcId, actualRpcId => this.journal.correlateRpcId(operation, actualRpcId))
      await this.journal.transition(operation, 'acknowledged')
    } catch (error) {
      if (error instanceof HostRpcError && error.definitiveRejection) {
        run.snapshot.cancelRequested = false
        await this.journal.transition(operation, 'failed', { error: errorText(error) })
        await this.persistState()
        throw error
      }
      await this.journal.transition(operation, 'unknown', { error: errorText(error) })
      throw this.journal.unknown(operation, 'The cancel response was unavailable; inspect run status before retrying')
    }
    await this.reconciler.refresh(run)
    await this.persistState()
    return cloneRun(run.snapshot)
  }

  async listCapabilities(): Promise<object> {
    await this.ready
    const [models, presets] = await Promise.all([
      this.gateway.listModels(),
      this.gateway.listAgentPresets(),
    ])
    return {
      models,
      presets,
      permissionPresets: ['read-only', 'workspace-write', 'danger-full-access'],
    }
  }

  private async submitRunPrompt(run: RunRecord, operation: OperationRecord, content: PromptPart[]): Promise<void> {
    this.promptSubmissions.add(operation.operationId)
    try { await this.promptAdmission.submit(run, operation, content) }
    finally { this.promptSubmissions.delete(operation.operationId) }
  }

  private async restoreState(): Promise<void> {
    const state = await this.stateStore.load()
    if (state === null) return
    for (const service of state.services) {
      this.services.set(service.serviceId, { ...service })
      if (service.status === 'running') this.serviceByWorkspace.set(service.workspace, service.serviceId)
    }
    for (const persisted of state.runs) {
      const snapshot = cloneRun(persisted.snapshot)
      snapshot.promptAdmission ??= snapshot.promptMessageId === null ? 'unknown' : 'accepted'
      this.runs.set(snapshot.runId, {
        snapshot,
        baselineSeq: persisted.baselineSeq,
        promptRpcId: persisted.promptRpcId,
        events: [],
      })
      if (occupiesSlot(snapshot)) {
        this.activeSessions.set(this.activeKey(snapshot.serviceId, snapshot.sessionId), snapshot.runId)
      }
    }
    for (const operation of state.operations) this.operations.set(operation.operationId, { ...operation })
    for (const lease of state.permissionLeases) this.permissionLeases.set(lease.leaseId, { ...lease })
    this.journal.restoreIndex()
    await this.permissions.markExpired()
  }

  private async persistState(): Promise<void> {
    const state: PersistedRelayState = {
      schemaVersion: 2,
      services: [...this.services.values()].map(service => ({ ...service })),
      runs: [...this.runs.values()].map(run => ({
        snapshot: persistedSnapshot(run.snapshot, this.config.persistPromptText),
        baselineSeq: run.baselineSeq,
        promptRpcId: run.promptRpcId,
      })),
      operations: this.journal.list(),
      permissionLeases: this.permissions.list(),
    }
    await this.stateStore.save(state)
  }

  private async open(service: ServiceRecord, url: string): Promise<void> {
    try {
      await openUrl(url)
      service.browserOpened = true
      service.browserError = null
    } catch (error) {
      service.browserError = errorText(error)
      throw error
    }
  }

  private requireService(serviceId: string): ServiceRecord {
    const service = this.services.get(serviceId)
    if (service === undefined) throw new Error(`unknown serviceId: ${serviceId}`)
    return service
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId)
    if (run === undefined) throw new Error(`unknown runId: ${runId}`)
    return run
  }

  private requireOperation(operationId: string): OperationRecord {
    const operation = this.operations.get(operationId)
    if (operation === undefined) throw new Error(`unknown operationId: ${operationId}`)
    return operation
  }

  private activeKey(serviceId: string, sessionId: string): string {
    return `${serviceId}:${sessionId}`
  }
}

function occupiesSlot(snapshot: RunSnapshot): boolean {
  return snapshot.status === 'running' || snapshot.status === 'unknown' || snapshot.status === 'needs_attention'
}
