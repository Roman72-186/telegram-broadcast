// server.js — Express-сервер для рассылок
const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { loadConfig, getBotById } = require('./lib/config');
const storage = require('./lib/storage');

const app = express();
const config = loadConfig();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// API: Проверка админа
// ============================================
app.get('/api/auth', (req, res) => {
  const telegramId = req.query.telegram_id;
  if (!telegramId) {
    return res.json({ admin: false });
  }
  const isAdmin = config.adminTelegramIds.includes(String(telegramId));
  return res.json({ admin: isAdmin });
});

// ============================================
// Хелпер: конфиг бота из запроса
// ============================================
function getBotConfig(req) {
  const botId = req.query.bot_id || req.body?.bot_id;
  const bot = getBotById(config, botId);
  if (!bot) return null;
  return {
    leadtehApiToken: config.leadtehApiToken,
    leadtehBotId: bot.leadtehBotId,
    telegramBotToken: bot.token,
  };
}

// ============================================
// Привязка списков к ботам
// ============================================
const botListsPath = path.join(__dirname, 'data', 'bot-lists.json');

function loadBotLists() {
  try {
    if (fs.existsSync(botListsPath)) {
      return JSON.parse(fs.readFileSync(botListsPath, 'utf-8'));
    }
  } catch (e) {
    console.error('Ошибка чтения bot-lists.json:', e.message);
  }
  return {};
}

function saveBotLists(mapping) {
  const dir = path.dirname(botListsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(botListsPath, JSON.stringify(mapping, null, 2), 'utf-8');
}

// ============================================
// Хелперы настроек
// ============================================
function requireAdmin(req, res) {
  const adminId = req.query.admin_id || req.body?.admin_id;
  if (!adminId || !config.adminTelegramIds.includes(String(adminId))) {
    res.status(403).json({ error: 'Доступ запрещён' });
    return false;
  }
  return true;
}

function maskToken(token) {
  if (!token || token.length < 10) return '***';
  return token.slice(0, 4) + '...' + token.slice(-3);
}

function readPreservedEnvKeys(envPath) {
  const preserved = {};
  if (!fs.existsSync(envPath)) return preserved;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (['PORT', 'LEADTEH_API_TOKEN', 'CRON_SECRET'].includes(key)) {
      preserved[key] = value;
    }
  }
  return preserved;
}

// ============================================
// API: Настройки — получить
// ============================================
app.get('/api/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const bots = config.bots.map((b, i) => ({
    id: b.id,
    name: b.name,
    token_masked: maskToken(b.token),
    leadteh_id: b.leadtehBotId || '',
    index: i,
  }));

  res.json({
    bots,
    admin_ids: config.adminTelegramIds,
  });
});

