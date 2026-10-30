'use strict';

/*
 * Frånvarokalender
 *
 * All data ligger i data.json i samma mapp som den här filen. Sidan kan köras på två sätt:
 *  - via server.ps1 (http://...)  -> läser/skriver genom servern
 *  - direkt från disk (file://...) -> läser/skriver data.json med webbläsarens File System Access API
 *
 * Varje sparning höjer "version". Den som sparar måste ha senaste versionen som grund, annars
 * läses filen om och ändringen görs om ovanpå den (så att två personer inte skriver över varandra).
 * Sidan kollar efter ändringar var POLL_MS millisekund och ritar om när någon annan sparat.
 *
 * Frånvaro sparas per datum oberoende av hur många månader som visas, så inget försvinner
 * när visningsperioden ändras.
 */

const POLL_MS = 3000;
const MIN_ROWS = 30;
const MONTH_CHOICES = [1, 2, 3, 6, 9, 12, 18, 24];
const DEFAULT_MONTHS = 6;
const WEEKDAYS = ['må', 'ti', 'on', 'to', 'fr', 'lö', 'sö'];
const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli',
  'augusti', 'september', 'oktober', 'november', 'december'];

const DEFAULT_DATA = () => ({
  version: 0,
  codes: [
    { id: 'c-s', code: 'S', label: 'Sjuk', color: '#f4a3a3' },
    { id: 'c-l', code: 'L', label: 'Ledig / semester', color: '#9fd8a4' },
    { id: 'c-v', code: 'V', label: 'VAB', color: '#ffd28a' },
    { id: 'c-f', code: 'F', label: 'Föräldraledig', color: '#c9b3ec' },
    { id: 'c-u', code: 'U', label: 'Utbildning / kurs', color: '#9cc7f0' },
    { id: 'c-t', code: 'T', label: 'Tjänsteresa', color: '#8fd6cf' },
  ],
  groups: [],
  employees: [],
  holidays: [],
  holidayYears: [],
  entries: {},
});

const $ = id => document.getElementById(id);
const grid = $('grid');
const gridWrap = $('gridWrap');

const state = {
  store: null,
  data: null,       // senast inlästa/sparade data
  pending: [],      // ändringar (funktioner) som inte är sparade än
  viewCache: null,
  flushing: false,
  checking: false,
  year: 0,
  month: 0,
  months: DEFAULT_MONTHS,
  days: [],
  emps: [],         // anställda i den ordning de visas i rutnätet (för markering)
  cells: [],
  sel: null,        // { ar, ac, fr, fc } = ankare + fokus (rad/kolumn-index)
  selEls: [],
  dragging: false,
  renderedDay: '',
  redDays: {},      // röda dagar från data: { 'YYYY-MM-DD': namn }
};

// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------

const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const newId = prefix => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const byName = (a, b) => a.name.localeCompare(b.name, 'sv', { sensitivity: 'base' });

