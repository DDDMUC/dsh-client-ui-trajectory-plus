// dsh-client-ui-trajectory-plus - pure core.
//
// Pure functions over a raw session event log plus serializable descriptors. The
// host half serves this from one loopback-only GET route; the tests drive it
// directly.
//
// READ-ONLY BY CONSTRUCTION: no service handle, no fetch, no write path. It reads
// a list of already-persisted events and returns a description; test/surface.test.js
// enforces that mechanically.
//
// The platform already owns a canonical surface fold: @deepseek-ai/dsh-session
// exports foldSurface(), and a LIVE Session exposes its own incremental fold as
// the getter session.surface (a SurfaceManager whose .nodes is the ordered
// surface). src/index.js PREFERS that one whenever the session is open in DSH and
// then reports surfaceSource 'platform'; foldSurfaceDerived below is the fallback
// for a persisted session nobody opened, or a surface whose projection
// definitions were unloaded.
//
// All siblings (dsh-declutter, dsh-delete-turn, dsh-rerun-turn) fold with the rule
// 'if (op === undefined) continue': an event is a surface node only when it
// carries an explicit surfaceOp marker. The platform refuses to WRITE a
// surface-eligible event without one, so on a current log that rule is exact -
// but a legacy log can hold message events with no marker, and there our fold and
// the platform's view disagree: the platform draws a row this rule cannot place.
// We keep the same rule (a different one would make the two folds incomparable),
// COUNT what it skips as unmarkedSurfaceEvents, and COMPARE our node list with the
// platform's as nodesAgree, so the deviation is measured and shown rather than
// hidden. See README 'known limitations'. This page is another perspective on the
// log, never a replacement for the trajectory view.

export const PLUGIN_ID = 'dsh-client-ui-trajectory-plus'
export const VERSION = '0.1.3'
export const ROUTE_PREFIX = '/dsh-client-ui-trajectory-plus'

/** The third tab, to the right of the chat view (order 0) and trajectory (order 10). */
export const VIEW_ID = 'surface'
export const VIEW_ORDER = 20

// --- the official view's history paging constants -----------------------------
//
// COPIED, NOT INVENTED. These are the numbers the shipped official trajectory
// view uses for its own 'load earlier' row and its bottom follow, read from
// @deepseek-ai/dsh-client-ui-trajectory/lib/client.js:
//
//   BOTTOM_FOLLOW_THRESHOLD_PX   = 2     (line 3993 of the shipped bundle)
//   OLDER_LOAD_THRESHOLD_PX      = 48    (line 3994)
//   HISTORY_LOAD_ROW_HEIGHT_PX   = 30    (line 3995)
//   VIRTUALIZATION_THRESHOLD     = 100   (line 3996)
//   HISTORY_PAGE_NODES           = 50    (line 8264)
//
// Reading them from the same numbers is the whole point: a reader who grows the
// window here and there must get the same step, the same trigger distance and
// the same row height, or the two views are not comparable.

/** How many more turns one 'load earlier' adds to the window. */
export const HISTORY_PAGE_NODES = 50
/** Within this distance of the top, scrolling loads the next page by itself. */
export const OLDER_LOAD_THRESHOLD_PX = 48
/** Only within this distance of the bottom does a new card follow the tail. */
export const BOTTOM_FOLLOW_THRESHOLD_PX = 2
/** The height of the 'load earlier' row. */
export const HISTORY_LOAD_ROW_HEIGHT_PX = 30
/**
 * The official view virtualizes above this many rows (and whenever it has older
 * history). This page does NOT virtualize: a 50-turn window of a few hundred
 * cards is not what the threshold exists for, and half a virtualizer is worse
 * than none. The number is kept here so the decision is written down and tested
 * rather than merely absent.
 */
export const VIRTUALIZATION_THRESHOLD = 100

