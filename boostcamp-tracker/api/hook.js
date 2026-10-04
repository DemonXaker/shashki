// Вебхук для бота: при каждой регистрации или правке бот шлёт строку участника.
//   POST /api/hook
//   Header: x-hook-secret: <HOOK_SECRET>
//   Body:   одна строка { "Pulse": "...", "ФИО": "...", ... } или { "rows": [ ... ] }
// Ключи — как в выгрузке бота (русские заголовки) или короткие английские
// (pulse, fio, telegram, goal, arr_flight, dep_flight, participant_id, ...).
import { mutate, applyBotRows, json, readBody, sameSecret } from './_store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const secret = req.headers['x-hook-secret'] || (req.query && req.query.secret);
  if (!sameSecret(secret, process.env.HOOK_SECRET)) return json(res, 401, { error: 'bad secret' });
  try {
    const body = await readBody(req);
    const rows = Array.isArray(body.rows) ? body.rows : [body];
    const report = await mutate(state => applyBotRows(state, rows, { by: 'бот' }));
    json(res, 200, { ok: true, report });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
}
