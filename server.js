// server.js — Express-сервер для мультитенантных рассылок (SaaS)
const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { loadConfig } = require('./lib/config');
const db = require('./lib/db');
const { validateInitData, getUserRole, isSuperAdmin, SUPER_ADMIN_ID } = require('./lib/auth');
const { authMiddleware, requireSuperAdmin, requireTenantAdmin, requireTenantOwner } = require('./lib/middleware');
const { fetchAllContacts, extractTags, fetchListSchemas, fetchListItems, extractTelegramIds } = require('./lib/leadteh');
const ExcelJS = require('exceljs');

const app = express();
const config = loadConfig();

const VALID_PARSE_MODES = ['Markdown', 'MarkdownV2', 'HTML'];

// ============================================
// Кэш превью получателей (in-memory, TTL 10 мин)
// ============================================
const recipientPreviewCache = new Map();
const PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000;

// ============================================
// Rate Limiter (in-memory)
// ============================================
const rateLimitStore = new Map();

function rateLimit(keyFn, maxRequests, windowMs) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let entry = rateLimitStore.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      rateLimitStore.set(key, entry);
    }
    entry.count++;
    if (entry.count > maxRequests) {
      return res.status(429).json({ error: 'Слишком много запросов. Попробуйте позже.' });
    }
    next();
  };
}

// Очистка устаревших записей каждые 5 минут
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.start > 120000) rateLimitStore.delete(key);
  }
  for (const [key, entry] of recipientPreviewCache) {
    if (now - entry.createdAt > PREVIEW_CACHE_TTL_MS) recipientPreviewCache.delete(key);
  }
}, 300000);

app.use(express.json({ limit: '15mb' }));

// Access log для диагностики
app.use((req, res, next) => {
  if (req.path !== '/health' && !req.path.startsWith('/api/cron')) {
    console.log(`[http] ${req.method} ${req.originalUrl} from ${req.ip}`);
  }
  next();
});

