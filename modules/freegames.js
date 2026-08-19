// modules/freegames.js — notifier game gratis (Epic/Steam/GOG) → auto-post channel.
//
// Beda dari wcp-watch/wcp-hook (sumber = .wcp / GitHub release): modul ini poll
// aggregator GamerPower (https://www.gamerpower.com/api/giveaways) yg ngerangkum
// giveaway gratis lintas store. Ga download/build apa-apa — cuma fetch JSON,
// filter (platform + tipe), lalu post kartu (foto + caption) ke channel.
//
// Alur: GET API (platform filter) → filter Active + tipe Game/DLC → dedup by id
// (state atomic) → sendPhoto(image, caption) ke channel. Seed senyap run pertama.
//
// KEAMANAN: SSRF allowlist (gamerpower host), size cap fetch, state atomic,
// caption PLAIN-TEXT (string pihak-3 ga di-render Markdown → anti caption-inject),
// cap per-poll (anti-flood), seed run pertama ga nge-post.

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

let bot = null;
let log = (...a) => console.log(...a);
let errLog = (...a) => console.error(...a);

const cfg = {
  channelId: null,
  statePath: '',
  pollMs: 6 * 60 * 60 * 1000,               // default 6 jam (free game jarang)
  maxPerPoll: 5,                            // cap post per siklus (anti-flood)
  platforms: ['epic-games-store', 'steam', 'gog'],  // GamerPower ga dukung multi-platform 1 URL → fetch per-platform
  keepTypes: new Set(['Game', 'DLC']),      // field `type` per-item yg di-post
  apiMaxBytes: 2 * 1024 * 1024,
  allowedHosts: new Set(['www.gamerpower.com', 'gamerpower.com']),
};

let seen = null;   // Set<String(id)>
let timer = null;
let polling = false;
let lastPoll = { ts: 0, posted: 0, errors: 0 };

function assertSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('URL invalid'); }
  if (u.protocol !== 'https:') throw new Error(`protokol ditolak: ${u.protocol}`);
  if (!cfg.allowedHosts.has(u.hostname)) throw new Error(`host ga di allowlist: ${u.hostname}`);
  return u;
}

function loadState() {
  seen = new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.statePath, 'utf8'));
    if (raw && Array.isArray(raw.seen)) for (const k of raw.seen) seen.add(String(k));
  } catch { /* kosong → seed */ }
  return seen;
}

function saveState() {
  const dir = path.dirname(cfg.statePath);
  const tmp = cfg.statePath + '.tmp';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ seen: Array.from(seen), updated: Date.now() }), 'utf8');
  fs.renameSync(tmp, cfg.statePath);
}

// Fetch giveaway 1 platform dari GamerPower. Balikin array (kosong kalau ga ada).
// Catatan: GamerPower balik HTTP 201 + {status:0} (bukan array) kalau platform lg
// kosong — itu NORMAL, bukan error. Non-array → treat list kosong.
async function fetchPlatform(platform) {
  const url = `https://www.gamerpower.com/api/giveaways?platform=${encodeURIComponent(platform)}&sort-by=date`;
  assertSafeUrl(url);
  const res = await axios.get(url, {
    timeout: 30000, maxContentLength: cfg.apiMaxBytes, maxRedirects: 3,
    headers: { 'User-Agent': 'copux-freegames/1', 'Accept': 'application/json' },
    beforeRedirect: (o) => { assertSafeUrl(`${o.protocol}//${o.hostname}${o.path}`); },
    validateStatus: (s) => s >= 200 && s < 300,   // 201 "no active" masih OK
  });
  return Array.isArray(res.data) ? res.data : [];
}

// Fetch semua platform, filter Active + tipe, dedup by id, normalize.
async function fetchGiveaways() {
  const rawAll = [];
  const errs = [];
  for (const p of cfg.platforms) {
    try { rawAll.push(...await fetchPlatform(p)); }
    catch (e) { errs.push(`${p}: ${e.message}`); }
  }
  // semua platform gagal → lempar (biar pollOnce catat error). Sebagian gagal → lanjut.
  if (errs.length === cfg.platforms.length) throw new Error(`semua platform gagal — ${errs.join('; ')}`);
  if (errs.length) errLog(`[freegames] sebagian platform gagal: ${errs.join('; ')}`);
  const out = [];
  const dedup = new Set();
  for (const g of rawAll) {
    if (!g || typeof g !== 'object') continue;
    if (String(g.status || '') !== 'Active') continue;
    if (!cfg.keepTypes.has(String(g.type || ''))) continue;
    const gurl = String(g.open_giveaway_url || g.gamerpower_url || '');
    if (g.id == null || !gurl) continue;
    const id = String(g.id);
    if (dedup.has(id)) continue;              // 1 giveaway bisa muncul di >1 platform
    dedup.add(id);
    // image WAJIB https — cegah node-telegram-bot-api (filepath:true) nganggep string
    // sbg path lokal & baca file dari box (SSRF-guard bypass / DoS via /dev/zero dll).
    let image = String(g.image || g.thumbnail || '');
    try { if (new URL(image).protocol !== 'https:') image = ''; } catch { image = ''; }
    out.push({
      id,
      title: String(g.title || 'Untitled').slice(0, 200),
      worth: String(g.worth || 'N/A'),
      image,
      url: gurl,
      platforms: String(g.platforms || '?').slice(0, 80),
      endDate: String(g.end_date || 'N/A'),
    });
  }
  return out;
}