function esc(s) {
  return String(s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function safeColor(c) {
  return /^#[0-9a-f]{6}$/i.test(c) ? c : '#cccccc';
}

function textColor(hex) {
  const n = parseInt(safeColor(hex).slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#1d2330' : '#fff';
}

function codeStyle(color) {
  const bg = safeColor(color);
  return `background-color:${bg};color:${textColor(bg)}`;
}

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  // "version" ska ligga först i filen – servern läser den därifrån.
  return {
    version: Number.isInteger(d.version) ? d.version : 0,
    codes: Array.isArray(d.codes) ? d.codes : [],
    groups: Array.isArray(d.groups) ? d.groups : [],
    employees: Array.isArray(d.employees) ? d.employees : [],
    holidays: Array.isArray(d.holidays) ? d.holidays : [],
    holidayYears: Array.isArray(d.holidayYears) ? d.holidayYears : [], // år som fått svenska helgdagar inlagda
    entries: d.entries && typeof d.entries === 'object' ? d.entries : {},
  };
}

function parseData(text) {
  return text.trim() ? normalize(JSON.parse(text)) : DEFAULT_DATA();
}

const serialize = d => JSON.stringify(d, null, 1);

// Anställda grupperade under sina avskiljare, sorterade i bokstavsordning inom varje grupp.
// Anställda utan (giltig) avskiljare hamnar överst.
function sections(v) {
  const groupIds = new Set(v.groups.map(g => g.id));
  const members = new Map([[null, []], ...v.groups.map(g => [g.id, []])]);
  for (const e of v.employees) members.get(groupIds.has(e.group) ? e.group : null).push(e);
  return [
    { group: null, emps: members.get(null).sort(byName) },
    ...v.groups.map(g => ({ group: g, emps: members.get(g.id).sort(byName) })),
  ];
}

// ---------------------------------------------------------------------------
// Datum och helgdagar
// ---------------------------------------------------------------------------

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoWeek(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3); // torsdag samma vecka
  const firstThu = new Date(t.getFullYear(), 0, 4);
  return 1 + Math.round(((t - firstThu) / 864e5 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
}

function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}

// Svenska helgdagar för ett år. Används bara för att lägga in dem i data – därefter är det
// listan i data.json som gäller, och den kan ändras fritt.
const holidayCache = {};
function swedishHolidays(y) {
  if (holidayCache[y]) return holidayCache[y];
  const h = {};
  const add = (d, name) => { h[dateKey(d)] = name; };
  const easter = easterSunday(y);
  add(new Date(y, 0, 1), 'Nyårsdagen');
  add(new Date(y, 0, 6), 'Trettondedag jul');
  add(addDays(easter, -2), 'Långfredagen');
  add(addDays(easter, -1), 'Påskafton');
  add(easter, 'Påskdagen');
  add(addDays(easter, 1), 'Annandag påsk');
  add(new Date(y, 4, 1), 'Första maj');
  add(addDays(easter, 39), 'Kristi himmelsfärdsdag');
  add(addDays(easter, 49), 'Pingstdagen');
  add(new Date(y, 5, 6), 'Sveriges nationaldag');
  for (let d = 19; d <= 25; d++) {
    const x = new Date(y, 5, d);
    if (x.getDay() === 5) { add(x, 'Midsommarafton'); add(addDays(x, 1), 'Midsommardagen'); }
  }
  for (let d = 31; d <= 37; d++) {
    const x = new Date(y, 9, d); // 31 okt – 6 nov
    if (x.getDay() === 6) add(x, 'Alla helgons dag');
  }
  add(new Date(y, 11, 24), 'Julafton');
  add(new Date(y, 11, 25), 'Juldagen');
  add(new Date(y, 11, 26), 'Annandag jul');
  add(new Date(y, 11, 31), 'Nyårsafton');
  return (holidayCache[y] = h);
}

function dayInfo(d, todayKey) {
  const key = dateKey(d);
  const dow = (d.getDay() + 6) % 7; // 0 = måndag
  const hol = state.redDays[key] || '';
  return {
    date: d, key, dow, hol,
    weekend: dow >= 5,
    closed: dow >= 5 || !!hol, // går inte att fylla i
    today: key === todayKey,
    week: isoWeek(d),
  };
}

function buildDays() {
  const out = [];
  const todayKey = dateKey(new Date());
  const end = new Date(state.year, state.month + state.months, 1);
  for (let d = new Date(state.year, state.month, 1); d < end; d = addDays(d, 1)) out.push(dayInfo(d, todayKey));
  return out;
}

function dayClass(d) {
  return [
    d.hol ? 'hol' : d.weekend ? 'off' : '',
    d.today ? 'today' : '',
    d.date.getDate() === 1 ? 'ms' : d.dow === 0 ? 'mon' : '',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Lagring: server eller fil
// ---------------------------------------------------------------------------

const serverStore = {
  label: 'server',
  async load() {
    const r = await fetch('api/data', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return parseData(await r.text());
  },
  async changed() {
    const r = await fetch('api/version', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return (await r.json()).version !== state.data.version;
  },
  async save(next, baseVersion) {
    const r = await fetch('api/data?base=' + baseVersion, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: serialize(next),
    });
    if (r.status === 409) return false;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return true;
  },
};

const fileStore = {
  label: 'fil',
  dir: null,
  lastModified: 0,
  fileHandle() {
    return this.dir.getFileHandle('data.json', { create: true });
  },
  async read() {
    const file = await (await this.fileHandle()).getFile();
    const text = await file.text();
    return { file, text, data: parseData(text) };
  },
  async load() {
    const { file, data } = await this.read();
    this.lastModified = file.lastModified;
    return data;
  },
  async changed() {
    const file = await (await this.fileHandle()).getFile();
    return file.lastModified !== this.lastModified;
  },
  async save(next, baseVersion) {
    const cur = await this.read();
    if (cur.data.version !== baseVersion) return false;
    if (cur.text.trim()) await this.backup(cur.text);
    const handle = await this.fileHandle();
    const w = await handle.createWritable();
    await w.write(serialize(next));
    await w.close();
    this.lastModified = (await handle.getFile()).lastModified;
    return true;
  },
  // Sparar en kopia per dag i mappen backups/ (första sparningen varje dag).
  async backup(text) {
    try {
      const dir = await this.dir.getDirectoryHandle('backups', { create: true });
      const name = `data-${dateKey(new Date())}.json`;
      try { await dir.getFileHandle(name); return; } catch { /* finns inte än */ }
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    } catch (e) {
      console.warn('Kunde inte skapa backup', e);
    }
  },
};

// Kommer ihåg vald mapp mellan besök (fil-läge).
function idb(mode, value) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('franvarokalender', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const store = req.result.transaction('kv', mode === 'get' ? 'readonly' : 'readwrite').objectStore('kv');
      const r = mode === 'get' ? store.get('dir') : store.put(value, 'dir');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    };
  });
}

// ---------------------------------------------------------------------------
// Ändringar och synkning
// ---------------------------------------------------------------------------

// Data som visas = senast sparade data + ändringar som väntar på att sparas.
function view() {
  if (!state.data) return null;
  if (!state.pending.length) return state.data;
  if (!state.viewCache) {
    const v = normalize(clone(state.data));
    state.pending.forEach(m => m(v));
    state.viewCache = v;
  }
  return state.viewCache;
}

function commit(mutate) {
  if (!state.data) return;
  state.pending.push(mutate);
  state.viewCache = null;
  render();
  flush();
}

async function flush() {
  if (state.flushing) return;
  state.flushing = true;
  setStatus('saving', 'Sparar…');
  try {
    while (state.pending.length) {
      const batch = state.pending.slice();
      const base = state.data;
      const next = normalize(clone(base));
      batch.forEach(m => m(next));
      next.version = base.version + 1;
      if (await state.store.save(next, base.version)) {
        state.data = next;
        state.pending.splice(0, batch.length);
      } else {
        // Någon annan hann spara först – läs om och gör om ändringarna ovanpå deras.
        state.data = await state.store.load();
      }
      state.viewCache = null;
    }
    setStatus('ok');
  } catch (e) {
    console.error(e);
    setStatus('error', 'Kunde inte spara – försöker igen', e);
  } finally {
    state.flushing = false;
    render();
  }
}

async function check() {
  if (state.checking || state.flushing || !state.store) return;
  state.checking = true;
  try {
    if (state.pending.length) {
      state.checking = false;
      await flush();
      return;
    }
    if (!state.data || await state.store.changed()) {
      state.data = await state.store.load();
      state.viewCache = null;
      render();
    } else if (state.renderedDay !== dateKey(new Date())) {
      render(); // ny dag – flytta "idag" och uppdatera statuskolumnen
    }
    setStatus('ok');
  } catch (e) {
    console.error(e);
    setStatus('error', 'Ingen kontakt med datafilen – försöker igen', e);
  } finally {
    state.checking = false;
  }
}

function setStatus(kind, text, err) {
  const el = $('status');
  // Senaste felet ligger kvar (även medan den försöker igen) tills något lyckas.
  if (kind === 'error') state.lastError = err;
  else if (kind === 'ok') state.lastError = null;
  const e = state.lastError;
  el.className = 'status ' + kind;
  el.textContent = (text || 'Uppdaterad ' + new Date().toLocaleTimeString('sv-SE')) +
    (kind === 'error' && e ? ` (${e.name})` : '');
  el.title = (e ? `${e.name}: ${e.message}\n` : '') + 'Läge: ' + (state.store ? state.store.label : '–');
}

function purgeEntries(d, keep) {
  for (const [emp, row] of Object.entries(d.entries)) {
    for (const [date, codeId] of Object.entries(row)) if (!keep(emp, date, codeId)) delete row[date];
    if (!Object.keys(row).length) delete d.entries[emp];
  }
}

const ops = {
  setCells: (cells, codeId) => d => {
    const empIds = new Set(d.employees.map(e => e.id));
    if (codeId && !d.codes.some(c => c.id === codeId)) return;
    for (const { emp, date } of cells) {
      if (!empIds.has(emp)) continue;
      const row = d.entries[emp] || (d.entries[emp] = {});
      if (codeId) row[date] = codeId;
      else delete row[date];
      if (!Object.keys(row).length) delete d.entries[emp];
    }
  },
  addEmployee: (id, name, group) => d => {
    if (!d.employees.some(e => e.id === id)) d.employees.push({ id, name, group });
  },
  updateEmployee: (id, patch) => d => {
    const e = d.employees.find(x => x.id === id);
    if (e) Object.assign(e, patch);
  },
  removeEmployee: id => d => {
    d.employees = d.employees.filter(e => e.id !== id);
    delete d.entries[id];
  },
  addGroup: (id, name) => d => {
    if (!d.groups.some(g => g.id === id)) d.groups.push({ id, name });
  },
  renameGroup: (id, name) => d => {
    const g = d.groups.find(x => x.id === id);
    if (g) g.name = name;
  },
  // Anställda under en borttagen avskiljare flyttas till avsnittet ovanför.
  removeGroup: id => d => {
    const i = d.groups.findIndex(g => g.id === id);
    if (i < 0) return;
    const above = i > 0 ? d.groups[i - 1].id : null;
    for (const e of d.employees) if (e.group === id) e.group = above;
    d.groups.splice(i, 1);
  },
  setHoliday: (date, name) => d => {
    const h = d.holidays.find(x => x.date === date);
    if (h) h.name = name;
    else d.holidays.push({ date, name });
    d.holidays.sort((a, b) => a.date.localeCompare(b.date));
  },
  removeHoliday: date => d => {
    d.holidays = d.holidays.filter(h => h.date !== date);
  },
  // Lägger in svenska helgdagar för år som inte fått dem än (onlyNew) eller lägger tillbaka
  // saknade helgdagar för angivna år. Befintliga datum lämnas orörda.
  addSwedishHolidays: (years, onlyNew) => d => {
    const have = new Set(d.holidays.map(h => h.date));
    for (const y of years) {
      if (onlyNew && d.holidayYears.includes(y)) continue;
      for (const [date, name] of Object.entries(swedishHolidays(y))) {
        if (!have.has(date)) d.holidays.push({ date, name });
      }
      if (!d.holidayYears.includes(y)) d.holidayYears.push(y);
    }
    d.holidayYears.sort((a, b) => a - b);
    d.holidays.sort((a, b) => a.date.localeCompare(b.date));
  },
  addCode: code => d => {
    if (!d.codes.some(c => c.id === code.id)) d.codes.push(code);
  },
  updateCode: (id, patch) => d => {
    const c = d.codes.find(x => x.id === id);
    if (c) Object.assign(c, patch);
  },
  removeCode: id => d => {
    d.codes = d.codes.filter(c => c.id !== id);
    purgeEntries(d, (emp, date, codeId) => codeId !== id);
  },
  move: (list, id, delta) => d => {
    const arr = d[list];
    const i = arr.findIndex(x => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  },
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function todayStatus(e, v, codeById, today) {
  if (today.hol) return `<td class="now dayoff">${esc(today.hol)}</td>`;
  if (today.weekend) return '<td class="now dayoff">Helg</td>';
  const code = codeById.get((v.entries[e.id] || {})[today.key]);
  if (!code) return '<td class="now available">Tillgänglig</td>';
  return `<td class="now" style="${codeStyle(code.color)}" title="${esc(code.label)}">${esc(code.label)}</td>`;
}

function render() {
  const v = view();
  state.redDays = {};
  for (const hd of v ? v.holidays : []) state.redDays[hd.date] = hd.name;
  renderPalette(v);
  state.days = buildDays();
  if (v) ensureHolidayYears(v, state.days);
  state.renderedDay = dateKey(new Date());
  const days = state.days;

  const first = days[0].date, last = days[days.length - 1].date;
  $('rangeLabel').textContent = state.months === 1
    ? `${MONTHS[first.getMonth()]} ${first.getFullYear()}`
    : `${MONTHS[first.getMonth()].slice(0, 3)} ${first.getFullYear()} – ${MONTHS[last.getMonth()].slice(0, 3)} ${last.getFullYear()}`;

  if (!v) {
    grid.innerHTML = '';
    state.cells = [];
    state.emps = [];
    return;
  }

  const codeById = new Map(v.codes.map(c => [c.id, c]));
  const today = dayInfo(new Date(), state.renderedDay);
  const groups = (keyFn) => {
    const out = [];
    for (const d of days) {
      const k = keyFn(d);
      if (out.length && out[out.length - 1].key === k) out[out.length - 1].n++;
      else out.push({ key: k, d, n: 1 });
    }
    return out;
  };

  let h = '<thead><tr><th class="name" rowspan="3">Anställd</th><th class="now" rowspan="3">Idag</th>';
  for (const g of groups(d => d.date.getFullYear() * 12 + d.date.getMonth())) {
    h += `<th class="month ms" colspan="${g.n}"><span>${MONTHS[g.d.date.getMonth()]} ${g.d.date.getFullYear()}</span></th>`;
  }
  h += '</tr><tr>';
  for (const g of groups(d => d.week)) {
    const cls = g.d.date.getDate() === 1 ? 'ms' : g.d.dow === 0 ? 'mon' : '';
    h += `<th class="week ${cls}" colspan="${g.n}" title="Vecka ${g.d.week}">${g.n >= 2 ? 'v.' + g.d.week : g.d.week}</th>`;
  }
  h += '</tr><tr>';
  for (const d of days) {
    h += `<th class="day ${dayClass(d)}" title="${esc(d.key + (d.hol ? ' – ' + d.hol : ''))}">${d.date.getDate()}<small>${WEEKDAYS[d.dow]}</small></th>`;
  }
  h += '</tr></thead><tbody>';

  // Tomma rutor återanvänds för alla rader – bygg strängen en gång.
  const emptyCells = days.map(d => `<td class="${dayClass(d)}"></td>`).join('');
  const emps = [];
  let rows = 0;

  for (const s of sections(v)) {
    if (s.group) {
      h += `<tr class="sep"><th class="name" colspan="2" title="${esc(s.group.name)}">${esc(s.group.name)}</th><td colspan="${days.length}"></td></tr>`;
      rows++;
    }
    for (const e of s.emps) {
      const r = emps.length;
      emps.push(e);
      rows++;
      const row = v.entries[e.id] || {};
      h += `<tr><th class="name" title="${esc(e.name)}">${esc(e.name)}</th>${todayStatus(e, v, codeById, today)}`;
      days.forEach((d, c) => {
        const code = !d.closed && codeById.get(row[d.key]);
        if (code) {
          h += `<td class="cell ${dayClass(d)}" data-r="${r}" data-c="${c}" style="${codeStyle(code.color)}" title="${esc(`${e.name} · ${d.key} · ${code.label}`)}">${esc(code.code)}</td>`;
        } else {
          h += `<td class="cell ${dayClass(d)}" data-r="${r}" data-c="${c}"></td>`;
        }
      });
      h += '</tr>';
    }
  }

  // Fyll ut med tomma rader så att rutnätet alltid har minst MIN_ROWS rader.
  for (; rows < MIN_ROWS; rows++) {
    const label = rows === 0 ? 'Lägg till anställda via knappen Anställda' : '';
    h += `<tr class="filler"><th class="name">${label}</th><td class="now"></td>${emptyCells}</tr>`;
  }
  h += '</tbody>';

  const available = today.closed ? 0
    : emps.filter(e => !codeById.has((v.entries[e.id] || {})[today.key])).length;
  h += `<tfoot><tr><th class="name">Frånvarande</th><td class="now">${
    emps.length && !today.closed ? `${available} av ${emps.length} tillgängliga` : ''}</td>`;
  for (const d of days) {
    const n = d.closed ? 0 : emps.filter(e => codeById.has((v.entries[e.id] || {})[d.key])).length;
    h += `<td class="${dayClass(d)}">${n || ''}</td>`;
  }
  h += '</tr></tfoot>';

  grid.innerHTML = h;
  state.emps = emps;
  state.cells = Array.from(grid.querySelectorAll('td.cell'));
  state.selEls = [];
  if (state.sel) {
    const maxR = emps.length - 1, maxC = days.length - 1;
    if (maxR < 0) state.sel = null;
    else for (const k of ['ar', 'fr']) state.sel[k] = clamp(state.sel[k], 0, maxR);
    if (state.sel) for (const k of ['ac', 'fc']) state.sel[k] = clamp(state.sel[k], 0, maxC);
  }
  paintSel();
  refreshDialogs(v);
}

// Första gången ett år visas (eller närmar sig) läggs dess svenska helgdagar in i data.
const holidayYearsQueued = new Set();
function ensureHolidayYears(v, days) {
  const thisYear = new Date().getFullYear();
  const years = new Set([thisYear, thisYear + 1, thisYear + 2]);
  for (const d of days) years.add(d.date.getFullYear());
  const missing = [...years].filter(y => !v.holidayYears.includes(y) && !holidayYearsQueued.has(y));
  if (!missing.length) return;
  missing.forEach(y => holidayYearsQueued.add(y));
  setTimeout(() => commit(ops.addSwedishHolidays(missing, true)));
}

function renderPalette(v) {
  const codes = v ? v.codes : [];
  $('palette').innerHTML =
    codes.map(c =>
      `<button class="chip" data-code="${esc(c.id)}" style="${codeStyle(c.color)}" title="Tryck ${esc(c.code)} på tangentbordet"><b>${esc(c.code)}</b> ${esc(c.label)}</button>`
    ).join('') +
    '<button class="chip clear" data-code="" title="Delete / Backspace">Rensa</button>' +
    '<span class="hint">Markera dagar (klicka och dra), tryck sedan kodens bokstav eller klicka på en kod. Helger och röda dagar kan inte fyllas i.</span>';
}

// ---------------------------------------------------------------------------
// Markering och inmatning i rutnätet
// ---------------------------------------------------------------------------

function selRect() {
  const s = state.sel;
  return {
    r0: Math.min(s.ar, s.fr), r1: Math.max(s.ar, s.fr),
    c0: Math.min(s.ac, s.fc), c1: Math.max(s.ac, s.fc),
  };
}

function paintSel() {
  state.selEls.forEach(el => el.classList.remove('sel'));
  state.selEls = [];
  if (!state.sel) return;
  const cols = state.days.length;
  const { r0, r1, c0, c1 } = selRect();
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const el = state.cells[r * cols + c];
      if (el) { el.classList.add('sel'); state.selEls.push(el); }
    }
  }
}

function applyCode(codeId) {
  if (!view() || !state.sel) return;
  const { r0, r1, c0, c1 } = selRect();
  const cells = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const d = state.days[c];
      // Helger och röda dagar fylls aldrig i (men rensas, ifall något ligger kvar där).
      if (codeId && d.closed) continue;
      cells.push({ emp: state.emps[r].id, date: d.key });
    }
  }
  if (cells.length) commit(ops.setCells(cells, codeId));
}