// ============================================
// API: Настройки — сохранить
// ============================================
app.post('/api/settings/save', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { admin_id, bots: newBots, admin_ids: newAdminIds } = req.body;

  // Валидация
  if (!Array.isArray(newBots) || newBots.length === 0) {
    return res.status(400).json({ error: 'Нужен минимум 1 бот' });
  }
  if (!Array.isArray(newAdminIds) || newAdminIds.length === 0) {
    return res.status(400).json({ error: 'Нужен минимум 1 админ' });
  }
  if (!newAdminIds.includes(String(admin_id))) {
    return res.status(400).json({ error: 'Нельзя удалить себя из админов' });
  }

  // Собираем токены ботов
  const resolvedBots = [];
  for (let i = 0; i < newBots.length; i++) {
    const bot = newBots[i];
    let token = bot.token || '';

    // Существующий бот без нового токена — берём из текущего конфига
    if (!token && bot.is_existing && bot.original_index != null) {
      const origBot = config.bots[bot.original_index];
      if (origBot) {
        token = origBot.token;
      }
    }

    if (!token) {
      return res.status(400).json({ error: `Бот "${bot.name || i + 1}" — токен не задан` });
    }

    resolvedBots.push({
      name: bot.name || `Бот ${i + 1}`,
      token,
      leadteh_id: bot.leadteh_id || '',
    });
  }

  // Читаем сохраняемые переменные из текущего .env
  const envPath = path.join(__dirname, '.env');
  const preserved = readPreservedEnvKeys(envPath);

  // Бэкап
  if (fs.existsSync(envPath)) {
    fs.copyFileSync(envPath, envPath + '.backup');
  }

  // Генерация нового .env
  let envContent = '';
  envContent += `PORT=${preserved.PORT || config.port || 3000}\n`;
  envContent += `LEADTEH_API_TOKEN=${preserved.LEADTEH_API_TOKEN || config.leadtehApiToken || ''}\n`;
  envContent += `CRON_SECRET=${preserved.CRON_SECRET || config.cronSecret || ''}\n`;
  envContent += `ADMIN_TELEGRAM_IDS=${newAdminIds.join(',')}\n\n`;

  for (let i = 0; i < resolvedBots.length; i++) {
    const n = i + 1;
    const bot = resolvedBots[i];
    envContent += `BOT_${n}_NAME=${bot.name}\n`;
    envContent += `BOT_${n}_TOKEN=${bot.token}\n`;
    envContent += `BOT_${n}_LEADTEH_ID=${bot.leadteh_id}\n`;
    if (i < resolvedBots.length - 1) envContent += '\n';
  }

  fs.writeFileSync(envPath, envContent, 'utf-8');

  res.json({ ok: true, message: 'Настройки сохранены. Сервер перезагружается...' });

  // PM2 автоматически рестартует процесс
  setTimeout(() => process.exit(0), 1500);
});

// ============================================
// API: Настройки — проверить токен бота
// ============================================
app.post('/api/settings/validate-token', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ ok: false, error: 'Токен не указан' });
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await r.json();
    if (data.ok) {
      res.json({
        ok: true,
        bot_username: data.result.username,
        bot_name: `${data.result.first_name}${data.result.last_name ? ' ' + data.result.last_name : ''}`,
      });
    } else {
      res.json({ ok: false, error: data.description || 'Невалидный токен' });
    }
  } catch (e) {
    res.json({ ok: false, error: 'Ошибка проверки токена' });
  }
});

// ============================================
// API: Привязка списков к ботам
// ============================================
app.get('/api/settings/bot-lists', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const { fetchListSchemas } = require('./lib/leadteh');
    // Загружаем все списки (через первого бота — они одинаковые на уровне аккаунта)
    const botConfig = getBotConfig(req) || config;
    const schemas = await fetchListSchemas(botConfig);

    const allLists = (Array.isArray(schemas) ? schemas : []).map((s) => ({
      id: s.id,
      name: s.name || s.title || `Список ${s.id}`,
    }));

    const mapping = loadBotLists();

    res.json({ lists: allLists, mapping });
  } catch (e) {
    console.error('GET /api/settings/bot-lists error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки списков' });
  }
});

app.post('/api/settings/bot-lists', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { mapping } = req.body;
  if (!mapping || typeof mapping !== 'object') {
    return res.status(400).json({ error: 'Невалидные данные' });
  }

  saveBotLists(mapping);
  res.json({ ok: true });
});

// ============================================
// API: Список ботов
// ============================================
app.get('/api/bots', (req, res) => {
  const bots = config.bots.map((b) => ({ id: b.id, name: b.name }));
  res.json({ bots });
});

// ============================================
// API: Теги
// ============================================
app.get('/api/tags', async (req, res) => {
  try {
    const { fetchAllContacts, extractTags } = require('./lib/leadteh');
    const botConfig = getBotConfig(req) || config;
    const allContacts = await fetchAllContacts(botConfig);

    const tagsSet = new Set();
    for (const contact of allContacts) {
      for (const tag of extractTags(contact)) {
        tagsSet.add(tag);
      }
    }

    res.json({ tags: Array.from(tagsSet).sort() });
  } catch (e) {
    console.error('GET /api/tags error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки тегов' });
  }
});

