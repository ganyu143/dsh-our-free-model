/**
 * The plugin's egress ignores the host's environment proxy.
 *
 * A harness started with `NODE_USE_ENV_PROXY=1` and `HTTP(S)_PROXY` set routes
 * every `fetch` in the process through the machine's local proxy — including
 * this plugin's long-lived model stream and its probe of the address the
 * gateway sees. `src/net.js` borrows undici's own `no_proxy` agent and passes it
 * per request instead, because the global dispatcher is built once at bootstrap
 * and a plugin cannot move anything off it afterwards.
 *
 * The checks are offline in both halves: the first installs stand-ins for the
 * global dispatcher, and the second starts a loopback server, points a child
 * process at a closed proxy port, and shows that the default fetch goes to the
 * proxy while `directFetch` reaches the server.
 *
 * Run: node scripts/net-test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

// ── reading the direct agent out of a dispatcher ─────────────────────────────
const directAgent = { dispatch: () => true, close: async () => {}, destroy: async () => {} }
/** A stand-in that reports itself as undici's `EnvHttpProxyAgent`, holding only the given symbols. */
function envAgent(symbols) {
  class EnvHttpProxyAgent {}
  const instance = Object.create(EnvHttpProxyAgent.prototype)
  for (const [key, value] of symbols) Object.defineProperty(instance, key, { value, enumerable: false })
  return instance
}

const { directAgentOf, directDispatcher, directInit, envProxyPreferred } = await import('../src/net.js')

check('no dispatcher at all: nothing to borrow', () => {
  assert.equal(directAgentOf(undefined), undefined)
  assert.equal(directAgentOf(null), undefined)
})
check('an already-direct dispatcher is left alone', () => {
  assert.equal(directAgentOf({ constructor: { name: 'Agent' }, dispatch: () => true }), undefined)
})
check('the no_proxy agent behind EnvHttpProxyAgent is borrowed', () => {
  assert.equal(directAgentOf(envAgent([[Symbol('no proxy agent'), directAgent]])), directAgent)
})
check('an EnvHttpProxyAgent whose symbol moved on is not guessed at', () => {
  assert.equal(directAgentOf(envAgent([])), undefined)
})
check('a borrowed symbol that no longer holds a dispatcher is refused', () => {
  assert.equal(directAgentOf(envAgent([[Symbol('no proxy agent'), { not: 'a dispatcher' }]])), undefined)
})
check('by default the host proxy is ignored, not consulted', () => {
  assert.equal(envProxyPreferred(), false)
})

// ── the live process, whatever its environment happens to be ─────────────────
const live = globalThis[Symbol.for('undici.globalDispatcher.1')]
if (live?.constructor?.name === 'EnvHttpProxyAgent') {
  check('this process has an env proxy, and its direct agent is borrowed', () => {
    assert.equal(typeof directDispatcher()?.dispatch, 'function')
    assert.equal(directInit().dispatcher, directDispatcher())
  })
} else {
  console.log(`SKIP  this process installs no environment proxy (${live?.constructor?.name ?? 'none'}): the default is already direct`)
}

// ── the opt-out ──────────────────────────────────────────────────────────────
const previousOptOut = process.env.OUR_FREE_MODEL_USE_ENV_PROXY
process.env.OUR_FREE_MODEL_USE_ENV_PROXY = '1'
try {
  const opted = await import(`../src/net.js?optout=${String(Math.random())}`)
  check('OUR_FREE_MODEL_USE_ENV_PROXY=1 keeps the host proxy in the path', () => {
    assert.equal(opted.envProxyPreferred(), true)
    assert.deepEqual(opted.directInit(), {})
    assert.equal(opted.directDispatcher(), undefined)
  })
} finally {
  if (previousOptOut === undefined) delete process.env.OUR_FREE_MODEL_USE_ENV_PROXY
  else process.env.OUR_FREE_MODEL_USE_ENV_PROXY = previousOptOut
}

// ── the live half: a closed proxy port, a loopback server, one child ─────────
/**
 * The child starts a loopback server and fetches it twice: once the ordinary
 * way, once through `directFetch`. With `NO_PROXY` emptied and the proxy on a
 * closed port the ordinary fetch cannot succeed, so a success in the second call
 * is the bypass rather than a network that happened to be direct.
 *
 * A runtime without environment-proxy support installs no `EnvHttpProxyAgent`,
 * both calls go direct, and the checks report themselves skipped instead of
 * passing on a coincidence.
 */
const CHILD = `
import http from 'node:http'
const { directFetch, directDispatcher } = await import(${JSON.stringify(new URL('../src/net.js', import.meta.url).href)})
const server = http.createServer((request, response) => { response.end('direct-ok') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = 'http://127.0.0.1:' + String(server.address().port) + '/'
const attempt = async (init) => {
  try { return await (await fetch(url, init)).text() }
  catch (error) { return 'ERR:' + String(error.cause?.code ?? error.name) }
}
const viaDefault = await attempt({})
const viaDirect = await (await directFetch(url)).text()
server.close()
console.log(JSON.stringify({
  dispatcher: globalThis[Symbol.for('undici.globalDispatcher.1')]?.constructor?.name ?? 'none',
  borrowed: directDispatcher() !== undefined,
  viaDefault,
  viaDirect,
}))
`

const outcome = await new Promise(resolve => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      ALL_PROXY: '',
      NO_PROXY: '',
      no_proxy: '',
      OUR_FREE_MODEL_USE_ENV_PROXY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { err += chunk })
  child.on('close', code => {
    try { resolve({ code, ...JSON.parse(out.trim().split('\n').pop()) }) }
    catch { resolve({ code, parseError: out + err }) }
  })
})

if (outcome.parseError !== undefined) {
  failures += 1
  console.error(`FAIL  the probe child did not report (exit ${outcome.code}) — ${outcome.parseError.trim().slice(0, 400)}`)
} else if (outcome.dispatcher !== 'EnvHttpProxyAgent') {
  console.log(`SKIP  this Node (${process.version}) installs no environment proxy: nothing to bypass`)
} else {
  check('the default path really is the proxy (this check has teeth)', () => {
    assert.equal(outcome.borrowed, true)
    assert.match(outcome.viaDefault, /^ERR:/, 'a fetch to a server with the proxy on a closed port succeeded')
  })
  check('directFetch reaches the server without the proxy', () => {
    assert.equal(outcome.viaDirect, 'direct-ok')
  })
}

console.log(failures === 0 ? '\nnet: plugin egress stands outside the host proxy' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
