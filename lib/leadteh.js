// lib/leadteh.js — Работа с Leadteh API (контакты, теги)

async function fetchAllContacts(config) {
  const contacts = [];
  let page = 1;
  const perPage = 500;

  while (true) {
    const url = `https://app.leadteh.ru/api/v1/getContacts?bot_id=${config.leadtehBotId}&count=${perPage}&page=${page}&with=tags,variables&api_token=${encodeURIComponent(config.leadtehApiToken)}`;

    const r = await fetch(url, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });

    if (!r.ok) break;

    const data = await r.json();
    const items = data.data || data.contacts || data || [];

    if (!Array.isArray(items) || items.length === 0) break;

    contacts.push(...items);
    if (items.length < perPage) break;
    page++;
  }

  return contacts;
}

function extractTags(contact) {
  const tags = [];

  if (Array.isArray(contact.tags)) {
    for (const t of contact.tags) {
      if (typeof t === 'string') tags.push(t.trim());
      else if (t && t.name) tags.push(t.name.trim());
    }
  }

  if (contact.variables && Array.isArray(contact.variables)) {
    for (const v of contact.variables) {
      if (v.key === 'tags' || v.name === 'tags') {
        const val = v.value || v.data || '';
        if (typeof val === 'string') {
          val.split(',').forEach((t) => {
            const trimmed = t.trim();
            if (trimmed) tags.push(trimmed);
          });
        }
      }
    }
  }

  if (typeof contact.tags === 'string') {
    contact.tags.split(',').forEach((t) => {
      const trimmed = t.trim();
      if (trimmed) tags.push(trimmed);
    });
  }

  return tags;
}

async function fetchListSchemas(config) {
  const url = `https://app.leadteh.ru/api/v1/getListSchemas?bot_id=${config.leadtehBotId}&api_token=${encodeURIComponent(config.leadtehApiToken)}`;

  const r = await fetch(url, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });

  if (!r.ok) throw new Error(`Ошибка загрузки списков: ${r.status}`);

  const data = await r.json();
  return data.data || data || [];
}

async function fetchListItems(config, schemaId) {
  const url = `https://app.leadteh.ru/api/v1/getListItems`;

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({
      schema_id: schemaId,
      bot_id: config.leadtehBotId,
      api_token: config.leadtehApiToken,
    }),
  });

  if (!r.ok) throw new Error(`Ошибка загрузки элементов списка: ${r.status}`);

  const data = await r.json();
  return data.data || data || [];
}

function extractTelegramIds(items, fields) {
  const ids = new Set();

  // Ищем поля типа contact или с названием содержащим telegram
  const contactFieldIds = [];
  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (
        f.type === 'contact' ||
        (f.name && f.name.toLowerCase().includes('telegram'))
      ) {
        contactFieldIds.push(f.id || f.key);
      }
    }
  }

  for (const item of items) {
    const values = item.values || item.fields || item;

    // Проверяем все значения элемента
    if (typeof values === 'object') {
      for (const [key, val] of Object.entries(values)) {
        // Если это поле контакта или telegram — извлечь id
        const isContactField = contactFieldIds.length === 0 || contactFieldIds.includes(key);
        if (!isContactField) continue;

        if (val && typeof val === 'object' && val.telegram_id) {
          ids.add(String(val.telegram_id));
        } else if (val && typeof val === 'string' && /^\d{5,15}$/.test(val)) {
          ids.add(val);
        } else if (typeof val === 'number' && val > 10000) {
          ids.add(String(val));
        }
      }
    }
  }

  return Array.from(ids);
}

module.exports = { fetchAllContacts, extractTags, fetchListSchemas, fetchListItems, extractTelegramIds };
