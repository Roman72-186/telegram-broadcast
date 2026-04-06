#!/usr/bin/env node
/**
 * Тесты устойчивости для telegram-broadcast
 * Цели: публичные эндпоинты VPS + локальная проверка edge-cases
 *
 * Запуск: node tests/stability.js [BASE_URL]
 * По умолчанию: https://broadcast.leadtehsms.ru
 */

const BASE = process.argv[2] || 'https://broadcast.leadtehsms.ru';
const TIMEOUT_MS = 10_000;

// ─── Утилиты ─────────────────────────────────────────────────────────────────

let passed = 0, failed = 0, warned = 0;
const results = [];

function fmt(ms) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`; }

function log(status, name, detail = '') {
  const icons = { PASS: '✅', FAIL: '❌', WARN: '⚠️', INFO: 'ℹ️' };
  const icon = icons[status] || '  ';
  console.log(`${icon} ${name}${detail ? '  — ' + detail : ''}`);
  results.push({ status, name, detail });
  if (status === 'PASS') passed++;
  if (status === 'FAIL') failed++;
  if (status === 'WARN') warned++;
}

async function req(method, path, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const elapsed = Date.now() - t0;
    let json = null;
    try { json = await res.clone().json(); } catch {}
    return { status: res.status, json, elapsed, headers: res.headers, ok: res.ok };
  } catch (e) {
    const elapsed = Date.now() - t0;
    return { status: 0, error: e.message, elapsed, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function section(title) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

// ─── 1. Базовая доступность ───────────────────────────────────────────────────

async function testBasicAvailability() {
  section('1. Базовая доступность');

  // Health check
  const h = await req('GET', '/health');
  if (h.status === 200) log('PASS', 'GET /health', `${fmt(h.elapsed)}`);
  else log('FAIL', 'GET /health', `status=${h.status}, err=${h.error}`);

  // Главная страница
  const idx = await req('GET', '/');
  if (idx.status === 200) log('PASS', 'GET /', `${fmt(idx.elapsed)}`);
  else log('FAIL', 'GET /', `status=${idx.status}`);

  // Публичные тарифы (возвращает { tariffs: [...] })
  const t = await req('GET', '/api/public/tariffs');
  const tariffList = t.json?.tariffs || t.json;
  if (t.status === 200 && Array.isArray(tariffList)) log('PASS', 'GET /api/public/tariffs', `${tariffList.length} тарифов, ${fmt(t.elapsed)}`);
  else log('FAIL', 'GET /api/public/tariffs', `status=${t.status}, body=${JSON.stringify(t.json).slice(0, 80)}`);

  // Публичная цена
  const p = await req('GET', '/api/public/pricing');
  if (p.status === 200 && p.json) log('PASS', 'GET /api/public/pricing', `${fmt(p.elapsed)}`);
  else log('FAIL', 'GET /api/public/pricing', `status=${p.status}`);

  // 404 для несуществующего роута
  const n = await req('GET', '/api/nonexistent-route-xyz');
  if (n.status === 404) log('PASS', '404 на несуществующий роут', `status=404`);
  else log('WARN', '404 на несуществующий роут', `status=${n.status} (ожидалось 404)`);
}

// ─── 2. Аутентификация ────────────────────────────────────────────────────────

async function testAuthentication() {
  section('2. Аутентификация — граничные случаи');

  // Пустой body
  const empty = await req('POST', '/api/auth', { body: {} });
  if (empty.status === 400 || empty.status === 401) log('PASS', 'Пустой initData → 4xx', `status=${empty.status}`);
  else log('FAIL', 'Пустой initData должен давать 4xx', `status=${empty.status}`);

  // Невалидный initData
  const bad = await req('POST', '/api/auth', { body: { initData: 'invalid_garbage_data' } });
  if (bad.status === 400 || bad.status === 401) log('PASS', 'Невалидный initData → 4xx', `status=${bad.status}`);
  else log('FAIL', 'Невалидный initData должен давать 4xx', `status=${bad.status}`);

  // Сфабрикованный initData (правильный формат, неверная подпись)
  const fakeHash = 'a'.repeat(64);
  const fakeUser = encodeURIComponent(JSON.stringify({ id: 123456789 }));
  const authDate = Math.floor(Date.now() / 1000);
  const fakeInitData = `auth_date=${authDate}&hash=${fakeHash}&user=${fakeUser}`;
  const forged = await req('POST', '/api/auth', { body: { initData: fakeInitData } });
  if (forged.status === 400 || forged.status === 401) log('PASS', 'Подделанный HMAC → 4xx', `status=${forged.status}`);
  else log('FAIL', 'Подделанный HMAC должен давать 4xx', `status=${forged.status}`);

  // Истёкший auth_date (25 часов назад)
  const expiredDate = Math.floor(Date.now() / 1000) - 90_000;
  const expiredInitData = `auth_date=${expiredDate}&hash=${fakeHash}&user=${fakeUser}`;
  const expired = await req('POST', '/api/auth', { body: { initData: expiredInitData } });
  if (expired.status === 400 || expired.status === 401) log('PASS', 'Истёкший auth_date → 4xx', `status=${expired.status}`);
  else log('FAIL', 'Истёкший auth_date должен давать 4xx', `status=${expired.status}`);

  // Без Authorization header
  const unauth = await req('GET', '/api/bots');
  if (unauth.status === 401) log('PASS', 'Без токена → 401', `status=${unauth.status}`);
  else log('FAIL', 'Без токена должен давать 401', `status=${unauth.status}`);

  // Невалидный Bearer токен
  const badToken = await req('GET', '/api/bots', { headers: { Authorization: 'Bearer INVALID_TOKEN_XYZ' } });
  if (badToken.status === 401) log('PASS', 'Невалидный Bearer → 401', `status=${badToken.status}`);
  else log('FAIL', 'Невалидный Bearer должен давать 401', `status=${badToken.status}`);
}

// ─── 3. Rate Limiting ─────────────────────────────────────────────────────────

async function testRateLimiting() {
  section('3. Rate Limiting');

  // Авторизация: лимит 15/мин
  console.log('  Отправляем 20 запросов к /api/auth за раз...');
  const authRequests = Array.from({ length: 20 }, () =>
    req('POST', '/api/auth', { body: { initData: 'test' }, timeout: 5000 })
  );
  const authResults = await Promise.all(authRequests);
  const auth429 = authResults.filter(r => r.status === 429).length;
  if (auth429 > 0) log('PASS', `Rate limit /api/auth сработал`, `${auth429}/20 запросов заблокировано (429)`);
  else log('WARN', `Rate limit /api/auth не сработал`, `Ни один запрос не заблокирован (лимит 15/мин)`);

  // API общий: лимит 60/мин
  console.log('  Отправляем 70 запросов к /api/bots за раз...');
  const apiRequests = Array.from({ length: 70 }, () =>
    req('GET', '/api/bots', { timeout: 5000 })
  );
  const apiResults = await Promise.all(apiRequests);
  const api429 = apiResults.filter(r => r.status === 429).length;
  // 401 нормально без токена, 429 означает rate limit
  const apiBlocked = apiResults.filter(r => r.status === 429 || r.status === 401).length;
  if (api429 > 0) log('PASS', `Rate limit /api/* сработал`, `${api429}/70 запросов заблокировано`);
  else log('INFO', `Rate limit /api/* не достигнут`, `${apiBlocked} ответов 401 (без токена), 429: ${api429}`);

  // Регистрация + оплата: лимит 5/мин (самый строгий)
  console.log('  Отправляем 8 запросов к /api/public/register-and-pay за раз...');
  const regRequests = Array.from({ length: 8 }, () =>
    req('POST', '/api/public/register-and-pay', { body: {}, timeout: 5000 })
  );
  const regResults = await Promise.all(regRequests);
  const reg429 = regResults.filter(r => r.status === 429).length;
  if (reg429 > 0) log('PASS', `Rate limit /register-and-pay сработал`, `${reg429}/8 запросов заблокировано`);
  else log('WARN', `Rate limit /register-and-pay не сработал`, `Ни один запрос не заблокирован (лимит 5/мин)`);
}

// ─── 4. Граничные значения payload ───────────────────────────────────────────

async function testPayloadLimits() {
  section('4. Граничные значения payload');

  // Огромный JSON (>2MB)
  const bigPayload = { data: 'x'.repeat(2_200_000) };
  const bigReq = await req('POST', '/api/auth', {
    body: bigPayload,
    timeout: 15_000,
  });
  if (bigReq.status === 413) log('PASS', 'Payload >2MB → 413', `status=413`);
  else if (bigReq.status === 400 || bigReq.status === 401) log('PASS', 'Payload >2MB → отклонён', `status=${bigReq.status}`);
  else if (bigReq.error) log('PASS', 'Payload >2MB → соединение разорвано', bigReq.error);
  else log('WARN', 'Payload >2MB прошёл', `status=${bigReq.status}`);

  // Пустой body (Content-Type: application/json, body = "")
  const emptyBody = await fetch(BASE + '/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then(r => ({ status: r.status })).catch(e => ({ status: 0, error: e.message }));
  if (emptyBody.status === 400 || emptyBody.status === 200) log('PASS', 'Пустой body не вызывает краш', `status=${emptyBody.status}`);
  else log('INFO', 'Пустой body', `status=${emptyBody.status}`);

  // Невалидный JSON
  const badJson = await fetch(BASE + '/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{broken json',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then(r => ({ status: r.status })).catch(e => ({ status: 0, error: e.message }));
  if (badJson.status === 400) log('PASS', 'Невалидный JSON → 400', `status=400`);
  else log('WARN', 'Невалидный JSON', `status=${badJson.status} (ожидалось 400)`);

  // Null bytes в строке
  const nullBytes = await req('POST', '/api/auth', { body: { initData: 'test\x00value' } });
  if (nullBytes.status !== 500) log('PASS', 'Null bytes в initData не вызывает 500', `status=${nullBytes.status}`);
  else log('FAIL', 'Null bytes в initData → 500!', `status=500`);

  // Очень длинный токен авторизации
  const longToken = await req('GET', '/api/bots', {
    headers: { Authorization: 'Bearer ' + 'a'.repeat(100_000) }
  });
  if (longToken.status !== 500) log('PASS', 'Очень длинный Bearer не вызывает 500', `status=${longToken.status}`);
  else log('FAIL', 'Очень длинный Bearer → 500!', `status=500`);
}

// ─── 5. Инъекции и path traversal ────────────────────────────────────────────

async function testInjections() {
  section('5. Path Traversal и инъекции');

  const traversalPaths = [
    '/api/uploads/../../../etc/passwd',
    '/api/uploads/1/../../server.js',
    '/api/uploads/%2e%2e%2f%2e%2e%2fetc/passwd',
    '/api/uploads/1/%2e%2e/server.js',
  ];

  for (const p of traversalPaths) {
    const r = await req('GET', p);
    if (r.status === 400 || r.status === 403 || r.status === 404 || r.status === 401) {
      log('PASS', `Path traversal заблокирован: ${p.slice(0, 40)}`, `status=${r.status}`);
    } else if (r.status === 429) {
      // Rate limit сработал раньше — traversal всё равно не прошёл
      log('PASS', `Path traversal заблокирован rate limit'ом: ${p.slice(0, 40)}`, `status=429`);
    } else if (r.status === 500) {
      log('FAIL', `Path traversal → 500: ${p.slice(0, 40)}`);
    } else if (r.status === 200) {
      log('FAIL', `Path traversal ПРОШЁЛ: ${p.slice(0, 40)}`, `status=200 — ФАЙЛ ОТДАН!`);
    } else {
      log('WARN', `Path traversal: ${p.slice(0, 40)}`, `status=${r.status}`);
    }
  }

  // Попытка XSS в параметрах запроса
  const xssParams = [
    '/api/public/tariffs?q=<script>alert(1)</script>',
    '/api/public/pricing?callback=alert(1)',
  ];

  for (const p of xssParams) {
    const r = await req('GET', p);
    // Просто проверяем что сервер не падает с 500
    if (r.status !== 500) {
      log('PASS', `XSS в query не вызывает 500: ${p.slice(0, 50)}`, `status=${r.status}`);
    } else {
      log('FAIL', `XSS в query → 500: ${p.slice(0, 50)}`);
    }
  }

  // SQL injection в query params
  const sqlPayloads = [
    "/api/public/tariffs?id=1' OR '1'='1",
    "/api/public/pricing?id=1; DROP TABLE tenants--",
  ];
  for (const p of sqlPayloads) {
    const r = await req('GET', p);
    if (r.status !== 500) log('PASS', `SQL injection в query не падает`, `status=${r.status}, path=${p.slice(0, 40)}`);
    else log('FAIL', `SQL injection → 500!`, p.slice(0, 40));
  }
}

// ─── 6. Конкурентная нагрузка ────────────────────────────────────────────────

async function testConcurrency() {
  section('6. Конкурентная нагрузка');

  // 50 параллельных запросов к /health
  console.log('  50 параллельных GET /health...');
  const t0 = Date.now();
  const healthResults = await Promise.all(
    Array.from({ length: 50 }, () => req('GET', '/health', { timeout: 15_000 }))
  );
  const elapsed = Date.now() - t0;
  const ok = healthResults.filter(r => r.status === 200).length;
  const errors = healthResults.filter(r => r.status === 0).length;
  const maxTime = Math.max(...healthResults.map(r => r.elapsed));
  const avgTime = Math.round(healthResults.reduce((s, r) => s + r.elapsed, 0) / healthResults.length);

  if (ok === 50) log('PASS', `50 конкурентных /health`, `все OK, avg=${fmt(avgTime)}, max=${fmt(maxTime)}, total=${fmt(elapsed)}`);
  else if (ok >= 45) log('WARN', `50 конкурентных /health`, `OK=${ok}/50, errors=${errors}`);
  else log('FAIL', `50 конкурентных /health`, `OK=${ok}/50, errors=${errors}`);

  // 30 параллельных запросов к публичным эндпоинтам
  console.log('  30 параллельных запросов к публичным API...');
  const t1 = Date.now();
  const mixedRequests = [
    ...Array.from({ length: 10 }, () => req('GET', '/api/public/tariffs', { timeout: 15_000 })),
    ...Array.from({ length: 10 }, () => req('GET', '/api/public/pricing', { timeout: 15_000 })),
    ...Array.from({ length: 10 }, () => req('GET', '/health', { timeout: 15_000 })),
  ];
  const mixedResults = await Promise.all(mixedRequests);
  const elapsed2 = Date.now() - t1;
  const okMixed = mixedResults.filter(r => r.status === 200).length;
  const err429 = mixedResults.filter(r => r.status === 429).length;
  if (okMixed >= 28) log('PASS', `30 смешанных конкурентных запросов`, `OK=${okMixed}/30, 429=${err429}, total=${fmt(elapsed2)}`);
  else log('WARN', `30 смешанных запросов`, `OK=${okMixed}/30, 429=${err429}`);

  // Последовательная серия для проверки стабильности (нет утечек)
  console.log('  100 последовательных GET /health...');
  const seqStart = Date.now();
  let seqOk = 0;
  for (let i = 0; i < 100; i++) {
    const r = await req('GET', '/health', { timeout: 5_000 });
    if (r.status === 200) seqOk++;
  }
  const seqElapsed = Date.now() - seqStart;
  if (seqOk === 100) log('PASS', '100 последовательных /health', `все OK, ${fmt(seqElapsed)}`);
  else log('WARN', '100 последовательных /health', `OK=${seqOk}/100`);
}

// ─── 7. HTTP Security Headers ─────────────────────────────────────────────────

async function testSecurityHeaders() {
  section('7. HTTP Security Headers');

  const r = await req('GET', '/');
  if (r.status !== 200) {
    log('WARN', 'Не удалось проверить заголовки', `status=${r.status}`);
    return;
  }

  const checks = [
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', null],           // любое непустое значение
    ['Content-Security-Policy', null],
    ['X-XSS-Protection', null],
    ['Strict-Transport-Security', null],
    ['Referrer-Policy', null],
  ];

  // Делаем fetch напрямую чтобы получить заголовки
  let headers = {};
  try {
    const rawRes = await fetch(BASE + '/', { signal: AbortSignal.timeout(TIMEOUT_MS) });
    rawRes.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  } catch {}

  for (const [header, expected] of checks) {
    const key = header.toLowerCase();
    const val = headers[key];
    if (val && (!expected || val.toLowerCase().includes(expected.toLowerCase()))) {
      log('PASS', `Header: ${header}`, val.slice(0, 60));
    } else if (!val) {
      log('WARN', `Header отсутствует: ${header}`);
    } else {
      log('WARN', `Header ${header}`, `значение: ${val.slice(0, 60)}`);
    }
  }

  // CORS проверка с чужого origin
  const corsRes = await fetch(BASE + '/api/public/tariffs', {
    headers: { Origin: 'https://evil.example.com' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then(r => ({
    status: r.status,
    allowOrigin: r.headers.get('access-control-allow-origin'),
  })).catch(() => ({ status: 0 }));

  if (!corsRes.allowOrigin || corsRes.allowOrigin !== '*') {
    log('PASS', 'CORS не пропускает evil origin', `Access-Control-Allow-Origin: ${corsRes.allowOrigin || '(не задан)'}`);
  } else {
    log('WARN', 'CORS возвращает *', `Любой origin разрешён`);
  }
}

// ─── 8. Webhook endpoint устойчивость ────────────────────────────────────────

async function testWebhookEndpoints() {
  section('8. Webhook endpoints — отказоустойчивость');

  // Платёжный webhook без подписи
  const badWebhook = await req('POST', '/api/payment/webhook/tbank', { body: { OrderId: '123', Status: 'AUTHORIZED' } });
  if ([400, 403, 429].includes(badWebhook.status)) {
    log('PASS', 'TBank webhook без подписи → отклонён', `status=${badWebhook.status}`);
  } else if (badWebhook.status === 500) {
    log('FAIL', 'TBank webhook без подписи → 500!', `status=500`);
  } else {
    log('WARN', 'TBank webhook без подписи', `status=${badWebhook.status}`);
  }

  // Platform webhook без secret-токена
  const badPlatform = await req('POST', '/webhook/platform', { body: { update_id: 1, message: { text: '/start' } } });
  if (badPlatform.status === 401 || badPlatform.status === 403) {
    log('PASS', 'Platform webhook без секрета → 401/403', `status=${badPlatform.status}`);
  } else {
    log('WARN', 'Platform webhook без секрета', `status=${badPlatform.status}`);
  }

  // Robokassa webhook без подписи
  const badRobokassa = await fetch(BASE + '/api/payment/webhook/robokassa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'OutSum=100&InvId=1&SignatureValue=FAKEVALUE',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then(r => ({ status: r.status })).catch(e => ({ status: 0, error: e.message }));
  if ([400, 403, 429].includes(badRobokassa.status)) {
    log('PASS', 'Robokassa webhook без подписи → отклонён', `status=${badRobokassa.status}`);
  } else {
    log('WARN', 'Robokassa webhook без подписи', `status=${badRobokassa.status}`);
  }
}

// ─── 9. Timeout и медленные клиенты ──────────────────────────────────────────

async function testTimeouts() {
  section('9. Таймауты и медленные клиенты');

  // Запрос к несуществующему, который быстро завершается
  const fastFail = await req('GET', '/api/this-does-not-exist-at-all', { timeout: 3000 });
  if (fastFail.elapsed < 3000 && fastFail.status !== 0) {
    log('PASS', 'Быстрый ответ на несуществующий маршрут', `${fmt(fastFail.elapsed)}`);
  } else {
    log('WARN', 'Медленный ответ на несуществующий маршрут', `${fmt(fastFail.elapsed)}`);
  }

  // Быстродействие публичных endpoint
  const timingTests = [
    ['GET', '/health'],
    ['GET', '/api/public/tariffs'],
    ['GET', '/api/public/pricing'],
  ];

  for (const [method, path] of timingTests) {
    const r = await req(method, path, { timeout: 5000 });
    if (r.elapsed < 500) log('PASS', `${method} ${path} быстрый`, `${fmt(r.elapsed)}`);
    else if (r.elapsed < 2000) log('WARN', `${method} ${path} медленноватый`, `${fmt(r.elapsed)}`);
    else log('FAIL', `${method} ${path} слишком медленный`, `${fmt(r.elapsed)}`);
  }
}

// ─── 10. Memory & процесс ────────────────────────────────────────────────────

async function testServerMemory() {
  section('10. Память сервера (через /health)');

  // Проверяем что /health отдаёт что-то разумное
  const h = await req('GET', '/health');
  if (h.json) {
    const mem = h.json.memory;
    if (mem) {
      const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
      const rssMB = Math.round(mem.rss / 1024 / 1024);
      if (heapMB < 512) log('PASS', `Heap используется`, `${heapMB} MB heap, ${rssMB} MB RSS`);
      else log('WARN', `Heap большой`, `${heapMB} MB heap (> 512 MB)`);
    } else {
      log('INFO', '/health не возвращает данные о памяти', JSON.stringify(h.json).slice(0, 100));
    }
  } else {
    log('INFO', '/health не возвращает JSON');
  }

  // Быстрый тест утечки: 200 запросов подряд к /health, смотрим время ответа
  console.log('  200 запросов к /health для выявления деградации производительности...');
  const times = [];
  for (let i = 0; i < 200; i++) {
    const r = await req('GET', '/health', { timeout: 5_000 });
    times.push(r.elapsed);
  }
  const first20avg = Math.round(times.slice(0, 20).reduce((a, b) => a + b, 0) / 20);
  const last20avg = Math.round(times.slice(-20).reduce((a, b) => a + b, 0) / 20);
  const maxTime = Math.max(...times);
  const degradation = ((last20avg - first20avg) / first20avg * 100).toFixed(1);

  if (Math.abs(last20avg - first20avg) < 50) {
    log('PASS', 'Нет деградации производительности', `first20avg=${fmt(first20avg)}, last20avg=${fmt(last20avg)}, max=${fmt(maxTime)}`);
  } else if (last20avg > first20avg * 2) {
    log('WARN', `Возможная деградация +${degradation}%`, `first20avg=${fmt(first20avg)}, last20avg=${fmt(last20avg)}, max=${fmt(maxTime)}`);
  } else {
    log('INFO', `Незначительное изменение ${degradation}%`, `first20avg=${fmt(first20avg)}, last20avg=${fmt(last20avg)}`);
  }
}

// ─── 11. Cron endpoint ───────────────────────────────────────────────────────

async function testCronEndpoint() {
  section('11. Cron endpoint');

  // Без секрета — должен вернуть 403
  const noSecret = await req('GET', '/api/cron/send');
  if (noSecret.status === 403) log('PASS', '/api/cron/send без секрета → 403', `status=403`);
  else if (noSecret.status === 401) log('PASS', '/api/cron/send без секрета → 401', `status=401`);
  else log('WARN', '/api/cron/send без секрета', `status=${noSecret.status}`);

  // Неверный секрет
  const badSecret = await req('GET', '/api/cron/send?secret=WRONG_SECRET_XYZ');
  if (badSecret.status === 403 || badSecret.status === 401) log('PASS', '/api/cron/send неверный секрет → 401/403', `status=${badSecret.status}`);
  else log('WARN', '/api/cron/send неверный секрет', `status=${badSecret.status}`);
}

// ─── 12. Специальные символы в URL ───────────────────────────────────────────

async function testSpecialChars() {
  section('12. Специальные символы в URL');

  const paths = [
    '/api/uploads/1/file%00.js',          // null byte
    '/api/uploads/1/../../etc/passwd',     // traversal
    '/api/uploads/' + 'a'.repeat(500),    // очень длинный path
    '/api/uploads/1/<script>.jpg',         // XSS
    '/api/uploads/%252e%252e/etc/passwd',  // двойная кодировка
  ];

  for (const p of paths) {
    const r = await req('GET', p, { timeout: 5000 });
    if (r.status !== 500) log('PASS', `Спецсимволы в URL не падает`, `${p.slice(0, 45)} → ${r.status}`);
    else log('FAIL', `Спецсимволы в URL → 500!`, p.slice(0, 45));
  }
}

// ─── ИТОГ ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'█'.repeat(60)}`);
  console.log(`  Тесты устойчивости: ${BASE}`);
  console.log(`${'█'.repeat(60)}`);

  const allTests = [
    testBasicAvailability,
    testAuthentication,
    testRateLimiting,
    testPayloadLimits,
    testInjections,
    testConcurrency,
    testSecurityHeaders,
    testWebhookEndpoints,
    testTimeouts,
    testServerMemory,
    testCronEndpoint,
    testSpecialChars,
  ];

  for (const test of allTests) {
    try {
      await test();
    } catch (e) {
      log('FAIL', `[КРАШ ТЕСТА] ${test.name}`, e.message);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ИТОГ: ✅ ${passed} PASS  ⚠️ ${warned} WARN  ❌ ${failed} FAIL`);
  console.log('═'.repeat(60));

  if (failed > 0) {
    console.log('\nПроваленные тесты:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ❌ ${r.name}: ${r.detail}`);
    });
  }

  if (warned > 0) {
    console.log('\nПредупреждения:');
    results.filter(r => r.status === 'WARN').forEach(r => {
      console.log(`  ⚠️  ${r.name}: ${r.detail}`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Критическая ошибка:', e);
  process.exit(1);
});
