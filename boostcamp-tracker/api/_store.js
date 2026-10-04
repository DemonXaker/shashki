// Общее хранилище трекера: один JSON в приватном Vercel Blob.
//
// Правки нескольких человек не затирают друг друга: запись идёт с ifMatch
// по ETag прочитанной версии, при конфликте перечитываем и повторяем.
//
// ETag берём из head(), а не из get(): get() отдаёт заголовок etag ответа
// хранилища, и в другом формате, чем ждёт ifMatch у put() — из-за этого
// каждая запись падала с «Precondition failed» (04.10).
import { get, head, put, BlobPreconditionFailedError, BlobNotFoundError } from '@vercel/blob';
import { waitUntil } from '@vercel/functions';

// Список квалифицированных (PDF) в git не лежит: он либо приходит файлом
// _seed.js при деплое с локальной машины, либо через env SEED_JSON.
async function loadSeed() {
  try { return (await import('./_seed.js')).SEED; } catch {}
  try { return JSON.parse(process.env.SEED_JSON || ''); } catch {}
  return { people: [] };
}

const PATH = 'boostcamp/state.json';
const MAX_EVENTS = 600;

export const GOAL_TARGET = 50;

let SEED = { people: [] };

// Официальный список «кто едет» (никнейм, баллы, цель, исключение, доплата).
// Вшитая версия применяется один раз — при первом чтении базы после деплоя.
async function loadRoster() {
  try { return (await import('./_roster.js')).ROSTER; } catch { return null; }
}

async function readRaw() {
  let meta;
  try { meta = await head(PATH); } catch (e) {
    if (e instanceof BlobNotFoundError || /not found|does not exist/i.test(String(e && e.message))) return null;
    throw e;
  }
  // сначала версия, потом содержимое: если между ними кто-то запишет,
  // put() с этой версией не пройдёт и мы перечитаем — гонка безопасна
  const res = await get(PATH, { access: 'private', useCache: false });
  if (!res || res.statusCode !== 200) return null;
  const text = await new Response(res.stream).text();
  return { state: JSON.parse(text), etag: meta.etag };
}

async function writeRaw(state, etag) {
  state.updatedAt = new Date().toISOString();
  const opts = {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60,
  };
  if (etag) opts.ifMatch = etag;
  await put(PATH, JSON.stringify(state), opts);
}

function pendingPatches(state, R) {
  const done = new Set(state.patchesApplied || []);
  return ((R && R.patches) || []).filter(x => !done.has(x.id));
}

// Разовая правка из деплоя: { id, nick, field, value, by, comment }.
function applyPatch(state, x) {
  const p = state.people.find(q => lc(q.nick) === lc(x.nick));
  state.patchesApplied = [...(state.patchesApplied || []), x.id];
  if (!p || !MANUAL_FIELDS[x.field]) return;
  p.m = p.m || {}; p.mAt = p.mAt || {};
  const at = new Date().toISOString();
  p.m[x.field] = x.value; p.mAt[x.field] = { by: x.by, at };
  if (x.comment) {
    p.m.comment = [p.m.comment, x.comment].filter(Boolean).join(' · ');
    p.mAt.comment = { by: x.by, at };
  }
  const spec = MANUAL_FIELDS[x.field];
  addEvent(state, { by: x.by, kind: 'edit', id: p.id, text: `${p.nick}: ${spec.label} → ${spec.values ? spec.values[x.value] : x.value}${x.comment ? ' (' + x.comment + ')' : ''}` });
}

export async function loadState() {
  const raw = await readRaw();
  if (raw) {
    const R = await loadRoster();
    const needRoster = R && !(raw.state.rosterVersions || []).includes(R.version);
    if (needRoster || pendingPatches(raw.state, R).length) {
      return mutate(s => {
        if (R && !(s.rosterVersions || []).includes(R.version)) applyRoster(s, R.rows, { by: 'система', version: R.version, source: R.source });
        for (const x of pendingPatches(s, R)) applyPatch(s, x);
      });
    }
    return raw.state;
  }
  // Первый запуск: собираем базу из сида и сохраняем.
  return mutate(s => s);
}