let typed = '';
let typedTimer = null;
function typeCode(ch, v) {
  clearTimeout(typedTimer);
  typed += ch;
  const norm = c => c.code.toUpperCase();
  const exact = v.codes.find(c => norm(c) === typed);
  const longer = v.codes.some(c => norm(c) !== typed && norm(c).startsWith(typed));
  if (!exact && !longer && typed.length > 1) {
    typed = '';
    typeCode(ch, v);
    return;
  }
  if (!longer) {
    if (exact) applyCode(exact.id);
    typed = '';
    return;
  }
  // Det finns längre koder som börjar likadant (t.ex. "C" och "CL") – vänta lite på nästa tangent.
  typedTimer = setTimeout(() => {
    if (exact) applyCode(exact.id);
    typed = '';
  }, 700);
}

function cellPos(target) {
  const td = target.closest && target.closest('td.cell');
  return td ? { r: +td.dataset.r, c: +td.dataset.c } : null;
}

grid.addEventListener('mousedown', e => {
  const p = cellPos(e.target);
  if (!p || e.button !== 0) return;
  e.preventDefault();
  gridWrap.focus({ preventScroll: true });
  if (e.shiftKey && state.sel) Object.assign(state.sel, { fr: p.r, fc: p.c });
  else state.sel = { ar: p.r, ac: p.c, fr: p.r, fc: p.c };
  state.dragging = true;
  paintSel();
});

