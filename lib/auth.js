// lib/auth.js — Валидация Telegram initData и управление сессиями
const crypto = require('crypto');
const { loadConfig } = require('./config');

const _config = loadConfig();
const SUPER_ADMIN_ID = _config.superAdminId;

/**
 * Валидация Telegram WebApp initData (HMAC-SHA-256)
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * @param {string} initData — строка initData из Telegram.WebApp.initData
 * @param {string} botToken — токен платформенного бота (PLATFORM_BOT_TOKEN)
 * @returns {{ valid: boolean, user?: object, error?: string }}
 */
function validateInitData(initData, botToken) {
  if (!initData || !botToken) {
    return { valid: false, error: 'initData или botToken не указаны' };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) {
      return { valid: false, error: 'hash отсутствует в initData' };
    }

    // Собираем data-check-string: все параметры кроме hash, отсортированные по алфавиту
    params.delete('hash');
    const entries = [...params.entries()];
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    // secret_key = HMAC-SHA-256("WebAppData", bot_token)
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    // calculated_hash = HMAC-SHA-256(secret_key, data_check_string)
    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    // Timing-safe comparison to prevent timing attacks
    const calcBuf = Buffer.from(calculatedHash, 'hex');
    const hashBuf = Buffer.from(hash, 'hex');
    if (calcBuf.length !== hashBuf.length || !crypto.timingSafeEqual(calcBuf, hashBuf)) {
      return { valid: false, error: 'Невалидная подпись initData' };
    }

    // Проверяем auth_date (не старше 24 часов)
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 86400) {
      return { valid: false, error: 'initData устарела (старше 24ч)' };
    }

    // Извлекаем данные пользователя
    const userStr = params.get('user');
    if (!userStr) {
      return { valid: false, error: 'user отсутствует в initData' };
    }

    const user = JSON.parse(userStr);
    return { valid: true, user };
  } catch (e) {
    return { valid: false, error: 'Ошибка валидации initData: ' + e.message };
  }
}

/**
 * Проверяет, является ли telegram_id суперадмином
 */
function isSuperAdmin(telegramId) {
  return String(telegramId) === SUPER_ADMIN_ID;
}

/**
 * Определяет роль пользователя в системе
 * @param {string} telegramId
 * @param {object} db — объект с функциями из lib/db.js
 * @returns {{ role: string, tenantId: number|null }}
 *   role: 'super_admin' | 'owner' | 'admin' | 'none'
 */
function getUserRole(telegramId, dbFunctions) {
  if (isSuperAdmin(telegramId)) {
    return { role: 'super_admin', tenantId: null };
  }

  const tenantInfo = dbFunctions.findTenantByAdmin(String(telegramId));
  if (tenantInfo) {
    if (tenantInfo.status === 'active') {
      return { role: tenantInfo.role, tenantId: tenantInfo.tenant_id };
    }
    // Тенант существует, но не active (blocked, pending_payment, etc.)
    return { role: 'none', tenantId: null, reason: tenantInfo.status };
  }

  // Не найден ни в tenant_admins, ни в tenants
  return { role: 'none', tenantId: null, reason: 'not_registered' };
}

module.exports = {
  validateInitData,
  isSuperAdmin,
  getUserRole,
  SUPER_ADMIN_ID,
};
