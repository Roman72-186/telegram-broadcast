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

  const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    leadtehApiToken: process.env.LEADTEH_API_TOKEN || '',
    leadtehBotId: process.env.LEADTEH_BOT_ID || '257034',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    cronSecret: process.env.CRON_SECRET || '',
  };

  // Проверка обязательных переменных
  const missing = [];
  if (!config.leadtehApiToken) missing.push('LEADTEH_API_TOKEN');
  if (!config.telegramBotToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (config.adminTelegramIds.length === 0) missing.push('ADMIN_TELEGRAM_IDS');

  if (missing.length > 0) {
    console.warn(`⚠ Не заданы переменные: ${missing.join(', ')}`);
    console.warn('  Создайте файл .env (см. .env.example)');
  }

  return config;
}

module.exports = { loadConfig };
