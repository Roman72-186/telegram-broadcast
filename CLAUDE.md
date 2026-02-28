# Telegram Mini App — Отложенные авторассылки

## Описание проекта

Telegram Mini App для администратора. Позволяет:
1. Написать текст сообщения (Telegram Markdown)
2. Добавить inline-кнопки (ссылки или deep links)
3. Отфильтровать получателей по тегам из Leadteh CRM
4. Выбрать дату/время отправки
5. Отправить сообщения через Telegram Bot API по расписанию

## Стек технологий

- **Frontend:** HTML5, Tailwind CSS (CDN), vanilla JavaScript
- **Backend:** Express.js (Node.js)
- **Хранилище:** JSON-файл (`data/broadcasts.json`)
- **API:** Leadteh REST API (контакты, теги), Telegram Bot API (отправка)
- **Планировщик:** встроенный node-cron (каждую минуту)
- **Деплой:** VPS + PM2

## Структура проекта

```
telegram-broadcast/
├── server.js               — Express-сервер + cron + все API-роуты
├── lib/
│   ├── config.js           — Загрузка конфигурации (.env)
│   ├── storage.js          — CRUD рассылок (JSON-файл)
│   └── leadteh.js          — Работа с Leadteh API
├── public/
│   └── index.html          — Mini App: мультишаговая форма
├── data/
│   └── broadcasts.json     — Данные рассылок (создаётся автоматически)
├── package.json            — Зависимости: express, node-cron
├── .env.example            — Шаблон переменных окружения
├── .gitignore              — Исключения для git
└── CLAUDE.md               — Этот файл
```

## Переменные окружения (.env)

| Переменная | Описание |
|---|---|
| `PORT` | Порт сервера (по умолчанию 3000) |
| `LEADTEH_API_TOKEN` | Токен Leadteh API |
| `LEADTEH_BOT_ID` | ID бота в Leadteh (257034) |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота |
| `ADMIN_TELEGRAM_IDS` | telegram_id админов через запятую |
| `CRON_SECRET` | Секрет для ручного вызова cron (необязательно) |

## API роуты

- `GET /api/tags` — уникальные теги из Leadteh
- `GET /api/contacts?include=...&exclude=...&count_only=true` — контакты с фильтрацией
- `POST /api/broadcast/save` — сохранить рассылку
- `GET /api/broadcast/list` — список рассылок
- `POST /api/broadcast/delete` — удалить pending рассылку
- `GET /api/cron/send?secret=...` — ручной запуск отправки

## Установка и запуск

```bash
cp .env.example .env       # заполнить переменные
npm install
npm start                  # запуск на порту 3000
```

## Деплой (PM2)

```bash
npm install -g pm2
pm2 start server.js --name broadcast
pm2 save
pm2 startup
```

## Безопасность

- Фронтенд проверяет telegram_id при сохранении рассылки (ADMIN_TELEGRAM_IDS)
- Cron встроен в процесс, внешний доступ защищён CRON_SECRET
- Токены хранятся в .env (не в коде, не в git)

## Язык

- Интерфейс и комментарии — русский