/** The message-producing types, copied from the platform's own SURFACE_EVENT_TYPES. */
export const SURFACE_EVENT_TYPES = Object.freeze([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

const SURFACE_TYPES = new Set(SURFACE_EVENT_TYPES)

// --- WHO REPLACED A NODE ------------------------------------------------------
//
// A positional replacement carries the event that took the node's place. That
// carrier's own source names its author, and the author is what a reader needs:
// "the platform compacted this into a summary" and "you deleted this" are the
// same fold fact and completely different news.
//
// The taxonomy below is measured, not guessed. On the 151-turn session that
// produced this table (10643 events, 38 replacements, 2341 shadowed seqs):
//
//   compact-checkpoint                    4 carriers / 2307 seqs   compaction
//   system-prompt                        13 carriers /   13 seqs   other
//   tool                                 13 carriers /   13 seqs   other
//   user + source.editedBy=dsh-edit-turn  4 carriers /    4 seqs   edit
//   plugin:dsh-edit-turn                  1 carrier  /    1 seq    edit
//   plugin:dsh-delete-turn                3 carriers /    3 seqs   delete
//
// Two findings the table is built around, both read off that log:
//
//   * the platform's context compaction is the overwhelming cause: four
//     compact-checkpoint carriers shadow 2307 of the 2341 shadowed seqs, i.e.
//     98.5%. Those turns were never "deleted" - the summary replaced them for
//     the MODEL's context, while every original event is still in the log.
//   * a user's own rewrite arrives in TWO spellings. dsh-edit-turn stamps
//     kind 'plugin:dsh-edit-turn' on one path and kind 'user' plus
//     source.editedBy 'dsh-edit-turn' on another, so classifying on kind alone
//     files the user's edit as a platform replacement. Both are read here.

/** The replacement authors, in tie-break order: a user's act outranks the platform's. */
export const REPLACEMENT_AUTHORS = Object.freeze(['edit', 'delete', 'rerun', 'compaction', 'other'])

/** Author keys a user's own operation produces. */
export const USER_REPLACEMENT_AUTHORS = Object.freeze(['edit', 'delete', 'rerun'])

/** Carrier source.kind -> author, for the plugin spellings. */
const CARRIER_KIND_AUTHORS = Object.freeze({
  'dsh-edit-turn': 'edit',
  'dsh-delete-turn': 'delete',
  'dsh-rerun-turn': 'rerun',
})

/** Carrier source.editedBy -> author, the second spelling of the same user acts. */
const EDITED_BY_AUTHORS = Object.freeze({
  'dsh-edit-turn': 'edit',
  'dsh-delete-turn': 'delete',
  'dsh-rerun-turn': 'rerun',
})

/** The compaction source kind, and the prefix it must stay compatible with. */
export const COMPACTION_KIND = 'compact-checkpoint'

/** The badge/story copy key for one replacement author. */
export function replacementKeyOf(author) {
  if (author === 'edit') return 'rewritten'
  if (author === 'delete') return 'deleted'
  if (author === 'rerun') return 'rerun'
  if (author === 'compaction') return 'compacted'
  return 'replaced'
}

/**
 * Who caused one positional replacement, from the carrier event's own source.
 *
 * @param event - the replacement carrier (the event whose surfaceOp.op is replace).
 * @returns 'edit' | 'delete' | 'rerun' | 'compaction' | 'other'.
 */
export function replacementAuthor(event) {
  const source = sourceOf(event)
  if (source === undefined) return 'other'
  const editedBy = source.editedBy
  if (typeof editedBy === 'string' && Object.hasOwn(EDITED_BY_AUTHORS, editedBy)) return EDITED_BY_AUTHORS[editedBy]
  const kind = source.kind
  if (typeof kind !== 'string') return 'other'
  // 'plugin:dsh-edit-turn' and 'plugin/dsh-edit-turn' are the same author.
  const bare = kind.startsWith('plugin:') ? kind.slice(7) : kind.startsWith('plugin/') ? kind.slice(7) : kind
  if (Object.hasOwn(CARRIER_KIND_AUTHORS, bare)) return CARRIER_KIND_AUTHORS[bare]
  if (bare === COMPACTION_KIND || bare.startsWith('compact')) return 'compaction'
  return 'other'
}

/** Whether one author is a user's own operation. */
export function isUserReplacementAuthor(author) {
  return USER_REPLACEMENT_AUTHORS.includes(author)
}

/**
 * The author a card's removal is reported as: a user's own act always outranks the
 * platform's, and otherwise the largest count wins, ties broken by
 * REPLACEMENT_AUTHORS order.
 *
 * @param counts - { author: count } as counted over the turn's shadowed seqs.
 * @returns the author key, or null when nothing was replaced.
 */
export function dominantReplacementAuthor(counts) {
  let best = null
  for (const author of REPLACEMENT_AUTHORS) {
    const n = counts !== null && typeof counts === 'object' && typeof counts[author] === 'number' ? counts[author] : 0
    if (n <= 0) continue
    if (best === null) {
      best = author
      continue
    }
    const user = isUserReplacementAuthor(author)
    const bestUser = isUserReplacementAuthor(best)
    if (user !== bestUser) {
      if (user) best = author
      continue
    }
    if (n > counts[best]) best = author
  }
  return best
}

const HEX = '0123456789abcdef'
const WHITESPACE = String.fromCharCode(32, 9, 10, 11, 12, 13, 160)
const PATH_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-'

/**
 * The only two routes this plugin ever POSTs to, both owned by a sibling plugin.
 * The delete route is /dsh-delete-turn/delete, NOT .../apply: that is the path
 * dsh-delete-turn registers, and the body it wants is { sessionId, mode, turn }
 * with mode one of message/step/reply.
 */
export const PROXY_ROUTES = Object.freeze({
  deleteTurn: '/dsh-delete-turn/delete',
  rerunTurn: '/dsh-rerun-turn/apply',
})

/** Mount probes: no sessionId, so a mounted sibling answers 400 and an absent one 404. */
export const PROBE_ROUTES = Object.freeze({
  deleteTurn: '/dsh-delete-turn/state',
  rerunTurn: '/dsh-rerun-turn/state',
})

export const SIBLING_IDS = Object.freeze(['deleteTurn', 'rerunTurn'])

/** Every external route prefix this plugin is allowed to touch. */
export const SIBLING_PREFIXES = Object.freeze(['/dsh-delete-turn', '/dsh-rerun-turn'])

export const DEFAULT_OPTIONS = Object.freeze({
  // Design point 1: EVERY turn gets a card, including one the platform's
  // row-based trajectory view draws no row for. Switch off to reproduce that.
  renderEveryTurn: true,
  promptChars: 240,
  answerChars: 400,
  // --- the per-turn detail rows (task D) ------------------------------------
  //
  // One row per surface node of the turn, in seq order, so a card shows what
  // happened inside the turn instead of only its first question and last answer.
  // Every row is clipped, and the clip is reported per row (chars + truncated) so
  // a reader can tell a short node from a cut one. The defaults follow the shape
  // of the official rows: enough to recognize the node, not the node itself.
  // Measured on the 50-turn window of the 156-turn session whose numbers the
  // README's 'payload size' section reports.
  systemChars: 320,      // the system prompt row
  userChars: 320,        // the human's own message
  contextChars: 260,     // platform injections (runtime context, skill catalog, ...)
  assistantRowChars: 320, // one assistant row (a turn can carry many)
  toolNameChars: 96,     // the tool name + its argument summary
  toolResultChars: 260,  // the result preview on the tool/result row
  // A ceiling per turn, so one turn that swallowed a hundred rows cannot own the
  // whole payload. Rows are generated in seq order and dropped from the end, and
  // the card says it happened (rowsClipped) - never silently. 9000 is measured:
  // on the 156-turn session it leaves 34 of the 35 rows of the widest turn in
  // place (the one row over the line is the 33k-character context injection).
  rowBudgetChars: 9000,
  // A hard ceiling on ANY one row, applied on top of the per-kind numbers above
  // and not configurable: those are budgets a reader tunes, this one is what stops
  // a mistyped budget (contextChars: 999999) from putting a 33k-character context
  // injection into the payload. Measured on the real session: the largest context
  // node is 36664 characters, the largest user node 24708, the largest assistant
  // node 3490, the largest tool result 30669 - so this cap bites for exactly the
  // node kinds it exists for.
  charLimit: 4000,
  // The same window the platform holds for its own views (WINDOW_MAX = 50 in
  // @deepseek-ai/dsh-client-ui-session). Keep the numbers identical to the official
  // view instead of inventing one: the reader gets a comparable amount of history
  // and 'load older' grows it in the same step.
  maxTurns: 50,
  maxRerunSeqs: 400,
})

/**
 * The card action table: the ONE place that decides which buttons exist.
 *
 * requires     names the sibling plugin without which the action cannot work; a
 *              null entry means the action belongs to this plugin. The browser
 *              half never decides visibility itself - the host ships the answer
 *              in the payload - so 'appears only when that plugin is mounted' is
 *              a property of this table, testable with no browser.
 * enabledWhen  is evaluated only after requires passes.
 */
export const ACTION_RULES = Object.freeze([
  Object.freeze({ id: 'delete-turn', key: 'action.delete', requires: 'deleteTurn', enabledWhen: 'nodes' }),
  Object.freeze({ id: 'rerun-turn', key: 'action.rerun', requires: 'rerunTurn', enabledWhen: 'rerunSeq' }),
  Object.freeze({ id: 'refresh', key: 'action.refresh', requires: null, enabledWhen: 'always' }),
])

/** Normalize plugin configuration, reporting unknown keys instead of ignoring them. */
export function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const options = { ...DEFAULT_OPTIONS }
  const unknown = []
  for (const [key, value] of Object.entries(raw)) {
    if (Object.hasOwn(DEFAULT_OPTIONS, key) === false) {
      unknown.push(key)
      continue
    }
    if (typeof value === typeof DEFAULT_OPTIONS[key]) options[key] = value
    else unknown.push(key)
  }
  return { options, unknown: unknown.sort() }
}

/** Collapse whitespace runs and trim, without a regular expression. */
export function collapseWhitespace(text) {
  const source = String(text === null || text === undefined ? '' : text)
  let out = ''
  let pending = false
  for (const ch of source) {
    if (WHITESPACE.includes(ch)) {
      if (out !== '') pending = true
      continue
    }
    if (pending === true) {
      out += ' '
      pending = false
    }
    out += ch
  }
  return out
}

/** Interpolate {name} placeholders. Both halves use this for every visible number. */
export function formatText(template, params) {
  let out = String(template)
  if (params === null || typeof params !== 'object') return out
  for (const [key, value] of Object.entries(params)) out = out.split('{' + key + '}').join(String(value))
  return out
}

/** Whether a value is a session id in either spelling the store uses. */
export function isSessionId(value) {
  if (typeof value !== 'string') return false
  const body = value.startsWith('session-') ? value.slice(8) : value
  if (body.length !== 36) return false
  for (let index = 0; index < 36; index += 1) {
    const ch = body[index]
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (ch !== '-') return false
      continue
    }
    if (HEX.includes(ch.toLowerCase()) === false) return false
  }
  return true
}

/**
 * Every /dsh-* path literal in one source text. The mechanical test uses this to
 * prove the browser half can only address this plugin's state route plus the two
 * sibling routes.
 */
export function dshPathsIn(source) {
  const text = String(source)
  const found = new Set()
  let cursor = 0
  while (true) {
    const at = text.indexOf('/dsh-', cursor)
    if (at === -1) break
    let end = at + 5
    while (end < text.length && PATH_CHARS.includes(text[end])) end += 1
    found.add(text.slice(at, end))
    cursor = end
  }
  return [...found].sort()
}

