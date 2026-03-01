#!/usr/bin/env node
// migrate.js — Одноразовая миграция из .env/JSON в SQLite
//
// Использование:
//   node migrate.js
//
// Что делает:
//   1. Читает текущий .env (LEADTEH_API_TOKEN, боты, админы)
//   2. Создаёт тенанта из первого ADMIN_TELEGRAM_IDS
//   3. Мигрирует ботов из .env в таблицу bots
//   4. Мигрирует рассылки из data/broadcasts.json в SQLite
//   5. Мигрирует bot-lists.json в bot_list_mappings
//   6. Создаёт новый .env с PLATFORM_BOT_TOKEN

const fs = require('fs');
const path = require('path');

// Загружаем .env до инициализации db (чтобы config.js не жаловался на отсутствие PLATFORM_BOT_TOKEN)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

const db = require('./lib/db');

async function migrate() {
await db.initDb();
console.log('=== Миграция в SQLite ===\n');

// Шаг 1: Читаем старый конфиг
const leadtehApiToken = process.env.LEADTEH_API_TOKEN || '';
const cronSecret = process.env.CRON_SECRET || '';
const port = process.env.PORT || '3000';
const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// Парсим ботов
const oldBots = [];
for (let i = 1; i <= 10; i++) {
  const token = process.env[`BOT_${i}_TOKEN`];
  if (!token) continue;
  oldBots.push({
    name: process.env[`BOT_${i}_NAME`] || `Бот ${i}`,
    token,
    leadtehBotId: process.env[`BOT_${i}_LEADTEH_ID`] || '',
  });
}

// Обратная совместимость
if (oldBots.length === 0 && process.env.TELEGRAM_BOT_TOKEN) {
  oldBots.push({
    name: process.env.BOT_1_NAME || 'Основной бот',
    token: process.env.TELEGRAM_BOT_TOKEN,
    leadtehBotId: process.env.LEADTEH_BOT_ID || '257034',
  });
}

console.log(`Leadteh API Token: ${leadtehApiToken ? 'есть' : 'НЕТ'}`);
console.log(`Админы: ${adminIds.join(', ') || '(нет)'}`);
console.log(`Боты: ${oldBots.length}`);

if (adminIds.length === 0) {
  console.error('\n❌ ADMIN_TELEGRAM_IDS не задан в .env — невозможно создать тенанта');
  process.exit(1);
}

// Шаг 2: Создаём тенанта
const ownerTgId = adminIds[0];

// Проверяем не существует ли уже
const existing = db.getTenantByTelegramId(ownerTgId);
if (existing) {
  console.log(`\nТенант с telegram_id ${ownerTgId} уже существует (id=${existing.id}). Пропускаем создание.`);
} else {
  const tenantId = db.createTenant(ownerTgId, 'Главный аккаунт', leadtehApiToken);
  console.log(`\n✅ Создан тенант id=${tenantId} (telegram_id=${ownerTgId})`);

  // Добавляем остальных админов
  for (let i = 1; i < adminIds.length; i++) {
    db.addTenantAdmin(tenantId, adminIds[i]);
    console.log(`  + Админ: ${adminIds[i]}`);
  }
}

const tenant = db.getTenantByTelegramId(ownerTgId);
const tenantId = tenant.id;

// Шаг 3: Мигрируем ботов
const existingBots = db.getBotsByTenant(tenantId);
if (existingBots.length > 0) {
  console.log(`\nБоты уже существуют (${existingBots.length}). Пропускаем.`);
} else {
  const botIdMap = {}; // oldId -> newId
  for (let i = 0; i < oldBots.length; i++) {
    const bot = oldBots[i];
    const newBotId = db.createBot(tenantId, bot.name, bot.token, bot.leadtehBotId, '');
    botIdMap[String(i + 1)] = newBotId;
    console.log(`✅ Бот "${bot.name}" мигрирован (id=${newBotId})`);
  }

  // Шаг 4: Мигрируем рассылки из broadcasts.json
  const broadcastsPath = path.join(__dirname, 'data', 'broadcasts.json');
  if (fs.existsSync(broadcastsPath)) {
    try {
      const broadcasts = JSON.parse(fs.readFileSync(broadcastsPath, 'utf-8'));
      let count = 0;
      for (const b of broadcasts) {
        // Маппим старый bot_id на новый
        const newBotId = botIdMap[b.bot_id] || (existingBots[0]?.id) || null;

        // Нормализуем сообщения
        let msgs;
        if (Array.isArray(b.messages) && b.messages.length > 0) {
          msgs = b.messages;
        } else {
          msgs = [{ photo_url: '', text: b.text || '', buttons: b.buttons || [] }];
        }

        const broadcast = {
          id: b.id,
          name: b.name || '',
          parse_mode: b.parse_mode || null,
          messages: msgs,
          filters: b.filters || {},
          bot_id: newBotId,
          scheduled_at: b.scheduled_at || b.created_at,
          created_by: b.created_by || ownerTgId,
        };

        try {
          db.saveBroadcast(tenantId, broadcast);

          // Обновляем статус если уже отправлена
          if (b.status && b.status !== 'pending') {
            db.updateBroadcastStatus(b.id, {
              status: b.status,
              sent_count: b.sent_count || 0,
              failed_count: b.failed_count || 0,
              total_recipients: b.total_recipients || 0,
              error: b.error || null,
              sent_at: b.sent_at || null,
            });
          }
          count++;
        } catch (e) {
          console.error(`  Ошибка миграции рассылки ${b.id}: ${e.message}`);
        }
      }
      console.log(`✅ Мигрировано ${count} рассылок из broadcasts.json`);
    } catch (e) {
      console.error(`Ошибка чтения broadcasts.json: ${e.message}`);
    }
  } else {
    console.log('broadcasts.json не найден — пропускаем');
  }

  // Шаг 5: Мигрируем bot-lists.json
  const botListsPath = path.join(__dirname, 'data', 'bot-lists.json');
  if (fs.existsSync(botListsPath)) {
    try {
      const mapping = JSON.parse(fs.readFileSync(botListsPath, 'utf-8'));
      for (const [oldBotId, schemaIds] of Object.entries(mapping)) {
        const newBotId = botIdMap[oldBotId];
        if (newBotId && Array.isArray(schemaIds)) {
          db.setBotListMappings(newBotId, schemaIds);
          console.log(`✅ Привязка списков для бота ${oldBotId} → ${newBotId}`);
        }
      }
    } catch (e) {
      console.error(`Ошибка чтения bot-lists.json: ${e.message}`);
    }
  }
}

// Шаг 6: Создаём новый .env
const platformBotToken = oldBots.length > 0 ? oldBots[0].token : '';

const newEnvContent = `# SaaS Platform Configuration
# Сгенерировано миграцией ${new Date().toISOString()}

PORT=${port}
CRON_SECRET=${cronSecret}

# Токен платформенного бота (для валидации initData)
# Это бот, через который все пользователи открывают Mini App
PLATFORM_BOT_TOKEN=${platformBotToken}
`;

// Бэкап старого .env
if (fs.existsSync(envPath)) {
  const backupPath = envPath + '.pre-migration.' + Date.now();
  fs.copyFileSync(envPath, backupPath);
  console.log(`\n📋 Бэкап .env → ${path.basename(backupPath)}`);
}

fs.writeFileSync(envPath, newEnvContent, 'utf-8');
console.log('✅ Новый .env создан');

console.log('\n=== Миграция завершена ===');
console.log(`\nВажно:`);
console.log(`  1. PLATFORM_BOT_TOKEN = токен бота, через который пользователи открывают Mini App`);
console.log(`     Сейчас установлен токен первого бота. Если платформенный бот другой — обновите .env`);
console.log(`  2. Данные в SQLite: data/broadcast.db`);
console.log(`  3. Суперадмин: telegram_id 5444227047`);
console.log(`  4. Запуск: npm install && node server.js`);
}

migrate().catch(e => {
  console.error('Ошибка миграции:', e);
  process.exit(1);
});
