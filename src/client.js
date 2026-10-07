// dsh-client-ui-trajectory-plus - browser half.
//
// A classic client-module bundle. It registers ONE conversation view tab
// (id 'surface', order 20) beside the chat view (id 'chat', order 0, owned by
// dsh-client-ui-chat) and the trajectory view (id 'trajectory', order 10, owned
// by @deepseek-ai/dsh-client-ui-trajectory), and renders one card per turn.
//
// WHAT THIS HALF IS ALLOWED TO DO
// ------------------------------
//   * GET this plugin's own state route, on a timer and after every action;
//   * GET the two sibling plugins' state routes to learn whether they are mounted
//     at all (the mount probe convention: 400/405 means present, 404 or a
//     rejected fetch means absent);
//   * POST the two card actions to the sibling routes their owners publish.
//
// It never touches the session log. It cannot: it has no session handle, and its
// POST targets are checked against a two-entry allow-list before any request is
// made, so a malformed payload cannot turn a card into an arbitrary HTTP client.
// Deleting and re-running are the siblings' business and stay theirs; this page
// only decides whether their buttons belong on a card.
//
// WHERE THE BUTTON RULE LIVES
// ---------------------------
// On the host. The browser half sends the two externally-observable facts only it
// can see - which siblings answered the probe, and which turns the rerun sibling
// says it can rerun - and renders the action list that comes back. That keeps
// 'the button appears only when the plugin is mounted' in one testable place
// instead of split across two languages.
window.__ModuleLoader__.load({
  id: 'dsh-client-ui-trajectory-plus',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    const NS = 'dsh-client-ui-trajectory-plus'
    const VERSION = '0.1.3'
    const ROUTE_PREFIX = '/dsh-client-ui-trajectory-plus'
    const VIEW_ID = 'surface'
    const VIEW_ORDER = 20
    // The sibling cadence: one poll every three seconds while the tab is open.
    const REFRESH_INTERVAL_MS = 5000
    // The official view's history paging numbers, copied from
    // @deepseek-ai/dsh-client-ui-trajectory/lib/client.js and pinned to
    // src/logic.js by a test so the two halves cannot drift:
    //   HISTORY_PAGE_NODES       50   (shipped bundle line 8264)
    //   BOTTOM_FOLLOW_THRESHOLD_PX 2  (line 3993)
    //   OLDER_LOAD_THRESHOLD_PX  48   (line 3994)
    //   HISTORY_LOAD_ROW_HEIGHT_PX 30 (line 3995)
    //   VIRTUALIZATION_THRESHOLD 100  (line 3996) - deliberately NOT implemented:
    //     the official view virtualizes above 100 rows (or whenever it has older
    //     history, for its spacer margin); a 50-turn window does not need it.
    const HISTORY_PAGE_NODES = 50
    const BOTTOM_FOLLOW_THRESHOLD_PX = 2
    const OLDER_LOAD_THRESHOLD_PX = 48
    const HISTORY_LOAD_ROW_HEIGHT_PX = 30
    const VIRTUALIZATION_THRESHOLD = 100
    // The same two strings as src/logic.js PROBE_ROUTES / PROXY_ROUTES. A test
    // pins them together so the halves cannot drift, and POST_TARGETS is the
    // allow-list every action is checked against.
    const PROBE_ROUTES = { deleteTurn: '/dsh-delete-turn/state', rerunTurn: '/dsh-rerun-turn/state' }
    const PROXY_ROUTES = { deleteTurn: '/dsh-delete-turn/delete', rerunTurn: '/dsh-rerun-turn/apply' }
    const POST_TARGETS = [PROXY_ROUTES.deleteTurn, PROXY_ROUTES.rerunTurn]

    // --- copy -----------------------------------------------------------------

    const zh = {
      'view.surface': '轨迹plus',
      'tabs.hint': '每一轮一张卡片，包括平台轨迹画不出行的轮次。',
      'card.title': '第 {n} 轮',
      'card.user': '用户',
      'card.assistant': '助手',
      'card.none': '本轮无内容',
      'card.injectedOnly': '本轮无内容 / 仅上下文注入',
      'card.replacedOnly': '本轮内容已从当前状态下移除',
      'card.story': '发生过什么',
      // The detail rows (task D) and the colour strip (task E).
      'row.system': '系统',
      'row.user': '用户',
      'row.context': '上下文',
      'row.assistant': '助手',
      'row.compacted': '压缩',
      'row.tool': '工具',
      'row.toolResult': '结果',
      'row.archivedTag': '原始内容',
      'row.image': '图片 ×{n}',
      'row.file': '文件 ×{n}',
      'row.block': '{kind} ×{n}',
      'row.more': '（共 {n} 字符）',
      'row.clipped': '本轮的明细过多，后面的 {n} 行没有列出',
      'strip.legend': '逐格：{n} 格 · 红 = 出错',
      'strip.title': '一轮里的每一步',
      'strip.jump': '跳到这一格',
      'card.duration': '{s} 秒',
      'card.durationMs': '{n} 毫秒',
      'status.running': '进行中',
      'status.content': '有内容',
      'status.empty': '空轮次',
      'status.injected': '仅上下文注入',
      'status.replaced': '内容已被移除',
      'status.compacted': '已压缩进摘要',
      'status.synthetic': '合成轮次',
      'status.failed': '失败',
      'status.recovered': '失败后恢复',
      'badge.running': '进行中',
      'badge.failed': '失败',
      'badge.recovered': '已恢复',
      'badge.resumed': '{n} 次恢复',
      'badge.retried': '{n} 次重试',
      'badge.replaced': '{n} 条被替换',
      'badge.rewritten': '{n} 条已改写',
      'badge.deleted': '{n} 条已删除',
      'badge.rerun': '{n} 条已重跑',
      'badge.compacted': '{n} 条已压缩进摘要',
      'badge.carrier': '{n} 条插件消息',
      'badge.contextOnly': '仅上下文',
      'badge.rowless': '无行',
      'story.retried': '{n} 次重试',
      'story.replaced': '{n} 条被替换',
      'story.rewritten': '{n} 条已改写',
      'story.deleted': '{n} 条已删除',
      'story.rerun': '{n} 条已重跑',
      'story.compacted': '{n} 条已压缩进摘要',
      'card.archived': '原始内容（已压缩进摘要）',
      'card.compactedOnly': '本轮内容已压缩进摘要，原始正文不可用',
      'history.loadEarlier': '加载更早',
      'history.clickToLoadEarlier': '点击加载更早',
      'history.loadingEarlier': '正在加载更早…',
      'story.resumed': '{n} 次恢复',
      'story.ends': '结束 {n} 次',
      'action.delete': '删除',
      'action.rerun': '重跑',
      'action.refresh': '刷新',
      'reason.ok': '可用',
      'reason.sibling-absent': '对应的插件没有安装',
      'reason.no-target': '这一轮当前没有可删除的内容',
      'reason.no-reply': '这一轮没有可重跑的作答',
      'reason.busy': '会话正在回复中',
      'reason.running': '这一轮还没有结束',
      'notice.surface-derived': '当前状态由本插件自己折叠得出，没有拿到平台的投影',
      'notice.nodes-disagree': '本插件折叠出的节点与平台的投影不一致，请以平台轨迹为准',
      'notice.unmarked-events': '有 {n} 条消息事件没有 surfaceOp 标记，本插件看到了它们，平台可能画不出',
      'notice.sibling-delete-absent': '未安装 dsh-delete-turn，删除按钮不显示',
      'notice.sibling-rerun-absent': '未安装 dsh-rerun-turn，重跑按钮不显示',
      'notice.orphan-nodes': '有 {n} 条当前节点不属于任何轮次',
      'notice.empty': '这个会话还没有轮次',
      'notice.loading': '正在读取…',
      'notice.load-failed': '读不到状态：{code}',
      'notice.submitted': '已提交，正在刷新',
      'notice.submit-failed': '提交失败：{code}',
    }

    const en = {
      'view.surface': 'Trajectory Plus',
      'tabs.hint': 'One card per turn, including the turns the platform trajectory cannot draw a row for.',
      'card.title': 'Turn {n}',
      'card.user': 'User',
      'card.assistant': 'Assistant',
      'card.none': 'This turn has no content',
      'card.injectedOnly': 'No content / context injection only',
      'card.replacedOnly': 'This turn content was removed from the current state',
      'card.story': 'What happened',
      'row.system': 'System',
      'row.user': 'User',
      'row.context': 'Context',
      'row.assistant': 'Assistant',
      'row.compacted': 'Compacted',
      'row.tool': 'Tool',
      'row.toolResult': 'Result',
      'row.archivedTag': 'Original',
      'row.image': 'image ×{n}',
      'row.file': 'file ×{n}',
      'row.block': '{kind} ×{n}',
      'row.more': '({n} chars in all)',
      'row.clipped': '{n} further row(s) of this turn are not listed',
      'strip.legend': '{n} cell(s) · red = failed',
      'strip.title': 'Every step of a turn',
      'strip.jump': 'Jump to this cell',
      'card.duration': '{s}s',
      'card.durationMs': '{n}ms',
      'status.running': 'Running',
      'status.content': 'Has content',
      'status.empty': 'Empty turn',
      'status.injected': 'Context injection only',
      'status.replaced': 'Content removed',
      'status.compacted': 'Compacted into a summary',
      'status.synthetic': 'Synthetic turn',
      'status.failed': 'Failed',
      'status.recovered': 'Failed, then recovered',
      'badge.running': 'Running',
      'badge.failed': 'Failed',
      'badge.recovered': 'Recovered',
      'badge.resumed': '{n} resume(s)',
      'badge.retried': '{n} retry(ies)',
      'badge.replaced': '{n} replaced',
      'badge.rewritten': '{n} rewritten',
      'badge.deleted': '{n} deleted',
      'badge.rerun': '{n} re-run',
      'badge.compacted': '{n} compacted into a summary',
      'badge.carrier': '{n} plugin message(s)',
      'badge.contextOnly': 'Context only',
      'badge.rowless': 'No row',
      'story.retried': '{n} retry(ies)',
      'story.replaced': '{n} replaced',
      'story.rewritten': '{n} rewritten',
      'story.deleted': '{n} deleted',
      'story.rerun': '{n} re-run',
      'story.compacted': '{n} compacted into a summary',
      'card.archived': 'Original content (compacted into a summary)',
      'card.compactedOnly': 'This turn was compacted into a summary; the original body is unavailable',
      'history.loadEarlier': 'Load earlier',
      'history.clickToLoadEarlier': 'Click to load earlier',
      'history.loadingEarlier': 'Loading earlier…',
      'story.resumed': '{n} resume(s)',
      'story.ends': 'closed {n} times',
      'action.delete': 'Delete',
      'action.rerun': 'Re-run',
      'action.refresh': 'Refresh',
      'reason.ok': 'available',
      'reason.sibling-absent': 'the plugin is not installed',
      'reason.no-target': 'this turn has nothing to delete right now',
      'reason.no-reply': 'this turn has no reply to re-run',
      'reason.busy': 'the session is still working',
      'reason.running': 'this turn has not finished',
      'notice.surface-derived': 'The current state is folded by this plugin; the platform projection was not available',
      'notice.nodes-disagree': 'This plugin fold disagrees with the platform projection. Trust the trajectory view.',
      'notice.unmarked-events': '{n} message event(s) carry no surfaceOp marker: this plugin sees them, the platform may not draw them',
      'notice.sibling-delete-absent': 'dsh-delete-turn is not installed, so the delete button is hidden',
      'notice.sibling-rerun-absent': 'dsh-rerun-turn is not installed, so the re-run button is hidden',
      'notice.orphan-nodes': '{n} current node(s) belong to no turn',
      'notice.empty': 'This session has no turns yet',
      'notice.loading': 'Loading…',
      'notice.load-failed': 'Cannot read the state: {code}',
      'notice.submitted': 'Submitted, refreshing',
      'notice.submit-failed': 'Submit failed: {code}',
    }

    // --- style: attribute-keyed and namespaced, so a React re-render of the
    // platform's own nodes can never fight this sheet.

    // The three lane colours, and the reason each row carries its own lane bar: a
    // cell in the strip and its row in a card must be findable from one another.
    const CSS = [
      '.dshts-root{display:flex;flex-direction:column;gap:8px;padding:8px 0 32px;overflow:auto}',
      '.dshts-head{padding:0 12px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px}',
      '.dshts-notice{display:block;margin:0 12px;padding:5px 8px;border-radius:6px;background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.1));color:var(--dsw-alias-label-secondary,#61666d);font-size:12px}',
      '.dshts-card{border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24));border-radius:10px;margin:0 12px;overflow:hidden}',
      '.dshts-cardHead{display:flex;align-items:center;gap:6px;padding:7px 10px;background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.06));font-size:13px}',
      '.dshts-turn{font-weight:600}',
      '.dshts-duration{margin-left:auto;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px}',
      '.dshts-badge{padding:0 6px;border-radius:4px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;line-height:18px;white-space:nowrap}',
      '.dshts-body{padding:8px 10px;display:flex;flex-direction:column;gap:6px}',
      '.dshts-none{margin:0;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px}',
      '.dshts-story{margin:0;padding:0 10px 8px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px}',
      '.dshts-actions{display:flex;gap:8px;justify-content:flex-end;padding:7px 10px;border-top:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}',
      '.dshts-action{border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));background:transparent;border-radius:6px;padding:2px 10px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);cursor:pointer}',
      '.dshts-action:disabled{opacity:.5;cursor:default}',
      '.dshts-action:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:2px}',
      '.dshts-historyLoadRow{width:100%;height:30px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#61666d);font:inherit;font-size:12px;cursor:pointer}',
      '.dshts-historyLoadButton:hover:not(:disabled){background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.1));color:var(--dsw-alias-label-primary,inherit)}',
      '.dshts-historyLoadButton:disabled{cursor:default;opacity:.6}',
      '.dshts-historyLoadButton:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:-2px}',
      '.dshts-archived{margin:0;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px}',
      '.dshts-rows{display:flex;flex-direction:column;gap:3px}',
      '.dshts-row2{display:flex;gap:6px;align-items:flex-start;font-size:12.5px;line-height:1.5}',
      '.dshts-lane{flex:none;width:3px;align-self:stretch;border-radius:2px;background:var(--dshts-lane-0,#8a8f98)}',
      '.dshts-lane[data-dshts-lane="1"]{background:var(--dshts-lane-1,#4d6bfe)}',
      '.dshts-lane[data-dshts-lane="2"]{background:var(--dshts-lane-2,#20a162)}',
      '.dshts-row2[data-dshts-red="1"] .dshts-lane{background:var(--dsw-alias-state-error-primary,#d93025)}',
      '.dshts-tag{flex:none;width:44px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11.5px;line-height:1.5}',
      '.dshts-rowText{margin:0;flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}',
      '.dshts-rowTool{margin:0;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;word-break:break-word}',
      '.dshts-rowTool b{font-weight:600;color:var(--dsw-alias-label-secondary,#61666d)}',
      '.dshts-chips{flex:none;display:flex;gap:4px}',
      '.dshts-chip{padding:0 4px;border-radius:3px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10.5px;line-height:15px;white-space:nowrap}',
      '.dshts-rowArchived{flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10.5px}',
      '.dshts-primary{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:1px;border-radius:3px}',
      '.dshts-strip{position:sticky;top:0;z-index:1;display:flex;flex-direction:column;gap:2px;padding:6px 12px;background:var(--dsw-alias-bg-base,Canvas)}',
      '.dshts-laneRow{display:flex;gap:2px;height:10px}',
      '.dshts-cell{flex:none;width:5px;height:10px;border:0;padding:0;border-radius:1px;cursor:pointer;background:var(--dshts-cell-0,#c9ccd1)}',
      '.dshts-cell:hover{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:1px}',
      '.dshts-cell[data-dshts-kind="user"],.dshts-cell[data-dshts-kind="system"]{background:var(--dshts-cell-system,#8a8f98)}',
      '.dshts-cell[data-dshts-kind="assistant"]{background:var(--dshts-cell-assistant,#4d6bfe)}',
      '.dshts-cell[data-dshts-kind="compacted"]{background:var(--dshts-cell-compacted,#b07d2b)}',
      '.dshts-cell[data-dshts-kind="tool"],.dshts-cell[data-dshts-kind="tool-result"]{background:var(--dshts-cell-tool,#20a162)}',
      '.dshts-cell[data-dshts-red="1"]{background:var(--dsw-alias-state-error-primary,#d93025)}',
      '.dshts-stripFoot{display:flex;gap:8px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px}',
      '.dshts-stripFoot b{font-weight:600;color:var(--dsw-alias-label-secondary,#61666d)}',
      '.dshts-stripKey{display:flex;align-items:center;gap:4px}',
      '.dshts-swatch{width:8px;height:8px;border-radius:2px;display:inline-block}',
      '@media (prefers-reduced-motion:reduce){.dshts-root{scroll-behavior:auto}}',
    ].join('')

    const TAG_ID = NS + '/surface.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // --- small readers --------------------------------------------------------

    function formatText(template, params) {
      let out = String(template)
      if (params === null || typeof params !== 'object') return out
      for (const [key, value] of Object.entries(params)) out = out.split('{' + key + '}').join(String(value))
      return out
    }

    function formatQuery(params) {
      const parts = []
      for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined || value === '') continue
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      }
      return parts.length === 0 ? '' : '?' + parts.join('&')
    }

    /** The mount probe convention: a mounted sibling answers 400 or 405. */
    function probeStatus(status) {
      return status === 400 || status === 405 ? 'present' : 'absent'
    }

    /**
     * Whether a pane is within `threshold` pixels of its bottom - the ONLY
     * condition under which new cards may move the view. Copied from the official
     * view's own follow test (TrajectoryTable.js: followsTableTail.current =
     * scrollHeight - clientHeight - scrollTop <= BOTTOM_FOLLOW_THRESHOLD_PX).
     */
    function isNearBottom(node, threshold) {
      if (node === null || node === undefined) return false
      const height = typeof node.scrollHeight === 'number' ? node.scrollHeight : 0
      const view = typeof node.clientHeight === 'number' ? node.clientHeight : 0
      const top = typeof node.scrollTop === 'number' ? node.scrollTop : 0
      const limit = typeof threshold === 'number' ? threshold : BOTTOM_FOLLOW_THRESHOLD_PX
      return height - view - top <= limit
    }

    /** Whether a pane has entered the older-load band at its top. */
    function isNearTop(node, threshold) {
      if (node === null || node === undefined) return false
      const top = typeof node.scrollTop === 'number' ? node.scrollTop : 0
      const limit = typeof threshold === 'number' ? threshold : OLDER_LOAD_THRESHOLD_PX
      return top <= limit
    }

    /**
     * The lane of one row kind. Mirrors src/logic.js rowLaneOf; a test pins the two
     * together, so the strip and the rows can never disagree about which lane a
     * kind belongs to.
     */
    function rowLaneOf(kind) {
      if (kind === 'assistant' || kind === 'compacted') return 1
      if (kind === 'tool' || kind === 'tool-result') return 2
      return 0
    }

    /** The copy key for one row kind. */
    function rowKindKey(kind) {
      if (kind === 'tool-result') return 'row.toolResult'
      return 'row.' + String(kind)
    }

    /** A count of non-text blocks as a chip label: the official row's '图片 ×1'. */
    function nonTextLabel(t, kind, n) {
      if (typeof kind === 'string' && kind.startsWith('image/')) return formatText(t('row.image'), { n })
      return formatText(t('row.block'), { kind, n })
    }

    /**
     * The copy-key suffix for one replacement author. Mirrors
     * src/logic.js replacementKeyOf; a test pins the two together.
     */
    function replacementKeyOf(author) {
      if (author === 'edit') return 'rewritten'
      if (author === 'delete') return 'deleted'
      if (author === 'rerun') return 'rerun'
      if (author === 'compaction') return 'compacted'
      return 'replaced'
    }

    function durationLabel(t, ms) {
      if (typeof ms !== 'number') return ''
      if (ms < 1000) return formatText(t('card.durationMs'), { n: ms })
      return formatText(t('card.duration'), { s: Math.round(ms / 100) / 10 })
    }

    // --- the per-session controller ------------------------------------------
    // One per session id. It owns the poll, the two probes and the two POSTs;
    // everything it renders comes from the host payload.

    class SurfaceController {
      constructor(sessionId) {
        this.sessionId = sessionId
        this.listeners = new Set()
        this.timer = null
        // THE PASS ON THE WIRE: exactly one, or none. See refresh().
        this.pass = null
        // A caller that arrived while that pass was running and needs a pass which
        // STARTS after its own call (the window just grew, an action was just
        // submitted) is served by exactly one follow-up pass.
        this.again = false
        // Whether this session has already been warmed by the prefetch. One warm per
        // session per page load: never a poll, never a retry.
        this.warmed = false
        // What the rerun sibling last said it can rerun, and whether it has been
        // asked yet. Its answer costs a full session fold, so it is learned in the
        // background instead of in front of the reader.
        this.rerunTargets = []
        this.rerunScanned = false
        // The window, in turns. It starts at HISTORY_PAGE_NODES - the same number
        // the official view grows its own history by - and only ever grows.
        this.windowTurns = HISTORY_PAGE_NODES
        // The in-flight guard for 'load earlier'. It is a plain instance flag, not
        // state, because a re-entrant call must be refused SYNCHRONOUSLY: the
        // scroll handler and a click can arrive in the same tick, and both would
        // otherwise read stale state and fetch the same page twice.
        this.loadingEarlier = false
        this.state = {
          payload: null,
          failure: null,
          loading: true,
          loadingEarlier: false,
          pending: null,
          localNotice: null,
          probes: { deleteTurn: 'unknown', rerunTurn: 'unknown' },
        }
      }

      /**
       * Grow the window by one page and refetch. One action, reached two ways: the
       * 'load earlier' row's click, and the scroll position entering
       * OLDER_LOAD_THRESHOLD_PX of the top. A re-entrant call does nothing at all -
       * no window growth, no fetch.
       *
       * @returns whether a page was requested.
       */
      async loadEarlier() {
        if (this.loadingEarlier === true) return false
        const payload = this.getSnapshot().payload
        if (payload === null || payload.hasOlder !== true) return false
        this.loadingEarlier = true
        this.windowTurns += HISTORY_PAGE_NODES
        this.publish({ loadingEarlier: true })
        try {
          // 'again': the page must be fetched by a pass that starts after this one,
          // even when a poll pass happens to be on the wire right now.
          await this.refresh({ again: true })
        } finally {
          this.loadingEarlier = false
          this.publish({ loadingEarlier: false })
        }
        return true
      }

      /** Whether a page is being fetched right now. */
      isLoadingEarlier() {
        return this.loadingEarlier
      }

      /**
       * The window value the next state request will ask for. Exposed so the direct
       * test can assert the grown window WITHOUT a browser, the same way the probe
       * convention is asserted.
       */
      requestedTurns() {
        return this.windowTurns
      }

      subscribe(listener) {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      }

      getSnapshot() {
        return this.state
      }

      publish(patch) {
        this.state = { ...this.state, ...patch }
        for (const listener of [...this.listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[dsh-client-ui-trajectory-plus] a subscriber threw:', error)
          }
        }
      }

      attach() {
        if (this.timer === null && typeof window !== 'undefined' && typeof window.setInterval === 'function') {
          this.timer = window.setInterval(() => {
            // A tick is a NUDGE, not a competitor: while a pass is on the wire the
            // next tick is skipped instead of starting a second pass that the first
            // one would then have to be thrown away for. (The state route answers in
            // 5-11s on the live 220 KB session, so a competing tick used to mean no
            // pass ever published at all - see refresh().)
            if (this.pass === null) this.refresh()
          }, REFRESH_INTERVAL_MS)
        }
        this.refresh()
        return () => {
          this.detach()
        }
      }

      detach() {
        if (this.timer !== null && typeof window !== 'undefined') window.clearInterval(this.timer)
        this.timer = null
        this.listeners.clear()
      }

      async probeOne(url) {
        try {
          const response = await fetch(url, { headers: { accept: 'application/json' } })
          return probeStatus(response.status)
        } catch (error) {
          // A sibling that is not mounted is not an error: a rejected fetch, a
          // timeout and a 404 all land in 'absent', and none of them logs.
          return 'absent'
        }
      }

      async probe() {
        const both = await Promise.all([this.probeOne(PROBE_ROUTES.deleteTurn), this.probeOne(PROBE_ROUTES.rerunTurn)])
        return { deleteTurn: both[0], rerunTurn: both[1] }
      }

      /** What the rerun sibling says it can rerun, keyed by turn. */
      async readRerunTargets() {
        try {
          const response = await fetch(PROBE_ROUTES.rerunTurn + formatQuery({ sessionId: this.sessionId }), { headers: { accept: 'application/json' } })
          if (response.ok !== true) return []
          const data = await response.json()
          const replies = data !== null && typeof data === 'object' && Array.isArray(data.replies) ? data.replies : []
          const out = []
          for (const entry of replies) {
            if (entry === null || typeof entry !== 'object') continue
            if (typeof entry.turn !== 'number' || typeof entry.seq !== 'number') continue
            const existing = out.find((item) => item.turn === entry.turn)
            if (existing === undefined) out.push({ turn: entry.turn, seq: entry.seq })
            else if (entry.seq > existing.seq) existing.seq = entry.seq
          }
          return out
        } catch (error) {
          return []
        }
      }

      /**
       * Warm this session once, so the FIRST click on the tab draws cards instead of
       * '正在读取…'. One request, no timer, no retry, and no visible failure: this
       * runs while nobody is looking, which is the whole reason it is allowed to
       * exist outside a mounted view.
       *
       * The cache alone cannot do this. The tab is only rendered while it is
       * selected (dsh-client-ui-conversation: renderSlot('conversation.view', ...,
       * { only: viewId })), so for a session this plugin has not been opened for yet
       * there is nothing to render from - the prefetch is what puts something there.
       *
       * @returns whether a pass was started.
       */
      prefetch() {
        if (this.warmed === true || this.state.payload !== null) return false
        this.warmed = true
        this.refresh()
        return true
      }

      /**
       * Run one pass, or join the pass already on the wire.
       *
       * ONE PASS AT A TIME, and every pass that completes PUBLISHES. Both halves of
       * that sentence are load bearing, because the old shape had neither: it began a
       * competing pass on every tick and threw a pass away whenever a younger one had
       * started - including a pass that had ALREADY fetched its data.
       *
       * The tick is 5s (REFRESH_INTERVAL_MS) and one pass costs a sibling probe round
       * trip plus the state route, which the live 220 KB session answers in 5-11s.
       * Measured in a real browser (2026-10-06, session-94db29c5): the view sat on
       * '正在读取…' for three minutes with 5-11s state responses arriving the whole
       * time, because every pass was younger than the next one and none of them was
       * allowed to publish. That is the bug this method exists to not have.
       *
       * @param options.again - the caller needs a pass that STARTS after this call
       *   (the window just grew, an action was just submitted): join the running
       *   pass, then run exactly one more.
       * @returns a promise for that pass and any follow-up it triggered.
       */
      refresh(options = {}) {
        if (this.pass !== null) {
          if (options.again === true) this.again = true
          return this.pass
        }
        const pass = this.runPasses()
        this.pass = pass
        const done = () => {
          if (this.pass === pass) this.pass = null
        }
        pass.then(done, done)
        return pass
      }

      /** One pass, plus one follow-up when a caller asked for one while it ran. */
      async runPasses() {
        let result = await this.passOnce()
        while (this.again === true) {
          this.again = false
          result = await this.passOnce()
        }
        return result
      }

      /** One round trip: probe the siblings, read the state, publish what came back. */
      async passOnce() {
        const probes = await this.probe()
        const siblings = []
        if (probes.deleteTurn === 'present') siblings.push('deleteTurn')
        if (probes.rerunTurn === 'present') siblings.push('rerunTurn')
        // NOT awaited: the rerun sibling answers by folding the whole session, which
        // costs seconds on a long conversation. Asking it here used to hold the cards
        // back for the whole round trip. The buttons appear on the pass after its
        // answer arrives instead.
        if (probes.rerunTurn === 'present' && this.rerunScanned === false) {
          this.rerunScanned = true
          this.readRerunTargets().then((targets) => {
            this.rerunTargets = targets
            this.refresh({ again: true })
          })
        }
        const query = formatQuery({
          sessionId: this.sessionId,
          siblings: siblings.join(','),
          rerunSeqs: this.rerunTargets.map((entry) => entry.turn + ':' + entry.seq).join(','),
          turns: this.windowTurns,
        })
        let payload = null
        let failure = null
        try {
          const response = await fetch(ROUTE_PREFIX + '/state' + query, { headers: { accept: 'application/json' } })
          if (response.ok !== true) failure = 'HTTP ' + response.status
          else payload = await response.json()
          if (payload !== null && (typeof payload !== 'object' || payload.ok !== true)) {
            payload = null
            failure = 'malformed'
          }
        } catch (error) {
          failure = 'network'
        }
        // CACHE FIRST: a pass that fails REPLACES NOTHING. The reader keeps the cards
        // already on screen and the failure is reported beside them. Emptying the
        // page because one poll failed is the worst of both worlds - the data is gone
        // AND the wait is back - and it is what a reader sees as 'the page reloaded
        // itself'.
        const kept = payload === null ? this.state.payload : payload
        // A failure is a notice FOR A READER. With no view attached there is nobody to
        // notice it, which is what makes a prefetch silent: a failure nobody asked
        // about must not be waiting on screen the moment somebody opens the page.
        this.publish({ payload: kept, failure: this.listeners.size > 0 ? failure : null, loading: false, probes })
      }

      async run(action, turn) {
        if (action === null || typeof action !== 'object') return
        if (action.id === 'refresh') {
          this.publish({ localNotice: null })
          // The reader asked for the newest state, so the answer has to come from a
          // pass that starts after the click.
          return this.refresh({ again: true })
        }
        // The allow-list. An action can only ever reach the two routes their
        // owners publish, whatever the payload says.
        if (POST_TARGETS.includes(action.path) === false) {
          this.publish({ localNotice: { key: 'notice.submit-failed', params: { code: 'refused-target' } } })
          return
        }
        const body = { sessionId: this.sessionId, ...action.params }
        this.publish({ pending: { id: action.id, turn }, localNotice: null })
        let code = null
        try {
          const response = await fetch(action.path, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
          const data = await response.json().catch(() => null)
          if (response.ok !== true || data === null || typeof data !== 'object' || data.ok !== true) {
            code = data !== null && typeof data === 'object' && data.code !== undefined ? String(data.code) : 'HTTP ' + response.status
          }
        } catch (error) {
          code = 'network'
        }
        this.publish({ pending: null, localNotice: code === null ? { key: 'notice.submitted', params: {} } : { key: 'notice.submit-failed', params: { code } } })
        // 'again': the answer to this action has to come from a pass that starts after
        // it, not from one that was already on the wire when the reader clicked.
        await this.refresh({ again: true })
      }
    }

    // --- the view -------------------------------------------------------------

    function textOf(t, entry) {
      if (entry === null || entry === undefined) return ''
      return formatText(t(entry.key), entry.params)
    }

    /**
     * One row of a turn: the lane bar, the kind tag, the text, and the counts of
     * whatever the text is not (images, tool calls). Everything comes from the
     * host's row; nothing is inferred here - a row the host did not send is a row
     * this page does not know about.
     */
    function SurfaceRow(props) {
      const row = props.row
      const t = props.t
      const lane = typeof row.lane === 'number' ? row.lane : rowLaneOf(row.kind)
      const body = []
      // A tool row reads like the official one: the name and its argument summary,
      // then the arrow and the head of the result.
      if (typeof row.tool === 'string' && row.tool !== '') {
        // The preview already LEADS with the tool name (that is how the host builds
        // it), so it is printed as it came and the name is only added when there is
        // no preview at all. Printing both would say 'bash bash List files'.
        const preview = typeof row.toolPreview === 'string' && row.toolPreview !== '' ? row.toolPreview : row.tool
        body.push(react.createElement('p', { key: 'tool', className: 'dshts-rowTool' }, react.createElement('b', null, preview)))
      }
      if (typeof row.text === 'string' && row.text !== '') {
        const text = typeof row.tool === 'string' && row.tool !== '' ? '→ ' + row.text : row.text
        const line = [text]
        if (row.truncated === true && typeof row.chars === 'number') {
          line.push(react.createElement('span', { key: 'more', className: 'dshts-rowArchived', 'data-dshts-more': '1' }, ' ' + formatText(t('row.more'), { n: row.chars })))
        }
        body.push(react.createElement('p', { key: 'text', className: 'dshts-rowText' }, line))
      }
      const children = [
        react.createElement('span', { key: 'lane', className: 'dshts-lane', 'data-dshts-lane': String(lane) }),
        react.createElement('span', { key: 'tag', className: 'dshts-tag' }, t(rowKindKey(row.kind))),
      ]
      if (body.length > 0) children.push(react.createElement('div', { key: 'body', className: 'dshts-rowText' }, body))
      const chips = []
      const nonText = row.nonText !== null && typeof row.nonText === 'object' ? row.nonText : null
      if (nonText !== null) {
        for (const kind of Object.keys(nonText)) {
          chips.push(react.createElement('span', { key: 'nt-' + kind, className: 'dshts-chip', 'data-dshts-nontext': kind }, nonTextLabel(t, kind, nonText[kind])))
        }
      }
      if (row.archived === true) {
        chips.push(react.createElement('span', { key: 'archived', className: 'dshts-chip', 'data-dshts-row-archived': '1' }, t('row.archivedTag')))
      }
      if (chips.length > 0) children.push(react.createElement('span', { key: 'chips', className: 'dshts-chips' }, chips))
      return react.createElement(
        'div',
        {
          className: 'dshts-row2',
          'data-dshts-row': String(row.seq),
          'data-dshts-kind': row.kind,
          'data-dshts-lane': String(lane),
          // Red means the row FAILED, and only a definite true is red: a row the
          // log says nothing about keeps its kind's colour.
          'data-dshts-red': row.error === true ? '1' : '0',
          // The reading anchor of this one line. SurfaceRow is a plain function
          // component, so a ref prop is not forwarded by React; the element is the
          // row's own node and this is where the strip's click lands.
          ref: (node) => {
            if (typeof props.onRef === 'function') props.onRef(node)
          },
        },
        children,
      )
    }

    /**
     * The colour strip: one line per lane, one cell per row, in row order.
     *
     * The cells are the SAME rows the cards render (the host serves one cell per
     * row, in the same order), which is what makes clicking a cell able to land on
     * its line. No time axis, no call axis, no virtual list: three lanes and the
     * cells, and the whole strip is at most one cell per row of the window.
     */
    function LaneStrip(props) {
      const t = props.t
      const strip = props.strip
      const lanes = Array.isArray(strip.lanes) ? strip.lanes : []
      const rows = []
      for (let lane = 0; lane < lanes.length; lane += 1) {
        const cells = []
        const list = Array.isArray(lanes[lane]) ? lanes[lane] : []
        for (const cell of list) {
          cells.push(
            react.createElement('button', {
              key: String(cell.turn) + ':' + String(cell.seq),
              type: 'button',
              className: 'dshts-cell',
              'data-dshts-cell': String(cell.seq),
              'data-dshts-cell-turn': String(cell.turn),
              'data-dshts-kind': cell.kind,
              'data-dshts-lane': String(lane),
              'data-dshts-red': cell.red === true ? '1' : '0',
              'data-dshts-archived': cell.archived === true ? '1' : '0',
              title: t('strip.jump') + ' · ' + t(rowKindKey(cell.kind)) + ' · #' + String(cell.seq),
              'aria-label': t('strip.jump') + ' ' + String(cell.turn),
              onClick: () => {
                props.onJump(cell)
              },
            }),
          )
        }
        rows.push(react.createElement('div', { key: 'lane-' + String(lane), className: 'dshts-laneRow', 'data-dshts-lane-row': String(lane) }, cells))
      }
      const kinds = strip.kinds !== null && typeof strip.kinds === 'object' ? Object.keys(strip.kinds) : []
      const key = []
      for (const kind of kinds) {
        key.push(
          react.createElement(
            'span',
            { key: 'k-' + kind, className: 'dshts-stripKey' },
            react.createElement('span', { className: 'dshts-swatch', 'data-dshts-swatch': kind, style: { background: cellColor(kind) } }),
            t(rowKindKey(kind)) + ' ' + String(strip.kinds[kind]),
          ),
        )
      }
      return react.createElement(
        'div',
        { className: 'dshts-strip', 'data-dshts-strip': '1' },
        rows,
        react.createElement(
          'div',
          { className: 'dshts-stripFoot' },
          react.createElement('span', null, t('strip.title')),
          react.createElement('span', { 'data-dshts-strip-total': String(strip.total) }, formatText(t('strip.legend'), { n: strip.total })),
          key,
        ),
      )
    }

    /** The fill one kind falls back to when the CSS variables are absent. */
    function cellColor(kind) {
      if (kind === 'assistant') return '#4d6bfe'
      if (kind === 'compacted') return '#b07d2b'
      if (kind === 'tool' || kind === 'tool-result') return '#20a162'
      return '#8a8f98'
    }

    function SurfaceCard(props) {
      const card = props.card
      const t = props.t
      const pending = props.pending
      const badges = []
      for (const badge of card.badges) {
        badges.push(react.createElement('span', { key: badge.key, className: 'dshts-badge', 'data-dshts-badge': badge.key }, textOf(t, badge)))
      }
      const actions = []
      for (const action of card.actions) {
        if (action.visible !== true) continue
        actions.push(
          react.createElement(
            'button',
            {
              key: action.id,
              type: 'button',
              className: 'dshts-action',
              disabled: action.enabled !== true || pending !== null,
              title: t('reason.' + action.reason),
              'data-dshts-action': action.id,
              'data-dshts-reason': action.reason,
              onClick: () => {
                props.onAction(action, card.turn)
              },
            },
            t(action.key),
          ),
        )
      }
      const body = []
      // The content below a compaction is the ORIGINAL, restored from the log. It
      // says so, because presenting it as the model's current context would be a
      // different (and false) claim.
      if (card.archived === true) {
        body.push(react.createElement('p', { key: 'archived', className: 'dshts-archived', 'data-dshts-archived': '1' }, t('card.archived')))
      }
      // THE DETAIL ROWS: every node of this turn, in seq order, instead of only its
      // first question and last answer. The host decides which nodes those are and
      // what each row says; this page only draws them.
      const rows = Array.isArray(card.rows) ? card.rows : null
      if (rows !== null) {
        const list = []
        for (const row of rows) {
          list.push(
            react.createElement(SurfaceRow, {
              key: String(row.seq),
              row,
              t,
              onRef: (node) => {
                if (typeof props.rowRef === 'function') props.rowRef(row.seq, node)
              },
            }),
          )
        }
        if (list.length > 0) body.push(react.createElement('div', { key: 'rows', className: 'dshts-rows' }, list))
      }
      if (rows !== null && rows.length === 0) {
        let key = 'card.none'
        if (card.nodes === 0 && card.suppressed > 0) key = card.removedBy === 'compaction' ? 'card.compactedOnly' : 'card.replacedOnly'
        else if (card.resumes > 0) key = 'card.injectedOnly'
        body.push(react.createElement('p', { key: 'none', className: 'dshts-none' }, t(key)))
      }
      // The budget is per turn, and a reader must be able to tell a clipped card
      // from a complete one.
      if (card.rowsClipped === true) {
        body.push(react.createElement('p', { key: 'rowsClipped', className: 'dshts-archived', 'data-dshts-rows-clipped': '1' }, formatText(t('row.clipped'), { n: Math.max(0, card.nodes - rows.length) })))
      }
      const story = []
      if (card.retries > 0) story.push(textOf(t, { key: 'story.retried', params: { n: card.retries } }))
      const suppression = Array.isArray(card.suppression) ? card.suppression : []
      if (suppression.length > 0) {
        for (const entry of suppression) story.push(textOf(t, { key: 'story.' + replacementKeyOf(entry.author), params: { n: entry.n } }))
      } else if (card.suppressed > 0) story.push(textOf(t, { key: 'story.replaced', params: { n: card.suppressed } }))
      if (card.ends.length > 1) story.push(textOf(t, { key: 'story.ends', params: { n: card.ends.length } }))
      const children = [
        react.createElement(
          'header',
          { key: 'head', className: 'dshts-cardHead' },
          react.createElement('span', { className: 'dshts-turn' }, formatText(t('card.title'), { n: card.turn })),
          badges,
          react.createElement('span', { className: 'dshts-duration' }, durationLabel(t, card.durationMs)),
        ),
        react.createElement('div', { key: 'body', className: 'dshts-body' }, body),
      ]
      if (story.length > 0) children.push(react.createElement('p', { key: 'story', className: 'dshts-story' }, t('card.story') + ' · ' + story.join(' · ')))
      if (actions.length > 0) children.push(react.createElement('footer', { key: 'actions', className: 'dshts-actions' }, actions))
      return react.createElement(
        'article',
        {
          className: 'dshts-card',
          // The turn's own anchor: the fallback landing place for a strip cell
          // whose row is not in the document.
          ref: (node) => {
            if (typeof props.cardRef === 'function') props.cardRef(node)
          },
          'data-dshts-turn': String(card.turn),
          'data-dshts-status': card.status,
          'data-dshts-rowless': card.rowless === true ? '1' : '0',
          // Who retired this turn's content, and whether what is shown below is the
          // original restored from the log. Both are the host's answer.
          'data-dshts-removed-by': typeof card.removedBy === 'string' ? card.removedBy : '',
          'data-dshts-archived': card.archived === true ? '1' : '0',
        },
        children,
      )
    }

    function SurfaceView(props) {
      const t = props.t
      const controller = props.controller
      const subscribe = (listener) => controller.subscribe(listener)
      const snapshot = () => controller.getSnapshot()
      const state = react.useSyncExternalStore(subscribe, snapshot, snapshot)
      react.useEffect(() => controller.attach(), [controller])
      const payload = state.payload
      // Chronological order puts the newest card last, so the view follows it.
      // A stub rendering host has no layout, hence the defensive test.
      const root = react.useRef(null)
      const cardCount = payload !== null && Array.isArray(payload.turns) ? payload.turns.length : 0
      const oldestTurn = payload === null || payload.oldestTurn === undefined ? null : payload.oldestTurn
      // Whether the reader was at the tail. A ref, not state: the decision to
      // follow must be taken from the position BEFORE the new cards arrived, and a
      // scroll handler that re-rendered the whole page would be its own bug.
      const followsTail = react.useRef(true)
      const scrolledOnce = react.useRef(false)
      // The reading position captured before an older page is prepended, so the
      // page can be restored instead of yanked: { oldestTurn, scrollTop, scrollHeight }.
      const olderAnchor = react.useRef(null)
      // Where each card and each row is, keyed 't<turn>' and 's<seq>'. Filled by the
      // ref props above; read by the strip's click. A ref map, not state.
      const rowRefs = react.useRef(new Map())
      // The one row just jumped to, so the reader can see which line it was.
      const highlighted = react.useRef(null)

      /**
       * Jump to one strip cell: its row when it is in the document, its card
       * otherwise. The turn is in the window by construction (every cell came from
       * a card), so a cell whose row was clipped still lands somewhere real.
       */
      const jumpTo = (cell) => {
        const map = rowRefs.current
        const node = map.get('s' + String(cell.seq)) || map.get('t' + String(cell.turn)) || null
        if (node === null) return
        if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' })
        else if (typeof node.scrollTop === 'number') node.scrollTop = 0
        // A click is a deliberate move: the reader is now reading history, so the
        // tail must not follow until they scroll back down themselves.
        followsTail.current = false
        const previous = highlighted.current
        if (previous !== null && previous.classList !== undefined && typeof previous.classList.remove === 'function') {
          previous.classList.remove('dshts-primary')
        }
        if (node.classList !== undefined && typeof node.classList.add === 'function') node.classList.add('dshts-primary')
        highlighted.current = node
      }

      const requestOlder = () => {
        // The guard is the controller's, checked before the anchor is touched: a
        // refused call leaves no trace.
        if (controller.isLoadingEarlier() === true) return
        const current = controller.getSnapshot()
        if (current.payload === null || current.payload.hasOlder !== true) return
        const node = root.current
        if (node !== null && node !== undefined && typeof node.scrollHeight === 'number') {
          olderAnchor.current = {
            oldestTurn: current.payload.oldestTurn === undefined ? null : current.payload.oldestTurn,
            scrollTop: node.scrollTop,
            scrollHeight: node.scrollHeight,
          }
        }
        controller.loadEarlier()
      }

      react.useEffect(() => {
        const node = root.current
        if (node === null || node === undefined || typeof node.scrollHeight !== 'number') return
        const anchor = olderAnchor.current
        if (anchor !== null && anchor.oldestTurn !== oldestTurn) {
          // Older cards were prepended: hold the reader's place, and never follow
          // the tail after that until they scroll back down themselves.
          node.scrollTop = anchor.scrollTop + node.scrollHeight - anchor.scrollHeight
          olderAnchor.current = null
          followsTail.current = false
          return
        }
        if (scrolledOnce.current === false) {
          if (payload === null) return
          scrolledOnce.current = true
          followsTail.current = true
          node.scrollTop = node.scrollHeight
          return
        }
        // THE CONDITIONAL FOLLOW: only a reader who was already at the tail is
        // moved. Someone reading history is never dragged back.
        if (followsTail.current === false) return
        node.scrollTop = node.scrollHeight
      }, [oldestTurn, cardCount])
      const notices = []
      if (state.failure !== null) {
        notices.push(react.createElement('div', { key: 'failure', className: 'dshts-notice', 'data-dshts-notice': 'failure' }, formatText(t('notice.load-failed'), { code: state.failure })))
      }
      if (state.localNotice !== null) {
        notices.push(react.createElement('div', { key: 'local', className: 'dshts-notice', 'data-dshts-notice': 'local' }, textOf(t, state.localNotice)))
      }
      if (payload !== null && Array.isArray(payload.notices)) {
        for (const notice of payload.notices) {
          notices.push(react.createElement('div', { key: notice.key, className: 'dshts-notice', 'data-dshts-notice': notice.key }, textOf(t, notice)))
        }
      }
      // THE CACHE-FIRST GATE. A payload this controller already holds is drawn on
      // the FIRST paint after the view is mounted again - switching tabs replaces
      // the view, never the data (the controller is the session's, not the view's).
      // '正在读取…' therefore means exactly one thing: there is nothing at all to
      // draw yet - no cached payload, no prefetched one, and no failure to report.
      // It must never mean 'a refresh is on its way'.
      if (payload === null && state.failure === null) {
        notices.push(react.createElement('div', { key: 'loading', className: 'dshts-notice', 'data-dshts-notice': 'loading' }, t('notice.loading')))
      }
      // The 'load earlier' row, above every card, and ONLY when the host says the
      // window clipped the session. hasOlder is the host's answer, never guessed
      // from the card count: a session that happens to have exactly one page left
      // must not offer a row that loads nothing.
      const historyRow = []
      if (payload !== null && payload.hasOlder === true) {
        const busy = state.loadingEarlier === true
        historyRow.push(
          react.createElement(
            'button',
            {
              key: 'older',
              type: 'button',
              // Both class names, like the official row (historyLoadRow +
              // historyLoadButton): one clickable line, not a bare link.
              className: 'dshts-historyLoadRow dshts-historyLoadButton',
              style: { height: HISTORY_LOAD_ROW_HEIGHT_PX },
              disabled: busy,
              title: t('history.clickToLoadEarlier'),
              'aria-label': busy ? t('history.loadingEarlier') : t('history.loadEarlier'),
              'data-dshts-load-earlier': '1',
              'data-dshts-loading-earlier': busy ? '1' : '0',
              'data-dshts-row-height': String(HISTORY_LOAD_ROW_HEIGHT_PX),
              onClick: () => {
                requestOlder()
              },
            },
            busy ? t('history.loadingEarlier') : t('history.loadEarlier'),
          ),
        )
      }
      // The strip, above 'load earlier', one line per lane. Only when the host sent
      // cells: an empty strip is noise, not a state.
      const strip = []
      const stripData = payload === null || payload.strip === undefined || payload.strip === null ? null : payload.strip
      if (stripData !== null && Array.isArray(stripData.cells) && stripData.cells.length > 0) {
        strip.push(react.createElement(LaneStrip, { key: 'strip', strip: stripData, t, onJump: jumpTo }))
      }
      const cards = []
      if (payload !== null && Array.isArray(payload.turns)) {
        // Chronological, like the conversation and the trajectory: the oldest turn
        // at the top, the newest at the bottom. The container is scrolled to the
        // bottom below so the newest card is what you see when you open the page.
        for (const card of payload.turns) {
          cards.push(
            react.createElement(SurfaceCard, {
              key: String(card.turn),
              card,
              t,
              pending: state.pending,
              onAction: (action, turn) => {
                controller.run(action, turn)
              },
              // The reading anchor is recorded per card and per row, so a cell in
              // the strip can land on a turn, and on a turn's line when the line is
              // there. A ref, never state: scrolling must not re-render the page.
              cardRef: (node) => {
                if (node === null || node === undefined) rowRefs.current.delete('t' + String(card.turn))
                else rowRefs.current.set('t' + String(card.turn), node)
              },
              rowRef: (seq, node) => {
                if (node === null || node === undefined) rowRefs.current.delete('s' + String(seq))
                else rowRefs.current.set('s' + String(seq), node)
              },
            }),
          )
        }
      }
      return react.createElement(
        'div',
        {
          className: 'dshts-root',
          'data-dshts-view': 'surface',
          ref: root,
          // One scroll handler does both jobs the official view's does: it records
          // whether the reader is at the tail, and it asks for the next page when
          // the top band is entered. loadEarlier is re-entrancy guarded, so the
          // dozens of events a scroll fires can only ever produce one request.
          onScroll: (event) => {
            const node = event !== null && event !== undefined && event.currentTarget !== undefined ? event.currentTarget : root.current
            followsTail.current = isNearBottom(node, BOTTOM_FOLLOW_THRESHOLD_PX)
            if (isNearTop(node, OLDER_LOAD_THRESHOLD_PX) === true) requestOlder()
          },
        },
        [react.createElement('div', { key: 'hint', className: 'dshts-head' }, t('tabs.hint'))].concat(strip, notices, historyRow, cards),
      )
    }

    // --- plugin ---------------------------------------------------------------

    /**
     * Register the tab.
     *
     * Kept at module scope rather than inside apply(), so a test can hand it a
     * stub slot service and assert the exact registration object the platform
     * reads - which is the whole premise of this plugin.
     *
     * Slot contract, from the shipped platform source:
     *   ctx.slots.inject('conversation.view', () => ctx.slots.register({...}, C))
     * 'conversation.view' is declared by @deepseek-ai/dsh-client-ui-conversation as
     * { kind: 'list', scope: 'session' }, and the conversation skeleton draws one
     * tab per entry of slots.entries('conversation.view'). The chat view is order
     * 0, the official trajectory view order 10, this one 20.
     */
    function registerView(slots, controllerFor, t) {
      slots.inject('conversation.view', () =>
        slots.register(
          {
            name: 'conversation.view',
            id: VIEW_ID,
            order: VIEW_ORDER,
            locale: NS,
            label: () => t('view.surface'),
            inject: (sessionId) => ({ controller: controllerFor(sessionId) }),
          },
          SurfaceView,
        ),
      )
    }

    /**
     * Warm the session the conversation area is showing, once per session.
     *
     * `source` is the platform's own current-session binding source
     * (ctx.uiSession.current). Its snapshot is the binding the renderer hands a
     * session-scoped view, and that binding's `key` is the session id - the same
     * string this plugin keys its controllers by. Asking the platform is the point:
     * it is the one place that knows which conversation is on screen, and it needs
     * no view of ours to be mounted (that is exactly the state a prefetch has to
     * run in).
     *
     * Nothing here is required. A platform without the service, or with a changed
     * shape, gets no prefetch and still works - one round trip later, on the mount
     * that fetches for itself.
     *
     * @param source - the current-session binding source, or null.
     * @param controllerFor - session id -> controller (the plugin's own cache).
     * @returns an unsubscribe for the session changes, or null when there is
     *   nothing this plugin is allowed to subscribe to.
     */
    function warmMainSession(source, controllerFor) {
      if (source === null || source === undefined) return null
      if (typeof source.getSnapshot !== 'function' || typeof source.subscribe !== 'function') return null
      const warm = () => {
        let binding = null
        try {
          binding = source.getSnapshot()
        } catch (error) {
          // A binding source that throws is a platform this plugin cannot read: no
          // prefetch, no complaint, no console noise on a page it does not own.
          binding = null
        }
        const sessionId = binding !== null && typeof binding === 'object' && typeof binding.key === 'string' ? binding.key : ''
        if (sessionId === '') return
        controllerFor(sessionId).prefetch()
      }
      warm()
      const unsubscribe = source.subscribe(warm)
      return typeof unsubscribe === 'function' ? unsubscribe : null
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ': dictionaries')
      const t = ctx.locale.bind(NS)

      const controllers = new Map()
      const controllerFor = (sessionId) => {
        let controller = controllers.get(sessionId)
        if (controller === undefined) {
          controller = new SurfaceController(sessionId)
          controllers.set(sessionId, controller)
        }
        return controller
      }
      ctx.effect(
        () => () => {
          for (const controller of controllers.values()) controller.detach()
          controllers.clear()
        },
        NS + ': per-session controllers',
      )

      // THE PREFETCH. One pass per session, the moment the platform says which
      // session the conversation area is showing, and no timer at all: the poll lives
      // in attach()/detach() and exists only while this plugin's view is on screen,
      // so with the tab closed this adds exactly one request per session - not a
      // loop, not a heartbeat, and nothing at all when the service is absent.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['uiSession'], (scope) => {
          const service = scope.uiSession === undefined || scope.uiSession === null ? null : scope.uiSession
          const stop = warmMainSession(service === null ? null : service.current, controllerFor)
          if (stop !== null) ctx.effect(() => stop, NS + ': session prefetch')
        })
      }

      // The direct path is the ordinary one, because the inject list in
      // package.json loads @deepseek-ai/dsh-client-ui-conversation (and with it the
      // slots service) before this plugin. The fallback covers a composition where
      // the service arrives later; slots.inject then waits for the declaration.
      if (ctx.slots !== undefined && ctx.slots !== null) registerView(ctx.slots, controllerFor, t)
      else if (typeof ctx.inject === 'function') ctx.inject(['slots'], (scope) => registerView(scope.slots, controllerFor, t))
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.version = VERSION
    // Exported for the unit tests, which run this file against a stub browser.
    exports.__test = {
      NS,
      VERSION,
      ROUTE_PREFIX,
      VIEW_ID,
      VIEW_ORDER,
      PROBE_ROUTES,
      PROXY_ROUTES,
      POST_TARGETS,
      REFRESH_INTERVAL_MS,
      // The official paging numbers and the two scroll conditions they drive.
      HISTORY_PAGE_NODES,
      BOTTOM_FOLLOW_THRESHOLD_PX,
      OLDER_LOAD_THRESHOLD_PX,
      HISTORY_LOAD_ROW_HEIGHT_PX,
      VIRTUALIZATION_THRESHOLD,
      isNearBottom,
      isNearTop,
      replacementKeyOf,
      // The rows and the strip (tasks D and E).
      rowLaneOf,
      rowKindKey,
      nonTextLabel,
      cellColor,
      SurfaceRow,
      LaneStrip,
      zh,
      en,
      formatText,
      formatQuery,
      probeStatus,
      durationLabel,
      SurfaceController,
      SurfaceView,
      SurfaceCard,
      registerView,
      warmMainSession,
    }
    return module.exports
  },
})