/** Strip comments, keeping string literals, so the scans read code not prose. */
export function codeOnly(source) {
  const text = String(source)
  let out = ''
  let index = 0
  let mode = 'code'
  let quote = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    const next = text.charCodeAt(index + 1)
    if (mode === 'code') {
      if (code === 47 && next === 47) {
        mode = 'line'
        index += 2
        continue
      }
      if (code === 47 && next === 42) {
        mode = 'block'
        index += 2
        continue
      }
      if (code === 39 || code === 34 || code === 96) {
        mode = 'string'
        quote = code
        out += text[index]
        index += 1
        continue
      }
      out += text[index]
      index += 1
      continue
    }
    if (mode === 'line') {
      if (code === 10) {
        mode = 'code'
        out += ' '
      }
      index += 1
      continue
    }
    if (mode === 'block') {
      if (code === 42 && next === 47) {
        mode = 'code'
        index += 2
        out += ' '
        continue
      }
      index += 1
      continue
    }
    if (code === 92) {
      index += 2
      continue
    }
    if (code === quote) {
      mode = 'code'
      out += text[index]
      index += 1
      continue
    }
    out += text[index]
    index += 1
  }
  return out
}

/** Parse the siblings query value into a de-duplicated, whitelisted id list. */
export function parseSiblingList(value) {
  const out = []
  if (typeof value !== 'string' || value === '') return out
  for (const chunk of value.split(',')) {
    const id = chunk.trim()
    if (SIBLING_IDS.includes(id) && out.includes(id) === false) out.push(id)
  }
  return out
}

/**
 * Parse the rerunSeqs query value (turn:seq,turn:seq) into a turn -> seq map.
 * The rerun sibling is the authority on what it can rerun; the browser half asks
 * it and forwards the answer, so the host decides the button state in one place.
 */
export function parseRerunSeqs(value) {
  const out = new Map()
  if (typeof value !== 'string' || value === '') return out
  for (const chunk of value.split(',')) {
    const parts = chunk.split(':')
    if (parts.length !== 2) continue
    const turn = Number(parts[0])
    const seq = Number(parts[1])
    if (Number.isSafeInteger(turn) === false || turn < 0) continue
    if (Number.isSafeInteger(seq) === false || seq < 0) continue
    out.set(turn, seq)
    if (out.size >= DEFAULT_OPTIONS.maxRerunSeqs) break
  }
  return out
}

/** Event time in milliseconds, from whichever field the log uses. */
export function timeOf(event) {
  const time = event === null || typeof event !== 'object' ? undefined : event.time
  if (typeof time === 'number' && Number.isFinite(time)) return time
  if (typeof time === 'string') {
    const parsed = Date.parse(time)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** The message source of an event, whichever field carries it (v3 and v4 differ). */
export function sourceOf(event) {
  const data = event === null || typeof event !== 'object' ? undefined : event.data
  if (data === null || typeof data !== 'object') return undefined
  if (data.source !== null && typeof data.source === 'object') return data.source
  const message = data.message
  if (message !== null && typeof message === 'object' && message.source !== null && typeof message.source === 'object') return message.source
  return undefined
}

/** Flatten one message's text blocks. */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ')
}

/** The text of a user/assistant message event, or an empty string when it has none. */
export function messageTextOf(event) {
  const data = event === null || typeof event !== 'object' ? undefined : event.data
  if (data === null || typeof data !== 'object') return ''
  if (Array.isArray(data.content)) return textOfContent(data.content)
  if (data.message !== null && typeof data.message === 'object' && Array.isArray(data.message.content)) return textOfContent(data.message.content)
  return ''
}

/** Whether a message was authored by a plugin rather than by the human or the model. */
export function isPluginCarrier(event) {
  const source = sourceOf(event)
  if (source === undefined) return false
  const kind = source.kind
  if (kind === 'plugin') return true
  if (typeof kind !== 'string') return false
  return kind.startsWith('plugin:') || kind.startsWith('plugin/')
}

/** Whether one event type can produce a surface node. */
export function isSurfaceEligibleType(type) {
  return SURFACE_TYPES.has(type)
}

/** Whether a request/header continued an existing session rather than starting one. */
export function isResumeHeader(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'request/header') return false
  const data = event.data
  if (data === null || typeof data !== 'object') return false
  const fallback = data.header !== null && typeof data.header === 'object' ? data.header.reason : undefined
  const reason = data.reason === undefined ? fallback : data.reason
  return reason === 'resume'
}

/**
 * Our own read-only replay of the surface, with the same rule the siblings use.
 *
 * @returns nodes (current surface seqs in order), replacements (one per positional
 *   replacement, with the seqs it shadowed and the AUTHOR that replacement is
 *   attributed to; see replacementAuthor) and unmarked (seqs of surface-ELIGIBLE
 *   events carrying no marker at all - the events this rule cannot place and the
 *   platform's view may still draw).
 */
export function foldSurfaceDerived(events) {
  const list = Array.isArray(events) ? events : []
  const nodes = []
  const replacements = []
  const unmarked = []
  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    const op = event.surfaceOp
    if (op === undefined) {
      if (isSurfaceEligibleType(event.type)) unmarked.push(event.seq)
      continue
    }
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (op === null || typeof op !== 'object' || op.op !== 'replace') continue
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    replacements.push({ seq: event.seq, startSeq: op.startSeq, endSeq: op.endSeq, shadowed, author: replacementAuthor(event) })
  }
  return { nodes, replacements, unmarked }
}

/** Whether two sequence lists address the same surface. */
export function sameSeqSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort((a, b) => a - b)
  const sortedRight = [...right].sort((a, b) => a - b)
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

/** A blank turn record. */
export function emptyTurnRecord(turn) {
  return {
    turn,
    startSeq: null,
    endSeq: null,
    firstSeq: null,
    lastSeq: null,
    startedAt: null,
    closedAt: null,
    ends: [],
    eventCount: 0,
    retries: 0,
    resumes: 0,
  }
}

/**
 * Group a raw event log into turns.
 *
 * Turn brackets are the durable authority: turn/start opens, turn/end closes and
 * may close MORE THAN ONCE (that is how a turn fails and then succeeds), and an
 * event carrying its own data.turn is attributed to that turn whatever the bracket
 * state is. A turn number that appears only as a declared number on some event
 * still gets a record, which is why a turn cannot silently vanish here.
 */
export function indexTurns(events) {
  const list = Array.isArray(events) ? events : []
  const turns = new Map()
  const turnOfSeq = new Map()
  let open = null
  const ensure = (turn) => {
    let record = turns.get(turn)
    if (record === undefined) {
      record = emptyTurnRecord(turn)
      turns.set(turn, record)
    }
    return record
  }
  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    const declared = typeof data.turn === 'number' ? data.turn : undefined
    const time = timeOf(event)
    if (event.type === 'turn/start') {
      const turn = declared === undefined ? turns.size : declared
      const record = ensure(turn)
      if (record.startSeq === null) record.startSeq = event.seq
      if (record.startedAt === null) record.startedAt = time === undefined ? null : time
      if (record.firstSeq === null) record.firstSeq = event.seq
      record.lastSeq = event.seq
      open = turn
      turnOfSeq.set(event.seq, turn)
      continue
    }
    if (event.type === 'turn/end') {
      const turn = declared === undefined ? open : declared
      if (typeof turn !== 'number') {
        turnOfSeq.set(event.seq, null)
        continue
      }
      const record = ensure(turn)
      const reason = data.reason !== null && typeof data.reason === 'object' ? data.reason : { kind: 'unknown' }
      const error = reason.error !== null && typeof reason.error === 'object' ? reason.error : null
      record.ends.push({
        seq: event.seq,
        time: time === undefined ? null : time,
        kind: typeof reason.kind === 'string' ? reason.kind : 'unknown',
        message: error !== null && typeof error.message === 'string' ? error.message : null,
        code: error !== null && typeof error.code === 'string' ? error.code : null,
      })
      record.endSeq = event.seq
      if (time !== undefined) record.closedAt = time
      if (record.firstSeq === null) record.firstSeq = event.seq
      record.lastSeq = event.seq
      turnOfSeq.set(event.seq, turn)
      if (open === turn) open = null
      continue
    }
    const turn = declared === undefined ? open : declared
    if (typeof turn !== 'number') {
      turnOfSeq.set(event.seq, null)
      continue
    }
    turnOfSeq.set(event.seq, turn)
    const record = ensure(turn)
    record.eventCount += 1
    if (record.firstSeq === null) record.firstSeq = event.seq
    record.lastSeq = event.seq
    if (record.endSeq !== null && event.seq > record.endSeq) record.endSeq = event.seq
    if (event.type === 'llm/retry' || event.type === 'llm/retry-started') record.retries += 1
    if (isResumeHeader(event)) record.resumes += 1
  }
  return { turns, turnOfSeq }
}