// Прочитать → изменить → записать с защитой от гонки. fn меняет state на месте
// и может вернуть значение, которое уйдёт вызывающему.
export async function mutate(fn) {
  let prevStamp = null, idle = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const raw = await readRaw();
    if (!raw) SEED = await loadSeed();
    const state = raw ? raw.state : initialState();
    if (!raw) { const R = await loadRoster(); if (R) applyRoster(state, R.rows, { by: 'система', version: R.version, source: R.source }); }
    // Если версия «не совпала», а файл за это время никто не менял (та же
    // отметка updatedAt) — конфликт ложный: пишем без проверки версии,
    // чтобы правка не потерялась.
    const stamp = raw ? raw.state.updatedAt || '' : null;
    idle = raw && stamp === prevStamp ? idle + 1 : 0;
    prevStamp = stamp;
    const result = await fn(state);
    try {
      await writeRaw(state, raw && idle < 2 ? raw.etag : undefined);
      notifySheet(state);
      return result === undefined ? state : result;
    } catch (e) {
      const conflict = e instanceof BlobPreconditionFailedError || /precondition|etag/i.test(String(e && e.message));
      if (!conflict) throw e;
      await new Promise(r => setTimeout(r, 60 + Math.random() * 180));
    }
  }
  throw new Error('Не удалось сохранить: слишком много одновременных правок, повторите.');
}

// ---------- мгновенное обновление Google Таблицы ----------
//
// Если в трекере сохранён адрес веб-приложения Apps Script (диалог «Google
// Таблица и бот»), после каждой записи дёргаем его — скрипт сразу
// перезаписывает лист «Трекер (live)». Ответа не ждём: waitUntil держит
// функцию живой, пока запрос не уйдёт, но пользователь не ждёт Google.
export const PUSH_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;

export function pushToSheet(url, ops = []) {
  const body = JSON.stringify({ key: process.env.SYNC_KEY || '', ops });
  return fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(25_000) })
    .then(async r => ({ ok: r.ok, status: r.status, text: (await r.text().catch(() => '')).slice(0, 200) }))
    .catch(e => ({ ok: false, error: String(e && e.message || e) }));
}

function notifySheet(state) {
  const url = state.settings && state.settings.sheetPushUrl;
  if (!url || !PUSH_URL_RE.test(url)) return;
  const p = pushToSheet(url, pendingOps(state));
  try { waitUntil(p); } catch {}
}

export function addEvent(state, ev) {
  state.events = state.events || [];
  state.events.push({ at: new Date().toISOString(), ...ev });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}

// ---------- база ----------

function initialState() {
  const state = { v: 1, people: [], events: [], createdAt: new Date().toISOString() };
  for (const p of SEED.people) {
    state.people.push({
      id: 'p' + p.num,
      num: p.num,
      nick: p.nick,
      vip: p.vip,
      points: p.points,
      goal: p.goal,
      alts: p.alts || [],
      pdfNote: p.note || '',
      inList: true,
      bot: null,
      m: {},
      mAt: {},
    });
  }
  addEvent(state, { by: 'система', kind: 'info', text: `База создана: ${SEED.people.length} квалифицированных из PDF (срез 28.09)` });
  return state;
}

// ---------- приём данных бота ----------

const lc = s => String(s ?? '').trim().toLowerCase();
const str = v => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
};

// Ключи строки бота: русские заголовки выгрузки или короткие английские.
const FIELDS = {
  goal: ['Цель', 'goal'],
  fio: ['ФИО', 'fio', 'name', 'full_name'],
  birth: ['Дата рождения', 'birth', 'birthdate'],
  email: ['Email', 'email'],
  tg: ['Telegram username', 'telegram', 'tg', 'username'],
  account: ['Pulse', 'pulse', 'account', 'nick'],
  regStatus: ['Статус регистрации', 'status'],
  passport: ['Паспорт для покупки билета', 'Паспорт', 'passport'],
  housing: ['Проживание', 'housing'],
  arrFromCity: ['Город вылета на кемп', 'arr_from'],
  arrToCity: ['Город прилёта на кемп', 'arr_to'],
  arrDate: ['Дата прилёта', 'arr_date'],
  arrTime: ['Время прилёта', 'arr_time'],
  arrAirport: ['Аэропорт прилёта', 'arr_airport'],
  arrFlight: ['Рейс прилёта', 'arr_flight'],
  depFromCity: ['Город обратного вылета', 'dep_from'],
  depToCity: ['Город обратного прилёта', 'dep_to'],
  depDate: ['Дата вылета', 'dep_date'],
  depTime: ['Время вылета', 'dep_time'],
  depAirport: ['Аэропорт обратного вылета', 'dep_airport'],
  depFlight: ['Рейс вылета', 'dep_flight'],
  transfer: ['Трансфер', 'transfer'],
  transferDate: ['Дата трансфера', 'transfer_date'],
  transferTime: ['Время трансфера', 'transfer_time'],
  meetPlace: ['Место встречи', 'meet_place'],
  transferStatus: ['Статус трансфера', 'transfer_status'],
  regAt: ['Дата регистрации', 'registered_at', 'created_at'],
  updAt: ['Последнее обновление', 'updated_at'],
  pid: ['Participant ID', 'participant_id', 'id'],
  source: ['Источник', 'source'],
  tgId: ['Telegram ID', 'telegram_id'],
};

