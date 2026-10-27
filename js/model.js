// Field Slate data model + timing logic.
// Shared by the browser (display/admin), the Node server and the desktop app,
// so it must stay dependency-free and environment-neutral.

export const SCHEMA = 1;

export const DEFAULT_SETTINGS = {
  theme: 'dark',            // 'dark' | 'light'
  accent: '#35E0FF',
  fontScale: 1,             // 0.7 – 1.5
  clock24: false,
  showSeconds: true,
  showClock: true,
  showEventName: true,
  showRound: true,
  showCountdown: true,
  showTime: true,
  showHometown: true,
  showDivision: true,
  showNotes: true,
  maxNotes: 4,
  onDeckCount: 3,           // 0 hides the on-deck rail
  showOnDeckHometown: true,
  showProgress: true,       // "7 / 32" position in the round
  includeBreaks: true,
  advanceAfterMin: 10,      // featured band flips to the next one this long after its start
  showGrid: true,           // subtle background grid
};

export const DEFAULT_LIVE = {
  mode: 'auto',             // 'auto' follows the clock, 'manual' pins a performance
  manualId: null,
  offsetMin: 0,             // + means the show is running behind
  hold: false,              // show the hold card instead of the slate
  message: '',              // shown on the hold card (or as a banner when not holding)
  banner: false,
};

export function uid(prefix = '') {
  const r = Math.random().toString(36).slice(2, 8);
  const t = Date.now().toString(36).slice(-4);
  return prefix + t + r;
}

export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function emptyState() {
  const roundId = uid('r_');
  return {
    schema: SCHEMA,
    rev: 0,
    updatedAt: new Date().toISOString(),
    event: { name: '', venue: '' },
    rounds: [{ id: roundId, name: 'Prelims', date: todayISO(), cs: null }],
    activeRoundId: roundId,
    bands: {},
    performances: [],
    live: { ...DEFAULT_LIVE },
    settings: { ...DEFAULT_SETTINGS },
    sync: { autoSync: false, intervalSec: 120, lastSync: null, lastError: null },
  };
}

// Fill in anything missing so older/foreign documents never crash the UI.
export function normalizeState(input) {
  const base = emptyState();
  if (!input || typeof input !== 'object') return base;
  const s = { ...base, ...input };
  s.event = { ...base.event, ...(input.event || {}) };
  s.settings = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
  s.live = { ...DEFAULT_LIVE, ...(input.live || {}) };
  s.sync = { ...base.sync, ...(input.sync || {}) };
  s.rounds = Array.isArray(input.rounds) && input.rounds.length ? input.rounds.map((r) => ({
    id: r.id || uid('r_'), name: r.name || 'Round', date: r.date || todayISO(), cs: r.cs || null,
  })) : base.rounds;
  if (!s.rounds.some((r) => r.id === s.activeRoundId)) s.activeRoundId = s.rounds[0].id;
  s.bands = {};
  for (const [id, b] of Object.entries(input.bands || {})) {
    s.bands[id] = {
      id, name: b.name || 'Unnamed band', hometown: b.hometown || '', csGroupId: b.csGroupId ?? null,
      notes: Array.isArray(b.notes) ? b.notes.filter((n) => n && n.text).map((n) => ({
        id: n.id || uid('n_'), text: String(n.text), pinned: !!n.pinned,
      })) : [],
    };
  }
  s.performances = (Array.isArray(input.performances) ? input.performances : [])
    .filter((p) => p && p.roundId)
    .map((p) => ({
      id: p.id || uid('p_'),
      roundId: p.roundId,
      kind: p.kind === 'break' ? 'break' : 'band',
      bandId: p.bandId || null,
      label: p.label || '',
      time: normalizeClock(p.time) || '00:00',
      division: p.division || '',
      csId: p.csId ?? null,
    }))
    .filter((p) => p.kind === 'break' || s.bands[p.bandId]);
  s.rev = Number(input.rev) || 0;
  return s;
}

// ---------- time helpers ----------

// Accepts "9:15", "09:15", "9:15 PM", "9.15pm", "21:15:00" → "HH:MM" (24h) or null.
export function normalizeClock(str) {
  if (str == null) return null;
  const m = String(str).trim().match(/^(\d{1,2})[:.h]?(\d{2})?(?::(\d{2}))?\s*([ap])?\.?m?\.?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = m[4] && m[4].toLowerCase();
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// CompetitionSuite's performanceTime format is undocumented; accept ISO
// (with or without zone) or a bare clock. Returns { date, time } in local time.
export function parseLooseDateTime(str) {
  if (!str) return { date: null, time: null };
  const s = String(str).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (iso) {
    if (iso[3]) {
      const d = new Date(s);
      if (!isNaN(d)) return { date: todayISO(d), time: normalizeClock(`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`) };
    }
    return { date: iso[1], time: iso[2] };
  }
  const withDate = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(.+)$/);
  if (withDate) {
    const date = `${withDate[3]}-${withDate[1].padStart(2, '0')}-${withDate[2].padStart(2, '0')}`;
    return { date, time: normalizeClock(withDate[4]) };
  }
  return { date: null, time: normalizeClock(s) };
}

export function perfStart(perf, round, offsetMin = 0) {
  const [y, mo, d] = (round?.date || todayISO()).split('-').map(Number);
  const [h, mi] = (perf.time || '00:00').split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi + (Number(offsetMin) || 0), 0, 0);
}

