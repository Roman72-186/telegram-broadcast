// lib/db.js — Инициализация SQLite базы данных (sql.js — чистый JS/WASM)
// Оптимизировано: debounced save вместо записи на диск после каждого запроса
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { encrypt, decrypt, isEncrypted } = require('./encryption');

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
  encryptExistingTokens();
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
// Расшифровка полей в строках из БД
// ============================================
function decryptTenantRow(row) {
  if (row && row.leadteh_api_token) row.leadteh_api_token = decrypt(row.leadteh_api_token);
  return row;
}

function decryptBotRow(row) {
  if (row && row.token) row.token = decrypt(row.token);
  return row;
}

// ============================================
// Инициализация таблиц
// ============================================
function initTables() {
  db.exec(`
    -- Тарифные планы (legacy, не используется для новых тенантов)
    CREATE TABLE IF NOT EXISTS tariff_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      max_bots INTEGER NOT NULL DEFAULT 3,
      max_broadcasts_per_month INTEGER NOT NULL DEFAULT 100,
      max_contacts INTEGER NOT NULL DEFAULT 5000,
      has_dialogs INTEGER NOT NULL DEFAULT 0,
      price INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Глобальная конфигурация ценообразования
    CREATE TABLE IF NOT EXISTS pricing_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      free_bots INTEGER NOT NULL DEFAULT 1,
      price_per_bot INTEGER NOT NULL DEFAULT 200,
      free_contacts INTEGER NOT NULL DEFAULT 100,
      price_per_100_contacts INTEGER NOT NULL DEFAULT 50,
      max_bots INTEGER NOT NULL DEFAULT 10,
      max_contacts INTEGER NOT NULL DEFAULT 50000,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Seed pricing_config
    INSERT OR IGNORE INTO pricing_config (id) VALUES (1);

    -- История оплат
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      amount INTEGER NOT NULL,
      period TEXT NOT NULL,
      bots INTEGER NOT NULL,
      contacts INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT
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

    -- Авторассылки
    CREATE TABLE IF NOT EXISTS auto_broadcasts (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      bot_id INTEGER REFERENCES bots(id),
      name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'chain',
      filters_json TEXT NOT NULL DEFAULT '{}',
      schedule_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auto_broadcast_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      auto_broadcast_id TEXT NOT NULL REFERENCES auto_broadcasts(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL DEFAULT 0,
      delay_value INTEGER NOT NULL DEFAULT 0,
      delay_unit TEXT NOT NULL DEFAULT 'hours',
      message_delay INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS auto_broadcast_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      step_id INTEGER NOT NULL REFERENCES auto_broadcast_steps(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      photo_url TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      buttons_json TEXT NOT NULL DEFAULT '[]',
      parse_mode TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS auto_broadcast_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      auto_broadcast_id TEXT NOT NULL REFERENCES auto_broadcasts(id) ON DELETE CASCADE,
      current_step INTEGER NOT NULL DEFAULT 0,
      next_step_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    -- Индексы
    CREATE INDEX IF NOT EXISTS idx_broadcasts_tenant ON broadcasts(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status);
    CREATE INDEX IF NOT EXISTS idx_bots_tenant ON bots(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_tenant_admins_telegram ON tenant_admins(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_br_broadcast ON broadcast_recipients(broadcast_id);
    CREATE INDEX IF NOT EXISTS idx_auto_broadcasts_tenant ON auto_broadcasts(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_auto_broadcasts_status ON auto_broadcasts(status);
    CREATE INDEX IF NOT EXISTS idx_auto_runs_status ON auto_broadcast_runs(status);
    CREATE INDEX IF NOT EXISTS idx_auto_runs_next ON auto_broadcast_runs(next_step_at);

    CREATE TABLE IF NOT EXISTS auto_broadcast_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      auto_broadcast_id TEXT NOT NULL REFERENCES auto_broadcasts(id) ON DELETE CASCADE,
      contact_telegram_id TEXT NOT NULL,
      current_step INTEGER NOT NULL DEFAULT 0,
      next_step_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(auto_broadcast_id, contact_telegram_id)
    );
    CREATE INDEX IF NOT EXISTS idx_enrollments_auto ON auto_broadcast_enrollments(auto_broadcast_id);
    CREATE INDEX IF NOT EXISTS idx_enrollments_status ON auto_broadcast_enrollments(status);
    CREATE INDEX IF NOT EXISTS idx_enrollments_next ON auto_broadcast_enrollments(next_step_at);

    -- Чаты (диалоги арендатор ↔ пользователь)
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      contact_telegram_id TEXT NOT NULL,
      contact_name TEXT NOT NULL DEFAULT '',
      last_message_at TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(bot_id, contact_telegram_id)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      direction TEXT NOT NULL DEFAULT 'outgoing',
      text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'sent',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chats_tenant ON chats(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_chats_bot_contact ON chats(bot_id, contact_telegram_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id);

    -- Пользователи, нажавшие /start в платформенном боте
    CREATE TABLE IF NOT EXISTS platform_bot_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL UNIQUE,
      first_name TEXT DEFAULT '',
      last_name TEXT DEFAULT '',
      username TEXT DEFAULT '',
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Лог отправок контактам (для подсчёта уникальных контактов в месяц)
    CREATE TABLE IF NOT EXISTS contact_sends_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      telegram_id TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'broadcast',
      source_id TEXT NOT NULL DEFAULT '',
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_csl_tenant_sent ON contact_sends_log(tenant_id, sent_at);
  `);

  // Миграция: заполнить contact_sends_log из broadcast_recipients (одноразово)
  try {
    const migrated = get('SELECT COUNT(*) as cnt FROM contact_sends_log');
    if (migrated.cnt === 0) {
      const hasBr = get('SELECT COUNT(*) as cnt FROM broadcast_recipients WHERE status = \'sent\' AND sent_at IS NOT NULL');
      if (hasBr.cnt > 0) {
        run(`INSERT INTO contact_sends_log (tenant_id, telegram_id, source_type, source_id, sent_at)
             SELECT b.tenant_id, br.telegram_id, 'broadcast', br.broadcast_id, br.sent_at
             FROM broadcast_recipients br
             JOIN broadcasts b ON br.broadcast_id = b.id
             WHERE br.status = 'sent' AND br.sent_at IS NOT NULL`);
        console.log(`[db] Миграция: ${hasBr.cnt} записей перенесено в contact_sends_log`);
      }
    }
  } catch (e) {
    console.warn('[db] Миграция contact_sends_log:', e.message);
  }

  // Миграция: добавить trial_ends_at и paid_until в tenants
  try {
    const tCols = db.exec("PRAGMA table_info(tenants)");
    const hasTrial = tCols[0]?.values?.some(row => row[1] === 'trial_ends_at');
    if (!hasTrial) {
      db.run("ALTER TABLE tenants ADD COLUMN trial_ends_at TEXT");
      db.run("ALTER TABLE tenants ADD COLUMN paid_until TEXT");
      // Существующие тенанты получают trial 3 дня
      const trialEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      db.run("UPDATE tenants SET trial_ends_at = ?", [trialEnd]);
      console.log('[db] Миграция: trial_ends_at, paid_until добавлены в tenants');
    }
  } catch (e) {
    console.warn('[db] Миграция trial/paid:', e.message);
  }

  // Миграция v2: существующие «бессрочные» тенанты → trial 3 дня
  try {
    const hasBulk = get("SELECT COUNT(*) as cnt FROM tenants WHERE paid_until = '2099-12-31T23:59:59'");
    if (hasBulk && hasBulk.cnt > 0) {
      const trialEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      db.run("UPDATE tenants SET paid_until = NULL, trial_ends_at = ? WHERE paid_until = '2099-12-31T23:59:59'", [trialEnd]);
      console.log(`[db] Миграция v2: ${hasBulk.cnt} тенантов переведены на trial 3 дня`);
    }
  } catch (e) {
    console.warn('[db] Миграция v2 trial:', e.message);
  }

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

  // Миграция: добавить delay_before в broadcast_messages
  try {
    const bmCols = db.exec("PRAGMA table_info(broadcast_messages)");
    const hasDelayBefore = bmCols[0]?.values?.some(row => row[1] === 'delay_before');
    if (!hasDelayBefore) {
      db.run("ALTER TABLE broadcast_messages ADD COLUMN delay_before INTEGER NOT NULL DEFAULT 0");
      // Перенести message_delay из broadcasts → delay_before каждого сообщения (кроме первого)
      db.run(`UPDATE broadcast_messages SET delay_before = (
        SELECT b.message_delay FROM broadcasts b WHERE b.id = broadcast_messages.broadcast_id
      ) WHERE sort_order > 0`);
      console.log('[db] Миграция: delay_before добавлен в broadcast_messages');
    }
  } catch (e) {
    console.warn('[db] Миграция delay_before:', e.message);
  }

  // Миграция: добавить has_dialogs в tariff_plans
  try {
    const tpCols = db.exec("PRAGMA table_info(tariff_plans)");
    const hasDialogs = tpCols[0]?.values?.some(row => row[1] === 'has_dialogs');
    if (!hasDialogs) {
      db.run("ALTER TABLE tariff_plans ADD COLUMN has_dialogs INTEGER NOT NULL DEFAULT 0");
      console.log('[db] Миграция: has_dialogs добавлен в tariff_plans');
    }
  } catch (e) {
    console.warn('[db] Миграция has_dialogs:', e.message);
  }

  // Миграция: добавить price в tariff_plans
  try {
    const tpCols2 = db.exec("PRAGMA table_info(tariff_plans)");
    const hasPrice = tpCols2[0]?.values?.some(row => row[1] === 'price');
    if (!hasPrice) {
      db.run("ALTER TABLE tariff_plans ADD COLUMN price INTEGER NOT NULL DEFAULT 0");
      // Установить цены для существующих тарифов
      db.run("UPDATE tariff_plans SET price = 290 WHERE name = 'Стартовый'");
      db.run("UPDATE tariff_plans SET price = 890 WHERE name = 'Базовый'");
      db.run("UPDATE tariff_plans SET price = 2490 WHERE name = 'Профессиональный'");
      db.run("UPDATE tariff_plans SET price = 790 WHERE name = 'Стартовый + Диалоги'");
      db.run("UPDATE tariff_plans SET price = 1390 WHERE name = 'Базовый + Диалоги'");
      db.run("UPDATE tariff_plans SET price = 2990 WHERE name = 'Профессиональный + Диалоги'");
      console.log('[db] Миграция: price добавлен в tariff_plans');
    }
  } catch (e) {
    console.warn('[db] Миграция price:', e.message);
  }

  // Миграция: объединение тарифов (6→5), диалоги включены во все, добавлены Бесплатный и Бизнес
  try {
    const oldDialogTariff = db.exec("SELECT id FROM tariff_plans WHERE name = 'Стартовый + Диалоги'");
    const freeTariff = db.exec("SELECT id FROM tariff_plans WHERE name = 'Бесплатный'");
    if (oldDialogTariff[0]?.values?.length > 0 && (!freeTariff[0] || freeTariff[0].values.length === 0)) {
      db.run("BEGIN");
      try {
        // Создать новые тарифы
        db.run("INSERT INTO tariff_plans (name, max_bots, max_broadcasts_per_month, max_contacts, has_dialogs, price, is_default) VALUES ('Бесплатный', 1, 10, 200, 1, 0, 0)");
        db.run("INSERT INTO tariff_plans (name, max_bots, max_broadcasts_per_month, max_contacts, has_dialogs, price, is_default) VALUES ('Бизнес', 5, 300, 15000, 1, 1990, 0)");

        // Обновить существующие: включить диалоги, новые цены
        db.run("UPDATE tariff_plans SET has_dialogs = 1, price = 490 WHERE name = 'Стартовый'");
        db.run("UPDATE tariff_plans SET has_dialogs = 1, price = 990 WHERE name = 'Базовый'");
        db.run("UPDATE tariff_plans SET has_dialogs = 1, price = 3990 WHERE name = 'Профессиональный'");

        // Перенести тенантов с «X + Диалоги» на «X»
        const plans = db.exec("SELECT id, name FROM tariff_plans WHERE name IN ('Стартовый','Базовый','Профессиональный','Стартовый + Диалоги','Базовый + Диалоги','Профессиональный + Диалоги')");
        if (plans[0]) {
          const map = {};
          for (const row of plans[0].values) { map[row[1]] = row[0]; }
          if (map['Стартовый + Диалоги'] && map['Стартовый'])
            db.run("UPDATE tenants SET tariff_plan_id = ? WHERE tariff_plan_id = ?", [map['Стартовый'], map['Стартовый + Диалоги']]);
          if (map['Базовый + Диалоги'] && map['Базовый'])
            db.run("UPDATE tenants SET tariff_plan_id = ? WHERE tariff_plan_id = ?", [map['Базовый'], map['Базовый + Диалоги']]);
          if (map['Профессиональный + Диалоги'] && map['Профессиональный'])
            db.run("UPDATE tenants SET tariff_plan_id = ? WHERE tariff_plan_id = ?", [map['Профессиональный'], map['Профессиональный + Диалоги']]);
        }

        // Удалить старые тарифы «X + Диалоги»
        db.run("DELETE FROM tariff_plans WHERE name IN ('Стартовый + Диалоги', 'Базовый + Диалоги', 'Профессиональный + Диалоги')");

        // Бесплатный = тариф по умолчанию
        db.run("UPDATE tariff_plans SET is_default = 0");
        db.run("UPDATE tariff_plans SET is_default = 1 WHERE name = 'Бесплатный'");

        db.run("COMMIT");
        console.log('[db] Миграция: тарифы объединены (6→5), диалоги включены во все');
      } catch (e) {
        db.run("ROLLBACK");
        console.warn('[db] Миграция тарифов (6→5):', e.message);
      }
    }
  } catch (e) {
    console.warn('[db] Миграция тарифов:', e.message);
  }

  // Миграция: добавить custom_max_bots, custom_max_contacts, custom_price в tenants
  try {
    const tCols = db.exec("PRAGMA table_info(tenants)");
    const hasCustomBots = tCols[0]?.values?.some(row => row[1] === 'custom_max_bots');
    if (!hasCustomBots) {
      db.run("ALTER TABLE tenants ADD COLUMN custom_max_bots INTEGER DEFAULT NULL");
      db.run("ALTER TABLE tenants ADD COLUMN custom_max_contacts INTEGER DEFAULT NULL");
      db.run("ALTER TABLE tenants ADD COLUMN custom_price INTEGER DEFAULT NULL");

      // Миграция данных: скопировать tariff_plans → custom_* для тенантов с ненулевой ценой
      db.run(`UPDATE tenants SET
        custom_max_bots = (SELECT tp.max_bots FROM tariff_plans tp WHERE tp.id = tenants.tariff_plan_id),
        custom_max_contacts = (SELECT tp.max_contacts FROM tariff_plans tp WHERE tp.id = tenants.tariff_plan_id),
        custom_price = (SELECT tp.price FROM tariff_plans tp WHERE tp.id = tenants.tariff_plan_id)
        WHERE tariff_plan_id IS NOT NULL AND (SELECT tp2.price FROM tariff_plans tp2 WHERE tp2.id = tenants.tariff_plan_id) > 0`);

      // Тенанты на бесплатном (price=0) — custom_* остаются NULL (1 бот, 100 контактов)
      console.log('[db] Миграция: custom_max_bots/custom_max_contacts/custom_price добавлены в tenants');
    }
  } catch (e) {
    console.warn('[db] Миграция custom_* в tenants:', e.message);
  }

  // Миграция: добавить external_id, payment_url, provider в payments
  try {
    const pCols = db.exec("PRAGMA table_info(payments)");
    const hasExtId = pCols[0]?.values?.some(row => row[1] === 'external_id');
    if (!hasExtId) {
      db.run("ALTER TABLE payments ADD COLUMN external_id TEXT");
      db.run("ALTER TABLE payments ADD COLUMN payment_url TEXT");
      db.run("ALTER TABLE payments ADD COLUMN provider TEXT DEFAULT ''");
      console.log('[db] Миграция: external_id, payment_url, provider добавлены в payments');
    }
  } catch (e) {
    console.warn('[db] Миграция payments (provider):', e.message);
  }
}

