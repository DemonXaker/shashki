// Ручная отметка по одному человеку: отель, билет, рейс, ответственный и т.д.
import { mutate, addEvent, MANUAL_FIELDS, computeStatus, json, readBody } from './_store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const { id, field, value, by } = await readBody(req);
    const spec = MANUAL_FIELDS[field];
    if (!spec) return json(res, 400, { error: 'Неизвестное поле' });
    const val = String(value ?? '').trim().slice(0, 500);
    if (spec.values && !(val in spec.values)) return json(res, 400, { error: 'Недопустимое значение' });
    const who = String(by || 'кто-то').trim().slice(0, 40) || 'кто-то';

    const out = await mutate(state => {
      const p = state.people.find(x => x.id === id);
      if (!p) throw Object.assign(new Error('Участник не найден'), { code: 404 });
      p.m = p.m || {}; p.mAt = p.mAt || {};
      const old = p.m[field] || '';
      if (old === val) return { person: { ...p, st: computeStatus(p) }, updatedAt: state.updatedAt };
      const before = computeStatus(p).code;
      p.m[field] = val;
      p.mAt[field] = { by: who, at: new Date().toISOString() };
      const shown = spec.values ? spec.values[val] : (val || '—');
      addEvent(state, { by: who, kind: 'edit', id: p.id, text: `${p.nick}: ${spec.label} → ${shown}` });
      const st = computeStatus(p);
      if (st.code === 'full' && before !== 'full') {
        addEvent(state, { by: who, kind: 'full', id: p.id, text: `✅ ${p.nick} — с нами на 100% (отель и билет готовы)` });
      }
      return { person: { ...p, st } };
    });
    json(res, 200, out);
  } catch (e) {
    json(res, e.code === 404 ? 404 : 500, { error: String(e && e.message || e) });
  }
}
