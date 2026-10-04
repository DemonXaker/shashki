// Загрузка нового списка «кто едет» (CSV/xlsx разбирается в браузере).
import { mutate, applyRoster, json, readBody } from './_store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const { rows, by, fileName } = await readBody(req);
    if (!Array.isArray(rows) || rows.length > 2000) return json(res, 400, { error: 'Нет строк' });
    const report = await mutate(state => applyRoster(state, rows, {
      by: String(by || 'кто-то').slice(0, 40),
      source: fileName ? String(fileName).slice(0, 80) : 'загрузка',
    }));
    json(res, 200, { ok: true, report });
  } catch (e) {
    json(res, 400, { error: String(e && e.message || e) });
  }
}