function seedTariffPlans() {
  const existing = get('SELECT COUNT(*) as cnt FROM tariff_plans');
  if (existing.cnt > 0) return;

  beginTransaction();
  try {
    run('INSERT INTO tariff_plans (name, max_bots, max_broadcasts_per_month, max_contacts, has_dialogs, price, is_default) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'Бесплатный', 1, 10, 200, 1, 0, 1);
    run('INSERT INTO tariff_plans (name, max_bots, max_broadcasts_per_month, max_contacts, has_dialogs, price, is_default) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'Стартовый', 1, 30, 1000, 1, 490, 0);
    run('INSERT INTO tariff_plans (name, max_bots, max_broadcasts_per_month, max_contacts, has_dialogs, price, is_default) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'Базовый', 3, 100, 5000, 1, 990, 0);
    run('INSERT INTO tariff_plans (name, max_bots, max_broadcasts_per_month, max_contacts, has_dialogs, price, is_default) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'Бизнес', 5, 300, 15000, 1, 1990, 0);
    run('INSERT INTO tariff_plans (name, max_bots, max_broadcasts_per_month, max_contacts, has_dialogs, price, is_default) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'Профессиональный', 10, 500, 50000, 1, 3990, 0);
    commit();
  } catch (e) {
    rollback();
    throw e;
  }
}

// ============================================
// Миграция: шифрование существующих plaintext токенов
// ============================================
function encryptExistingTokens() {
  try {
    let count = 0;
    const tenants = all('SELECT id, leadteh_api_token FROM tenants WHERE leadteh_api_token != ?', '');
    for (const t of tenants) {
      if (!isEncrypted(t.leadteh_api_token)) {
        run('UPDATE tenants SET leadteh_api_token = ? WHERE id = ?', encrypt(t.leadteh_api_token), t.id);
        count++;
      }
    }
    const bots = all('SELECT id, token FROM bots');
    for (const b of bots) {
      if (!isEncrypted(b.token)) {
        run('UPDATE bots SET token = ? WHERE id = ?', encrypt(b.token), b.id);
        count++;
      }
    }
    if (count > 0) console.log(`[db] Миграция: зашифровано ${count} токенов`);
  } catch (e) {
    console.error('[db] Ошибка шифрования токенов:', e.message);
  }
}

// ============================================
// CRUD-хелперы
// ============================================

// --- Тенанты ---
function createTenant(telegramId, name, leadtehApiToken, status) {
  beginTransaction();
  try {
    const tenantStatus = status || 'active';
    const trialEndsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const result = run(
      'INSERT INTO tenants (telegram_id, name, leadteh_api_token, trial_ends_at, status) VALUES (?, ?, ?, ?, ?)',
      telegramId, name, leadtehApiToken ? encrypt(leadtehApiToken) : '', trialEndsAt, tenantStatus
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
  return decryptTenantRow(get('SELECT * FROM tenants WHERE telegram_id = ?', String(telegramId)));
}

function getTenantById(id) {
  return decryptTenantRow(get('SELECT * FROM tenants WHERE id = ?', id));
}

function getAllTenants() {
  const month = new Date().toISOString().slice(0, 7);
  const nextMonth = getNextMonth(month);
  return all(
    `SELECT t.*,
     COALESCE(t.custom_max_bots, 1) as effective_max_bots,
     COALESCE(t.custom_max_contacts, 100) as effective_max_contacts,
     COALESCE(t.custom_price, 0) as effective_price,
     (SELECT COUNT(*) FROM bots WHERE tenant_id = t.id) as bots_count,
     (SELECT COUNT(*) FROM broadcasts WHERE tenant_id = t.id) as broadcasts_count,
     (SELECT COUNT(DISTINCT telegram_id) FROM contact_sends_log WHERE tenant_id = t.id AND sent_at >= ? AND sent_at < ?) as unique_contacts
     FROM tenants t
     ORDER BY t.created_at DESC`,
    month + '-01', nextMonth + '-01'
  ).map(decryptTenantRow);
}

function updateTenant(id, fields) {
  if (fields.leadteh_api_token) fields = { ...fields, leadteh_api_token: encrypt(fields.leadteh_api_token) };
  const allowed = ['name', 'leadteh_api_token', 'tariff_plan_id', 'status', 'paid_until', 'trial_ends_at', 'custom_max_bots', 'custom_max_contacts', 'custom_price'];
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
  return all('SELECT * FROM bots WHERE tenant_id = ? AND is_active = 1 ORDER BY id', tenantId).map(decryptBotRow);
}

function getBotById(botId) {
  return decryptBotRow(get('SELECT * FROM bots WHERE id = ?', botId));
}

function getAllActiveBots() {
  return all('SELECT * FROM bots WHERE is_active = 1').map(decryptBotRow);
}

function createBot(tenantId, name, token, leadtehBotId, botUsername) {
  const result = run(
    'INSERT INTO bots (tenant_id, name, token, leadteh_bot_id, bot_username) VALUES (?, ?, ?, ?, ?)',
    tenantId, name, encrypt(token), leadtehBotId || '', botUsername || ''
  );
  return result.lastInsertRowid;
}

function updateBot(botId, fields) {
  if (fields.token) fields = { ...fields, token: encrypt(fields.token) };
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
        'INSERT INTO broadcast_messages (broadcast_id, sort_order, photo_url, text, buttons_json, parse_mode, delay_before) VALUES (?, ?, ?, ?, ?, ?, ?)',
        broadcast.id,
        i,
        msg.photo_url || '',
        msg.text || '',
        JSON.stringify(msg.buttons || []),
        msg.parse_mode || null,
        i === 0 ? 0 : (msg.delay_before || 0)
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
    delay_before: m.delay_before || 0,
  }));
  return b;
}

function listBroadcasts(tenantId) {
  const rows = all(
    `SELECT b.*, bt.name as bot_name
     FROM broadcasts b
     LEFT JOIN bots bt ON b.bot_id = bt.id
     WHERE b.tenant_id = ? AND b.status != 'deleted'
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
      delay_before: m.delay_before || 0,
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
  // pending — физическое удаление, sent/error — мягкое (сохраняет статистику)
  const b = get('SELECT status FROM broadcasts WHERE id = ? AND tenant_id = ?', broadcastId, tenantId);
  if (!b) return { changes: 0 };
  if (b.status === 'sending') return { changes: 0 };
  if (b.status === 'pending') {
    return run('DELETE FROM broadcasts WHERE id = ? AND tenant_id = ?', broadcastId, tenantId);
  }
  return run("UPDATE broadcasts SET status = 'deleted' WHERE id = ? AND tenant_id = ?", broadcastId, tenantId);
}

function getPendingBroadcasts() {
  const now = new Date().toISOString();
  const rows = all(
    `SELECT b.*, t.leadteh_api_token
     FROM broadcasts b
     JOIN tenants t ON b.tenant_id = t.id
     WHERE b.status = 'pending' AND b.scheduled_at <= ?
     AND t.status = 'active'
     AND (t.paid_until >= datetime('now') OR t.trial_ends_at >= datetime('now') OR COALESCE(t.custom_price, 0) = 0)`,
    now
  );

  return rows.map(b => {
    b.leadteh_api_token = decrypt(b.leadteh_api_token);
    b.filters = JSON.parse(b.filters_json);
    b.messages = all(
      'SELECT * FROM broadcast_messages WHERE broadcast_id = ? ORDER BY sort_order',
      b.id
    ).map(m => ({
      photo_url: m.photo_url,
      text: m.text,
      buttons: JSON.parse(m.buttons_json),
      parse_mode: m.parse_mode || null,
      delay_before: m.delay_before || 0,
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

function createTariffPlan(name, maxBots, maxBroadcasts, maxContacts, hasDialogs, price) {
  const result = run(
    'INSERT INTO tariff_plans (name, max_bots, max_broadcasts_per_month, max_contacts, has_dialogs, price) VALUES (?, ?, ?, ?, ?, ?)',
    name, maxBots, maxBroadcasts, maxContacts, hasDialogs ? 1 : 0, price || 0
  );
  return result.lastInsertRowid;
}

function updateTariffPlan(id, fields) {
  const allowed = ['name', 'max_bots', 'max_broadcasts_per_month', 'max_contacts', 'has_dialogs', 'price'];
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

// --- Ценообразование (pricing_config) ---
function getPricingConfig() {
  return get('SELECT * FROM pricing_config WHERE id = 1');
}

function updatePricingConfig(fields) {
  const allowed = ['free_bots', 'price_per_bot', 'free_contacts', 'price_per_100_contacts', 'max_bots', 'max_contacts'];
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
  run(`UPDATE pricing_config SET ${sets.join(', ')} WHERE id = 1`, ...values);
}

function calculatePrice(bots, contacts) {
  const cfg = getPricingConfig();
  const extraBots = Math.max(0, bots - cfg.free_bots);
  const extraContacts = Math.max(0, contacts - cfg.free_contacts);
  const botsCost = extraBots * cfg.price_per_bot;
  const contactsCost = Math.ceil(extraContacts / 100) * cfg.price_per_100_contacts;
  return {
    price: botsCost + contactsCost,
    breakdown: {
      bots,
      contacts,
      free_bots: cfg.free_bots,
      free_contacts: cfg.free_contacts,
      extra_bots: extraBots,
      extra_contacts_blocks: Math.ceil(extraContacts / 100),
      bots_cost: botsCost,
      contacts_cost: contactsCost,
      price_per_bot: cfg.price_per_bot,
      price_per_100_contacts: cfg.price_per_100_contacts,
    },
  };
}

// --- Платежи ---
function createPayment(tenantId, amount, period, bots, contacts) {
  const result = run(
    'INSERT INTO payments (tenant_id, amount, period, bots, contacts) VALUES (?, ?, ?, ?, ?)',
    tenantId, amount, period, bots, contacts
  );
  return result.lastInsertRowid;
}

function confirmPayment(paymentId) {
  const payment = get('SELECT * FROM payments WHERE id = ?', paymentId);
  if (!payment || payment.status !== 'pending') return null;

  beginTransaction();
  try {
    run("UPDATE payments SET status = 'paid', paid_at = datetime('now') WHERE id = ?", paymentId);

    // Применить тариф к тенанту
    const price = calculatePrice(payment.bots, payment.contacts).price;
    run(
      `UPDATE tenants SET custom_max_bots = ?, custom_max_contacts = ?, custom_price = ?, updated_at = datetime('now') WHERE id = ?`,
      payment.bots, payment.contacts, price, payment.tenant_id
    );

    // Продлить подписку
    const tenant = get('SELECT paid_until FROM tenants WHERE id = ?', payment.tenant_id);
    const now = new Date();
    const currentPaidUntil = tenant?.paid_until ? new Date(tenant.paid_until) : null;
    const baseDate = (currentPaidUntil && currentPaidUntil > now) ? currentPaidUntil : now;
    const newPaidUntil = new Date(baseDate);

    const periodMonths = { '1m': 1, '6m': 6, '12m': 12 };
    const months = periodMonths[payment.period] || 1;
    newPaidUntil.setMonth(newPaidUntil.getMonth() + months);

    run('UPDATE tenants SET paid_until = ? WHERE id = ?', newPaidUntil.toISOString(), payment.tenant_id);

    commit();
    return { ...payment, status: 'paid', paid_until: newPaidUntil.toISOString() };
  } catch (e) {
    rollback();
    throw e;
  }
}

function getPayments(tenantId) {
  return all('SELECT * FROM payments WHERE tenant_id = ? ORDER BY created_at DESC', tenantId);
}

function getAllPayments() {
  return all(
    `SELECT p.*, t.name as tenant_name, t.telegram_id as tenant_telegram_id
     FROM payments p
     JOIN tenants t ON p.tenant_id = t.id
     ORDER BY p.created_at DESC`
  );
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

function logContactSend(tenantId, telegramId, sourceType, sourceId) {
  run(
    'INSERT INTO contact_sends_log (tenant_id, telegram_id, source_type, source_id, sent_at) VALUES (?, ?, ?, ?, datetime(\'now\'))',
    tenantId, String(telegramId), sourceType || 'broadcast', sourceId || ''
  );
}

function getUniqueContactsCount(tenantId, month) {
  if (!month) month = new Date().toISOString().slice(0, 7);
  const nextMonth = getNextMonth(month);
  const row = get(
    `SELECT COUNT(DISTINCT telegram_id) as cnt FROM contact_sends_log
     WHERE tenant_id = ? AND sent_at >= ? AND sent_at < ?`,
    tenantId, month + '-01', nextMonth + '-01'
  );
  return row ? row.cnt : 0;
}

function getNextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  if (m === 12) return `${y + 1}-01`;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

function checkTariffLimits(tenantId) {
  const tenant = get('SELECT * FROM tenants WHERE id = ?', tenantId);

  if (!tenant) return { allowed: false, reason: 'Тенант не найден' };

  const maxBots = tenant.custom_max_bots != null ? tenant.custom_max_bots : 1;
  const maxContacts = tenant.custom_max_contacts != null ? tenant.custom_max_contacts : 100;

  const month = new Date().toISOString().slice(0, 7);
  const uniqueContacts = getUniqueContactsCount(tenantId, month);
  const botsCount = get(
    'SELECT COUNT(*) as cnt FROM bots WHERE tenant_id = ? AND is_active = 1',
    tenantId
  ).cnt;

  if (uniqueContacts >= maxContacts) {
    return { allowed: false, reason: `Лимит контактов в месяц исчерпан (${uniqueContacts}/${maxContacts})` };
  }

  return {
    allowed: true,
    limits: {
      max_bots: maxBots,
      max_contacts: maxContacts,
      current_bots: botsCount,
      current_contacts: uniqueContacts,
    },
  };
}

function checkBotLimit(tenantId) {
  const tenant = get('SELECT * FROM tenants WHERE id = ?', tenantId);
  if (!tenant) return { allowed: true };

  const maxBots = tenant.custom_max_bots != null ? tenant.custom_max_bots : 1;

  const botsCount = get(
    'SELECT COUNT(*) as cnt FROM bots WHERE tenant_id = ? AND is_active = 1',
    tenantId
  ).cnt;

  if (botsCount >= maxBots) {
    return { allowed: false, reason: `Лимит ботов исчерпан (${botsCount}/${maxBots})` };
  }
  return { allowed: true };
}

function hasDialogsAccess(tenantId) {
  // Диалоги включены для всех тенантов
  return true;
}

// --- Подписка ---
function checkSubscription(tenantId) {
  const tenant = get('SELECT * FROM tenants WHERE id = ?', tenantId);
  if (!tenant) return { canBroadcast: false, status: 'unknown' };

  const price = tenant.custom_price != null ? tenant.custom_price : 0;

  // Бесплатный тариф (price=0) — подписка не требуется
  if (price === 0) {
    return { canBroadcast: true, status: 'free' };
  }

  const now = new Date();
  const paidUntil = tenant.paid_until ? new Date(tenant.paid_until) : null;
  const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;

  if (paidUntil && paidUntil > now) {
    return { canBroadcast: true, status: 'paid', paidUntil: tenant.paid_until };
  }
  if (trialEndsAt && trialEndsAt > now) {
    const trialDaysLeft = Math.ceil((trialEndsAt - now) / (24 * 60 * 60 * 1000));
    return { canBroadcast: true, status: 'trial', trialDaysLeft, trialEndsAt: tenant.trial_ends_at };
  }
  // Оба истекли
  return { canBroadcast: false, status: trialEndsAt ? 'trial_expired' : 'no_subscription', trialEndsAt: tenant.trial_ends_at, paidUntil: tenant.paid_until };
}

function getExpiringTrials() {
  // Тенанты, у которых trial истекает в ближайшие 24 часа и нет оплаты
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  return all(
    `SELECT id, name, telegram_id, trial_ends_at FROM tenants
     WHERE trial_ends_at IS NOT NULL AND trial_ends_at > ? AND trial_ends_at <= ?
     AND (paid_until IS NULL OR paid_until < ?)`,
    now, tomorrow, now
  );
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

// --- Авторассылки ---
function saveAutoBroadcast(tenantId, data) {
  beginTransaction();
  try {
    run(
      `INSERT INTO auto_broadcasts (id, tenant_id, bot_id, name, type, filters_json, schedule_json, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.id,
      tenantId,
      data.bot_id || null,
      data.name || '',
      data.type || 'chain',
      JSON.stringify(data.filters || {}),
      JSON.stringify(data.schedule || {}),
      data.status || 'active',
      data.created_by || ''
    );

    for (let si = 0; si < (data.steps || []).length; si++) {
      const step = data.steps[si];
      const stepResult = run(
        `INSERT INTO auto_broadcast_steps (auto_broadcast_id, step_order, delay_value, delay_unit, message_delay)
         VALUES (?, ?, ?, ?, ?)`,
        data.id,
        si,
        step.delay_value || 0,
        step.delay_unit || 'hours',
        step.message_delay || 0
      );
      const stepId = stepResult.lastInsertRowid;

      for (let mi = 0; mi < (step.messages || []).length; mi++) {
        const msg = step.messages[mi];
        run(
          `INSERT INTO auto_broadcast_messages (step_id, sort_order, photo_url, text, buttons_json, parse_mode)
           VALUES (?, ?, ?, ?, ?, ?)`,
          stepId,
          mi,
          msg.photo_url || '',
          msg.text || '',
          JSON.stringify(msg.buttons || []),
          msg.parse_mode || null
        );
      }
    }

    commit();
    return data.id;
  } catch (e) {
    rollback();
    throw e;
  }
}

function getAutoBroadcast(id, tenantId) {
  const ab = tenantId
    ? get('SELECT * FROM auto_broadcasts WHERE id = ? AND tenant_id = ?', id, tenantId)
    : get('SELECT * FROM auto_broadcasts WHERE id = ?', id);
  if (!ab) return null;

  ab.filters = JSON.parse(ab.filters_json);
  ab.schedule = JSON.parse(ab.schedule_json);

  const steps = all(
    'SELECT * FROM auto_broadcast_steps WHERE auto_broadcast_id = ? ORDER BY step_order',
    id
  );

  ab.steps = steps.map(s => {
    const msgs = all(
      'SELECT * FROM auto_broadcast_messages WHERE step_id = ? ORDER BY sort_order',
      s.id
    ).map(m => ({
      photo_url: m.photo_url,
      text: m.text,
      buttons: JSON.parse(m.buttons_json),
      parse_mode: m.parse_mode || null,
    }));
    return {
      id: s.id,
      step_order: s.step_order,
      delay_value: s.delay_value,
      delay_unit: s.delay_unit,
      message_delay: s.message_delay,
      messages: msgs,
    };
  });

  return ab;
}

function listAutoBroadcasts(tenantId) {
  const rows = all(
    `SELECT ab.*, bt.name as bot_name,
     (SELECT COUNT(*) FROM auto_broadcast_steps WHERE auto_broadcast_id = ab.id) as steps_count,
     (SELECT COUNT(*) FROM auto_broadcast_runs WHERE auto_broadcast_id = ab.id AND status = 'running') as active_runs,
     (SELECT COUNT(*) FROM auto_broadcast_enrollments WHERE auto_broadcast_id = ab.id) as enrolled_total,
     (SELECT COUNT(*) FROM auto_broadcast_enrollments WHERE auto_broadcast_id = ab.id AND status = 'active') as enrolled_active,
     (SELECT COUNT(*) FROM auto_broadcast_enrollments WHERE auto_broadcast_id = ab.id AND status = 'completed') as enrolled_completed
     FROM auto_broadcasts ab
     LEFT JOIN bots bt ON ab.bot_id = bt.id
     WHERE ab.tenant_id = ?
     ORDER BY ab.created_at DESC`,
    tenantId
  );

  return rows.map(r => {
    r.filters = JSON.parse(r.filters_json);
    r.schedule = JSON.parse(r.schedule_json);
    return r;
  });
}

function updateAutoBroadcastStatus(id, status) {
  run('UPDATE auto_broadcasts SET status = ? WHERE id = ?', status, id);
}

function deleteAutoBroadcast(id, tenantId) {
  return run('DELETE FROM auto_broadcasts WHERE id = ? AND tenant_id = ?', id, tenantId);
}

function createAutoRun(autoBroadcastId, nextStepAt) {
  const result = run(
    `INSERT INTO auto_broadcast_runs (auto_broadcast_id, current_step, next_step_at, status)
     VALUES (?, ?, ?, 'running')`,
    autoBroadcastId,
    0,
    nextStepAt || null
  );
  return result.lastInsertRowid;
}

function getActiveRuns() {
  const now = new Date().toISOString();
  return all(
    `SELECT r.*, ab.tenant_id, ab.bot_id, ab.filters_json, ab.type
     FROM auto_broadcast_runs r
     JOIN auto_broadcasts ab ON r.auto_broadcast_id = ab.id
     JOIN tenants t ON ab.tenant_id = t.id
     WHERE r.status = 'running' AND r.next_step_at IS NOT NULL AND r.next_step_at <= ?
     AND (t.paid_until >= datetime('now') OR t.trial_ends_at >= datetime('now') OR COALESCE(t.custom_price, 0) = 0)`,
    now
  );
}

function getRecurringDue() {
  return all(
    `SELECT ab.*
     FROM auto_broadcasts ab
     JOIN tenants t ON ab.tenant_id = t.id
     WHERE ab.type = 'recurring' AND ab.status = 'active'
     AND (t.paid_until >= datetime('now') OR t.trial_ends_at >= datetime('now') OR COALESCE(t.custom_price, 0) = 0)`
  );
}

function hasRunToday(autoBroadcastId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = get(
    `SELECT COUNT(*) as cnt FROM auto_broadcast_runs
     WHERE auto_broadcast_id = ? AND started_at >= ? || 'T00:00:00'`,
    autoBroadcastId, today
  );
  return row && row.cnt > 0;
}

function updateAutoRun(runId, fields) {
  const allowed = ['current_step', 'next_step_at', 'status', 'error', 'completed_at'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return;
  values.push(runId);
  run(`UPDATE auto_broadcast_runs SET ${sets.join(', ')} WHERE id = ?`, ...values);
}

// --- Enrollments для цепочек (per-contact) ---
function enrollContact(autoBroadcastId, contactTelegramId, nextStepAt) {
  try {
    run(
      `INSERT OR IGNORE INTO auto_broadcast_enrollments (auto_broadcast_id, contact_telegram_id, current_step, next_step_at, status)
       VALUES (?, ?, 0, ?, 'active')`,
      autoBroadcastId, String(contactTelegramId), nextStepAt || null
    );
    return true;
  } catch (e) {
    return false; // уже enrolled
  }
}

function getEnrolledContactIds(autoBroadcastId) {
  const rows = all(
    `SELECT contact_telegram_id FROM auto_broadcast_enrollments WHERE auto_broadcast_id = ?`,
    autoBroadcastId
  );
  return new Set(rows.map(r => r.contact_telegram_id));
}

function getDueEnrollments() {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  return all(
    `SELECT e.*, ab.tenant_id, ab.bot_id, ab.filters_json
     FROM auto_broadcast_enrollments e
     JOIN auto_broadcasts ab ON e.auto_broadcast_id = ab.id
     JOIN tenants t ON ab.tenant_id = t.id
     WHERE e.status = 'active' AND e.next_step_at IS NOT NULL AND e.next_step_at <= ?
     AND ab.status = 'active'
     AND (t.paid_until >= datetime('now') OR t.trial_ends_at >= datetime('now') OR COALESCE(t.custom_price, 0) = 0)`,
    now
  );
}

function updateEnrollment(enrollmentId, fields) {
  const sets = [];
  const values = [];
  if (fields.current_step !== undefined) { sets.push('current_step = ?'); values.push(fields.current_step); }
  if (fields.next_step_at !== undefined) { sets.push('next_step_at = ?'); values.push(fields.next_step_at); }
  if (fields.status) { sets.push('status = ?'); values.push(fields.status); }
  if (sets.length === 0) return;
  values.push(enrollmentId);
  run(`UPDATE auto_broadcast_enrollments SET ${sets.join(', ')} WHERE id = ?`, ...values);
}

function getEnrollmentStats(autoBroadcastId) {
  return {
    total: get('SELECT COUNT(*) as cnt FROM auto_broadcast_enrollments WHERE auto_broadcast_id = ?', autoBroadcastId).cnt,
    active: get("SELECT COUNT(*) as cnt FROM auto_broadcast_enrollments WHERE auto_broadcast_id = ? AND status = 'active'", autoBroadcastId).cnt,
    completed: get("SELECT COUNT(*) as cnt FROM auto_broadcast_enrollments WHERE auto_broadcast_id = ? AND status = 'completed'", autoBroadcastId).cnt,
  };
}

function getActiveChains() {
  return all(
    `SELECT ab.* FROM auto_broadcasts ab
     JOIN tenants t ON ab.tenant_id = t.id
     WHERE ab.type = 'chain' AND ab.status = 'active'
     AND (t.paid_until >= datetime('now') OR t.trial_ends_at >= datetime('now') OR COALESCE(t.custom_price, 0) = 0)`
  );
}

// --- Чаты (диалоги) ---
function findOrCreateChat(tenantId, botId, contactTelegramId, contactName) {
  const existing = get(
    'SELECT * FROM chats WHERE bot_id = ? AND contact_telegram_id = ?',
    botId, String(contactTelegramId)
  );
  if (existing) return existing;

  const result = run(
    'INSERT INTO chats (tenant_id, bot_id, contact_telegram_id, contact_name) VALUES (?, ?, ?, ?)',
    tenantId, botId, String(contactTelegramId), contactName || ''
  );
  return get('SELECT * FROM chats WHERE id = ?', result.lastInsertRowid);
}

function getChatsByTenant(tenantId) {
  return all(
    `SELECT c.*, b.name as bot_name,
       (SELECT cm.text FROM chat_messages cm WHERE cm.chat_id = c.id ORDER BY cm.id DESC LIMIT 1) as last_message_text,
       (SELECT cm.direction FROM chat_messages cm WHERE cm.chat_id = c.id ORDER BY cm.id DESC LIMIT 1) as last_message_direction
     FROM chats c
     LEFT JOIN bots b ON c.bot_id = b.id
     WHERE c.tenant_id = ?
     ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC`,
    tenantId
  );
}

function getChatMessages(chatId, afterId, limit) {
  if (afterId) {
    return all(
      'SELECT * FROM chat_messages WHERE chat_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
      chatId, afterId, limit || 100
    );
  }
  return all(
    'SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY id ASC LIMIT ?',
    chatId, limit || 200
  );
}

function addChatMessage(chatId, direction, text) {
  const now = new Date().toISOString();
  const result = run(
    'INSERT INTO chat_messages (chat_id, direction, text, created_at) VALUES (?, ?, ?, ?)',
    chatId, direction, text, now
  );
  run('UPDATE chats SET last_message_at = ? WHERE id = ?', now, chatId);
  if (direction === 'incoming') {
    run('UPDATE chats SET unread_count = unread_count + 1 WHERE id = ?', chatId);
  }
  return get('SELECT * FROM chat_messages WHERE id = ?', result.lastInsertRowid);
}

function markChatRead(chatId) {
  run('UPDATE chats SET unread_count = 0 WHERE id = ?', chatId);
}

function getChatById(chatId) {
  return get('SELECT * FROM chats WHERE id = ?', chatId);
}

function getChatByBotAndContact(botId, contactTelegramId) {
  return get(
    'SELECT * FROM chats WHERE bot_id = ? AND contact_telegram_id = ?',
    botId, String(contactTelegramId)
  );
}

// --- Агрегированная статистика для суперадмина ---
function getSuperStats() {
  const stats = {
    total_tenants: get('SELECT COUNT(*) as cnt FROM tenants').cnt,
    active_tenants: get("SELECT COUNT(*) as cnt FROM tenants WHERE status = 'active'").cnt,
    total_bots: get('SELECT COUNT(*) as cnt FROM bots WHERE is_active = 1').cnt,
    total_broadcasts: get("SELECT COUNT(*) as cnt FROM broadcasts WHERE status != 'deleted'").cnt,
    sent_broadcasts: get("SELECT COUNT(*) as cnt FROM broadcasts WHERE status = 'sent'").cnt,
    month: new Date().toISOString().slice(0, 7),
  };
  stats.month_broadcasts = get(
    "SELECT COUNT(*) as cnt FROM broadcasts WHERE created_at >= ? || '-01' AND status != 'deleted'",
    stats.month
  ).cnt;
  return stats;
}

// --- Пользователи платформенного бота ---
function savePlatformBotUser(telegramId, firstName, lastName, username) {
  run(
    `INSERT INTO platform_bot_users (telegram_id, first_name, last_name, username)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET first_name = ?, last_name = ?, username = ?`,
    String(telegramId), firstName || '', lastName || '', username || '',
    firstName || '', lastName || '', username || ''
  );
}

function getPlatformBotUsers() {
  return all('SELECT * FROM platform_bot_users ORDER BY started_at DESC');
}

function updatePaymentExternal(paymentId, { external_id, payment_url, provider }) {
  run(
    'UPDATE payments SET external_id = ?, payment_url = ?, provider = ? WHERE id = ?',
    external_id || null, payment_url || null, provider || '', paymentId
  );
}

function findPaymentByExternalId(externalId) {
  return get('SELECT * FROM payments WHERE external_id = ?', externalId);
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
  getAllActiveBots,
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
  // Тарифы (legacy)
  getTariffPlans,
  getTariffPlan,
  createTariffPlan,
  updateTariffPlan,
  // Ценообразование
  getPricingConfig,
  updatePricingConfig,
  calculatePrice,
  // Платежи
  createPayment,
  confirmPayment,
  getPayments,
  getAllPayments,
  updatePaymentExternal,
  findPaymentByExternalId,
  // Использование
  incrementUsage,
  getUsage,
  checkTariffLimits,
  checkBotLimit,
  hasDialogsAccess,
  logContactSend,
  getUniqueContactsCount,
  // Подписка
  checkSubscription,
  getExpiringTrials,
  // Bot-lists
  getBotListMappings,
  setBotListMappings,
  // Результаты доставки
  saveBroadcastRecipient,
  getBroadcastRecipients,
  // Статистика
  getSuperStats,
  // Авторассылки
  saveAutoBroadcast,
  getAutoBroadcast,
  listAutoBroadcasts,
  updateAutoBroadcastStatus,
  deleteAutoBroadcast,
  createAutoRun,
  getActiveRuns,
  getRecurringDue,
  hasRunToday,
  updateAutoRun,
  // Enrollments (цепочки per-contact)
  enrollContact,
  getEnrolledContactIds,
  getDueEnrollments,
  updateEnrollment,
  getEnrollmentStats,
  getActiveChains,
  // Чаты (диалоги)
  findOrCreateChat,
  getChatsByTenant,
  getChatMessages,
  addChatMessage,
  markChatRead,
  getChatById,
  getChatByBotAndContact,
  // Пользователи платформенного бота
  savePlatformBotUser,
  getPlatformBotUsers,
};