// ============================================
// API: Контакты (с фильтрацией по тегам)
// ============================================
app.get('/api/contacts', async (req, res) => {
  try {
    const { fetchAllContacts, extractTags } = require('./lib/leadteh');
    const botConfig = getBotConfig(req) || config;

    const includeTags = req.query.include
      ? req.query.include.split(',').map((t) => t.trim()).filter(Boolean)
      : [];
    const excludeTags = req.query.exclude
      ? req.query.exclude.split(',').map((t) => t.trim()).filter(Boolean)
      : [];
    const countOnly = req.query.count_only === 'true';

    const allContacts = await fetchAllContacts(botConfig);

    const filtered = allContacts.filter((contact) => {
      if (!contact.telegram_id) return false;
      const contactTags = extractTags(contact);

      if (includeTags.length > 0) {
        const hasAny = includeTags.some((t) =>
          contactTags.some((ct) => ct.toLowerCase() === t.toLowerCase())
        );
        if (!hasAny) return false;
      }

      if (excludeTags.length > 0) {
        const hasExcluded = excludeTags.some((t) =>
          contactTags.some((ct) => ct.toLowerCase() === t.toLowerCase())
        );
        if (hasExcluded) return false;
      }

      return true;
    });

    if (countOnly) {
      return res.json({ count: filtered.length });
    }

    const contacts = filtered.map((c) => ({
      telegram_id: String(c.telegram_id),
      name: c.name || '',
      tags: extractTags(c),
    }));

    res.json({ count: contacts.length, contacts });
  } catch (e) {
    console.error('GET /api/contacts error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки контактов' });
  }
});

// ============================================
// API: Списки (Leadteh List Schemas)
// ============================================
app.get('/api/lists', async (req, res) => {
  try {
    const { fetchListSchemas } = require('./lib/leadteh');
    const botConfig = getBotConfig(req) || config;
    const schemas = await fetchListSchemas(botConfig);

    let lists = (Array.isArray(schemas) ? schemas : []).map((s) => ({
      id: s.id,
      name: s.name || s.title || `Список ${s.id}`,
      fields: s.fields || [],
    }));

    // Фильтрация по привязке списков к боту
    const botId = req.query.bot_id;
    if (botId) {
      const mapping = loadBotLists();
      const assigned = mapping[botId];
      if (Array.isArray(assigned) && assigned.length > 0) {
        lists = lists.filter((l) => assigned.includes(l.id));
      }
    }

    res.json({ lists });
  } catch (e) {
    console.error('GET /api/lists error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки списков' });
  }
});

app.get('/api/lists/:schemaId/items', async (req, res) => {
  try {
    const { fetchListItems, extractTelegramIds, fetchListSchemas } = require('./lib/leadteh');
    const botConfig = getBotConfig(req) || config;
    const { schemaId } = req.params;

    // Получаем схему для определения полей
    const schemas = await fetchListSchemas(botConfig);
    const schema = (Array.isArray(schemas) ? schemas : []).find(
      (s) => String(s.id) === String(schemaId)
    );
    const fields = schema?.fields || [];

    const items = await fetchListItems(botConfig, schemaId);
    const telegramIds = extractTelegramIds(Array.isArray(items) ? items : [], fields);

    res.json({
      count: telegramIds.length,
      telegram_ids: telegramIds,
      total_items: Array.isArray(items) ? items.length : 0,
    });
  } catch (e) {
    console.error('GET /api/lists/:id/items error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки элементов списка' });
  }
});

