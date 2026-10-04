// Загрузка выгрузки бота (xlsx разбирается в браузере, сюда приходят строки).
import { mutate, applyBotRows, addEvent, json, readBody } from './_store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const { rows, by, fileName } = await readBody(req);
    if (!Array.isArray(rows) || !rows.length) return json(res, 400, { error: 'Пустой файл' });
    if (rows.length > 2000) return json(res, 400, { error: 'Слишком много строк' });
    const who = String(by || 'кто-то').slice(0, 40);
    const report = await mutate(state => {
      const r = applyBotRows(state, rows, { by: who });
      addEvent(state, { by: who, kind: 'info', text: `Загружена выгрузка бота${fileName ? ` (${String(fileName).slice(0, 80)})` : ''}: новых ${r.added}, обновлено ${r.updated}, вне списка ${r.extra}, пропущено тестовых ${r.skipped}` });
      return r;
    });
    json(res, 200, { ok: true, report });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
}
