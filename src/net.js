/**
 * The plugin's own egress ignores the host's environment proxy.
 *
 * A harness started under `NODE_USE_ENV_PROXY=1` — with `HTTP_PROXY`,
 * `HTTPS_PROXY` or `ALL_PROXY` in the environment — sends every `fetch` in the
 * process through the machine's local proxy. Node builds that dispatcher once
 * at bootstrap, so a plugin cannot move requests off it afterwards: an entry
 * written into `NO_PROXY` at mount time is read too late. The plugin's own
 * destinations are exactly the ones a local proxy is most likely to hurt — a
 * long-lived SSE stream, and a probe of the address the gateway actually sees.
 *
 * A per-request `dispatcher` still wins. undici keeps one plain `Agent` for the
 * `no_proxy` side of its `EnvHttpProxyAgent`, and it hangs off the global
 * dispatcher under a symbol this module can find; borrowing that agent needs no
 * import, which matters because undici is not a dependency of this package. When
 * the host carries no environment proxy the global dispatcher is already direct,
 * so {@link directInit} contributes nothing and the default options stand.
 *
 * The plugin still reaches the harness's own loopback services: `no_proxy`
 * already covers loopback, and those requests are not this plugin's egress.
 *
 * `OUR_FREE_MODEL_USE_ENV_PROXY=1` puts the host's proxy back in the path for
 * this plugin — the escape hatch for a network where only the proxy routes out.
 *
 * @module src/net.js
 */

/** Spellings of "yes" accepted from `OUR_FREE_MODEL_USE_ENV_PROXY`. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/** Whether the operator asked to keep the host's environment proxy in the path. */
export function envProxyPreferred() {
  return TRUTHY.has(String(process.env.OUR_FREE_MODEL_USE_ENV_PROXY ?? '').trim().toLowerCase())
}

/**
 * The plain agent behind an `EnvHttpProxyAgent`, when it can be borrowed.
 *
 * Two things undici owns are read here: the symbol its `no_proxy` agent hides
 * behind, and the shape of a dispatcher. Both are probed defensively, and
 * anything unexpected — another dispatcher, another symbol name, a symbol that
 * no longer holds a dispatcher — answers `undefined`, which means "use the
 * default dispatcher". A runtime this module does not recognise therefore keeps
 * its current behaviour instead of failing requests.
 *
 * @param {object|undefined} dispatcher - the process's global dispatcher
 * @returns {object|undefined} the direct dispatcher to borrow, if any
 */
export function directAgentOf(dispatcher) {
  if (dispatcher === null || typeof dispatcher !== 'object') return undefined
  if (dispatcher.constructor?.name !== 'EnvHttpProxyAgent') return undefined
  const key = Object.getOwnPropertySymbols(dispatcher).find(symbol => symbol.description === 'no proxy agent')
  const agent = key === undefined ? undefined : dispatcher[key]
  return typeof agent?.dispatch === 'function' ? agent : undefined
}

/**
 * The direct dispatcher of this process, when it has one to lend.
 *
 * @returns {object|undefined} `undefined` when the default dispatcher is already direct
 */
export function directDispatcher() {
  if (envProxyPreferred()) return undefined
  return directAgentOf(globalThis[Symbol.for('undici.globalDispatcher.1')])
}

/**
 * Fetch options that keep one request off the host's environment proxy.
 *
 * @returns {{dispatcher?: object}} empty when the default dispatcher is already direct
 */
export function directInit() {
  const dispatcher = directDispatcher()
  return dispatcher === undefined ? {} : { dispatcher }
}

/**
 * `fetch` under {@link directInit} — the shape the announcement feed and the
 * updater take as their `fetchImpl`.
 *
 * @param {string|URL} url
 * @param {object} [init]
 * @returns {Promise<Response>}
 */
export function directFetch(url, init) {
  return fetch(url, { ...init, ...directInit() })
}
