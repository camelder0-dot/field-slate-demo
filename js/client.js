// Data layer for the display and control pages.
// - Server mode: state lives on the Field Slate server, updates stream in live (SSE).
//   If the connection drops, the page keeps running on its last copy and pushes
//   pending edits when it reconnects.
// - Standalone mode: no server reachable (or ?local=1). State lives in this
//   browser's storage; tabs on the same device stay in sync.
import { normalizeState, emptyState } from './model.js';
import { sampleState } from './sample.js';

const LOCAL_KEY = 'fieldslate:local';
const CACHE_KEY = 'fieldslate:cache';
const PIN_KEY = 'fieldslate:pin';
const MODE_KEY = 'fieldslate:mode';

const safe = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode / quota */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

async function fetchWithTimeout(url, opts = {}, ms = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store' }); } finally { clearTimeout(t); }
}

export function getPreferredMode() { return safe.get(MODE_KEY) || 'auto'; }
export function setPreferredMode(m) { if (m === 'auto') safe.del(MODE_KEY); else safe.set(MODE_KEY, m); }

export function createClient() {
  const listeners = new Set();
  const statusListeners = new Set();
  let state = normalizeState(parse(safe.get(CACHE_KEY)) || emptyState());
  let mode = 'local';
  let status = 'connecting';
  let pending = false;
  let health = null;
  let es = null;
  let pushing = null;

  const emit = () => { for (const fn of listeners) fn(state); };
  const setStatus = (s) => { status = s; for (const fn of statusListeners) fn({ status, mode, pending, health }); };

  function accept(next) {
    state = normalizeState(next);
    safe.set(mode === 'server' ? CACHE_KEY : LOCAL_KEY, JSON.stringify(state));
    emit();
  }

  function connectStream() {
    if (es) es.close();
    es = new EventSource('/api/stream');
    es.addEventListener('state', (ev) => {
      const incoming = parse(ev.data);
      if (!incoming) return;
      if (pending) { push(); return; } // our offline edits win; push them now
      if (incoming.rev >= state.rev || incoming.rev === 0) accept(incoming);
    });
    es.onopen = () => setStatus('live');
    es.onerror = () => setStatus('offline'); // EventSource retries on its own
  }

  async function push() {
    if (mode !== 'server') return;
    if (pushing) { pending = true; return pushing; }
    pending = false;
    pushing = (async () => {
      try {
        const res = await fetchWithTimeout('/api/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Slate-Pin': safe.get(PIN_KEY) || '' },
          body: JSON.stringify({ state }),
        }, 8000);
        if (res.status === 401) {
          pending = true;
          setStatus('locked');
          return;
        }
        if (!res.ok) throw new Error('push failed');
        const saved = await res.json();
        if (!pending) accept(saved);
        setStatus('live');
      } catch {
        pending = true;
        setStatus('offline');
      } finally {
        pushing = null;
        if (pending && status === 'live') push();
      }
    })();
    return pushing;
  }

  return {
    get state() { return state; },
    get mode() { return mode; },
    get status() { return status; },
    get health() { return health; },

    async init() {
      const forced = new URLSearchParams(location.search).get('local') === '1' || getPreferredMode() === 'local';
      if (!forced && location.protocol.startsWith('http')) {
        try {
          const res = await fetchWithTimeout('/api/health');
          const body = res.ok ? await res.json() : null;
          if (body?.app === 'field-slate') { health = body; mode = 'server'; }
        } catch { /* no server → standalone */ }
      }
      if (mode === 'server') {
        try {
          const res = await fetchWithTimeout('/api/state', {}, 5000);
          if (res.ok) accept(await res.json());
        } catch { /* stream will deliver it */ }
        connectStream();
        setInterval(() => { if (pending && status !== 'locked') push(); }, 5000);
      } else {
        const saved = parse(safe.get(LOCAL_KEY));
        // Opened from a static link (no server) for the first time: start with the demo show.
        // An untouched demo is rebuilt so its times are always around "now".
        const stale = saved?.demo === true && Date.now() - new Date(saved.updatedAt).getTime() > 30 * 60000;
        const fresh = !saved || stale;
        state = normalizeState(fresh ? (forced && !saved ? emptyState() : sampleState()) : saved);
        if (fresh) safe.set(LOCAL_KEY, JSON.stringify(state));
        window.addEventListener('storage', (e) => {
          if (e.key === LOCAL_KEY && e.newValue) { state = normalizeState(parse(e.newValue)); emit(); }
        });
        setStatus('local');
        emit();
      }
      return this;
    },

    subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    onStatus(fn) { statusListeners.add(fn); fn({ status, mode, pending, health }); return () => statusListeners.delete(fn); },

    /** Apply a change: update(draft => { draft.live.offsetMin += 1 }) */
    update(mutator) {
      const draft = structuredClone(state);
      delete draft.demo; // the first real edit makes the demo the user's own show
      mutator(draft);
      const next = normalizeState(draft);
      if (mode === 'local') next.rev = state.rev + 1;
      next.updatedAt = new Date().toISOString();
      accept(next);
      if (mode === 'server') push();
    },

    replaceAll(doc) { this.update((d) => { Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, normalizeState(doc), { rev: state.rev }); }); },

    // Admin PIN (server mode only)
    getPin: () => safe.get(PIN_KEY) || '',
    async tryPin(pin) {
      const res = await fetchWithTimeout('/api/pin/check', { method: 'POST', headers: { 'X-Slate-Pin': pin } });
      if (res.ok) { safe.set(PIN_KEY, pin); setStatus('live'); if (pending) push(); return true; }
      return false;
    },
    async setPin(pin) {
      const res = await fetchWithTimeout('/api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Slate-Pin': safe.get(PIN_KEY) || '' }, body: JSON.stringify({ pin }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not set PIN');
      if (pin) safe.set(PIN_KEY, pin); else safe.del(PIN_KEY);
      health = { ...health, pinRequired: !!pin };
    },

    /** JSON call to the server API with the admin PIN attached. */
    async api(path, { method = 'GET', body } = {}) {
      const res = await fetchWithTimeout(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Slate-Pin': safe.get(PIN_KEY) || '' },
        body: body ? JSON.stringify(body) : undefined,
      }, 20000);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
    },
  };
}
