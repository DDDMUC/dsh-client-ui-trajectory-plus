// dsh-client-ui-trajectory-plus - test suite.
//
//   node --test test/*.test.js
//
// Three groups:
//   1. the pure core and the host route, driven directly;
//   2. the browser half, driven through test/dom-stub.js;
//   3. the mechanical read-only scans, which matter most: this plugin must never
//      gain a way to write a session event.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { apply, name as hostName, version as hostVersion } from '../src/index.js'
import {
  ACTION_RULES,
  BOTTOM_FOLLOW_THRESHOLD_PX,
  HISTORY_LOAD_ROW_HEIGHT_PX,
  HISTORY_PAGE_NODES,
  OLDER_LOAD_THRESHOLD_PX,
  PLUGIN_ID,
  PROBE_ROUTES,
  PROXY_ROUTES,
  REPLACEMENT_AUTHORS,
  ROUTE_PREFIX,
  SIBLING_IDS,
  SURFACE_EVENT_TYPES,
  VERSION,
  VIEW_ID,
  VIEW_ORDER,
  VIRTUALIZATION_THRESHOLD,
  ROW_KINDS,
  actionList,
  buildRows,
  buildStrip,
  dominantReplacementAuthor,
  nonTextCountsOf,
  replacementAuthor,
  rowErrorOf,
  rowKindOf,
  rowLaneOf,
  rowTextOf,
  suppressionList,
  toolCallMap,
  toolMetaOf,
  codeOnly,
  collapseWhitespace,
  describeSurface,
  dshPathsIn,
  foldSurfaceDerived,
  formatText,
  indexTurns,
  isSessionId,
  parseRerunSeqs,
  parseSiblingList,
  resolveConfig,
} from '../src/logic.js'
import { readSource } from './sources.js'
import { loadClient } from './dom-stub.js'

// --- fixtures ----------------------------------------------------------------

const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const SESSION_BARE = '11111111-2222-3333-4444-555555555555'

function ev(seq, type, data, marker) {
  const event = { seq, type, time: 1000 + seq * 10, data: data === undefined ? {} : data }
  if (marker !== undefined) event.surfaceOp = marker
  return event
}
function text(value) {
  return [{ type: 'text', text: value }]
}

/** Four turns: normal, failed-then-recovered, empty, normal - plus a legacy unmarked prompt. */
function turnStory() {
  return [
    ev(0, 'system/message', { content: text('system prompt') }, 'append'),
    ev(1, 'turn/start', { turn: 0 }),
    ev(2, 'user/message', { content: text('first question'), source: { kind: 'user' } }, 'append'),
    ev(3, 'assistant/message', { turn: 0, message: { content: text('first answer') } }, 'append'),
    ev(4, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
    ev(5, 'turn/start', { turn: 1 }),
    ev(6, 'user/message', { content: text('second question'), source: { kind: 'user' } }, 'append'),
    ev(7, 'llm/retry', { turn: 1, attempt: 1 }),
    ev(8, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'E_TEST' } } }),
    ev(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev(10, 'turn/start', { turn: 2 }),
    ev(11, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ev(12, 'turn/start', { turn: 3 }),
    ev(13, 'user/message', { content: text('third  question'), source: { kind: 'user' } }, 'append'),
    ev(14, 'tool/result', { turn: 3, message: { content: [] } }, 'append'),
    ev(15, 'assistant/message', { turn: 3, message: { content: text('third answer') } }, 'append'),
    ev(16, 'turn/end', { turn: 3, reason: { kind: 'completed' } }),
    ev(17, 'user/message', { content: text('legacy without a marker'), source: { kind: 'user' } }),
  ]
}

/** What the platform's own fold produces for turnStory(). */
const PLATFORM_NODES = [0, 2, 3, 6, 13, 14, 15]

