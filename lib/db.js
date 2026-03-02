// lib/db.js — Инициализация SQLite базы данных (sql.js — чистый JS/WASM)
// Оптимизировано: debounced save вместо записи на диск после каждого запроса
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'broadcast.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db = null;
let _inTransaction = false;
let _dirty = false;
let _saveTimer = null;
const SAVE_DEBOUNCE_MS = 500;

// ============================================
// Инициализация (async — вызвать перед использованием)
// ============================================
async function initDb() {
  if (db) return;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run("PRAGMA foreign_keys = ON");
  initTables();
  seedTariffPlans();
  flushDb();

  // Периодическое сохранение на случай если debounce не сработал
  setInterval(() => {
    if (_dirty) flushDb();
  }, 5000);

  // Сохранение при завершении процесса
  process.on('exit', () => flushDb());
  process.on('SIGINT', () => { flushDb(); process.exit(0); });
  process.on('SIGTERM', () => { flushDb(); process.exit(0); });
}

// ============================================
// Сохранение на диск (debounced)
// ============================================
function flushDb() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    _dirty = false;
  } catch (e) {
    console.error('[db] Ошибка сохранения на диск:', e.message);
  }
}

function scheduleSave() {
  _dirty = true;
  if (_inTransaction) return;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    flushDb();
  }, SAVE_DEBOUNCE_MS);
}

// ============================================
// SQL-обёртки
// ============================================
function run(sql, ...params) {
  const clean = params.map(p => p === undefined ? null : p);
  db.run(sql, clean.length > 0 ? clean : undefined);
  const changes = db.getRowsModified();
  const result = db.exec("SELECT last_insert_rowid()");
  const lastInsertRowid = result.length > 0 ? Number(result[0].values[0][0]) : 0;
  scheduleSave();
  return { lastInsertRowid, changes };
}