export function normalizeRow(row) {
  const clean = {};
  for (const [k, v] of Object.entries(row || {})) clean[String(k).trim()] = v;
  row = clean;
  const out = {};
  for (const [k, names] of Object.entries(FIELDS)) {
    for (const n of names) {
      if (row[n] !== undefined && row[n] !== null && row[n] !== '') { out[k] = str(row[n]); break; }
    }
    if (out[k] === undefined) out[k] = '';
  }
  const g = out.goal.match(/\d/);
  out.goalNum = g ? Number(g[0]) : 0;
  return out;
}

// «03.10.2026 10:42 UTC» → ISO; иначе пусто.
function parseRuDate(s) {
  const m = String(s || '').match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00.000Z` : '';
}

function isTestRow(r) {
  return /example\.com$/i.test(r.email) || /staging|тестов/i.test(r.account + ' ' + r.fio);
}

function changedFields(a, b) {
  const keys = ['fio', 'tg', 'email', 'regStatus', 'passport', 'housing', 'arrDate', 'arrTime', 'arrFlight', 'depDate', 'depTime', 'depFlight', 'arrFromCity', 'transferStatus'];
  return keys.filter(k => (a[k] || '') !== (b[k] || ''));
}

// Сопоставление заявки из бота с человеком из списка.
// 1) ник совпадает с основным аккаунтом — точно он;
// 2) ник — второй аккаунт из PDF: засчитываем, только если цель совпадает
//    и у основного аккаунта нет своей заявки от другого человека;
//    иначе — отдельная строка «требует решения»;
// 3) ника нет в списке — отдельная строка «не в списке».
export function applyBotRows(state, rows, { by = 'бот', quietTime = false } = {}) {
  const report = { added: 0, updated: 0, skipped: 0, extra: 0 };
  const norm = rows.map(normalizeRow).filter(r => r.account || r.fio);
  // основные аккаунты — первыми, чтобы вторые аккаунты видели занятые места
  const byMain = r => state.people.some(p => p.inList && lc(p.nick) === lc(r.account));
  norm.sort((a, b) => Number(byMain(b)) - Number(byMain(a)));

  for (const r of norm) {
    if (isTestRow(r)) { report.skipped++; continue; }
    if (lc(r.source) === 'трекер') continue; // строку добавил трекер — это не заявка бота
    // уже известная заявка (по ID участника бота) — обновляем там, где она лежит
    let person = r.pid && state.people.find(p => p.bot && p.bot.pid === r.pid);
    let reason = '';
    if (!person) {
      person = state.people.find(p => p.inList && lc(p.nick) === lc(r.account));
      if (person && person.bot && person.bot.pid && person.bot.pid !== r.pid) person = null;
    }
    if (!person) {
      const main = state.people.find(p => p.inList && p.alts.some(a => lc(a) === lc(r.account)));
      if (main) {
        const taken = main.bot && main.bot.pid && main.bot.pid !== r.pid;
        const goalDiff = r.goalNum && r.goalNum !== main.goal;
        if (!taken && !goalDiff) {
          person = main;
        } else {
          reason = `В PDF «${r.account}» — второй аккаунт ${main.nick} (срезан). ` +
            (taken ? `${main.nick} уже зарегистрирован отдельно (${main.bot.fio || 'другое ФИО'}).` : `Бот поставил Цель ${r.goalNum}, а у ${main.nick} — Цель ${main.goal}.`) +
            ' Считать отдельным участником?';
        }
      } else {
        reason = `Ника «${r.account}» нет в списке квалифицированных (срез 28.09).` + (r.goalNum ? ` Бот поставил Цель ${r.goalNum}.` : ' Цель в боте не указана.');
      }
    }
    if (!person) {
      person = {
        id: 'x' + (r.pid || r.account || Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi, '').slice(0, 24),
        num: null, nick: r.account || r.fio, vip: '', points: null, goal: r.goalNum, alts: [],
        pdfNote: '', inList: false, decisionReason: reason, bot: null, m: {}, mAt: {},
      };
      state.people.push(person);
      report.extra++;
    }
    const prev = person.bot;
    person.bot = { ...r };
    const via = lc(r.account) !== lc(person.nick) ? ` (через аккаунт ${r.account})` : '';
    if (!prev) {
      report.added++;
      addEvent(state, {
        by, kind: 'reg', id: person.id,
        text: `${quietTime ? 'В боте' : '🆕 Новая заявка в боте'}: ${person.nick}${via} — ${r.fio || 'без ФИО'}, ${r.goal || 'цель не указана'}` + (person.inList ? '' : ' · ⚠ требует решения'),
        ...(quietTime && parseRuDate(r.regAt) ? { at: parseRuDate(r.regAt) } : {}),
      });
    } else {
      const diff = changedFields(prev, r);
      if (diff.length) {
        report.updated++;
        const parts = [];
        if (diff.includes('regStatus')) parts.push(`статус: ${r.regStatus || '—'}`);
        if (diff.includes('passport')) parts.push(`паспорт/билет: ${r.passport || '—'}`);
        if (diff.includes('housing')) parts.push(`проживание: ${r.housing || '—'}`);
        if (diff.some(k => /Flight|Date|Time/.test(k)) && (r.arrFlight || r.depFlight)) parts.push(`рейсы: ${r.arrFlight || '—'} → ${r.depFlight || '—'}`);
        if (diff.includes('fio') && r.fio && !(prev.fio)) parts.push(`ФИО: ${r.fio}`);
        addEvent(state, { by, kind: 'bot-upd', id: person.id, text: `${person.nick}: ${parts.length ? parts.join(' · ') : 'обновил анкету'}` });
      }
    }
  }
  return report;
}

// ---------- Google Таблица «Участники» (доступ по ссылке) ----------
//
// Таблицу ведёт команда (выгрузка бота + колонки «Паспорт», «Проживание»).
// Забираем её CSV не чаще раза в минуту на инстанс и пишем в базу только
// если содержимое изменилось — так не тратим операции Blob впустую.

let lastPull = 0;

export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map(h => h.replace(/^﻿/, '').trim());
  return rows.slice(1).filter(r => r.some(v => v.trim())).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + ':' + s.length;
}

export async function pullSheet({ force = false } = {}) {
  const id = process.env.SHEET_ID;
  if (!id) return { skipped: 'no SHEET_ID' };
  if (!force && Date.now() - lastPull < 60_000) return { skipped: 'recent' };
  lastPull = Date.now();
  const gid = process.env.SHEET_GID || '0';
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`, { redirect: 'follow', cache: 'no-store' });
  if (!r.ok) throw new Error('Таблица недоступна: HTTP ' + r.status);
  const text = await r.text();
  if (/^\s*</.test(text)) throw new Error('Таблица закрыта: нужен доступ «все, у кого есть ссылка»');
  const h = hash(text);
  const raw = await readRaw();
  if (raw && raw.state.sheetHash === h) {
    // таблица не менялась — но правки трекера могли не доехать: дошлём
    const url = raw.state.settings && raw.state.settings.sheetPushUrl;
    const ops = url ? pendingOps(raw.state) : [];
    if (ops.length && PUSH_URL_RE.test(url)) { const p = pushToSheet(url, ops); try { waitUntil(p); } catch {} }
    return { same: true, resent: ops.length };
  }
  const rows = parseCsv(text);
  const headers = Object.keys(rows[0] || {});
  return mutate(state => {
    if (state.sheetHash === h) return { same: true };
    const first = !state.sheetHash;
    const rep = applyBotRows(state, rows, { by: 'таблица «Участники»', quietTime: first });
    rep.manual = syncManualFromRows(state, rows, headers);
    state.sheetHash = h;
    state.sheetPulledAt = new Date().toISOString();
    if (first) addEvent(state, { by: 'система', kind: 'info', text: `Подключена таблица «Участники»: ${rows.length} заявок (в списке ${rows.length - rep.extra - rep.skipped}, вне списка ${rep.extra})` });
    return rep;
  });
}

