import { createClient, getPreferredMode, setPreferredMode } from './client.js';
import * as M from './model.js';
import { sampleState } from './sample.js';

const $ = (id) => document.getElementById(id);
const main = $('main');
const client = createClient();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TABS = ['live', 'schedule', 'notes', 'source', 'display', 'system'];
let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'live';
let conn = { status: 'connecting', mode: 'local' };
const ui = {
  roundId: null,
  bandId: null,
  bandQuery: '',
  focus: null,
  importText: '',
  cs: { status: null, seasons: null, seasonId: '', events: null, eventId: '', event: null, busy: '', raw: null, error: '' },
};

const S = () => client.state;
const settings = () => S().settings;
const fmt = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return M.formatClock(d, { clock24: settings().clock24 });
};
const update = (fn) => client.update(fn);

// ---------- confirm dialog (in-page: native confirm() is blocked in embedded/shared views) ----------
function ask(message, okLabel = 'Continue') {
  return new Promise((resolve) => {
    $('askMsg').textContent = message;
    $('askYes').textContent = okLabel;
    $('ask').hidden = false;
    $('askYes').focus();
    const done = (v) => { $('ask').hidden = true; $('askForm').onsubmit = null; $('askNo').onclick = null; resolve(v); };
    $('askForm').onsubmit = (e) => { e.preventDefault(); done(true); };
    $('askNo').onclick = () => done(false);
  });
}

