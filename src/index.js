// dsh-client-ui-trajectory-plus - host half.
//
// ONE route, loopback only, GET only:
//
//   GET /dsh-client-ui-trajectory-plus/state?sessionId=<id>[&siblings=a,b][&rerunSeqs=turn:seq,...]
//
// WHAT THIS PLUGIN DOES NOT DO
// ----------------------------
// It never appends, replaces or rewrites a session event. There is no write path
// anywhere in this file, and there is not even a write VERB: the route answers
// every non-GET method with 405 and no request body is ever read. The two card
// actions POST straight to the sibling plugins' own routes from the browser half,
// so this half never needs a POST - not even to proxy them. The test suite
// enforces that mechanically, and asserts that the source contains no POST literal
// at all.
//
// READING THE LOG
// ---------------
// Events come from the official query service (ctx.get('sessionQuery').readSession),
// never from parsing a log file, so the shapes this plugin reasons about are the
// shapes the runtime actually validated and persisted. A live Session's own
// snapshot is the fallback when the service is absent or throws.
//
// THE PLATFORM'S OWN SURFACE COMES FIRST
// -------------------------------------
// platformSurfaceOf reads session.surface.nodes: the live Session's incremental
// SurfaceManager, i.e. the platform's own ordered surface - the same thing the
// trajectory view draws. It needs no SDK import; the service hands the object
// back and we read one getter. The getter may throw (a projection definition can
// be unloaded while a session still references it), so it is wrapped: a failure
// degrades to our own fold and is reported as platformError instead of turning
// the route into a 500.
//
// This module imports nothing from the DSH SDK: sessions, sessionQuery and
// webServer are resolved through the cordis context at call time, so the plugin
// loads on any profile and degrades to a clear HTTP failure when a service is
// absent.
import {
  PLUGIN_ID,
  VERSION,
  ROUTE_PREFIX,
  describeSurface,
  isSessionId,
  parseRerunSeqs,
  parseSiblingList,
  resolveConfig,
} from './logic.js'

export const name = PLUGIN_ID
export const version = VERSION

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

// A session id travels in two spellings: the raw uuid and 'session-<uuid>'. The
// store, the persistence directories and the workspace rows disagree about which
// one they hold, so every lookup tries both.
function idVariants(sessionId) {
  const out = new Set([sessionId])
  if (sessionId.startsWith('session-')) out.add(sessionId.slice('session-'.length))
  else out.add('session-' + sessionId)
  return [...out]
}

function findLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return undefined
  for (const variant of idVariants(sessionId)) {
    const found = sessions.get(variant)
    if (found) return found
  }
  return undefined
}

function eventsFromLive(session) {
  if (session === null || session === undefined || typeof session.snapshotEvents !== 'function') return undefined
  try {
    const events = session.snapshotEvents()
    if (Array.isArray(events)) return events
  } catch (error) {
    // A snapshot read is deprecated and the platform may stop honouring it at any
    // time; fall through to the query service.
    return undefined
  }
  return undefined
}

/** Live-preferred read through the public query service. */
async function readEvents(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query !== undefined && query !== null && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId)
      if (snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.events)) return snapshot.events
    } catch (error) {
      const fallback = eventsFromLive(findLiveSession(ctx, sessionId))
      return fallback === undefined ? null : fallback
    }
  }
  const events = eventsFromLive(findLiveSession(ctx, sessionId))
  return events === undefined ? null : events
}

/**
 * The platform's OWN surface, when a live Session can supply it.
 *
 * session.surface is the Session's incremental SurfaceManager, so
 * session.surface.nodes IS the platform's current model-visible node list - the
 * same list the trajectory view draws. Whenever this succeeds the page is showing
 * the platform's own projection rather than ours, and the payload says so through
 * surfaceSource.
 */
function platformSurfaceOf(ctx, sessionId) {
  const session = findLiveSession(ctx, sessionId)
  if (session === null || session === undefined) return { nodes: null, error: null }
  try {
    const surface = session.surface
    if (surface === null || typeof surface !== 'object') return { nodes: null, error: 'no-surface' }
    const nodes = surface.nodes
    if (Array.isArray(nodes) === false) return { nodes: null, error: 'no-nodes' }
    return { nodes: nodes.map((seq) => Number(seq)), error: null }
  } catch (error) {
    return { nodes: null, error: String((error && error.message) || error) }
  }
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function isLocalHostHeader(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const name = host.split(':')[0].toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The browser half reads this from the same origin; no store anywhere.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Loopback socket, loopback Host header and a same-origin check when the browser
 * sends Origin. This plugin mutates nothing, but it reports on a session's
 * contents, so it stays off the network just the same.
 */
function guard(req, res) {
  if (isLoopbackAddress(req.socket && req.socket.remoteAddress) === false) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'loopback only' })
    return false
  }
  const host = req.headers.host
  if (isLocalHostHeader(host) === false) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'unexpected host' })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost = null
    try {
      originHost = new URL(origin).host
    } catch (error) {
      originHost = null
    }
    if (originHost !== host) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'cross-origin request' })
      return false
    }
  }
  return true
}

function queryOf(url) {
  try {
    return new URL(url, 'http://localhost').searchParams
  } catch (error) {
    return new URLSearchParams('')
  }
}

function failure(res, error) {
  const status = error instanceof HttpError ? error.status : 500
  const code = error instanceof HttpError ? error.code : 'internal'
  sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) })
}

/**
 * Mount the plugin.
 *
 * ONE route, GET only, no request body. The mount probe convention holds here
 * too: without a sessionId the route answers 400, so the difference between 400
 * and 404 is exactly 'installed' versus 'not installed'.
 *
 * @param ctx - cordis context.
 * @param config - option overrides; see DEFAULT_OPTIONS in src/logic.js.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)

  const registerRoutes = (webServer, fiber) => {
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + '/state',
        handler: async (req, res) => {
          if (guard(req, res) === false) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
            return
          }
          try {
            const params = queryOf(req.url)
            const sessionId = (params.get('sessionId') || '').trim()
            if (sessionId === '') throw new HttpError(400, 'invalid', 'sessionId required')
            if (isSessionId(sessionId) === false) throw new HttpError(400, 'invalid', 'invalid session id')
            // The window is the caller's to widen (the platform's own views work
            // the same way). It is clamped, so one request cannot ask for the whole
            // log at once.
            const wanted = Number((queryOf(req.url).get('turns') || '').trim())
            const windowed =
              Number.isSafeInteger(wanted) && wanted > 0
                ? { options: { ...resolved.options, maxTurns: Math.min(wanted, 1000) }, unknown: resolved.unknown }
                : resolved
            const events = await readEvents(ctx, sessionId)
            if (events === null) throw new HttpError(404, 'session-not-found', 'no session log for this id')
            const platform = platformSurfaceOf(ctx, sessionId)
            const payload = describeSurface(events, {
              resolved: windowed,
              platformNodes: platform.nodes,
              siblings: parseSiblingList(params.get('siblings')),
              rerunSeqs: parseRerunSeqs(params.get('rerunSeqs')),
            })
            sendJson(res, 200, {
              ok: true,
              sessionId,
              live: findLiveSession(ctx, sessionId) !== undefined,
              platformError: platform.error,
              ...payload,
            })
          } catch (error) {
            failure(res, error)
          }
        },
      }),
    )
  }

  const webServer = ctx.get('webServer')
  if (webServer) registerRoutes(webServer, ctx)
  else ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
}