// ---------- ручные колонки ✎ в таблице «Участники» (в обе стороны) ----------
//
// Каждое ручное поле трекера — колонка «✎ …» в таблице. Направление правки
// определяем по p.sheetM — значению, которое трекер последним видел в таблице:
//   ячейка ≠ sheetM  → её поменяли в таблице → берём в трекер;
//   ячейка = sheetM, а в трекере другое → правка трекера ещё не доехала →
//   досылаем в таблицу (pendingOps).

export const SHEET_COLS = {
  hotel: '✎ Отель', ticketWho: '✎ Билет покупает', ticket: '✎ Билет',
  arrFlight: '✎ Рейс туда', arrDate: '✎ Дата прилёта', depFlight: '✎ Рейс обратно',
  owner: '✎ Ответственный', sponsor: '✎ Спонсор', phone: '✎ Телефон',
  comment: '✎ Комментарий', decision: '✎ Решение',
};
const COL_FIELD = Object.fromEntries(Object.entries(SHEET_COLS).map(([f, c]) => [c, f]));
export const fieldByColumn = col => COL_FIELD[String(col || '').trim()];

const TO_SHEET = {
  hotel: { requested: 'запрошена', confirmed: '✅ подтверждена' },
  ticketWho: { company: 'мы', self: 'сам' },
  ticket: { asked: 'спросили', bought: '✅ куплен', notneeded: 'не нужен — уже в Турции' },
  decision: { yes: 'участвует', no: 'не участвует' },
};
export const SHEET_CHOICES = Object.fromEntries(Object.entries(TO_SHEET).map(([f, v]) => [SHEET_COLS[f], Object.values(v)]));