function get(sql, ...params) {
  const clean = params.map(p => p === undefined ? null : p);
  const stmt = db.prepare(sql);
  if (clean.length > 0) stmt.bind(clean);
  let row = undefined;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

function all(sql, ...params) {
  const clean = params.map(p => p === undefined ? null : p);
  const stmt = db.prepare(sql);
  if (clean.length > 0) stmt.bind(clean);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function beginTransaction() {
  _inTransaction = true;
  db.run("BEGIN TRANSACTION");
}

function commit() {
  db.run("COMMIT");
  _inTransaction = false;
  flushDb();
}

function rollback() {
  db.run("ROLLBACK");
  _inTransaction = false;
  _dirty = false;
}

// ============================================
// Инициализация таблиц
// ============================================
function initTables() {
  db.exec(`
    -- Тарифные планы
    CREATE TABLE IF NOT EXISTS tariff_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      max_bots INTEGER NOT NULL DEFAULT 3,
      max_broadcasts_per_month INTEGER NOT NULL DEFAULT 100,
      max_contacts INTEGER NOT NULL DEFAULT 5000,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Тенанты (арендаторы)
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      leadteh_api_token TEXT NOT NULL DEFAULT '',
      tariff_plan_id INTEGER REFERENCES tariff_plans(id),
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Админы тенанта
    CREATE TABLE IF NOT EXISTS tenant_admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      telegram_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, telegram_id)
    );

    -- Боты тенанта
    CREATE TABLE IF NOT EXISTS bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      token TEXT NOT NULL,
      leadteh_bot_id TEXT NOT NULL DEFAULT '',
      bot_username TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Рассылки
    CREATE TABLE IF NOT EXISTS broadcasts (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      bot_id INTEGER REFERENCES bots(id),
      name TEXT NOT NULL DEFAULT '',
      parse_mode TEXT,
      filters_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      scheduled_at TEXT,
      created_by TEXT,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      total_recipients INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      message_delay INTEGER NOT NULL DEFAULT 0
    );

    -- Сообщения рассылки
    CREATE TABLE IF NOT EXISTS broadcast_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      photo_url TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      buttons_json TEXT NOT NULL DEFAULT '[]',
      parse_mode TEXT DEFAULT NULL
    );

    -- Учёт использования
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      broadcasts_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tenant_id, month)
    );

    -- Сессии
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      telegram_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    -- Маппинг бот-списки
    CREATE TABLE IF NOT EXISTS bot_list_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      list_schema_id TEXT NOT NULL,
      UNIQUE(bot_id, list_schema_id)
    );

    -- Результаты доставки по получателям
    CREATE TABLE IF NOT EXISTS broadcast_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcast_id TEXT NOT NULL,
      telegram_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'sent',
      error TEXT,
      sent_at TEXT
    );

    -- Индексы
    CREATE INDEX IF NOT EXISTS idx_broadcasts_tenant ON broadcasts(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status);
    CREATE INDEX IF NOT EXISTS idx_bots_tenant ON bots(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_tenant_admins_telegram ON tenant_admins(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_br_broadcast ON broadcast_recipients(broadcast_id);
  `);

  // Миграция: добавить message_delay в broadcasts (если ещё нет)
  try {
    const bCols = db.exec("PRAGMA table_info(broadcasts)");
    const hasDelay = bCols[0]?.values?.some(row => row[1] === 'message_delay');
    if (!hasDelay) {
      db.run("ALTER TABLE broadcasts ADD COLUMN message_delay INTEGER NOT NULL DEFAULT 0");
      console.log('[db] Миграция: message_delay добавлен в broadcasts');
    }
  } catch (e) {
    console.warn('[db] Миграция message_delay:', e.message);
  }

  // Миграция: добавить parse_mode в broadcast_messages (если ещё нет)
  try {
    const cols = db.exec("PRAGMA table_info(broadcast_messages)");
    const hasParseMode = cols[0]?.values?.some(row => row[1] === 'parse_mode');
    if (!hasParseMode) {
      db.run("ALTER TABLE broadcast_messages ADD COLUMN parse_mode TEXT DEFAULT NULL");
      // Перенести parse_mode из broadcasts в каждое сообщение
      db.run(`UPDATE broadcast_messages SET parse_mode = (
        SELECT b.parse_mode FROM broadcasts b WHERE b.id = broadcast_messages.broadcast_id
      ) WHERE parse_mode IS NULL`);
      console.log('[db] Миграция: parse_mode перенесён в broadcast_messages');
    }
  } catch (e) {
    console.warn('[db] Миграция parse_mode:', e.message);
  }
}

function seedTariffPlans() {
  const existing = get('SELECT COUNT(*) as cnt FROM tariff_plans');
  if (existing.cnt > 0) return;

  beginTransaction();
  try {
    run('INSERT INTO tariff_plans (name, max_bots, max_broadcasts_per_month, max_contacts, is_default) VALUES (?, ?, ?, ?, ?)',
      'Стартовый', 1, 30, 1000, 1);
    run('INSERT INTO tariff_plans (name, max_bots, max_broadcasts_per_month, max_contacts, is_default) VALUES (?, ?, ?, ?, ?)',
      'Базовый', 3, 100, 5000, 0);
    run('INSERT INTO tariff_plans (name, max_bots, max_broadcasts_per_month, max_contacts, is_default) VALUES (?, ?, ?, ?, ?)',
      'Профессиональный', 10, 500, 50000, 0);
    commit();
  } catch (e) {
    rollback();
    throw e;
  }
}

// ============================================
// CRUD-хелперы
// ============================================

// --- Тенанты ---
function createTenant(telegramId, name, leadtehApiToken) {
  const defaultPlan = get('SELECT id FROM tariff_plans WHERE is_default = 1 LIMIT 1');
  const planId = defaultPlan ? defaultPlan.id : null;

  beginTransaction();
  try {
    const result = run(
      'INSERT INTO tenants (telegram_id, name, leadteh_api_token, tariff_plan_id) VALUES (?, ?, ?, ?)',
      telegramId, name, leadtehApiToken || '', planId
    );

    const tenantId = result.lastInsertRowid;

    // Создатель тенанта = owner
    run(
      'INSERT INTO tenant_admins (tenant_id, telegram_id, role) VALUES (?, ?, ?)',
      tenantId, telegramId, 'owner'
    );

    commit();
    return tenantId;
  } catch (e) {
    rollback();
    throw e;
  }
}

function getTenantByTelegramId(telegramId) {
  return get('SELECT * FROM tenants WHERE telegram_id = ?', String(telegramId));
}

function getTenantById(id) {
  return get('SELECT * FROM tenants WHERE id = ?', id);
}

function getAllTenants() {
  return all(
    `SELECT t.*, tp.name as tariff_name,
     (SELECT COUNT(*) FROM bots WHERE tenant_id = t.id) as bots_count,
     (SELECT COUNT(*) FROM broadcasts WHERE tenant_id = t.id) as broadcasts_count
     FROM tenants t
     LEFT JOIN tariff_plans tp ON t.tariff_plan_id = tp.id
     ORDER BY t.created_at DESC`
  );
}

function updateTenant(id, fields) {
  const allowed = ['name', 'leadteh_api_token', 'tariff_plan_id', 'status'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  run(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, ...values);
}

function deleteTenant(id) {
  // CASCADE удалит: tenant_admins, bots → bot_list_mappings, broadcasts → broadcast_messages, usage_log, sessions
  run('DELETE FROM tenants WHERE id = ?', id);
}

// --- Роли / Права ---
function findTenantByAdmin(telegramId) {
  // Проверяем: тенант-owner или admin
  const admin = get(
    `SELECT ta.tenant_id, ta.role, t.status
     FROM tenant_admins ta
     JOIN tenants t ON ta.tenant_id = t.id
     WHERE ta.telegram_id = ?`,
    String(telegramId)
  );

  if (admin) return admin;

  // Проверяем: может сам тенант
  const tenant = get(
    'SELECT id as tenant_id, status FROM tenants WHERE telegram_id = ?',
    String(telegramId)
  );

  if (tenant) return { ...tenant, role: 'owner' };

  return null;
}

function getTenantAdmins(tenantId) {
  return all('SELECT * FROM tenant_admins WHERE tenant_id = ? ORDER BY created_at', tenantId);
}

function addTenantAdmin(tenantId, telegramId, role) {
  if (!role) role = 'admin';
  return run(
    'INSERT OR IGNORE INTO tenant_admins (tenant_id, telegram_id, role) VALUES (?, ?, ?)',
    tenantId, String(telegramId), role
  );
}

function removeTenantAdmin(tenantId, telegramId) {
  return run(
    'DELETE FROM tenant_admins WHERE tenant_id = ? AND telegram_id = ? AND role != ?',
    tenantId, String(telegramId), 'owner'
  );
}

// Проверка: является ли telegram_id админом (не owner) какого-либо тенанта
function isAdminOfAnyTenant(telegramId) {
  return get(
    `SELECT ta.tenant_id, ta.role, t.name as tenant_name
     FROM tenant_admins ta
     JOIN tenants t ON ta.tenant_id = t.id
     WHERE ta.telegram_id = ? AND ta.role = 'admin'`,
    String(telegramId)
  );
}

// Проверка: является ли telegram_id владельцем (owner) какого-либо тенанта
function isOwnerOfAnyTenant(telegramId) {
  return get(
    'SELECT id, name FROM tenants WHERE telegram_id = ?',
    String(telegramId)
  );
}

// --- Боты ---
function getBotsByTenant(tenantId) {
  return all('SELECT * FROM bots WHERE tenant_id = ? AND is_active = 1 ORDER BY id', tenantId);
}

function getBotById(botId) {
  return get('SELECT * FROM bots WHERE id = ?', botId);
}

function createBot(tenantId, name, token, leadtehBotId, botUsername) {
  const result = run(
    'INSERT INTO bots (tenant_id, name, token, leadteh_bot_id, bot_username) VALUES (?, ?, ?, ?, ?)',
    tenantId, name, token, leadtehBotId || '', botUsername || ''
  );
  return result.lastInsertRowid;
}

function updateBot(botId, fields) {
  const allowed = ['name', 'token', 'leadteh_bot_id', 'bot_username', 'is_active'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return;
  values.push(botId);
  run(`UPDATE bots SET ${sets.join(', ')} WHERE id = ?`, ...values);
}

function deleteBot(botId) {
  run('UPDATE bots SET is_active = 0 WHERE id = ?', botId);
}

// --- Рассылки ---
function saveBroadcast(tenantId, broadcast) {
  beginTransaction();
  try {
    run(
      `INSERT INTO broadcasts (id, tenant_id, bot_id, name, parse_mode, filters_json, status, scheduled_at, created_by, message_delay)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      broadcast.id,
      tenantId,
      broadcast.bot_id || null,
      broadcast.name || '',
      broadcast.parse_mode || null,
      JSON.stringify(broadcast.filters || {}),
      'pending',
      broadcast.scheduled_at || new Date().toISOString(),
      broadcast.created_by || '',
      broadcast.message_delay || 0
    );

    (broadcast.messages || []).forEach((msg, i) => {
      run(
        'INSERT INTO broadcast_messages (broadcast_id, sort_order, photo_url, text, buttons_json, parse_mode) VALUES (?, ?, ?, ?, ?, ?)',
        broadcast.id,
        i,
        msg.photo_url || '',
        msg.text || '',
        JSON.stringify(msg.buttons || []),
        msg.parse_mode || null
      );
    });

    commit();
  } catch (e) {
    rollback();
    throw e;
  }
}

function getBroadcast(broadcastId, tenantId) {
  const b = get('SELECT * FROM broadcasts WHERE id = ? AND tenant_id = ?', broadcastId, tenantId);
  if (!b) return null;

  b.filters = JSON.parse(b.filters_json);
  b.messages = all(
    'SELECT * FROM broadcast_messages WHERE broadcast_id = ? ORDER BY sort_order',
    broadcastId
  ).map(m => ({
    photo_url: m.photo_url,
    text: m.text,
    buttons: JSON.parse(m.buttons_json),
    parse_mode: m.parse_mode || null,
  }));
  return b;
}

function listBroadcasts(tenantId) {
  const rows = all(
    `SELECT b.*, bt.name as bot_name
     FROM broadcasts b
     LEFT JOIN bots bt ON b.bot_id = bt.id
     WHERE b.tenant_id = ?
     ORDER BY
       CASE WHEN b.status = 'pending' THEN 0 ELSE 1 END,
       b.created_at DESC`,
    tenantId
  );

  return rows.map(b => {
    b.filters = JSON.parse(b.filters_json);
    b.messages = all(
      'SELECT * FROM broadcast_messages WHERE broadcast_id = ? ORDER BY sort_order',
      b.id
    ).map(m => ({
      photo_url: m.photo_url,
      text: m.text,
      buttons: JSON.parse(m.buttons_json),
      parse_mode: m.parse_mode || null,
    }));
    return b;
  });
}

function updateBroadcastStatus(broadcastId, fields) {
  const allowed = ['status', 'sent_count', 'failed_count', 'total_recipients', 'error', 'sent_at'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return;
  values.push(broadcastId);
  run(`UPDATE broadcasts SET ${sets.join(', ')} WHERE id = ?`, ...values);
}

function deleteBroadcast(broadcastId, tenantId) {
  return run(
    "DELETE FROM broadcasts WHERE id = ? AND tenant_id = ? AND status = 'pending'",
    broadcastId, tenantId
  );
}

function getPendingBroadcasts() {
  const now = new Date().toISOString();
  const rows = all(
    `SELECT b.*, t.leadteh_api_token
     FROM broadcasts b
     JOIN tenants t ON b.tenant_id = t.id
     WHERE b.status = 'pending' AND b.scheduled_at <= ?
     AND t.status = 'active'`,
    now
  );

  return rows.map(b => {
    b.filters = JSON.parse(b.filters_json);
    b.messages = all(
      'SELECT * FROM broadcast_messages WHERE broadcast_id = ? ORDER BY sort_order',
      b.id
    ).map(m => ({
      photo_url: m.photo_url,
      text: m.text,
      buttons: JSON.parse(m.buttons_json),
      parse_mode: m.parse_mode || null,
    }));
    return b;
  });
}

// --- Сессии ---
function createSession(tenantId, telegramId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  run(
    'INSERT INTO sessions (id, tenant_id, telegram_id, role, expires_at) VALUES (?, ?, ?, ?, ?)',
    token, tenantId, String(telegramId), role, expiresAt
  );

  return { token, expiresAt };
}

function getSession(token) {
  const session = get(
    'SELECT * FROM sessions WHERE id = ? AND expires_at > datetime(?)',
    token, new Date().toISOString()
  );
  return session || null;
}

function deleteExpiredSessions() {
  run("DELETE FROM sessions WHERE expires_at <= datetime('now')");
}

// --- Тарифные планы ---
function getTariffPlans() {
  return all('SELECT * FROM tariff_plans ORDER BY id');
}

function getTariffPlan(id) {
  return get('SELECT * FROM tariff_plans WHERE id = ?', id);
}

function createTariffPlan(name, maxBots, maxBroadcasts, maxContacts) {
  const result = run(
    'INSERT INTO tariff_plans (name, max_bots, max_broadcasts_per_month, max_contacts) VALUES (?, ?, ?, ?)',
    name, maxBots, maxBroadcasts, maxContacts
  );
  return result.lastInsertRowid;
}

function updateTariffPlan(id, fields) {
  const allowed = ['name', 'max_bots', 'max_broadcasts_per_month', 'max_contacts'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return;
  values.push(id);
  run(`UPDATE tariff_plans SET ${sets.join(', ')} WHERE id = ?`, ...values);
}

// --- Учёт использования ---
function incrementUsage(tenantId) {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  run(
    `INSERT INTO usage_log (tenant_id, month, broadcasts_count)
     VALUES (?, ?, 1)
     ON CONFLICT(tenant_id, month) DO UPDATE SET broadcasts_count = broadcasts_count + 1`,
    tenantId, month
  );
}

function getUsage(tenantId, month) {
  if (!month) month = new Date().toISOString().slice(0, 7);
  const row = get(
    'SELECT broadcasts_count FROM usage_log WHERE tenant_id = ? AND month = ?',
    tenantId, month
  );
  return row ? row.broadcasts_count : 0;
}

function checkTariffLimits(tenantId) {
  const tenant = get(
    `SELECT t.*, tp.max_bots, tp.max_broadcasts_per_month, tp.max_contacts
     FROM tenants t
     LEFT JOIN tariff_plans tp ON t.tariff_plan_id = tp.id
     WHERE t.id = ?`,
    tenantId
  );

  if (!tenant) return { allowed: false, reason: 'Тенант не найден' };
  if (!tenant.max_broadcasts_per_month) return { allowed: true };

  const month = new Date().toISOString().slice(0, 7);
  const usage = getUsage(tenantId, month);
  const botsCount = get(
    'SELECT COUNT(*) as cnt FROM bots WHERE tenant_id = ? AND is_active = 1',
    tenantId
  ).cnt;

  if (usage >= tenant.max_broadcasts_per_month) {
    return { allowed: false, reason: `Лимит рассылок в месяц исчерпан (${usage}/${tenant.max_broadcasts_per_month})` };
  }

  return {
    allowed: true,
    limits: {
      max_bots: tenant.max_bots,
      max_broadcasts_per_month: tenant.max_broadcasts_per_month,
      max_contacts: tenant.max_contacts,
      current_bots: botsCount,
      current_broadcasts: usage,
    },
  };
}

function checkBotLimit(tenantId) {
  const tenant = get(
    `SELECT tp.max_bots
     FROM tenants t
     LEFT JOIN tariff_plans tp ON t.tariff_plan_id = tp.id
     WHERE t.id = ?`,
    tenantId
  );

  if (!tenant || !tenant.max_bots) return { allowed: true };

  const botsCount = get(
    'SELECT COUNT(*) as cnt FROM bots WHERE tenant_id = ? AND is_active = 1',
    tenantId
  ).cnt;

  if (botsCount >= tenant.max_bots) {
    return { allowed: false, reason: `Лимит ботов исчерпан (${botsCount}/${tenant.max_bots})` };
  }
  return { allowed: true };
}

// --- Bot-list mappings ---
function getBotListMappings(botId) {
  return all(
    'SELECT list_schema_id FROM bot_list_mappings WHERE bot_id = ?',
    botId
  ).map(r => r.list_schema_id);
}

function setBotListMappings(botId, schemaIds) {
  beginTransaction();
  try {
    run('DELETE FROM bot_list_mappings WHERE bot_id = ?', botId);
    for (const sid of schemaIds) {
      run('INSERT INTO bot_list_mappings (bot_id, list_schema_id) VALUES (?, ?)', botId, String(sid));
    }
    commit();
  } catch (e) {
    rollback();
    throw e;
  }
}

// --- Результаты доставки ---
function saveBroadcastRecipient(broadcastId, { telegram_id, name, status, error, sent_at }) {
  run(
    'INSERT INTO broadcast_recipients (broadcast_id, telegram_id, name, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?)',
    broadcastId, String(telegram_id), name || '', status || 'sent', error || null, sent_at || null
  );
}

function getBroadcastRecipients(broadcastId) {
  return all(
    'SELECT * FROM broadcast_recipients WHERE broadcast_id = ? ORDER BY status, name',
    broadcastId
  );
}

// --- Агрегированная статистика для суперадмина ---
function getSuperStats() {
  const stats = {
    total_tenants: get('SELECT COUNT(*) as cnt FROM tenants').cnt,
    active_tenants: get("SELECT COUNT(*) as cnt FROM tenants WHERE status = 'active'").cnt,
    total_bots: get('SELECT COUNT(*) as cnt FROM bots WHERE is_active = 1').cnt,
    total_broadcasts: get('SELECT COUNT(*) as cnt FROM broadcasts').cnt,
    sent_broadcasts: get("SELECT COUNT(*) as cnt FROM broadcasts WHERE status = 'sent'").cnt,
    month: new Date().toISOString().slice(0, 7),
  };
  stats.month_broadcasts = get(
    "SELECT COUNT(*) as cnt FROM broadcasts WHERE created_at >= ? || '-01'",
    stats.month
  ).cnt;
  return stats;
}

module.exports = {
  initDb,
  flushDb,
  // Тенанты
  createTenant,
  getTenantByTelegramId,
  getTenantById,
  getAllTenants,
  updateTenant,
  deleteTenant,
  findTenantByAdmin,
  getTenantAdmins,
  addTenantAdmin,
  removeTenantAdmin,
  isAdminOfAnyTenant,
  isOwnerOfAnyTenant,
  // Боты
  getBotsByTenant,
  getBotById,
  createBot,
  updateBot,
  deleteBot,
  // Рассылки
  saveBroadcast,
  getBroadcast,
  listBroadcasts,
  updateBroadcastStatus,
  deleteBroadcast,
  getPendingBroadcasts,
  // Сессии
  createSession,
  getSession,
  deleteExpiredSessions,
  // Тарифы
  getTariffPlans,
  getTariffPlan,
  createTariffPlan,
  updateTariffPlan,
  // Использование
  incrementUsage,
  getUsage,
  checkTariffLimits,
  checkBotLimit,
  // Bot-lists
  getBotListMappings,
  setBotListMappings,
  // Результаты доставки
  saveBroadcastRecipient,
  getBroadcastRecipients,
  // Статистика
  getSuperStats,
};
