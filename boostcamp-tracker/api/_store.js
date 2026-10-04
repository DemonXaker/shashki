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

export async function loadState() {
  const raw = await readRaw();
  if (raw) return raw.state;
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

export function pushToSheet(url) {
  return fetch(url, { method: 'POST', body: 'sync', redirect: 'follow', signal: AbortSignal.timeout(25_000) })
    .then(r => ({ ok: r.ok, status: r.status }))
    .catch(e => ({ ok: false, error: String(e && e.message || e) }));
}

function notifySheet(state) {
  const url = state.settings && state.settings.sheetPushUrl;
  if (!url || !PUSH_URL_RE.test(url)) return;
  try { waitUntil(pushToSheet(url)); } catch { pushToSheet(url); }
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
  if (raw && raw.state.sheetHash === h) return { same: true };
  const rows = parseCsv(text);
  return mutate(state => {
    if (state.sheetHash === h) return { same: true };
    const first = !state.sheetHash;
    const rep = applyBotRows(state, rows, { by: 'таблица «Участники»', quietTime: first });
    state.sheetHash = h;
    state.sheetPulledAt = new Date().toISOString();
    if (first) addEvent(state, { by: 'система', kind: 'info', text: `Подключена таблица «Участники»: ${rows.length} заявок (в списке ${rows.length - rep.extra - rep.skipped}, вне списка ${rep.extra})` });
    return rep;
  });
}

// ---------- ручные отметки ----------

export const MANUAL_FIELDS = {
  hotel: { label: 'Отель', values: { '': 'нет брони', requested: 'запрошена', confirmed: 'подтверждена' } },
  ticketWho: { label: 'Кто покупает билет', values: { '': 'по умолчанию', company: 'мы', self: 'сам' } },
  ticket: { label: 'Билет', values: { '': 'не куплен', asked: 'спросили', bought: 'куплен' } },
  arrFlight: { label: 'Рейс туда' },
  depFlight: { label: 'Рейс обратно' },
  arrDate: { label: 'Дата прилёта' },
  owner: { label: 'Ответственный' },
  sponsor: { label: 'Спонсор' },
  phone: { label: 'Телефон' },
  comment: { label: 'Комментарий' },
  decision: { label: 'Решение', values: { '': 'не решено', yes: 'участвует', no: 'не участвует' } },
  inBotManual: { label: 'В боте (вручную)', values: { '': 'нет', yes: 'да' } },
};

// ---------- статус ----------

export function computeStatus(p) {
  const m = p.m || {};
  const b = p.bot || {};
  const counted = p.inList || m.decision === 'yes';
  const excluded = !p.inList && m.decision === 'no';
  const inBot = !!p.bot || m.inBotManual === 'yes';
  const regDone = m.inBotManual === 'yes' || /актив/i.test(b.regStatus || '');
  const passport = (b.passport || '').toLowerCase();
  const byCar = /машин/.test(passport);
  const selfFromSheet = /сам/.test(passport);
  const who = m.ticketWho || (selfFromSheet ? 'self' : (p.goal === 3 ? 'company' : 'self'));
  const passportOk = /^загружен/.test(passport);
  const arrFlight = m.arrFlight || b.arrFlight || '';
  const depFlight = m.depFlight || b.depFlight || '';
  const housingPaid = /оплачен|подтвержд|заброн/i.test(b.housing || '');
  const hotelOk = m.hotel === 'confirmed' || housingPaid;
  const ticketOk = m.ticket === 'bought' || byCar || (who === 'self' && !!arrFlight);
  const missing = [];
  if (!inBot) missing.push('не перешёл в бот');
  else if (!regDone) missing.push(`дожать регистрацию в боте (${b.regStatus || 'не завершена'})`);
  if (!hotelOk) missing.push(m.hotel === 'requested' ? 'отель запрошен, ждём подтверждения' : 'забронировать отель');
  if (!ticketOk) {
    if (who === 'company') missing.push(passportOk ? 'купить билет (паспорт есть)' : 'получить паспорт и купить билет');
    else missing.push(m.ticket === 'asked' ? 'ждём номер рейса' : 'спросить, купил ли билет, и номер рейса');
  }
  let code;
  if (excluded) code = 'excluded';
  else if (!p.inList && !m.decision) code = 'decision';
  else if (!inBot) code = 'nobot';
  else if (regDone && hotelOk && ticketOk) code = 'full';
  else code = 'work';
  return { code, counted: counted && !excluded, inBot, regDone, who, byCar, passportOk, housingPaid, arrFlight, depFlight, hotelOk, ticketOk, missing };
}

export function summary(state) {
  const s = { target: GOAL_TARGET, counted: 0, full: 0, work: 0, nobot: 0, decision: 0, inBot: 0, byGoal: {} };
  for (const p of state.people) {
    const st = computeStatus(p);
    if (st.code === 'decision') s.decision++;
    if (!st.counted) continue;
    s.counted++;
    if (st.inBot) s.inBot++;
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