export function toSheet(field, code) {
  code = code || '';
  return TO_SHEET[field] ? (TO_SHEET[field][code] || '') : code;
}

// Текст ячейки → код поля. undefined — непонятное значение, его не трогаем.
export function fromSheet(field, text) {
  const t = String(text ?? '').trim();
  const l = t.toLowerCase();
  if (!TO_SHEET[field]) return t.slice(0, 500);
  if (!l || /^(нет|-|—|не решено)$/.test(l)) return '';
  if (field === 'hotel') return /^не/.test(l) ? '' : /подтв|✅|брон|оплач|^да/.test(l) ? 'confirmed' : /запро/.test(l) ? 'requested' : undefined;
  if (field === 'ticket') return /не\s*нуж|турци/.test(l) ? 'notneeded' : /^не/.test(l) ? '' : /спрос/.test(l) ? 'asked' : /куп|✅|^да/.test(l) ? 'bought' : undefined;
  if (field === 'ticketWho') return /^мы|компан/.test(l) ? 'company' : /сам/.test(l) ? 'self' : undefined;
  if (field === 'decision') return /^не/.test(l) ? 'no' : /участ|^да/.test(l) ? 'yes' : undefined;
}

function rowKeyOf(p) {
  return { pid: (p.bot && p.bot.pid) || '', nick: (p.bot && p.bot.account) || p.nick };
}

// Правки трекера, которых ещё нет в таблице.
export function pendingOps(state, limit = 300) {
  const ops = [];
  for (const p of state.people) {
    const m = p.m || {}, seen = p.sheetM || {};
    for (const [f, col] of Object.entries(SHEET_COLS)) {
      const want = m[f] || '';
      if (want === (seen[f] ?? '')) continue;
      const k = rowKeyOf(p);
      ops.push({ pid: k.pid, nick: k.nick, goal: p.goal ? `Цель ${p.goal}` : '', col, value: toSheet(f, want) });
      if (ops.length >= limit) return ops;
    }
  }
  return ops;
}