export function formatClock(date, { clock24 = false, seconds = false } = {}) {
  let h = date.getHours();
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  if (clock24) return `${String(h).padStart(2, '0')}:${m}${seconds ? ':' + s : ''}`;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m}${seconds ? ':' + s : ''} ${ap}`;
}

export function formatCountdown(ms) {
  const neg = ms < 0;
  let t = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(t / 3600); t -= h * 3600;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return (neg ? '+' : '−') + body;
}

// ---------- schedule queries ----------

export function roundPerformances(state, roundId = state.activeRoundId, { includeBreaks = true } = {}) {
  return state.performances
    .filter((p) => p.roundId === roundId && (includeBreaks || p.kind !== 'break'))
    .sort((a, b) => a.time.localeCompare(b.time));
}

export function bandAppearances(state, bandId) {
  return state.performances
    .filter((p) => p.bandId === bandId)
    .map((p) => ({ perf: p, round: state.rounds.find((r) => r.id === p.roundId) }))
    .filter((x) => x.round);
}

/**
 * What the slate should show right now.
 * Auto mode: the featured slot is the first performance whose start + advanceAfterMin
 * is still ahead of `now`. So a band stays featured ("on field") for advanceAfterMin
 * after it steps off, then the slate flips to the next band ("up next").
 */
export function computeLive(state, now = new Date()) {
  const st = state.settings;
  const round = state.rounds.find((r) => r.id === state.activeRoundId) || state.rounds[0];
  const list = roundPerformances(state, round?.id, { includeBreaks: st.includeBreaks });
  const offset = Number(state.live.offsetMin) || 0;
  const withTimes = list.map((p) => ({ perf: p, start: perfStart(p, round, offset), band: p.bandId ? state.bands[p.bandId] : null }));
  const bandsOnly = withTimes.filter((x) => x.perf.kind !== 'break');

  let idx = -1;
  if (state.live.mode === 'manual' && state.live.manualId) {
    idx = withTimes.findIndex((x) => x.perf.id === state.live.manualId);
  }
  if (idx === -1) {
    const advanceMs = (Number(st.advanceAfterMin) || 0) * 60000;
    idx = withTimes.findIndex((x) => now.getTime() < x.start.getTime() + advanceMs);
  }

  const featured = idx >= 0 ? withTimes[idx] : null;
  let phase = 'empty';
  if (!withTimes.length) phase = 'empty';
  else if (!featured) phase = 'done';
  else if (featured.perf.kind === 'break') phase = 'break';
  else phase = now < featured.start ? 'next' : 'on';

  const onDeck = idx >= 0 ? withTimes.slice(idx + 1, idx + 1 + Math.max(0, st.onDeckCount)) : [];
  const position = featured && featured.perf.kind !== 'break' ? bandsOnly.indexOf(featured) + 1 : 0;

  return {
    round, phase, featured, onDeck, offset,
    countdownMs: featured ? featured.start.getTime() - now.getTime() : 0,
    position, total: bandsOnly.length,
    index: idx, list: withTimes,
  };
}

// ---------- bands ----------

export function bandKey(name) {
  return String(name || '').toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(the|high school|hs|h\.s\.|marching band|band|of)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

export function findBand(state, { name, csGroupId }) {
  const all = Object.values(state.bands);
  if (csGroupId != null) {
    const byId = all.find((b) => b.csGroupId != null && String(b.csGroupId) === String(csGroupId));
    if (byId) return byId;
  }
  const k = bandKey(name);
  return k ? all.find((b) => bandKey(b.name) === k) || null : null;
}

export function upsertBand(state, { name, hometown = '', csGroupId = null }) {
  let b = findBand(state, { name, csGroupId });
  if (!b) {
    b = { id: uid('b_'), name: String(name).trim(), hometown: String(hometown || '').trim(), csGroupId, notes: [] };
    state.bands[b.id] = b;
  } else {
    if (!b.hometown && hometown) b.hometown = String(hometown).trim();
    if (b.csGroupId == null && csGroupId != null) b.csGroupId = csGroupId;
  }
  return b;
}

// Remove bands nobody performs as and nobody wrote notes about.
export function pruneBands(state) {
  const used = new Set(state.performances.map((p) => p.bandId));
  for (const [id, b] of Object.entries(state.bands)) {
    if (!used.has(id) && !b.notes.length) delete state.bands[id];
  }
}

// ---------- imports ----------

const HEADER_ALIASES = {
  time: ['time', 'performance time', 'perf time', 'start', 'start time', 'performs', 'performancetime'],
  band: ['band', 'group', 'name', 'school', 'unit', 'ensemble', 'group name', 'groupname'],
  hometown: ['hometown', 'location', 'city', 'from', 'home', 'grouplocation', 'city, state'],
  division: ['division', 'class', 'classification', 'div'],
};

function splitRow(line, delim) {
  if (delim === '\t') return line.split('\t').map((c) => c.trim());
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Parse pasted CSV/TSV (from a spreadsheet, a PDF copy, etc.) into rows. */
export function parseScheduleText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const first = splitRow(lines[0], delim).map((c) => c.toLowerCase());
  const col = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const i = first.findIndex((c) => aliases.includes(c));
    if (i >= 0) col[key] = i;
  }
  const hasHeader = col.band != null || col.time != null;
  if (!hasHeader) Object.assign(col, { time: 0, band: 1, hometown: 2, division: 3 });
  const rows = [];
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const cells = splitRow(line, delim);
    let time = normalizeClock(cells[col.time]);
    let band = cells[col.band] || '';
    let hometown = col.hometown != null ? cells[col.hometown] || '' : '';
    // "City, ST" split across two comma cells when the paste wasn't quoted
    if (!hasHeader && delim === ',' && cells.length === 5 && /^[A-Z]{2}$/.test(cells[3])) {
      hometown = `${cells[2]}, ${cells[3]}`;
      cells[3] = cells[4];
    }
    const division = col.division != null ? cells[col.division] || '' : '';
    if (!time && !band) continue;
    if (/^(break|intermission|lunch|dinner|awards|retreat)/i.test(band) && !hometown) {
      rows.push({ kind: 'break', time: time || '00:00', label: band });
      continue;
    }
    if (!band) continue;
    rows.push({ kind: 'band', time: time || '00:00', band, hometown, division });
  }
  return rows;
}

/** Add parsed rows to a round. `replace` clears that round first (notes are kept on bands). */
export function applyScheduleRows(state, roundId, rows, { replace = false } = {}) {
  if (replace) state.performances = state.performances.filter((p) => p.roundId !== roundId);
  for (const r of rows) {
    if (r.kind === 'break') {
      state.performances.push({ id: uid('p_'), roundId, kind: 'break', bandId: null, label: r.label || 'Break', time: r.time, division: '', csId: null });
    } else {
      const b = upsertBand(state, { name: r.band, hometown: r.hometown });
      state.performances.push({ id: uid('p_'), roundId, kind: 'band', bandId: b.id, label: '', time: r.time, division: r.division || '', csId: null });
    }
  }
  pruneBands(state);
}

/**
 * Merge a CompetitionSuite schedule response into a round.
 * Known fields (from the v3 docs example): schedule[].{id, break, groupId, groupName,
 * groupLocation, divisionName, roundName, description, performanceTime, sortOrder}.
 * Matching is by CompSuite id so local notes/edits survive every re-sync.
 */
export function mergeCompSuiteSchedule(state, roundId, payload) {
  const entries = Array.isArray(payload?.schedule) ? payload.schedule : Array.isArray(payload) ? payload : [];
  const round = state.rounds.find((r) => r.id === roundId);
  const seen = new Set();
  let added = 0, updated = 0, removed = 0;
  let dateSet = false;

  for (const e of entries) {
    const isBreak = !!e.break;
    const csId = `${isBreak ? 'brk' : 'perf'}:${e.id}`;
    seen.add(csId);
    const { date, time } = parseLooseDateTime(e.performanceTime);
    if (round && date && !dateSet) { round.date = date; dateSet = true; }
    let perf = state.performances.find((p) => p.roundId === roundId && p.csId === csId);
    const fields = isBreak
      ? { kind: 'break', bandId: null, label: e.description || 'Break', division: '' }
      : (() => {
          const b = upsertBand(state, { name: e.groupName || 'Unnamed group', hometown: e.groupLocation || '', csGroupId: e.groupId ?? null });
          return { kind: 'band', bandId: b.id, label: '', division: e.divisionName || '' };
        })();
    if (perf) {
      Object.assign(perf, fields, time ? { time } : {});
      updated++;
    } else {
      state.performances.push({ id: uid('p_'), roundId, csId, time: time || '00:00', ...fields });
      added++;
    }
  }
  // Drop CompSuite rows that vanished (scratches). Manually added rows stay.
  state.performances = state.performances.filter((p) => {
    if (p.roundId !== roundId || !p.csId || seen.has(p.csId)) return true;
    removed++;
    return false;
  });
  pruneBands(state);
  return { added, updated, removed, total: entries.length, lastUpdate: payload?.lastUpdate || null };
}
