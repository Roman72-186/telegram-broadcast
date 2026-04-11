# Интеграция с Тинькофф Банком (TBank Acquiring API v2)

## Обзор

Проект поддерживает два платёжных провайдера: ТБанк и Робокасса. Оба реализованы через strategy-паттерн в `lib/payment.js`. Провайдер инициализируется один раз при старте сервера.

**Платёжный модуль отключён в FREE_MODE** — `paymentProvider` будет `null`, и все ветки с реальной оплатой пропускаются, уступая место ручному режиму (уведомление суперадмину).

---

## Файлы

| Файл | Роль |
|---|---|
| `lib/payment.js` | Реализация провайдеров (ТБанк + Робокасса) и фабрика `getProvider()` |
| `lib/config.js` | Загрузка переменных окружения в объект `config` |
| `server.js` | Инициализация провайдера, API-эндпоинты, webhook |
| `public/payment-success.html` | Страница успешной оплаты |
| `public/payment-fail.html` | Страница неудачной оплаты |

---

## Переменные окружения (.env)

```env
PAYMENT_PROVIDER=tbank
BASE_URL=https://broadcast.leadtehsms.ru

TBANK_TERMINAL_KEY=1773060883781   # боевой терминал на VPS
TBANK_PASSWORD=<пароль терминала>
TBANK_TEST_MODE=false              # по умолчанию true (если не 'false')
```

> **Важно:** `TBANK_TEST_MODE` по умолчанию `true` — чтобы включить боевой режим нужно явно указать `TBANK_TEST_MODE=false`.
>
> DEMO-терминалы тоже работают через `https://securepay.tinkoff.ru/v2` (rest-api-test.tinkoff.ru возвращает 403).

### Загрузка в config (`lib/config.js:51-54`)

```js
tbankTerminalKey: process.env.TBANK_TERMINAL_KEY || '',
tbankPassword:    process.env.TBANK_PASSWORD    || '',
tbankTestMode:    process.env.TBANK_TEST_MODE !== 'false',
```

---

## Реализация провайдера (`lib/payment.js`)

### Инициализация (`getProvider`, строки 130-138)

```js
function getProvider(config) {
  if (config.paymentProvider === 'tbank' && config.tbankTerminalKey && config.tbankPassword) {
    return createTbankProvider(config);
  }
  // ...
  return null; // ручной режим
}
```

Провайдер возвращает объект `{ name: 'tbank', createPayment(), verifyWebhook() }`.

---

### Генерация токена (`generateToken`, строки 11-21)

Алгоритм подписи по документации ТБанк:

1. Взять все поля запроса (включая `Password`, исключая вложенные объекты и массивы).
2. Отсортировать по имени ключа.
3. Конкатенировать значения в одну строку.
4. Взять SHA-256 от строки.

```js
function generateToken(params) {
  const data = { ...params, Password: config.tbankPassword };
  const keys = Object.keys(data)
    .filter(k => typeof data[k] !== 'object')
    .sort();
  const concatenated = keys.map(k => data[k]).join('');
  return crypto.createHash('sha256').update(concatenated).digest('hex');
}
```

---

### Создание платежа (`createPayment`, строки 26-53)

Вызывает `POST https://securepay.tinkoff.ru/v2/Init`.

**Параметры запроса:**

| Поле | Значение |
|---|---|
| `TerminalKey` | `config.tbankTerminalKey` |
| `Amount` | сумма в **копейках** (`Math.round(amount * 100)`) |
| `OrderId` | ID платежа из нашей БД (строка) |
| `Description` | `'Оплата тарифа LT Кабинет'` или переданная строка |
| `NotificationURL` | `${BASE_URL}/api/payment/webhook/tbank` |
| `SuccessURL` | `${BASE_URL}/payment-success.html` |
| `FailURL` | `${BASE_URL}/payment-fail.html` |
| `Token` | SHA-256 подпись |

**Ответ ТБанка:**

```json
{
  "Success": true,
  "PaymentURL": "https://securepay.tinkoff.ru/...",
  "PaymentId": "12345678"
}
```

Функция возвращает `{ paymentUrl, externalId }`.

---

### Верификация вебхука (`verifyWebhook`, строки 55-67)

ТБанк присылает JSON-тело с полем `Token`. Верификация:

1. Убрать `Token` из тела.
2. Пересчитать `generateToken(rest)`.
3. Сравнить с полученным токеном.

```js
verifyWebhook(body) {
  const { Token: receivedToken, ...rest } = body;
  const expectedToken = generateToken(rest);
  const verified = receivedToken === expectedToken;
  return {
    verified,
    orderId:    body.OrderId    ? String(body.OrderId)    : null,
    externalId: body.PaymentId  ? String(body.PaymentId)  : null,
    status:     body.Status,
    amount:     body.Amount ? Math.round(body.Amount / 100) : 0, // копейки → рубли
  };
}
```

---

## API-эндпоинты (`server.js`)

### Инициализация (`server.js:19`)

```js
const paymentProvider = config.freeMode ? null : getProvider(config);
```

---

### `POST /api/tariff/apply` — оплата тарифа (строки 1557-1617)