function findPersonForRow(state, r) {
  if (r.pid) { const p = state.people.find(x => x.bot && x.bot.pid === r.pid); if (p) return p; }
  if (lc(r.source) === 'трекер' || !r.pid) {
    const n = lc(r.account);
    return n ? state.people.find(x => !x.bot && lc(x.nick) === n) : null;
  }
  return null;
}

// Забрать правки ✎-колонок из строк таблицы. headers — заголовки CSV.
export function syncManualFromRows(state, rows, headers) {
  const cols = Object.values(SHEET_COLS).filter(c => headers.includes(c));
  // Колонку удалили (вставили выгрузку без ✎) — забываем, что видели в ней:
  // значения трекера уйдут в таблицу заново, скрипт вернёт колонку.
  for (const [f, col] of Object.entries(SHEET_COLS)) {
    if (cols.includes(col)) continue;
    for (const p of state.people) if (p.sheetM && f in p.sheetM) delete p.sheetM[f];
  }
  if (!cols.length) return { applied: 0 };
  const changes = [];
  const withRow = new Set();
  for (const row of rows) {
    const r = normalizeRow(row);
    const p = findPersonForRow(state, r);
    if (!p) continue;
    withRow.add(p.id);
    p.m = p.m || {}; p.mAt = p.mAt || {}; p.sheetM = p.sheetM || {};
    for (const col of cols) {
      const f = COL_FIELD[col];
      const code = fromSheet(f, row[col]);
      if (code === undefined) continue;
      const seen = p.sheetM[f];
      if (seen === undefined) {
        // первая встреча с колонкой: значение из таблицы берём, если в трекере пусто
        if (code && !p.m[f]) changes.push({ p, f, code, first: true });
        else p.sheetM[f] = code;
        continue;
      }
      if (code !== seen) changes.push({ p, f, code });
    }
  }
  // Строку человека удалили из таблицы — его значения дошлём заново.
  for (const p of state.people) if (p.sheetM && !withRow.has(p.id)) p.sheetM = {};
  // Ручные очистки приходят сразу через onEdit. Если же сверка видит, что
  // ✎-ячейки опустели сразу в нескольких строках, — это вставка выгрузки
  // поверх колонок: трекер не стираем, а возвращаем значения в таблицу.
  const clears = changes.filter(c => !c.code && (c.p.m[c.f] || ''));
  const wipe = new Set(clears.map(c => c.p.id)).size >= 2;
  let applied = 0;
  for (const c of changes) {
    if (wipe && !c.code) { c.p.sheetM[c.f] = ''; continue; }
    c.p.sheetM[c.f] = c.code;
    if ((c.p.m[c.f] || '') === c.code) continue;
    c.p.m[c.f] = c.code;
    c.p.mAt[c.f] = { by: 'таблица', at: new Date().toISOString() };
    applied++;
    const spec = MANUAL_FIELDS[c.f];
    addEvent(state, { by: 'таблица «Участники»', kind: 'edit', id: c.p.id, text: `${c.p.nick}: ${spec.label} → ${spec.values ? spec.values[c.code] : (c.code || '—')} (правка в таблице)` });
  }
  if (wipe) addEvent(state, { by: 'система', kind: 'info', text: `В таблице разом очищено ${clears.length} ✎-ячеек — похоже, вставили новую выгрузку. Значения трекера возвращены в таблицу.` });
  return { applied, wipe };
}

// ---------- список «кто едет» ----------
//
// Строки: { 'Никнейм', 'Баллы', 'Цель', 'Исключение', 'Доплата' }.
// Кого нет в списке — убираем (если по человеку есть заявка в боте или
// отметки — оставляем «вне списка» с пометкой, чтобы ничего не потерять).
// Кто появился — добавляем; если это бывший «второй аккаунт», чья заявка
// висела на основном (anita → annapulse), заявку и отметки переносим.

export function parseRosterRows(rows) {
  const out = [];
  for (const row of rows) {
    const r = {};
    for (const [k, v] of Object.entries(row || {})) r[String(k).trim().toLowerCase()] = String(v ?? '').trim();
    const nick = r['никнейм'] || r['ник'] || r['nick'] || r['pulse'];
    if (!nick) continue;
    const g = (r['цель'] || '').match(/\d/);
    out.push({
      nick,
      points: Number(String(r['баллы'] || '').replace(/[^\d.]/g, '')) || null,
      goal: g ? Number(g[0]) : 0,
      exception: r['исключение'] || '',
      surcharge: r['доплата'] || '',
    });
  }
  return out;
}