// ---------- toast ----------
let toastT;
function toast(msg, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (bad ? ' bad' : '');
  el.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------- rendering ----------
let deferred = false;
const isEditing = () => {
  const a = document.activeElement;
  return a && main.contains(a) && a.matches('input[type=text],input[type=search],input[type=time],input[type=date],input[type=number],input[type=password],input[type=url],textarea') && !a.dataset.live;
};

function render(force = false) {
  if (!force && isEditing()) { deferred = true; return; }
  deferred = false;
  document.querySelectorAll('.rail button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const st = settings();
  document.documentElement.dataset.theme = st.theme === 'light' ? 'light' : 'dark';
  document.documentElement.style.setProperty('--accent', st.accent);
  $('topEvent').textContent = [S().event.name, S().event.venue].filter(Boolean).join(' · ');
  const scroll = main.scrollTop;
  const html = PANELS[tab]();
  if (tab === renderedTab && main.querySelector('[data-soft]')) {
    // Swap only the regions that change so the preview iframe never reloads.
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll('[data-soft]').forEach((n) => {
      const cur = main.querySelector(`[data-soft="${n.dataset.soft}"]`);
      if (cur) cur.innerHTML = n.innerHTML;
    });
  } else {
    main.innerHTML = html;
  }
  renderedTab = tab;
  main.scrollTop = scroll;
  after();
}
let renderedTab = null;

function after() {
  // scale display previews to their boxes
  main.querySelectorAll('.preview').forEach((box) => {
    const f = box.querySelector('iframe');
    if (f) f.style.transform = `scale(${box.clientWidth / 1600})`;
  });
  main.querySelectorAll('textarea.auto').forEach(autosize);
  if (ui.focus) {
    const el = main.querySelector(ui.focus);
    if (el) { el.focus(); if (el.select) el.select(); }
    ui.focus = null;
  }
  if (tab === 'live') liveTick();
}
function autosize(t) { t.style.height = 'auto'; t.style.height = Math.max(38, t.scrollHeight + 2) + 'px'; }

main.addEventListener('focusout', () => setTimeout(() => { if (deferred && !isEditing()) render(); }, 0));

const preview = () => `<div class="preview"><iframe src="./#preview" title="Display preview" tabindex="-1"></iframe></div>`;
const box = (title, body, { actions = '', flush = false } = {}) =>
  `<section class="box"><div class="box-h"><span class="label">${title}</span><div class="row">${actions}</div></div><div class="box-b${flush ? ' flush' : ''}">${body}</div></section>`;
const sw = (key, label, small = '', checked = false) =>
  `<label class="sw"><span>${label}${small ? `<small>${small}</small>` : ''}</span><input type="checkbox" data-change="${key}" ${checked ? 'checked' : ''}></label>`;
const stepper = (act, value, unit = '') =>
  `<div class="stepper"><button type="button" data-act="${act}" data-d="-1">−</button><output>${esc(value)}${unit}</output><button type="button" data-act="${act}" data-d="1">+</button></div>`;
const roundOptions = (sel) => S().rounds.map((r) => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`).join('');

// ================= LIVE =================
function nowHtml() {
  const live = M.computeLive(S());
  const f = live.featured;
  if (S().live.hold) return `<div class="now"><span class="when">Holding</span><span class="who">${esc(S().live.message || 'Standby')}</span><span class="where">Display shows the hold card.</span></div>`;
  if (!f) return `<div class="now"><span class="when">${live.phase === 'done' ? 'Round complete' : 'Nothing scheduled'}</span><span class="who">${esc(live.round?.name || '')}</span><span class="where">${live.phase === 'empty' ? 'Add performances in Schedule or pull them from CompetitionSuite.' : 'Switch rounds or step back to show a band again.'}</span></div>`;
  const phase = { next: 'Up next', on: 'On field', break: 'Break' }[live.phase];
  const name = f.perf.kind === 'break' ? f.perf.label : f.band?.name;
  return `<div class="now">
    <span class="when">${phase} · ${esc(M.formatClock(f.start, { clock24: settings().clock24 }))} · ${esc(M.formatCountdown(live.countdownMs))}${S().live.mode === 'manual' ? ' · pinned' : ''}</span>
    <span class="who">${esc(name)}</span>
    <span class="where">${esc(f.band?.hometown || '')}${f.perf.division ? ` · ${esc(f.perf.division)}` : ''}</span>
  </div>`;
}

function runlistHtml() {
  const live = M.computeLive(S());
  if (!live.list.length) return `<div class="empty-state"><b>No performances in this round</b>Add them in Schedule, paste a list, or import from CompetitionSuite.</div>`;
  return `<ul class="runlist">${live.list.map((x, i) => {
    const cls = [i === live.index ? 'cur' : i < live.index || live.index === -1 ? 'past' : '', x.perf.kind === 'break' ? 'brk' : ''].join(' ');
    const status = i === live.index ? (S().live.mode === 'manual' ? 'Pinned' : 'Showing') : i < live.index || live.index === -1 ? 'Done' : '';
    const name = x.perf.kind === 'break' ? x.perf.label : x.band?.name;
    const nn = x.band?.notes?.length ? `<small>${x.band.notes.length} note${x.band.notes.length > 1 ? 's' : ''}</small>` : '';
    return `<li class="${cls}" data-act="pin" data-id="${x.perf.id}"><span class="t">${esc(M.formatClock(x.start, { clock24: settings().clock24 }))}</span><span class="n">${esc(name)}${nn}</span><span class="s">${status}</span></li>`;
  }).join('')}</ul>`;
}

function quickNotesHtml() {
  const f = M.computeLive(S()).featured;
  if (!f || f.perf.kind === 'break' || !f.band) return `<p class="hint">Notes for the band on screen show up here.</p>`;
  const b = f.band;
  return `<div class="field"><span class="muted">${esc(b.name)}</span>
    <form class="row" data-submit="quicknote" data-band="${b.id}"><input class="grow" style="flex:1;min-width:0" type="text" name="text" placeholder="Add a note for this band…" autocomplete="off"><button class="btn" type="submit">Add</button></form></div>
    ${b.notes.length ? `<ul class="notelist" style="margin-top:12px">${b.notes.map((n) => `<li style="grid-template-columns:34px 1fr"><button type="button" class="pinbtn ${n.pinned ? 'on' : ''}" data-act="notepin" data-band="${b.id}" data-note="${n.id}" title="Highlight">★</button><span style="padding-top:8px">${esc(n.text)}</span></li>`).join('')}</ul>` : ''}`;
}

let lastLive = '';
function liveTick() {
  if (tab !== 'live') return;
  const nb = main.querySelector('#nowBox');
  const rl = main.querySelector('#runBox');
  const html = nowHtml() + '\u0000' + runlistHtml();
  if (html === lastLive) return;
  lastLive = html;
  const [a, b] = html.split('\u0000');
  if (nb) nb.innerHTML = a;
  if (rl) rl.innerHTML = b;
}

const PANELS = {};
PANELS.live = () => {
  lastLive = '';
  const L = S().live;
  return `
  <div class="panel-head"><div><div class="label">01 / Live</div><h1>Live control</h1>
    <p>The display follows the clock on its own: each band stays up for ${settings().advanceAfterMin} min after step-off, then the next band takes over. Step in when the show drifts.</p></div></div>
  <div class="cols">
    <div class="stack">
      <section class="box">${preview()}<div id="nowBox"></div></section>
      <div data-soft="run">${box('Run order', `<div id="runBox"></div>`, { flush: true, actions: `<select data-change="activeRound" style="height:30px;width:auto">${roundOptions(S().activeRoundId)}</select>` })}</div>
    </div>
    <div class="stack" data-soft="livectl">
      ${box('Transport', `
        <div class="ctl-grid">
          <div class="transport">
            <button class="btn lg" data-act="step" data-d="-1">◀ Previous</button>
            <button class="btn lg primary" data-act="step" data-d="1">Next ▶</button>
          </div>
          <div class="ctl"><span>Mode</span>
            <div class="seg"><button data-act="mode" data-v="auto" class="${L.mode === 'auto' ? 'on' : ''}">Auto (clock)</button><button data-act="mode" data-v="manual" class="${L.mode === 'manual' ? 'on' : ''}">Manual</button></div></div>
          <p class="hint">Tap any row in the run order to put that band on screen. On a display with a keyboard: <span class="kbd">←</span> <span class="kbd">→</span> step, <span class="kbd">A</span> auto, <span class="kbd">H</span> hold, <span class="kbd">F</span> full screen.</p>
        </div>`)}
      ${box('Timing', `
        <div class="ctl-grid">
          <div class="ctl"><span>Running ${L.offsetMin >= 0 ? 'behind' : 'ahead'}<small class="hint" style="display:block;margin:0">Shifts every time and countdown</small></span>
            <div class="row">${stepper('offset', (L.offsetMin > 0 ? '+' : '') + L.offsetMin, 'm')}<button class="btn sm ghost" data-act="offset0">Reset</button></div></div>
          <div class="ctl"><span>Flip to next band<small class="hint" style="display:block;margin:0">Minutes after a band's start time</small></span>${stepper('advance', settings().advanceAfterMin, 'm')}</div>
        </div>`)}
      ${box('Hold &amp; message', `
        ${sw('live.hold', 'Hold screen', 'Covers the slate with your message (awards, weather, breaks)', L.hold)}
        ${sw('live.banner', 'Show message as banner', 'Runs along the bottom while the slate stays up', L.banner)}
        <div class="field" style="margin-top:12px"><input type="text" data-change="live.message" value="${esc(L.message)}" placeholder="Message, e.g. Retreat at 10:45 PM"></div>`)}
      ${box('Notes on screen', `<div id="quickNotes">${quickNotesHtml()}</div>`)}
    </div>
  </div>`;
};

// ================= SCHEDULE =================
PANELS.schedule = () => {
  const s = S();
  if (!s.rounds.some((r) => r.id === ui.roundId)) ui.roundId = s.activeRoundId;
  const round = s.rounds.find((r) => r.id === ui.roundId);
  const perfs = M.roundPerformances(s, round.id);
  const rows = perfs.map((p) => {
    if (p.kind === 'break') {
      return `<div class="r brk" data-perf="${p.id}">
        <input type="time" data-change="perf.time" value="${p.time}">
        <input type="text" class="lbl" data-change="perf.label" value="${esc(p.label)}" placeholder="Break">
        <span></span>
        <button class="x" data-act="delperf" title="Remove">×</button></div>`;
    }
    const b = s.bands[p.bandId];
    return `<div class="r" data-perf="${p.id}">
      <input type="time" data-change="perf.time" value="${p.time}" aria-label="Time">
      <input type="text" data-change="perf.band" value="${esc(b?.name)}" placeholder="Band name" list="bandNames" aria-label="Band">
      <input type="text" data-change="perf.hometown" value="${esc(b?.hometown)}" placeholder="Hometown" aria-label="Hometown">
      <input type="text" data-change="perf.division" value="${esc(p.division)}" placeholder="Class" aria-label="Division">
      <button class="nc ${b?.notes.length ? 'has' : ''}" data-act="gonotes" data-band="${p.bandId}" title="Notes">${b?.notes.length || 0} ✎</button>
      <button class="x" data-act="delperf" title="Remove">×</button></div>`;
  }).join('');
  const csLink = round.cs ? `<span class="chip">CompSuite · event ${round.cs.eventId} / comp ${round.cs.competitionId}</span>` : '';
  return `
  <div class="panel-head"><div><div class="label">02 / Schedule</div><h1>Schedule</h1>
    <p>One tab per round. Edit any cell in place. Times are the published performance times; use the Live tab's offset when the show runs late.</p></div></div>
  <div class="stack">
    ${box('Event', `<div class="fields">
      <label class="field"><span class="label">Event name</span><input type="text" data-change="event.name" value="${esc(s.event.name)}" placeholder="e.g. Grand National Championships"></label>
      <label class="field"><span class="label">Venue</span><input type="text" data-change="event.venue" value="${esc(s.event.venue)}" placeholder="e.g. Lucas Oil Stadium"></label></div>`)}
    <section class="box">
      <div class="box-h"><div class="tabs">${s.rounds.map((r) => `<button data-act="selround" data-id="${r.id}" class="${r.id === round.id ? 'on' : ''}">${esc(r.name)}${r.id === s.activeRoundId ? ' ●' : ''}</button>`).join('')}<button class="add" data-act="addround" title="Add round">+ Round</button></div></div>
      <div class="box-b">
        <div class="fields round">
          <label class="field"><span class="label">Round name</span><input type="text" data-change="round.name" value="${esc(round.name)}"></label>
          <label class="field"><span class="label">Date</span><input type="date" data-change="round.date" value="${round.date}"></label>
          <div class="field"><span class="label">&nbsp;</span><div class="row">
            ${round.id === s.activeRoundId ? '<span class="chip" style="color:var(--accent);border-color:var(--accent)">On display</span>' : `<button class="btn sm" data-act="showround">Put on display</button>`}
            <button class="btn sm ghost danger" data-act="delround" ${s.rounds.length < 2 ? 'disabled' : ''}>Delete round</button></div></div>
        </div>
        ${csLink ? `<div class="apps">${csLink}</div>` : ''}
      </div>
    </section>
    <section class="box">
      <div class="box-h"><span class="label">${perfs.filter((p) => p.kind === 'band').length} performances</span>
        <div class="row"><button class="btn sm" data-act="addperf">+ Band</button><button class="btn sm ghost" data-act="addbreak">+ Break</button></div></div>
      <div class="box-b flush">
        ${perfs.length ? `<div class="sched"><div class="hd label"><span>Time</span><span>Band</span><span>Hometown</span><span>Class</span><span style="text-align:center">Notes</span><span></span></div>${rows}</div>`
          : `<div class="empty-state"><b>No performances yet</b>Add bands one at a time, paste a list below, or import from CompetitionSuite under Data source.</div>`}
      </div>
    </section>
    ${box('Paste a schedule', `
      <textarea id="importText" rows="6" placeholder="Time, Band, Hometown, Class&#10;8:00 AM, Fishers HS, &quot;Fishers, IN&quot;, AAAA&#10;8:12 AM, Avon HS, &quot;Avon, IN&quot;, AAAA&#10;9:30 AM, Break">${esc(ui.importText)}</textarea>
      <p class="hint">Copy rows straight from a spreadsheet, Google Sheet or CSV. Columns: time, band, hometown, class (a header row is optional). Rows named Break, Lunch, Dinner or Awards become breaks. Existing notes attach automatically by band name.</p>
      <div class="row" style="margin-top:10px"><button class="btn primary" data-act="import" data-mode="append">Add to ${esc(round.name)}</button><button class="btn ghost" data-act="import" data-mode="replace">Replace ${esc(round.name)}</button></div>`)}
  </div>
  <datalist id="bandNames">${Object.values(s.bands).map((b) => `<option value="${esc(b.name)}">`).join('')}</datalist>`;
};

// ================= NOTES =================
PANELS.notes = () => {
  const s = S();
  const q = M.bandKey(ui.bandQuery);
  const bands = Object.values(s.bands)
    .filter((b) => !q || M.bandKey(b.name).includes(q) || b.hometown.toLowerCase().includes(ui.bandQuery.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!ui.bandId || !s.bands[ui.bandId]) ui.bandId = bands[0]?.id || null;
  const sel = ui.bandId ? s.bands[ui.bandId] : null;
  const list = bands.map((b) => `<li class="${b.id === ui.bandId ? 'on' : ''}" data-act="selband" data-id="${b.id}"><span class="n">${esc(b.name)}</span><span class="h">${esc(b.hometown || '—')}</span><span class="c ${b.notes.length ? 'has' : ''}">${b.notes.length}</span></li>`).join('');
  let editor = `<div class="empty-state"><b>No band selected</b>Add a band, or load a schedule first.</div>`;
  if (sel) {
    const apps = M.bandAppearances(s, sel.id);
    editor = `
      <div class="fields">
        <label class="field"><span class="label">Band</span><input type="text" data-change="band.name" data-band="${sel.id}" value="${esc(sel.name)}"></label>
        <label class="field"><span class="label">Hometown</span><input type="text" data-change="band.hometown" data-band="${sel.id}" value="${esc(sel.hometown)}" placeholder="City, ST"></label>
      </div>
      <div class="apps">${apps.length ? apps.map((a) => `<span class="chip">${esc(a.round.name)} · ${fmt(a.perf.time)}</span>`).join('') : '<span class="chip">Not on a schedule yet</span>'}</div>
      <div class="label" style="margin:22px 0 10px">Notes · ★ = highlight on screen</div>
      ${sel.notes.length ? `<ul class="notelist">${sel.notes.map((n) => `<li>
        <button type="button" class="pinbtn ${n.pinned ? 'on' : ''}" data-act="notepin" data-band="${sel.id}" data-note="${n.id}" title="Highlight on display">★</button>
        <textarea class="auto" rows="1" data-change="note.text" data-band="${sel.id}" data-note="${n.id}">${esc(n.text)}</textarea>
        <button type="button" class="x" data-act="notedel" data-band="${sel.id}" data-note="${n.id}" title="Delete note">×</button></li>`).join('')}</ul>` : ''}
      <form class="row" data-submit="addnote" data-band="${sel.id}" style="margin-top:10px">
        <input type="text" name="text" placeholder="e.g. Director is a Hall of Fame inductee" autocomplete="off" style="flex:1;min-width:0"><button class="btn primary" type="submit">Add note</button></form>
      <div class="row between" style="margin-top:22px"><span class="hint" style="margin:0">Notes stay with this band in every round.</span>
        <button class="btn sm ghost danger" data-act="delband" data-band="${sel.id}" ${apps.length ? 'disabled title="Remove it from the schedule first"' : ''}>Delete band</button></div>`;
  }
  return `
  <div class="panel-head"><div><div class="label">03 / Bands &amp; notes</div><h1>Bands &amp; notes</h1>
    <p>Notes belong to the band, not the performance, so what you enter for prelims comes back in semis and finals. Add bands before the schedule exists; they match up by name when it arrives.</p></div></div>
  <div class="cols" style="grid-template-columns:minmax(0,.9fr) minmax(0,1.4fr)">
    <section class="box">
      <div class="box-h"><input type="search" data-live="1" id="bandSearch" placeholder="Search ${Object.keys(s.bands).length} bands" value="${esc(ui.bandQuery)}" style="height:32px"><button class="btn sm" data-act="addband">+ Band</button></div>
      <div class="box-b flush">${list ? `<ul class="bandlist">${list}</ul>` : `<div class="empty-state">No bands match.</div>`}</div>
    </section>
    <div class="stack">
      ${box('Band', editor)}
      ${box('Quick add', `<textarea id="bulkNotes" rows="4" placeholder="Fishers: Giant bear prop in the closer&#10;Avon: Director inducted into the Hall of Fame"></textarea>
        <p class="hint">One note per line as <b>Band: note</b>. New band names are created; existing ones match by name.</p>
        <div class="row" style="margin-top:10px"><button class="btn" data-act="bulknotes">Add notes</button></div>`)}
    </div>
  </div>`;
};

// ================= SOURCE =================
PANELS.source = () => {
  const s = S();
  const server = conn.mode === 'server';
  const c = ui.cs;
  if (server && !c.status && !c.busy) loadCsStatus();
  let cs;
  if (!server) {
    cs = `<div class="notice">CompetitionSuite needs the Field Slate server, which holds your API secret safely. Open Field Slate from the desktop app or run the server (see Devices), then connect here. Manual and pasted schedules work everywhere.</div>`;
  } else if (!c.status) {
    cs = `<p class="hint">Checking connection…</p>`;
  } else if (!c.status.connected) {
    cs = `<form data-submit="csconnect" class="stack" style="gap:12px">
      <div class="notice">You need an API key from the organization running the show (circuit or show host). In CompetitionSuite: <b>Settings → API → Create API Key</b>. Keys are per organization, and schedules only appear for that organization's events.</div>
      <div class="fields">
        <label class="field"><span class="label">Client ID</span><input type="text" name="clientId" autocomplete="off" required></label>
        <label class="field"><span class="label">Client secret</span><input type="password" name="clientSecret" autocomplete="off" required></label>
      </div>
      <details><summary class="hint" style="cursor:pointer">Advanced</summary><label class="field" style="margin-top:8px"><span class="label">API base URL</span><input type="url" name="baseUrl" placeholder="https://api.competitionsuite.com/v3"></label></details>
      <div class="err">${esc(c.error)}</div>
      <div class="row"><button class="btn primary" type="submit" ${c.busy ? 'disabled' : ''}>${c.busy === 'connect' ? 'Connecting…' : 'Connect'}</button></div>
      <p class="hint">The secret is stored only on the machine running the server, never in browsers or on displays.</p></form>`;
  } else {
    const events = Array.isArray(c.events?.data) ? c.events.data : Array.isArray(c.events) ? c.events : null;
    const seasons = Array.isArray(c.seasons?.data) ? c.seasons.data : Array.isArray(c.seasons) ? c.seasons : [];
    const comps = c.event?.competitions || [];
    cs = `<dl class="kv"><dt>Status</dt><dd style="color:var(--ok)">Connected (${esc(c.status.clientIdHint)})</dd>
      ${c.status.rateLimitedUntil ? `<dt>Rate limit</dt><dd style="color:var(--warn)">Paused until ${new Date(c.status.rateLimitedUntil).toLocaleTimeString()}</dd>` : ''}</dl>
      <div class="fields" style="margin-top:16px;grid-template-columns:1fr 2fr auto">
        <label class="field"><span class="label">Season</span><select data-change="cs.season"><option value="">All seasons</option>${seasons.map((x) => `<option value="${x.id}" ${String(x.id) === String(c.seasonId) ? 'selected' : ''}>${esc(x.name || x.id)}</option>`).join('')}</select></label>
        <label class="field"><span class="label">Event</span><select data-change="cs.event" ${events ? '' : 'disabled'}><option value="">${events ? `Choose from ${events.length} events` : 'Load events first'}</option>${(events || []).map((e) => `<option value="${e.id}" ${String(e.id) === String(c.eventId) ? 'selected' : ''}>${esc(e.name)}${e.location ? ' — ' + esc(e.location) : ''}</option>`).join('')}</select></label>
        <div class="field"><span class="label">&nbsp;</span><button class="btn" data-act="csevents" ${c.busy ? 'disabled' : ''}>${c.busy === 'events' ? 'Loading…' : events ? 'Reload' : 'Load events'}</button></div>
      </div>
      <div class="err" style="margin-top:8px">${esc(c.error)}</div>
      ${c.event ? `<div class="label" style="margin:14px 0 6px">${esc(c.event.name)} · competitions</div>
        <ul class="complist" style="border:1px solid var(--line)">${comps.length ? comps.map((k) => `<li><div><b>${esc(k.name)}</b><div class="hint" style="margin:2px 0 0">${k.date ? new Date(k.date).toLocaleDateString() : ''}</div></div>
          <div class="row"><select data-cs-target="${k.id}" style="height:30px;width:auto"><option value="">New round “${esc(k.name)}”</option>${roundOptions(null)}</select>
          <button class="btn sm primary" data-act="csimport" data-comp="${k.id}" data-name="${esc(k.name)}" ${c.busy ? 'disabled' : ''}>Import</button>
          <button class="btn sm ghost" data-act="csraw" data-comp="${k.id}">Raw</button></div></li>`).join('') : '<li class="hint">No competitions in this event.</li>'}</ul>` : ''}
      ${c.raw ? `<div class="label" style="margin:14px 0 6px">Raw schedule response</div><pre class="raw">${esc(JSON.stringify(c.raw, null, 2))}</pre>` : ''}
      <div class="row" style="margin-top:16px"><button class="btn sm ghost danger" data-act="csdisconnect">Disconnect</button></div>`;
  }
  const linked = s.rounds.filter((r) => r.cs);
  return `
  <div class="panel-head"><div><div class="label">04 / Data source</div><h1>Data source</h1>
    <p>Pull the schedule from CompetitionSuite, or type and paste it yourself. Notes and edits you make here survive every re-sync.</p></div></div>
  <div class="cols">
    <div class="stack">
      ${box('CompetitionSuite', cs)}
      ${box('Manual', `<p class="muted" style="margin:0">No Wi-Fi, no API key, or a show that isn't on CompetitionSuite? Build the schedule in <a href="#schedule" data-act="tab" data-tab="schedule" style="color:var(--accent)">Schedule</a>: type rows or paste them from a spreadsheet. Everything works offline.</p>`)}
    </div>
    <div class="stack">
      ${box('Sync', `${linked.length ? `<ul class="complist" style="margin:-16px -16px 12px">${linked.map((r) => `<li><div><b>${esc(r.name)}</b><div class="hint" style="margin:2px 0 0">event ${r.cs.eventId} · competition ${r.cs.competitionId}</div></div><button class="btn sm ghost" data-act="unlink" data-id="${r.id}">Unlink</button></li>`).join('')}</ul>` : '<p class="hint" style="margin-top:0">No rounds linked to CompetitionSuite yet. Import a competition to link it.</p>'}
        ${sw('sync.autoSync', 'Auto-sync linked rounds', 'Picks up schedule changes and scratches', s.sync.autoSync)}
        <div class="ctl" style="padding:11px 0"><span>Every</span><select data-change="sync.intervalSec" style="width:auto;height:32px">${[60, 120, 300, 600].map((v) => `<option value="${v}" ${s.sync.intervalSec === v ? 'selected' : ''}>${v / 60} min</option>`).join('')}</select></div>
        <dl class="kv" style="margin-top:6px"><dt>Last sync</dt><dd>${s.sync.lastSync ? new Date(s.sync.lastSync).toLocaleString() : 'Never'}</dd>${s.sync.lastError ? `<dt>Error</dt><dd style="color:var(--danger)">${esc(s.sync.lastError)}</dd>` : ''}</dl>
        <div class="row" style="margin-top:12px"><button class="btn" data-act="syncnow" ${!server || !linked.length ? 'disabled' : ''}>Sync now</button></div>`)}
    </div>
  </div>`;
};

// ================= DISPLAY =================
const ACCENTS = ['#35E0FF', '#3DDC97', '#FFB547', '#FF5A5F', '#B18CFF', '#FFFFFF'];
PANELS.display = () => {
  const st = settings();
  const t = (k, label, small) => sw('set.' + k, label, small, st[k]);
  return `
  <div class="panel-head"><div><div class="label">05 / Display</div><h1>Display</h1>
    <p>Show as much or as little as you want. Changes apply to every connected screen instantly.</p></div></div>
  <div class="cols">
    <div class="stack" data-soft="dispctl">
      ${box('Look', `
        <div class="ctl" style="padding-bottom:12px"><span>Theme</span><div class="seg"><button data-act="set" data-k="theme" data-v="dark" class="${st.theme === 'dark' ? 'on' : ''}">Dark</button><button data-act="set" data-k="theme" data-v="light" class="${st.theme === 'light' ? 'on' : ''}">Light</button></div></div>
        <div class="ctl" style="padding:12px 0;border-top:1px solid var(--line)"><span>Accent</span><div class="swatches">${ACCENTS.map((a) => `<button style="background:${a}" class="${st.accent.toLowerCase() === a.toLowerCase() ? 'on' : ''}" data-act="set" data-k="accent" data-v="${a}" title="${a}"></button>`).join('')}<input type="color" data-change="set.accent" value="${st.accent}"></div></div>
        <div class="ctl" style="padding:12px 0;border-top:1px solid var(--line)"><span>Text size</span>${stepper('scale', Math.round(st.fontScale * 100), '%')}</div>
        ${t('showGrid', 'Background grid')}`)}
      ${box('Header', `${t('showEventName', 'Event name')}${t('showRound', 'Round name')}${t('showClock', 'Clock')}${t('showSeconds', 'Seconds on clock')}${t('clock24', '24-hour time')}`)}
      ${box('Featured band', `${t('showTime', 'Performance time')}${t('showCountdown', 'Countdown + progress bar')}${t('showHometown', 'Hometown')}${t('showDivision', 'Class / division')}${t('showProgress', 'Position in round', 'e.g. 07 / 32')}${t('showNotes', 'Notes')}
        <div class="ctl" style="padding:11px 0"><span>Max notes shown</span>${stepper('maxNotes', st.maxNotes)}</div>`)}
      ${box('On deck', `<div class="ctl" style="padding-bottom:11px"><span>Bands on deck<small class="hint" style="display:block;margin:0">0 hides the list</small></span>${stepper('onDeck', st.onDeckCount)}</div>
        ${t('showOnDeckHometown', 'Hometowns on deck')}${t('includeBreaks', 'Show breaks', 'Breaks appear as their own slot')}`)}
    </div>
    <div class="stack" style="position:sticky;top:0">
      <section class="box">${preview()}<div class="box-b"><p class="hint" style="margin:0">Live preview at 16:9. Portrait screens (phones, iPad upright) stack the on-deck list under the band.</p></div></section>
    </div>
  </div>`;
};

// ================= SYSTEM =================
PANELS.system = () => {
  const server = conn.mode === 'server';
  const h = client.health;
  const lan = h?.lan || [];
  const here = location.origin;
  return `
  <div class="panel-head"><div><div class="label">06 / Devices &amp; backup</div><h1>Devices &amp; backup</h1></div></div>
  <div class="cols even">
    <div class="stack">
      ${box('This connection', `<dl class="kv">
        <dt>Mode</dt><dd>${server ? 'Field Slate server · every screen stays in sync' : 'Standalone · data lives in this browser only'}</dd>
        <dt>Status</dt><dd>${esc(conn.status)}</dd>
        ${server ? `<dt>Version</dt><dd>${esc(h?.version)}</dd>` : ''}
      </dl>
      <div class="row" style="margin-top:14px">
        ${server ? `<button class="btn sm ghost" data-act="forcelocal">Use standalone on this device</button>` : getPreferredMode() === 'local' ? `<button class="btn sm" data-act="forceauto">Reconnect to server</button>` : ''}
      </div>`)}
      ${box('Connect another screen', server ? `
        <p class="muted" style="margin-top:0">On an iPad, phone or another computer on the same Wi-Fi or hotspot, open:</p>
        ${(lan.length ? lan : [here]).map((u) => `<div class="url">${esc(u)}</div>`).join('')}
        <p class="hint">Add <span class="kbd">/admin</span> for this control panel. No venue Wi-Fi? Turn on a phone hotspot, join the laptop and iPad to it, and use the address above. No internet needed.</p>`
        : `<p class="muted" style="margin-top:0">Standalone mode keeps everything on this device. To drive an iPad or second screen from another device, run the Field Slate desktop app (or <span class="kbd">npm start</span>) on a laptop and open its network address.</p>`)}
      ${box('iPad full screen', `<ol class="steps">
        <li>Open the display address in <b>Safari</b>.</li>
        <li>Tap <b>Share → Add to Home Screen</b>.</li>
        <li>Launch <b>Field Slate</b> from the Home Screen: it runs edge-to-edge with no browser bars, and the screen stays awake.</li>
        <li>Optional: <b>Settings → Accessibility → Guided Access</b>, then triple-click to lock the iPad to the slate.</li></ol>`)}
    </div>
    <div class="stack">
      ${box('Backup', `
        <p class="muted" style="margin-top:0">Export the whole show (schedule, bands, notes, settings) to a file. Import it on another device or before Finals.</p>
        <div class="row"><button class="btn" data-act="export">Export .json</button><button class="btn ghost" data-act="copybackup">Copy backup</button><label class="btn ghost">Import .json<input type="file" accept="application/json,.json" data-change="importfile" hidden></label></div>`)}
      ${box('Reset', `
        <div class="row"><button class="btn ghost danger" data-act="clearsched">Clear schedules, keep notes</button><button class="btn ghost danger" data-act="eraseall">Erase everything</button></div>
        <p class="hint">Export a backup first. Erase cannot be undone.</p>
        <div class="row" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line)"><button class="btn ghost" data-act="sample">Load sample show</button><span class="hint" style="margin:0">Replaces everything with a demo timed around right now.</span></div>`)}
      ${server ? box('Admin PIN', `
        <p class="muted" style="margin-top:0">${h?.pinRequired ? 'A PIN is set. Anyone on the network can view the display, but editing needs the PIN.' : 'No PIN set: anyone on the same network who opens /admin can edit.'}</p>
        <form class="row" data-submit="setpin"><input type="password" name="pin" inputmode="numeric" placeholder="${h?.pinRequired ? 'New PIN (blank removes it)' : 'Choose a PIN'}" style="flex:1;min-width:0" autocomplete="new-password"><button class="btn" type="submit">${h?.pinRequired ? 'Change' : 'Set PIN'}</button></form>`) : ''}
    </div>
  </div>`;
};

// ---------- CompetitionSuite calls ----------
async function csCall(busy, fn) {
  ui.cs.busy = busy; ui.cs.error = ''; render(true);
  try { await fn(); } catch (e) { ui.cs.error = e.message; } finally { ui.cs.busy = ''; render(true); }
}
async function loadCsStatus() {
  ui.cs.busy = 'status';
  try { ui.cs.status = await client.api('/api/compsuite/status'); } catch (e) { ui.cs.error = e.message; ui.cs.status = { connected: false }; }
  ui.cs.busy = '';
  if (ui.cs.status.connected && !ui.cs.seasons) client.api('/api/compsuite/seasons').then((r) => { ui.cs.seasons = r; if (tab === 'source') render(); }).catch(() => {});
  if (tab === 'source') render();
}

// ---------- actions ----------
function perfOf(el) {
  const id = el.closest('[data-perf]')?.dataset.perf;
  return id;
}
const ACTIONS = {
  tab: (el, e) => { e.preventDefault(); go(el.dataset.tab); },
  step(el) {
    const live = M.computeLive(S());
    if (!live.list.length) return;
    const d = Number(el.dataset.d);
    const i = Math.max(0, Math.min(live.list.length - 1, (live.index < 0 ? live.list.length : live.index) + d));
    update((s) => { s.live.mode = 'manual'; s.live.manualId = live.list[i].perf.id; });
  },
  pin(el) { update((s) => { s.live.mode = 'manual'; s.live.manualId = el.dataset.id; s.live.hold = false; }); },
  mode(el) {
    update((s) => {
      s.live.mode = el.dataset.v;
      if (el.dataset.v === 'auto') s.live.manualId = null;
      else if (!s.live.manualId) s.live.manualId = M.computeLive(s).featured?.perf.id || null;
    });
  },
  offset(el) { update((s) => { s.live.offsetMin = Math.max(-120, Math.min(240, s.live.offsetMin + Number(el.dataset.d))); }); },
  offset0() { update((s) => { s.live.offsetMin = 0; }); },
  advance(el) { update((s) => { s.settings.advanceAfterMin = Math.max(0, Math.min(60, s.settings.advanceAfterMin + Number(el.dataset.d))); }); },
  scale(el) { update((s) => { s.settings.fontScale = Math.round(Math.max(0.7, Math.min(1.5, s.settings.fontScale + 0.05 * Number(el.dataset.d))) * 100) / 100; }); },
  maxNotes(el) { update((s) => { s.settings.maxNotes = Math.max(1, Math.min(10, s.settings.maxNotes + Number(el.dataset.d))); }); },
  onDeck(el) { update((s) => { s.settings.onDeckCount = Math.max(0, Math.min(8, s.settings.onDeckCount + Number(el.dataset.d))); }); },
  set(el) { update((s) => { s.settings[el.dataset.k] = el.dataset.v; }); },

  selround(el) { ui.roundId = el.dataset.id; render(true); },
  showround() { update((s) => { s.activeRoundId = ui.roundId; s.live.mode = 'auto'; s.live.manualId = null; }); toast('Round is now on the display'); },
  addround() {
    const id = M.uid('r_');
    const names = ['Prelims', 'Semifinals', 'Finals'];
    update((s) => {
      const name = names.find((n) => !s.rounds.some((r) => r.name === n)) || `Round ${s.rounds.length + 1}`;
      s.rounds.push({ id, name, date: s.rounds.at(-1)?.date || M.todayISO(), cs: null });
    });
    ui.roundId = id; ui.focus = '[data-change="round.name"]';
  },
  async delround() {
    const r = S().rounds.find((x) => x.id === ui.roundId);
    if (!r || !await ask(`Delete ${r.name} and its performances? Band notes are kept.`)) return;
    update((s) => {
      s.rounds = s.rounds.filter((x) => x.id !== r.id);
      s.performances = s.performances.filter((p) => p.roundId !== r.id);
      if (s.activeRoundId === r.id) s.activeRoundId = s.rounds[0].id;
      M.pruneBands(s);
    });
    ui.roundId = null;
  },
  addperf() {
    const perfs = M.roundPerformances(S(), ui.roundId);
    const last = perfs.at(-1)?.time || '07:48';
    const [h, m] = last.split(':').map(Number);
    const t = new Date(2000, 0, 1, h, m + 12);
    const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const pid = M.uid('p_');
    update((s) => {
      const b = { id: M.uid('b_'), name: 'New band', hometown: '', csGroupId: null, notes: [] };
      s.bands[b.id] = b;
      s.performances.push({ id: pid, roundId: ui.roundId, kind: 'band', bandId: b.id, label: '', time, division: perfs.at(-1)?.division || '', csId: null });
    });
    ui.focus = `[data-perf="${pid}"] [data-change="perf.band"]`;
  },
  addbreak() {
    const perfs = M.roundPerformances(S(), ui.roundId);
    const pid = M.uid('p_');
    update((s) => { s.performances.push({ id: pid, roundId: ui.roundId, kind: 'break', bandId: null, label: 'Break', time: perfs.at(-1)?.time || '12:00', division: '', csId: null }); });
    ui.focus = `[data-perf="${pid}"] [data-change="perf.label"]`;
  },
  delperf(el) {
    const id = perfOf(el);
    update((s) => { s.performances = s.performances.filter((p) => p.id !== id); if (s.live.manualId === id) s.live.manualId = null; M.pruneBands(s); });
  },
  gonotes(el) { ui.bandId = el.dataset.band; go('notes'); },
  async import(el) {
    const text = main.querySelector('#importText').value;
    const rows = M.parseScheduleText(text);
    if (!rows.length) return toast('Nothing to import. Check the format.', true);
    const replace = el.dataset.mode === 'replace';
    if (replace && M.roundPerformances(S(), ui.roundId).length && !await ask('Replace every performance in this round? Notes are kept.')) return;
    update((s) => M.applyScheduleRows(s, ui.roundId, rows, { replace }));
    ui.importText = '';
    toast(`Imported ${rows.length} rows`);
  },

  selband(el) { ui.bandId = el.dataset.id; render(true); },
  addband() {
    const id = M.uid('b_');
    update((s) => { s.bands[id] = { id, name: 'New band', hometown: '', csGroupId: null, notes: [] }; });
    ui.bandId = id; ui.bandQuery = ''; ui.focus = '[data-change="band.name"]';
  },
  async delband(el) {
    const b = S().bands[el.dataset.band];
    if (!b || !await ask(`Delete ${b.name} and its notes?`)) return;
    update((s) => { delete s.bands[b.id]; });
    ui.bandId = null;
  },
  notepin(el) { update((s) => { const n = s.bands[el.dataset.band]?.notes.find((x) => x.id === el.dataset.note); if (n) n.pinned = !n.pinned; }); },
  notedel(el) { update((s) => { const b = s.bands[el.dataset.band]; if (b) b.notes = b.notes.filter((x) => x.id !== el.dataset.note); }); },
  bulknotes() {
    const lines = main.querySelector('#bulkNotes').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let n = 0;
    update((s) => {
      for (const line of lines) {
        const m = line.match(/^(.+?)\s*[:—–|-]\s+(.+)$/) || line.match(/^(.+?):(.+)$/);
        if (!m) continue;
        const b = M.upsertBand(s, { name: m[1].trim() });
        b.notes.push({ id: M.uid('n_'), text: m[2].trim(), pinned: false });
        n++;
      }
    });
    toast(n ? `Added ${n} note${n > 1 ? 's' : ''}` : 'Use “Band: note”, one per line', !n);
    if (n) main.querySelector('#bulkNotes').value = '';
  },

  csevents() {
    csCall('events', async () => {
      ui.cs.events = await client.api('/api/compsuite/events' + (ui.cs.seasonId ? `?seasonId=${encodeURIComponent(ui.cs.seasonId)}` : ''));
    });
  },
  csimport(el) {
    const comp = el.dataset.comp;
    const target = main.querySelector(`[data-cs-target="${comp}"]`).value;
    csCall('import', async () => {
      const r = await client.api('/api/compsuite/import', { method: 'POST', body: { eventId: ui.cs.eventId, competitionId: comp, roundId: target || null, roundName: el.dataset.name, eventName: ui.cs.event?.name } });
      ui.roundId = r.roundId;
      toast(`Imported ${r.total} entries (${r.added} new, ${r.updated} updated, ${r.removed} removed)`);
    });
  },
  csraw(el) { csCall('raw', async () => { ui.cs.raw = await client.api(`/api/compsuite/events/${ui.cs.eventId}/competitions/${el.dataset.comp}/schedule`); }); },
  async csdisconnect() {
    if (!await ask('Remove the CompetitionSuite key from this server? Imported schedules stay.')) return;
    csCall('disconnect', async () => { ui.cs.status = await client.api('/api/compsuite/config', { method: 'DELETE' }); ui.cs.events = null; ui.cs.event = null; });
  },
  unlink(el) { update((s) => { const r = s.rounds.find((x) => x.id === el.dataset.id); if (r) r.cs = null; }); },
  async syncnow() {
    try {
      const r = await client.api('/api/compsuite/sync', { method: 'POST' });
      const t = (r.results || []).reduce((a, x) => ({ added: a.added + x.added, removed: a.removed + x.removed }), { added: 0, removed: 0 });
      toast(`Synced · ${t.added} new, ${t.removed} removed`);
    } catch (e) { toast(e.message, true); }
  },

  export() {
    const blob = new Blob([JSON.stringify(S(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const name = (S().event.name || 'field-slate').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}-${M.todayISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  async copybackup() {
    try { await navigator.clipboard.writeText(JSON.stringify(S())); toast('Backup copied. Paste it into a .json file to keep it.'); } catch { toast('Copy was blocked by this browser. Use Export instead.', true); }
  },
  async clearsched() {
    if (!await ask('Remove every performance from every round? Bands with notes are kept.')) return;
    update((s) => { s.performances = []; s.rounds.forEach((r) => { r.cs = null; }); s.live = { ...M.DEFAULT_LIVE }; M.pruneBands(s); });
    toast('Schedules cleared');
  },
  async eraseall() {
    if (!await ask('Erase the entire show, including all notes? This cannot be undone.')) return;
    client.replaceAll(M.emptyState());
    toast('Show erased');
  },
  async sample() {
    if (Object.keys(S().bands).length && !await ask('Replace this show with the sample show?')) return;
    client.replaceAll(sampleState());
    ui.roundId = null; ui.bandId = null;
    toast('Sample show loaded');
    go('live');
  },
  async forcelocal() { if (await ask('Switch this browser to standalone? It will stop syncing with the server.')) { setPreferredMode('local'); location.reload(); } },
  forceauto() { setPreferredMode('auto'); location.reload(); },
};

// Field edits (commit on change, i.e. blur/enter)
const CHANGES = {
  activeRound: (v) => update((s) => { s.activeRoundId = v; s.live.mode = 'auto'; s.live.manualId = null; }),
  'event.name': (v) => update((s) => { s.event.name = v.trim(); }),
  'event.venue': (v) => update((s) => { s.event.venue = v.trim(); }),
  'round.name': (v) => update((s) => { const r = s.rounds.find((x) => x.id === ui.roundId); if (r) r.name = v.trim() || r.name; }),
  'round.date': (v) => update((s) => { const r = s.rounds.find((x) => x.id === ui.roundId); if (r && v) r.date = v; }),
  'perf.time': (v, el) => update((s) => { const p = s.performances.find((x) => x.id === perfOf(el)); const t = M.normalizeClock(v); if (p && t) p.time = t; }),
  'perf.label': (v, el) => update((s) => { const p = s.performances.find((x) => x.id === perfOf(el)); if (p) p.label = v.trim() || 'Break'; }),
  'perf.division': (v, el) => update((s) => { const p = s.performances.find((x) => x.id === perfOf(el)); if (p) p.division = v.trim(); }),
  'perf.hometown': (v, el) => update((s) => { const p = s.performances.find((x) => x.id === perfOf(el)); if (p && s.bands[p.bandId]) s.bands[p.bandId].hometown = v.trim(); }),
  'perf.band': (v, el) => update((s) => {
    const p = s.performances.find((x) => x.id === perfOf(el));
    const name = v.trim();
    if (!p || !name) return;
    // Typing a name that already exists links to that band (and its notes) instead of renaming.
    const existing = M.findBand(s, { name });
    if (existing && existing.id !== p.bandId) p.bandId = existing.id;
    else if (s.bands[p.bandId]) s.bands[p.bandId].name = name;
    M.pruneBands(s);
  }),
  'band.name': (v, el) => update((s) => { const b = s.bands[el.dataset.band]; if (b && v.trim()) b.name = v.trim(); }),
  'band.hometown': (v, el) => update((s) => { const b = s.bands[el.dataset.band]; if (b) b.hometown = v.trim(); }),
  'note.text': (v, el) => update((s) => {
    const b = s.bands[el.dataset.band];
    if (!b) return;
    if (!v.trim()) b.notes = b.notes.filter((n) => n.id !== el.dataset.note);
    else { const n = b.notes.find((x) => x.id === el.dataset.note); if (n) n.text = v.trim(); }
  }),
  'live.hold': (v, el) => update((s) => { s.live.hold = el.checked; }),
  'live.banner': (v, el) => update((s) => { s.live.banner = el.checked; }),
  'live.message': (v) => update((s) => { s.live.message = v.trim(); }),
  'sync.autoSync': (v, el) => update((s) => { s.sync.autoSync = el.checked; }),
  'sync.intervalSec': (v) => update((s) => { s.sync.intervalSec = Number(v); }),
  'cs.season': (v) => { ui.cs.seasonId = v; ui.cs.events = null; ui.cs.event = null; ACTIONS.csevents(); },
  'cs.event': (v) => {
    ui.cs.eventId = v; ui.cs.event = null; ui.cs.raw = null;
    if (v) csCall('event', async () => { ui.cs.event = await client.api(`/api/compsuite/events/${v}`); });
    else render(true);
  },
  importfile: async (v, el) => {
    const file = el.files?.[0];
    if (!file) return;
    try {
      const doc = JSON.parse(await file.text());
      if (!doc || !Array.isArray(doc.rounds)) throw new Error('Not a Field Slate backup');
      if (!await ask(`Replace this show with “${doc.event?.name || file.name}”?`)) return;
      client.replaceAll(doc);
      toast('Backup imported');
    } catch (e) { toast(e.message, true); }
  },
};

main.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !main.contains(el)) return;
  ACTIONS[el.dataset.act]?.(el, e);
});
main.addEventListener('change', (e) => {
  const el = e.target;
  const key = el.dataset.change;
  if (!key) return;
  if (key.startsWith('set.')) {
    const k = key.slice(4);
    update((s) => { s.settings[k] = el.type === 'checkbox' ? el.checked : el.value; });
    return;
  }
  CHANGES[key]?.(el.value, el);
});
main.addEventListener('input', (e) => {
  if (e.target.id === 'bandSearch') {
    ui.bandQuery = e.target.value;
    const pos = e.target.selectionStart;
    render(true);
    const s = main.querySelector('#bandSearch');
    s.focus(); s.setSelectionRange(pos, pos);
  }
  if (e.target.id === 'importText') ui.importText = e.target.value;
  if (e.target.matches('textarea.auto')) autosize(e.target);
});
main.addEventListener('keydown', (e) => {
  // Enter commits single-line fields; Enter in a note commits instead of adding a newline.
  if (e.key === 'Enter' && e.target.matches('input[data-change], textarea[data-change]')) {
    e.preventDefault();
    e.target.blur();
  }
});
main.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const kind = form.dataset.submit;
  if (kind === 'addnote' || kind === 'quicknote') {
    const text = String(data.text || '').trim();
    if (!text) return;
    update((s) => { s.bands[form.dataset.band]?.notes.push({ id: M.uid('n_'), text, pinned: false }); });
    ui.focus = `[data-submit="${kind}"] input[name=text]`;
    render(true);
  }
  if (kind === 'csconnect') {
    csCall('connect', async () => { ui.cs.status = await client.api('/api/compsuite/config', { method: 'POST', body: data }); ui.cs.seasons = null; loadCsStatus(); toast('CompetitionSuite connected'); });
  }
  if (kind === 'setpin') {
    try { await client.setPin(String(data.pin || '')); toast(data.pin ? 'PIN set' : 'PIN removed'); render(true); } catch (err) { toast(err.message, true); }
  }
});

// ---------- navigation ----------
function go(t) {
  tab = t;
  renderedTab = null;
  history.replaceState(null, '', '#' + t);
  render(true);
  main.scrollTop = 0;
}
addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS.includes(t) && t !== tab) go(t); });
$('rail').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab); });
addEventListener('resize', () => main.querySelectorAll('.preview').forEach((box) => { const f = box.querySelector('iframe'); if (f) f.style.transform = `scale(${box.clientWidth / 1600})`; }));

// ---------- lock (admin PIN) ----------
$('lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = await client.tryPin($('lockPin').value).catch(() => false);
  if (ok) { $('lock').hidden = true; $('lockErr').textContent = ''; } else $('lockErr').textContent = 'Wrong PIN';
});

// ---------- boot ----------
client.onStatus((s) => {
  conn = s;
  const b = $('connBadge');
  const label = { live: 'Live', local: 'Standalone', offline: 'Offline · saving locally', locked: 'Locked', connecting: 'Connecting' }[s.status] || s.status;
  b.className = 'badge ' + s.status;
  b.textContent = label;
  const needPin = s.status === 'locked' || (s.mode === 'server' && s.health?.pinRequired && !client.getPin());
  $('lock').hidden = !needPin;
  if (needPin) setTimeout(() => $('lockPin').focus(), 50);
});
let first = true;
client.subscribe(() => { if (!first) render(); });
await client.init();
first = false;
if (tab === 'source' && conn.mode === 'server') loadCsStatus();
render(true);
setInterval(liveTick, 500);
if ('serviceWorker' in navigator && client.mode === 'server') navigator.serviceWorker.register('sw.js').catch(() => {});
