// access.js — Telegram bot user-access gate.
// Manages an approved-users store persisted to a JSON file with atomic writes.
// On-disk shape: { "approved": { "<userId>": { "name": <string>, "ts": <number> } } }
// No external deps (fs, path only). Reads tolerate missing/bad files; writes fail loud.

const fs = require('fs');
const path = require('path');

const STORE_PATH =
  process.env.ACCESS_STORE_PATH || path.join(__dirname, 'data', 'access.json');

let cache = null; // { approved: { ... } }, loaded lazily on first use

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const approved =
      parsed && typeof parsed.approved === 'object' && parsed.approved
        ? parsed.approved
        : {};
    cache = { approved };
  } catch (err) {
    // Missing file or malformed JSON → treat as empty store, never throw.
    cache = { approved: {} };
  }
  return cache;
}

function persist() {
  const dir = path.dirname(STORE_PATH);
  const tmp = STORE_PATH + '.tmp';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf8');
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    console.error('[access] failed to persist store:', err.message);
    throw err;
  }
}

const key = (userId) => String(userId);

function isApproved(userId) {
  return Object.prototype.hasOwnProperty.call(load().approved, key(userId));
}

function approve(userId, meta) {
  const store = load();
  const ts = meta && meta.ts !== undefined ? meta.ts : Date.now();
  const name = meta && meta.name ? String(meta.name) : '';
  store.approved = { ...store.approved, [key(userId)]: { name, ts } };
  persist();
}

function revoke(userId) {
  const store = load();
  const k = key(userId);
  if (!Object.prototype.hasOwnProperty.call(store.approved, k)) return;
  const next = { ...store.approved };
  delete next[k];
  store.approved = next;
  persist();
}

function list() {
  const { approved } = load();
  return Object.keys(approved).map((userId) => ({
    userId,
    name: approved[userId].name,
    ts: approved[userId].ts,
  }));
}

function count() {
  return Object.keys(load().approved).length;
}

module.exports = { isApproved, approve, revoke, list, count };
