// Вход в трекер BoostCamp — та же схема, что в pulse-webinar-dashboard:
// своя страница входа и cookie (системное окно Basic Auth не появляется во
// встроенных браузерах Telegram). Basic Auth оставлен для скриптов и curl.
// /api/hook (бот) и /api/export (Google Таблица) проверяют свои ключи сами.
export const config = { matcher: '/:path*' };

// Иконки отдаём без пароля: данных в них нет.
const PUBLIC = new Set(['/favicon.svg', '/favicon.ico', '/api/hook', '/api/export']);
const COOKIE = 'bc_tracker';
const MONTH = 60 * 60 * 24 * 30;

const enc = new TextEncoder();

// Подпись cookie. В cookie лежит не пароль, а HMAC от него: при смене
// пароля все старые сессии перестают действовать сами.
async function sessionToken(secret) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('boostcamp-tracker-v1'));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Сравнение без утечки по времени: сравниваем подписи одинаковой длины.
async function samePassword(given, expected) {
  const [a, b] = await Promise.all([sessionToken(given), sessionToken(expected)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Логин и пароль из заголовка Basic. Любая порча — «не вошёл», не падение.
function readBasic(auth) {
  if (!auth) return null;
  const [scheme, encoded] = auth.trim().split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== 'basic' || !encoded) return null;
  try {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const sep = decoded.indexOf(':');
    return sep < 0 ? null : { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

// Возврат только на свой сайт: «//evil.com» и полные адреса отбрасываем.
function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function loginPage(next, failed) {
  const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Вход · BoostCamp трекер</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root { --bg:#121212; --bg-2:#1a1a1e; --ink:#f0f0f5; --ink-2:#c8c8d4; --ink-3:#8a8a9c;
          --accent:#ff4d00; --accent-bright:#ff6b1a; --line:#ffffff1f; --err:#ff5252;
          --sans:"Manrope",-apple-system,"Segoe UI",sans-serif; --mono:"DM Mono","SF Mono",Menlo,monospace; }
  * { box-sizing:border-box; margin:0 }
  body { min-height:100vh; display:grid; place-items:center; padding:24px;
         background:radial-gradient(circle at 78% -4%, #ff4d0018, transparent 34%), var(--bg);
         color:var(--ink); font-family:var(--sans); }
  .card { width:100%; max-width:380px; background:var(--bg-2); border:1px dashed var(--line);
          border-radius:24px; padding:32px 28px; }
  .kicker { font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase;
            color:var(--ink-3); margin-bottom:12px }
  h1 { font-size:24px; font-weight:800; margin-bottom:24px }
  h1 b { color:var(--accent); font-weight:800 }
  label { display:block; font-family:var(--mono); font-size:11px; letter-spacing:.07em;
          text-transform:uppercase; color:var(--ink-3); margin-bottom:8px }
  input { width:100%; padding:12px 14px; border-radius:12px; border:1px solid var(--line);
          background:#121212; color:var(--ink); font:500 15px var(--sans); }
  input:focus { outline:none; border-color:var(--accent) }
  button { width:100%; margin-top:16px; padding:13px; border:0; border-radius:12px;
           background:var(--accent); color:#121212; font:700 15px var(--sans); cursor:pointer;
           transition:background .15s }
  button:hover { background:var(--accent-bright) }
  .err { margin-top:14px; font-size:13px; color:var(--err) }
  .hint { margin-top:18px; font-size:12px; color:var(--ink-3) }
</style></head><body>
<form class="card" method="post" action="/__login">
  <div class="kicker">Pulse Platform · BoostCamp 2026</div>
  <h1>Трекер <b>участников</b></h1>
  <label for="p">Пароль</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required autofocus>
  <input type="hidden" name="next" value="${esc(next)}">
  <button type="submit">Войти</button>
  ${failed ? '<div class="err">Неверный пароль. Попробуйте ещё раз.</div>' : ''}
  <div class="hint">Доступ только для команды. Вход сохраняется на 30 дней.</div>
</form></body></html>`;
  // Без заголовка WWW-Authenticate: иначе браузер снова покажет системное
  // окно и может уйти в цикл повторов.
  return new Response(html, {
    status: 401,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default async function middleware(request) {
  const url = new URL(request.url);
  if (PUBLIC.has(url.pathname)) return;

  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    return new Response('Пароль трекера не настроен.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const token = await sessionToken(expected);

  // отправка формы входа
  if (url.pathname === '/__login') {
    if (request.method !== 'POST') return Response.redirect(new URL('/', url), 303);
    let form;
    try { form = await request.formData(); } catch { return loginPage('/', true); }
    const next = safeNext(form.get('next'));
    const given = String(form.get('password') || '');
    if (given && await samePassword(given, expected)) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: next,
          'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=${MONTH}; HttpOnly; Secure; SameSite=Lax`,
          'Cache-Control': 'no-store',
        },
      });
    }
    return loginPage(next, true);
  }

  // выход
  if (url.pathname === '/__logout') {
    return new Response(null, {
      status: 303,
      headers: { Location: '/', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` },
    });
  }

  // уже вошёл
  if (readCookie(request, COOKIE) === token) return;

  // скрипты и curl по-прежнему могут ходить через Basic Auth
  const basic = readBasic(request.headers.get('authorization'));
  if (basic && basic.user.trim().toLowerCase() === (process.env.DASHBOARD_USER || 'pulse')
      && await samePassword(basic.pass, expected)) return;

  // данные дашборда отдаём только вошедшим; для них страница входа не нужна
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('.json')) {
    return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  return loginPage(safeNext(url.pathname + url.search), false);
}
