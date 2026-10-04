// Правка из Google Таблицы «Участники» (триггер onEdit скрипта Apps Script).
//   POST /api/sheet-edit   { key, pid, nick, col, value, user }  — ✎-ячейка
//   POST /api/sheet-edit   { key, pull: true }                   — любая другая
// Ключ — тот же SYNC_KEY, что у выгрузки.
import { mutate, pullSheet, addEvent, fieldByColumn, fromSheet, MANUAL_FIELDS, json, readBody, sameSecret } from './_store.js';

const lc = s => String(s ?? '').trim().toLowerCase();

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const body = await readBody(req);
    if (!sameSecret(body.key, process.env.SYNC_KEY)) return json(res, 401, { error: 'bad key' });
    if (body.pull) {
      const rep = await pullSheet({ force: true });
      return json(res, 200, { ok: true, pulled: rep });
    }
    const field = fieldByColumn(body.col);
    if (!field) return json(res, 400, { error: 'не ✎-колонка' });
    const code = fromSheet(field, body.value);
    if (code === undefined) return json(res, 200, { ok: false, ignored: 'непонятное значение' });
    const who = String(body.user || '').trim().slice(0, 60) || 'таблица';
    const out = await mutate(state => {
      const pid = String(body.pid || '').trim(), nick = lc(body.nick);
      const p = (pid && state.people.find(x => x.bot && x.bot.pid === pid))
        || (nick && state.people.find(x => !x.bot && lc(x.nick) === nick))
        || (nick && state.people.find(x => x.bot && lc(x.bot.account) === nick));
      if (!p) return { ok: false, notFound: true };
      p.m = p.m || {}; p.mAt = p.mAt || {}; p.sheetM = p.sheetM || {};
      p.sheetM[field] = code;
      if ((p.m[field] || '') === code) return { ok: true, same: true };
      p.m[field] = code;
      p.mAt[field] = { by: who + ' (таблица)', at: new Date().toISOString() };
      const spec = MANUAL_FIELDS[field];
      addEvent(state, { by: who + ' · таблица', kind: 'edit', id: p.id, text: `${p.nick}: ${spec.label} → ${spec.values ? spec.values[code] : (code || '—')} (правка в таблице)` });
      return { ok: true, id: p.id };
    });
    json(res, 200, out);
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
}
