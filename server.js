// server.js — Express-сервер для рассылок
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { loadConfig } = require('./lib/config');
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
// API: Теги
// ============================================
app.get('/api/tags', async (req, res) => {
  try {
    const { fetchAllContacts, extractTags } = require('./lib/leadteh');
    const allContacts = await fetchAllContacts(config);

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

    const includeTags = req.query.include
      ? req.query.include.split(',').map((t) => t.trim()).filter(Boolean)
      : [];
    const excludeTags = req.query.exclude
      ? req.query.exclude.split(',').map((t) => t.trim()).filter(Boolean)
      : [];
    const countOnly = req.query.count_only === 'true';

    const allContacts = await fetchAllContacts(config);

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
// API: Сохранить рассылку
// ============================================
app.post('/api/broadcast/save', (req, res) => {
  try {
    const { text, buttons, filters, scheduled_at, created_by } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Текст сообщения обязателен' });
    }
    if (!created_by) {
      return res.status(400).json({ error: 'created_by обязателен' });
    }

    const adminIds = config.adminTelegramIds;
    if (!adminIds.includes(String(created_by))) {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }

    const id = generateId();
    const now = new Date().toISOString();

    const broadcast = {
      id,
      text: text.trim(),
      buttons: Array.isArray(buttons) ? buttons.slice(0, 6) : [],
      filters: {
        include_tags: filters?.include_tags || [],
        exclude_tags: filters?.exclude_tags || [],
      },
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
  const { fetchAllContacts, extractTags } = require('./lib/leadteh');
  const botToken = config.telegramBotToken;

  const allContacts = await fetchAllContacts(config);
  const includeTags = broadcast.filters?.include_tags || [];
  const excludeTags = broadcast.filters?.exclude_tags || [];

  const recipients = allContacts.filter((contact) => {
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

  // Получаем username бота для deep links
  let botUsername = '';
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = await r.json();
    if (data.ok) botUsername = data.result.username;
  } catch (e) {
    console.error('Не удалось получить username бота:', e.message);
  }

  const inlineKeyboard = buildKeyboard(broadcast.buttons, botUsername);

  let sent = 0;
  let failed = 0;

  for (const contact of recipients) {
    try {
      const body = {
        chat_id: String(contact.telegram_id),
        text: broadcast.text,
        parse_mode: 'Markdown',
      };

      if (inlineKeyboard.length > 0) {
        body.reply_markup = { inline_keyboard: inlineKeyboard };
      }

      const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (r.ok) {
        sent++;
      } else {
        const err = await r.json();
        console.error(`Не удалось отправить ${contact.telegram_id}:`, err.description);
        failed++;
      }
    } catch (e) {
      console.error(`Ошибка отправки ${contact.telegram_id}:`, e.message);
      failed++;
    }

    // Пауза ~35мс (лимит Telegram 30 msg/sec)
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
  console.log('Cron: каждую минуту');
});
