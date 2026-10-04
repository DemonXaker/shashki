// Выгрузка для Google Таблицы и проверок: GET /api/export?key=<SYNC_KEY>
//   format=rows    — таблица (по умолчанию), JSON { headers, rows, summary }
//   format=csv     — то же в CSV (для =IMPORTDATA)
//   format=events&since=<ISO> — лента событий после момента since
import { loadState, pullSheet, computeStatus, summary, json, sameSecret } from './_store.js';

const GOAL = g => (g ? `Цель ${g}` : '—');
const STATUS = { full: '✅ С нами 100%', work: '🟠 В работе', nobot: '⚪ Не в боте', decision: '❓ Требует решения', excluded: '✖ Не участвует' };
const HOTEL = { '': '—', requested: 'запрошена', confirmed: '✅ подтверждена' };
const TICKET = { '': '—', asked: 'спросили', bought: '✅ куплен' };

export function toRows(state) {
  const headers = ['№', 'Ник Pulse', 'Цель', 'Баллы', 'Статус', 'Чего не хватает', 'В боте', 'ФИО', 'Telegram', 'Телефон',
    'Регистрация в боте (статус)', 'Паспорт / билет (таблица)', 'Проживание (таблица)', 'Отель', 'Билет покупает', 'Билет', 'Рейс туда', 'Дата прилёта', 'Рейс обратно', 'Ответственный', 'Спонсор', 'Комментарий',
    'Регистрация в боте', 'Другие аккаунты', 'Примечание'];
  const order = { 3: 0, 2: 1, 1: 2, 0: 3 };
  const people = [...state.people].sort((a, b) =>
    (Number(!a.inList) - Number(!b.inList)) || (order[a.goal] - order[b.goal]) || ((a.num || 999) - (b.num || 999)));
  const rows = people.map(p => {
    const st = computeStatus(p); const m = p.m || {}; const b = p.bot || {};
    return [p.num || '', p.nick, GOAL(p.goal), p.points || '', STATUS[st.code], st.code === 'full' ? '' : st.missing.join(', '),
      st.inBot ? '✅' : '—', b.fio || '', b.tg ? '@' + b.tg.replace(/^@/, '') : '', m.phone || '',
      b.regStatus || '', b.passport || '', b.housing || '',
      st.housingPaid && !m.hotel ? '✅ оплачено (таблица)' : HOTEL[m.hotel || ''], st.byCar ? 'едет на машине' : (st.who === 'company' ? 'мы' : 'сам'), TICKET[m.ticket || ''] + (st.who === 'self' && !m.ticket && st.arrFlight ? ' (рейс указан)' : ''),
      st.arrFlight, m.arrDate || b.arrDate || '', st.depFlight, m.owner || '', m.sponsor || '', m.comment || '',
      b.regAt || '', (p.alts || []).join(', '), p.inList ? (p.pdfNote || '') : (p.decisionReason || '')];
  });
  return { headers, rows };
}

const csvCell = v => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

export default async function handler(req, res) {
  const q = req.query || {};
  if (!sameSecret(q.key, process.env.SYNC_KEY)) return json(res, 401, { error: 'bad key' });
  try {
    try { await pullSheet(); } catch {}
    const state = await loadState();
    if (q.format === 'events') {
      const since = String(q.since || '');
      const events = (state.events || []).filter(e => !since || e.at > since).sort((a, b) => (a.at < b.at ? -1 : 1));
      return json(res, 200, { updatedAt: state.updatedAt, summary: summary(state), events });
    }
    const { headers, rows } = toRows(state);
    if (q.format === 'csv') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end('﻿' + [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\n'));
    }
    json(res, 200, { updatedAt: state.updatedAt, summary: summary(state), headers, rows });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
}
