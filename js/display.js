import { createClient } from './client.js';
import { computeLive, formatClock, formatCountdown, perfStart } from './model.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const preview = params.get('preview') === '1' || location.hash === '#preview';
document.body.classList.add('display'); // also set here: static hosts may supply their own <body>
if (preview) document.body.classList.add('preview');

const client = createClient();
let conn = { status: 'connecting', mode: 'local' };
let lastKey = '';

function applyTheme(st) {
  const root = document.documentElement;
  root.dataset.theme = st.theme === 'light' ? 'light' : 'dark';
  root.style.setProperty('--accent', st.accent || '#35E0FF');
  root.style.setProperty('--scale', String(st.fontScale || 1));
  $('slate').classList.toggle('grid', !!st.showGrid);
  document.querySelector('meta[name="theme-color"]').content = st.theme === 'light' ? '#F4F6F8' : '#07090C';
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Shrink the band name until it fits in at most two lines and leaves room for
// hometown + countdown (notes may clip; the name never should).
function fitName() {
  const el = $('bandName');
  const box = $('namebox');
  const feature = document.querySelector('.feature');
  const notes = $('notes');
  const notesWas = notes.style.display;
  // Keep room for the notes (up to ~a third of the panel) when there are any.
  const reserve = notes.hidden ? 0 : Math.min(notes.scrollHeight + 8, feature.clientHeight * 0.34);
  notes.style.display = 'none';
  el.style.fontSize = '';
  const max = parseFloat(getComputedStyle(el).fontSize);
  const lh = 0.95;
  let size = max;
  const avail = box.clientWidth;
  const padB = parseFloat(getComputedStyle(feature).paddingBottom);
  // Bottom edge of the last fixed block (feature is the offsetParent: position:relative).
  const used = () => {
    const last = [...feature.children].filter((c) => c !== notes && !c.hidden && c.offsetHeight).at(-1);
    return last ? last.offsetTop + last.offsetHeight + padB : 0;
  };
  for (let i = 0; i < 40; i++) {
    el.style.fontSize = size + 'px';
    const lines = Math.round(el.scrollHeight / (size * lh));
    if (el.scrollWidth <= avail + 1 && lines <= 2 && used() + reserve <= feature.clientHeight + 1) break;
    size *= 0.93;
  }
  notes.style.display = notesWas;
}

function render() {
  const state = client.state;
  const st = state.settings;
  const now = new Date();
  const live = computeLive(state, now);
  const fmt = (d) => formatClock(d, { clock24: st.clock24 });

  // top bar
  $('eventName').textContent = st.showEventName ? (state.event.name || 'Field Slate') : '';
  $('roundName').textContent = st.showRound && live.round ? live.round.name : '';
  $('roundSep').hidden = !(st.showEventName && st.showRound && live.round);
  $('clock').textContent = st.showClock ? formatClock(now, { clock24: st.clock24, seconds: st.showSeconds }) : '';
  const off = live.offset;
  $('offset').hidden = !off;
  $('offset').textContent = off > 0 ? `+${off} min behind` : `${Math.abs(off)} min ahead`;
  const showConn = !preview && conn.mode === 'server' && conn.status === 'offline';
  $('conn').hidden = !showConn;
  $('conn').textContent = 'Offline · last known schedule';

  // covers
  const holding = state.live.hold;
  $('hold').hidden = !holding;
  if (holding) {
    $('holdMsg').textContent = state.live.message || 'Standby';
    $('holdEvent').textContent = [state.event.name, live.round?.name].filter(Boolean).join(' — ');
  }
  const empty = !holding && (live.phase === 'empty' || live.phase === 'done');
  $('empty').hidden = !empty;
  if (live.phase === 'done') {
    $('emptyLabel').textContent = 'Round complete';
    $('emptyMsg').textContent = live.round?.name || 'Complete';
    $('emptySub').textContent = state.event.name || '';
  } else if (live.phase === 'empty') {
    $('emptyLabel').textContent = 'No schedule loaded';
    $('emptyMsg').textContent = 'Field Slate';
    $('emptySub').textContent = 'Open the control panel to add performances or connect CompetitionSuite.';
  }

  $('banner').hidden = holding || !(state.live.banner && state.live.message);
  $('banner').textContent = state.live.message || '';

  const deckOn = st.onDeckCount > 0;
  document.querySelector('.stage').classList.toggle('no-deck', !deckOn);

  const f = live.featured;
  if (!f) return;

  // phase + time
  const phaseEl = $('phase');
  phaseEl.className = 'phase ' + live.phase;
  phaseEl.textContent = { next: 'Up next', on: 'On field', break: 'Break' }[live.phase] || '';
  const sched = perfStart(f.perf, live.round, 0);
  $('ftime').hidden = !st.showTime;
  $('ftime').innerHTML = esc(fmt(f.start)) + (off ? `<span class="was">${esc(fmt(sched))}</span>` : '');
  $('position').hidden = !st.showProgress || !live.position;
  $('position').textContent = live.position ? `${String(live.position).padStart(2, '0')} / ${String(live.total).padStart(2, '0')}` : '';

  // name / hometown / division (re-fit only when the text changes)
  const isBreak = f.perf.kind === 'break';
  const name = isBreak ? (f.perf.label || 'Break') : f.band?.name || '';
  const home = isBreak ? '' : f.band?.hometown || '';
  const key = `${name}|${st.fontScale}|${innerWidth}x${innerHeight}|${deckOn}`;
  $('bandName').textContent = name;
  $('hometown').textContent = st.showHometown ? home : '';
  $('division').textContent = st.showDivision && !isBreak ? f.perf.division : '';
  $('division').hidden = !(st.showDivision && f.perf.division && !isBreak);
  $('bandSub').hidden = !$('hometown').textContent && $('division').hidden;
  if (key !== lastKey) { lastKey = key; requestAnimationFrame(fitName); }

  // countdown + track
  const timer = $('timer');
  timer.hidden = !st.showCountdown;
  const ms = live.countdownMs;
  timer.classList.toggle('on', live.phase === 'on');
  timer.classList.toggle('late', live.phase === 'next' && ms < 60_000);
  $('countdown').textContent = formatCountdown(ms);
  $('countLabel').textContent = live.phase === 'on' ? 'since step-off' : isBreak ? 'until break' : 'until step-off';
  let pct = 0;
  if (live.phase === 'on') {
    const win = Math.max(1, st.advanceAfterMin) * 60000;
    pct = Math.min(1, -ms / win);
  } else {
    const prev = live.index > 0 ? live.list[live.index - 1].start.getTime() : f.start.getTime() - 15 * 60000;
    const span = Math.max(60000, f.start.getTime() - prev);
    pct = Math.min(1, Math.max(0, 1 - ms / span));
  }
  $('trackFill').style.width = (pct * 100).toFixed(2) + '%';

  // notes (pinned first)
  const notes = isBreak ? [] : [...(f.band?.notes || [])].sort((a, b) => Number(b.pinned) - Number(a.pinned)).slice(0, st.maxNotes);
  $('notes').hidden = !st.showNotes || !notes.length;
  const notesHtml = notes.map((n) => `<li class="${n.pinned ? 'pin' : ''}">${esc(n.text)}</li>`).join('');
  if ($('noteList').innerHTML !== notesHtml) $('noteList').innerHTML = notesHtml;

  // on deck
  const deckHtml = live.onDeck.map((x) => {
    if (x.perf.kind === 'break') return `<li class="brk"><span class="t">${esc(fmt(x.start))}</span><span class="n">${esc(x.perf.label || 'Break')}</span></li>`;
    const nn = x.band?.notes?.length ? `<span class="nn">${x.band.notes.length} note${x.band.notes.length > 1 ? 's' : ''}</span>` : '';
    return `<li><span class="t">${esc(fmt(x.start))}</span><span class="n">${esc(x.band?.name)}</span>${st.showOnDeckHometown && x.band?.hometown ? `<span class="h">${esc(x.band.hometown)}</span>` : ''}${nn}</li>`;
  }).join('');
  if ($('deckList').innerHTML !== deckHtml) $('deckList').innerHTML = deckHtml || '<li class="brk"><span class="t">—</span><span class="n">End of round</span></li>';
}

// ---------- full screen, wake lock, idle chrome ----------
const fsEl = document.documentElement;
const canFullscreen = !!(fsEl.requestFullscreen || fsEl.webkitRequestFullscreen);
const isStandalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
function toggleFullscreen() {
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  if (active) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else if (fsEl.requestFullscreen) fsEl.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  else if (fsEl.webkitRequestFullscreen) fsEl.webkitRequestFullscreen();
}
$('btnFull').hidden = !canFullscreen || isStandalone;
$('btnFull').addEventListener('click', toggleFullscreen);

let wakeLock = null;
async function keepAwake() {
  if (preview || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not allowed yet; retried on tap */ }
}
document.addEventListener('visibilitychange', keepAwake);
document.addEventListener('pointerdown', () => { if (!wakeLock || wakeLock.released) keepAwake(); });

let idleT;
function poke() {
  document.body.classList.remove('idle');
  clearTimeout(idleT);
  idleT = setTimeout(() => document.body.classList.add('idle'), 3000);
}
['pointermove', 'pointerdown', 'keydown'].forEach((e) => document.addEventListener(e, poke));
poke();

// iPad/iPhone Safari outside Home Screen mode: explain the one reliable way to go full screen.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
try {
  if (!preview && isIOS && !isStandalone && !localStorage.getItem('fieldslate:iosHint')) $('iosHint').hidden = false;
} catch { /* storage blocked */ }
$('iosHintClose').addEventListener('click', () => { $('iosHint').hidden = true; try { localStorage.setItem('fieldslate:iosHint', '1'); } catch { /* */ } });

// Keyboard: a single-laptop operator can drive the slate without opening the control panel.
document.addEventListener('keydown', (e) => {
  if (preview || e.target.closest('input,textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') toggleFullscreen();
  if (k === 'arrowright' || k === 'arrowleft') {
    const live = computeLive(client.state);
    const list = live.list;
    if (!list.length) return;
    const i = Math.max(0, Math.min(list.length - 1, (live.index < 0 ? list.length : live.index) + (k === 'arrowright' ? 1 : -1)));
    client.update((d) => { d.live.mode = 'manual'; d.live.manualId = list[i].perf.id; });
  }
  if (k === 'a') client.update((d) => { d.live.mode = 'auto'; d.live.manualId = null; });
  if (k === 'h') client.update((d) => { d.live.hold = !d.live.hold; });
});

// ---------- boot ----------
client.onStatus((s) => { conn = s; });
client.subscribe((state) => { applyTheme(state.settings); lastKey = ''; render(); });
await client.init();
render();
setInterval(render, 250);
addEventListener('resize', () => { lastKey = ''; render(); });

if ('serviceWorker' in navigator && client.mode === 'server' && !preview) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