grid.addEventListener('mouseover', e => {
  if (!state.dragging) return;
  const p = cellPos(e.target);
  if (!p || (p.r === state.sel.fr && p.c === state.sel.fc)) return;
  Object.assign(state.sel, { fr: p.r, fc: p.c });
  paintSel();
});

window.addEventListener('mouseup', () => { state.dragging = false; });

// Dra med musen i rubrikerna eller namnkolumnen för att scrolla rutnätet åt sidan.
// (Pekskärm och pekplatta scrollar redan med vanliga svep.)
let pan = null;
let panMoved = false;
let pressOnCell = false;
gridWrap.addEventListener('pointerdown', e => {
  panMoved = false;
  pressOnCell = !!e.target.closest('td.cell');
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  if (!e.target.closest('thead th, tbody th.name, tbody td.now, tr.sep, tr.filler')) return;
  pan = { x: e.clientX, y: e.clientY, left: gridWrap.scrollLeft, top: gridWrap.scrollTop, id: e.pointerId };
  gridWrap.setPointerCapture(e.pointerId);
  gridWrap.classList.add('panning');
  e.preventDefault();
});
gridWrap.addEventListener('pointermove', e => {
  if (!pan || e.pointerId !== pan.id) return;
  const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) panMoved = true;
  gridWrap.scrollLeft = pan.left - dx;
  gridWrap.scrollTop = pan.top - dy;
});
const endPan = e => {
  if (!pan || e.pointerId !== pan.id) return;
  pan = null;
  gridWrap.classList.remove('panning');
};
gridWrap.addEventListener('pointerup', endPan);
gridWrap.addEventListener('pointercancel', endPan);