// Post 1 giveaway: foto + caption. Caption PLAIN-TEXT (no parse_mode) — anti-inject.
async function postGiveaway(item) {
  const caption =
    `🎮 GRATIS: ${item.title}\n` +
    `💰 ${item.worth}  •  🏪 ${item.platforms}\n` +
    (item.endDate && item.endDate !== 'N/A' ? `⏰ berakhir: ${item.endDate}\n` : '') +
    `🔗 ${item.url}\n` +
    `⚠️ Klaim di store resmi — verifikasi sebelum login.`;
  try {
    if (item.image) await bot.sendPhoto(cfg.channelId, item.image, { caption });
    else await bot.sendMessage(cfg.channelId, caption);
  } catch (e) {
    // image gagal di-fetch Telegram → fallback text-only (jgn swallow senyap).
    await bot.sendMessage(cfg.channelId, caption);
  }
}

async function pollOnce(opts = {}) {
  if (polling) return { skipped: true };
  polling = true;
  const seedOnly = !!opts.seedOnly || seen.size === 0;
  let posted = 0, errors = 0, discovered = 0, deferred = 0;
  try {
    let items;
    try { items = await fetchGiveaways(); }
    catch (e) { errors++; errLog(`[freegames] fetch gagal: ${e.message}`); items = []; }
    for (const item of items) {
      if (seen.has(item.id)) continue;
      discovered++;
      if (seedOnly) { seen.add(item.id); continue; }
      if (posted >= cfg.maxPerPoll) { deferred++; continue; }  // cap: sisa nunggu poll berikut (JGN di-seen).
      try {
        await postGiveaway(item);
        seen.add(item.id);
        saveState();          // persist per-sukses → ga double-post kalau crash.
        posted++;
        log(`[freegames] posted ${item.title} (${item.platforms})`);
      } catch (e) {
        errors++;
        errLog(`[freegames] post gagal (${item.title}): ${e.message}`);
        // JGN tandai seen kalau gagal → retry poll berikutnya.
      }
    }
    if (seedOnly && discovered > 0) { saveState(); log(`[freegames] seed: ${discovered} giveaway di-record (ga di-post).`); }
    if (deferred > 0) log(`[freegames] ${deferred} ditunda (cap ${cfg.maxPerPoll}/poll) — nyusul poll berikut.`);
  } finally {
    polling = false;
    lastPoll = { ts: Date.now(), posted, errors, deferred };
  }
  return { posted, errors, discovered, deferred, seedOnly };
}

function init(opts) {
  bot = opts.bot;
  if (opts.log) log = opts.log;
  if (opts.errLog) errLog = opts.errLog;
  cfg.channelId = opts.channelId != null ? opts.channelId : (process.env.FREEGAME_CHANNEL_ID || process.env.WCP_CHANNEL_ID || null);
  cfg.statePath = opts.statePath || path.join(opts.dataDir || process.cwd(), 'freegame-seen.json');
  if (process.env.FREEGAME_POLL_MS) cfg.pollMs = Math.max(300000, parseInt(process.env.FREEGAME_POLL_MS, 10) || cfg.pollMs);
  if (process.env.FREEGAME_PLATFORMS) cfg.platforms = process.env.FREEGAME_PLATFORMS.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.FREEGAME_TYPES) cfg.keepTypes = new Set(process.env.FREEGAME_TYPES.split(',').map(s => s.trim()).filter(Boolean));
  if (process.env.FREEGAME_MAX_PER_POLL) cfg.maxPerPoll = Math.max(1, parseInt(process.env.FREEGAME_MAX_PER_POLL, 10) || cfg.maxPerPoll);
  loadState();
  return { platforms: cfg.platforms, seen: seen.size, channel: !!cfg.channelId };
}

function start() {
  if (timer) return false;
  if (!cfg.channelId) { errLog('[freegames] channel kosong — notifier ga jalan.'); return false; }
  timer = setInterval(() => { pollOnce().catch((e) => errLog('[freegames] poll err:', e.message)); }, cfg.pollMs);
  if (timer.unref) timer.unref();
  pollOnce().catch((e) => errLog('[freegames] initial poll err:', e.message));
  log(`[freegames] notifier ON — ${cfg.platforms}, tiap ${Math.round(cfg.pollMs / 60000)}m.`);
  return true;
}

function stop() { if (!timer) return false; clearInterval(timer); timer = null; log('[freegames] notifier OFF.'); return true; }

function status() {
  return {
    running: !!timer,
    platforms: cfg.platforms,
    types: Array.from(cfg.keepTypes),
    channel: cfg.channelId,
    seen: seen ? seen.size : 0,
    pollMinutes: Math.round(cfg.pollMs / 60000),
    maxPerPoll: cfg.maxPerPoll,
    lastPoll,
  };
}

async function seed() { return pollOnce({ seedOnly: true }); }

module.exports = { init, start, stop, status, pollOnce, seed, assertSafeUrl, _cfg: cfg };
