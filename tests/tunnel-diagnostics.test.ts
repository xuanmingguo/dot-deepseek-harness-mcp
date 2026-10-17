import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('../scripts/diagnose-tunnel.mjs', import.meta.url))
test('operator probe detects stale polling behind green health and never emits private labels or bodies', async t => {
  let lastSuccess: number | undefined = Math.floor(Date.now() / 1000) - 600
  let unavailable = false
  let component: any = { status: 'ok', state: 'polling', details: { consecutive_failures: 0 } }
  const paths: string[] = []
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET')
    paths.push(req.url!)
    if (unavailable) { res.writeHead(503); res.end('private-response-body'); return }
    if (req.url === '/metrics') {
      res.end([
        'commands_poll_cycles_total 45',
        'commands_poll_errors_total{endpoint="private-tunnel-identifier"} 40',
        'commands_poll_errors_total{endpoint="private-second-identifier"} 4',
        ...(lastSuccess === undefined ? [] : [`commands_poll_last_successful_timestamp_seconds ${lastSuccess}`]),
        'commands_queue_length 0', 'dispatcher_worker_pool_occupancy 0',
      ].join('\n'))
    } else res.end(JSON.stringify({ live: true, ready: true, components: { 'control-plane': component }, privateField: 'private-response-body' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const run = () => new Promise<{ code: number; value: Record<string, any> }>((resolve, reject) => {
    execFile(process.execPath, [script, `http://127.0.0.1:${address.port}/`], (error, stdout, stderr) => {
      try {
        assert.equal(stderr, '')
        assert.doesNotMatch(stdout, /private-|http:\/\//)
        resolve({ code: error ? Number(error.code) : 0, value: JSON.parse(stdout) })
      } catch (caught) { reject(caught) }
    })
  })
  const stale = await run()
  assert.equal(stale.code, 1)
  assert.equal(stale.value.status, 'polling_stale')
  assert.equal(stale.value.locallyReady, true)
  assert.equal(stale.value.counters.commands_poll_errors_total, 44)
  assert.equal(stale.value.dotAcceptance, 'not_tested')
  assert.equal(stale.value.replayedRequests, 0)
  lastSuccess = Math.floor(Date.now() / 1000)
  const current = await run()
  assert.equal(current.code, 0)
  assert.equal(current.value.status, 'polling_current')
  assert.equal(current.value.dotAcceptance, 'not_tested')
  component = { status: 'degraded', state: 'backoff', details: { consecutive_failures: 1, http_status: 504, error: 'private-response-body' } }
  const degraded = await run()
  assert.equal(degraded.code, 1)
  assert.equal(degraded.value.status, 'polling_degraded')
  assert.deepEqual(degraded.value.controlPlane, { status: 'degraded', state: 'backoff', httpStatus: 504, consecutiveFailures: 1 })
  // Starting the next poll must not hide the unresolved failure either.
  component.state = 'polling'
  assert.equal((await run()).value.status, 'polling_degraded')
  component = undefined
  const missing = await run()
  assert.equal(missing.code, 2)
  assert.equal(missing.value.status, 'polling_unverified')
  component = { status: 'private-status', state: 'private-state', details: { consecutive_failures: 'private-count', http_status: 'private-error' } }
  const malformed = await run()
  assert.equal(malformed.value.status, 'polling_unverified')
  assert.deepEqual(malformed.value.controlPlane, { status: null, state: null, httpStatus: null, consecutiveFailures: null })
  component = { status: 'ok', state: 'polling', details: { consecutive_failures: 0 } }
  lastSuccess = undefined
  const unknown = await run()
  assert.equal(unknown.code, 2)
  assert.equal(unknown.value.status, 'polling_unverified')
  unavailable = true
  const offline = await run()
  assert.equal(offline.code, 1)
  assert.equal(offline.value.status, 'local_unavailable')
  assert.equal(paths.length, 24)
  assert(paths.every(path => ['/health?details=true', '/readyz', '/metrics'].includes(path)))
})

test('operator probe rejects degraded response delivery behind green readiness and accepts recovery', async t => {
  let delivery: any
  const paths: string[] = []
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET')
    paths.push(req.url!)
    if (req.url === '/metrics') {
      res.end(`commands_poll_last_successful_timestamp_seconds ${Math.floor(Date.now() / 1000)}\n`)
    } else {
      res.end(JSON.stringify({
        live: true, ready: true,
        components: {
          'control-plane': { status: 'ok', state: 'polling', details: { consecutive_failures: 0 } },
          'response-delivery': delivery,
        },
      }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const run = () => new Promise<{ code: number; value: Record<string, any> }>((resolve, reject) => {
    execFile(process.execPath, [script, `http://127.0.0.1:${address.port}/`], (error, stdout, stderr) => {
      try {
        assert.equal(stderr, '')
        assert.doesNotMatch(stdout, /private-|https?:\/\//)
        const value = JSON.parse(stdout)
        assert.equal(value.healthHttpStatus, 200)
        assert.equal(value.readyHttpStatus, 200)
        assert.equal(value.locallyReady, true)
        assert.equal(value.controlPlane.status, 'ok')
        assert.equal(value.dotAcceptance, 'not_tested')
        assert.equal(value.replayedRequests, 0)
        resolve({ code: error ? Number(error.code) : 0, value })
      } catch (caught) { reject(caught) }
    })
  })
  delivery = {
    status: 'degraded', state: 'failed', reason_code: 'private-reason',
    details: {
      disposition: 'failed', http_status: 503, in_progress: 0, terminal_failures: 3,
      error: 'private-response-body', endpoint: 'https://private-endpoint/', request_id: 'private-id',
    },
  }
  const broken = await run()
  assert.equal(broken.code, 1)
  assert.equal(broken.value.status, 'response_delivery_degraded')
  assert.equal(broken.value.nextAction, 'inspect_response_delivery_failures')
  assert.deepEqual(broken.value.responseDelivery, {
    status: 'degraded', state: 'failed', disposition: 'failed', httpStatus: 503, inProgress: 0,
  })

  // Recovery clears current failure evidence, not the cumulative failure count.
  delivery.status = 'ok'
  delivery.state = 'accepted'
  delivery.details.disposition = 'accepted'
  delivery.details.http_status = 200
  const recovered = await run()
  assert.equal(recovered.code, 0)
  assert.equal(recovered.value.status, 'polling_current')
  assert.equal(recovered.value.nextAction, 'verify_original_dot_connection')
  assert.equal(delivery.details.terminal_failures, 3)
  delivery.state = 'uploading'
  delivery.details.in_progress = 1
  assert.equal((await run()).value.status, 'polling_current')
  // An attempt failure is current even when the previous completion succeeded.
  delivery.status = 'degraded'
  delivery.details.http_status = 503
  assert.equal((await run()).value.status, 'response_delivery_degraded')
  // Uploading can hide the terminal disposition in the component state.
  delivery.status = 'unknown'
  delivery.details.disposition = 'failed'
  assert.equal((await run()).value.status, 'response_delivery_degraded')
  delivery.state = 'failed'
  delivery.details.disposition = 'private-disposition'
  assert.equal((await run()).value.status, 'response_delivery_degraded')

  for (const disposition of ['not_observed', 'already_fulfilled_or_unknown', 'canceled']) {
    delivery = { status: 'unknown', state: disposition, details: { disposition, terminal_failures: 3 } }
    assert.equal((await run()).value.status, 'polling_current')
  }
  delivery = { status: 'unknown', state: 'uploading', details: { disposition: 'not_observed', in_progress: 1 } }
  assert.equal((await run()).value.status, 'polling_current')
  delivery = undefined
  const legacy = await run()
  assert.equal(legacy.code, 0)
  assert.equal(legacy.value.status, 'polling_current')
  delivery = {
    status: 'private-status', state: 'private-state',
    details: { disposition: 'private-disposition', http_status: 'private-status', in_progress: 'private-count' },
  }
  const malformed = await run()
  assert.equal(malformed.value.status, 'polling_current')
  assert.deepEqual(malformed.value.responseDelivery, { status: null, state: null, disposition: null, httpStatus: null, inProgress: null })
  assert.equal(paths.length, 36)
  assert(paths.every(path => ['/health?details=true', '/readyz', '/metrics'].includes(path)))
})


test('operator probe detects current dispatcher failure despite green polling and delivery, then accepts recovery', async t => {
  let dispatcher: any = {
    status: 'degraded', state: 'accepting', reason_code: 'private-reason',
    details: {
      accepting: true, active: 0, completed: 4, failures: 2, timeouts: 1,
      request_id: 'private-id', error: 'private-response-body', endpoint: 'https://private-endpoint/',
    },
  }
  const paths: string[] = []
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET')
    paths.push(req.url!)
    if (req.url === '/metrics') {
      res.end(`commands_poll_last_successful_timestamp_seconds ${Math.floor(Date.now() / 1000)}\n`)
    } else {
      res.end(JSON.stringify({
        live: true, ready: true,
        components: {
          'control-plane': { status: 'ok', state: 'polling', details: { consecutive_failures: 0 } },
          'response-delivery': { status: 'ok', state: 'accepted', details: { disposition: 'accepted', http_status: 200 } },
          dispatcher,
        },
      }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const run = () => new Promise<{ code: number; value: Record<string, any> }>((resolve, reject) => {
    execFile(process.execPath, [script, `http://127.0.0.1:${address.port}/`], (error, stdout, stderr) => {
      try {
        assert.equal(stderr, '')
        assert.doesNotMatch(stdout, /private-|https?:\/\//)
        const value = JSON.parse(stdout)
        assert.equal(value.healthHttpStatus, 200)
        assert.equal(value.readyHttpStatus, 200)
        assert.equal(value.locallyReady, true)
        assert.equal(value.controlPlane.status, 'ok')
        assert.equal(value.responseDelivery.status, 'ok')
        assert.equal(value.dotAcceptance, 'not_tested')
        assert.equal(value.replayedRequests, 0)
        resolve({ code: error ? Number(error.code) : 0, value })
      } catch (caught) { reject(caught) }
    })
  })
  // ActivityHealth records swallowed response expiry as a failed, timed-out completion.
  const expired = await run()
  assert.equal(expired.code, 1)
  assert.equal(expired.value.status, 'dispatcher_degraded')
  assert.equal(expired.value.nextAction, 'inspect_mcp_dispatch_failures')
  assert.deepEqual(expired.value.dispatcher, {
    status: 'degraded', state: 'accepting', accepting: true, active: 0, completed: 4, failures: 2, timeouts: 1,
  })

  // Starting more work does not clear the latest failed completion.
  dispatcher.details.active = 1
  assert.equal((await run()).value.status, 'dispatcher_degraded')
  // A healthy completion clears status, while cumulative failures/timeouts stay unchanged.
  dispatcher.status = 'ok'
  dispatcher.details.active = 0
  dispatcher.details.completed = 5
  const recovered = await run()
  assert.equal(recovered.code, 0)
  assert.equal(recovered.value.status, 'polling_current')
  assert.equal(recovered.value.nextAction, 'verify_original_dot_connection')
  assert.equal(recovered.value.dispatcher.failures, 2)
  assert.equal(recovered.value.dispatcher.timeouts, 1)
  dispatcher.details.active = 1
  assert.equal((await run()).value.status, 'polling_current')

  // Listener shutdown stops accepting commands even if its last work succeeded.
  for (const state of ['draining', 'stopped']) {
    dispatcher = { status: 'ok', state, details: { accepting: false } }
    const stopped = await run()
    assert.equal(stopped.code, 1)
    assert.equal(stopped.value.status, 'dispatcher_degraded')
  }
  dispatcher = { status: 'unknown', state: 'starting', details: { accepting: false } }
  assert.equal((await run()).value.status, 'dispatcher_degraded')

  dispatcher = undefined
  const legacy = await run()
  assert.equal(legacy.code, 0)
  assert.equal(legacy.value.status, 'polling_current')
  const unobserved = { status: null, state: null, accepting: null, active: null, completed: null, failures: null, timeouts: null }
  assert.deepEqual(legacy.value.dispatcher, unobserved)
  dispatcher = {
    status: 'private-status', state: 'private-state',
    details: { accepting: 'private-bool', active: -1, completed: 0.5, failures: Number.MAX_SAFE_INTEGER + 1, timeouts: 'private-count' },
  }
  const malformed = await run()
  assert.equal(malformed.code, 0)
  assert.equal(malformed.value.status, 'polling_current')
  assert.deepEqual(malformed.value.dispatcher, unobserved)
  assert.equal(paths.length, 27)
  assert(paths.every(path => ['/health?details=true', '/readyz', '/metrics'].includes(path)))
})
