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
- **Планировщик:** node-cron (каждую минуту, три независимых задачи)
- **Шифрование:** AES-256-GCM (`lib/encryption.js`) — токены ботов и Leadteh API
- **Экспорт:** exceljs — выгрузка результатов рассылок в Excel

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

Чат-пользователи (контакты бота) авторизуются отдельно через `POST /api/auth/chat { initData, bot_id }` — валидация по токену конкретного бота тенанта, роль `chat_user`.

### Роли и middleware

| Роль | Middleware |
|---|---|
| `super_admin` | `requireSuperAdmin` |
| `owner` | `requireTenantOwner` (owner + super_admin) |
| `admin` | `requireTenantAdmin` (admin + owner + super_admin) |
| `chat_user` | `requireChatUser` |

Доступ к диалогам дополнительно ограничен `requireDialogsAccess` (проверяет `has_dialogs` у тарифного плана).

### Маршруты (server.js)

| Префикс | Назначение |
|---|---|
| `/api/public/` | Регистрация, цены, тарифы — без авторизации |
| `/api/auth` | Создание сессии через initData |
| `/api/bots` | Управление ботами |
| `/api/contacts`, `/api/tags`, `/api/lists` | Контакты, теги, списки Leadteh |
| `/api/recipients` | Предварительный просмотр получателей (кэш) |
| `/api/broadcast/` | Рассылки: создание, список, удаление, экспорт |
| `/api/auto/` | Авторассылки: цепочки и расписания |
| `/api/chat/` | Диалоги: admin ↔ contact |
| `/api/settings/` | Настройки бота, администраторов, Leadteh |
| `/api/tariff/` | Тарифный план, докупка сообщений |
| `/api/payment/` | Webhook ТБанк/Робокасса, статус оплаты |
| `/api/super/` | Суперадмин-панель |
| `/api/cron/send` | Ручной запуск cron (CRON_SECRET) |
| `/webhook/platform` | Webhook платформенного бота (/start) |
| `/api/upload` | Загрузка фото для рассылок |

### БД (lib/db.js)

sql.js держит базу в памяти. Запись на диск: debounced 500мс + каждые 5с + при SIGINT/SIGTERM.

Обёртки над sql.js:
- `run(sql, ...params)` — INSERT/UPDATE/DELETE, возвращает `{ lastInsertRowid, changes }`
- `get(sql, ...params)` — SELECT одной строки
- `all(sql, ...params)` — SELECT всех строк

Транзакции: `beginTransaction()` / `commit()` / `rollback()`. Используются в `saveBroadcast`, `createTenant`, `setBotListMappings`.

Токены ботов и Leadteh API хранятся зашифрованными (AES-256-GCM, формат `enc:iv:authTag:data`). `decryptBotRow()` / `decryptTenantRow()` расшифровывают при чтении.

**Миграции:** «Defensive ALTER TABLE» — при старте `initDb()` проверяет наличие колонки через `PRAGMA table_info(table)`, добавляет если нет. Все 20+ миграций идемпотентны, вынесены в конец `initTables()`.

### Схема таблиц БД

```
tariff_plans            — тарифные планы (messages_limit, price, has_dialogs, is_default)
pricing_config          — глобальная конфигурация цен (id=1, singleton, free_mode)
tenants                 — арендаторы (telegram_id, leadteh_api_token, tariff_plan_id, messages_balance)
tenant_admins           — owner/admin тенанта (telegram_id, role)
bots                    — боты тенанта (token зашифрован)
broadcasts              — рассылки (status: pending/sending/done/failed, scheduled_at)
broadcast_messages      — сообщения рассылки (photo_url, text, buttons_json, parse_mode, sort_order, delay_before)
broadcast_recipients    — результаты доставки по получателям
auto_broadcasts         — авторассылки (type: chain/recurring, filters_json, status: active/paused)
auto_broadcast_steps    — шаги цепочки (step_order, delay_value, delay_unit, message_delay)
auto_broadcast_messages — сообщения шагов (photo_url, text, buttons_json, parse_mode, media_type)
auto_broadcast_enrollments — состояние прохождения цепочки (contact_telegram_id, current_step, next_step_at, status)
usage_log               — учёт рассылок по месяцам
sessions                — Bearer-сессии (expires_at +24ч)
bot_list_mappings       — привязка бот → список Leadteh
payments                — история оплат (status: pending/paid)
platform_bot_users      — пользователи, запустившие платформенного бота
chats                   — диалоги admin↔contact (bot_id, contact_telegram_id, contact_name, contact_username, unread_count)
chat_messages           — сообщения диалогов (direction: incoming/outgoing, text, status)
```