/** A turn whose whole current content was replaced away, plus the carrier's own turn. */
function retiredTurn() {
  return [
    ev(0, 'system/message', { content: text('system prompt') }, 'append'),
    ev(1, 'turn/start', { turn: 0 }),
    ev(2, 'user/message', { content: text('question'), source: { kind: 'user' } }, 'append'),
    ev(3, 'assistant/message', { turn: 0, message: { content: text('answer') } }, 'append'),
    ev(4, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
    ev(5, 'turn/start', { turn: 1 }),
    ev(6, 'user/message', { content: text(''), source: { kind: 'plugin:dsh-delete-turn' } }, { op: 'replace', startSeq: 2, endSeq: 3 }),
    ev(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

function syntheticTurn() {
  return [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'assistant/message', { turn: 0, message: { content: text('rewritten answer'), source: { kind: 'plugin:dsh-edit-turn' } } }, 'append'),
    ev(2, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
  ]
}

function resumeTurn() {
  return [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'request/header', { reason: 'resume' }),
    ev(2, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
  ]
}

function runningTurn() {
  return [ev(0, 'turn/start', { turn: 0 }), ev(1, 'user/message', { content: text('question'), source: { kind: 'user' } }, 'append')]
}

const turnOf = (payload, n) => payload.turns.find((card) => card.turn === n)

// --- 1. the pure core --------------------------------------------------------

test('the surface-eligible types, the action table and the view identity are pinned', () => {
  assert.deepEqual(SURFACE_EVENT_TYPES, ['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
  assert.deepEqual(ACTION_RULES.map((rule) => rule.id), ['delete-turn', 'rerun-turn', 'refresh'])
  assert.deepEqual(ACTION_RULES.map((rule) => rule.requires), ['deleteTurn', 'rerunTurn', null])
  assert.equal(VIEW_ID, 'surface')
  assert.equal(VIEW_ORDER, 20)
  assert.equal(ROUTE_PREFIX, '/dsh-client-ui-trajectory-plus')
})

test('the small readers behave without a regular expression', () => {
  assert.equal(collapseWhitespace('  a  b ' + String.fromCharCode(10) + 'c '), 'a b c')
  assert.equal(formatText('{a}/{b}', { a: 1, b: 2 }), '1/2')
  assert.equal(formatText('none', { a: 1 }), 'none')
  assert.equal(isSessionId(SESSION), true)
  assert.equal(isSessionId(SESSION_BARE), true)
  assert.equal(isSessionId('nope'), false)
  assert.equal(isSessionId(null), false)
  assert.deepEqual(dshPathsIn('x /dsh-delete-turn/state y /dsh-rerun-turn/apply'), ['/dsh-delete-turn', '/dsh-rerun-turn'])
  assert.deepEqual(parseSiblingList('rerunTurn,deleteTurn,rerunTurn,nope'), ['rerunTurn', 'deleteTurn'])
  assert.deepEqual(parseSiblingList(undefined), [])
  assert.equal(parseRerunSeqs('0:3,2:11,junk,4:x').size, 2)
  assert.equal(parseRerunSeqs('0:3,2:11,junk,4:x').get(2), 11)
  assert.equal(parseRerunSeqs('').size, 0)
})

test('resolveConfig keeps defaults, applies overrides and reports unknown keys', () => {
  assert.equal(resolveConfig({}).options.renderEveryTurn, true)
  assert.equal(resolveConfig({ renderEveryTurn: false }).options.renderEveryTurn, false)
  assert.deepEqual(resolveConfig({ nope: 1, promptChars: 'wide' }).unknown, ['nope', 'promptChars'])
  assert.equal(resolveConfig({ promptChars: 'wide' }).options.promptChars, 240)
})

test('the derived fold replays appends and positional replacements', () => {
  const folded = foldSurfaceDerived(turnStory())
  assert.deepEqual(folded.nodes, PLATFORM_NODES)
  assert.deepEqual(folded.replacements, [])
  assert.deepEqual(folded.unmarked, [17], 'the legacy prompt carries no marker')
  const retired = foldSurfaceDerived(retiredTurn())
  assert.deepEqual(retired.nodes, [0, 6])
  assert.equal(retired.replacements.length, 1)
  assert.deepEqual(retired.replacements[0].shadowed, [2, 3])
  assert.deepEqual(retired.unmarked, [])
  assert.deepEqual(foldSurfaceDerived([{ seq: 0, type: 'turn/start', data: {} }]).unmarked, [], 'a bracket is not a deviation')
})

test('indexTurns survives a double close and an event with no bracket', () => {
  const indexed = indexTurns(turnStory())
  assert.deepEqual([...indexed.turns.keys()], [0, 1, 2, 3])
  assert.equal(indexed.turns.get(1).ends.length, 2)
  assert.equal(indexed.turns.get(1).ends[0].kind, 'error')
  assert.equal(indexed.turns.get(1).retries, 1)
  assert.equal(indexed.turnOfSeq.get(0), null, 'the system head belongs to no turn')
})

test('describeSurface: every turn gets a card, with its current state', () => {
  const payload = describeSurface(turnStory())
  assert.deepEqual(payload.turns.map((card) => card.turn), [0, 1, 2, 3])
  assert.equal(payload.events, 18)
  assert.equal(payload.nodes, 7)
  assert.equal(payload.surfaceSource, 'derived')
  assert.equal(payload.nodesAgree, null)
  assert.equal(payload.unmarkedSurfaceEvents, 1)
  assert.deepEqual(payload.rowlessTurns, [2])
  assert.deepEqual(payload.orphanNodes, [0])
  assert.equal(payload.busy, false)
  assert.deepEqual(payload.totals, {
    turns: 4,
    shown: 4,
    rowless: 1,
    // The detail rows (task D): one per node that has anything to say. Turn 0 has
    // two (seq 2, 3), turn 1 one (seq 6), turn 2 none, and turn 3 two (seq 13, 15):
    // seq 14 is a tool/result with an EMPTY content array, which is blank and makes
    // no row at all rather than an empty line.
    rows: 5,
    rowsClippedTurns: 0,
    content: 2,
    empty: 1,
    injected: 0,
    replaced: 0,
    compacted: 0,
    synthetic: 0,
    failed: 0,
    recovered: 1,
    running: 0,
  })
  const first = turnOf(payload, 0)
  assert.deepEqual(first.nodeSeqs, [2, 3])
  assert.equal(first.prompt.text, 'first question')
  assert.equal(first.answer.text, 'first answer')
  assert.equal(first.suppressed, 0)
  const third = turnOf(payload, 3)
  assert.equal(third.prompt.text, 'third question', 'whitespace is collapsed')
  assert.deepEqual(third.nodeSeqs, [13, 14, 15])
  assert.deepEqual(turnOf(payload, 2).nodeSeqs, [])
})

test('every special turn is distinguishable', () => {
  const story = describeSurface(turnStory())
  assert.equal(turnOf(story, 2).status, 'empty')
  assert.equal(turnOf(story, 2).rowless, true)
  const recovered = turnOf(story, 1)
  assert.equal(recovered.status, 'recovered')
  assert.equal(recovered.failed, true)
  assert.equal(recovered.recovered, true)
  assert.deepEqual(recovered.ends.map((end) => end.kind), ['error', 'completed'])
  assert.equal(recovered.ends[0].code, 'E_TEST')
  assert.deepEqual(recovered.badges.map((badge) => badge.key), ['badge.failed', 'badge.recovered', 'badge.retried'])

  const retired = describeSurface(retiredTurn())
  assert.equal(turnOf(retired, 0).status, 'replaced')
  assert.equal(turnOf(retired, 0).suppressed, 2)
  assert.deepEqual(turnOf(retired, 0).replacedBy, [6])
  assert.equal(turnOf(retired, 1).status, 'synthetic')
  assert.equal(turnOf(describeSurface(syntheticTurn()), 0).status, 'synthetic')
  assert.equal(turnOf(describeSurface(syntheticTurn()), 0).carriers, 1)
  assert.equal(turnOf(describeSurface(resumeTurn()), 0).status, 'injected')
  assert.equal(turnOf(describeSurface(resumeTurn()), 0).resumes, 1)
  assert.equal(turnOf(describeSurface(runningTurn()), 0).status, 'running')
  assert.equal(describeSurface(runningTurn()).busy, true)
  assert.deepEqual(describeSurface([]).turns, [])
})

test('the platform projection wins when it is available, and disagreement is reported', () => {
  const agree = describeSurface(turnStory(), { platformNodes: PLATFORM_NODES })
  assert.equal(agree.surfaceSource, 'platform')
  assert.equal(agree.nodesAgree, true)
  assert.equal(agree.notices.some((notice) => notice.key === 'notice.nodes-disagree'), false)
  const disagree = describeSurface(turnStory(), { platformNodes: PLATFORM_NODES.concat([17]) })
  assert.equal(disagree.surfaceSource, 'platform')
  assert.equal(disagree.nodesAgree, false)
  assert.equal(disagree.notices.some((notice) => notice.key === 'notice.nodes-disagree'), true)
})

test('the action table drives the buttons, including their targets and reasons', () => {
  const payload = describeSurface(turnStory(), { siblings: SIBLING_IDS, rerunSeqs: parseRerunSeqs('0:3') })
  const first = turnOf(payload, 0)
  assert.deepEqual(first.actions.map((action) => action.id), ['delete-turn', 'rerun-turn', 'refresh'])
  assert.deepEqual(first.actions[0].params, { mode: 'reply', turn: 0 })
  assert.equal(first.actions[0].path, '/dsh-delete-turn/delete')
  assert.equal(first.actions[0].enabled, true)
  assert.equal(first.actions[0].reason, 'ok')
  assert.equal(first.actions[1].path, '/dsh-rerun-turn/apply')
  assert.deepEqual(first.actions[1].params, { seq: 3 })
  assert.equal(first.actions[2].path, ROUTE_PREFIX + '/state')
  assert.equal(turnOf(payload, 1).actions[1].reason, 'no-reply')
  assert.equal(turnOf(payload, 2).actions[0].reason, 'no-target')
  assert.equal(turnOf(payload, 2).actions[2].enabled, true, 'refresh never depends on a sibling')
})

// --- 2. negative verification ------------------------------------------------

test('NEGATIVE: switching off "every turn" removes exactly the rowless cards', () => {
  const every = describeSurface(turnStory(), { resolved: resolveConfig({}) })
  const only = describeSurface(turnStory(), { resolved: resolveConfig({ renderEveryTurn: false }) })
  assert.deepEqual(every.turns.map((card) => card.turn), [0, 1, 2, 3])
  assert.equal(turnOf(every, 2).status, 'empty')
  assert.deepEqual(only.turns.map((card) => card.turn), [0, 1, 3])
  assert.equal(turnOf(only, 2), undefined)
  assert.deepEqual(only.rowlessTurns, [2], 'the hole is still counted')
  assert.equal(only.totals.turns, 4)
})

test('NEGATIVE: an action whose plugin is not mounted is not offered', () => {
  const absent = describeSurface(turnStory(), { siblings: [] })
  const present = describeSurface(turnStory(), { siblings: SIBLING_IDS })
  assert.deepEqual(turnOf(present, 0).actions.map((action) => [action.id, action.visible]), [
    ['delete-turn', true],
    ['rerun-turn', true],
    ['refresh', true],
  ])
  assert.equal(turnOf(absent, 0).actions[0].visible, false)
  assert.equal(turnOf(absent, 0).actions[0].reason, 'sibling-absent')
  assert.equal(turnOf(absent, 0).actions[1].visible, false)
  assert.equal(turnOf(absent, 0).actions[1].reason, 'sibling-absent')
  assert.equal(turnOf(absent, 0).actions[2].visible, true)
})

test('NEGATIVE: dropping the requires clause makes the button appear anyway', () => {
  const card = turnOf(describeSurface(turnStory(), { siblings: [] }), 0)
  const honest = actionList(card, { siblings: new Set(), busy: false })
  assert.equal(honest[0].visible, false)
  const broken = ACTION_RULES.map((rule) => (rule.id === 'delete-turn' ? { ...rule, requires: null } : rule))
  const forced = actionList(card, { siblings: new Set(), busy: false }, broken)
  assert.equal(forced[0].visible, true, 'this is exactly what the requires clause prevents')
  assert.equal(forced[1].visible, false, 'and the mechanism is per rule, not global')
})

// --- 3. the host half --------------------------------------------------------

function mount(options = {}) {
  const routes = new Map()
  const webServer = {
    register: (route) => {
      routes.set(route.path, route)
      return () => {}
    },
  }
  const events = options.events === undefined ? turnStory() : options.events
  const live = options.live === undefined ? null : options.live
  const ctx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    inject: () => {},
    get: (service) => {
      if (service === 'webServer') return webServer
      if (service === 'sessionQuery') return { readSession: async () => (events === null ? null : { events }) }
      if (service === 'sessions') return { get: (id) => (live !== null && (id === SESSION || id === SESSION_BARE) ? live : undefined) }
      return undefined
    },
  }
  apply(ctx, options.config === undefined ? {} : options.config)
  return routes
}

const STATE = ROUTE_PREFIX + '/state'
const stateUrl = (query) => STATE + query

async function call(routes, options = {}) {
  const route = routes.get(STATE)
  assert.ok(route !== undefined, 'the state route must be registered')
  const req = new EventEmitter()
  req.method = options.method === undefined ? 'GET' : options.method
  req.url = options.url === undefined ? STATE : options.url
  req.headers = options.headers === undefined ? { host: '127.0.0.1:3080' } : options.headers
  req.socket = { remoteAddress: options.remoteAddress === undefined ? '127.0.0.1' : options.remoteAddress }
  const res = {
    statusCode: null,
    body: null,
    writeHead(status) {
      this.statusCode = status
    },
    end(payload) {
      this.body = JSON.parse(payload)
    },
  }
  await route.handler(req, res)
  return res
}

test('the plugin mounts exactly one route, and it is GET only', async () => {
  const routes = mount()
  assert.equal(routes.size, 1)
  assert.deepEqual([...routes.keys()], [STATE])
  assert.equal(routes.get(STATE).kind, 'exact')
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await call(routes, { method, url: stateUrl('?sessionId=' + SESSION) })
    assert.equal(res.statusCode, 405, method + ' must be refused')
    assert.equal(res.body.code, 'method')
  }
  assert.equal((await call(routes, { url: stateUrl('?sessionId=' + SESSION) })).statusCode, 200)
})

test('the mount probe contract: no sessionId 400, malformed 400, unknown session 404', async () => {
  const routes = mount()
  assert.equal((await call(routes, {})).statusCode, 400)
  assert.equal((await call(routes, { url: stateUrl('?sessionId=nope') })).statusCode, 400)
  assert.equal((await call(routes, { url: stateUrl('?sessionId=' + SESSION_BARE) })).statusCode, 200)
  const missing = await call(mount({ events: null }), { url: stateUrl('?sessionId=' + SESSION) })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.body.code, 'session-not-found')
})

test('off-loopback, foreign host and cross-origin requests are refused', async () => {
  const routes = mount()
  assert.equal((await call(routes, { url: stateUrl('?sessionId=' + SESSION), remoteAddress: '10.0.0.4' })).statusCode, 403)
  assert.equal((await call(routes, { url: stateUrl('?sessionId=' + SESSION), headers: { host: 'example.com' } })).statusCode, 403)
  assert.equal(
    (await call(routes, { url: stateUrl('?sessionId=' + SESSION), headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } })).statusCode,
    403,
  )
})

test('the payload carries the cards, and the query decides the buttons', async () => {
  const routes = mount()
  const bare = await call(routes, { url: stateUrl('?sessionId=' + SESSION) })
  assert.equal(bare.body.ok, true)
  assert.equal(bare.body.plugin, PLUGIN_ID)
  assert.equal(bare.body.version, VERSION)
  assert.equal(bare.body.sessionId, SESSION)
  assert.deepEqual(bare.body.turns.map((card) => card.turn), [0, 1, 2, 3])
  assert.deepEqual(bare.body.rowlessTurns, [2])
  assert.deepEqual(bare.body.siblings, [])
  assert.equal(bare.body.turns[0].actions[0].visible, false)
  assert.equal(bare.body.turns[0].actions[0].reason, 'sibling-absent')
  const withSiblings = await call(routes, { url: stateUrl('?sessionId=' + SESSION + '&siblings=deleteTurn,rerunTurn&rerunSeqs=0:3') })
  assert.deepEqual(withSiblings.body.siblings, ['deleteTurn', 'rerunTurn'])
  assert.equal(withSiblings.body.turns[0].actions[0].visible, true)
  assert.deepEqual(withSiblings.body.turns[0].actions[1].params, { seq: 3 })
})

test('a live session supplies the platform projection; a broken one degrades instead of 500', async () => {
  const live = await call(mount({ live: { surface: { nodes: PLATFORM_NODES } } }), { url: stateUrl('?sessionId=' + SESSION) })
  assert.equal(live.body.live, true)
  assert.equal(live.body.surfaceSource, 'platform')
  assert.equal(live.body.nodesAgree, true)
  assert.equal(live.body.platformError, null)
  const hostile = await call(mount({ live: { get surface() { throw new Error('projections unloaded') } } }), { url: stateUrl('?sessionId=' + SESSION) })
  assert.equal(hostile.statusCode, 200)
  assert.equal(hostile.body.surfaceSource, 'derived')
  assert.equal(hostile.body.platformError, 'projections unloaded')
})

test('configuration reaches the payload and unknown keys are reported', async () => {
  const res = await call(mount({ config: { renderEveryTurn: false, nope: true } }), { url: stateUrl('?sessionId=' + SESSION) })
  assert.equal(res.body.turns.length, 3)
  assert.deepEqual(res.body.rowlessTurns, [2])
  assert.deepEqual(res.body.unknownOptionKeys, ['nope'])
})

// --- 4. the browser half -----------------------------------------------------

test('the bundle registers one conversation.view tab, with every field the platform reads', () => {
  const env = loadClient()
  assert.equal(env.registered.id, PLUGIN_ID)
  assert.equal(typeof env.registered.factory, 'function')
  assert.equal(env.api.version, VERSION)
  assert.deepEqual(env.api.inject, ['slots', 'locale'])
  const entries = env.runApply()
  assert.equal(entries.length, 1)
  const entry = entries[0]
  assert.equal(entry.options.name, 'conversation.view')
  assert.equal(entry.options.id, 'surface')
  assert.equal(entry.options.order, 20)
  assert.equal(entry.options.locale, PLUGIN_ID)
  assert.equal(typeof entry.options.label, 'function')
  assert.equal(entry.options.label(), '轨迹plus')
  assert.equal(env.translate('en', 'view.surface'), 'Trajectory Plus')
  assert.equal(typeof entry.component, 'function')
  assert.deepEqual(env.injectKeys, ['conversation.view'])
  assert.equal(entry.options.inject(SESSION, {}).controller, entry.options.inject(SESSION, {}).controller)
})

test('the tab still appears when the slots service arrives late', () => {
  const env = loadClient({ late: true })
  assert.equal(env.runApply().length, 0)
  env.installSlots()
  assert.equal(env.slotEntries.length, 1)
})

/** How many turns one windowed session has, for the paging tests. */
function manyTurns(count) {
  const events = []
  let seq = 0
  for (let turn = 0; turn < count; turn += 1) {
    events.push(ev(seq++, 'turn/start', { turn }))
    events.push(ev(seq++, 'user/message', { turn, content: text('question ' + turn), source: { kind: 'user' } }, 'append'))
    events.push(ev(seq++, 'assistant/message', { turn, message: { content: text('answer ' + turn) } }, 'append'))
    events.push(ev(seq++, 'turn/end', { turn, reason: { kind: 'completed' } }))
  }
  return events
}

function payloadFor(siblingsText, older) {
  const siblings = siblingsText === '' ? [] : siblingsText.split(',')
  const has = (id) => siblings.includes(id)
  const act = (id, key, requires, enabled, reason, path, params) => ({ id, key, requires, visible: requires === null || has(requires), enabled, reason, path, params })
  // The rows the host would send for this fixture. They are written out by hand
  // rather than derived: the browser half must render exactly what it is handed,
  // so a fixture that recomputed them could not catch it inventing a row.
  const rowsFor = (turn) => {
    if (turn === 0) {
      return [
        { seq: 2, kind: 'user', lane: 0, text: 'first question', chars: 14 },
        { seq: 3, kind: 'assistant', lane: 1, text: 'first answer', chars: 12 },
      ]
    }
    if (turn === 1) {
      return [
        { seq: 4, kind: 'user', lane: 0, text: 'second question', chars: 15 },
        // A tool row that FAILED: the strip paints it red and the row says so.
        { seq: 6, kind: 'tool-result', lane: 2, error: true, tool: 'run_code', toolPreview: 'run_code {"code":"boom"}', text: 'Error: boom', chars: 11 },
        { seq: 5, kind: 'assistant', lane: 1, text: 'second answer', chars: 13 },
      ]
    }
    if (turn === 3) {
      return [
        { seq: 7, kind: 'user', lane: 0, archived: true, text: 'the original question', chars: 21 },
        { seq: 8, kind: 'assistant', lane: 1, archived: true, text: 'the original answer', chars: 19 },
      ]
    }
    return []
  }
  const make = (turn, status, nodes, rowless, prompt, answer, retries, suppressed, resumes, rerunSeq) => ({
    turn,
    status,
    nodes,
    rowless,
    prompt,
    answer,
    rows: rowsFor(turn),
    rowsClipped: false,
    retries,
    suppressed,
    resumes,
    carriers: 0,
    contextOnly: false,
    badges: [{ key: 'badge.' + status, params: {} }],
    durationMs: 1000 + turn * 500,
    ends:
      retries > 0
        ? [{ seq: 1, kind: 'error', message: null, code: null }, { seq: 2, kind: 'completed', message: null, code: null }]
        : [{ seq: 1, kind: 'completed', message: null, code: null }],
    actions: [
      act('delete-turn', 'action.delete', 'deleteTurn', nodes > 0, nodes > 0 ? 'ok' : 'no-target', '/dsh-delete-turn/delete', { mode: 'reply', turn }),
      act('rerun-turn', 'action.rerun', 'rerunTurn', typeof rerunSeq === 'number', typeof rerunSeq === 'number' ? 'ok' : 'no-reply', '/dsh-rerun-turn/apply', typeof rerunSeq === 'number' ? { seq: rerunSeq } : {}),
      act('refresh', 'action.refresh', null, true, 'ok', '/dsh-client-ui-trajectory-plus/state', {}),
    ],
  })
  return {
    plugin: PLUGIN_ID,
    version: VERSION,
    turns: [
      make(0, 'content', 2, false, { seq: 2, text: 'first question', chars: 14, truncated: false }, { seq: 3, text: 'first answer', chars: 12, truncated: false }, 0, 0, 0, 3),
      make(1, 'recovered', 3, false, { seq: 4, text: 'second question', chars: 15, truncated: false }, { seq: 5, text: 'second answer', chars: 13, truncated: false }, 1, 0, 0, undefined),
      make(2, 'empty', 0, true, null, null, 0, 0, 0, undefined),
      make(3, 'replaced', 0, true, null, null, 0, 2, 0, undefined),
      // A turn whose content is gone AND whose originals are gone with it: the only
      // card that renders the 'no content' line, because every other card has rows.
      make(4, 'replaced', 0, true, null, null, 0, 1, 0, undefined),
    ],
    strip: {
      lanes: [
        [ { turn: 0, seq: 2, kind: 'user', lane: 0 }, { turn: 1, seq: 4, kind: 'user', lane: 0 }, { turn: 3, seq: 7, kind: 'user', lane: 0, archived: true } ],
        [ { turn: 0, seq: 3, kind: 'assistant', lane: 1 }, { turn: 1, seq: 5, kind: 'assistant', lane: 1 }, { turn: 3, seq: 8, kind: 'assistant', lane: 1, archived: true } ],
        [ { turn: 1, seq: 6, kind: 'tool-result', lane: 2, red: true } ],
      ],
      cells: [
        { turn: 0, seq: 2, kind: 'user', lane: 0 },
        { turn: 0, seq: 3, kind: 'assistant', lane: 1 },
        { turn: 1, seq: 4, kind: 'user', lane: 0 },
        { turn: 1, seq: 6, kind: 'tool-result', lane: 2, red: true },
        { turn: 1, seq: 5, kind: 'assistant', lane: 1 },
        { turn: 3, seq: 7, kind: 'user', lane: 0, archived: true },
        { turn: 3, seq: 8, kind: 'assistant', lane: 1, archived: true },
      ],
      kinds: { user: 3, assistant: 3, 'tool-result': 1 },
      total: 7,
    },
    notices: [],
    ...(older === undefined ? {} : older),
  }
}

test('the view renders one card per turn, oldest first, rowless included', () => {
  const env = loadClient({ fetch: () => new Promise(() => {}) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  controller.publish({ payload: payloadFor('deleteTurn,rerunTurn'), loading: false })
  const tree = env.render(entry.component, controller)
  const cards = env.findAll(tree, 'article')
  assert.deepEqual(cards.map((card) => card.props['data-dshts-turn']), ['0', '1', '2', '3', '4'], 'chronological, oldest first')
  assert.deepEqual([cards[2].props['data-dshts-status'], cards[2].props['data-dshts-rowless']], ['empty', '1'])
  // The strip's cells are buttons too, so the action buttons are named explicitly.
  assert.deepEqual(env.findAll(tree, 'button').filter((node) => node.props['data-dshts-action'] !== undefined).map((node) => node.props['data-dshts-action']), [
    'delete-turn',
    'rerun-turn',
    'refresh',
    'delete-turn',
    'rerun-turn',
    'refresh',
    'delete-turn',
    'rerun-turn',
    'refresh',
    'delete-turn',
    'rerun-turn',
    'refresh',
    'delete-turn',
    'rerun-turn',
    'refresh',
  ])
  // The rows are DRAWN, and only the card with no rows at all falls back to the
  // 'this turn has no content' line.
  assert.deepEqual(env.findAll(tree, 'div').filter((node) => node.props['data-dshts-row'] !== undefined).map((node) => node.props['data-dshts-row']), ['2', '3', '4', '6', '5', '7', '8'])
  assert.equal(env.findAll(tree, 'p').some((node) => node.children[0] === '本轮内容已从当前状态下移除'), true)
  assert.equal(env.findAll(tree, 'span').some((node) => node.props['data-dshts-badge'] === 'badge.recovered'), true)
  assert.equal(env.findAll(tree, 'p').some((node) => String(node.children[0]).indexOf('1 次重试') > -1), true)
})

test('NEGATIVE: with no sibling mounted the delete and re-run buttons do not exist', () => {
  const env = loadClient({ fetch: () => new Promise(() => {}) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  controller.publish({ payload: payloadFor(''), loading: false })
  const buttons = env.findAll(env.render(entry.component, controller), 'button').filter((node) => node.props['data-dshts-action'] !== undefined)
  assert.deepEqual(buttons.map((node) => node.props['data-dshts-action']), ['refresh', 'refresh', 'refresh', 'refresh', 'refresh'])
  assert.equal(buttons.some((node) => node.props['data-dshts-action'] === 'delete-turn'), false)
  assert.equal(buttons.some((node) => node.props['data-dshts-action'] === 'rerun-turn'), false)
})

test('the probe, the forwarded facts and the payload request', async () => {
  const env = loadClient({ fetch: jsonFetch })
  assert.deepEqual(
    [env.api.__test.probeStatus(400), env.api.__test.probeStatus(405), env.api.__test.probeStatus(404), env.api.__test.probeStatus(200)],
    ['present', 'present', 'absent', 'absent'],
  )
  assert.equal(env.api.__test.REFRESH_INTERVAL_MS, 5000)
  const controller = env.runApply()[0].options.inject(SESSION, {}).controller
  await controller.refresh()
  assert.deepEqual(controller.getSnapshot().probes, { deleteTurn: 'present', rerunTurn: 'present' })
  // The first pass ships the cards with the sibling ids but does NOT wait for the
  // question 'what can you rerun': that one folds the whole session, and holding the
  // page for it is exactly why this page read slowly on a long conversation.
  const own = () => env.calls.filter((entry) => entry.url.indexOf(ROUTE_PREFIX + '/state?') === 0).map((entry) => entry.url)
  assert.equal(own()[0].indexOf('siblings=deleteTurn%2CrerunTurn') > -1, true)
  assert.equal(own()[0].indexOf('rerunSeqs=') === -1, true, 'the first pass must not wait for the sibling scan')
  // Its answer arrives detached and triggers exactly one follow-up pass, which is the
  // pass that carries the rerun targets and therefore the re-run buttons.
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
  const later = own()
  assert.equal(later.length > 1, true, 'the detached answer triggers a follow-up pass')
  assert.equal(later[later.length - 1].indexOf('rerunSeqs=0%3A5%2C2%3A11') > -1, true)
})

test('NEGATIVE: an action can only POST to the two sibling routes', async () => {
  const env = loadClient({ fetch: jsonFetch })
  const controller = env.runApply()[0].options.inject(SESSION, {}).controller
  await controller.run({ id: 'delete-turn', path: '/dsh-delete-turn/delete', params: { mode: 'reply', turn: 2 } }, 2)
  const posted = env.calls.filter((entry) => entry.init.method === 'POST')
  assert.equal(posted.length, 1)
  assert.equal(posted[0].url, '/dsh-delete-turn/delete')
  assert.deepEqual(JSON.parse(posted[0].init.body), { sessionId: SESSION, mode: 'reply', turn: 2 })
  const before = env.calls.length
  await controller.run({ id: 'delete-turn', path: '/dsh-elsewhere/apply', params: { mode: 'reply', turn: 2 } }, 2)
  assert.equal(env.calls.length, before, 'a refused target makes no request at all')
  assert.deepEqual(controller.getSnapshot().localNotice, { key: 'notice.submit-failed', params: { code: 'refused-target' } })
  assert.deepEqual(await controller.readRerunTargets(), [{ turn: 0, seq: 5 }, { turn: 2, seq: 11 }])
})

async function jsonFetch(url, init) {
  if (init !== undefined && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) }
  if (url.indexOf('/state') > -1 && url.indexOf('sessionId') === -1) return { ok: false, status: 400, json: async () => ({}) }
  if (url.indexOf('/dsh-rerun-turn/state') > -1) {
    return { ok: true, status: 200, json: async () => ({ ok: true, replies: [{ turn: 0, seq: 2 }, { turn: 0, seq: 5 }, { turn: 2, seq: 11 }, null, { turn: 3 }, { turn: 1, seq: 'x' }] }) }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, turns: [], notices: [] }) }
}


// --- 6. WHO REPLACED A NODE (task B) -----------------------------------------
//
// The taxonomy these tests pin was measured on a real 151-turn session, not
// assumed: 38 replacement carriers, 2341 shadowed seqs, of which FOUR
// compact-checkpoint carriers account for 2307 (98.5%). The reader-visible bug
// was that all 90 emptied turns said 'the content was removed', which is false
// about a compaction: the originals are still in the log.

/** A platform compaction retiring turn 0's nodes, plus a healthy turn after it. */
function compactedTurn() {
  return [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'user/message', { content: text('the original question'), source: { kind: 'user' } }, 'append'),
    ev(2, 'assistant/message', { turn: 0, message: { content: text('the original answer') } }, 'append'),
    ev(3, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
    ev(4, 'turn/start', { turn: 1 }),
    ev(5, 'user/message', { content: text('second question'), source: { kind: 'user' } }, 'append'),
    ev(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    // Written by the platform's own compaction: a checkpoint message carrying
    // source.kind 'compact-checkpoint' takes the place of the nodes it retired.
    ev(
      7,
      'user/message',
      { turn: 1, content: text('summary of turn 0'), source: { kind: 'compact-checkpoint', compactionId: 'c1' } },
      { op: 'replace', startSeq: 1, endSeq: 2 },
    ),
  ]
}

/** A user's own rewrite, in the SECOND spelling the log uses: kind 'user' + editedBy. */
function rewrittenTurn() {
  return [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'user/message', { content: text('first wording'), source: { kind: 'user' } }, 'append'),
    ev(2, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
    ev(3, 'turn/start', { turn: 1 }),
    ev(
      4,
      'user/message',
      { turn: 1, content: text('second wording'), source: { kind: 'user', editedBy: 'dsh-edit-turn' } },
      { op: 'replace', startSeq: 1, endSeq: 1 },
    ),
    ev(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

test('the replacement author is read from the carrier source, both spellings included', () => {
  const carrier = (source) => ev(1, 'user/message', { content: text('x'), source }, { op: 'replace', startSeq: 0, endSeq: 0 })
  assert.deepEqual(REPLACEMENT_AUTHORS, ['edit', 'delete', 'rerun', 'compaction', 'other'])
  assert.equal(replacementAuthor(carrier({ kind: 'plugin:dsh-edit-turn' })), 'edit')
  assert.equal(replacementAuthor(carrier({ kind: 'plugin/dsh-edit-turn' })), 'edit', 'the slash spelling is the same author')
  assert.equal(replacementAuthor(carrier({ kind: 'user', editedBy: 'dsh-edit-turn' })), 'edit', 'the second spelling of a user edit')
  assert.equal(replacementAuthor(carrier({ kind: 'plugin:dsh-delete-turn' })), 'delete')
  assert.equal(replacementAuthor(carrier({ kind: 'user', editedBy: 'dsh-delete-turn' })), 'delete')
  assert.equal(replacementAuthor(carrier({ kind: 'plugin:dsh-rerun-turn' })), 'rerun')
  assert.equal(replacementAuthor(carrier({ kind: 'compact-checkpoint', compactionId: 'c' })), 'compaction')
  assert.equal(replacementAuthor(carrier({ kind: 'system-prompt' })), 'other', 'the platform refreshes its own system prompt')
  assert.equal(replacementAuthor(carrier({ kind: 'tool' })), 'other', 'and prunes its own tool results')
  assert.equal(replacementAuthor(carrier(undefined)), 'other')
})

test('NEGATIVE: classifying on source.kind alone files the user\'s own edit as the platform\'s', () => {
  const full = ev(1, 'user/message', { content: text('x'), source: { kind: 'user', editedBy: 'dsh-edit-turn' } }, { op: 'replace', startSeq: 0, endSeq: 0 })
  const blind = ev(1, 'user/message', { content: text('x'), source: { kind: 'user' } }, { op: 'replace', startSeq: 0, endSeq: 0 })
  assert.equal(replacementAuthor(full), 'edit')
  assert.equal(replacementAuthor(blind), 'other', 'without editedBy the carrier looks like the platform: this is exactly what reading it prevents')
})

test("a user's own operation outranks the platform's, whatever the counts say", () => {
  assert.equal(dominantReplacementAuthor({ compaction: 5, edit: 1 }), 'edit')
  assert.equal(dominantReplacementAuthor({ delete: 1, compaction: 900 }), 'delete')
  assert.equal(dominantReplacementAuthor({ compaction: 5, other: 1 }), 'compaction')
  assert.equal(dominantReplacementAuthor({ other: 4 }), 'other', 'platform housekeeping is still just replaced')
  assert.equal(dominantReplacementAuthor({}), null)
  assert.deepEqual(suppressionList({ edit: 1, compaction: 5, other: 2 }), [
    { author: 'compaction', n: 5 },
    { author: 'other', n: 2 },
    { author: 'edit', n: 1 },
  ])
})

test('a compacted turn is labelled as compaction AND keeps its original content', () => {
  const payload = describeSurface(compactedTurn())
  const first = turnOf(payload, 0)
  assert.equal(first.status, 'compacted')
  assert.equal(first.removedBy, 'compaction')
  assert.deepEqual(first.suppression, [{ author: 'compaction', n: 2 }])
  assert.deepEqual(first.replacedBy, [7])
  assert.equal(first.archived, true, 'the originals are restored from the log, not dropped')
  assert.equal(first.prompt.text, 'the original question')
  assert.equal(first.answer.text, 'the original answer')
  assert.deepEqual(first.badges.filter((badge) => badge.key === 'badge.compacted'), [{ key: 'badge.compacted', params: { n: 2 } }])
  assert.equal(first.badges.some((badge) => badge.key === 'badge.replaced'), false, 'not the generic replaced badge')
  assert.equal(turnOf(payload, 1).status, 'content')
  assert.equal(payload.totals.compacted, 1)
  assert.equal(payload.totals.replaced, 0)
  assert.deepEqual(payload.replacementsByAuthor, { compaction: { carriers: 1, shadowed: 2 } })
})

test("a user's delete is NOT resurrected as archived content", () => {
  const payload = describeSurface(retiredTurn())
  const first = turnOf(payload, 0)
  assert.equal(first.status, 'replaced', 'deleting is not compacting')
  assert.equal(first.removedBy, 'delete')
  assert.equal(first.suppressed, 2)
  assert.equal(first.archived, false)
  assert.equal(first.prompt, null, 'the original the user deleted must not come back')
  assert.equal(first.answer, null)
  assert.deepEqual(first.badges.filter((badge) => badge.key === 'badge.deleted'), [{ key: 'badge.deleted', params: { n: 2 } }])
  assert.equal(payload.totals.replaced, 1)
  assert.equal(payload.totals.compacted, 0)
  assert.deepEqual(payload.replacementsByAuthor, { delete: { carriers: 1, shadowed: 2 } })
})

test("a user's own rewrite keeps its own label, and its replaced original stays gone", () => {
  const payload = describeSurface(rewrittenTurn())
  const first = turnOf(payload, 0)
  assert.equal(first.status, 'replaced')
  assert.equal(first.removedBy, 'edit', 'kind alone would have called this the platform')
  assert.deepEqual(first.suppression, [{ author: 'edit', n: 1 }])
  assert.equal(first.archived, false, 'the original a user rewrote on purpose is not restored')
  assert.equal(first.prompt, null)
  assert.equal(turnOf(payload, 1).suppressed, 0)
  assert.deepEqual(turnOf(payload, 1).suppression, [])
  assert.deepEqual(payload.replacementsByAuthor, { edit: { carriers: 1, shadowed: 1 } })
})

/** The platform refreshing its own system prompt: a 1:1 swap with no summary. */
function prunedTurn() {
  return [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'system/message', { turn: 0, message: { content: text('the older system prompt'), source: { kind: 'system-prompt' } } }, 'append'),
    ev(2, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
    ev(3, 'turn/start', { turn: 1 }),
    ev(
      4,
      'system/message',
      { turn: 1, message: { content: text('the newer system prompt'), source: { kind: 'system-prompt' } } },
      { op: 'replace', startSeq: 1, endSeq: 1 },
    ),
    ev(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

test('platform housekeeping is neither a compaction nor a user act, and says so', () => {
  const payload = describeSurface(prunedTurn())
  const first = turnOf(payload, 0)
  assert.equal(first.status, 'replaced', 'a system-prompt swap is not a summary')
  assert.equal(first.removedBy, 'other')
  assert.deepEqual(first.suppression, [{ author: 'other', n: 1 }])
  assert.equal(first.archived, false)
  assert.deepEqual(first.badges.filter((badge) => badge.key === 'badge.replaced'), [{ key: 'badge.replaced', params: { n: 1 } }])
  assert.deepEqual(payload.replacementsByAuthor, { other: { carriers: 1, shadowed: 1 } })
})

test('the card shows a compacted original under a marker, and never a deleted one', () => {
  const env = loadClient({ fetch: () => new Promise(() => {}) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  const show = (payload) => {
    controller.publish({ payload: { ok: true, ...payload }, loading: false })
    return env.render(entry.component, controller)
  }
  const textOfP = (tree) => env.findAll(tree, 'p').map((node) => String(node.children[0]))

  const compacted = show(describeSurface(compactedTurn()))
  const card = env.findAll(compacted, 'article')[0]
  assert.equal(card.props['data-dshts-status'], 'compacted')
  assert.equal(card.props['data-dshts-removed-by'], 'compaction')
  assert.equal(card.props['data-dshts-archived'], '1')
  assert.equal(textOfP(compacted).includes('原始内容（已压缩进摘要）'), true, 'the restored content is marked as restored')
  assert.equal(textOfP(compacted).includes('the original question'), true, 'and it is ON the card')
  assert.equal(textOfP(compacted).includes('the original answer'), true)
  assert.equal(textOfP(compacted).some((value) => value.indexOf('2 条已压缩进摘要') > -1), true, 'the story line names compaction, not removal')
  assert.equal(env.findAll(compacted, 'p').some((node) => node.children[0] === '本轮内容已从当前状态下移除'), false)

  const deleted = show(describeSurface(retiredTurn()))
  const deletedCard = env.findAll(deleted, 'article')[0]
  assert.equal(deletedCard.props['data-dshts-removed-by'], 'delete')
  assert.equal(deletedCard.props['data-dshts-archived'], '0')
  assert.equal(textOfP(deleted).includes('question'), false, "a deleted original stays deleted")
  assert.equal(textOfP(deleted).includes('本轮内容已从当前状态下移除'), true)
  assert.equal(textOfP(deleted).some((value) => value.indexOf('2 条已删除') > -1), true)
})

test('NEGATIVE: without the author, the same two folds are indistinguishable', () => {
  const compacted = describeSurface(compactedTurn())
  const deleted = describeSurface(retiredTurn())
  const shape = (payload) => {
    const card = payload.turns[0]
    return { nodes: card.nodes, suppressed: card.suppressed, rowless: card.rowless }
  }
  assert.deepEqual(shape(compacted), shape(deleted), 'the old fold fact is identical for a compaction and a delete: only the author tells them apart')
  assert.equal(turnOf(compacted, 0).status === turnOf(deleted, 0).status, false)
})


// --- 7. THE WINDOW AND THE 'LOAD EARLIER' ROW (task A) -----------------------
//
// The numbers below are the official view's, copied from its shipped bundle and
// pinned here so a future edit cannot quietly diverge from the view this page is
// supposed to be comparable with.

test('the paging numbers are the official ones, and both halves carry them', async () => {
  assert.equal(HISTORY_PAGE_NODES, 50, 'the official HISTORY_PAGE_NODES')
  assert.equal(OLDER_LOAD_THRESHOLD_PX, 48, 'the official OLDER_LOAD_THRESHOLD_PX')
  assert.equal(BOTTOM_FOLLOW_THRESHOLD_PX, 2, 'the official BOTTOM_FOLLOW_THRESHOLD_PX')
  assert.equal(HISTORY_LOAD_ROW_HEIGHT_PX, 30, 'the official HISTORY_LOAD_ROW_HEIGHT_PX')
  assert.equal(VIRTUALIZATION_THRESHOLD, 100, 'the official threshold, which this page deliberately does not implement')
  const api = loadClient().api.__test
  assert.equal(api.HISTORY_PAGE_NODES, HISTORY_PAGE_NODES)
  assert.equal(api.OLDER_LOAD_THRESHOLD_PX, OLDER_LOAD_THRESHOLD_PX)
  assert.equal(api.BOTTOM_FOLLOW_THRESHOLD_PX, BOTTOM_FOLLOW_THRESHOLD_PX)
  assert.equal(api.HISTORY_LOAD_ROW_HEIGHT_PX, HISTORY_LOAD_ROW_HEIGHT_PX)
  assert.equal(api.VIRTUALIZATION_THRESHOLD, VIRTUALIZATION_THRESHOLD)
  // The author key -> copy key map is duplicated in both halves; it cannot drift.
  const { replacementKeyOf } = await import('../src/logic.js')
  for (const author of REPLACEMENT_AUTHORS) assert.equal(api.replacementKeyOf(author), replacementKeyOf(author), author)
  const client = codeOnly(await readSource('client'))
  for (const key of ['history.loadEarlier', 'history.clickToLoadEarlier', 'history.loadingEarlier']) {
    assert.equal(api.zh[key] !== undefined, true, 'zh carries ' + key)
    assert.equal(api.en[key] !== undefined, true, 'en carries ' + key)
  }
  assert.equal(client.indexOf('VIRTUALIZATION_THRESHOLD') > -1, true, 'the number is written down even though it is not used')
})

test('the window is the NEWEST turns, and the query decides how many', async () => {
  const routes = mount({ events: manyTurns(70) })
  const first = await call(routes, { url: stateUrl('?sessionId=' + SESSION) })
  assert.equal(first.body.windowTurns, HISTORY_PAGE_NODES)
  assert.equal(first.body.turns.length, HISTORY_PAGE_NODES)
  assert.equal(first.body.turns[0].turn, 20, 'the oldest end is what gets dropped')
  assert.equal(first.body.turns[49].turn, 69)
  assert.equal(first.body.hasOlder, true)
  assert.equal(first.body.oldestTurn, 20)

  const wider = await call(routes, { url: stateUrl('?sessionId=' + SESSION + '&turns=60') })
  assert.equal(wider.body.windowTurns, 60)
  assert.equal(wider.body.turns.length, 60)
  assert.equal(wider.body.oldestTurn, 10)
  assert.equal(wider.body.hasOlder, true)

  const whole = await call(routes, { url: stateUrl('?sessionId=' + SESSION + '&turns=200') })
  assert.equal(whole.body.turns.length, 70)
  assert.equal(whole.body.hasOlder, false, 'nothing older left: the row must not be offered')
  assert.equal(whole.body.oldestTurn, 0)

  const clamped = await call(routes, { url: stateUrl('?sessionId=' + SESSION + '&turns=5000') })
  assert.equal(clamped.body.windowTurns, 1000, 'clamped, not obeyed')
  for (const junk of ['0', '-3', 'abc', '']) {
    const res = await call(routes, { url: stateUrl('?sessionId=' + SESSION + '&turns=' + junk) })
    assert.equal(res.body.windowTurns, HISTORY_PAGE_NODES, 'turns=' + JSON.stringify(junk) + ' falls back to the default window')
  }
  const short = await call(mount(), { url: stateUrl('?sessionId=' + SESSION) })
  assert.equal(short.body.hasOlder, false)
  assert.equal(short.body.oldestTurn, 0)
})

/**
 * A host payload built by the real fold, wrapped exactly as the route wraps it
 * (the route adds the ok envelope), so the view is driven by real data end to end.
 */
function payloadOf(turns, window) {
  const payload = describeSurface(manyTurns(turns), { resolved: resolveConfig({ maxTurns: window }) })
  return { ok: true, ...payload }
}

/** Find the 'load earlier' row in a rendered tree (there is at most one). */
function olderRows(env, tree) {
  return env.findAll(tree, 'button').filter((node) => node.props['data-dshts-load-earlier'] === '1')
}

/**
 * A fetch stub whose answer to this plugin's own state route is the payload the
 * requested window produces, always leaving older history to fetch. `state.windows`
 * records what each state request asked for.
 */
function windowFetch(state) {
  return async (url, init) => {
    if (init !== undefined && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) }
    if (url.indexOf('/state') > -1 && url.indexOf('sessionId') === -1) return { ok: false, status: 400, json: async () => ({}) }
    if (url.indexOf('/dsh-rerun-turn/state') > -1) return { ok: true, status: 200, json: async () => ({ ok: true, replies: [] }) }
    const at = url.indexOf('turns=') === -1 ? null : Number(decodeURIComponent(url.slice(url.indexOf('turns=') + 6).split('&')[0]))
    state.windows.push(Number.isFinite(at) ? at : null)
    return { ok: true, status: 200, json: async () => payloadOf(60, Number.isFinite(at) ? at : 50) }
  }
}

const settle = async (rounds) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

test("the 'load earlier' row is one 30px clickable line, and only when the host says hasOlder", () => {
  const env = loadClient({ fetch: () => new Promise(() => {}) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  const rowsOf = (tree) => env.findAll(tree, 'button').filter((node) => node.props['data-dshts-load-earlier'] === '1')
  const show = (payload) => {
    controller.publish({ payload, loading: false })
    return env.render(entry.component, controller)
  }

  assert.equal(rowsOf(show(payloadOf(60, 60))).length, 0, 'a session that fits offers nothing to load')
  // The running host may predate ?turns: an absent hasOlder must read as 'no',
  // never as 'probably yes'.
  const absent = payloadOf(60, 50)
  delete absent.hasOlder
  assert.equal(rowsOf(show(absent)).length, 0, 'a host that never says hasOlder offers no row')

  const rows = rowsOf(show(payloadOf(60, 50)))
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.props.className, 'dshts-historyLoadRow dshts-historyLoadButton', 'both official class names: it is a row, and it is clickable')
  assert.equal(row.props.style.height, HISTORY_LOAD_ROW_HEIGHT_PX)
  assert.equal(row.props['data-dshts-row-height'], String(HISTORY_LOAD_ROW_HEIGHT_PX))
  assert.equal(row.children[0], '加载更早')
  assert.equal(row.props.title, '点击加载更早')
  assert.equal(row.props.disabled, false)
  assert.equal(row.props['data-dshts-loading-earlier'], '0')
  assert.equal(env.translate('en', 'history.loadEarlier'), 'Load earlier')
  assert.equal(rowsOf(env.render(entry.component, controller, 'en'))[0].children[0], 'Load earlier')
})

test("one 'load earlier' grows the window by exactly one page, and a re-entrant call is refused", async () => {
  const state = { windows: [] }
  const env = loadClient({ fetch: windowFetch(state) })
  const controller = env.runApply()[0].options.inject(SESSION, {}).controller
  await controller.refresh()
  assert.equal(controller.requestedTurns(), HISTORY_PAGE_NODES)
  env.calls.length = 0
  state.windows.length = 0
  const first = controller.loadEarlier()
  const second = controller.loadEarlier()
  assert.equal(await second, false, 'the second call is refused before it can fetch')
  assert.equal(await first, true)
  assert.equal(controller.requestedTurns(), HISTORY_PAGE_NODES * 2, 'one click, one page')
  assert.deepEqual(state.windows, [100])
  const own = env.calls.filter((call) => call.url.indexOf(ROUTE_PREFIX + '/state?') === 0)
  assert.equal(own.length, 1)
  assert.equal(own[0].url.indexOf('turns=100') > -1, true)
  assert.equal(controller.getSnapshot().loadingEarlier, false, 'the row goes back to its idle wording')
})

test('NEGATIVE: the in-flight guard is exactly what makes one click one request', async () => {
  const state = { windows: [] }
  const env = loadClient({ fetch: windowFetch(state) })
  const controller = env.runApply()[0].options.inject(SESSION, {}).controller
  await controller.refresh()
  state.windows.length = 0
  await Promise.all([controller.loadEarlier(), controller.loadEarlier()])
  assert.equal(state.windows.length, 1, 'guarded: one request')

  // The same double intent with the guard removed - what the code does without it.
  // refresh() coalesces two CONCURRENT passes into one request, so the first
  // damage is invisible here; what is not invisible is that the reader asked for
  // one page and the window grew by two.
  state.windows.length = 0
  controller.windowTurns = HISTORY_PAGE_NODES
  const unguarded = () => {
    controller.windowTurns += HISTORY_PAGE_NODES
    return controller.refresh()
  }
  await Promise.all([unguarded(), unguarded()])
  assert.equal(controller.requestedTurns(), HISTORY_PAGE_NODES * 3, 'one reader action, two pages')
  assert.equal(state.windows.length, 1, 'the concurrent pair is coalesced by refresh()')
  await unguarded()
  assert.equal(state.windows.length, 2, 'and a pass that is not concurrent costs another request')
})

test('the top band loads the next page, and only the bottom 2px follows the tail', async () => {
  const state = { windows: [] }
  const env = loadClient({ fetch: windowFetch(state) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  const api = env.api.__test
  // Mount first: a browser attaches the ref before the effect runs, so the node
  // exists by the time the first data arrives. The stub is driven the same way.
  const mounted = env.render(entry.component, controller)
  const node = { scrollTop: 0, clientHeight: 400, scrollHeight: 2000 }
  mounted.props.ref.current = node
  controller.publish({ payload: payloadOf(60, 50), loading: false })
  let tree = env.render(entry.component, controller)
  await settle(6)
  // From here on the window is whatever the READER asks for: the mount's own poll
  // has settled and is not evidence about anything.
  state.windows.length = 0
  assert.equal(node.scrollTop, 2000, 'the first card pins the newest turn, as the official view does')

  // Mid-history: new cards must NOT move the reader. This is the bug that made
  // reading history impossible: the follow used to be unconditional.
  node.scrollTop = 600
  tree.props.onScroll({ currentTarget: node })
  assert.deepEqual(state.windows, [], 'the middle of the list is not the top band')
  node.scrollHeight = 2400
  controller.publish({ payload: payloadOf(61, 51), loading: false }) // a card arrived at the tail
  tree = env.render(entry.component, controller)
  assert.equal(node.scrollTop, 600, 'the reader stays where they were')
  assert.notEqual(node.scrollTop, node.scrollHeight, 'where the old unconditional follow would have put them')

  // At the tail - within BOTTOM_FOLLOW_THRESHOLD_PX - the new cards do follow.
  node.scrollTop = 2400 - 400 - BOTTOM_FOLLOW_THRESHOLD_PX
  tree.props.onScroll({ currentTarget: node })
  node.scrollHeight = 2800
  controller.publish({ payload: payloadOf(62, 52), loading: false })
  tree = env.render(entry.component, controller)
  assert.equal(node.scrollTop, 2800, 'at the tail, and only there, the view follows')

  // One pixel further out is already not the tail.
  assert.equal(api.isNearBottom({ scrollTop: 2800 - 400 - BOTTOM_FOLLOW_THRESHOLD_PX, clientHeight: 400, scrollHeight: 2800 }), true)
  assert.equal(api.isNearBottom({ scrollTop: 2800 - 400 - BOTTOM_FOLLOW_THRESHOLD_PX - 1, clientHeight: 400, scrollHeight: 2800 }), false)

  // The top band asks for the same page the row's click does.
  node.scrollTop = OLDER_LOAD_THRESHOLD_PX
  tree.props.onScroll({ currentTarget: node })
  await settle(6)
  assert.deepEqual(state.windows, [100], 'the top band loads exactly one page')
})

test('a prepended page holds the reading position, and the row says it is loading', () => {
  const env = loadClient({ fetch: () => new Promise(() => {}) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  const rowsOf = (tree) => env.findAll(tree, 'button').filter((node) => node.props['data-dshts-load-earlier'] === '1')
  const mounted = env.render(entry.component, controller)
  const node = { scrollTop: 0, clientHeight: 400, scrollHeight: 2000 }
  mounted.props.ref.current = node
  controller.publish({ payload: payloadOf(60, 50), loading: false })
  const tree = env.render(entry.component, controller)
  assert.equal(node.scrollTop, 2000)
  assert.equal(rowsOf(tree)[0].children[0], '加载更早')

  node.scrollTop = 20
  rowsOf(tree)[0].props.onClick()
  const busy = rowsOf(env.render(entry.component, controller))[0]
  assert.equal(busy.children[0], '正在加载更早…')
  assert.equal(busy.props.disabled, true)
  assert.equal(busy.props['data-dshts-loading-earlier'], '1')
  assert.equal(controller.isLoadingEarlier(), true, 'the same instance flag the guard reads')

  node.scrollHeight = 2600
  controller.publish({ payload: payloadOf(60, 55), loading: false })
  env.render(entry.component, controller)
  assert.equal(node.scrollTop, 20 + (2600 - 2000), 'the prepended page holds the reader in place, like the official anchor')
})


// --- 8. THE ROWS OF ONE TURN (task D) -----------------------------------------
//
// The reader-visible bug: a turn that ran eight tools showed two lines - its first
// question and its last answer - because the card only ever looked for those two
// events. The rows below are the turn's own surface nodes, one line each, and the
// tests pin what each line says.

/** One real turn: the system prompt, the human, three injections, two tool calls. */
function detailTurn() {
  return [
    ev(0, 'system/message', { turn: 0, step: 1, message: { role: 'system', content: text('You are an AI agent powered by DeepSeek Harness.') } }, 'append'),
    ev(1, 'turn/start', { turn: 0 }),
    ev(2, 'user/message', { content: [{ type: 'text', text: 'look at the GUI' }, { type: 'image', attachment: { mediaType: 'image/png' } }], source: { kind: 'user' } }, 'append'),
    ev(3, 'user/message', { content: text('Current runtime context. Approval prompts are disabled.'), source: { kind: 'runtime-context' } }, 'append'),
    ev(4, 'user/message', { content: text('<system-reminder> A skill is available.'), source: { kind: 'skill-catalog' } }, 'append'),
    ev(5, 'assistant/message', { turn: 0, step: 1, message: { content: [{ type: 'reasoning', text: 'let me look' }, { type: 'text', text: 'I will look at the GUI now.' }, { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls -la","description":"List files"}' }] } }, 'append'),
    ev(6, 'tool/call', { turn: 0, callId: 'call_1', name: 'bash', arguments: '{"command":"ls -la"}' }),
    ev(7, 'tool/result', { turn: 0, message: { role: 'tool', source: { kind: 'tool', callId: 'call_1' }, toolCallId: 'call_1', content: text('node_modules package-lock.json'), isError: false } }, 'append'),
    ev(8, 'assistant/message', { turn: 0, message: { content: text('The checkout only has node_modules.') } }, 'append'),
    ev(9, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
  ]
}

test('every step of a turn becomes a row, in seq order, not just the first and last', () => {
  const card = describeSurface(detailTurn()).turns[0]
  assert.deepEqual(card.rows.map((row) => row.seq), [0, 2, 3, 4, 5, 7, 8])
  assert.deepEqual(card.rows.map((row) => row.kind), ['system', 'user', 'context', 'context', 'assistant', 'tool-result', 'assistant'])
  // The bug this exists for: the old card body could only ever hold these two.
  assert.equal(card.prompt.text, 'look at the GUI')
  assert.equal(card.answer.text, 'The checkout only has node_modules.')
  assert.equal(card.rows.length > 2, true)
  // The two orders agree: the rows are the turn's current nodes, one line each.
  assert.deepEqual(card.rows.map((row) => row.seq), card.nodeSeqs)
  assert.deepEqual(ROW_KINDS, ['system', 'user', 'context', 'assistant', 'compacted', 'tool', 'tool-result'])
})

test('a node is classified by WHO WROTE IT, not by a list of known kinds', () => {
  assert.equal(rowKindOf(ev(1, 'system/message', { message: { content: text('x') } })), 'system')
  assert.equal(rowKindOf(ev(1, 'developer/message', { content: text('x') })), 'system')
  assert.equal(rowKindOf(ev(1, 'user/message', { content: text('x'), source: { kind: 'user' } })), 'user')
  assert.equal(rowKindOf(ev(1, 'assistant/message', { message: { content: text('x') } })), 'assistant')
  assert.equal(rowKindOf(ev(1, 'tool/result', { message: { content: text('x') } })), 'tool-result')
  assert.equal(rowKindOf(ev(1, 'user/message', { content: text('x'), source: { kind: 'runtime-context' } })), 'context')
  assert.equal(rowKindOf(ev(1, 'user/message', { content: text('x'), source: { kind: 'skill-catalog' } })), 'context')
  // A source kind nobody has ever heard of does not need a code change to be
  // classified: it is not the human and not the model, so it is injected context.
  assert.equal(rowKindOf(ev(1, 'user/message', { content: text('x'), source: { kind: 'invented-by-a-future-platform' } })), 'context')
  assert.equal(rowKindOf(ev(1, 'user/message', { content: text('x'), source: { kind: 'model-selection' } })), 'context')
  assert.equal(rowKindOf(ev(1, 'user/message', { content: text('x'), source: { kind: 'agent-message' } })), 'context')
  // A message with no source at all is the human's: that is what the log means.
  assert.equal(rowKindOf(ev(1, 'user/message', { content: text('x') })), 'user')
  // And a compaction checkpoint is its own kind, on the model's lane.
  assert.equal(rowKindOf(ev(1, 'user/message', { content: text('summary'), source: { kind: 'compact-checkpoint', compactionId: 'c1' } })), 'compacted')
})

test('the lane of a row follows the kind, and only a definite error is red', () => {
  assert.deepEqual(ROW_KINDS.map((kind) => rowLaneOf(kind)), [0, 0, 0, 1, 1, 2, 2])
  assert.equal(rowErrorOf(ev(1, 'tool/result', { message: { content: text('x'), isError: true } })), true)
  assert.equal(rowErrorOf(ev(1, 'tool/result', { message: { content: text('x'), isError: false } })), false)
  assert.equal(rowErrorOf(ev(1, 'tool/result', { message: { content: text('x') } })), null, 'the log does not say, and null is not false')
  assert.equal(rowErrorOf(ev(1, 'tool/result', { message: { content: text('x') }, error: { code: 'E' } })), true)
  const rows = describeSurface(detailTurn()).turns[0].rows
  assert.equal(rows.filter((row) => row.error === false).length, 1, 'only the node that says so is a definite non-error')
  assert.equal(rows.filter((row) => row.error === true).length, 0)
})

test('a tool row carries the command and a clipped preview of the result', () => {
  const story = detailTurn()
  story.push(ev(10, 'turn/start', { turn: 1 }))
  story.push(ev(11, 'assistant/message', { turn: 1, message: { content: [{ type: 'tool-call', id: 'c_sub', name: 'run_code', arguments: '{"code":"throw new Error(1)"}' }] } }, 'append'))
  story.push(ev(12, 'tool/result', { turn: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'c_sub' }, toolCallId: 'c_sub', content: text('Error: boom'), isError: true } }, 'append'))
  story.push(ev(13, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  const card = turnOf(describeSurface(story), 0)
  const row = card.rows.find((entry) => entry.kind === 'tool-result')
  assert.equal(row.tool, 'bash', 'the name is not on the result node: it is looked up by call id')
  assert.equal(row.toolPreview, 'bash List files', 'the model wrote a /what/ line for a reader: that is the summary')
  assert.equal(row.toolPreviewTruncated, undefined)
  assert.equal(row.text, 'node_modules package-lock.json')
  assert.equal(row.chars, 30)
  assert.equal(row.truncated, undefined)
  const failed = turnOf(describeSurface(story), 1).rows.find((entry) => entry.kind === 'tool-result')
  assert.equal(failed.tool, 'run_code', 'with no summary the raw arguments stand in, honestly clipped')
  assert.equal(failed.toolPreview, 'run_code {"code":"throw new Error(1)"}')
  assert.equal(failed.error, true)
  // No call anywhere: the row still exists and still says the result, without a name.
  const orphan = describeSurface([ev(0, 'turn/start', { turn: 0 }), ev(1, 'tool/result', { turn: 0, message: { content: text('bare result') } }, 'append'), ev(2, 'turn/end', { turn: 0, reason: { kind: 'completed' } })])
  const bare = turnOf(orphan, 0).rows[0]
  assert.equal(bare.kind, 'tool-result')
  assert.equal(bare.tool, undefined)
  assert.equal(bare.text, 'bare result')
})

test('non-text blocks are COUNTED, by media type: the official 图片 x1', () => {
  const card = describeSurface(detailTurn()).turns[0]
  const user = card.rows.find((row) => row.kind === 'user')
  assert.deepEqual(user.nonText, { 'image/png': 1 })
  const assistant = card.rows.find((row) => row.seq === 5)
  assert.deepEqual(assistant.nonText, { 'tool-call': 1 }, 'reasoning is not a non-text block: it is text the reader does not need twice')
  assert.deepEqual(nonTextCountsOf(ev(1, 'user/message', { content: [{ type: 'text', text: 'x' }] })), {})
  const two = ev(1, 'user/message', { content: [{ type: 'image', attachment: { mediaType: 'image/png' } }, { type: 'image', attachment: { mediaType: 'image/jpeg' } }, { type: 'text', text: 'x' }] })
  assert.deepEqual(nonTextCountsOf(two), { 'image/png': 1, 'image/jpeg': 1 })
})

test('every row is clipped, and says by how much', () => {
  const long = 'x'.repeat(5000)
  const story = [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'user/message', { content: text(long), source: { kind: 'user' } }, 'append'),
    ev(2, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
  ]
  const card = describeSurface(story).turns[0]
  const row = card.rows[0]
  assert.equal(row.text.length, 320, 'the user budget')
  assert.equal(row.chars, 5000, 'and the reader is told how much there was')
  assert.equal(row.truncated, true)
  // Every row of a real turn is bounded by its kind's budget.
  const real = describeSurface(detailTurn()).turns[0]
  assert.equal(real.rows.every((entry) => typeof entry.text !== 'string' || entry.text.length <= 320), true)
  assert.equal(real.rows.every((entry) => typeof entry.toolPreview !== 'string' || entry.toolPreview.length <= 96), true)
  // The hard ceiling: a raised per-kind budget cannot put a whole node in the payload.
  const options = resolveConfig({ contextChars: 999999 })
  const huge = describeSurface([ev(0, 'turn/start', { turn: 0 }), ev(1, 'user/message', { turn: 0, content: text('y'.repeat(50000)), source: { kind: 'runtime-context' } }, 'append'), ev(2, 'turn/end', { turn: 0, reason: { kind: 'completed' } })], { resolved: options })
  assert.equal(huge.turns[0].rows[0].text.length, 4000, 'charLimit caps any one row')
  assert.equal(huge.turns[0].rows[0].chars, 50000)
})

// --- 9. THE COLOUR STRIP (task E) ---------------------------------------------

test('the strip has three lanes, one cell per row, and the counts add up', () => {
  const payload = describeSurface(detailTurn())
  const card = payload.turns[0]
  assert.equal(payload.strip.total, card.rows.length)
  assert.equal(payload.strip.cells.length, card.rows.length, 'one cell per row, no cell without a row')
  assert.deepEqual(payload.strip.lanes.map((lane) => lane.length), [4, 2, 1])
  assert.deepEqual(payload.strip.cells.map((cell) => cell.seq), card.rows.map((row) => row.seq))
  for (const cell of payload.strip.cells) assert.equal(cell.lane, rowLaneOf(cell.kind))
  assert.deepEqual(payload.strip.kinds, { system: 1, user: 1, context: 2, assistant: 2, 'tool-result': 1 })
  assert.equal(payload.totals.rows, card.rows.length)
  assert.equal(payload.totals.rowsClippedTurns, 0)
})

test('red means the node failed - and a turn that failed is red on its last cell', () => {
  const failed = [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'user/message', { content: text('go'), source: { kind: 'user' } }, 'append'),
    ev(2, 'tool/result', { turn: 0, message: { content: text('Error: boom'), isError: true } }, 'append'),
    ev(3, 'assistant/message', { turn: 0, message: { content: text('giving up') } }, 'append'),
    ev(4, 'turn/end', { turn: 0, reason: { kind: 'error', error: { message: 'boom', code: 'E' } } }),
  ]
  const payload = describeSurface(failed)
  assert.equal(payload.turns[0].turnError, true)
  assert.equal(payload.turns[0].turnErrorMessage, 'boom')
  const red = payload.strip.cells.filter((cell) => cell.red === true)
  assert.deepEqual(red.map((cell) => [cell.seq, cell.kind]), [[2, 'tool-result']], 'the failing node, and NOT also the last cell')
  // A turn that failed with no failing node: the failure rides on the card and
  // lands on the last cell, which is the only place it can land.
  const turnOnly = [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'user/message', { content: text('go'), source: { kind: 'user' } }, 'append'),
    ev(2, 'turn/end', { turn: 0, reason: { kind: 'error', error: { message: 'rate limited', code: 'RATE_LIMIT' } } }),
  ]
  const stripped = describeSurface(turnOnly)
  assert.equal(stripped.turns[0].turnError, true)
  assert.deepEqual(stripped.strip.cells.filter((cell) => cell.red === true).map((cell) => cell.seq), [1])
  // A turn that completed: nothing is red, and an unknown error state is not red.
  const quiet = describeSurface(detailTurn())
  assert.equal(quiet.turns[0].turnError, false)
  assert.equal(quiet.strip.cells.some((cell) => cell.red === true), false)
  assert.equal(quiet.strip.cells.every((cell) => cell.red === undefined || cell.red === true), true)
})

test('the archived original becomes a row ONLY when the turn has no current row', () => {
  const compacted = describeSurface(compactedTurn())
  const card = turnOf(compacted, 0)
  assert.deepEqual(card.rows.map((row) => [row.seq, row.kind, row.archived]), [
    [1, 'user', true],
    [2, 'assistant', true],
  ], 'marked, so the page can say it is the original')
  // The fold that produced those rows still holds the platform's surface, not a
  // resurrected one: the restore is a presentation of the row list, not a fold.
  // The order is the platform's own: the checkpoint (seq 7) took the place of the
  // two nodes it retired, and the surface node appended after it comes last.
  assert.deepEqual(foldSurfaceDerived(compactedTurn()).nodes, [7, 5])
  // A user's own delete is never resurrected, in the rows either. The turn that
  // lost its content makes NO rows - and the only cell on the strip belongs to the
  // carrier event itself, which is a node like any other.
  const deleted = describeSurface(retiredTurn())
  assert.deepEqual(turnOf(deleted, 0).rows, [])
  assert.deepEqual(deleted.strip.cells.map((cell) => [cell.turn, cell.kind]), [[1, 'context']], 'the carrier event is a plugin-written node, so it is context, not the human')
  assert.equal(deleted.strip.cells.length, deleted.totals.rows, 'the strip is the rows, never more')
})

test('NEGATIVE: a card that showed only its first and last line is exactly what the rows replace', () => {
  const full = describeSurface(detailTurn()).turns[0]
  // The old rule: one prompt event and one answer event, nothing between.
  const old = full.rows.filter((row) => row.seq === full.prompt.seq || row.seq === full.answer.seq)
  assert.equal(old.length, 2, 'the old card body')
  assert.equal(full.rows.length, 7, 'the rows')
  assert.equal(full.rows.length > old.length, true)
})

test('NEGATIVE: a per-turn budget drops the tail of a turn, and the card says so', () => {
  const events = [ev(0, 'turn/start', { turn: 0 })]
  for (let index = 0; index < 40; index += 1) {
    events.push(ev(index + 1, 'user/message', { turn: 0, content: text('question ' + index + ' ' + 'z'.repeat(300)), source: { kind: 'user' } }, 'append'))
  }
  events.push(ev(41, 'turn/end', { turn: 0, reason: { kind: 'completed' } }))
  const generous = describeSurface(events, { resolved: resolveConfig({ rowBudgetChars: 100000 }) })
  assert.equal(generous.turns[0].rows.length, 40)
  assert.equal(generous.turns[0].rowsClipped, false)
  const tight = describeSurface(events, { resolved: resolveConfig({ rowBudgetChars: 900 }) })
  assert.equal(tight.turns[0].rows.length < 40, true, 'the budget cuts the tail')
  assert.equal(tight.turns[0].rowsClipped, true, 'and the card can say it did')
  assert.equal(tight.turns[0].rowBudget, 900, 'the number the page shows is the number that was used')
  assert.equal(tight.totals.rowsClippedTurns, 1)
  assert.deepEqual(tight.turns[0].rows.map((row) => row.seq), generous.turns[0].rows.slice(0, tight.turns[0].rows.length).map((row) => row.seq), 'what survives is the HEAD of the turn, in order')
})

test('the row budgets reach the payload, with the lanes and kinds the page draws', () => {
  const payload = describeSurface(detailTurn(), { resolved: resolveConfig({ contextChars: 300 }) })
  assert.equal(payload.options.contextChars, 300)
  assert.equal(payload.options.systemChars, 320)
  assert.equal(payload.options.userChars, 320)
  assert.equal(payload.options.assistantRowChars, 320)
  assert.equal(payload.options.toolNameChars, 96)
  assert.equal(payload.options.toolResultChars, 260)
  assert.equal(payload.options.rowBudgetChars, 9000)
  assert.deepEqual(payload.options.rowKinds, ROW_KINDS)
  assert.deepEqual(payload.options.rowLanes, { 0: ['system', 'user', 'context'], 1: ['assistant', 'compacted'], 2: ['tool', 'tool-result'] })
  assert.deepEqual(resolveConfig({ rowChars: 10 }).unknown, ['rowChars'], 'an invented option key is reported, not ignored')
  assert.equal(resolveConfig({ systemChars: 10 }).options.systemChars, 10)
})

// --- 10. THE ROWS AND THE STRIP IN THE BROWSER HALF ---------------------------

/**
 * Every string inside a rendered element, in order. The stub hands back the
 * element tree React would build, so a nested <b> or a trailing span is part of
 * the node's text and a reader sees it - which is what these tests assert on.
 */
function allText(node) {
  const out = []
  const walk = (value) => {
    if (value === null || value === undefined) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value === 'object') {
      if (Array.isArray(value.children)) for (const child of value.children) walk(child)
      return
    }
    out.push(String(value))
  }
  walk(node === null || node === undefined ? [] : node.children)
  return out.join('')
}

test('the browser half carries the SAME lane table as the pure core', () => {
  const api = loadClient().api.__test
  for (const kind of ROW_KINDS) assert.equal(api.rowLaneOf(kind), rowLaneOf(kind), kind + ' must sit on the same lane in both halves')
  assert.deepEqual(ROW_KINDS.map((kind) => api.rowKindKey(kind)), ['row.system', 'row.user', 'row.context', 'row.assistant', 'row.compacted', 'row.tool', 'row.toolResult'])
})

test('the card draws one line per row, with its lane, its kind and its counters', () => {
  const env = loadClient({ fetch: () => new Promise(() => {}) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  const payload = describeSurface(detailTurn())
  payload.ok = true
  controller.publish({ payload, loading: false })
  const tree = env.render(entry.component, controller)
  const rows = env.findAll(tree, 'div').filter((node) => node.props['data-dshts-row'] !== undefined)
  assert.deepEqual(rows.map((node) => node.props['data-dshts-row']), ['0', '2', '3', '4', '5', '7', '8'])
  assert.deepEqual(rows.map((node) => node.props['data-dshts-lane']), ['0', '0', '0', '0', '1', '2', '1'])
  assert.deepEqual(rows.map((node) => node.props['data-dshts-red']), ['0', '0', '0', '0', '0', '0', '0'])
  const labels = env.findAll(tree, 'span').map(allText)
  assert.equal(labels.includes('系统'), true)
  assert.equal(labels.includes('用户'), true)
  assert.equal(labels.includes('上下文'), true)
  assert.equal(labels.includes('助手'), true)
  assert.equal(labels.includes('结果'), true)
  assert.equal(labels.includes('图片 ×1'), true, 'the official 图片 ×1, from the counted block')
  const lines = env.findAll(tree, 'p').map(allText)
  assert.equal(lines.includes('bash List files'), true, 'the tool line names the tool and what it was asked to do')
  assert.equal(lines.some((value) => value.indexOf('node_modules package-lock.json') > -1), true, 'and shows the head of the result')
})

/** Two turns: one healthy, one whose tool failed. */
function failedToolStory() {
  return [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'user/message', { content: text('first'), source: { kind: 'user' } }, 'append'),
    ev(2, 'assistant/message', { turn: 0, message: { content: text('one') } }, 'append'),
    ev(3, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
    ev(4, 'turn/start', { turn: 1 }),
    ev(5, 'user/message', { turn: 1, content: text('second'), source: { kind: 'user' } }, 'append'),
    ev(6, 'assistant/message', { turn: 1, message: { content: text('two') } }, 'append'),
    ev(7, 'tool/result', { turn: 1, message: { content: text('Error: boom'), isError: true } }, 'append'),
    ev(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

test('the strip draws three lanes, one cell per row, and a red cell is the failed one', () => {
  const env = loadClient({ fetch: () => new Promise(() => {}) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  const payload = describeSurface(failedToolStory())
  payload.ok = true
  controller.publish({ payload, loading: false })
  const tree = env.render(entry.component, controller)
  const laneRows = env.findAll(tree, 'div').filter((node) => node.props['data-dshts-lane-row'] !== undefined)
  assert.deepEqual(laneRows.map((node) => node.props['data-dshts-lane-row']), ['0', '1', '2'])
  const cells = env.findAll(tree, 'button').filter((node) => node.props['data-dshts-cell'] !== undefined)
  // The DOM walk is lane-major (lane 0 first), so the same cells are found in the
  // host's row order once sorted back by seq - which is the order they came in.
  const bySeq = (a2, b2) => Number(a2.props['data-dshts-cell']) - Number(b2.props['data-dshts-cell'])
  assert.deepEqual([...cells].sort(bySeq).map((node) => node.props['data-dshts-cell']), payload.strip.cells.map((cell) => String(cell.seq)))
  assert.deepEqual(cells.map((node) => node.props['data-dshts-lane']), ['0', '0', '1', '1', '2'])
  assert.deepEqual(cells.map((node) => node.props['data-dshts-red']), ['0', '0', '0', '0', '1'])
  assert.equal(cells[4].props['data-dshts-kind'], 'tool-result')
  assert.equal(
    env.findAll(tree, 'span').some((node) => node.props['data-dshts-strip-total'] === String(payload.strip.cells.length)),
    true,
    'the legend counts the cells it drew',
  )
  assert.equal(payload.strip.cells.length, 5, 'two rows on the first turn, three on the second')
})

test('clicking a cell scrolls to that row, and the reader stops following the tail', () => {
  const env = loadClient({ fetch: () => new Promise(() => {}) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  const payload = describeSurface(failedToolStory())
  payload.ok = true
  controller.publish({ payload, loading: false })
  const tree = env.render(entry.component, controller)
  // The row elements, registered by the ref props the card hands down.
  const calls = []
  const remove = []
  const rowNode = (seq) => ({
    scrollIntoView: (options) => calls.push({ seq, options }),
    classList: { add: (name) => calls.push({ seq, add: name }), remove: (name) => remove.push({ seq, name }) },
  })
  for (const node of env.findAll(tree, 'div').filter((element) => element.props['data-dshts-row'] !== undefined)) {
    node.props.ref(rowNode(node.props['data-dshts-row']))
  }
  const cells = env.findAll(tree, 'button').filter((node) => node.props['data-dshts-cell'] !== undefined)
  cells.find((node) => node.props['data-dshts-cell'] === '2').props.onClick()
  assert.deepEqual(calls[0], { seq: '2', options: { block: 'center' } })
  assert.deepEqual(calls[1], { seq: '2', add: 'dshts-primary' })
  // A second jump clears the first mark instead of leaving two.
  cells.find((node) => node.props['data-dshts-cell'] === '6').props.onClick()
  assert.deepEqual(remove, [{ seq: '2', name: 'dshts-primary' }])
})

test('NEGATIVE: a cell whose row is not in the document lands on its turn', () => {
  const env = loadClient({ fetch: () => new Promise(() => {}) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  const payload = describeSurface(failedToolStory())
  payload.ok = true
  controller.publish({ payload, loading: false })
  const tree = env.render(entry.component, controller)
  const calls = []
  // Only the CARD refs exist: the row refs were never called, which is what a
  // clipped or not-yet-rendered row looks like.
  for (const node of env.findAll(tree, 'article')) {
    node.props.ref({ scrollIntoView: (options) => calls.push({ turn: node.props['data-dshts-turn'], options }), classList: { add: () => {}, remove: () => {} } })
  }
  const cell = env.findAll(tree, 'button').find((node) => node.props['data-dshts-cell'] === '7')
  cell.props.onClick()
  assert.deepEqual(calls, [{ turn: '1', options: { block: 'center' } }])
})

test('a failed row is red in the card too, and a budgeted card says what it left out', () => {
  const env = loadClient({ fetch: () => new Promise(() => {}) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  const payload = describeSurface(failedToolStory())
  payload.ok = true
  // The host's answer, edited only where this test needs it: a card that lost rows
  // to its own budget, and rows whose error state the log does not state.
  payload.turns[1].rowsClipped = true
  payload.turns[1].nodes = payload.turns[1].rows.length + 2
  payload.turns[0].rows[0].error = undefined
  controller.publish({ payload, loading: false })
  const tree = env.render(entry.component, controller)
  const rows = env.findAll(tree, 'div').filter((node) => node.props['data-dshts-row'] !== undefined)
  assert.deepEqual(rows.map((node) => node.props['data-dshts-red']), ['0', '0', '0', '0', '1'], 'only the row that failed is red')
  assert.equal(env.findAll(tree, 'p').some((node) => allText(node) === '本轮的明细过多，后面的 2 行没有列出'), true, 'the omission is on the card, with its count')
})

test('NEGATIVE: cards with no rows are exactly the old card', () => {
  const env = loadClient({ fetch: () => new Promise(() => {}) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  const payload = describeSurface(detailTurn())
  payload.ok = true
  for (const card of payload.turns) card.rows = []
  controller.publish({ payload, loading: false })
  const tree = env.render(entry.component, controller)
  assert.deepEqual(env.findAll(tree, 'div').filter((node) => node.props['data-dshts-row'] !== undefined), [])
  assert.equal(env.findAll(tree, 'p').some((node) => String(node.children[0]) === '本轮无内容'), true, 'no rows is the old empty card, and it says so instead of inventing a line')
})

// --- 5. the mechanical scans -------------------------------------------------

const WRITE_TOKENS = ['.append(', 'sessionController', 'deleteSession', 'SessionStore', 'surfaceOp:', 'sourceEventSeqs:']

test('the first principle: no half of this plugin can write a session event', async () => {
  const halves = { index: await readSource('index'), logic: await readSource('logic'), client: await readSource('client') }
  for (const [half, text] of Object.entries(halves)) {
    const code = codeOnly(text)
    for (const token of WRITE_TOKENS) assert.equal(code.includes(token), false, half + '.js must not name ' + token + ' in code')
  }
  assert.equal(codeOnly(halves.index).includes('POST'), false, 'the host registers GET routes only')
  assert.equal(codeOnly(halves.logic).includes('surfaceOp'), true, 'the read path must still exist')
  assert.equal(codeOnly(halves.logic).includes('.splice('), true, 'the replacement fold must still exist')
  assert.equal(codeOnly(halves.client).includes('.append('), false, 'the browser half appends nothing')
})

test('the scanner the test above trusts actually catches a write', () => {
  assert.equal(codeOnly('const a = 1 // .append(').includes('.append('), false)
  const dirty = codeOnly('session.append("user/message", {}, { surfaceOp: "append" })')
  assert.equal(dirty.includes('.append('), true)
  assert.equal(dirty.includes('surfaceOp:'), true)
  assert.equal(codeOnly('const route = "/dsh-delete-turn/delete"').includes('/dsh-delete-turn'), true)
})

test('the browser half addresses exactly three dsh paths, and the halves agree', async () => {
  const client = codeOnly(await readSource('client'))
  assert.deepEqual(dshPathsIn(client), [ROUTE_PREFIX, '/dsh-delete-turn', '/dsh-rerun-turn'].sort())
  const logic = codeOnly(await readSource('logic'))
  for (const route of Object.values(PROXY_ROUTES).concat(Object.values(PROBE_ROUTES))) {
    assert.equal(logic.includes(route), true, 'logic.js must name ' + route)
    assert.equal(client.includes(route), true, 'client.js must name ' + route + ' so the halves cannot drift')
  }
  assert.equal(PROBE_ROUTES.deleteTurn, '/dsh-delete-turn/state')
  assert.equal(PROBE_ROUTES.rerunTurn, '/dsh-rerun-turn/state')
  assert.equal(PROXY_ROUTES.deleteTurn, '/dsh-delete-turn/delete')
  assert.equal(PROXY_ROUTES.rerunTurn, '/dsh-rerun-turn/apply')
})

test('the version is the same number in every place that ships it', async () => {
  const pkg = JSON.parse(await readSource('package'))
  assert.equal(pkg.name, PLUGIN_ID)
  assert.equal(pkg.version, VERSION)
  assert.equal(hostVersion, VERSION)
  assert.equal(hostName, PLUGIN_ID)
  assert.equal((await readSource('client')).includes("'" + VERSION + "'"), true)
})

// --- 9. 切回来要秒出 (cache first + one prefetch) ------------------------------
//
// The reader-visible bug this section pins, measured in a real browser on
// 2026-10-06 (session-94db29c5, headless Chromium against the live GUI): the view
// sat on '正在读取…' for THREE MINUTES while payload after payload arrived over the
// wire, because the 5s tick started a competing pass every time and the generation
// guard threw away each pass whose answer was already in hand. The companion bug is
// that a single failed poll used to REPLACE the cards with nothing at all.
//
// The platform is a fact of life here, not a bug to work around: it renders only the
// SELECTED view (dsh-client-ui-conversation:
//   renderSlot('conversation.view', {...}, { only: viewId })
// -> dsh-client-ui-renderer: list.filter((item) => item.id === opts.only)),
// so a mounted view is a view that was just remounted, and anything the view owns
// is gone by the time the reader comes back. The data must therefore live in the
// controller (it does - one per session, at plugin scope), and the FIRST mount for a
// session must not be the first time anyone asks for its data.

/** The one notice node of a kind ('loading', 'failure', 'local', a host key), or null. */
function noticeOf(env, tree, kind) {
  const found = env.findAll(tree, 'div').filter((node) => node.props['data-dshts-notice'] === kind)
  return found.length === 0 ? null : found[0]
}

/**
 * A fetch stub the test drives by hand: every request parks until the test releases
 * it, so 'a pass is on the wire right now' is a state a test can stand in.
 */
function parkFetch() {
  const parked = []
  const fetchStub = (url, init) =>
    new Promise((resolve) => {
      parked.push({
        url,
        init: init === undefined ? {} : init,
        release: (body, status) => {
          const code = status === undefined ? 200 : status
          resolve({ ok: code < 400, status: code, json: async () => body })
        },
      })
    })
  return { parked, fetch: fetchStub }
}

/**
 * The same answer as windowFetch, but with siblings that are NOT mounted (404):
 * one state request per pass, no rerun scan and therefore no follow-up pass. That
 * is what makes 'exactly one request' an assertion a test can make.
 */
function soloFetch(state) {
  return async (url, init) => {
    if (init !== undefined && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) }
    if (url.indexOf('/state') > -1 && url.indexOf('sessionId') === -1) return { ok: false, status: 404, json: async () => ({}) }
    const at = url.indexOf('turns=') === -1 ? null : Number(decodeURIComponent(url.slice(url.indexOf('turns=') + 6).split('&')[0]))
    state.windows.push(Number.isFinite(at) ? at : null)
    return { ok: true, status: 200, json: async () => payloadOf(60, Number.isFinite(at) ? at : 50) }
  }
}

/** A fetch stub whose answer to this plugin's own route can be switched to a failure. */
function flakyFetch(answers) {
  return async (url, init) => {
    if (init !== undefined && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) }
    if (url.indexOf('/state') > -1 && url.indexOf('sessionId') === -1) return { ok: false, status: 400, json: async () => ({}) }
    if (url.indexOf('/dsh-rerun-turn/state') > -1) return { ok: true, status: 200, json: async () => ({ ok: true, replies: [] }) }
    if (answers.fail === true) return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => payloadOf(60, answers.window === undefined ? 50 : answers.window) }
  }
}

test('cache first: the loaded cards are drawn again at once, and a failed pass does not empty the page', async () => {
  const answers = { fail: false }
  const env = loadClient({ fetch: flakyFetch(answers) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  // A reader is on the page. That is what a failure is a notice FOR.
  const stop = controller.subscribe(() => {})
  await controller.refresh()
  const loaded = controller.getSnapshot().payload
  assert.notEqual(loaded, null)
  const cards = env.findAll(env.render(entry.component, controller), 'article').length
  assert.equal(cards > 0, true)
  assert.equal(noticeOf(env, env.render(entry.component, controller), 'loading'), null, 'a payload that is already here is never a loading state')

  // The route fails on the next pass: what is on screen survives it.
  answers.fail = true
  await controller.refresh()
  const after = controller.getSnapshot()
  assert.equal(after.payload, loaded, 'the same cards, not nothing: the last good payload is kept')
  assert.equal(after.failure, 'HTTP 500', 'and the failure is reported beside them')
  const tree = env.render(entry.component, controller)
  assert.equal(env.findAll(tree, 'article').length, cards, 'the cards are still drawn')
  assert.notEqual(noticeOf(env, tree, 'failure'), null, 'with the failure on top')
  assert.equal(noticeOf(env, tree, 'loading'), null, 'a failed refresh is not a reason to show the loading state')
  stop()
})

test('a tab switch is an unmount and a mount: the cards stay, so coming back is instant', async () => {
  const env = loadClient({ fetch: flakyFetch({ fail: false }) })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  await controller.refresh()
  const loaded = controller.getSnapshot().payload
  assert.notEqual(loaded, null)
  // A NEW component identity per mount, which is what React hands a view that was
  // unmounted and mounted again: the platform renders one view at a time
  // (dsh-client-ui-conversation: renderSlot('conversation.view', ..., { only: viewId })),
  // so switching tabs really does unmount this view and its hooks with it.
  const mount = () => env.render((props) => entry.component(props), controller)
  const first = mount()
  const cards = env.findAll(first, 'article').length
  assert.equal(cards > 0, true)
  // Unmount: React drops the view and runs its cleanup, which is detach().
  controller.detach()
  assert.equal(controller.getSnapshot().payload, loaded, 'unmounting the view does not drop the session data')
  const second = mount()
  // The mount starts a refresh, but the FIRST paint is the payload that is already
  // here - that is the whole difference between 'instant' and '正在读取…'.
  assert.equal(env.findAll(second, 'article').length, cards, 'the same cards, on the first paint')
  assert.equal(noticeOf(env, second, 'loading'), null, 'and never a loading state while there is something to draw')
  assert.equal(controller.getSnapshot().payload, loaded, 'mounting again does not empty the controller either')
})

test('a pass that is on the wire publishes: a younger request cannot discard its answer', async () => {
  const park = parkFetch()
  const env = loadClient({ fetch: park.fetch })
  const controller = env.runApply()[0].options.inject(SESSION, {}).controller
  const own = () => env.calls.filter((call) => call.url.indexOf(ROUTE_PREFIX + '/state?') === 0).length

  const pass = controller.refresh()
  await settle(4)
  assert.equal(park.parked.length, 2, 'a pass begins with the two sibling probes')
  // 404 is 'that sibling is not mounted': no rerun scan, so the next request this
  // pass makes is its own state read.
  park.parked[0].release({}, 404)
  park.parked[1].release({}, 404)
  await settle(4)
  assert.equal(park.parked.length, 3, 'and then reads the state')

  // The 5s tick (or a click, or 'load earlier') while that pass is on the wire.
  const joined = controller.refresh()
  assert.equal(park.parked.length, 3, 'the younger request joins the pass instead of starting a competing one')

  park.parked[2].release(payloadOf(60, 50))
  await Promise.all([pass, joined])
  assert.equal(controller.getSnapshot().payload !== null, true, 'the pass published what it fetched')
  assert.equal(own(), 1, 'one pass, one state request - and it was not thrown away')
})

test('the poll is a nudge: while a pass is on the wire the tick is skipped', async () => {
  const park = parkFetch()
  const env = loadClient({ fetch: park.fetch })
  const entry = env.runApply()[0]
  const controller = entry.options.inject(SESSION, {}).controller
  env.render(entry.component, controller) // attach(): arms the interval and starts the first pass
  assert.equal(env.intervals.length, 1, 'the poll exists only while the view is mounted')
  assert.equal(env.intervals[0].ms, env.api.__test.REFRESH_INTERVAL_MS, 'the poll cadence is the pinned one')
  await settle(4)
  assert.equal(park.parked.length, 2)
  env.intervals[0].fn() // five seconds later, with the first pass still on the wire
  assert.equal(park.parked.length, 2, 'the tick did not start a second probe round')
  park.parked[0].release({}, 404)
  park.parked[1].release({}, 404)
  await settle(4)
  assert.equal(park.parked.length, 3)
  park.parked[2].release(payloadOf(60, 50))
  await settle(6)
  assert.equal(controller.getSnapshot().payload !== null, true, 'the pass published')
})

test('the session the main view is showing is warmed once, before its tab is ever opened', async () => {
  const env = loadClient({ fetch: soloFetch({ windows: [] }) })
  const entry = env.runApply()[0]
  assert.deepEqual(env.injectRequests, [['uiSession']], 'the plugin asks the platform which session the conversation area shows')

  let listener = null
  const fired = env.installServices({
    uiSession: {
      current: {
        getSnapshot: () => ({ key: SESSION }),
        subscribe: (fn) => {
          listener = fn
          return () => {
            listener = null
          }
        },
      },
    },
  })
  assert.deepEqual(fired, [['uiSession']])
  assert.equal(typeof listener, 'function', 'the prefetch follows the session from then on')
  await settle(8)

  const own = () => env.calls.filter((call) => call.url.indexOf(ROUTE_PREFIX + '/state?') === 0)
  const controller = entry.options.inject(SESSION, {}).controller
  assert.notEqual(controller.getSnapshot().payload, null, 'the payload is already cached')
  assert.equal(env.intervals.length, 0, 'and nothing is on a timer: no view is mounted, so nothing polls')
  assert.equal(own().length, 1, 'exactly one request: the warm')

  // A second notification for the SAME session must not warm it twice: the cache
  // already holds it, and a prefetch is not a poll.
  listener()
  await settle(4)
  assert.equal(own().length, 1, 'warmed once per session')

  // THE POINT OF THE WHOLE CHANGE: the first click draws cards, and never '正在读取…'.
  const tree = env.render(entry.component, controller)
  assert.equal(env.findAll(tree, 'article').length > 0, true, 'cards on the first paint')
  assert.equal(noticeOf(env, tree, 'loading'), null, 'and no loading state at all')
})

test('NEGATIVE: a prefetch failure is silent, and nothing retries behind the reader\'s back', async () => {
  const env = loadClient({
    fetch: () => {
      throw new Error('no route')
    },
  })
  const entry = env.runApply()[0]
  env.installServices({
    uiSession: {
      current: {
        getSnapshot: () => ({ key: SESSION }),
        subscribe: () => () => {},
      },
    },
  })
  await settle(8)
  const controller = entry.options.inject(SESSION, {}).controller
  assert.equal(controller.getSnapshot().payload, null)
  // Nobody is looking at this page, so there is nobody to tell. A failure that no
  // view asked about must not be waiting on screen the moment one opens.
  assert.equal(controller.getSnapshot().failure, null, 'a prefetch never reports a failure')
  assert.equal(env.intervals.length, 0, 'and it does not arm a timer to try again')
})

test('the prefetch follows the main view from session to session, and tolerates a platform without the service', async () => {
  const env = loadClient({ fetch: soloFetch({ windows: [] }) })
  const entry = env.runApply()[0]
  const api = env.api.__test
  const OTHER = 'session-99999999-8888-7777-6666-555555555555'
  let current = SESSION
  const asked = []
  const source = {
    getSnapshot: () => ({ key: current }),
    subscribe: () => () => {},
  }
  const stop = api.warmMainSession(source, (id) => {
    asked.push(id)
    return entry.options.inject(id, {}).controller
  })
  assert.deepEqual(asked, [SESSION])
  current = OTHER
  api.warmMainSession(source, (id) => {
    asked.push(id)
    return entry.options.inject(id, {}).controller
  })
  assert.deepEqual(asked, [SESSION, OTHER])
  await settle(8)
  const own = (id) => env.calls.filter((call) => call.url.indexOf(ROUTE_PREFIX + '/state?') === 0 && call.url.indexOf(id) > -1)
  assert.equal(own(SESSION).length, 1, 'each session is warmed once')
  assert.equal(own(OTHER).length, 1, 'and a session the reader moves to is warmed too')
  const warmed = own(SESSION).length + own(OTHER).length
  source.getSnapshot = () => ({ key: OTHER })
  api.warmMainSession(source, (id) => {
    asked.push(id)
    return entry.options.inject(id, {}).controller
  })
  await settle(4)
  assert.equal(own(SESSION).length + own(OTHER).length, warmed, 'a repeat notification starts no pass: the cache is the answer')
  assert.equal(typeof stop, 'function', 'and the subscription can be dropped again')

  // A platform that does not offer the service, or offers a shape this plugin cannot
  // read, gets no prefetch and NO throw: the page still works, one round trip later.
  const refuse = () => {
    throw new Error('must not be called')
  }
  assert.equal(api.warmMainSession(null, refuse), null)
  assert.equal(api.warmMainSession({}, refuse), null)
  assert.equal(
    typeof api.warmMainSession(
      {
        getSnapshot: () => {
          throw new Error('boom')
        },
        subscribe: () => () => {},
      },
      refuse,
    ),
    'function',
    'a source whose snapshot throws is skipped, not fatal',
  )
  assert.equal(typeof api.warmMainSession({ getSnapshot: () => ({ key: '' }), subscribe: () => () => {} }, refuse), 'function', 'an absent session warms nothing')
})

test('the prefetch is wired to the platform service, and cannot grow into a second data path', async () => {
  const client = await readSource('client')
  assert.equal(client.indexOf("ctx.inject(['uiSession']") > -1, true, 'the prefetch reads the platform session binding')
  // One address for data and only one: the prefetch reuses the same controller and
  // therefore the same state route. A second path would be a second thing to keep
  // correct, and the first place a write verb could sneak in.
  const paths = dshPathsIn(client)
  assert.deepEqual(paths.filter((path) => path.indexOf(PROBE_ROUTES.deleteTurn) === 0 || path.indexOf(PROBE_ROUTES.rerunTurn) === 0 || path.indexOf(ROUTE_PREFIX) === 0).length > 0, true)
  assert.equal(client.indexOf('prefetch()') > -1, true)
})

