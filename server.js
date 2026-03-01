// server.js — Express-сервер для мультитенантных рассылок (SaaS)
const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { loadConfig } = require('./lib/config');
const db = require('./lib/db');
const { validateInitData, getUserRole, isSuperAdmin } = require('./lib/auth');
const { authMiddleware, requireSuperAdmin, requireTenantAdmin, requireTenantOwner } = require('./lib/middleware');

const app = express();
const config = loadConfig();

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS: разрешить только Telegram WebApp
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  // Telegram WebApp загружается через web.telegram.org или t.me
  if (origin && !origin.includes('telegram.org') && !origin.includes('t.me') && !origin.includes('localhost') && !origin.includes('leadtehsms.ru')) {
    return res.status(403).json({ error: 'CORS: Origin не разрешён' });
  }
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ============================================
// API: Авторизация через initData
// ============================================
app.post('/api/auth', (req, res) => {
  try {
    const { initData } = req.body;

    if (!initData) {
      return res.status(400).json({ error: 'initData обязательна' });
    }

    const validation = validateInitData(initData, config.platformBotToken);
    console.log('[auth] initData validation:', validation.valid ? 'OK' : validation.error, '| user:', validation.user?.id);
    if (!validation.valid) {
      return res.status(401).json({ error: validation.error });
    }

    const telegramId = String(validation.user.id);
    const { role, tenantId } = getUserRole(telegramId, db);
    console.log('[auth] telegram_id:', telegramId, '| role:', role, '| tenant_id:', tenantId);

    if (role === 'none') {
      return res.json({
        authorized: false,
        message: 'Нет доступа. Обратитесь к администратору платформы.',
      });
    }

    // Создаём сессию
    const session = db.createSession(tenantId, telegramId, role);
    console.log('[auth] session created for', telegramId, '| role:', role);

    res.json({
      authorized: true,
      token: session.token,
      role,
      tenantId,
      user: {
        id: validation.user.id,
        first_name: validation.user.first_name,
        last_name: validation.user.last_name,
        username: validation.user.username,
      },
    });
  } catch (e) {
    console.error('POST /api/auth error:', e.message);
    res.status(500).json({ error: 'Ошибка авторизации' });
  }
});

// ============================================
// Все последующие роуты требуют авторизации
// ============================================
app.use('/api', (req, res, next) => {
  // /api/auth не требует Bearer
  if (req.path === '/auth') return next();
  // /api/cron/send проверяется по cronSecret
  if (req.path === '/cron/send') return next();
  authMiddleware(req, res, next);
});

// ============================================
// API: Загрузка фото
// ============================================
app.post('/api/upload', requireTenantAdmin, (req, res) => {
  try {
    const { data, filename } = req.body;
    if (!data) return res.status(400).json({ error: 'Нет данных' });

    const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Файл слишком большой (макс. 10 МБ)' });
    }

    const ext = (filename || 'image.jpg').split('.').pop().toLowerCase();
    const allowed = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    const safeExt = allowed.includes(ext) ? ext : 'jpg';

    // Загрузки в директорию тенанта
    const tenantDir = req.tenantId ? String(req.tenantId) : '_super';
    const uploadsDir = path.join(__dirname, 'data', 'uploads', tenantDir);
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const name = generateId() + '.' + safeExt;
    fs.writeFileSync(path.join(uploadsDir, name), buffer);

    res.json({ ok: true, url: `/api/uploads/${tenantDir}/${name}` });
  } catch (e) {
    console.error('POST /api/upload error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки файла' });
  }
});

