// lib/config.js — Загрузка конфигурации платформы из .env
const fs = require('fs');
const path = require('path');

function loadConfig() {
  // Загружаем .env если есть
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
    platformBotToken: process.env.PLATFORM_BOT_TOKEN || '',
    cronSecret: process.env.CRON_SECRET || '',
  };

  // Проверка обязательных переменных
  if (!config.platformBotToken) {
    console.warn('⚠ PLATFORM_BOT_TOKEN не задан в .env — авторизация невозможна');
  }

  return config;
}

module.exports = { loadConfig };