// Klick utanför de ifyllbara rutorna (tomma rader, namn, rubriker …) tar bort markeringen.
// Att dra för att scrolla räknas inte som klick, och inte heller att dra en markering över flera
// rutor (då hamnar klicket på raden i stället för på en ruta).
gridWrap.addEventListener('click', e => {
  if (panMoved || pressOnCell || e.target.closest('td.cell') || !state.sel) return;
  state.sel = null;
  paintSel();
});

document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]') || e.target.closest('input, select, textarea')) return;
  if (!state.sel || e.ctrlKey || e.metaKey || e.altKey) return;
  const v = view();
  if (!v) return;

  const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (moves[e.key]) {
    e.preventDefault();
    const [dr, dc] = moves[e.key];
    const r = clamp(state.sel.fr + dr, 0, state.emps.length - 1);
    const c = clamp(state.sel.fc + dc, 0, state.days.length - 1);
    if (e.shiftKey) Object.assign(state.sel, { fr: r, fc: c });
    else state.sel = { ar: r, ac: c, fr: r, fc: c };
    paintSel();
    const el = state.cells[r * state.days.length + c];
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    applyCode(null);
    return;
  }
  if (e.key === 'Escape') {
    state.sel = null;
    paintSel();
    return;
  }
  if (e.key.length === 1 && /\S/.test(e.key)) {
    e.preventDefault();
    typeCode(e.key.toUpperCase(), v);
  }
});

$('palette').addEventListener('mousedown', e => e.preventDefault()); // behåll fokus i rutnätet
$('palette').addEventListener('click', e => {
  const btn = e.target.closest('button[data-code]');
  if (btn) applyCode(btn.dataset.code || null);
});