/**
 * Clip message text to the configured budget, reporting what was lost.
 *
 * @param limit - the per-kind budget (a reader may raise it).
 * @param max - the hard ceiling; the effective cut is min(limit, max).
 */
function clipText(text, limit, max) {
  const value = collapseWhitespace(text)
  const ceiling = typeof max === 'number' && max > 0 ? Math.min(limit, max) : limit
  if (value.length <= ceiling) return { text: value, chars: value.length, truncated: false }
  return { text: value.slice(0, ceiling), chars: value.length, truncated: true }
}

/**
 * One clipped text segment OF A VALUE THAT IS NOT NECESSARILY A STRING, reporting
 * what was lost. A tool call's arguments are an object; the preview of an object
 * is its JSON. Everything else about the clip is clipText's.
 */
function clipValue(value, limit, max) {
  if (value === undefined || value === null) return null
  const source = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof source !== 'string' || source === '') return null
  const clipped = clipText(source, limit, max)
  if (clipped.chars === 0) return null
  return clipped
}

// --- THE ROWS OF ONE TURN -----------------------------------------------------
//
// A card's rows are the turn's CURRENT surface nodes, one row each, in seq order:
// the same nodes the platform draws rows for, so 'what the card shows' and 'what
// the model had in context' are the same list. A node the current surface no
// longer holds (compaction retired it) produces no row; if that leaves a turn
// with nothing, the turn's own content is restored under the 'archived' source,
// exactly like the card's prompt/answer pair already does.
//
// The classification is the ONE judgement call in this file, and it is written as
// a question about the AUTHOR rather than a list of kinds:
//
//   who wrote this node?  the human  -> 'user'
//                         the model  -> 'assistant'
//                         neither    -> 'context' (the platform injected it)
//
// so a platform injection this file has never heard of (runtime-context,
// skill-catalog, model-selection, whatever is added next) is filed as context by
// default instead of falling through a table. 'system' is the one exception: a
// system-role row is called 'system' because that is what it says on the tin,
// even though the author test would have called it context too.

/** The row kinds. The browser half mirrors this list; a test pins the two. */
export const ROW_KINDS = Object.freeze(['system', 'user', 'context', 'assistant', 'compacted', 'tool', 'tool-result'])

/**
 * The lane a row occupies in the colour strip (task E), copied from the official
 * view's own mapping (deriveTrajectoryTimeline):
 *
 *   lane 0  system / user / context      (the setting)
 *   lane 1  assistant / compacted        (the model speaking)
 *   lane 2  tool / tool-result           (work done)
 *
 * The three lanes are what the official strip draws; the mapping is the one place
 * the two agree by construction, because it is one small table rather than a
 * derivation.
 */
export function rowLaneOf(kind) {
  if (kind === 'assistant' || kind === 'compacted') return 1
  if (kind === 'tool' || kind === 'tool-result') return 2
  return 0
}

/** Source kinds that mean 'a human typed this'. */
const HUMAN_SOURCE_KINDS = Object.freeze(['user'])

/**
 * Classify one node into a row kind, from its author rather than from a table of
 * known kinds. See the block comment above.
 *
 * @param event - a surface node.
 * @returns one of ROW_KINDS.
 */
export function rowKindOf(event) {
  const type = event === null || typeof event !== 'object' ? undefined : event.type
  if (type === 'system/message') return 'system'
  if (type === 'developer/message') return 'system'
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool-result'
  if (type !== 'user/message') return 'context'
  const source = sourceOf(event)
  const kind = source === undefined ? undefined : source.kind
  if (kind === COMPACTION_KIND || (typeof kind === 'string' && kind.startsWith('compact'))) return 'compacted'
  if (kind === undefined || kind === null) return 'user'
  return HUMAN_SOURCE_KINDS.includes(kind) ? 'user' : 'context'
}

/** Flatten one message's text blocks to text, joining multiple blocks with a space. */
export function rowTextOf(event) {
  const data = event === null || typeof event !== 'object' ? undefined : event.data
  if (data === null || typeof data !== 'object') return ''
  if (Array.isArray(data.content)) return textOfContent(data.content)
  if (data.message !== null && typeof data.message === 'object' && Array.isArray(data.message.content)) {
    return textOfContent(data.message.content)
  }
  return ''
}

/** The content blocks of one node, whichever field carries them (v3 and v4 differ). */
function blocksOf(event) {
  const data = event === null || typeof event !== 'object' ? undefined : event.data
  if (data === null || typeof data !== 'object') return []
  if (Array.isArray(data.content)) return data.content
  if (data.message !== null && typeof data.message === 'object' && Array.isArray(data.message.content)) return data.message.content
  return []
}

/**
 * How many non-text blocks one node carries, BY KIND and by media type - the '图片
 * ×1' the official row shows. Counted, never guessed: a block whose type is not
 * 'text' is a non-text block, and its type (or its attachment's media type) is
 * what the count is keyed by.
 */
export function nonTextCountsOf(event) {
  const out = {}
  for (const block of blocksOf(event)) {
    if (block === null || typeof block !== 'object') continue
    const type = typeof block.type === 'string' ? block.type : 'unknown'
    if (type === 'text' || type === 'reasoning') continue
    let key = type
    const attachment = block.attachment
    if (attachment !== null && typeof attachment === 'object' && typeof attachment.mediaType === 'string') key = attachment.mediaType
    out[key] = (out[key] === undefined ? 0 : out[key]) + 1
  }
  return out
}

/**
 * Whether one node carries nothing a reader can see at all - no text and no
 * block. Such a node produces no row: a row that says nothing is worse than no
 * row, because it still makes the reader look. A node with NO TEXT but with an
 * image or a tool name is not empty and does get one ('图片 ×1').
 */
function isBlankNode(event) {
  const text = collapseWhitespace(rowTextOf(event))
  if (text !== '') return false
  return blocksOf(event).length === 0
}

/**
 * A tool call's name and argument summary, by call id, collected once per payload.
 *
 * WHY /what:/ is read first: a tool call's argument summary is written FOR a
 * reader by the model that made the call, and the raw arguments of a code runner
 * are a program, not a line a person can scan. The raw JSON is the fallback for
 * the calls that carry no description - honesty first, prettiness second.
 */
export function toolCallMap(events) {
  const out = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue
    for (const block of blocksOf(event)) {
      if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
      if (typeof block.id !== 'string') continue
      out.set(block.id, { name: typeof block.name === 'string' ? block.name : '', arguments: block.arguments })
    }
  }
  return out
}

/** One string field of an argument object, or ''. */
function stringFieldOf(raw, key) {
  if (raw === null || typeof raw !== 'object') return ''
  const value = raw[key]
  if (typeof value === 'string') return value
  return ''
}

/**
 * A ONE-LINE summary of what a tool call was asked to do, taken from the call's
 * own arguments. This is measured, not guessed.
 *
 * The platform's tool contract namespaces an argument description under /what/,
 * and its documented shape is a language model call: {language, code} or
 * {language, content}. On the 1191 tool calls of the session this was measured on
 * there is no /what/ at all - every call carries a top-level 'description', which
 * the model wrote FOR A READER ('List DSH home dir', 'Recon workspace and DSH
 * home'). Both spellings are read here, and 'description' wins when both exist,
 * because it is the one written as a summary.
 *
 * The order matters at the end: 'url' before the raw arguments, so a web fetch row
 * says where it fetched instead of showing a JSON blob.
 */
