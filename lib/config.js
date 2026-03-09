// lib/config.js — Загрузка конфигурации платформы из .env
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

  // Автогенерация ENCRYPTION_KEY если не задан
  if (!process.env.ENCRYPTION_KEY) {
    const newKey = crypto.randomBytes(32).toString('hex');
    process.env.ENCRYPTION_KEY = newKey;
    console.warn('[config] ENCRYPTION_KEY не задан — сгенерирован автоматически');
    console.warn('[config] ВАЖНО: сохраните ключ! Без него зашифрованные данные будут потеряны');
    try {
      const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
      const nl = envContent.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(envPath, `${nl}ENCRYPTION_KEY=${newKey}\n`);
      console.log('[config] ENCRYPTION_KEY добавлен в .env');
    } catch (e) {
      console.error('[config] Не удалось записать ENCRYPTION_KEY в .env:', e.message);
      console.error('[config] Добавьте вручную: ENCRYPTION_KEY=' + newKey);
    }
  }

  const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    platformBotToken: process.env.PLATFORM_BOT_TOKEN || '',
    cronSecret: process.env.CRON_SECRET || '',
    superAdminId: process.env.SUPER_ADMIN_ID || '',
    // Платёжный шлюз
    paymentProvider: (process.env.PAYMENT_PROVIDER || '').toLowerCase(),
    baseUrl: (process.env.BASE_URL || '').replace(/\/+$/, ''),
    // ТБанк
    tbankTerminalKey: process.env.TBANK_TERMINAL_KEY || '',
    tbankPassword: process.env.TBANK_PASSWORD || '',
    tbankTestMode: process.env.TBANK_TEST_MODE !== 'false',
    // Робокасса
    robokassaLogin: process.env.ROBOKASSA_LOGIN || '',
    robokassaPassword1: process.env.ROBOKASSA_PASSWORD1 || '',
    robokassaPassword2: process.env.ROBOKASSA_PASSWORD2 || '',
    robokassaTestMode: process.env.ROBOKASSA_TEST_MODE !== 'false',
  };

  // Проверка обязательных переменных
  if (!config.platformBotToken) {
    console.warn('PLATFORM_BOT_TOKEN не задан в .env — авторизация невозможна');
  }
  if (!config.superAdminId) {
    console.warn('SUPER_ADMIN_ID не задан в .env — суперадмин не настроен');
  }

  return config;
}

module.exports = { loadConfig };