// ---------------------------------------------------------------------------
// Navigering och tema
// ---------------------------------------------------------------------------

function goToMonth(year, month) {
  const d = new Date(year, month, 1);
  state.year = d.getFullYear();
  state.month = d.getMonth();
  state.sel = null;
  render();
}

function scrollToToday() {
  const th = grid.querySelector('thead th.today');
  const fixed = grid.querySelector('thead th.name').offsetWidth + grid.querySelector('thead th.now').offsetWidth;
  gridWrap.scrollLeft = th ? Math.max(0, th.offsetLeft - fixed - 3 * th.offsetWidth) : 0;
}

$('prev').addEventListener('click', () => goToMonth(state.year, state.month - 1));
$('next').addEventListener('click', () => goToMonth(state.year, state.month + 1));
$('today').addEventListener('click', () => {
  const now = new Date();
  goToMonth(now.getFullYear(), now.getMonth());
  scrollToToday();
});
$('monthsSel').addEventListener('change', e => {
  state.months = +e.target.value;
  try { localStorage.setItem('franvaro.manader', state.months); } catch { /* ignoreras */ }
  state.sel = null;
  render();
});

function showThemeButton() {
  const dark = document.documentElement.dataset.theme !== 'light';
  $('btnTheme').textContent = dark ? '☀ Ljust' : '☾ Mörkt';
}
$('btnTheme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('franvaro.tema', next); } catch { /* ignoreras */ }
  showThemeButton();
});

// ---------------------------------------------------------------------------
// Dialog: anställda och avskiljare
// ---------------------------------------------------------------------------

const dlgEmployees = $('dlgEmployees');
const dlgCodes = $('dlgCodes');

function moveButtons(i, len) {
  return `<button type="button" data-act="up" title="Flytta upp" ${i === 0 ? 'disabled' : ''}>↑</button>` +
    `<button type="button" data-act="down" title="Flytta ner" ${i === len - 1 ? 'disabled' : ''}>↓</button>`;
}

