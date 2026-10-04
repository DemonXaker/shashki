// Настройки трекера (только после входа): адрес веб-приложения Apps Script,
// которое мгновенно перезаписывает лист в Google Таблице после каждой правки.
import { mutate, addEvent, json, readBody, PUSH_URL_RE, pushToSheet } from './_store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const { sheetPushUrl, by } = await readBody(req);
    const url = String(sheetPushUrl || '').trim();
    if (url && !PUSH_URL_RE.test(url)) {
      return json(res, 400, { error: 'Нужен адрес вида https://script.google.com/macros/s/…/exec (Развернуть → Веб-приложение)' });
    }
    // проверяем адрес до сохранения: скрипт должен ответить
    const test = url ? await pushToSheet(url) : { ok: true };
    if (url && !test.ok) {
      return json(res, 400, { error: `Скрипт не ответил (${test.status || test.error}). Проверьте доступ «Все» при развёртывании.` });
    }
    await mutate(state => {
      state.settings = { ...(state.settings || {}), sheetPushUrl: url };
      addEvent(state, { by: String(by || 'кто-то').slice(0, 40), kind: 'info', text: url ? 'Google Таблица подключена: правки уходят в неё сразу' : 'Мгновенная отправка в Google Таблицу отключена' });
    });
    json(res, 200, { ok: true });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
}