export function toolSummaryOf(event, calls, limit) {
  const source = toolMetaOf(event, calls, 0)
  const raw = source.raw
  const previewLimit = typeof limit === 'number' && limit > 0 ? limit : DEFAULT_OPTIONS.toolNameChars
  const nameOnly = source.name === '' ? null : { text: source.name, chars: source.name.length, truncated: false }
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    // No arguments to summarize (or unparsable ones): the name is a real answer,
    // and it is the only one there is.
    return nameOnly
  }
  let summary = stringFieldOf(raw, 'what')
  if (summary === '') {
    const nested = raw.what !== null && typeof raw.what === 'object' ? raw.what : null
    summary = stringFieldOf(nested, 'text')
  }
  if (summary === '') summary = stringFieldOf(raw, 'description')
  if (summary === '') summary = stringFieldOf(raw.command, 'description')
  if (summary === '') summary = stringFieldOf(raw, 'url')
  if (summary === '') summary = stringFieldOf(raw, 'command')
  if (summary === '') {
    const clipped = clipValue(raw, previewLimit)
    if (clipped === null) return nameOnly
    return source.name === '' ? clipped : { text: source.name + ' ' + clipped.text, chars: source.name.length + 1 + clipped.chars, truncated: clipped.truncated }
  }
  const body = clipText(summary, previewLimit)
  if (source.name === '') return body
  return { text: source.name + ' ' + body.text, chars: source.name.length + 1 + body.chars, truncated: body.truncated }
}

/**
 * The tool name and argument summary for one call id.
 *
 * The call may be the node (a tool/call event) or be carried by an assistant
 * message (the tool-call block), which is the usual case: the result node holds
 * the call id and nothing else.
 */
export function toolMetaOf(event, calls, limit) {
  const data = event === null || typeof event !== 'object' ? undefined : event.data
  const message = data !== null && typeof data === 'object' && data.message !== null && typeof data.message === 'object' ? data.message : undefined
  const source = data !== null && typeof data === 'object' && data.source !== null && typeof data.source === 'object' ? data.source : message === undefined ? undefined : message.source
  let callId = data !== null && typeof data === 'object' ? data.toolCallId : undefined
  if (typeof callId !== 'string' && message !== undefined && typeof message.toolCallId === 'string') callId = message.toolCallId
  if (typeof callId !== 'string' && source !== undefined && typeof source.callId === 'string') callId = source.callId
  let name = data !== null && typeof data === 'object' && typeof data.name === 'string' ? data.name : ''
  let raw
  if (typeof callId === 'string' && calls instanceof Map && calls.has(callId)) {
    const call = calls.get(callId)
    if (name === '') name = call.name
    raw = call.arguments
  }
  if (typeof raw === 'string') {
    // The stored arguments are JSON text; a caller may also hand the object over
    // directly. Both end up as an object here, or as null when it does not parse.
    try {
      raw = JSON.parse(raw)
    } catch (error) {
      raw = null
    }
  }
  // The name alone is always available; the SUMMARY needs the arguments, and
  // toolSummaryOf composes the two (see its own comment for why it lives there).
  const preview = name === '' ? null : { text: name, chars: name.length, truncated: false }
  return { callId: typeof callId === 'string' ? callId : null, name, raw, preview }
}

/**
 * Whether one node ERRORED - and the third answer matters.
 *
 * The platform records the fact on the tool result (message.isError) and, in the
 * same event, as an error object. Some events carry neither, and there the honest
 * answer is null, not false: a cell that is not red must not be a claim that
 * everything went fine. The colour strip paints red on true only.
 *
 * @returns true | false | null (null = the log does not say).
 */
export function rowErrorOf(event) {
  const data = event === null || typeof event !== 'object' ? undefined : event.data
  if (data === null || typeof data !== 'object') return null
  const flag = data.isError
  const message = data.message !== null && typeof data.message === 'object' ? data.message : undefined
  const messageFlag = message === undefined ? undefined : message.isError
  if (flag === true || messageFlag === true) return true
  if (flag === false || messageFlag === false) return false
  if (data.error !== null && typeof data.error === 'object') return true
  return null
}

/** The configured clip limit for one row kind. */
function limitForKind(kind, settings) {
  if (kind === 'system') return settings.systemChars
  if (kind === 'user') return settings.userChars
  if (kind === 'assistant' || kind === 'compacted') return settings.assistantRowChars
  if (kind === 'tool-result') return settings.toolResultChars
  return settings.contextChars
}

/**
 * One row per surface node of one turn, in seq order (task D).
 *
 * @param nodeEvents - the turn's current nodes, in seq order.
 * @param ctx - { settings, calls, archived, compaction } from describeSurface.
 * @returns { rows, clipped } - rows, and whether the per-turn budget cut any.
 */
export function buildRows(nodeEvents, ctx) {
  const settings = ctx === null || typeof ctx !== 'object' ? DEFAULT_OPTIONS : ctx.settings
  const calls = ctx === null || typeof ctx !== 'object' ? undefined : ctx.calls
  const budget = typeof settings.rowBudgetChars === 'number' && settings.rowBudgetChars > 0 ? settings.rowBudgetChars : DEFAULT_OPTIONS.rowBudgetChars
  const rows = []
  let spent = 0
  let clipped = false
  const list = Array.isArray(nodeEvents) ? nodeEvents : []
  for (let index = 0; index < list.length; index += 1) {
    const event = list[index]
    const kind = rowKindOf(event)
    const row = { seq: event.seq, kind, lane: rowLaneOf(kind) }
    const counts = nonTextCountsOf(event)
    if (Object.keys(counts).length > 0) row.nonText = counts
    // The error fact is read for every kind, and only a definite true is RED: the
    // strip must not paint a cell green on the strength of a missing field.
    const error = rowErrorOf(event)
    if (error !== null) row.error = error
    // Every row that addresses a tool call gets the name and the argument summary,
    // whichever of the two spellings the node uses (a tool/result node carries the
    // call id and no name of its own - the name lives on the assistant message).
    const isToolRow = kind === 'tool' || kind === 'tool-result'
    if (isToolRow) {
      const meta = toolMetaOf(event, calls, settings.toolNameChars)
      if (meta.name !== '') row.tool = meta.name
      const summary = toolSummaryOf(event, calls, settings.toolNameChars)
      if (summary !== null && summary.text !== '') {
        row.toolPreview = summary.text
        if (summary.truncated === true) row.toolPreviewTruncated = true
      }
    }
    const cap = typeof settings.charLimit === 'number' ? settings.charLimit : DEFAULT_OPTIONS.charLimit
    const body =
      isToolRow === true
        ? clipText(rowTextOf(event), settings.toolResultChars, cap)
        : clipText(rowTextOf(event), limitForKind(kind, settings), cap)
    if (body !== null && body.text !== '') {
      row.text = body.text
      row.chars = body.chars
      if (body.truncated === true) row.truncated = true
    }
    if (row.text === undefined && (row.tool === undefined || row.tool === '') && isBlankNode(event) === true) continue
    const cost = (typeof row.text === 'string' ? row.text.length : 0) + (typeof row.toolPreview === 'string' ? row.toolPreview.length : 0)
    if (spent + cost > budget) {
      clipped = true
      break
    }
    spent += cost
    rows.push(row)
  }
  // The compacted turn: its current surface is empty, but the log still holds the
  // originals. They come back as rows marked 'archived', never as current.
  if (rows.length === 0 && ctx !== null && typeof ctx === 'object' && ctx.archived !== null && ctx.archived !== undefined) {
    const archived = ctx.archived
    if (archived.prompt !== null && archived.prompt !== undefined) {
      rows.push({ seq: archived.prompt.seq, kind: 'user', lane: rowLaneOf('user'), archived: true, text: archived.prompt.text, chars: archived.prompt.chars, truncated: archived.prompt.truncated === true })
    }
    if (archived.answer !== null && archived.answer !== undefined) {
      rows.push({ seq: archived.answer.seq, kind: 'assistant', lane: rowLaneOf('assistant'), archived: true, text: archived.answer.text, chars: archived.answer.chars, truncated: archived.answer.truncated === true })
    }
  }
  return { rows, clipped }
}

