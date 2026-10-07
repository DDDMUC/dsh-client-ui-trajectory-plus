// A deliberately small browser stub, sized to exactly what the view half uses.
//
// It is NOT a browser: it implements the client-module loader protocol, the React
// hooks the component tree needs, and a fetch recorder, and it throws on anything
// else rather than silently stubbing it away. A stub that quietly accepts
// everything would turn 'the view stopped rendering' into 'the test still passes'.
//
// CLIENT_SOURCE is null in the shipped file, where loadClient() reads
// ../src/client.js from disk. A harness without a writable filesystem replaces that
// ONE line.
export const CLIENT_SOURCE = null

import { readFileSync } from 'node:fs'

// THE TWO FIDELITY RULES THIS STUB KEEPS, because a view that behaves differently
// under test than in a browser is worse than an untested one:
//
//   * hooks get IDENTITY. One slot table per component, per environment, reset at
//     the start of every component call. With a fresh { current } handed out per
//     render, useRef could never remember anything - and 'was the reader at the
//     tail?' would be untestable rather than wrong.
//   * an effect with a dependency array runs only when that array CHANGES, using
//     Object.is, exactly as React decides it. Running effects on every render
//     would hide a dependency the component forgot (and would fire the view's
//     attach() once per render instead of once).
//
// Everything above is per loadClient() call, so two environments never share a
// component's hooks.

function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false
  if (previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

function defaultFetch() {
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
}

export function loadClient(options = {}) {
  const calls = []
  const slotEntries = []
  const injectKeys = []
  const intervals = []
  const dicts = {}
  const hookSlots = new Map()
  // Every service list this plugin asks the context for, in order, plus the
  // requests that are still waiting for their service. A plugin that asks for a
  // service it never gets must keep working, so a request stays pending forever
  // unless the test installs it.
  const injectRequests = []
  const pendingInject = []
  let activeSlots = null
  let registered = null
  let lateInstall = null

  const nextSlot = () => {
    const index = activeSlots.index
    activeSlots.index += 1
    return index
  }

  const slotOrDefault = (build) => {
    if (activeSlots === null) return build()
    const index = nextSlot()
    if (activeSlots.refs[index] === undefined) activeSlots.refs[index] = build()
    return activeSlots.refs[index]
  }

  const hooks = {
    createElement: (tag, props, ...children) => ({ tag, props: props === null || props === undefined ? {} : props, children }),
    useEffect: (fn, deps) => {
      if (activeSlots === null) {
        fn()
        return
      }
      const index = nextSlot()
      const previous = activeSlots.refs[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return
      activeSlots.refs[index] = { deps }
      fn()
    },
    useMemo: (fn) => {
      if (activeSlots !== null) nextSlot()
      return fn()
    },
    useRef: (value) => slotOrDefault(() => ({ current: value })),
    // A slot, not a tuple, so a second render returns the same box. Nothing in
    // this suite calls a setter; the stub renders from props.
    useState: (value) => {
      const box = slotOrDefault(() => ({ value, set: () => {} }))
      return [box.value, box.set]
    },
    useCallback: (fn) => {
      if (activeSlots !== null) nextSlot()
      return fn
    },
    useSyncExternalStore: (subscribe, getSnapshot) => {
      if (activeSlots !== null) nextSlot()
      return getSnapshot()
    },
  }

  const fetchStub = async (url, init) => {
    calls.push({ url, init: init === undefined ? {} : init })
    return (options.fetch === undefined ? defaultFetch : options.fetch)(url, init)
  }
  const window = {
    __ModuleLoader__: {
      load: (spec) => {
        registered = spec
      },
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms })
      return intervals.length
    },
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  const document = {
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, textContent: '' }),
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const require = (id) => {
    if (id === 'react') return hooks
    throw new Error('dom-stub: unexpected require ' + id)
  }

  // Render one function component inside its own hook slot table. Everything the
  // suite renders goes through here, so a component's refs survive exactly as
  // long as the component does.
  const callComponent = (component, props) => {
    const previous = activeSlots
    let table = hookSlots.get(component)
    if (table === undefined) {
      table = { index: 0, refs: [] }
      hookSlots.set(component, table)
    }
    table.index = 0
    activeSlots = table
    try {
      return component(props)
    } finally {
      activeSlots = previous
    }
  }

  // The shipped file reads the real bundle; an in-memory harness that has no
  // filesystem replaces CLIENT_SOURCE instead and this read never runs.
  const source = CLIENT_SOURCE === null ? readFileSync(new URL('../src/client.js', import.meta.url), 'utf8') : CLIENT_SOURCE
  const factory = new Function('window', 'document', 'fetch', 'require', 'module', 'exports', source + ';return window;')
  factory(window, document, fetchStub, require, {}, {})
  if (registered === null) throw new Error('the client bundle did not register with __ModuleLoader__')

  const api = registered.factory(require)
  const buildSlots = () => ({
    inject: (key, callback) => {
      injectKeys.push(key)
      callback()
    },
    register: (entryOptions, component) => {
      slotEntries.push({ options: entryOptions, component })
      return () => {}
    },
  })
  const ctx = {
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    inject: (services, callback) => {
      injectRequests.push([...services])
      if (services.includes('slots')) lateInstall = () => callback({ slots: buildSlots() })
      else pendingInject.push({ services, callback })
    },
    slots: options.late === true ? undefined : buildSlots(),
    locale: {
      register: (ns, table) => {
        dicts[ns] = table
      },
      bind: (ns) => (key) => {
        const table = dicts[ns]
        return table !== undefined && table.zh !== undefined && table.zh[key] !== undefined ? table.zh[key] : key
      },
    },
  }
  const translate = (lang, key) => {
    const table = dicts[api.__test.NS]
    return table === undefined || table[lang] === undefined || table[lang][key] === undefined ? key : table[lang][key]
  }
  return {
    api,
    registered,
    calls,
    slotEntries,
    injectKeys,
    intervals,
    dicts,
    ctx,
    translate,
    runApply: () => {
      api.apply(ctx)
      return slotEntries
    },
    installSlots: () => {
      if (lateInstall !== null) {
        lateInstall()
        lateInstall = null
      }
      return slotEntries
    },
    callComponent,
    injectRequests,
    /**
     * Fire every pending service request the given scope can satisfy - the cordis
     * behavior this plugin's prefetch depends on, in one line. A scope missing a
     * requested service leaves its request pending, which is what 'the platform
     * does not have it' looks like from inside the plugin.
     *
     * @returns the service lists that were fired.
     */
    installServices: (scope) => {
      const fired = []
      for (const request of [...pendingInject]) {
        const ready = request.services.every((name) => scope[name] !== undefined && scope[name] !== null)
        if (ready === false) continue
        pendingInject.splice(pendingInject.indexOf(request), 1)
        request.callback(scope)
        fired.push([...request.services])
      }
      return fired
    },
    render: (component, controller, lang) => callComponent(component, { t: (key) => translate(lang === undefined ? 'zh' : lang, key), controller }),
    findAll: (node, tag) => {
      const out = []
      const walk = (value) => {
        if (value === null || value === undefined || typeof value !== 'object') return
        if (Array.isArray(value)) {
          for (const item of value) walk(item)
          return
        }
        // React would call a function component; so does this, through the same
        // hook slot table, so a walked subtree sees the component's own refs.
        if (typeof value.tag === 'function') {
          walk(callComponent(value.tag, value.props))
          return
        }
        if (typeof value.tag === 'string' && value.tag.toLowerCase() === tag) out.push(value)
        if (Array.isArray(value.children)) for (const child of value.children) walk(child)
      }
      walk(node)
      return out
    },
  }
}
