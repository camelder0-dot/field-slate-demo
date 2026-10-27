// A demo show timed around "now" so the slate is live the moment it loads.
import { emptyState, uid, todayISO } from './model.js';

const BANDS = [
  ['Fishers High School', 'Fishers, IN', ['Giant bear prop rises in the closer', 'Back-to-back state finalist']],
  ['Avon High School', 'Avon, IN', ['Director is a Hall of Fame inductee']],
  ['Carmel High School', 'Carmel, IN', []],
  ['Lawrence Central High School', 'Indianapolis, IN', ['Volcano prop erupts in the closer']],
  ['Broken Arrow High School', 'Broken Arrow, OK', ['Largest band in the field: 320 members']],
  ['Hebron High School', 'Carrollton, TX', []],
  ['Marian Catholic High School', 'Chicago Heights, IL', ['First Grand Nationals appearance since 2019']],
  ['Castle High School', 'Newburgh, IN', []],
  ['William Mason High School', 'Mason, OH', ['Drum major is a senior who started on cymbals']],
  ['Blue Springs High School', 'Blue Springs, MO', []],
];

export function sampleState() {
  const s = emptyState();
  s.demo = true;
  s.event = { name: 'Grand National Championships', venue: 'Lucas Oil Stadium' };
  const prelims = s.rounds[0];
  prelims.name = 'Prelims';
  prelims.date = todayISO();
  const semis = { id: uid('r_'), name: 'Semifinals', date: todayISO(), cs: null };
  s.rounds.push(semis);

  const start = new Date(Date.now() - 16 * 60000);
  start.setSeconds(0, 0);
  const clock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  BANDS.forEach(([name, hometown, notes], i) => {
    const id = uid('b_');
    s.bands[id] = { id, name, hometown, csGroupId: null, notes: notes.map((text, j) => ({ id: uid('n_'), text, pinned: j === 0 && i % 3 === 0 })) };
    const t = new Date(start.getTime() + i * 12 * 60000 + (i >= 5 ? 15 * 60000 : 0));
    s.performances.push({ id: uid('p_'), roundId: prelims.id, kind: 'band', bandId: id, label: '', time: clock(t), division: i % 2 ? 'Class AAAA' : 'Class AAA', csId: null });
    // Same bands in semis, later in the day: their notes follow them automatically.
    const t2 = new Date(start.getTime() + (6 * 60 + i * 15) * 60000);
    s.performances.push({ id: uid('p_'), roundId: semis.id, kind: 'band', bandId: id, label: '', time: clock(t2), division: 'Semifinal', csId: null });
  });
  const brk = new Date(start.getTime() + 5 * 12 * 60000);
  s.performances.push({ id: uid('p_'), roundId: prelims.id, kind: 'break', bandId: null, label: 'Break · Judges reset', time: clock(brk), division: '', csId: null });
  return s;
}