/**
 * The colour strip's cells (task E), derived from the SAME rows the cards render.
 *
 * The official strip is one line per lane, each lane holding one cell per row that
 * belongs to it. This is that structure and nothing else - no time axis, no
 * per-call axis, no duration: the three projection modes the official view offers
 * are deliberately NOT implemented (README, 'known limitations').
 *
 * A cell carries the three facts the strip paints and the click needs: which lane,
 * which kind, and whether the row ERRORED. 'red' is set from a definite error only;
 * a row the log says nothing about is not red and not green either - the strip has
 * no colour for 'unknown', so it keeps the kind's colour.
 *
 * @param cards - the cards of the payload, in order.
 * @returns { lanes, cells, kinds } - cells is flat and in row order.
 */
export function buildStrip(cards) {
  const lanes = [[], [], []]
  const cells = []
  const kinds = {}
  for (const card of Array.isArray(cards) ? cards : []) {
    if (card === null || typeof card !== 'object' || Array.isArray(card.rows) === false) continue
    const turnCells = []
    for (const row of card.rows) {
      if (row === null || typeof row !== 'object') continue
      const lane = typeof row.lane === 'number' ? row.lane : rowLaneOf(row.kind)
      const cell = { turn: card.turn, seq: row.seq, kind: row.kind, lane }
      if (row.error === true) cell.red = true
      if (row.archived === true) cell.archived = true
      cells.push(cell)
      if (lanes[lane] !== undefined) lanes[lane].push(cell)
      kinds[row.kind] = (kinds[row.kind] === undefined ? 0 : kinds[row.kind]) + 1
      turnCells.push(cell)
    }
    // A turn that ENDED IN ERROR is red on ITS OWN cell: the last cell before the
    // first failing one, or the turn's last cell when no node failed by itself.
    // It rides on the card (turnError), never on a row: the log does not say that
    // that particular node failed.
    if (card.turnError === true && turnCells.length > 0 && turnCells.every((cell) => cell.red !== true)) {
      turnCells[turnCells.length - 1].red = true
    }
  }
  return { lanes, cells, kinds }
}

/**
 * The primary status of one turn.
 *
 * Precedence is deliberate. A turn whose content was retired outranks a failure
 * notice, because 'the content is gone' is what a reader needs first, and the
 * failure survives as a badge. A turn with no current node but with a resume
 * header is the context-only turn, not an empty one.
 *
 * 'replaced' and 'compacted' are the same fold fact and are NOT the same news:
 * compaction retires a turn for the model's context while the timeline keeps it,
 * so a compacted card is a card that still has its content (restored, see
 * turnFacts) and merely says so. A user's own edit or delete, and the platform's
 * housekeeping prunes, keep the plain 'replaced' - there the content really is
 * not what the log holds anymore.
 */
export function statusOf(facts) {
  if (facts.ended === false) return 'running'
  if (facts.nodes === 0 && facts.suppressed > 0) return facts.removedBy === 'compaction' ? 'compacted' : 'replaced'
  if (facts.failed === true && facts.recovered === false) return 'failed'
  if (facts.failed === true && facts.recovered === true) return 'recovered'
  if (facts.nodes === 0) return facts.resumes > 0 ? 'injected' : 'empty'
  if (facts.prompt === null && facts.carriers > 0) return 'synthetic'
  if (facts.prompt === null) return 'injected'
  return 'content'
}

/**
 * The secondary markers, in a fixed order so the payload is deterministic.
 *
 * One badge per replacement author present, not one badge for 'replaced': a card
 * that lost two nodes to compaction and one to the user's own rewrite must say
 * both, and each says it with its own copy key.
 */
export function badgesOf(facts) {
  const out = []
  if (facts.ended === false) out.push({ key: 'badge.running', params: {} })
  if (facts.failed === true) out.push({ key: 'badge.failed', params: {} })
  if (facts.recovered === true) out.push({ key: 'badge.recovered', params: {} })
  if (facts.resumes > 0) out.push({ key: 'badge.resumed', params: { n: facts.resumes } })
  if (facts.retries > 0) out.push({ key: 'badge.retried', params: { n: facts.retries } })
  if (Array.isArray(facts.suppression) === true && facts.suppression.length > 0) {
    for (const entry of facts.suppression) out.push({ key: 'badge.' + replacementKeyOf(entry.author), params: { n: entry.n } })
  } else if (facts.suppressed > 0) out.push({ key: 'badge.replaced', params: { n: facts.suppressed } })
  if (facts.carriers > 0) out.push({ key: 'badge.carrier', params: { n: facts.carriers } })
  if (facts.contextOnly === true) out.push({ key: 'badge.contextOnly', params: {} })
  if (facts.rowless === true) out.push({ key: 'badge.rowless', params: {} })
  return out
}

/**
 * Build the action list for one card from the declarative table.
 * @param table - the action rules; injectable so a test can drop a rule's requires
 *   clause and watch the button appear for an absent plugin.
 */
export function actionList(facts, ctx, table = ACTION_RULES) {
  const out = []
  for (const rule of table) {
    const required = rule.requires === null ? true : ctx.siblings.has(rule.requires)
    let enabled = required === true && ctx.busy === false && facts.ended === true
    if (enabled === true) {
      if (rule.enabledWhen === 'nodes') enabled = facts.nodes > 0
      else if (rule.enabledWhen === 'rerunSeq') enabled = typeof facts.rerunSeq === 'number'
    }
    let reason = 'ok'
    if (required === false) reason = 'sibling-absent'
    else if (facts.ended === false) reason = 'running'
    else if (ctx.busy === true) reason = 'busy'
    else if (enabled === false && rule.enabledWhen === 'nodes') reason = 'no-target'
    else if (enabled === false && rule.enabledWhen === 'rerunSeq') reason = 'no-reply'
    const params = {}
    if (rule.id === 'delete-turn') {
      params.mode = 'reply'
      params.turn = facts.turn
    }
    if (rule.id === 'rerun-turn' && typeof facts.rerunSeq === 'number') params.seq = facts.rerunSeq
    let path = ROUTE_PREFIX + '/state'
    if (rule.id === 'delete-turn') path = PROXY_ROUTES.deleteTurn
    else if (rule.id === 'rerun-turn') path = PROXY_ROUTES.rerunTurn
    out.push({
      id: rule.id,
      key: rule.key,
      requires: rule.requires,
      visible: required === true,
      enabled: enabled === true && required === true,
      reason,
      // The one route this action may ever POST to. The browser half refuses any
      // other value, so a card can never become a general-purpose HTTP client.
      path,
      params,
    })
  }
  return out
}

/** One author's count, or 0 when the turn has none of that author. */
function authorCount(authors, author) {
  if (authors === null || typeof authors !== 'object') return 0
  const n = authors[author]
  return typeof n === 'number' && n > 0 ? n : 0
}

/**
 * A turn's replacements as an ordered [{author, n}] list: most first, ties broken
 * by REPLACEMENT_AUTHORS so a user's own act is listed before the platform's.
 */
export function suppressionList(authors) {
  const out = []
  for (const author of REPLACEMENT_AUTHORS) {
    const n = authorCount(authors, author)
    if (n > 0) out.push({ author, n })
  }
  return out.sort((left, right) => {
    if (left.n !== right.n) return right.n - left.n
    return REPLACEMENT_AUTHORS.indexOf(left.author) - REPLACEMENT_AUTHORS.indexOf(right.author)
  })
}

/**
 * The turn's own messages as they were written, for a turn whose current state the
 * platform's compaction retired.
 *
 * WHY THIS EXISTS: compaction removes the originals from the surface the MODEL
 * sees, which is a real and deliberate fold - but the timeline still contains
 * them, so a card that says only 'this content was removed' is telling the reader
 * that their history is gone when it is not. The originals are restored and the
 * card is marked, rather than silently presenting them as current.
 *
 * Two rules keep the restore honest:
 *   * only events this fold actually placed as nodes (an explicit surfaceOp
 *     marker) are eligible, so a legacy unmarked message is not resurrected into
 *     a card on the strength of this fallback;
 *   * an original a USER operation replaced is never restored. The user rewrote
 *     or deleted it on purpose, and the sibling plugin's record is the authority
 *     on that, not this page.
 */