### Cron (каждую минуту, три независимые задачи)

1. **`processPendingBroadcasts()`** — обычные рассылки: находит `status='pending'` и `scheduled_at <= now`, отправляет через Telegram Bot API с exponential backoff при 429/5xx, пишет в `broadcast_recipients`.

2. **`processChainRuns()`** — цепочки авторассылок: записывает новые контакты в `auto_broadcast_enrollments`, отправляет нужный шаг цепочки, рассчитывает `next_step_at` следующего шага, помечает завершённые enrollments.

3. **`processRecurringBroadcasts()`** — периодические рассылки: сверяет `schedule_json` (время + таймзона) с текущим временем, запускает рассылку в окне ±5 минут.

Каждая задача независимо защищена от одновременного запуска флагом (`isRunning`).

### Диалоги (чаты)

Двусторонний обмен сообщениями между администратором тенанта и контактом.

- **Создание чата:** при авторизации контакта через `/api/auth/chat` → `findOrCreateChat()` сохраняет `contact_name` и `contact_username` из Telegram initData. Чат также создаётся при первой отправке от администратора (`/api/chat/send`).
- **Входящие:** контакт отправляет через `/api/chat/user/send` (роль `chat_user`). Платформенный бот уведомляет всех admin/owner тенанта.
- **Исходящие:** админ отправляет через `/api/chat/send`, бот тенанта доставляет сообщение с кнопкой «Диалог».
- **Tenant бoты НЕ имеют webhook** — платформа только отправляет сообщения через Telegram Bot API. Только платформенный бот (`/webhook/platform`) принимает входящие (только команда `/start`).

### Платёжный модуль (lib/payment.js)

Strategy-паттерн: `getProvider(config)` возвращает объект с методами `createPayment()` и `verifyWebhook()`. Реализованы провайдеры: ТБанк (securepay.tinkoff.ru/v2, подпись SHA256) и Робокасса (MD5). В FREE_MODE платёжный провайдер не инициализируется.

### Leadteh API (lib/leadteh.js)

Все вызовы к `app.leadteh.ru/api/v1` — получение контактов, тегов, списков. Контакты пагинируются по 500 штук. Leadteh Bot ID и API-токен берутся из настроек тенанта (зашифрованы в БД).

### Безопасность

- Валидация initData через HMAC-SHA-256 с timingSafeEqual
- CORS: только telegram.org, t.me, leadtehsms.ru, localhost
- Rate limiting (in-memory): авторизация 5/мин, API 60/мин, загрузки 3/мин
- Path traversal protection для `data/uploads/{tenant_id}/`
- Все SQL-запросы фильтруют по `tenant_id`
- Webhook платформенного бота верифицируется через `X-Telegram-Bot-Api-Secret-Token`
- CSP и HSTS заголовки на всех ответах

### Фронтенд (public/index.html)

Один HTML-файл (~300 КБ). Пять основных вкладок:

| Вкладка | Что внутри |
|---|---|
| **Создать** | Пошаговый мастер рассылки: бот → фильтры → сообщения → расписание → отправка |
| **Список** | История рассылок + подтабы: «Обычные», «Цепочки», «Периодические» |
| **Диалог** | Подтабы «Контакты» (из Leadteh) и «Диалоги» (существующие чаты) |
| **Настройки** | Боты, администраторы, Leadteh токен, привязка бот→список |
| **Суперадмин** | Управление тенантами, тарифами, ценами, платежами (только super_admin) |

## Язык

Интерфейс, комментарии в коде, имена переменных в SQL — русский.
