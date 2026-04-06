# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# LT Кабинет — Мультитенантная SaaS-платформа (Telegram Mini App)

## Команды

```bash
# Запуск
npm start              # node server.js (продакшн)
npm run dev            # то же самое

# Одноразовая миграция из .env/JSON → SQLite
node migrate.js

# Деплой на VPS
bash deploy.sh "commit message"
```

Тестов нет. Для ручной проверки cron: `GET /api/cron/send?secret=<CRON_SECRET>`.  
Health check: `GET /health`.

## Стек

- **Backend:** Express.js (Node.js), без TypeScript
- **БД:** SQLite через sql.js (WASM, in-memory + debounced disk save) — `data/broadcast.db`
- **Frontend:** `public/index.html` — один HTML-файл, Tailwind CSS (CDN), vanilla JS
- **Планировщик:** node-cron (каждую минуту проверяет pending рассылки)
- **Шифрование:** AES-256-GCM (`lib/encryption.js`) — токены ботов и Leadteh API

## Переменные окружения (.env)

| Переменная | Описание |
|---|---|
| `PLATFORM_BOT_TOKEN` | Токен платформенного бота (для валидации initData) |
| `SUPER_ADMIN_ID` | Telegram ID суперадмина |
| `ENCRYPTION_KEY` | 64-символьный hex (32 байта AES-256). Автогенерируется при первом запуске и записывается в .env — **не терять** |
| `PORT` | Порт (по умолчанию 3000) |
| `CRON_SECRET` | Секрет для ручного вызова cron (необязательно) |
| `FREE_MODE` | `true`/`false` — перезаписывает значение из БД при старте |
| `BASE_URL` | Публичный URL приложения (нужен для платёжных webhook) |
| `PAYMENT_PROVIDER` | `tbank` или `robokassa` |
| `TBANK_TERMINAL_KEY`, `TBANK_PASSWORD`, `TBANK_TEST_MODE` | ТБанк |
| `ROBOKASSA_LOGIN`, `ROBOKASSA_PASSWORD1`, `ROBOKASSA_PASSWORD2`, `ROBOKASSA_TEST_MODE` | Робокасса |

Все остальные настройки (боты, Leadteh API, админы) хранятся в SQLite.

## Архитектура

### Аутентификация и сессии

```
Telegram Mini App → POST /api/auth { initData }
  → validateInitData() HMAC-SHA-256 (PLATFORM_BOT_TOKEN)
  → getUserRole() → super_admin / owner / admin / none
  → createSession() → Bearer token (24ч, хранится в sessions)
  → Все API: Authorization: Bearer → authMiddleware → req.tenantId / req.role
```

Impersonate: суперадмин вызывает `POST /api/super/impersonate` → сессия переключается на тенанта. `POST /api/super/exit-impersonate` — возврат к своему тенанту. Суперадмин при этом имеет собственный тенант (автосоздаётся при первой авторизации).

### Роли и middleware

| Роль | Middleware |
|---|---|
| `super_admin` | `requireSuperAdmin` |
| `owner` | `requireTenantOwner` (owner + super_admin) |
| `admin` | `requireTenantAdmin` (admin + owner + super_admin) |
| `chat_user` | `requireChatUser` |

### БД (lib/db.js)

sql.js держит базу в памяти. Запись на диск: debounced 500мс + каждые 5с + при SIGINT/SIGTERM.

Обёртки над sql.js:
- `run(sql, ...params)` — INSERT/UPDATE/DELETE, возвращает `{ lastInsertRowid, changes }`
- `get(sql, ...params)` — SELECT одной строки
- `all(sql, ...params)` — SELECT всех строк

Транзакции: `beginTransaction()` / `commit()` / `rollback()`. Используются в `saveBroadcast`, `createTenant`, `setBotListMappings`.

Токены ботов и Leadteh API хранятся зашифрованными (AES-256-GCM, формат `enc:iv:authTag:data`). `decryptBotRow()` / `decryptTenantRow()` расшифровывают при чтении.

### Схема таблиц БД

```
tariff_plans       — тарифные планы (messages_limit, price, is_default)
pricing_config     — глобальная конфигурация цен (id=1, singleton)
tenants            — арендаторы (telegram_id, leadteh_api_token, tariff_plan_id, status)
tenant_admins      — owner/admin тенанта (telegram_id, role)
bots               — боты тенанта (token зашифрован)
broadcasts         — рассылки (status: pending/sending/done/failed)
broadcast_messages — сообщения рассылки (photo_url, text, buttons_json, sort_order)
broadcast_recipients — результаты доставки по получателям
auto_broadcasts    — авторассылки (type: chain)
auto_broadcast_steps — шаги авторассылки (delay_value, delay_unit)
auto_broadcast_messages — сообщения шагов авторассылки
usage_log          — учёт рассылок по месяцам
sessions           — Bearer-сессии (expires_at +24ч)
bot_list_mappings  — привязка бот → список Leadteh
payments           — история оплат (status: pending/paid)
platform_bot_users — пользователи, запустившие платформенного бота
```

### Cron (каждую минуту)

Находит `broadcasts` со `status='pending'` и `scheduled_at <= now`, загружает credentials бота из БД, отправляет сообщения через Telegram Bot API с exponential backoff при 429/5xx. Обрабатывает рассылки всех тенантов в одном процессе.

### Платёжный модуль (lib/payment.js)

Strategy-паттерн: `getProvider(config)` возвращает объект с методами `createPayment()` и `verifyWebhook()`. Реализованы провайдеры: ТБанк (securepay.tinkoff.ru/v2) и Робокасса. В FREE_MODE платёжный провайдер не инициализируется.

### Leadteh API (lib/leadteh.js)

Все вызовы к `app.leadteh.ru/api/v1` — получение контактов, тегов, списков. Контакты пагинируются по 500 штук. Leadteh Bot ID и API-токен берутся из настроек тенанта.

### Безопасность

- Валидация initData через HMAC-SHA-256 с timingSafeEqual
- CORS: только telegram.org, t.me, leadtehsms.ru, localhost
- Rate limiting (in-memory): авторизация 5/мин, API 60/мин, загрузки 3/мин
- Path traversal protection для `data/uploads/{tenant_id}/`
- Все SQL-запросы фильтруют по `tenant_id`
- Webhook платформенного бота верифицируется через `X-Telegram-Bot-Api-Secret-Token`

## Язык

Интерфейс, комментарии в коде, имена переменных в SQL — русский.
