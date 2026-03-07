// lib/middleware.js — Express middleware для авторизации
const { getSession } = require('./db');
const { isSuperAdmin } = require('./auth');

/**
 * Auth middleware — проверяет Bearer token, устанавливает req.tenantId, req.telegramId, req.role
 * Пропускает только валидные сессии.
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  const token = authHeader.slice(7);
  const session = getSession(token);

  if (!session) {
    return res.status(401).json({ error: 'Сессия истекла или невалидна' });
  }

  req.sessionToken = token;
  req.tenantId = session.tenant_id;
  req.telegramId = session.telegram_id;
  req.role = session.role;

  next();
}

/**
 * Middleware: только суперадмин
 */
function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req.telegramId)) {
    return res.status(403).json({ error: 'Доступ только для суперадмина' });
  }
  next();
}

/**
 * Middleware: тенант-админ или выше (owner/admin/super_admin)
 */
function requireTenantAdmin(req, res, next) {
  if (isSuperAdmin(req.telegramId)) {
    return next();
  }

  if (!req.tenantId) {
    return res.status(403).json({ error: 'Нет привязки к тенанту' });
  }

  if (req.role === 'owner' || req.role === 'admin') {
    return next();
  }

  return res.status(403).json({ error: 'Доступ запрещён' });
}

/**
 * Middleware: owner тенанта или суперадмин
 */
function requireTenantOwner(req, res, next) {
  if (isSuperAdmin(req.telegramId)) {
    return next();
  }

  if (!req.tenantId) {
    return res.status(403).json({ error: 'Нет привязки к тенанту' });
  }

  if (req.role === 'owner') {
    return next();
  }

  return res.status(403).json({ error: 'Доступ только для владельца' });
}

/**
 * Middleware: chat_user или выше (admin/owner/super_admin)
 */
function requireChatUser(req, res, next) {
  if (isSuperAdmin(req.telegramId)) return next();
  if (['owner', 'admin', 'chat_user'].includes(req.role)) return next();
  return res.status(403).json({ error: 'Доступ запрещён' });
}

module.exports = {
  authMiddleware,
  requireSuperAdmin,
  requireTenantAdmin,
  requireTenantOwner,
  requireChatUser,
};
