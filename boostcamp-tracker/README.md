# BoostCamp 2026 — трекер участников

Живой трекер набора на кемп (цель — 50 человек «с нами на 100%»): кто перешёл в бот,
подтверждена ли бронь отеля, куплен ли билет (покупаем мы или сам), номер рейса.

- **Источник заявок** — Google Таблица «Участники» (доступ по ссылке): трекер забирает её
  CSV не чаще раза в минуту (`SHEET_ID`), новые строки и правки идут в ленту событий.
- **Ручные отметки** (отель, билет, рейсы, ответственный, спонсор, комментарий) — в трекере;
  хранятся в приватном Vercel Blob (`boostcamp/state.json`), запись с `ifMatch` по ETag.
- **Живая копия в Google Таблицу** — Apps Script из диалога «Google Таблица и бот»
  (`/api/export?key=SYNC_KEY`), либо `=IMPORTDATA(.../api/export?key=…&format=csv)`.
- **Вебхук бота** — `POST /api/hook` с заголовком `x-hook-secret: HOOK_SECRET`.
- **Вход** — пароль `DASHBOARD_PASSWORD` (как в pulse-webinar-dashboard).

Список квалифицированных из PDF (срез 28.09) в git не хранится: при деплое с локальной
машины кладётся `api/_seed.js`, либо задаётся env `SEED_JSON` (`{"people":[...]}`).

## Деплой

1. Vercel → проект `boostcamp-tracker` (Framework: Other, Output Directory: `public`).
2. Storage → Blob → создать **private** store и подключить к проекту (`BLOB_READ_WRITE_TOKEN`).
3. Env: `DASHBOARD_PASSWORD`, `SYNC_KEY`, `HOOK_SECRET`, `SHEET_ID`, при необходимости `SEED_JSON`.
4. `vercel deploy --prod` из этой папки.
