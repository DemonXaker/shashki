// Всё состояние трекера для страницы. Доступ — только после входа (middleware).
import { loadState, pullSheet, summary, computeStatus, json } from './_store.js';

export default async function handler(req, res) {
  try {
    // заодно подтягиваем таблицу «Участники» (не чаще раза в минуту)
    let sheetError = '';
    try { await pullSheet({ force: req.query && req.query.pull === '1' }); } catch (e) { sheetError = String(e && e.message || e); }
    const state = await loadState();
    const since = req.query && req.query.since;
    if (since && state.updatedAt === since) return json(res, 200, { same: true, updatedAt: state.updatedAt, sheetError });
    const people = state.people.map(p => ({ ...p, st: computeStatus(p) }));
    const events = [...(state.events || [])].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 200);
    json(res, 200, {
      updatedAt: state.updatedAt,
      summary: summary(state),
      people,
      events,
      syncKey: process.env.SYNC_KEY || '',
      hookConfigured: !!process.env.HOOK_SECRET,
      sheetPulledAt: state.sheetPulledAt || '',
      sheetId: process.env.SHEET_ID || '',
      sheetError,
    });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
}