function groupOptions(v, selected) {
  return `<option value="">${v.groups.length ? '(överst, ingen avskiljare)' : '(ingen avskiljare)'}</option>` +
    v.groups.map(g => `<option value="${esc(g.id)}" ${g.id === selected ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
}

function renderEmployeeList(v) {
  let h = '';
  sections(v).forEach(s => {
    if (s.group) {
      const i = v.groups.indexOf(s.group);
      h += `<li class="sep-item" data-group="${esc(s.group.id)}">
        <span class="tag">Avskiljare</span>
        <input class="gname" value="${esc(s.group.name)}" aria-label="Namn på avskiljare">
        ${moveButtons(i, v.groups.length)}
        <button type="button" data-act="del-group" class="danger">Ta bort</button>
      </li>`;
    }
    for (const e of s.emps) {
      h += `<li class="emp-item" data-id="${esc(e.id)}">
        <input class="name" value="${esc(e.name)}" aria-label="Namn">
        ${v.groups.length ? `<select class="group" aria-label="Avskiljare">${groupOptions(v, s.group && s.group.id)}</select>` : ''}
        <button type="button" data-act="del" class="danger">Ta bort</button>
      </li>`;
    }
    if (s.group && !s.emps.length) h += '<li class="section-note">Inga anställda under den här avskiljaren än.</li>';
  });
  $('empList').innerHTML = h || '<li class="muted">Inga anställda ännu.</li>';

  const sel = $('empAdd').elements.group;
  const keep = sel.value;
  sel.innerHTML = groupOptions(v, keep);
  sel.hidden = !v.groups.length;
}

$('btnEmployees').addEventListener('click', () => {
  const v = view();
  if (!v) return;
  renderEmployeeList(v);
  dlgEmployees.showModal();
  $('empAdd').elements.name.focus();
});

$('empAdd').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target.elements;
  const name = f.name.value.trim();
  if (!name) return;
  commit(ops.addEmployee(newId('e-'), name, f.group.value || null));
  f.name.value = '';
  f.name.focus();
  renderEmployeeList(view());
});

$('groupAdd').addEventListener('submit', e => {
  e.preventDefault();
  const input = e.target.elements.name;
  const name = input.value.trim();
  if (!name) return;
  const id = newId('g-');
  commit(ops.addGroup(id, name));
  input.value = '';
  renderEmployeeList(view());
  $('empAdd').elements.group.value = id; // nya anställda hamnar under den nya avskiljaren
});

$('empList').addEventListener('change', e => {
  const t = e.target;
  const v = view();
  if (t.matches('input.name')) {
    const id = t.closest('li').dataset.id;
    const emp = v.employees.find(x => x.id === id);
    const name = t.value.trim();
    if (!name) { t.value = emp ? emp.name : ''; return; }
    commit(ops.updateEmployee(id, { name }));
  } else if (t.matches('select.group')) {
    commit(ops.updateEmployee(t.closest('li').dataset.id, { group: t.value || null }));
  } else if (t.matches('input.gname')) {
    const id = t.closest('li').dataset.group;
    const g = v.groups.find(x => x.id === id);
    const name = t.value.trim();
    if (!name) { t.value = g ? g.name : ''; return; }
    commit(ops.renameGroup(id, name));
  } else {
    return;
  }
  renderEmployeeList(view()); // sortera om efter namnbyte/flytt
});

$('empList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const li = btn.closest('li');
  const v = view();
  const act = btn.dataset.act;

  if (li.dataset.group) {
    const g = v.groups.find(x => x.id === li.dataset.group);
    if (!g) return;
    if (act === 'del-group') {
      const n = v.employees.filter(x => x.group === g.id).length;
      if (!confirm(`Ta bort avskiljaren "${g.name}"?` +
        (n ? `\n\n${n} anställd(a) under den flyttas till avsnittet ovanför.` : ''))) return;
      commit(ops.removeGroup(g.id));
    } else {
      commit(ops.move('groups', g.id, act === 'up' ? -1 : 1));
    }
  } else if (act === 'del') {
    const emp = v.employees.find(x => x.id === li.dataset.id);
    if (emp) confirmDeleteEmployee(emp);
    return;
  }
  renderEmployeeList(view());
});

// Borttagning av anställd kräver att namnet skrivs in exakt.
const dlgDelete = $('dlgDelete');
let deleteTarget = null;

function confirmDeleteEmployee(emp) {
  deleteTarget = { id: emp.id, name: emp.name };
  $('delName').textContent = emp.name;
  $('delInput').value = '';
  $('delOk').disabled = true;
  dlgDelete.showModal();
  $('delInput').focus();
}

$('delInput').addEventListener('input', e => {
  $('delOk').disabled = !deleteTarget || e.target.value !== deleteTarget.name;
});
$('delCancel').addEventListener('click', () => dlgDelete.close());
dlgDelete.addEventListener('close', () => { deleteTarget = null; });
$('delForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!deleteTarget || $('delInput').value !== deleteTarget.name) return;
  commit(ops.removeEmployee(deleteTarget.id));
  dlgDelete.close();
  renderEmployeeList(view());
});

// ---------------------------------------------------------------------------
// Dialog: frånvarokoder
// ---------------------------------------------------------------------------

function renderCodeList(v) {
  $('codeList').innerHTML = v.codes.map((c, i) =>
    `<li data-id="${esc(c.id)}">
      <input class="code" value="${esc(c.code)}" maxlength="3" aria-label="Kod">
      <input class="label" value="${esc(c.label)}" aria-label="Beskrivning">
      <input class="color" type="color" value="${safeColor(c.color)}" aria-label="Färg">
      ${moveButtons(i, v.codes.length)}
      <button type="button" data-act="del" class="danger">Ta bort</button>
    </li>`).join('') || '<li class="muted">Inga koder ännu.</li>';
}

// Uppdatera öppna dialoger när data ändras, men inte medan någon skriver i dem.
function refreshDialogs(v) {
  const typing = el => el.contains(document.activeElement) && document.activeElement.matches('input, select');
  if (dlgEmployees.open && !typing(dlgEmployees)) renderEmployeeList(v);
  if (dlgCodes.open && !typing(dlgCodes)) renderCodeList(v);
  if (dlgHolidays.open && !typing(dlgHolidays)) renderHolidayList(v);
}

function validCode(raw, v, exceptId) {
  const code = raw.trim().toUpperCase();
  if (!code) { alert('Koden får inte vara tom.'); return null; }
  if (v.codes.some(c => c.id !== exceptId && c.code.toUpperCase() === code)) {
    alert(`Koden "${code}" används redan.`);
    return null;
  }
  return code;
}

$('btnCodes').addEventListener('click', () => {
  const v = view();
  if (!v) return;
  renderCodeList(v);
  dlgCodes.showModal();
  $('codeAdd').elements.code.focus();
});

$('codeAdd').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target.elements;
  const code = validCode(f.code.value, view());
  const label = f.label.value.trim();
  if (!code || !label) return;
  commit(ops.addCode({ id: newId('c-'), code, label, color: safeColor(f.color.value) }));
  f.code.value = '';
  f.label.value = '';
  f.code.focus();
  renderCodeList(view());
});

$('codeList').addEventListener('change', e => {
  const li = e.target.closest('li');
  if (!li) return;
  const id = li.dataset.id;
  const v = view();
  const cur = v.codes.find(c => c.id === id);
  if (!cur) return;
  if (e.target.matches('input.code')) {
    const code = validCode(e.target.value, v, id);
    if (!code) { e.target.value = cur.code; return; }
    e.target.value = code;
    commit(ops.updateCode(id, { code }));
  } else if (e.target.matches('input.label')) {
    const label = e.target.value.trim();
    if (!label) { e.target.value = cur.label; return; }
    commit(ops.updateCode(id, { label }));
  } else if (e.target.matches('input.color')) {
    commit(ops.updateCode(id, { color: safeColor(e.target.value) }));
  }
});

$('codeList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const v = view();
  const code = v.codes.find(c => c.id === id);
  if (!code) return;
  if (btn.dataset.act === 'del') {
    let used = 0;
    for (const row of Object.values(v.entries)) for (const c of Object.values(row)) if (c === id) used++;
    const msg = `Ta bort koden ${code.code} (${code.label})?` +
      (used ? `\n\nDen är ifylld på ${used} dag(ar), de rutorna töms.` : '');
    if (!confirm(msg)) return;
    commit(ops.removeCode(id));
  } else {
    commit(ops.move('codes', id, btn.dataset.act === 'up' ? -1 : 1));
  }
  renderCodeList(view());
});

// ---------------------------------------------------------------------------
// Dialog: röda dagar
// ---------------------------------------------------------------------------

const dlgHolidays = $('dlgHolidays');
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && dateKey(new Date(s + 'T00:00')) === s;

function formatDate(key) {
  return new Date(key + 'T00:00').toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// Alla röda dagar ligger i data och kan döpas om eller tas bort fritt.
function renderHolidayList(v) {
  const todayKey = dateKey(new Date());
  const showPast = $('holShowPast').checked;
  const items = v.holidays
    .filter(h => validDate(h.date) && (showPast || h.date >= todayKey))
    .sort((a, b) => a.date.localeCompare(b.date));

  $('holList').innerHTML = items.map(h =>
    `<li data-date="${esc(h.date)}" class="${h.date < todayKey ? 'past' : ''}">
      <span class="hdate">${esc(formatDate(h.date))}</span>
      <input class="hname" value="${esc(h.name)}" aria-label="Namn">
      <button type="button" data-act="del" class="danger">Ta bort</button>
    </li>`).join('') || '<li class="muted">Inga kommande röda dagar.</li>';
}

$('btnHolidays').addEventListener('click', () => {
  const v = view();
  if (!v) return;
  renderHolidayList(v);
  dlgHolidays.showModal();
  $('holAdd').elements.date.focus();
});

$('holAdd').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target.elements;
  const date = f.date.value;
  const name = f.name.value.trim();
  if (!validDate(date) || !name) return;
  const existing = view().holidays.find(h => h.date === date);
  if (existing && !confirm(`${formatDate(date)} är redan röd dag (${existing.name}).\n\nVill du byta namn till "${name}"?`)) return;
  commit(ops.setHoliday(date, name));
  f.date.value = '';
  f.name.value = '';
  f.date.focus();
  renderHolidayList(view());
});

$('holList').addEventListener('change', e => {
  if (!e.target.matches('input.hname')) return;
  const date = e.target.closest('li').dataset.date;
  const h = view().holidays.find(x => x.date === date);
  const name = e.target.value.trim();
  if (!name) { e.target.value = h ? h.name : ''; return; }
  commit(ops.setHoliday(date, name));
});

$('holList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act="del"]');
  if (!btn) return;
  const date = btn.closest('li').dataset.date;
  const h = view().holidays.find(x => x.date === date);
  if (!h || !confirm(`Ta bort den röda dagen ${formatDate(date)} (${h.name})?\n\nDagen blir en vanlig arbetsdag.`)) return;
  commit(ops.removeHoliday(date));
  renderHolidayList(view());
});

$('holShowPast').addEventListener('change', () => renderHolidayList(view()));

// Lägger tillbaka svenska helgdagar som tagits bort, för i år och två år framåt.
$('holRestore').addEventListener('click', () => {
  const v = view();
  const y = new Date().getFullYear();
  const todayKey = dateKey(new Date());
  const have = new Set(v.holidays.map(h => h.date));
  const missing = [y, y + 1, y + 2]
    .flatMap(year => Object.entries(swedishHolidays(year)))
    .filter(([date]) => date >= todayKey && !have.has(date));
  if (!missing.length) { alert(`Alla svenska helgdagar ${y}–${y + 2} finns redan med.`); return; }
  const list = missing.map(([date, name]) => `${formatDate(date)}  ${name}`).join('\n');
  if (!confirm(`Lägga tillbaka ${missing.length} helgdag(ar)?\n\n${list}`)) return;
  commit(ops.addSwedishHolidays([y, y + 1, y + 2], false));
  renderHolidayList(view());
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start(store) {
  state.store = store;
  $('connect').hidden = true;
  setStatus('saving', 'Läser in…');
  await check();
  scrollToToday();
  setInterval(check, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
}

async function initFileMode() {
  const overlay = $('connect');
  const msg = $('connectMsg');
  const btn = $('connectBtn');
  const other = $('pickOther');
  overlay.hidden = false;

  if (!window.showDirectoryPicker) {
    msg.innerHTML = 'Den här webbläsaren kan inte spara direkt till nätverksdisken. ' +
      'Öppna sidan i <b>Microsoft Edge</b> eller <b>Google Chrome</b>, eller använd serverläget (se LÄSMIG.md).';
    btn.hidden = true;
    return;
  }

  let saved = null;
  try { saved = await idb('get'); } catch { /* ingen sparad mapp */ }

  if (saved) {
    try {
      if (await saved.queryPermission({ mode: 'readwrite' }) === 'granted') {
        fileStore.dir = saved;
        return start(fileStore);
      }
    } catch { saved = null; }
  }

  if (saved) {
    msg.innerHTML = `Webbläsaren behöver tillåtelse att läsa och spara i mappen <b>${esc(saved.name)}</b> igen.`;
    btn.textContent = 'Fortsätt';
    other.hidden = false;
  } else {
    msg.innerHTML = 'Första gången behöver du peka ut mappen där kalendern ligger ' +
      '(samma mapp som <b>index.html</b> och <b>data.json</b> på nätverksdisken). Webbläsaren kommer ihåg valet.';
  }

  const pick = async () => {
    const dir = await window.showDirectoryPicker({ id: 'franvarokalender', mode: 'readwrite' });
    const has = async name => { try { await dir.getFileHandle(name); return true; } catch { return false; } };
    if (!(await has('data.json')) && !(await has('index.html')) &&
        !confirm(`Mappen "${dir.name}" innehåller ingen kalender (data.json).\n\nVill du skapa en ny, tom kalender där?`)) return;
    try { await idb('put', dir); } catch { /* kommer inte ihåg mappen, men fungerar ändå */ }
    fileStore.dir = dir;
    start(fileStore);
  };

  btn.onclick = async () => {
    try {
      if (saved && await saved.requestPermission({ mode: 'readwrite' }) === 'granted') {
        fileStore.dir = saved;
        return start(fileStore);
      }
      await pick();
    } catch (e) {
      if (e.name !== 'AbortError') alert('Kunde inte öppna mappen: ' + e.message);
    }
  };
  other.onclick = () => pick().catch(e => { if (e.name !== 'AbortError') alert('Kunde inte öppna mappen: ' + e.message); });
}

window.addEventListener('beforeunload', e => {
  if (state.pending.length) e.preventDefault();
});

(function init() {
  const now = new Date();
  state.year = now.getFullYear();
  state.month = now.getMonth();
  try {
    const m = +localStorage.getItem('franvaro.manader');
    if (MONTH_CHOICES.includes(m)) state.months = m;
  } catch { /* ignoreras */ }
  $('monthsSel').value = String(state.months);
  showThemeButton();
  render();

  if (location.protocol.startsWith('http')) start(serverStore);
  else initFileMode();
})();
