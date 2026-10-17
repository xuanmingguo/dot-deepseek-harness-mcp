import { HostRpcError, type HarnessGatewayFacade } from '../harness-gateway/index.js'
import type { OperationRecord, PromptPart } from '../types.js'
import { errorText } from './helpers.js'
import type { RunRecord } from './internal-types.js'
import type { OperationJournal } from './operation-journal.js'
import type { RunReconciler } from './run-reconciler.js'

export class PromptAdmissionController {
  constructor(
    private readonly gateway: HarnessGatewayFacade,
    private readonly journal: OperationJournal,
    private readonly reconciler: RunReconciler,
  ) {}

  async submit(run: RunRecord, operation: OperationRecord, content: PromptPart[]): Promise<void> {
    const snapshot = run.snapshot
    try {
      if (operation.state === 'prepared') await this.journal.transition(operation, 'submitted')
    } catch (error) {
      // The journal may have mutated its in-memory state before persistence
      // failed, but no gateway invocation has started at this boundary.
      snapshot.promptAdmission = 'rejected'
      throw await this.journal.fail(operation, error, 'not_submitted')
    }
    let correlationFailed = false
    let correlationError: unknown
    let accepted: { accepted: true; rpcId: string; messageId?: string }
    try {
      accepted = await this.gateway.submitPrompt(snapshot.sessionId, 'queue', content, run.promptRpcId, async actualRpcId => {
        try {
          run.promptRpcId = actualRpcId
          await this.journal.correlateRpcId(operation, actualRpcId)
        } catch (error) {
          // Supported adapters await this hook before dispatch. Capture the
          // original failure even if the carrier wraps the callback error.
          correlationFailed = true
          correlationError = error
          throw error
        }
      })
    } catch (error) {
      if (correlationFailed) {
        snapshot.promptAdmission = 'rejected'
        throw await this.journal.fail(operation, correlationError, 'not_submitted')
      }
      snapshot.error = errorText(error)
      if (error instanceof HostRpcError && error.definitiveRejection) {
        snapshot.promptAdmission = 'rejected'
        await this.journal.fail(operation, error, 'rejected')
        await this.reconciler.finalize(run, 'failed', snapshot.error)
      } else {
        snapshot.promptAdmission = 'unknown'
        const warning = 'The prompt response was unavailable; DSH Relay is reconciling durable history by rpcId'
        if (!snapshot.warnings.includes(warning)) snapshot.warnings.push(warning)
        await this.journal.transition(operation, 'unknown', { error: snapshot.error })
      }
      return
    }
    snapshot.promptAdmission = 'accepted'
    run.promptRpcId = accepted.rpcId
    snapshot.promptMessageId = accepted.messageId ?? null
    snapshot.error = null
    await this.journal.transition(operation, 'acknowledged', { messageId: snapshot.promptMessageId, error: null })
  }
}