export function applyRoster(state, rows, { by = 'кто-то', version = '', source = '' } = {}) {
  const list = parseRosterRows(rows);
  if (list.length < 10) throw new Error('В списке меньше 10 строк — похоже, не тот файл');
  const inRoster = new Set(list.map(r => lc(r.nick)));
  const report = { total: list.length, added: [], removed: [], moved: [], promoted: [] };
  const hasData = p => !!p.bot || Object.values(p.m || {}).some(v => v);

  list.forEach((r, i) => {
    const n = lc(r.nick);
    let p = state.people.find(x => lc(x.nick) === n);
    if (p && !p.inList) report.promoted.push(r.nick);
    if (!p) {
      // заявка этого ника висит на другом человеке (вход через второй аккаунт)
      const host = state.people.find(x => x.bot && lc(x.bot.account) === n && lc(x.nick) !== n);
      p = { id: 'r' + n.replace(/[^a-z0-9]/g, '').slice(0, 24) + (state.people.length + 1), nick: r.nick, vip: '', alts: [], pdfNote: '', bot: null, m: {}, mAt: {} };
      if (host) {
        p.bot = host.bot; p.m = host.m || {}; p.mAt = host.mAt || {}; p.sheetM = host.sheetM;
        host.bot = null; host.m = {}; host.mAt = {}; delete host.sheetM;
        report.moved.push(`${r.nick} ← ${host.nick}`);
      } else report.added.push(r.nick);
      state.people.push(p);
    }
    Object.assign(p, {
      inList: true, num: i + 1, points: r.points, goal: r.goal,
      exception: r.exception, surcharge: r.surcharge, decisionReason: '',
    });
  });

  for (const p of [...state.people]) {
    if (!p.inList || inRoster.has(lc(p.nick))) continue;
    report.removed.push(p.nick);
    if (hasData(p)) {
      p.inList = false; p.num = null;
      p.decisionReason = `Нет в списке «кто едет»${version ? ' (' + version + ')' : ''}, но по человеку есть заявка или отметки. Он едет?`;
    } else {
      state.people.splice(state.people.indexOf(p), 1);
    }
  }
  // вторые аккаунты, которые теперь отдельные участники, — не «другие аккаунты»
  for (const p of state.people) if (p.alts) p.alts = p.alts.filter(a => !inRoster.has(lc(a)));

  state.rosterVersions = [...(state.rosterVersions || []), version || ('загрузка ' + new Date().toISOString())];
  state.rosterSource = source || state.rosterSource || '';
  addEvent(state, { by, kind: 'info', text:
    `Список «кто едет» обновлён${source ? ' (' + source + ')' : ''}: ${list.length} чел.` +
    (report.added.length ? ` · добавлены: ${report.added.join(', ')}` : '') +
    (report.promoted.length ? ` · из «вне списка» в список: ${report.promoted.join(', ')}` : '') +
    (report.moved.length ? ` · заявка перенесена: ${report.moved.join(', ')}` : '') +
    (report.removed.length ? ` · убраны: ${report.removed.join(', ')}` : '') });
  return report;
}

// ---------- ручные отметки ----------

export const MANUAL_FIELDS = {
  hotel: { label: 'Отель', values: { '': 'нет брони', requested: 'запрошена', confirmed: 'подтверждена' } },
  ticketWho: { label: 'Кто покупает билет', values: { '': 'по умолчанию', company: 'мы', self: 'сам' } },
  ticket: { label: 'Билет', values: { '': 'не куплен', asked: 'спросили', bought: 'куплен', notneeded: 'не нужен (уже в Турции)' } },
  transfer: { label: 'Трансфер', values: { '': 'нужен', no: 'не нужен' } },
  arrFlight: { label: 'Рейс туда' },
  depFlight: { label: 'Рейс обратно' },
  arrDate: { label: 'Дата прилёта' },
  owner: { label: 'Ответственный' },
  sponsor: { label: 'Спонсор' },
  phone: { label: 'Телефон' },
  comment: { label: 'Комментарий' },
  decision: { label: 'Решение', values: { '': 'не решено', yes: 'участвует', no: 'не участвует' } },
  inBotManual: { label: 'В боте (вручную)', values: { '': 'нет', yes: 'да' } },
  notGoing: { label: 'Участие', values: { '': 'едет', yes: 'не едет' } },
};