function archivedContentOf(record, ctx) {
  const events = ctx.turnEvents instanceof Map ? ctx.turnEvents.get(record.turn) : undefined
  const list = Array.isArray(events) ? events : []
  const shadowedAuthors = ctx.shadowedAuthors instanceof Map ? ctx.shadowedAuthors : new Map()
  const settings = ctx.settings
  let prompt = null
  let answer = null
  for (const event of list) {
    if (ctx.everyEvent !== true && event.surfaceOp === undefined) continue
    if (isUserReplacementAuthor(shadowedAuthors.get(event.seq)) === true) continue
    if (event.type === 'user/message' && prompt === null) {
      const source = sourceOf(event)
      const kind = source === undefined ? undefined : source.kind
      const human = kind === undefined || kind === null || kind === 'user'
      if (human === true) {
        const clipped = clipText(messageTextOf(event), settings.promptChars)
        if (clipped.text !== '') prompt = { seq: event.seq, text: clipped.text, chars: clipped.chars, truncated: clipped.truncated }
      }
    }
    if (event.type === 'assistant/message') {
      const clipped = clipText(messageTextOf(event), settings.answerChars)
      if (clipped.text !== '') answer = { seq: event.seq, text: clipped.text, chars: clipped.chars, truncated: clipped.truncated }
    }
  }
  return { prompt, answer }
}

/** Facts for one turn: its current surface, its shadowed history and its brackets. */
export function turnFacts(record, ctx) {
  const nodeSeqs = Array.isArray(ctx.nodes) ? ctx.nodes : []
  const nodeEvents = []
  for (const seq of nodeSeqs) {
    const event = ctx.bySeq.get(seq)
    if (event !== undefined) nodeEvents.push(event)
  }
  let prompt = null
  let answer = null
  let carriers = 0
  let contextNodes = 0
  for (const event of nodeEvents) {
    if (isPluginCarrier(event) === true) carriers += 1
    if (event.type === 'system/message' || event.type === 'developer/message') contextNodes += 1
    if (event.type === 'user/message' && prompt === null) {
      const source = sourceOf(event)
      const kind = source === undefined ? undefined : source.kind
      const human = kind === undefined || kind === null || kind === 'user'
      if (human === true) {
        const clipped = clipText(messageTextOf(event), ctx.settings.promptChars)
        if (clipped.text !== '') prompt = { seq: event.seq, text: clipped.text, chars: clipped.chars, truncated: clipped.truncated }
      }
    }
    if (event.type === 'assistant/message') {
      const clipped = clipText(messageTextOf(event), ctx.settings.answerChars)
      if (clipped.text !== '') answer = { seq: event.seq, text: clipped.text, chars: clipped.chars, truncated: clipped.truncated }
    }
  }
  const ends = record.ends.map((end) => ({ seq: end.seq, kind: end.kind, message: end.message, code: end.code }))
  const lastEnd = ends.length === 0 ? null : ends[ends.length - 1]
  const failed = ends.some((end) => end.kind === 'error')
  const recovered = failed === true && lastEnd !== null && lastEnd.kind !== 'error'
  const closedAt = record.closedAt
  const durationMs = record.startedAt !== null && closedAt !== null ? Math.max(0, closedAt - record.startedAt) : null
  const suppression = suppressionList(ctx.suppressed.authors)
  const removedBy = dominantReplacementAuthor(ctx.suppressed.authors)
  // Compaction retired this turn's content from the model's view but not from the
  // log: put the originals back, marked, instead of reporting them as gone.
  let archived = false
  if (prompt === null && answer === null && ctx.suppressed.count > 0 && authorCount(ctx.suppressed.authors, 'compaction') > 0) {
    const userReplaced = suppression.some((entry) => isUserReplacementAuthor(entry.author) === true)
    if (userReplaced === false) {
      const restored = archivedContentOf(record, { ...ctx, everyEvent: true })
      prompt = restored.prompt
      answer = restored.answer
      archived = prompt !== null || answer !== null
    }
  }
  // The detail rows: the turn's CURRENT nodes first, one row each. Only when the
  // current surface holds nothing does the restored original become rows, marked.
  // The two never mix inside one card, so a row can never be the original of a
  // node that is still current.
  const detail = buildRows(nodeEvents, {
    settings: ctx.settings,
    // nodeEvents is in seq order: nodesByTurn filled it from the ordered surface.
    calls: ctx.calls,
    archived: archived === true ? { prompt, answer } : null,
  })
  // The turn's own failure is a fact about the TURN, not about one node, so it
  // rides on the card and the strip reads it there: a failed turn's last cell is
  // red even though no single row is. Painting it onto a row instead would claim
  // that that node errored, which the log does not say.
  const turnError = ends.some((end) => end.kind === 'error')
  const turnErrorMessage = (() => {
    for (let index = ends.length - 1; index >= 0; index -= 1) {
      if (ends[index].kind === 'error') return ends[index].message
    }
    return null
  })()
  const facts = {
    turn: record.turn,
    ended: ends.length > 0,
    failed,
    recovered,
    resumes: record.resumes,
    retries: record.retries,
    nodes: nodeSeqs.length,
    nodeSeqs: [...nodeSeqs],
    suppressed: ctx.suppressed.count,
    replacedBy: [...ctx.suppressed.by],
    suppression,
    removedBy,
    archived,
    carriers,
    contextOnly: nodeSeqs.length > 0 && contextNodes === nodeSeqs.length,
    rowless: nodeSeqs.length === 0,
    prompt,
    answer,
    // The turn's own rows, in seq order (task D). everyRowSeq makes the two orders
    // comparable: rowSeqs[i] is the seq of rows[i].
    rows: detail.rows,
    rowsClipped: detail.clipped,
    rowBudget: ctx.settings.rowBudgetChars,
    // The turn's own failure (turn/end reason.kind === 'error'), which is what the
    // official strip paints red on the turn's last cell.
    turnError,
    turnErrorMessage,
    events: record.eventCount,
    startSeq: record.startSeq,
    endSeq: record.endSeq,
    startedAt: record.startedAt,
    closedAt,
    durationMs,
    ends,
    rerunSeq: ctx.rerunSeqs.get(record.turn),
  }
  facts.status = statusOf(facts)
  facts.badges = badgesOf(facts)
  return facts
}

/**
 * Describe one session log as cards.
 *
 * @param options - resolved (resolveConfig result), platformNodes (the platform's
 *   own surface, or null when no live session could supply it), siblings (ids the
 *   browser half found mounted), rerunSeqs (Map of what the rerun sibling can
 *   rerun). @returns the serializable payload the state route serves.
 */