// ============================================
// API: Сохранить рассылку
// ============================================
app.post('/api/broadcast/save', (req, res) => {
  try {
    const { messages, text, buttons, filters, scheduled_at, created_by, bot_id } = req.body;

    if (!created_by) {
      return res.status(400).json({ error: 'created_by обязателен' });
    }

    const adminIds = config.adminTelegramIds;
    if (!adminIds.includes(String(created_by))) {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }

    // Нормализация: новый формат (messages) или старый (text + buttons)
    let normalizedMessages;
    if (Array.isArray(messages) && messages.length > 0) {
      if (messages.length > 5) {
        return res.status(400).json({ error: 'Максимум 5 сообщений' });
      }
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg.text || !msg.text.trim()) {
          return res.status(400).json({ error: `Текст сообщения ${i + 1} обязателен` });
        }
        if (msg.photo_url && msg.photo_url.trim()) {
          try {
            new URL(msg.photo_url);
          } catch {
            return res.status(400).json({ error: `Невалидный URL фото в сообщении ${i + 1}` });
          }
        }
        if (Array.isArray(msg.buttons) && msg.buttons.length > 6) {
          return res.status(400).json({ error: `Максимум 6 кнопок в сообщении ${i + 1}` });
        }
      }
      normalizedMessages = messages.map((msg) => ({
        photo_url: msg.photo_url?.trim() || '',
        text: msg.text.trim(),
        buttons: Array.isArray(msg.buttons) ? msg.buttons.slice(0, 6) : [],
      }));
    } else {
      // Старый формат
      if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Текст сообщения обязателен' });
      }
      normalizedMessages = [{
        photo_url: '',
        text: text.trim(),
        buttons: Array.isArray(buttons) ? buttons.slice(0, 6) : [],
      }];
    }

    const id = generateId();
    const now = new Date().toISOString();

    // Определяем бота для рассылки
    const bot = getBotById(config, bot_id);
    const broadcastBotId = bot ? bot.id : (config.bots[0]?.id || '1');
    const broadcastBotName = bot ? bot.name : (config.bots[0]?.name || '');

    const broadcast = {
      id,
      messages: normalizedMessages,
      filters: {
        include_tags: filters?.include_tags || [],
        exclude_tags: filters?.exclude_tags || [],
        list_schema_id: filters?.list_schema_id || null,
        list_name: filters?.list_name || null,
      },
      bot_id: broadcastBotId,
      bot_name: broadcastBotName,
      scheduled_at: scheduled_at || now,
      status: 'pending',
      created_at: now,
      created_by: String(created_by),
      sent_count: 0,
      failed_count: 0,
    };

    storage.save(broadcast);
    res.json({ ok: true, id, broadcast });
  } catch (e) {
    console.error('POST /api/broadcast/save error:', e.message);
    res.status(500).json({ error: 'Ошибка сохранения рассылки' });
  }
});

// ============================================
// API: Список рассылок
// ============================================
app.get('/api/broadcast/list', (req, res) => {
  try {
    const broadcasts = storage.list();
    broadcasts.sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
    res.json({ broadcasts });
  } catch (e) {
    console.error('GET /api/broadcast/list error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки рассылок' });
  }
});

// ============================================
// API: Удалить рассылку
// ============================================
app.post('/api/broadcast/delete', (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id обязателен' });

    const broadcast = storage.get(id);
    if (!broadcast) return res.status(404).json({ error: 'Рассылка не найдена' });

    if (broadcast.status !== 'pending') {
      return res.status(400).json({ error: 'Можно удалить только запланированную рассылку' });
    }

    storage.remove(id);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/broadcast/delete error:', e.message);
    res.status(500).json({ error: 'Ошибка удаления рассылки' });
  }
});