1. Найти тарифный план по `plan_id`.
2. Создать запись `payments` в БД → `paymentId`.
3. Вызвать `paymentProvider.createPayment(paymentId, amount, description)`.
4. Сохранить `external_id`, `payment_url`, `provider` в БД.
5. Уведомить суперадмина в Telegram (`💳 Новый платёж`).
6. Вернуть клиенту `{ ok, payment_id, amount, payment_url }`.

В ручном режиме (`paymentProvider === null`) — только уведомление суперадмину, без `payment_url`.

---

### `POST /api/tariff/buy-messages` — докупка сообщений (строки 1627-1673)

Аналогично `/api/tariff/apply`, но тип платежа `'extra'` и в `contacts` хранится количество сообщений.

---

### `GET /api/tariff/payments` — список платежей тенанта (строки 1675-1683)

Возвращает `{ payments }` из БД по `tenant_id`.

---

### `POST /api/payment/webhook/tbank` — вебхук от ТБанка (строки 1688-1742)

**Без авторизации** (только проверка подписи).

Логика:
1. Проверить, что `paymentProvider.name === 'tbank'`.
2. Вызвать `verifyWebhook(req.body)` — если подпись неверна, ответить `403 FAIL`.
3. При `status === 'CONFIRMED'`:
   - Найти платёж по `externalId` → `db.findPaymentByExternalId()`.
   - Если платёж уже `paid` — вернуть `OK` (идемпотентность).
   - Подтвердить платёж → `db.confirmPayment(payment.id)`.
   - Если тенант в статусе `pending_payment` → установить `status: 'active'`.
   - Уведомить суперадмина (`✅ Оплата #N подтверждена (ТБанк)`).
4. Всегда отвечать `200 OK` (ТБанк ожидает `OK` в теле).

---

### `GET /api/payment/status/:id` — статус платежа (строки 1787-1799)

Polling-эндпоинт. Клиент вызывает после возврата со страницы оплаты.
Возвращает `{ status, paid_at }` платежа из БД.

---

### `GET /api/super/payments` — все платежи (суперадмин)

Возвращает все платежи по всем тенантам.

---

### `POST /api/super/payments/:id/confirm` — ручное подтверждение (суперадмин)

Используется в ручном режиме или при проблемах с автоматической оплатой.

---

## Схема платёжного flow

```
Клиент (Mini App)
  │
  ├─ POST /api/tariff/apply { plan_id }
  │     └─ createPayment() → ТБанк API /v2/Init
  │              └─ { PaymentURL, PaymentId }
  │
  ├─ Получает payment_url → tg.openLink(payment_url)
  │
  │          [ Пользователь оплачивает на странице ТБанка ]
  │
  ├─ ТБанк → POST /api/payment/webhook/tbank  (async)
  │     ├─ verifyWebhook() — проверка подписи
  │     ├─ confirmPayment() — запись в БД
  │     ├─ updateTenant({ status: 'active' }) — если pending_payment
  │     └─ sendMessage суперадмину ✅
  │
  └─ ТБанк редиректит → /payment-success.html или /payment-fail.html
        └─ Клиент делает polling GET /api/payment/status/:id
```

---

## Страницы редиректа

### `public/payment-success.html`
- Отображает «Оплата прошла успешно!»
- Ссылка: «Открыть бот» → `https://t.me/starts_klick_bot`
- Совет подождать минуту если тариф ещё не активировался

### `public/payment-fail.html`
- Отображает «Оплата не завершена»
- Ссылка на возврат в бот + ссылка на поддержку (`t.me/roman_chatbots`)

---

## Frontend (`public/index.html`)

Ключевые функции:

### `applyTariff()` (строка ~2129)
```js
// Открывает платёжную ссылку ТБанка
if (tg?.openLink) tg.openLink(data.payment_url);
else window.location.href = data.payment_url;
```

### `buyExtraMessages()` (строка ~2179)
Аналогично — отправляет `POST /api/tariff/buy-messages`, получает `payment_url`, открывает.

### Обработка возврата (строка ~1960)
Проверяет параметр `?payment=success` / `?payment=fail` в URL при открытии Mini App.

---

## Боевой стенд (VPS)

- **Терминал:** `TBANK_TERMINAL_KEY=1773060883781`
- **Режим:** `TBANK_TEST_MODE=false` (боевой)
- **Webhook URL:** `https://broadcast.leadtehsms.ru/api/payment/webhook/tbank`
- **Приложение:** `/opt/telegram-broadcast`, PM2 имя `broadcast`

---

## Замечания и особенности

1. **`confirm()` недоступен в Telegram Mini App** — заменён на `tg.showConfirm()` или убран.
2. **Идемпотентность вебхука** — если платёж уже `paid`, повторный вебхук игнорируется.
3. **Сумма в копейках** — ТБанк принимает `Amount` в копейках (`* 100`), возвращает тоже в копейках.
4. **`Payment_url` клиенту открывает Telegram** через `tg.openLink`, не через `window.open` — иначе не работает в Mini App.
5. **Ручной режим** — если `paymentProvider === null`, суперадмин подтверждает вручную через `POST /api/super/payments/:id/confirm`.