// Отдача загруженных файлов (с проверкой доступа)
app.get('/api/uploads/:tenantDir/:filename', (req, res) => {
  const { tenantDir, filename } = req.params;
  // Проверяем доступ: суперадмин видит всё, тенант — только своё
  if (!isSuperAdmin(req.telegramId) && tenantDir !== String(req.tenantId)) {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  const filePath = path.join(__dirname, 'data', 'uploads', tenantDir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл не найден' });
  res.sendFile(filePath);
});

// ============================================
// API: Список ботов тенанта
// ============================================
app.get('/api/bots', requireTenantAdmin, (req, res) => {
  const bots = db.getBotsByTenant(req.tenantId);
  res.json({ bots: bots.map(b => ({ id: b.id, name: b.name })) });
});

// ============================================
// Хелпер: получить конфиг бота для Leadteh
// ============================================
function getBotConfigForLeadteh(req) {
  const botId = req.query.bot_id || req.body?.bot_id;
  const bots = db.getBotsByTenant(req.tenantId);
  const tenant = db.getTenantById(req.tenantId);

  let bot;
  if (botId) {
    bot = bots.find(b => b.id === Number(botId));
  }
  if (!bot && bots.length > 0) {
    bot = bots[0];
  }
  if (!bot || !tenant) return null;

  return {
    leadtehApiToken: tenant.leadteh_api_token,
    leadtehBotId: bot.leadteh_bot_id,
    telegramBotToken: bot.token,
  };
}

// ============================================
// API: Теги
// ============================================
app.get('/api/tags', requireTenantAdmin, async (req, res) => {
  try {
    const { fetchAllContacts, extractTags } = require('./lib/leadteh');
    const botConfig = getBotConfigForLeadteh(req);
    if (!botConfig) return res.status(400).json({ error: 'Нет настроенных ботов' });

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
app.get('/api/contacts', requireTenantAdmin, async (req, res) => {
  try {
    const { fetchAllContacts, extractTags } = require('./lib/leadteh');
    const botConfig = getBotConfigForLeadteh(req);
    if (!botConfig) return res.status(400).json({ error: 'Нет настроенных ботов' });

    const includeTags = req.query.include
      ? req.query.include.split(',').map(t => t.trim()).filter(Boolean)
      : [];
    const excludeTags = req.query.exclude
      ? req.query.exclude.split(',').map(t => t.trim()).filter(Boolean)
      : [];
    const countOnly = req.query.count_only === 'true';

    const allContacts = await fetchAllContacts(botConfig);
    const filtered = allContacts.filter(contact => {
      if (!contact.telegram_id) return false;
      const contactTags = extractTags(contact);

      if (includeTags.length > 0) {
        const hasAny = includeTags.some(t =>
          contactTags.some(ct => ct.toLowerCase() === t.toLowerCase())
        );
        if (!hasAny) return false;
      }
      if (excludeTags.length > 0) {
        const hasExcluded = excludeTags.some(t =>
          contactTags.some(ct => ct.toLowerCase() === t.toLowerCase())
        );
        if (hasExcluded) return false;
      }
      return true;
    });

    if (countOnly) return res.json({ count: filtered.length });

    const contacts = filtered.map(c => ({
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
app.get('/api/lists', requireTenantAdmin, async (req, res) => {
  try {
    const { fetchListSchemas } = require('./lib/leadteh');
    const botConfig = getBotConfigForLeadteh(req);
    if (!botConfig) return res.status(400).json({ error: 'Нет настроенных ботов' });

    const schemas = await fetchListSchemas(botConfig);
    let lists = (Array.isArray(schemas) ? schemas : []).map(s => ({
      id: s.id,
      name: s.name || s.title || `Список ${s.id}`,
      fields: s.fields || [],
    }));

    // Фильтрация по привязке списков к боту
    const botId = req.query.bot_id;
    if (botId) {
      const assigned = db.getBotListMappings(Number(botId));
      if (assigned.length > 0) {
        lists = lists.filter(l => assigned.includes(String(l.id)));
      }
    }

    res.json({ lists });
  } catch (e) {
    console.error('GET /api/lists error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки списков' });
  }
});

app.get('/api/lists/:schemaId/items', requireTenantAdmin, async (req, res) => {
  try {
    const { fetchListItems, extractTelegramIds, fetchListSchemas } = require('./lib/leadteh');
    const botConfig = getBotConfigForLeadteh(req);
    if (!botConfig) return res.status(400).json({ error: 'Нет настроенных ботов' });

    const { schemaId } = req.params;
    const schemas = await fetchListSchemas(botConfig);
    const schema = (Array.isArray(schemas) ? schemas : []).find(
      s => String(s.id) === String(schemaId)
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
app.post('/api/broadcast/save', requireTenantAdmin, (req, res) => {
  try {
    const { name, parse_mode, messages, text, buttons, filters, scheduled_at, bot_id } = req.body;

    // Проверка тарифных лимитов
    const limits = db.checkTariffLimits(req.tenantId);
    if (!limits.allowed) {
      return res.status(403).json({ error: limits.reason });
    }

    // Нормализация сообщений
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
          if (!msg.photo_url.startsWith('/api/uploads/')) {
            try { new URL(msg.photo_url); } catch {
              return res.status(400).json({ error: `Невалидный URL фото в сообщении ${i + 1}` });
            }
          }
        }
        if (Array.isArray(msg.buttons) && msg.buttons.length > 6) {
          return res.status(400).json({ error: `Максимум 6 кнопок в сообщении ${i + 1}` });
        }
      }
      normalizedMessages = messages.map(msg => ({
        photo_url: msg.photo_url?.trim() || '',
        text: msg.text.trim(),
        buttons: Array.isArray(msg.buttons) ? msg.buttons.slice(0, 6) : [],
      }));
    } else {
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

    // Определяем бота
    const bots = db.getBotsByTenant(req.tenantId);
    let broadcastBot;
    if (bot_id) {
      broadcastBot = bots.find(b => b.id === Number(bot_id));
    }
    if (!broadcastBot && bots.length > 0) {
      broadcastBot = bots[0];
    }

    const broadcast = {
      id,
      name: name || '',
      parse_mode: parse_mode || null,
      messages: normalizedMessages,
      filters: {
        include_tags: filters?.include_tags || [],
        exclude_tags: filters?.exclude_tags || [],
        list_schema_id: filters?.list_schema_id || null,
        list_name: filters?.list_name || null,
      },
      bot_id: broadcastBot ? broadcastBot.id : null,
      scheduled_at: scheduled_at || new Date().toISOString(),
      created_by: req.telegramId,
    };

    db.saveBroadcast(req.tenantId, broadcast);
    db.incrementUsage(req.tenantId);

    res.json({ ok: true, id, broadcast: { ...broadcast, status: 'pending', bot_name: broadcastBot?.name || '' } });
  } catch (e) {
    console.error('POST /api/broadcast/save error:', e.message);
    res.status(500).json({ error: 'Ошибка сохранения рассылки' });
  }
});

// ============================================
// API: Список рассылок
// ============================================
app.get('/api/broadcast/list', requireTenantAdmin, (req, res) => {
  try {
    const broadcasts = db.listBroadcasts(req.tenantId);
    res.json({ broadcasts });
  } catch (e) {
    console.error('GET /api/broadcast/list error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки рассылок' });
  }
});

// ============================================
// API: Удалить рассылку
// ============================================
app.post('/api/broadcast/delete', requireTenantAdmin, (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id обязателен' });

    const result = db.deleteBroadcast(id, req.tenantId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Рассылка не найдена или уже отправлена' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/broadcast/delete error:', e.message);
    res.status(500).json({ error: 'Ошибка удаления рассылки' });
  }
});

// ============================================
// API: Настройки — получить (тенант)
// ============================================
app.get('/api/settings', requireTenantAdmin, (req, res) => {
  try {
    const bots = db.getBotsByTenant(req.tenantId);
    const admins = db.getTenantAdmins(req.tenantId);
    const tenant = db.getTenantById(req.tenantId);
    const limits = db.checkTariffLimits(req.tenantId);

    res.json({
      bots: bots.map(b => ({
        id: b.id,
        name: b.name,
        token_masked: maskToken(b.token),
        leadteh_id: b.leadteh_bot_id || '',
        bot_username: b.bot_username || '',
      })),
      admin_ids: admins.map(a => a.telegram_id),
      tenant: {
        name: tenant?.name || '',
        has_leadteh_token: !!tenant?.leadteh_api_token,
      },
      limits: limits.limits || null,
    });
  } catch (e) {
    console.error('GET /api/settings error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки настроек' });
  }
});

// ============================================
// API: Настройки — сохранить бота
// ============================================
app.post('/api/settings/bot/add', requireTenantOwner, async (req, res) => {
  try {
    const { token, name, leadteh_id } = req.body;
    if (!token) return res.status(400).json({ error: 'Токен обязателен' });

    // Проверка лимита ботов
    const botLimit = db.checkBotLimit(req.tenantId);
    if (!botLimit.allowed) {
      return res.status(403).json({ error: botLimit.reason });
    }

    // Валидация токена через Telegram API
    let botUsername = '';
    let botName = name || '';
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await r.json();
      if (!data.ok) {
        return res.status(400).json({ error: 'Невалидный токен бота' });
      }
      botUsername = data.result.username || '';
      if (!botName) {
        botName = `${data.result.first_name}${data.result.last_name ? ' ' + data.result.last_name : ''}`;
      }
    } catch (e) {
      return res.status(400).json({ error: 'Ошибка проверки токена' });
    }

    const botId = db.createBot(req.tenantId, botName, token, leadteh_id || '', botUsername);
    res.json({ ok: true, bot_id: botId, bot_username: botUsername, bot_name: botName });
  } catch (e) {
    console.error('POST /api/settings/bot/add error:', e.message);
    res.status(500).json({ error: 'Ошибка добавления бота' });
  }
});

app.post('/api/settings/bot/remove', requireTenantOwner, (req, res) => {
  try {
    const { bot_id } = req.body;
    if (!bot_id) return res.status(400).json({ error: 'bot_id обязателен' });

    // Проверяем что бот принадлежит тенанту
    const bot = db.getBotById(bot_id);
    if (!bot || bot.tenant_id !== req.tenantId) {
      return res.status(404).json({ error: 'Бот не найден' });
    }

    // Проверяем что остаётся хотя бы 1 бот
    const bots = db.getBotsByTenant(req.tenantId);
    if (bots.length <= 1) {
      return res.status(400).json({ error: 'Нужен минимум 1 бот' });
    }

    db.deleteBot(bot_id);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/settings/bot/remove error:', e.message);
    res.status(500).json({ error: 'Ошибка удаления бота' });
  }
});

// ============================================
// API: Настройки — проверить токен бота
// ============================================
app.post('/api/settings/validate-token', requireTenantAdmin, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok: false, error: 'Токен не указан' });

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
// API: Настройки — админы тенанта
// ============================================
app.post('/api/settings/admin/add', requireTenantOwner, (req, res) => {
  try {
    const { telegram_id } = req.body;
    if (!telegram_id || !/^\d+$/.test(telegram_id)) {
      return res.status(400).json({ error: 'Невалидный Telegram ID' });
    }
    db.addTenantAdmin(req.tenantId, telegram_id);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/settings/admin/add error:', e.message);
    res.status(500).json({ error: 'Ошибка добавления админа' });
  }
});

app.post('/api/settings/admin/remove', requireTenantOwner, (req, res) => {
  try {
    const { telegram_id } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'telegram_id обязателен' });

    // Нельзя удалить себя
    if (String(telegram_id) === req.telegramId) {
      return res.status(400).json({ error: 'Нельзя удалить себя' });
    }

    db.removeTenantAdmin(req.tenantId, telegram_id);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/settings/admin/remove error:', e.message);
    res.status(500).json({ error: 'Ошибка удаления админа' });
  }
});

// ============================================
// API: Настройки — Leadteh API токен
// ============================================
app.post('/api/settings/leadteh-token', requireTenantOwner, (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Токен обязателен' });
    db.updateTenant(req.tenantId, { leadteh_api_token: token });
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/settings/leadteh-token error:', e.message);
    res.status(500).json({ error: 'Ошибка сохранения токена' });
  }
});

// ============================================
// API: Привязка списков к ботам
// ============================================
app.get('/api/settings/bot-lists', requireTenantAdmin, async (req, res) => {
  try {
    const { fetchListSchemas } = require('./lib/leadteh');
    const botConfig = getBotConfigForLeadteh(req);
    if (!botConfig) return res.json({ lists: [], mapping: {} });

    const schemas = await fetchListSchemas(botConfig);
    const allLists = (Array.isArray(schemas) ? schemas : []).map(s => ({
      id: s.id,
      name: s.name || s.title || `Список ${s.id}`,
    }));

    // Собираем маппинг для ботов тенанта
    const bots = db.getBotsByTenant(req.tenantId);
    const mapping = {};
    for (const bot of bots) {
      mapping[bot.id] = db.getBotListMappings(bot.id);
    }

    res.json({ lists: allLists, mapping });
  } catch (e) {
    console.error('GET /api/settings/bot-lists error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки списков' });
  }
});

app.post('/api/settings/bot-lists', requireTenantOwner, (req, res) => {
  try {
    const { mapping } = req.body;
    if (!mapping || typeof mapping !== 'object') {
      return res.status(400).json({ error: 'Невалидные данные' });
    }

    const bots = db.getBotsByTenant(req.tenantId);
    const botIds = new Set(bots.map(b => b.id));

    for (const [botId, schemaIds] of Object.entries(mapping)) {
      if (!botIds.has(Number(botId))) continue;
      db.setBotListMappings(Number(botId), Array.isArray(schemaIds) ? schemaIds : []);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/settings/bot-lists error:', e.message);
    res.status(500).json({ error: 'Ошибка сохранения' });
  }
});

// ============================================
// API: Информация о тенанте (использование, тариф)
// ============================================
app.get('/api/tenant/info', requireTenantAdmin, (req, res) => {
  try {
    const tenant = db.getTenantById(req.tenantId);
    const limits = db.checkTariffLimits(req.tenantId);
    const plan = tenant?.tariff_plan_id ? db.getTariffPlan(tenant.tariff_plan_id) : null;

    res.json({
      tenant: {
        name: tenant?.name || '',
        status: tenant?.status || 'unknown',
      },
      tariff: plan ? {
        name: plan.name,
        max_bots: plan.max_bots,
        max_broadcasts_per_month: plan.max_broadcasts_per_month,
        max_contacts: plan.max_contacts,
      } : null,
      usage: limits.limits || null,
    });
  } catch (e) {
    console.error('GET /api/tenant/info error:', e.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================
// SUPER ADMIN API
// ============================================

// --- Список тенантов ---
app.get('/api/super/tenants', requireSuperAdmin, (req, res) => {
  try {
    const tenants = db.getAllTenants();
    res.json({ tenants });
  } catch (e) {
    console.error('GET /api/super/tenants error:', e.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// --- Создать тенанта ---
app.post('/api/super/tenants', requireSuperAdmin, (req, res) => {
  try {
    const { telegram_id, name, leadteh_api_token, tariff_plan_id } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'telegram_id обязателен' });

    // Проверяем нет ли уже
    const existing = db.getTenantByTelegramId(telegram_id);
    if (existing) return res.status(400).json({ error: 'Тенант с этим telegram_id уже существует' });

    const tenantId = db.createTenant(String(telegram_id), name || '', leadteh_api_token || '');

    if (tariff_plan_id) {
      db.updateTenant(tenantId, { tariff_plan_id });
    }

    res.json({ ok: true, tenant_id: tenantId });
  } catch (e) {
    console.error('POST /api/super/tenants error:', e.message);
    res.status(500).json({ error: 'Ошибка создания тенанта' });
  }
});

// --- Обновить тенанта ---
app.post('/api/super/tenants/:id/update', requireSuperAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { name, status, tariff_plan_id } = req.body;
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (status !== undefined) fields.status = status;
    if (tariff_plan_id !== undefined) fields.tariff_plan_id = tariff_plan_id;

    db.updateTenant(Number(id), fields);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/super/tenants/:id/update error:', e.message);
    res.status(500).json({ error: 'Ошибка обновления тенанта' });
  }
});

// --- Переключить работу под тенантом (суперадмин видит данные тенанта) ---
app.post('/api/super/impersonate', requireSuperAdmin, (req, res) => {
  try {
    const { tenant_id } = req.body;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id обязателен' });

    const tenant = db.getTenantById(Number(tenant_id));
    if (!tenant) return res.status(404).json({ error: 'Тенант не найден' });

    // Создаём сессию для суперадмина привязанную к тенанту
    const session = db.createSession(Number(tenant_id), req.telegramId, 'super_admin');
    res.json({ ok: true, token: session.token, tenant_name: tenant.name });
  } catch (e) {
    console.error('POST /api/super/impersonate error:', e.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// --- Тарифные планы ---
app.get('/api/super/tariffs', requireSuperAdmin, (req, res) => {
  res.json({ tariffs: db.getTariffPlans() });
});

app.post('/api/super/tariffs', requireSuperAdmin, (req, res) => {
  try {
    const { name, max_bots, max_broadcasts_per_month, max_contacts } = req.body;
    if (!name) return res.status(400).json({ error: 'name обязателен' });
    const id = db.createTariffPlan(name, max_bots || 3, max_broadcasts_per_month || 100, max_contacts || 5000);
    res.json({ ok: true, id });
  } catch (e) {
    console.error('POST /api/super/tariffs error:', e.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/super/tariffs/:id/update', requireSuperAdmin, (req, res) => {
  try {
    db.updateTariffPlan(Number(req.params.id), req.body);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/super/tariffs/:id/update error:', e.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// --- Статистика платформы ---
app.get('/api/super/stats', requireSuperAdmin, (req, res) => {
  try {
    res.json(db.getSuperStats());
  } catch (e) {
    console.error('GET /api/super/stats error:', e.message);
    res.status(500).json({ error: 'Ошибка' });
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
    // Очистка просроченных сессий
    db.deleteExpiredSessions();
  } catch (e) {
    console.error('[cron] Ошибка:', e.message);
  }
});

// ============================================
// Логика отправки (мультитенантная)
// ============================================
async function processPendingBroadcasts() {
  const pending = db.getPendingBroadcasts();
  const results = [];

  for (const broadcast of pending) {
    db.updateBroadcastStatus(broadcast.id, { status: 'sending' });

    try {
      const result = await sendBroadcast(broadcast);
      db.updateBroadcastStatus(broadcast.id, {
        status: 'sent',
        sent_count: result.sent,
        failed_count: result.failed,
        sent_at: new Date().toISOString(),
      });
    } catch (e) {
      console.error(`Ошибка отправки ${broadcast.id}:`, e.message);
      db.updateBroadcastStatus(broadcast.id, {
        status: 'error',
        error: e.message,
      });
    }

    results.push({ id: broadcast.id });
  }

  return results;
}

async function sendBroadcast(broadcast) {
  const { fetchAllContacts, extractTags, fetchListItems, fetchListSchemas, extractTelegramIds } = require('./lib/leadteh');

  // Загружаем credentials тенанта и бота из БД
  const bot = broadcast.bot_id ? db.getBotById(broadcast.bot_id) : null;
  if (!bot) throw new Error('Бот не найден');

  const botConfig = {
    leadtehApiToken: broadcast.leadteh_api_token,
    leadtehBotId: bot.leadteh_bot_id,
    telegramBotToken: bot.token,
  };

  const allContacts = await fetchAllContacts(botConfig);
  const includeTags = broadcast.filters?.include_tags || [];
  const excludeTags = broadcast.filters?.exclude_tags || [];
  const listSchemaId = broadcast.filters?.list_schema_id || null;

  // Загрузить telegram_id из списка
  let listTelegramIds = null;
  if (listSchemaId) {
    try {
      const schemas = await fetchListSchemas(botConfig);
      const schema = (Array.isArray(schemas) ? schemas : []).find(
        s => String(s.id) === String(listSchemaId)
      );
      const fields = schema?.fields || [];
      const items = await fetchListItems(botConfig, listSchemaId);
      listTelegramIds = new Set(extractTelegramIds(Array.isArray(items) ? items : [], fields));
      console.log(`[broadcast] Фильтр по списку: ${listTelegramIds.size} telegram_id`);
    } catch (e) {
      console.error('[broadcast] Ошибка загрузки списка:', e.message);
    }
  }

  const recipients = allContacts.filter(contact => {
    if (!contact.telegram_id) return false;

    if (listTelegramIds) {
      return listTelegramIds.has(String(contact.telegram_id));
    }

    const contactTags = extractTags(contact);

    if (includeTags.length > 0) {
      const hasAny = includeTags.some(t =>
        contactTags.some(ct => ct.toLowerCase() === t.toLowerCase())
      );
      if (!hasAny) return false;
    }

    if (excludeTags.length > 0) {
      const hasExcluded = excludeTags.some(t =>
        contactTags.some(ct => ct.toLowerCase() === t.toLowerCase())
      );
      if (hasExcluded) return false;
    }

    return true;
  });

  // Получаем username бота для deep links
  let botUsername = bot.bot_username || '';
  if (!botUsername) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${bot.token}/getMe`);
      const data = await r.json();
      if (data.ok) botUsername = data.result.username;
    } catch (e) {
      console.error('Не удалось получить username бота:', e.message);
    }
  }

  const messages = broadcast.messages || [];
  const prepared = messages.map(msg => ({
    text: msg.text || '',
    photoUrl: msg.photo_url || '',
    keyboard: buildKeyboard(msg.buttons || [], botUsername),
  }));

  // Сохраняем общее количество
  db.updateBroadcastStatus(broadcast.id, { total_recipients: recipients.length });

  let sent = 0;
  let failed = 0;

  for (const contact of recipients) {
    let contactFailed = false;

    for (let i = 0; i < prepared.length; i++) {
      const msg = prepared[i];
      try {
        const r = await sendSingleMessage(
          bot.token,
          contact.telegram_id,
          msg.text,
          msg.photoUrl,
          msg.keyboard,
          broadcast.parse_mode,
          broadcast.tenant_id
        );

        if (!r.ok) {
          const err = await r.json();
          console.error(`Не удалось отправить ${contact.telegram_id} (msg ${i + 1}):`, err.description);
          contactFailed = true;
          break;
        }
      } catch (e) {
        console.error(`Ошибка отправки ${contact.telegram_id} (msg ${i + 1}):`, e.message);
        contactFailed = true;
        break;
      }

      if (i < prepared.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (contactFailed) {
      failed++;
    } else {
      sent++;
    }

    await new Promise(r => setTimeout(r, 35));
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

async function sendSingleMessage(botToken, chatId, text, photoUrl, inlineKeyboard, parseMode, tenantId) {
  const replyMarkup = inlineKeyboard.length > 0
    ? { inline_keyboard: inlineKeyboard }
    : undefined;
  const usedParseMode = parseMode || undefined;

  if (photoUrl) {
    // Локальный файл — отправляем через multipart
    if (photoUrl.startsWith('/api/uploads/')) {
      return await sendLocalPhoto(botToken, chatId, text, photoUrl, replyMarkup, usedParseMode);
    }

    const body = {
      chat_id: String(chatId),
      photo: photoUrl,
      caption: text.slice(0, 1024),
    };
    if (usedParseMode) body.parse_mode = usedParseMode;
    if (replyMarkup) body.reply_markup = replyMarkup;

    let r = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!r.ok && usedParseMode) {
      const err = await r.json().catch(() => ({}));
      if (err.description && err.description.includes("can't parse entities")) {
        delete body.parse_mode;
        r = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
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

  const body = {
    chat_id: String(chatId),
    text,
  };
  if (usedParseMode) body.parse_mode = usedParseMode;
  if (replyMarkup) body.reply_markup = replyMarkup;

  let r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!r.ok && usedParseMode) {
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

async function sendLocalPhoto(botToken, chatId, text, localPath, replyMarkup, parseMode) {
  // localPath = /api/uploads/{tenantId}/{filename}
  const parts = localPath.replace('/api/uploads/', '').split('/');
  const filePath = path.join(__dirname, 'data', 'uploads', ...parts);

  if (!fs.existsSync(filePath)) {
    return { ok: false, json: async () => ({ description: 'Файл не найден: ' + localPath }) };
  }

  const fileBuffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

  function buildFormData(withParseMode) {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append('photo', new Blob([fileBuffer], { type: mimeType }), 'photo' + ext);
    if (text) fd.append('caption', text.slice(0, 1024));
    if (withParseMode && parseMode) fd.append('parse_mode', parseMode);
    if (replyMarkup) fd.append('reply_markup', JSON.stringify(replyMarkup));
    return fd;
  }

  let r = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: 'POST',
    body: buildFormData(true),
  });

  if (!r.ok && parseMode) {
    const err = await r.json().catch(() => ({}));
    if (err.description && err.description.includes("can't parse entities")) {
      r = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST',
        body: buildFormData(false),
      });
    } else {
      return { ok: false, json: async () => err };
    }
  }

  return r;
}

function maskToken(token) {
  if (!token || token.length < 10) return '***';
  return token.slice(0, 4) + '...' + token.slice(-3);
}

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================
// Запуск
// ============================================
async function main() {
  await db.initDb();
  const PORT = config.port;
  app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
    console.log(`Платформенный бот: ${config.platformBotToken ? 'настроен' : 'НЕ НАСТРОЕН'}`);
    console.log('Cron: каждую минуту');
  });
}

main().catch(e => {
  console.error('Ошибка запуска:', e);
  process.exit(1);
});
