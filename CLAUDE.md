# Telegram Mini App — Мультитенантная SaaS-платформа для рассылок

## Описание проекта

Мультитенантная SaaS-платформа для Telegram рассылок. Позволяет:
1. **Суперадмин** (telegram_id: 5444227047) управляет арендаторами и тарифами
2. **Арендаторы** (тенанты) — независимые пользователи со своими ботами, Leadteh-аккаунтами, рассылками
3. Полная изоляция данных между арендаторами
4. Все заходят через один платформенный бот суперадмина

## Стек технологий

- **Frontend:** HTML5, Tailwind CSS (CDN), vanilla JavaScript
- **Backend:** Express.js (Node.js)
- **Хранилище:** SQLite (better-sqlite3) — `data/broadcast.db`
- **Авторизация:** Telegram initData HMAC-SHA-256 + Bearer token сессии
- **API:** Leadteh REST API, Telegram Bot API
- **Планировщик:** встроенный node-cron (каждую минуту)
- **Деплой:** VPS + PM2

## Структура проекта

```
telegram-broadcast/
├── server.js               — Express-сервер + cron + все API-роуты
├── migrate.js              — Одноразовая миграция из .env/JSON в SQLite
├── lib/
│   ├── config.js           — Загрузка конфигурации (PORT, CRON_SECRET, PLATFORM_BOT_TOKEN)
│   ├── db.js               — Инициализация SQLite, все таблицы, CRUD-хелперы
│   ├── auth.js             — Валидация initData (HMAC-SHA-256), роли, сессии
│   ├── middleware.js       — Express middleware (Bearer auth, requireSuperAdmin, requireTenantAdmin)
│   ├── leadteh.js          — Работа с Leadteh API (контакты, теги, списки)
│   └── storage.js          — [УСТАРЕВШИЙ] JSON-хранилище (заменён SQLite)
├── public/
│   └── index.html          — Mini App: мультишаговая форма + суперадмин-панель
├── data/
│   ├── broadcast.db        — SQLite база данных (создаётся автоматически)
│   └── uploads/{tenant_id}/ — Загруженные файлы по тенантам
├── package.json            — Зависимости: express, node-cron, better-sqlite3
├── .env.example            — Шаблон переменных окружения
└── CLAUDE.md               — Этот файл
```

## Переменные окружения (.env)

| Переменная | Описание |
|---|---|
| `PORT` | Порт сервера (по умолчанию 3000) |
| `PLATFORM_BOT_TOKEN` | Токен платформенного бота (для валидации initData) |
| `CRON_SECRET` | Секрет для ручного вызова cron (необязательно) |

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
| `super_admin` | telegram_id 5444227047. Управляет тенантами, тарифами, статистикой |
| `owner` | Владелец тенанта. Управляет ботами, админами, Leadteh API |
| `admin` | Админ тенанта. Создаёт рассылки, просматривает данные |

## API роуты

### Публичные
- `POST /api/auth` — авторизация через initData

### Тенант (требует Bearer token)
- `GET /api/bots` — боты тенанта
- `GET /api/tags` — теги из Leadteh
- `GET /api/contacts` — контакты с фильтрацией
- `GET /api/lists` — списки Leadteh
- `GET /api/lists/:id/items` — элементы списка
- `POST /api/broadcast/save` — сохранить рассылку
- `GET /api/broadcast/list` — список рассылок тенанта
- `POST /api/broadcast/delete` — удалить pending рассылку
- `POST /api/upload` — загрузка фото
- `GET /api/settings` — настройки тенанта
- `POST /api/settings/bot/add` — добавить бота (owner)
- `POST /api/settings/bot/remove` — удалить бота (owner)
- `POST /api/settings/admin/add` — добавить админа (owner)
- `POST /api/settings/admin/remove` — удалить админа (owner)
- `POST /api/settings/leadteh-token` — обновить Leadteh API токен (owner)
- `GET /api/settings/bot-lists` — привязка списков к ботам
- `POST /api/settings/bot-lists` — сохранить привязку
- `GET /api/tenant/info` — тариф и использование

### Суперадмин
- `GET /api/super/tenants` — список тенантов
- `POST /api/super/tenants` — создать тенанта
- `POST /api/super/tenants/:id/update` — обновить тенанта
- `POST /api/super/impersonate` — войти под тенантом
- `GET /api/super/tariffs` — тарифные планы
- `POST /api/super/tariffs` — создать тариф
- `POST /api/super/tariffs/:id/update` — обновить тариф
- `GET /api/super/stats` — статистика платформы

### Cron
- `GET /api/cron/send?secret=...` — ручной запуск отправки

## Установка с нуля

```bash
cp .env.example .env       # заполнить PLATFORM_BOT_TOKEN
npm install
node server.js
```

## Миграция с single-tenant

```bash
node migrate.js            # миграция .env → SQLite
npm install                # установит better-sqlite3
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

- Валидация Telegram initData через HMAC-SHA-256
- Сессии с Bearer token (24ч, хранятся в SQLite)
- Все API защищены middleware авторизации
- Изоляция данных: все SQL-запросы фильтруют по tenant_id
- CORS: разрешён только Telegram WebApp
- Загрузки изолированы по тенантам (data/uploads/{tenant_id}/)
- Тарифные лимиты (макс. ботов, рассылок/мес, контактов)
- Cron обрабатывает рассылки всех тенантов, загружая credentials из БД

## Язык

- Интерфейс и комментарии — русский
