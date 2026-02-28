// lib/leadteh.js — Работа с Leadteh API (контакты, теги)

async function fetchAllContacts(config) {
  const contacts = [];
  let page = 1;
  const perPage = 500;

  while (true) {
    const url = `https://app.leadteh.ru/api/v1/getContacts?bot_id=${config.leadtehBotId}&count=${perPage}&page=${page}&with=variables&api_token=${encodeURIComponent(config.leadtehApiToken)}`;

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

module.exports = { fetchAllContacts, extractTags };
