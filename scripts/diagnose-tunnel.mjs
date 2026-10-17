#!/usr/bin/env node
// Read-only operator probe. Never emits metric labels, response bodies or URLs.
const [base, maxAge = '120'] = process.argv.slice(2)
let url
try {
  url = new URL(base)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error()
  if (!Number.isFinite(Number(maxAge)) || Number(maxAge) <= 0) throw new Error()
} catch {
  process.stderr.write('Usage: node scripts/diagnose-tunnel.mjs http://127.0.0.1:<admin-port>/ [max-poll-age-seconds]\n')
  process.exit(2)
}

const names = [
  'commands_poll_cycles_total', 'commands_poll_errors_total',
  'commands_poll_last_successful_timestamp_seconds',
  'commands_queue_length', 'dispatcher_worker_pool_occupancy',
]
async function probe(path) {
  try {
    const response = await fetch(new URL(path, url), { signal: AbortSignal.timeout(5000), redirect: 'error' })
    return { httpStatus: response.status, body: await response.text() }
  } catch {
    return { httpStatus: null, body: '' }
  }
}
const [health, ready, metrics] = await Promise.all(['/health?details=true', '/readyz', '/metrics'].map(probe))
let live = null, locallyReady = null
const controlPlane = { status: null, state: null, httpStatus: null, consecutiveFailures: null }
const responseDelivery = { status: null, state: null, disposition: null, httpStatus: null, inProgress: null }
const dispatcher = { status: null, state: null, accepting: null, active: null, completed: null, failures: null, timeouts: null }
try {
  const parsed = JSON.parse(health.body)
  if (typeof parsed.live === 'boolean') live = parsed.live
  if (typeof parsed.ready === 'boolean') locallyReady = parsed.ready
  const component = parsed.components?.['control-plane']
  // Only bounded, documented values may leave this probe. Never copy raw errors.
  if (['ok', 'degraded', 'unknown'].includes(component?.status)) controlPlane.status = component.status
  if (['starting', 'polling', 'idle', 'backoff', 'backpressured', 'stopped'].includes(component?.state)) controlPlane.state = component.state
  const details = component?.details
  if (Number.isInteger(details?.http_status) && details.http_status >= 100 && details.http_status <= 599) controlPlane.httpStatus = details.http_status
  if (Number.isSafeInteger(details?.consecutive_failures) && details.consecutive_failures >= 0) controlPlane.consecutiveFailures = details.consecutive_failures
  const delivery = parsed.components?.['response-delivery']
  const dispositions = ['not_observed', 'accepted', 'already_fulfilled_or_unknown', 'failed', 'canceled']
  if (['ok', 'degraded', 'unknown', 'disabled'].includes(delivery?.status)) responseDelivery.status = delivery.status
  if ([...dispositions, 'uploading'].includes(delivery?.state)) responseDelivery.state = delivery.state
  if (dispositions.includes(delivery?.details?.disposition)) responseDelivery.disposition = delivery.details.disposition
  if (Number.isInteger(delivery?.details?.http_status) && delivery.details.http_status >= 100 && delivery.details.http_status <= 599) responseDelivery.httpStatus = delivery.details.http_status
  if (Number.isSafeInteger(delivery?.details?.in_progress) && delivery.details.in_progress >= 0) responseDelivery.inProgress = delivery.details.in_progress
  const dispatch = parsed.components?.dispatcher
  if (['ok', 'degraded', 'unknown'].includes(dispatch?.status)) dispatcher.status = dispatch.status
  if (['starting', 'accepting', 'draining', 'stopped'].includes(dispatch?.state)) dispatcher.state = dispatch.state
  if (typeof dispatch?.details?.accepting === 'boolean') dispatcher.accepting = dispatch.details.accepting
  for (const field of ['active', 'completed', 'failures', 'timeouts']) {
    if (Number.isSafeInteger(dispatch?.details?.[field]) && dispatch.details[field] >= 0) dispatcher[field] = dispatch.details[field]
  }
} catch { /* Missing JSON is reported without echoing its contents. */ }
const samples = new Map(names.map(name => [name, []]))
if (metrics.httpStatus === 200) {
  for (const line of metrics.body.split('\n')) {
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^\n]*\})?\s+([-+\d.eE]+)(?:\s+\d+)?\s*$/.exec(line)
    if (match && samples.has(match[1]) && Number.isFinite(Number(match[2]))) samples.get(match[1]).push(Number(match[2]))
  }
}
const lastValues = samples.get('commands_poll_last_successful_timestamp_seconds')
const lastSuccess = lastValues.length ? Math.min(...lastValues) : null
const ageSeconds = lastSuccess !== null && lastSuccess > 0 ? Math.max(0, Date.now() / 1000 - lastSuccess) : null
const localHealthy = health.httpStatus === 200 && live === true && locallyReady === true && ready.httpStatus === 200
// A recent isolated success does not clear a subsequent failure or its retry.
const pollingDegraded = controlPlane.status === 'degraded' || controlPlane.state === 'backoff'
  || controlPlane.state === 'stopped' || controlPlane.consecutiveFailures > 0
// DeliveryHealth keeps failure evidence while uploading; cumulative terminal
// failures survive recovery and must not make an accepted delivery fail forever.
const deliveryDegraded = responseDelivery.status === 'degraded' || responseDelivery.state === 'failed'
  || responseDelivery.disposition === 'failed'
// ActivityHealth retains the latest work outcome until a healthy completion.
// Its cumulative failures/timeouts alone do not describe current degradation.
const dispatcherDegraded = dispatcher.status === 'degraded' || dispatcher.state === 'draining'
  || dispatcher.state === 'stopped' || dispatcher.accepting === false
const status = !localHealthy ? 'local_unavailable'
  : pollingDegraded ? 'polling_degraded'
    : deliveryDegraded ? 'response_delivery_degraded'
      : dispatcherDegraded ? 'dispatcher_degraded'
        : ageSeconds === null ? 'polling_unverified'
          : ageSeconds > Number(maxAge) ? 'polling_stale'
            : controlPlane.status !== 'ok' ? 'polling_unverified' : 'polling_current'
const counters = Object.fromEntries(names.filter(name => !name.endsWith('_timestamp_seconds')).map(name => {
  const values = samples.get(name)
  return [name, values.length ? values.reduce((sum, value) => sum + value, 0) : null]
}))
process.stdout.write(`${JSON.stringify({
  layer: 'tunnel_client', status,
  healthHttpStatus: health.httpStatus, readyHttpStatus: ready.httpStatus, metricsHttpStatus: metrics.httpStatus,
  live, locallyReady, pollAgeSeconds: ageSeconds === null ? null : Math.floor(ageSeconds),
  maxPollAgeSeconds: Number(maxAge), controlPlane, responseDelivery, dispatcher, counters,
  nextAction: ['polling_stale', 'polling_degraded'].includes(status) ? 'inspect_controlplane_poll_failures'
    : status === 'response_delivery_degraded' ? 'inspect_response_delivery_failures'
      : status === 'dispatcher_degraded' ? 'inspect_mcp_dispatch_failures'
        : status === 'local_unavailable' ? 'inspect_local_client_service'
          : status === 'polling_unverified' ? 'inspect_poll_telemetry' : 'verify_original_dot_connection',
  dotAcceptance: 'not_tested', replayedRequests: 0,
})}\n`)
process.exitCode = status === 'polling_current' ? 0 : status === 'polling_unverified' ? 2 : 1
