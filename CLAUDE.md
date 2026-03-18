# LT Кабинет — Мультитенантная SaaS-платформа (Telegram Mini App)

## Описание проекта

Мультитенантная SaaS-платформа для Telegram рассылок. Позволяет:
1. **Суперадмин** (telegram_id из .env SUPER_ADMIN_ID) управляет арендаторами и тарифами
2. **Арендаторы** (тенанты) — независимые пользователи со своими ботами, Leadteh-аккаунтами, рассылками
3. Полная изоляция данных между арендаторами
4. Все заходят через один платформенный бот суперадмина

## Стек технологий

- **Frontend:** HTML5, Tailwind CSS (CDN), vanilla JavaScript
- **Backend:** Express.js (Node.js)
- **Хранилище:** SQLite (sql.js — чистый JS/WASM, debounced save) — `data/broadcast.db`
- **Авторизация:** Telegram initData HMAC-SHA-256 + Bearer token сессии
- **API:** Leadteh REST API, Telegram Bot API (с retry + exponential backoff)
- **Планировщик:** встроенный node-cron (каждую минуту)
- **Деплой:** VPS + PM2

## Структура проекта

```
telegram-broadcast/
├── server.js               — Express-сервер + cron + все API-роуты
├── migrate.js              — Одноразовая миграция из .env/JSON в SQLite
├── lib/
│   ├── config.js           — Загрузка конфигурации (PORT, CRON_SECRET, PLATFORM_BOT_TOKEN)
│   ├── db.js               — Инициализация SQLite (sql.js), все таблицы, CRUD-хелперы
│   ├── auth.js             — Валидация initData (HMAC-SHA-256), роли, сессии
│   ├── middleware.js       — Express middleware (Bearer auth, requireSuperAdmin, requireTenantAdmin)
│   └── leadteh.js          — Работа с Leadteh API (контакты, теги, списки)
├── public/
│   └── index.html          — Mini App: мультишаговая форма + суперадмин-панель
├── data/
│   ├── broadcast.db        — SQLite база данных (создаётся автоматически)
│   └── uploads/{tenant_id}/ — Загруженные файлы по тенантам
├── package.json            — Зависимости: express, node-cron, sql.js
├── .env.example            — Шаблон переменных окружения
└── CLAUDE.md               — Этот файл
```

## Переменные окружения (.env)

| Переменная | Описание |
|---|---|
| `PORT` | Порт сервера (по умолчанию 3000) |
| `PLATFORM_BOT_TOKEN` | Токен платформенного бота (для валидации initData) |
| `CRON_SECRET` | Секрет для ручного вызова cron (необязательно) |
| `SUPER_ADMIN_ID` | Telegram ID суперадмина платформы |
| `FREE_MODE` | Бесплатный режим. Управляется из суперадмин-панели (Цены → переключатель). Можно принудительно задать `true`/`false` (перезаписывает БД) |

Все остальные настройки (боты, Leadteh API, админы) хранятся в SQLite.

## Архитектура аутентификации

```
Платформенный бот → Mini App → POST /api/auth (initData)
  → Валидация HMAC-SHA-256 (PLATFORM_BOT_TOKEN)
  → Определение роли: super_admin / owner / admin
  → Создание сессии (24ч) → Bearer token
  → Все API: Authorization: Bearer <token> → middleware → req.tenantId
```

## Роли

| Роль | Описание |
|---|---|
| `super_admin` | SUPER_ADMIN_ID из .env. Имеет собственный тенант (автосоздаётся при первой авторизации). Видит все табы + суперадмин-панель. Может impersonate чужих тенантов и возвращаться к своему |
| `owner` | Владелец тенанта. Управляет ботами, админами, Leadteh API |
| `admin` | Админ тенанта. Создаёт рассылки, просматривает данные |

## API роуты

### Публичные
- `GET /health` — health check (статус, uptime)
- `POST /api/auth` — авторизация через initData

### Тенант (требует Bearer token)
- `GET /api/bots` — боты тенанта
- `GET /api/tags` — теги из Leadteh
- `GET /api/contacts` — контакты с фильтрацией
- `GET /api/lists` — списки Leadteh
- `GET /api/lists/:id/items` — элементы списка
- `POST /api/broadcast/save` — сохранить рассылку (валидация parse_mode)
- `GET /api/broadcast/list` — список рассылок тенанта
- `POST /api/broadcast/delete` — удалить pending рассылку
- `POST /api/upload` — загрузка фото
- `GET /api/settings` — настройки тенанта
- `POST /api/settings/bot/add` — добавить бота (owner)
- `POST /api/settings/bot/remove` — удалить бота (owner)
- `POST /api/settings/admin/add` — добавить админа (owner)
- `POST /api/settings/admin/remove` — удалить админа (owner)
- `POST /api/settings/leadteh-token` — обновить Leadteh API токен (owner)
- `POST /api/settings/validate-token` — проверить токен бота
- `GET /api/settings/bot-lists` — привязка списков к ботам
- `POST /api/settings/bot-lists` — сохранить привязку
- `GET /api/tenant/info` — тариф и использование

### Суперадмин
- `GET /api/super/tenants` — список тенантов
- `POST /api/super/tenants` — создать тенанта
- `POST /api/super/tenants/:id/update` — обновить тенанта
- `POST /api/super/tenants/:id/delete` — удалить тенанта
- `POST /api/super/impersonate` — войти под тенантом
- `POST /api/super/exit-impersonate` — вернуться к своему тенанту
- `GET /api/super/tariffs` — тарифные планы
- `POST /api/super/tariffs` — создать тариф
- `POST /api/super/tariffs/:id/update` — обновить тариф
- `GET /api/super/stats` — статистика платформы

### Cron
- `GET /api/cron/send?secret=...` — ручной запуск отправки

## Установка с нуля

```bash
cp .env.example .env       # заполнить PLATFORM_BOT_TOKEN и SUPER_ADMIN_ID
npm install
node server.js
```

## Миграция с single-tenant

```bash
node migrate.js            # миграция .env → SQLite
npm install
node server.js
```

## Деплой (PM2)

```bash
cd /opt/telegram-broadcast
git pull
npm install
node migrate.js            # только при первой миграции
pm2 restart broadcast
```

## Безопасность

- Валидация Telegram initData через HMAC-SHA-256 (timingSafeEqual)
- Сессии с Bearer token (24ч, хранятся в SQLite)
- Все API защищены middleware авторизации
- Изоляция данных: все SQL-запросы фильтруют по tenant_id
- CORS: разрешён только Telegram WebApp и leadtehsms.ru
- Загрузки изолированы по тенантам (data/uploads/{tenant_id}/)
- Path traversal protection при доступе к файлам
- Тарифные лимиты (макс. ботов, рассылок/мес, контактов)
- Rate limiting: авторизация 5/мин, API 60/мин, загрузки 3/мин
- Валидация parse_mode (Markdown, MarkdownV2, HTML)
- Retry с exponential backoff при 429/5xx от Telegram API
- Cron обрабатывает рассылки всех тенантов, загружая credentials из БД
- Graceful shutdown с сохранением БД на диск (SIGINT/SIGTERM)

## Архитектура БД (sql.js)

- sql.js держит БД в памяти, пишет на диск debounced (500мс) + каждые 5с + при shutdown
- Транзакции: saveBroadcast, createTenant, setBotListMappings обёрнуты в BEGIN/COMMIT
- Для продакшена с высокой нагрузкой рекомендуется миграция на better-sqlite3 (нативный)

## Язык

- Интерфейс и комментарии — русский