// Cache-bust: редирект / без версии → /?v=timestamp (сбрасывает кэш Telegram WebApp)
const APP_VERSION = Date.now().toString(36);
app.get('/', (req, res, next) => {
  if (!req.query.v) return res.redirect(`/?v=${APP_VERSION}`);
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// CORS: разрешить только Telegram WebApp и доверенные домены
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin) {
    try {
      const host = new URL(origin).hostname;
      const allowed = host === 'localhost'
        || host === 'telegram.org' || host.endsWith('.telegram.org')
        || host === 't.me' || host.endsWith('.t.me')
        || host === 'leadtehsms.ru' || host.endsWith('.leadtehsms.ru');
      if (!allowed) {
        return res.status(403).json({ error: 'CORS: Origin не разрешён' });
      }
    } catch {
      return res.status(403).json({ error: 'CORS: невалидный Origin' });
    }
  }
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ============================================
// Health check (без авторизации)
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ============================================
// API: Авторизация через initData
// ============================================
app.post('/api/auth', rateLimit(req => req.ip, 5, 60000), (req, res) => {
  try {
    const { initData } = req.body;

    if (!initData) {
      return res.status(400).json({ error: 'initData обязательна' });
    }

    const validation = validateInitData(initData, config.platformBotToken);
    if (!validation.valid) {
      return res.status(401).json({ error: validation.error });
    }

    const telegramId = String(validation.user.id);
    const { role, tenantId } = getUserRole(telegramId, db);

    if (role === 'none') {
      return res.json({
        authorized: false,
        message: 'Нет доступа. Обратитесь к администратору платформы.',
      });
    }

    // Создаём сессию
    const session = db.createSession(tenantId, telegramId, role);

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
app.use('/api', rateLimit(req => `api:${req.ip}`, 60, 60000), (req, res, next) => {
  // /api/auth не требует Bearer
  if (req.path === '/auth') return next();
  // /api/cron/send проверяется по cronSecret
  if (req.path === '/cron/send') return next();
  authMiddleware(req, res, next);
});

// ============================================
// API: Загрузка фото
// ============================================
app.post('/api/upload', requireTenantAdmin, rateLimit(req => `upload:${req.telegramId}`, 3, 60000), (req, res) => {
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
  // Path traversal protection
  const uploadsBase = path.resolve(__dirname, 'data', 'uploads');
  const filePath = path.resolve(uploadsBase, tenantDir, filename);
  if (!filePath.startsWith(uploadsBase + path.sep)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
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
// Вычисление фильтров по условиям (конструктор И/ИЛИ)
// Приоритет: AND > OR. Группируем AND-условия, между группами — OR.
// ============================================
function evaluateFilterConditions(contactTags, conditions, operators) {
  if (!conditions || conditions.length === 0) return true;

  // Разбиваем на AND-группы по OR-операторам
  const groups = [[]];
  for (let i = 0; i < conditions.length; i++) {
    groups[groups.length - 1].push(conditions[i]);
    if (i < operators.length && operators[i] === 'OR') {
      groups.push([]);
    }
  }

  // Между группами — OR (ANY), внутри группы — AND (ALL)
  const lowerTags = contactTags.map(t => t.toLowerCase());
  return groups.some(group =>
    group.every(cond => {
      const tagLower = cond.tag.toLowerCase();
      const hasTag = lowerTags.includes(tagLower);
      return cond.type === 'has' ? hasTag : !hasTag;
    })
  );
}

// ============================================
// API: Теги
// ============================================
app.get('/api/tags', requireTenantAdmin, async (req, res) => {
  try {

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

    const botConfig = getBotConfigForLeadteh(req);
    if (!botConfig) return res.status(400).json({ error: 'Нет настроенных ботов' });

    const countOnly = req.query.count_only === 'true';

    // Новый формат: conditions + operators (конструктор И/ИЛИ)
    let conditions = null;
    let operators = null;
    if (req.query.conditions) {
      try {
        conditions = JSON.parse(req.query.conditions);
        operators = req.query.operators ? JSON.parse(req.query.operators) : [];
      } catch (e) { /* fallback to legacy */ }
    }

    // Legacy формат: include/exclude
    const includeTags = req.query.include
      ? req.query.include.split(',').map(t => t.trim()).filter(Boolean)
      : [];
    const excludeTags = req.query.exclude
      ? req.query.exclude.split(',').map(t => t.trim()).filter(Boolean)
      : [];

    const allContacts = await fetchAllContacts(botConfig);
    const filtered = allContacts.filter(contact => {
      if (!contact.telegram_id) return false;
      const contactTags = extractTags(contact);

      // Новый формат условий
      if (conditions && conditions.length > 0) {
        return evaluateFilterConditions(contactTags, conditions, operators || []);
      }

      // Legacy формат
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

    const botConfig = getBotConfigForLeadteh(req);
    if (!botConfig) return res.status(400).json({ error: 'Нет настроенных ботов' });

    const schemas = await fetchListSchemas(botConfig);
    let lists = (Array.isArray(schemas) ? schemas : []).map(s => ({
      id: s.id,
      name: s.name || s.title || `Список ${s.id}`,
      fields: s.fields || [],
    }));

    // Фильтрация по привязке списков к боту (всегда, fallback на первого бота)
    const bots = db.getBotsByTenant(req.tenantId);
    const botIdParam = req.query.bot_id;
    const filterBot = botIdParam
      ? bots.find(b => b.id === Number(botIdParam))
      : bots[0];

    if (filterBot) {
      const assigned = db.getBotListMappings(filterBot.id);
      console.log(`[lists] tenant=${req.tenantId} bot=${filterBot.id} total=${lists.length} mappings=${assigned.length}`);
      if (assigned.length > 0) {
        lists = lists.filter(l => assigned.includes(String(l.id)));
      } else {
        return res.json({ lists: [], no_mappings: true });
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
// API: Превью получателей (список контактов с пагинацией)
// ============================================
app.post('/api/recipients/preview', requireTenantAdmin, async (req, res) => {
  try {
    const botConfig = getBotConfigForLeadteh(req);
    if (!botConfig) return res.status(400).json({ error: 'Нет настроенных ботов' });

    const { include_tags, exclude_tags, conditions, operators, list_schema_id } = req.body;
    const perPage = 50;
    let contacts = [];

    if (list_schema_id) {
      // Режим списка: получить telegram_id из списка, затем обогатить данными контактов
      const schemas = await fetchListSchemas(botConfig);
      const schema = (Array.isArray(schemas) ? schemas : []).find(
        s => String(s.id) === String(list_schema_id)
      );
      const fields = schema?.fields || [];
      const items = await fetchListItems(botConfig, list_schema_id);
      const telegramIds = extractTelegramIds(Array.isArray(items) ? items : [], fields);

      if (telegramIds.length > 0) {
        const allContacts = await fetchAllContacts(botConfig);
        const contactMap = new Map();
        for (const c of allContacts) {
          if (c.telegram_id) contactMap.set(String(c.telegram_id), c);
        }
        contacts = telegramIds.map(tid => {
          const c = contactMap.get(tid);
          return {
            telegram_id: tid,
            name: c?.name || '',
            tags: c ? extractTags(c) : [],
          };
        });
      }
    } else if (Array.isArray(conditions) && conditions.length > 0) {
      // Новый формат: конструктор условий И/ИЛИ
      const ops = Array.isArray(operators) ? operators : [];
      const allContacts = await fetchAllContacts(botConfig);
      const filtered = allContacts.filter(contact => {
        if (!contact.telegram_id) return false;
        const contactTags = extractTags(contact);
        return evaluateFilterConditions(contactTags, conditions, ops);
      });
      contacts = filtered.map(c => ({
        telegram_id: String(c.telegram_id),
        name: c.name || '',
        tags: extractTags(c),
      }));
    } else {
      // Legacy: фильтрация по include/exclude тегам
      const includeTags = Array.isArray(include_tags) ? include_tags : [];
      const excludeTags = Array.isArray(exclude_tags) ? exclude_tags : [];

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

      contacts = filtered.map(c => ({
        telegram_id: String(c.telegram_id),
        name: c.name || '',
        tags: extractTags(c),
      }));
    }

    // Кэшируем результат
    const cacheId = `${req.tenantId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    recipientPreviewCache.set(cacheId, {
      tenantId: req.tenantId,
      contacts,
      createdAt: Date.now(),
    });

    res.json({
      cache_id: cacheId,
      total: contacts.length,
      page: 1,
      per_page: perPage,
      contacts: contacts.slice(0, perPage),
    });
  } catch (e) {
    console.error('POST /api/recipients/preview error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки получателей' });
  }
});

app.get('/api/recipients/preview/:cacheId', requireTenantAdmin, (req, res) => {
  try {
    const { cacheId } = req.params;
    const entry = recipientPreviewCache.get(cacheId);

    if (!entry || entry.tenantId !== req.tenantId) {
      return res.status(404).json({ error: 'Кэш не найден или истёк', expired: true });
    }

    if (Date.now() - entry.createdAt > PREVIEW_CACHE_TTL_MS) {
      recipientPreviewCache.delete(cacheId);
      return res.status(404).json({ error: 'Кэш истёк', expired: true });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = 50;
    const start = (page - 1) * perPage;
    const pageContacts = entry.contacts.slice(start, start + perPage);

    res.json({
      cache_id: cacheId,
      total: entry.contacts.length,
      page,
      per_page: perPage,
      contacts: pageContacts,
    });
  } catch (e) {
    console.error('GET /api/recipients/preview/:cacheId error:', e.message);
    res.status(500).json({ error: 'Ошибка чтения кэша' });
  }
});

// ============================================
// API: Сохранить рассылку
// ============================================
app.post('/api/broadcast/save', requireTenantAdmin, (req, res) => {
  try {
    const { name, parse_mode, messages, text, buttons, filters, scheduled_at, bot_id, message_delay } = req.body;

    // Валидация parse_mode (общий — для обратной совместимости)
    if (parse_mode && !VALID_PARSE_MODES.includes(parse_mode)) {
      return res.status(400).json({ error: `Невалидный parse_mode. Допустимые: ${VALID_PARSE_MODES.join(', ')}` });
    }

    // Проверка тарифных лимитов
    const limits = db.checkTariffLimits(req.tenantId);
    if (!limits.allowed) {
      return res.status(403).json({ error: limits.reason });
    }

    // Проверка подписки (суперадмин — обход)
    if (req.role !== 'super_admin') {
      const sub = db.checkSubscription(req.tenantId);
      if (!sub.canBroadcast) {
        return res.status(403).json({ error: 'Подписка истекла. Обратитесь к администратору для продления.', subscription_expired: true });
      }
    }

    // Нормализация сообщений
    let normalizedMessages;
    if (Array.isArray(messages) && messages.length > 0) {
      if (messages.length > 5) {
        return res.status(400).json({ error: 'Максимум 5 сообщений' });
      }
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.parse_mode && !VALID_PARSE_MODES.includes(msg.parse_mode)) {
          return res.status(400).json({ error: `Невалидный parse_mode в сообщении ${i + 1}` });
        }
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
        if (Array.isArray(msg.buttons)) {
          for (let j = 0; j < msg.buttons.length; j++) {
            const btn = msg.buttons[j];
            if (!btn.text || !btn.text.trim()) {
              return res.status(400).json({ error: `Укажите текст кнопки ${j + 1} в сообщении ${i + 1}` });
            }
            if (!btn.value || !btn.value.trim()) {
              return res.status(400).json({ error: `Укажите действие кнопки "${btn.text}" в сообщении ${i + 1}` });
            }
            if (btn.type === 'url' && !/^https?:\/\/.+/i.test(btn.value.trim())) {
              return res.status(400).json({ error: `Невалидная ссылка в кнопке "${btn.text}". Используйте формат https://...` });
            }
            if (btn.type === 'command' && !btn.value.trim().startsWith('/')) {
              return res.status(400).json({ error: `Команда должна начинаться с / в кнопке "${btn.text}"` });
            }
          }
        }
      }
      normalizedMessages = messages.map(msg => ({
        photo_url: msg.photo_url?.trim() || '',
        text: msg.text.trim(),
        parse_mode: msg.parse_mode || parse_mode || null,
        buttons: Array.isArray(msg.buttons) ? msg.buttons.slice(0, 6).map(b => {
          const nb = { text: b.text, type: b.type, value: b.value };
          if (b.style) nb.style = b.style;
          return nb;
        }) : [],
      }));
    } else {
      if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Текст сообщения обязателен' });
      }
      normalizedMessages = [{
        photo_url: '',
        text: text.trim(),
        parse_mode: parse_mode || null,
        buttons: Array.isArray(buttons) ? buttons.slice(0, 6).map(b => {
          const nb = { text: b.text, type: b.type, value: b.value };
          if (b.style) nb.style = b.style;
          return nb;
        }) : [],
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

    // Новый формат фильтров: conditions/operators (с обратной совместимостью)
    const broadcastFilters = {};
    if (Array.isArray(filters?.conditions) && filters.conditions.length > 0) {
      broadcastFilters.conditions = filters.conditions;
      broadcastFilters.operators = Array.isArray(filters.operators) ? filters.operators : [];
    } else {
      broadcastFilters.include_tags = filters?.include_tags || [];
      broadcastFilters.exclude_tags = filters?.exclude_tags || [];
    }
    broadcastFilters.list_schema_id = filters?.list_schema_id || null;
    broadcastFilters.list_name = filters?.list_name || null;

    const delaySeconds = Math.max(0, Math.min(300, parseInt(message_delay) || 0));

    const broadcast = {
      id,
      name: name || '',
      parse_mode: parse_mode || null,
      messages: normalizedMessages,
      filters: broadcastFilters,
      bot_id: broadcastBot ? broadcastBot.id : null,
      scheduled_at: scheduled_at || new Date().toISOString(),
      created_by: req.telegramId,
      message_delay: delaySeconds,
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
// API: Данные рассылки для повтора с редактированием
// ============================================
app.get('/api/broadcast/:id/data', requireTenantAdmin, (req, res) => {
  try {
    const broadcast = db.getBroadcast(req.params.id, req.tenantId);
    if (!broadcast) return res.status(404).json({ error: 'Рассылка не найдена' });

    res.json({
      broadcast: {
        name: broadcast.name || '',
        bot_id: broadcast.bot_id,
        messages: broadcast.messages || [],
        filters: broadcast.filters || {},
        message_delay: broadcast.message_delay || 0,
      },
    });
  } catch (e) {
    console.error('GET /api/broadcast/:id/data error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки данных рассылки' });
  }
});

// ============================================
// API: Экспорт отчёта рассылки в Excel
// ============================================
app.get('/api/broadcast/:id/export', requireTenantAdmin, async (req, res) => {
  try {
    const broadcast = db.getBroadcast(req.params.id, req.tenantId);
    if (!broadcast) return res.status(404).json({ error: 'Рассылка не найдена' });

    const recipients = db.getBroadcastRecipients(broadcast.id);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Отчёт');

    // Шапка отчёта
    const filtersDesc = [];
    if (broadcast.filters?.conditions?.length) {
      for (let i = 0; i < broadcast.filters.conditions.length; i++) {
        const c = broadcast.filters.conditions[i];
        filtersDesc.push(`${c.type === 'has' ? 'ЕСТЬ' : 'НЕТ'} "${c.tag}"`);
        if (i < (broadcast.filters.operators || []).length) {
          filtersDesc.push(broadcast.filters.operators[i] === 'AND' ? 'И' : 'ИЛИ');
        }
      }
    } else {
      if (broadcast.filters?.include_tags?.length) filtersDesc.push('Включить: ' + broadcast.filters.include_tags.join(', '));
      if (broadcast.filters?.exclude_tags?.length) filtersDesc.push('Исключить: ' + broadcast.filters.exclude_tags.join(', '));
    }
    if (broadcast.filters?.list_name) filtersDesc.push('Список: ' + broadcast.filters.list_name);

    const headerRows = [
      ['Рассылка:', broadcast.name || 'Без названия'],
      ['Дата отправки:', broadcast.sent_at ? new Date(broadcast.sent_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—'],
      ['Фильтры:', filtersDesc.join(' ') || 'Без фильтров'],
      ['Всего получателей:', broadcast.total_recipients || 0],
      ['Доставлено:', broadcast.sent_count || 0],
      ['Ошибок:', broadcast.failed_count || 0],
      [],
    ];

    headerRows.forEach(row => {
      const r = sheet.addRow(row);
      if (row.length >= 1 && row[0]) r.getCell(1).font = { bold: true };
    });

    // Таблица получателей
    const tableHeader = sheet.addRow(['№', 'Telegram ID', 'Имя', 'Статус', 'Ошибка', 'Дата']);
    tableHeader.eachCell(cell => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
      cell.border = {
        bottom: { style: 'thin' },
      };
    });

    recipients.forEach((r, i) => {
      sheet.addRow([
        i + 1,
        r.telegram_id,
        r.name || '',
        r.status === 'sent' ? 'Доставлено' : 'Ошибка',
        r.error || '',
        r.sent_at ? new Date(r.sent_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '',
      ]);
    });

    // Ширина колонок
    sheet.columns = [
      { width: 6 },
      { width: 16 },
      { width: 25 },
      { width: 14 },
      { width: 35 },
      { width: 20 },
    ];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="broadcast_report_${broadcast.id}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('GET /api/broadcast/:id/export error:', e.message);
    res.status(500).json({ error: 'Ошибка генерации отчёта' });
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

    // Проверяем что остаётся хотя бы 1 бот (суперадмин может удалить любого)
    const bots = db.getBotsByTenant(req.tenantId);
    if (bots.length <= 1 && !isSuperAdmin(req.telegramId)) {
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

    // Проверяем: не является ли он уже арендатором (owner тенанта)
    const ownerOf = db.isOwnerOfAnyTenant(telegram_id);
    if (ownerOf) {
      return res.status(400).json({
        error: `Этот пользователь уже является арендатором ("${ownerOf.name}"). Арендатор не может быть помощником`
      });
    }

    // Проверяем: не является ли он уже админом другого тенанта
    const adminOf = db.isAdminOfAnyTenant(telegram_id);
    if (adminOf && adminOf.tenant_id !== req.tenantId) {
      return res.status(400).json({
        error: `Этот пользователь уже является помощником другого арендатора ("${adminOf.tenant_name}")`
      });
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
    const tenant = db.getTenantById(req.tenantId);
    const bots = db.getBotsByTenant(req.tenantId);
    if (!tenant || bots.length === 0) return res.json({ lists: [], mapping: {} });

    // Загружаем списки отдельно для каждого бота (по leadteh_bot_id)
    const listsPerBot = {};
    const allListsMap = new Map();
    for (const bot of bots) {
      if (!bot.leadteh_bot_id) { listsPerBot[bot.id] = []; continue; }
      try {
        const schemas = await fetchListSchemas({ leadtehApiToken: tenant.leadteh_api_token, leadtehBotId: bot.leadteh_bot_id });
        const botLists = (Array.isArray(schemas) ? schemas : []).map(s => {
          const item = { id: s.id, name: s.name || s.title || `Список ${s.id}` };
          allListsMap.set(s.id, item);
          return item;
        });
        listsPerBot[bot.id] = botLists;
      } catch (e) {
        console.error(`Ошибка загрузки списков для bot=${bot.id} leadteh_bot_id=${bot.leadteh_bot_id}:`, e.message);
        listsPerBot[bot.id] = [];
      }
    }
    const allLists = [...allListsMap.values()];

    // Собираем маппинг для ботов тенанта
    const mapping = {};
    for (const bot of bots) {
      mapping[bot.id] = db.getBotListMappings(bot.id);
    }

    res.json({ lists: allLists, listsPerBot, mapping });
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

    const subscription = db.checkSubscription(req.tenantId);

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
      subscription,
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

    // Проверяем: не является ли он админом (помощником) другого тенанта
    const adminOf = db.isAdminOfAnyTenant(telegram_id);
    if (adminOf) {
      return res.status(400).json({
        error: `Этот пользователь является помощником арендатора "${adminOf.tenant_name}". Сначала удалите его оттуда`
      });
    }

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

// --- Удалить тенанта ---
app.post('/api/super/tenants/:id/delete', requireSuperAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const tenant = db.getTenantById(Number(id));
    if (!tenant) return res.status(404).json({ error: 'Тенант не найден' });

    db.deleteTenant(Number(id));

    // Удалить файлы загрузок тенанта
    const uploadsDir = path.join(__dirname, 'data', 'uploads', String(id));
    if (fs.existsSync(uploadsDir)) {
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/super/tenants/:id/delete error:', e.message);
    res.status(500).json({ error: 'Ошибка удаления тенанта' });
  }
});

// --- Активация подписки тенанта ---
app.post('/api/super/tenants/:id/activate', requireSuperAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { days, months, until } = req.body;

    const tenant = db.getTenantById(Number(id));
    if (!tenant) return res.status(404).json({ error: 'Тенант не найден' });

    let newPaidUntil;

    if (until) {
      // Конкретная дата
      newPaidUntil = new Date(until);
      if (isNaN(newPaidUntil.getTime())) return res.status(400).json({ error: 'Невалидная дата' });
    } else {
      // Продлеваем от текущей даты или от paid_until (если ещё активна)
      const now = new Date();
      const currentPaidUntil = tenant.paid_until ? new Date(tenant.paid_until) : null;
      const baseDate = (currentPaidUntil && currentPaidUntil > now) ? currentPaidUntil : now;
      newPaidUntil = new Date(baseDate);

      if (days) {
        newPaidUntil.setDate(newPaidUntil.getDate() + (parseInt(days) || 0));
      } else {
        newPaidUntil.setMonth(newPaidUntil.getMonth() + (parseInt(months) || 1));
      }
    }

    db.updateTenant(Number(id), { paid_until: newPaidUntil.toISOString() });
    res.json({ ok: true, paid_until: newPaidUntil.toISOString() });
  } catch (e) {
    console.error('POST /api/super/tenants/:id/activate error:', e.message);
    res.status(500).json({ error: 'Ошибка активации подписки' });
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
// API: Авторассылки
// ============================================
app.post('/api/auto/save', requireTenantAdmin, (req, res) => {
  try {
    const { name, type, bot_id, steps, schedule, filters } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'Название обязательно' });
    if (!['chain', 'recurring'].includes(type)) return res.status(400).json({ error: 'Тип должен быть chain или recurring' });
    if (!bot_id) return res.status(400).json({ error: 'Выберите бота' });

    // Проверка бота
    const bots = db.getBotsByTenant(req.tenantId);
    const bot = bots.find(b => b.id === Number(bot_id));
    if (!bot) return res.status(400).json({ error: 'Бот не найден' });

    // Проверка подписки (суперадмин — обход)
    if (req.role !== 'super_admin') {
      const sub = db.checkSubscription(req.tenantId);
      if (!sub.canBroadcast) {
        return res.status(403).json({ error: 'Подписка истекла. Обратитесь к администратору для продления.', subscription_expired: true });
      }
    }

    // Валидация шагов
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > 5) {
      return res.status(400).json({ error: 'От 1 до 5 шагов' });
    }

    for (let si = 0; si < steps.length; si++) {
      const step = steps[si];
      if (!Array.isArray(step.messages) || step.messages.length === 0 || step.messages.length > 5) {
        return res.status(400).json({ error: `Шаг ${si + 1}: от 1 до 5 сообщений` });
      }
      for (let mi = 0; mi < step.messages.length; mi++) {
        const msg = step.messages[mi];
        if (!msg.text || !msg.text.trim()) {
          return res.status(400).json({ error: `Шаг ${si + 1}, сообщение ${mi + 1}: текст обязателен` });
        }
        if (msg.parse_mode && !VALID_PARSE_MODES.includes(msg.parse_mode)) {
          return res.status(400).json({ error: `Шаг ${si + 1}, сообщение ${mi + 1}: невалидный parse_mode` });
        }
        if (msg.photo_url && msg.photo_url.trim()) {
          if (!msg.photo_url.startsWith('/api/uploads/')) {
            try { new URL(msg.photo_url); } catch {
              return res.status(400).json({ error: `Шаг ${si + 1}, сообщение ${mi + 1}: невалидный URL фото` });
            }
          }
        }
        // Валидация кнопок
        if (Array.isArray(msg.buttons)) {
          if (msg.buttons.length > 6) {
            return res.status(400).json({ error: `Шаг ${si + 1}, сообщение ${mi + 1}: максимум 6 кнопок` });
          }
          for (let j = 0; j < msg.buttons.length; j++) {
            const btn = msg.buttons[j];
            if (!btn.text || !btn.text.trim()) {
              return res.status(400).json({ error: `Укажите текст кнопки ${j + 1} в шаге ${si + 1}, сообщении ${mi + 1}` });
            }
            if (!btn.value || !btn.value.trim()) {
              return res.status(400).json({ error: `Укажите действие кнопки "${btn.text}" в шаге ${si + 1}` });
            }
            if (btn.type === 'url' && !/^https?:\/\/.+/i.test(btn.value.trim())) {
              return res.status(400).json({ error: `Невалидная ссылка в кнопке "${btn.text}"` });
            }
            if (btn.type === 'command' && !btn.value.trim().startsWith('/')) {
              return res.status(400).json({ error: `Команда должна начинаться с / в кнопке "${btn.text}"` });
            }
          }
        }
      }
    }

    // Для recurring — валидация расписания
    if (type === 'recurring') {
      if (!schedule || !Array.isArray(schedule.days) || schedule.days.length === 0) {
        return res.status(400).json({ error: 'Выберите дни недели' });
      }
      if (!schedule.time || !/^\d{2}:\d{2}$/.test(schedule.time)) {
        return res.status(400).json({ error: 'Укажите время в формате HH:MM' });
      }
    }

    // Нормализация
    const id = generateId();
    const normalizedSteps = steps.map((step, si) => ({
      delay_value: si === 0 ? 0 : (parseInt(step.delay_value) || 0),
      delay_unit: step.delay_unit || 'hours',
      message_delay: Math.max(0, Math.min(300, parseInt(step.message_delay) || 0)),
      messages: step.messages.map(msg => ({
        photo_url: msg.photo_url?.trim() || '',
        text: msg.text.trim(),
        parse_mode: msg.parse_mode || null,
        buttons: Array.isArray(msg.buttons) ? msg.buttons.slice(0, 6).map(b => {
          const nb = { text: b.text, type: b.type, value: b.value };
          if (b.style) nb.style = b.style;
          return nb;
        }) : [],
      })),
    }));

    // Фильтры
    const autoFilters = {};
    if (Array.isArray(filters?.conditions) && filters.conditions.length > 0) {
      autoFilters.conditions = filters.conditions;
      autoFilters.operators = Array.isArray(filters.operators) ? filters.operators : [];
    }
    autoFilters.list_schema_id = filters?.list_schema_id || null;
    autoFilters.list_name = filters?.list_name || null;

    const autoData = {
      id,
      name: name.trim(),
      type,
      bot_id: bot.id,
      filters: autoFilters,
      schedule: type === 'recurring' ? (schedule || {}) : {},
      status: 'active',
      created_by: req.telegramId,
      steps: normalizedSteps,
    };

    db.saveAutoBroadcast(req.tenantId, autoData);

    // Для chain — сразу создаём run, первый шаг отправляется немедленно
    if (type === 'chain') {
      db.createAutoRun(id, new Date().toISOString());
    }

    res.json({ ok: true, id });
  } catch (e) {
    console.error('POST /api/auto/save error:', e.message);
    res.status(500).json({ error: 'Ошибка сохранения авторассылки' });
  }
});

app.get('/api/auto/list', requireTenantAdmin, (req, res) => {
  try {
    const list = db.listAutoBroadcasts(req.tenantId);
    res.json({ auto_broadcasts: list });
  } catch (e) {
    console.error('GET /api/auto/list error:', e.message);
    res.status(500).json({ error: 'Ошибка загрузки авторассылок' });
  }
});

app.get('/api/auto/:id', requireTenantAdmin, (req, res) => {
  try {
    const ab = db.getAutoBroadcast(req.params.id, req.tenantId);
    if (!ab) return res.status(404).json({ error: 'Авторассылка не найдена' });
    if (ab.type === 'chain') {
      ab.enrollment_stats = db.getEnrollmentStats(ab.id);
    }
    res.json({ auto_broadcast: ab });
  } catch (e) {
    console.error('GET /api/auto/:id error:', e.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/auto/:id/pause', requireTenantAdmin, (req, res) => {
  try {
    const ab = db.getAutoBroadcast(req.params.id, req.tenantId);
    if (!ab) return res.status(404).json({ error: 'Авторассылка не найдена' });
    if (ab.status !== 'active') return res.status(400).json({ error: 'Можно приостановить только активную авторассылку' });
    db.updateAutoBroadcastStatus(req.params.id, 'paused');
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/auto/:id/pause error:', e.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/auto/:id/resume', requireTenantAdmin, (req, res) => {
  try {
    const ab = db.getAutoBroadcast(req.params.id, req.tenantId);
    if (!ab) return res.status(404).json({ error: 'Авторассылка не найдена' });
    if (ab.status !== 'paused') return res.status(400).json({ error: 'Можно возобновить только приостановленную авторассылку' });
    db.updateAutoBroadcastStatus(req.params.id, 'active');
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/auto/:id/resume error:', e.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/auto/:id/stop', requireTenantAdmin, (req, res) => {
  try {
    const ab = db.getAutoBroadcast(req.params.id, req.tenantId);
    if (!ab) return res.status(404).json({ error: 'Авторассылка не найдена' });
    db.updateAutoBroadcastStatus(req.params.id, 'stopped');
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/auto/:id/stop error:', e.message);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/auto/:id/delete', requireTenantAdmin, (req, res) => {
  try {
    const result = db.deleteAutoBroadcast(req.params.id, req.tenantId);
    if (result.changes === 0) return res.status(404).json({ error: 'Авторассылка не найдена' });
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/auto/:id/delete error:', e.message);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

app.post('/api/auto/:id/start', requireTenantAdmin, (req, res) => {
  try {
    const ab = db.getAutoBroadcast(req.params.id, req.tenantId);
    if (!ab) return res.status(404).json({ error: 'Авторассылка не найдена' });
    if (ab.type !== 'chain') return res.status(400).json({ error: 'Ручной запуск только для цепочек' });
    // Активируем цепочку — cron начнёт мониторить контакты
    db.updateAutoBroadcastStatus(ab.id, 'active');
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/auto/:id/start error:', e.message);
    res.status(500).json({ error: 'Ошибка запуска' });
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
    // Авторассылки: цепочки
    await processChainRuns();
    // Авторассылки: рекурренция
    await processRecurringBroadcasts();
    // Очистка просроченных сессий
    db.deleteExpiredSessions();
    // Уведомления об истекающем trial (раз в час)
    if (new Date().getMinutes() === 0) {
      await notifyTrialExpiry();
    }
  } catch (e) {
    console.error('[cron] Ошибка:', e.message);
  }
});

// ============================================
// Уведомления суперадмину об истекающем trial
// ============================================
async function notifyTrialExpiry() {
  if (!SUPER_ADMIN_ID || !config.platformBotToken) return;
  try {
    const expiring = db.getExpiringTrials();
    if (expiring.length === 0) return;

    const lines = expiring.map(t => `- ${t.name || 'Без имени'} (TG: ${t.telegram_id}, trial до ${t.trial_ends_at?.slice(0, 10)})`);
    const text = `⏰ Trial истекает в ближайшие 24ч:\n${lines.join('\n')}`;

    await fetch(`https://api.telegram.org/bot${config.platformBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: SUPER_ADMIN_ID, text }),
    });
    console.log(`[notify] Отправлено уведомление суперадмину: ${expiring.length} тенантов`);
  } catch (e) {
    console.error('[notify] Ошибка уведомления:', e.message);
  }
}

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

// ============================================
// Авторассылки: обработка цепочек (per-contact enrollment)
// ============================================
async function processChainRuns() {
  // 1. Найти новых контактов для активных цепочек → enroll + отправить шаг 0
  const activeChains = db.getActiveChains();
  for (const chain of activeChains) {
    try {
      const ab = db.getAutoBroadcast(chain.id);
      if (!ab || !ab.steps || ab.steps.length === 0) continue;

      const matchingContacts = await getFilteredContacts(ab);
      if (matchingContacts.length === 0) continue;

      const alreadyEnrolled = db.getEnrolledContactIds(ab.id);
      const newContacts = matchingContacts.filter(c => !alreadyEnrolled.has(String(c.telegram_id)));
      if (newContacts.length === 0) continue;

      console.log(`[auto-chain] "${ab.name}": ${newContacts.length} новых контактов`);

      const step0 = ab.steps[0];
      const prepared = await prepareStepMessages(ab, step0);

      for (const contact of newContacts) {
        try {
          const ok = await sendPreparedToContact(ab, prepared, contact.telegram_id);
          if (ok) {
            // Вычисляем время следующего шага
            let nextStepAt = null;
            if (ab.steps.length > 1) {
              const delayMs = computeDelayMs(ab.steps[1].delay_value, ab.steps[1].delay_unit);
              nextStepAt = new Date(Date.now() + delayMs).toISOString();
            }
            db.enrollContact(ab.id, contact.telegram_id, nextStepAt);
            if (ab.steps.length <= 1) {
              // Единственный шаг — сразу завершаем
              const enrolled = db.getEnrolledContactIds(ab.id);
              // enrollContact уже вставил — обновим статус
            }
          }
        } catch (e) {
          console.error(`[auto-chain] Ошибка отправки шага 0 контакту ${contact.telegram_id}:`, e.message);
        }
        await new Promise(r => setTimeout(r, 35));
      }
    } catch (e) {
      console.error(`[auto-chain] Ошибка обработки цепочки ${chain.id}:`, e.message);
    }
  }

  // 2. Обработать enrollments, у которых пришло время следующего шага
  const dueEnrollments = db.getDueEnrollments();
  for (const enrollment of dueEnrollments) {
    try {
      const ab = db.getAutoBroadcast(enrollment.auto_broadcast_id);
      if (!ab || ab.status !== 'active') {
        db.updateEnrollment(enrollment.id, { status: 'completed' });
        continue;
      }

      const steps = ab.steps || [];
      const nextStepIdx = enrollment.current_step + 1;

      if (nextStepIdx >= steps.length) {
        db.updateEnrollment(enrollment.id, { status: 'completed' });
        continue;
      }

      const step = steps[nextStepIdx];
      const prepared = await prepareStepMessages(ab, step);
      const ok = await sendPreparedToContact(ab, prepared, enrollment.contact_telegram_id);

      if (ok) {
        const afterNextIdx = nextStepIdx + 1;
        if (afterNextIdx >= steps.length) {
          db.updateEnrollment(enrollment.id, { current_step: nextStepIdx, status: 'completed', next_step_at: null });
          console.log(`[auto-chain] Контакт ${enrollment.contact_telegram_id} завершил цепочку "${ab.name}"`);
        } else {
          const nextDelay = computeDelayMs(steps[afterNextIdx].delay_value, steps[afterNextIdx].delay_unit);
          const nextStepAt = new Date(Date.now() + nextDelay).toISOString();
          db.updateEnrollment(enrollment.id, { current_step: nextStepIdx, next_step_at: nextStepAt });
          console.log(`[auto-chain] Контакт ${enrollment.contact_telegram_id}: шаг ${nextStepIdx + 1}/${steps.length}, след. через ${steps[afterNextIdx].delay_value} ${steps[afterNextIdx].delay_unit}`);
        }
      } else {
        db.updateEnrollment(enrollment.id, { status: 'error' });
      }
    } catch (e) {
      console.error(`[auto-chain] Ошибка enrollment ${enrollment.id}:`, e.message);
      db.updateEnrollment(enrollment.id, { status: 'error' });
    }
  }
}

// Получить контакты, подходящие под фильтры авторассылки
async function getFilteredContacts(autoBroadcast) {
  const bot = autoBroadcast.bot_id ? db.getBotById(autoBroadcast.bot_id) : null;
  if (!bot) return [];

  const tenant = db.getTenantById(autoBroadcast.tenant_id);
  if (!tenant) return [];

  const botConfig = {
    leadtehApiToken: tenant.leadteh_api_token,
    leadtehBotId: bot.leadteh_bot_id,
    telegramBotToken: bot.token,
  };

  const allContacts = await fetchAllContacts(botConfig);
  const filters = autoBroadcast.filters || {};
  const listSchemaId = filters.list_schema_id || null;

  let listTelegramIds = null;
  if (listSchemaId) {
    try {
      const schemas = await fetchListSchemas(botConfig);
      const schema = (Array.isArray(schemas) ? schemas : []).find(s => String(s.id) === String(listSchemaId));
      const fields = schema?.fields || [];
      const items = await fetchListItems(botConfig, listSchemaId);
      listTelegramIds = new Set(extractTelegramIds(Array.isArray(items) ? items : [], fields));
    } catch (e) {
      console.error('[auto] Ошибка загрузки списка:', e.message);
    }
  }

  const filterConditions = Array.isArray(filters.conditions) ? filters.conditions : null;
  const filterOperators = Array.isArray(filters.operators) ? filters.operators : [];

  return allContacts.filter(contact => {
    if (!contact.telegram_id) return false;
    if (listTelegramIds) return listTelegramIds.has(String(contact.telegram_id));
    const contactTags = extractTags(contact);
    if (filterConditions && filterConditions.length > 0) {
      return evaluateFilterConditions(contactTags, filterConditions, filterOperators);
    }
    return true;
  });
}

// Подготовить сообщения шага (без отправки)
async function prepareStepMessages(autoBroadcast, step) {
  const bot = db.getBotById(autoBroadcast.bot_id);
  let botUsername = bot.bot_username || '';
  if (!botUsername) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${bot.token}/getMe`);
      const data = await r.json();
      if (data.ok) botUsername = data.result.username;
    } catch (e) { /* ignore */ }
  }

  const messages = step.messages || [];
  return {
    botToken: bot.token,
    tenantId: autoBroadcast.tenant_id,
    messageDelay: step.message_delay || 0,
    messages: messages.map(msg => ({
      text: msg.text || '',
      photoUrl: msg.photo_url || '',
      keyboard: buildKeyboard(msg.buttons || [], botUsername),
      parseMode: msg.parse_mode || null,
    })),
  };
}

// Отправить подготовленные сообщения одному контакту
async function sendPreparedToContact(autoBroadcast, prepared, telegramId) {
  for (let i = 0; i < prepared.messages.length; i++) {
    const msg = prepared.messages[i];
    try {
      const r = await sendSingleMessage(
        prepared.botToken,
        telegramId,
        msg.text,
        msg.photoUrl,
        msg.keyboard,
        msg.parseMode,
        prepared.tenantId
      );
      if (!r.ok) return false;
    } catch (e) {
      return false;
    }
    if (i < prepared.messages.length - 1) {
      const delayMs = prepared.messageDelay * 1000 || 500;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return true;
}

// ============================================
// Авторассылки: обработка рекурренции (recurring)
// ============================================
async function processRecurringBroadcasts() {
  const recurring = db.getRecurringDue();
  const now = new Date();
  // МСК = UTC+3
  const mskOffset = 3 * 60 * 60 * 1000;
  const mskNow = new Date(now.getTime() + mskOffset);
  const mskDay = mskNow.getUTCDay(); // 0=Вс, 1=Пн..6=Сб
  const mskHour = mskNow.getUTCHours();
  const mskMinute = mskNow.getUTCMinutes();
  const mskTimeStr = String(mskHour).padStart(2, '0') + ':' + String(mskMinute).padStart(2, '0');

  for (const ab of recurring) {
    try {
      const schedule = JSON.parse(ab.schedule_json);
      if (!schedule.days || !schedule.time) continue;

      // Проверяем день недели
      if (!schedule.days.includes(mskDay)) continue;

      // Проверяем время (минутная точность)
      if (mskTimeStr !== schedule.time) continue;

      // Проверяем: уже отправляли сегодня?
      if (db.hasRunToday(ab.id)) continue;

      console.log(`[auto-recurring] Запуск "${ab.name}" (${schedule.time}, день ${mskDay})`);

      const fullAb = db.getAutoBroadcast(ab.id);
      if (!fullAb || !fullAb.steps || fullAb.steps.length === 0) continue;

      const runId = db.createAutoRun(ab.id, null);
      const step = fullAb.steps[0]; // recurring — всегда 1 шаг

      await sendStepMessages(fullAb, step);

      db.updateAutoRun(runId, { current_step: 1, status: 'completed', completed_at: new Date().toISOString() });
      console.log(`[auto-recurring] "${ab.name}" отправлена`);
    } catch (e) {
      console.error(`[auto-recurring] Ошибка ${ab.id}:`, e.message);
    }
  }
}

// ============================================
// Общая логика отправки шага авторассылки (для recurring — всем сразу)
// ============================================
async function sendStepMessages(autoBroadcast, step) {
  const recipients = await getFilteredContacts(autoBroadcast);
  const prepared = await prepareStepMessages(autoBroadcast, step);

  let sent = 0;
  let failed = 0;

  for (const contact of recipients) {
    const ok = await sendPreparedToContact(autoBroadcast, prepared, contact.telegram_id);
    if (ok) sent++;
    else failed++;
    await new Promise(r => setTimeout(r, 35));
  }

  console.log(`[auto] Отправлено: ${sent}, ошибок: ${failed}`);
  return { sent, failed };
}

function computeDelayMs(value, unit) {
  const v = parseInt(value) || 0;
  switch (unit) {
    case 'minutes': return v * 60 * 1000;
    case 'hours': return v * 60 * 60 * 1000;
    case 'days': return v * 24 * 60 * 60 * 1000;
    default: return v * 60 * 60 * 1000;
  }
}

async function sendBroadcast(broadcast) {
  // Загружаем credentials тенанта и бота из БД
  const bot = broadcast.bot_id ? db.getBotById(broadcast.bot_id) : null;
  if (!bot) throw new Error('Бот не найден');

  const botConfig = {
    leadtehApiToken: broadcast.leadteh_api_token,
    leadtehBotId: bot.leadteh_bot_id,
    telegramBotToken: bot.token,
  };

  const allContacts = await fetchAllContacts(botConfig);
  const filters = broadcast.filters || {};
  const listSchemaId = filters.list_schema_id || null;

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

  // Новый формат: conditions + operators
  const filterConditions = Array.isArray(filters.conditions) ? filters.conditions : null;
  const filterOperators = Array.isArray(filters.operators) ? filters.operators : [];
  // Legacy формат
  const includeTags = filters.include_tags || [];
  const excludeTags = filters.exclude_tags || [];

  const recipients = allContacts.filter(contact => {
    if (!contact.telegram_id) return false;

    if (listTelegramIds) {
      return listTelegramIds.has(String(contact.telegram_id));
    }

    const contactTags = extractTags(contact);

    // Новый формат условий
    if (filterConditions && filterConditions.length > 0) {
      return evaluateFilterConditions(contactTags, filterConditions, filterOperators);
    }

    // Legacy формат
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
    parseMode: msg.parse_mode || broadcast.parse_mode || null,
  }));

  // Сохраняем общее количество
  db.updateBroadcastStatus(broadcast.id, { total_recipients: recipients.length });

  let sent = 0;
  let failed = 0;

  for (const contact of recipients) {
    let contactFailed = false;
    let lastError = '';

    for (let i = 0; i < prepared.length; i++) {
      const msg = prepared[i];
      try {
        const r = await sendSingleMessage(
          bot.token,
          contact.telegram_id,
          msg.text,
          msg.photoUrl,
          msg.keyboard,
          msg.parseMode,
          broadcast.tenant_id
        );

        if (!r.ok) {
          const err = await r.json();
          lastError = err.description || 'Telegram API error';
          console.error(`Не удалось отправить ${contact.telegram_id} (msg ${i + 1}):`, err.description);
          contactFailed = true;
          break;
        }
      } catch (e) {
        lastError = e.message;
        console.error(`Ошибка отправки ${contact.telegram_id} (msg ${i + 1}):`, e.message);
        contactFailed = true;
        break;
      }

      if (i < prepared.length - 1) {
        const delayMs = (broadcast.message_delay || 0) * 1000 || 500;
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.name || '';
    if (contactFailed) {
      failed++;
      db.saveBroadcastRecipient(broadcast.id, {
        telegram_id: contact.telegram_id,
        name: contactName,
        status: 'failed',
        error: lastError || 'Ошибка отправки',
        sent_at: new Date().toISOString(),
      });
    } else {
      sent++;
      db.saveBroadcastRecipient(broadcast.id, {
        telegram_id: contact.telegram_id,
        name: contactName,
        status: 'sent',
        sent_at: new Date().toISOString(),
      });
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
    } else if (btn.type === 'command') {
      // /start param → deep link, остальные команды → callback_data
      const startMatch = btn.value.match(/^\/start\s+(.+)/);
      if (startMatch && botUsername) {
        const param = encodeURIComponent(startMatch[1].trim());
        button = { text: btn.text, url: `https://t.me/${botUsername}?start=${param}` };
      } else if (btn.value === '/start' && botUsername) {
        button = { text: btn.text, url: `https://t.me/${botUsername}` };
      } else {
        button = { text: btn.text, callback_data: btn.value };
      }
    } else if (btn.type === 'start') {
      // Обратная совместимость со старыми рассылками
      const param = encodeURIComponent(btn.value);
      const url = botUsername
        ? `https://t.me/${botUsername}?start=${param}`
        : btn.value;
      button = { text: btn.text, url };
    } else {
      continue;
    }

    if (btn.style) button.style = btn.style;

    currentRow.push(button);
    if (currentRow.length >= 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  if (currentRow.length > 0) rows.push(currentRow);
  return rows;
}

// Retry с exponential backoff для Telegram API (429, 5xx)
async function telegramFetch(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await fetch(url, options);

    if (r.ok || attempt === maxRetries) return r;

    // 429 Too Many Requests — Telegram отдаёт retry_after
    if (r.status === 429) {
      const err = await r.json().catch(() => ({}));
      const retryAfter = err.parameters?.retry_after || (2 ** attempt);
      console.warn(`[telegram] 429 — ждём ${retryAfter}с (попытка ${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    // 5xx — ошибка сервера Telegram, retry с backoff
    if (r.status >= 500) {
      const delay = (2 ** attempt) * 1000;
      console.warn(`[telegram] ${r.status} — retry через ${delay}мс (попытка ${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }

    // 4xx (кроме 429) — не ретраим
    return r;
  }
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

    let r = await telegramFetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!r.ok && usedParseMode) {
      const err = await r.json().catch(() => ({}));
      if (err.description && err.description.includes("can't parse entities")) {
        delete body.parse_mode;
        r = await telegramFetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
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

  let r = await telegramFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!r.ok && usedParseMode) {
    const err = await r.json().catch(() => ({}));
    if (err.description && err.description.includes("can't parse entities")) {
      delete body.parse_mode;
      r = await telegramFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
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
  const uploadsBase = path.resolve(__dirname, 'data', 'uploads');
  const filePath = path.resolve(uploadsBase, ...parts);

  // Path traversal protection
  if (!filePath.startsWith(uploadsBase + path.sep)) {
    return { ok: false, json: async () => ({ description: 'Forbidden: invalid path' }) };
  }

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

  let r = await telegramFetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: 'POST',
    body: buildFormData(true),
  });

  if (!r.ok && parseMode) {
    const err = await r.json().catch(() => ({}));
    if (err.description && err.description.includes("can't parse entities")) {
      r = await telegramFetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
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