export function describeSurface(events, options = {}) {
  const list = Array.isArray(events) ? events.filter((event) => event !== null && typeof event === 'object') : []
  const resolved = options.resolved === undefined ? resolveConfig({}) : options.resolved
  const settings = resolved.options
  const siblingList = Array.isArray(options.siblings) ? options.siblings.filter((id) => SIBLING_IDS.includes(id)) : []
  const siblings = new Set(siblingList)
  const rerunSeqs = options.rerunSeqs instanceof Map ? options.rerunSeqs : new Map()
  const derived = foldSurfaceDerived(list)
  const offered = Array.isArray(options.platformNodes) ? options.platformNodes.filter((seq) => Number.isSafeInteger(seq)) : null
  const nodes = offered === null ? derived.nodes : offered
  const bySeq = new Map()
  for (const event of list) if (typeof event.seq === 'number') bySeq.set(event.seq, event)
  // One index of the tool calls, built once for the whole payload, so a tool/result
  // row can say which tool ran and what it was asked to do.
  const calls = toolCallMap(list)
  const indexed = indexTurns(list)
  const turns = indexed.turns
  const turnOfSeq = indexed.turnOfSeq
  const shadowedBy = new Map()
  const shadowedAuthors = new Map()
  for (const replacement of derived.replacements) {
    for (const seq of replacement.shadowed) {
      shadowedBy.set(seq, replacement.seq)
      shadowedAuthors.set(seq, replacement.author)
    }
  }
  // Every event, bucketed by the turn it belongs to, so a compacted turn can be
  // shown as it was written instead of as an empty shell. One pass; the buckets
  // keep log order because turnOfSeq was filled in log order.
  const turnEvents = new Map()
  for (const [seq, turn] of turnOfSeq) {
    if (typeof turn !== 'number') continue
    const event = bySeq.get(seq)
    if (event === undefined) continue
    const bucket = turnEvents.get(turn)
    if (bucket === undefined) turnEvents.set(turn, [event])
    else bucket.push(event)
  }
  const nodesByTurn = new Map()
  const orphanNodes = []
  for (const seq of nodes) {
    const turn = turnOfSeq.get(seq)
    if (typeof turn !== 'number') {
      orphanNodes.push(seq)
      continue
    }
    const bucket = nodesByTurn.get(turn)
    if (bucket === undefined) nodesByTurn.set(turn, [seq])
    else bucket.push(seq)
  }
  const suppressedByTurn = new Map()
  let orphanSuppressed = 0
  for (const [seq, by] of shadowedBy) {
    const turn = turnOfSeq.get(seq)
    if (typeof turn !== 'number') {
      orphanSuppressed += 1
      continue
    }
    const author = shadowedAuthors.get(seq) === undefined ? 'other' : shadowedAuthors.get(seq)
    let bucket = suppressedByTurn.get(turn)
    if (bucket === undefined) {
      bucket = { count: 0, by: [], authors: {} }
      suppressedByTurn.set(turn, bucket)
    }
    bucket.count += 1
    if (bucket.by.includes(by) === false) bucket.by.push(by)
    bucket.authors[author] = (bucket.authors[author] === undefined ? 0 : bucket.authors[author]) + 1
  }
  // A window is the NEWEST maxTurns turns, never the oldest: this page shows where
  // the conversation is now, and the older end is exactly what 'load older' fetches.
  const all = [...turns.values()].sort((left, right) => left.turn - right.turn)
  const ordered = settings.maxTurns > 0 ? all.slice(-settings.maxTurns) : all
  const facts = []
  for (const record of ordered) {
    const nodeSeqs = nodesByTurn.get(record.turn)
    const suppressed = suppressedByTurn.get(record.turn)
    facts.push(
      turnFacts(record, {
        bySeq,
        nodes: nodeSeqs === undefined ? [] : nodeSeqs,
        suppressed: suppressed === undefined ? { count: 0, by: [], authors: {} } : suppressed,
        shadowedAuthors,
        turnEvents,
        calls,
        settings,
        rerunSeqs,
      }),
    )
  }
  const busy = facts.length > 0 && facts[facts.length - 1].status === 'running'
  const rowlessTurns = facts.filter((fact) => fact.rowless === true).map((fact) => fact.turn)
  const shown = settings.renderEveryTurn === true ? facts : facts.filter((fact) => fact.rowless === false)
  const cards = []
  for (const fact of shown) {
    const card = { ...fact }
    card.actions = actionList(fact, { siblings, busy })
    cards.push(card)
  }
  // The strip (task E): the same rows the cards hold, folded into three lanes and
  // one flat cell list, plus the per-kind counts the legend shows.
  const strip = buildStrip(cards)
  const rowCount = cards.reduce((sum, card) => sum + (Array.isArray(card.rows) ? card.rows.length : 0), 0)
  const rowsClippedTurns = cards.filter((card) => card.rowsClipped === true).length
  // The replacement carriers themselves, by author: how many events did the
  // replacing, and how many nodes did each of them retire. This is the page-level
  // answer to 'who removed my history', and it is counted, never guessed.
  const replacementsByAuthor = {}
  for (const replacement of derived.replacements) {
    const entry = replacementsByAuthor[replacement.author] === undefined ? { carriers: 0, shadowed: 0 } : replacementsByAuthor[replacement.author]
    entry.carriers += 1
    entry.shadowed += replacement.shadowed.length
    replacementsByAuthor[replacement.author] = entry
  }
  const countOf = (status) => facts.filter((fact) => fact.status === status).length
  const totals = {
    turns: facts.length,
    shown: cards.length,
    rowless: rowlessTurns.length,
    // The detail rows (task D) and the strip's cells (task E), which are the same
    // rows: rowsTotal must always equal strip.cells.length, and a test says so.
    rows: rowCount,
    rowsClippedTurns,
    content: countOf('content'),
    empty: countOf('empty'),
    injected: countOf('injected'),
    replaced: countOf('replaced'),
    // The platform's own compaction, told apart from a user's edit/delete.
    compacted: countOf('compacted'),
    synthetic: countOf('synthetic'),
    failed: countOf('failed'),
    recovered: countOf('recovered'),
    running: countOf('running'),
  }
  const notices = []
  if (offered === null) notices.push({ key: 'notice.surface-derived', params: {} })
  if (offered !== null && sameSeqSet(offered, derived.nodes) === false) notices.push({ key: 'notice.nodes-disagree', params: {} })
  if (derived.unmarked.length > 0) notices.push({ key: 'notice.unmarked-events', params: { n: derived.unmarked.length } })
  if (siblings.has('deleteTurn') === false) notices.push({ key: 'notice.sibling-delete-absent', params: {} })
  if (siblings.has('rerunTurn') === false) notices.push({ key: 'notice.sibling-rerun-absent', params: {} })
  if (orphanNodes.length > 0) notices.push({ key: 'notice.orphan-nodes', params: { n: orphanNodes.length } })
  if (facts.length === 0) notices.push({ key: 'notice.empty', params: {} })
  return {
    plugin: PLUGIN_ID,
    version: VERSION,
    viewId: VIEW_ID,
    viewOrder: VIEW_ORDER,
    // Which fold produced the current state the cards show, and whether the two
    // folds agree. nodesAgree is null when there was no platform projection to
    // compare with, which is not the same as 'they agree'.
    surfaceSource: offered === null ? 'derived' : 'platform',
    nodesAgree: offered === null ? null : sameSeqSet(offered, derived.nodes),
    unmarkedSurfaceEvents: derived.unmarked.length,
    unmarkedSeqs: derived.unmarked.slice(0, 64),
    events: list.length,
    nodes: nodes.length,
    derivedNodes: derived.nodes.length,
    replacements: derived.replacements.length,
    replacementsByAuthor,
    turns: cards,
    // The colour strip: three lanes and their cells, plus the per-kind counts. It
    // is served next to the cards rather than inside each of them so the page can
    // draw the strip without walking every card's rows, and the two can never
    // disagree because both come out of buildStrip/buildRows here.
    strip: { lanes: strip.lanes, cells: strip.cells, kinds: strip.kinds, total: strip.cells.length },
    // Whether the window clipped the session, so the page can offer to grow it.
    hasOlder: all.length > ordered.length,
    windowTurns: settings.maxTurns,
    oldestTurn: ordered.length > 0 ? ordered[0].turn : null,
    rowlessTurns,
    totals,
    orphanNodes: orphanNodes.slice(0, 64),
    orphanSuppressed,
    busy,
    siblings: siblingList,
    notices,
    options: {
      renderEveryTurn: settings.renderEveryTurn,
      promptChars: settings.promptChars,
      answerChars: settings.answerChars,
      // The detail-row budgets, so the page can say what it is showing (a reader
      // must be able to tell a clipped row from a short one).
      systemChars: settings.systemChars,
      userChars: settings.userChars,
      contextChars: settings.contextChars,
      assistantRowChars: settings.assistantRowChars,
      toolNameChars: settings.toolNameChars,
      toolResultChars: settings.toolResultChars,
      rowBudgetChars: settings.rowBudgetChars,
      rowKinds: [...ROW_KINDS],
      rowLanes: { 0: ['system', 'user', 'context'], 1: ['assistant', 'compacted'], 2: ['tool', 'tool-result'] },
    },
    unknownOptionKeys: resolved.unknown,
  }
}