// ============================================
// API: Ручной запуск отправки (для теста)
// ============================================
app.get('/api/cron/send', async (req, res) => {
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (!secret || secret !== config.cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = await processPendingBroadcasts();
  res.json({ ok: true, processed: results });
});

// ============================================
// Cron — каждую минуту проверяем и отправляем
// ============================================
cron.schedule('* * * * *', async () => {
  console.log(`[cron] ${new Date().toISOString()} — проверка рассылок`);
  try {
    const results = await processPendingBroadcasts();
    if (results.length > 0) {
      console.log('[cron] Обработано:', results);
    }
  } catch (e) {
    console.error('[cron] Ошибка:', e.message);
  }
});

// ============================================
// Логика отправки
// ============================================
async function processPendingBroadcasts() {
  const all = storage.list();
  const now = new Date();
  const results = [];

  for (const broadcast of all) {
    if (broadcast.status !== 'pending') continue;
    if (new Date(broadcast.scheduled_at) > now) continue;

    broadcast.status = 'sending';
    storage.update(broadcast);

    try {
      const result = await sendBroadcast(broadcast);
      broadcast.status = 'sent';
      broadcast.sent_count = result.sent;
      broadcast.failed_count = result.failed;
      broadcast.sent_at = new Date().toISOString();
    } catch (e) {
      console.error(`Ошибка отправки ${broadcast.id}:`, e.message);
      broadcast.status = 'error';
      broadcast.error = e.message;
    }

    storage.update(broadcast);
    results.push({
      id: broadcast.id,
      status: broadcast.status,
      sent: broadcast.sent_count,
      failed: broadcast.failed_count,
    });
  }

  return results;
}

async function sendBroadcast(broadcast) {
  const { fetchAllContacts, extractTags, fetchListItems, fetchListSchemas, extractTelegramIds } = require('./lib/leadteh');

  // Определяем бота из рассылки
  const bot = getBotById(config, broadcast.bot_id);
  const botToken = bot ? bot.token : config.telegramBotToken;
  const botConfig = {
    leadtehApiToken: config.leadtehApiToken,
    leadtehBotId: bot ? bot.leadtehBotId : config.leadtehBotId,
    telegramBotToken: botToken,
  };

  const allContacts = await fetchAllContacts(botConfig);
  const includeTags = broadcast.filters?.include_tags || [];
  const excludeTags = broadcast.filters?.exclude_tags || [];
  const listSchemaId = broadcast.filters?.list_schema_id || null;

  // Загрузить telegram_id из списка (если задан фильтр)
  let listTelegramIds = null;
  if (listSchemaId) {
    try {
      const schemas = await fetchListSchemas(botConfig);
      const schema = (Array.isArray(schemas) ? schemas : []).find(
        (s) => String(s.id) === String(listSchemaId)
      );
      const fields = schema?.fields || [];
      const items = await fetchListItems(botConfig, listSchemaId);
      listTelegramIds = new Set(extractTelegramIds(Array.isArray(items) ? items : [], fields));
      console.log(`[broadcast] Фильтр по списку: ${listTelegramIds.size} telegram_id`);
    } catch (e) {
      console.error('[broadcast] Ошибка загрузки списка:', e.message);
    }
  }

  const recipients = allContacts.filter((contact) => {
    if (!contact.telegram_id) return false;

    // Фильтр по списку
    if (listTelegramIds && !listTelegramIds.has(String(contact.telegram_id))) {
      return false;
    }

    const contactTags = extractTags(contact);

    if (includeTags.length > 0) {
      const hasAny = includeTags.some((t) =>
        contactTags.some((ct) => ct.toLowerCase() === t.toLowerCase())
      );
      if (!hasAny) return false;
    }

    if (excludeTags.length > 0) {
      const hasExcluded = excludeTags.some((t) =>
        contactTags.some((ct) => ct.toLowerCase() === t.toLowerCase())
      );
      if (hasExcluded) return false;
    }

    return true;
  });

  // Получаем username бота для deep links
  let botUsername = '';
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = await r.json();
    if (data.ok) botUsername = data.result.username;
  } catch (e) {
    console.error('Не удалось получить username бота:', e.message);
  }

  // Нормализация: поддержка старого формата (text + buttons) и нового (messages[])
  let messages;
  if (Array.isArray(broadcast.messages) && broadcast.messages.length > 0) {
    messages = broadcast.messages;
  } else {
    messages = [{
      photo_url: '',
      text: broadcast.text || '',
      buttons: broadcast.buttons || [],
    }];
  }

  // Подготовим клавиатуры для каждого сообщения
  const prepared = messages.map((msg) => ({
    text: msg.text || '',
    photoUrl: msg.photo_url || '',
    keyboard: buildKeyboard(msg.buttons || [], botUsername),
  }));

  // Сохраняем общее количество получателей
  broadcast.total_recipients = recipients.length;
  storage.update(broadcast);

  let sent = 0;
  let failed = 0;

  for (const contact of recipients) {
    let contactFailed = false;

    for (let i = 0; i < prepared.length; i++) {
      const msg = prepared[i];
      try {
        const r = await sendSingleMessage(
          botToken,
          contact.telegram_id,
          msg.text,
          msg.photoUrl,
          msg.keyboard
        );

        if (!r.ok) {
          const err = await r.json();
          console.error(`Не удалось отправить ${contact.telegram_id} (msg ${i + 1}):`, err.description);
          contactFailed = true;
          break; // Не шлём остальные сообщения этому контакту
        }
      } catch (e) {
        console.error(`Ошибка отправки ${contact.telegram_id} (msg ${i + 1}):`, e.message);
        contactFailed = true;
        break;
      }

      // Пауза 500мс между сообщениями одному получателю
      if (i < prepared.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (contactFailed) {
      failed++;
    } else {
      sent++;
    }

    // Пауза ~35мс между получателями (лимит Telegram 30 msg/sec)
    await new Promise((r) => setTimeout(r, 35));
  }

  return { sent, failed };
}

function buildKeyboard(buttons, botUsername) {
  if (!Array.isArray(buttons) || buttons.length === 0) return [];

  const rows = [];
  let currentRow = [];

  for (const btn of buttons) {
    let button;
    if (btn.type === 'url') {
      button = { text: btn.text, url: btn.value };
    } else if (btn.type === 'start') {
      const param = encodeURIComponent(btn.value);
      const url = botUsername
        ? `https://t.me/${botUsername}?start=${param}`
        : btn.value;
      button = { text: btn.text, url };
    } else if (btn.type === 'command') {
      // Команда → callback_data (обычная кнопка без иконки ссылки)
      button = { text: btn.text, callback_data: btn.value };
    } else {
      continue;
    }

    currentRow.push(button);
    if (currentRow.length >= 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  if (currentRow.length > 0) rows.push(currentRow);
  return rows;
}

async function sendSingleMessage(botToken, chatId, text, photoUrl, inlineKeyboard) {
  const replyMarkup = inlineKeyboard.length > 0
    ? { inline_keyboard: inlineKeyboard }
    : undefined;

  if (photoUrl) {
    const body = {
      chat_id: String(chatId),
      photo: photoUrl,
      caption: text.slice(0, 1024),
      parse_mode: 'Markdown',
    };
    if (replyMarkup) body.reply_markup = replyMarkup;

    let r = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // При ошибке парсинга Markdown — повторить без parse_mode
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      if (err.description && err.description.includes("can't parse entities")) {
        delete body.parse_mode;
        r = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        // Вернуть фейковый Response с уже распарсенной ошибкой
        return { ok: false, json: async () => err };
      }
    }
    return r;
  }

  // sendMessage
  const body = {
    chat_id: String(chatId),
    text,
    parse_mode: 'Markdown',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  let r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // При ошибке парсинга Markdown — повторить без parse_mode
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    if (err.description && err.description.includes("can't parse entities")) {
      delete body.parse_mode;
      r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      return { ok: false, json: async () => err };
    }
  }
  return r;
}

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================
// Запуск
// ============================================
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  console.log(`Админы: ${config.adminTelegramIds.join(', ') || '(не заданы)'}`);
  console.log(`Боты: ${config.bots.map((b) => `${b.name} (id=${b.id})`).join(', ') || '(не заданы)'}`);
  console.log('Cron: каждую минуту');
});
