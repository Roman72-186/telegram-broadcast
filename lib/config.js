// lib/config.js — Загрузка конфигурации из .env файла или переменных окружения
const fs = require('fs');
const path = require('path');

function loadConfig() {
  // Загружаем .env если есть (без внешних зависимостей)
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  // Парсинг мультибот конфига: BOT_1_TOKEN .. BOT_10_TOKEN
  const bots = [];
  for (let i = 1; i <= 10; i++) {
    const token = process.env[`BOT_${i}_TOKEN`];
    if (!token) continue;
    bots.push({
      id: String(i),
      name: process.env[`BOT_${i}_NAME`] || `Бот ${i}`,
      token,
      leadtehBotId: process.env[`BOT_${i}_LEADTEH_ID`] || '',
    });
  }

  // Обратная совместимость: если BOT_1_* не задан, используем старые переменные
  if (bots.length === 0 && process.env.TELEGRAM_BOT_TOKEN) {
    bots.push({
      id: '1',
      name: process.env.BOT_1_NAME || 'Основной бот',
      token: process.env.TELEGRAM_BOT_TOKEN,
      leadtehBotId: process.env.LEADTEH_BOT_ID || '257034',
    });
  }

  const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    leadtehApiToken: process.env.LEADTEH_API_TOKEN || '',
    // Для обратной совместимости — значения первого бота
    leadtehBotId: bots.length > 0 ? bots[0].leadtehBotId : (process.env.LEADTEH_BOT_ID || '257034'),
    telegramBotToken: bots.length > 0 ? bots[0].token : (process.env.TELEGRAM_BOT_TOKEN || ''),
    adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    cronSecret: process.env.CRON_SECRET || '',
    bots,
  };

  // Проверка обязательных переменных
  const missing = [];
  if (!config.leadtehApiToken) missing.push('LEADTEH_API_TOKEN');
  if (bots.length === 0) missing.push('TELEGRAM_BOT_TOKEN (или BOT_1_TOKEN)');
  if (config.adminTelegramIds.length === 0) missing.push('ADMIN_TELEGRAM_IDS');

  if (missing.length > 0) {
    console.warn(`⚠ Не заданы переменные: ${missing.join(', ')}`);
    console.warn('  Создайте файл .env (см. .env.example)');
  }

  return config;
}

function getBotById(config, botId) {
  if (!botId) return config.bots[0] || null;
  return config.bots.find((b) => b.id === String(botId)) || config.bots[0] || null;
}

module.exports = { loadConfig, getBotById };
