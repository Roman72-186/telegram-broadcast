// lib/storage.js — Хранение рассылок в JSON-файле
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'broadcasts.json');

// Создаём директорию data если нет
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readAll() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeAll(broadcasts) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(broadcasts, null, 2), 'utf-8');
}

function save(broadcast) {
  const all = readAll();
  all.push(broadcast);
  writeAll(all);
}

function get(id) {
  const all = readAll();
  return all.find((b) => b.id === id) || null;
}

function update(broadcast) {
  const all = readAll();
  const idx = all.findIndex((b) => b.id === broadcast.id);
  if (idx >= 0) {
    all[idx] = broadcast;
    writeAll(all);
  }
}

function remove(id) {
  const all = readAll();
  const filtered = all.filter((b) => b.id !== id);
  writeAll(filtered);
}

function list() {
  return readAll();
}

module.exports = { save, get, update, remove, list };
