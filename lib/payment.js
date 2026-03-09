// lib/payment.js — Модуль платёжного шлюза (ТБанк + Робокасса)
const crypto = require('crypto');

// ============================================
// ТБанк (Tinkoff Acquiring API v2)
// ============================================
function createTbankProvider(config) {
  const baseUrl = config.tbankTestMode
    ? 'https://rest-api-test.tinkoff.ru/v2'
    : 'https://securepay.tinkoff.ru/v2';

  function generateToken(params) {
    // Собрать пары ключ-значение, добавить Password, отсортировать по ключу,
    // конкатенировать значения, SHA-256
    const data = { ...params, Password: config.tbankPassword };
    // Исключить вложенные объекты и массивы
    const keys = Object.keys(data)
      .filter(k => typeof data[k] !== 'object')
      .sort();
    const concatenated = keys.map(k => data[k]).join('');
    return crypto.createHash('sha256').update(concatenated).digest('hex');
  }

  return {
    name: 'tbank',

    async createPayment(orderId, amount, description) {
      const params = {
        TerminalKey: config.tbankTerminalKey,
        Amount: Math.round(amount * 100), // в копейках
        OrderId: String(orderId),
        Description: description || 'Оплата тарифа LT Кабинет',
        NotificationURL: `${config.baseUrl}/api/payment/webhook/tbank`,
        SuccessURL: `${config.baseUrl}/?payment=success`,
        FailURL: `${config.baseUrl}/?payment=fail`,
      };
      params.Token = generateToken(params);

      const res = await fetch(`${baseUrl}/Init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json();

      if (!data.Success) {
        throw new Error(`ТБанк Init error: ${data.Message || data.Details || 'unknown'}`);
      }

      return {
        paymentUrl: data.PaymentURL,
        externalId: String(data.PaymentId),
      };
    },

    verifyWebhook(body) {
      // body — JSON от ТБанк
      const { Token: receivedToken, ...rest } = body;
      const expectedToken = generateToken(rest);
      const verified = receivedToken === expectedToken;
      return {
        verified,
        orderId: body.OrderId ? String(body.OrderId) : null,
        externalId: body.PaymentId ? String(body.PaymentId) : null,
        status: body.Status,
        amount: body.Amount ? Math.round(body.Amount / 100) : 0, // из копеек в рубли
      };
    },
  };
}

// ============================================
// Робокасса
// ============================================
function createRobokassaProvider(config) {
  const isTest = config.robokassaTestMode;

  function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
  }

  return {
    name: 'robokassa',

    async createPayment(orderId, amount, description) {
      // Подпись: MD5(MerchantLogin:OutSum:InvId:Password1)
      const outSum = String(amount); // рубли
      const invId = String(orderId);
      const signature = md5(`${config.robokassaLogin}:${outSum}:${invId}:${config.robokassaPassword1}`);

      const params = new URLSearchParams({
        MerchantLogin: config.robokassaLogin,
        OutSum: outSum,
        InvId: invId,
        Description: description || 'Оплата тарифа LT Кабинет',
        SignatureValue: signature,
        Culture: 'ru',
      });
      if (isTest) params.set('IsTest', '1');

      const paymentUrl = `https://auth.robokassa.ru/Merchant/Index.aspx?${params.toString()}`;

      return {
        paymentUrl,
        externalId: invId, // у Робокассы InvId = наш orderId
      };
    },

    verifyWebhook(body) {
      // ResultURL: проверка MD5(OutSum:InvId:Password2)
      const outSum = body.OutSum;
      const invId = body.InvId;
      const receivedSignature = (body.SignatureValue || '').toLowerCase();
      const expectedSignature = md5(`${outSum}:${invId}:${config.robokassaPassword2}`);
      const verified = receivedSignature === expectedSignature;

      return {
        verified,
        orderId: invId ? String(invId) : null,
        externalId: invId ? String(invId) : null,
        status: verified ? 'CONFIRMED' : 'UNKNOWN',
        amount: outSum ? parseFloat(outSum) : 0,
      };
    },
  };
}

// ============================================
// Фабрика провайдеров
// ============================================
function getProvider(config) {
  if (config.paymentProvider === 'tbank' && config.tbankTerminalKey && config.tbankPassword) {
    return createTbankProvider(config);
  }
  if (config.paymentProvider === 'robokassa' && config.robokassaLogin && config.robokassaPassword1) {
    return createRobokassaProvider(config);
  }
  return null; // ручной режим
}

module.exports = { getProvider };