// ---------- статус ----------

export function computeStatus(p) {
  const m = p.m || {};
  const b = p.bot || {};
  const counted = p.inList || m.decision === 'yes';
  // «не едет» — решение команды; держится и после загрузки нового списка
  const excluded = m.notGoing === 'yes' || (!p.inList && m.decision === 'no');
  const inBot = !!p.bot || m.inBotManual === 'yes';
  const regDone = m.inBotManual === 'yes' || /актив/i.test(b.regStatus || '');
  const passport = (b.passport || '').toLowerCase();
  const byCar = /машин/.test(passport);
  const selfFromSheet = /сам/.test(passport);
  const cond = p.exception ? Math.max(2, p.goal || 0) : p.goal; // по исключению — условия Цели 2
  const who = m.ticketWho || (selfFromSheet ? 'self' : (cond === 3 ? 'company' : 'self'));
  const surchargeUnpaid = /не\s*оплач/i.test(p.surcharge || '');
  const passportOk = /^загружен/.test(passport);
  const arrFlight = m.arrFlight || b.arrFlight || '';
  const depFlight = m.depFlight || b.depFlight || '';
  const housingPaid = /оплачен|подтвержд|заброн/i.test(b.housing || '');
  const hotelOk = m.hotel === 'confirmed' || housingPaid;
  const inTurkey = m.ticket === 'notneeded';
  const ticketOk = m.ticket === 'bought' || inTurkey || byCar || (who === 'self' && !!arrFlight);
  const transferNeeded = m.transfer !== 'no';
  const missing = [];
  if (!inBot) missing.push('не перешёл в бот');
  else if (!regDone) missing.push(`дожать регистрацию в боте (${b.regStatus || 'не завершена'})`);
  if (!hotelOk) missing.push(m.hotel === 'requested' ? 'отель запрошен, ждём подтверждения' : 'забронировать отель');
  if (!ticketOk) {
    if (who === 'company') missing.push(passportOk ? 'купить билет (паспорт есть)' : 'получить паспорт и купить билет');
    else missing.push(m.ticket === 'asked' ? 'ждём номер рейса' : 'спросить, купил ли билет, и номер рейса');
  }
  if (surchargeUnpaid) missing.push('доплата за программу не оплачена');
  let code;
  if (excluded) code = 'excluded';
  else if (!p.inList && !m.decision) code = 'decision';
  else if (!inBot) code = 'nobot';
  else if (regDone && hotelOk && ticketOk && !surchargeUnpaid) code = 'full';
  else code = 'work';
  return { code, counted: counted && !excluded, inBot, regDone, who, cond, surchargeUnpaid, inTurkey, transferNeeded, byCar, passportOk, housingPaid, arrFlight, depFlight, hotelOk, ticketOk, missing };
}

export function summary(state) {
  const s = { target: GOAL_TARGET, counted: 0, full: 0, work: 0, nobot: 0, decision: 0, inBot: 0, unpaid: 0, inTurkey: 0, transferNeed: 0, byGoal: {} };
  for (const p of state.people) {
    const st = computeStatus(p);
    if (st.code === 'decision') s.decision++;
    if (!st.counted) continue;
    s.counted++;
    if (st.inBot) s.inBot++;
    if (st.surchargeUnpaid) s.unpaid++;
    if (st.inTurkey) s.inTurkey++;
    if (st.transferNeeded) s.transferNeed++;
    s[st.code] = (s[st.code] || 0) + 1;
    const g = (s.byGoal[p.goal] = s.byGoal[p.goal] || { total: 0, full: 0, inBot: 0 });
    g.total++; if (st.inBot) g.inBot++; if (st.code === 'full') g.full++;
  }
  return s;
}

// ---------- общие ответы ----------

export function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

// Сравнение секретов без утечки по времени.
export function sameSecret(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
