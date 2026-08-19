// modules/wcp-watch.js — Winlator .wcp release notifier (auto-post ke channel).
// Poll satu/lebih katalog contents.json (GitHub-hosted), deteksi komponen baru
// (default DXVK/Box64/FEXCore), download tiap .wcp baru lalu re-upload ke channel
// Telegram sebagai document.
//
// Desain:
// - Host-agnostic: semua via env (sumber, channel, interval, cap). Portable.
// - SSRF-guarded: cuma https + host GitHub allowlist, redirect di-revalidasi.
// - Size-capped streaming download + cleanup temp (bot jgn OOM / disk penuh).
// - Run PERTAMA nge-SEED senyap (record katalog sekarang sbg seen) → ga flood.
// - State atomic (tmp+rename) ala modules/persistence.js. Persist per-sukses.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

// ---- injected via init() ----
let bot = null;
let log = (...a) => console.log(...a);
let errLog = (...a) => console.error(...a);

// ---- config (di-resolve di init dari env) ----
const cfg = {
  sources: [],                 // [{name, url}]
  channelId: null,
  types: new Set(['DXVK', 'Box64', 'FEXCore']),
  pollMs: 30 * 60 * 1000,
  maxBytes: 100 * 1024 * 1024, // 100MB cap per file
  maxPerPoll: 10,              // cap jml upload per siklus (anti-flood), sisa nunggu poll berikut
  catalogMaxBytes: 10 * 1024 * 1024,
  dlTimeoutMs: 120000,
  statePath: '',
  allowedHosts: new Set([
    'raw.githubusercontent.com',
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'codeload.github.com',
  ]),
};

let seen = null;      // Set<remoteUrl>
let timer = null;
let polling = false;  // reentrancy guard
let lastPoll = { ts: 0, posted: 0, errors: 0 };

// ============================================================================
//  SSRF guard — remoteUrl datang dari katalog pihak-3, jgn dipercaya.
// ============================================================================
function assertSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('URL invalid'); }
  if (u.protocol !== 'https:') throw new Error(`protokol ditolak: ${u.protocol}`);
  if (!cfg.allowedHosts.has(u.hostname)) throw new Error(`host ga di allowlist: ${u.hostname}`);
  return u;
}

// ============================================================================
//  State (seen set) — atomic write ala persistence.js.
// ============================================================================
function loadState() {
  seen = new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.statePath, 'utf8'));
    if (Array.isArray(raw && raw.seen)) for (const k of raw.seen) seen.add(String(k));
  } catch {
    // file ga ada / rusak → mulai kosong, seed di poll pertama.
  }
  return seen;
}

function saveState() {
  const dir = path.dirname(cfg.statePath);
  const tmp = cfg.statePath + '.tmp';
  const payload = { seen: Array.from(seen), updated: Date.now() };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, cfg.statePath);
}

// ============================================================================
//  Fetch + parse katalog contents.json (flat array, skema seragam).
// ============================================================================
async function fetchCatalog(src) {
  assertSafeUrl(src.url);
  const res = await axios.get(src.url, {
    responseType: 'text',
    timeout: 30000,
    maxContentLength: cfg.catalogMaxBytes,
    maxRedirects: 3,
    headers: { 'User-Agent': 'copux-wcp-watch/1' },
    beforeRedirect: (opts) => { assertSafeUrl(`${opts.protocol}//${opts.hostname}${opts.path}`); },
  });
  let arr;
  try { arr = JSON.parse(res.data); } catch { throw new Error('katalog bukan JSON valid'); }
  if (!Array.isArray(arr)) throw new Error('katalog bukan array');
  const out = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const type = String(e.type || '');
    const remoteUrl = String(e.remoteUrl || '');
    const verName = String(e.verName || '');
    if (!remoteUrl || !verName) continue;
    // normalisasi tipe: D7VK (anomali winnative) diperlakukan sbg DXVK utk filter.
    const canon = type === 'D7VK' ? 'DXVK' : type;
    if (!cfg.types.has(canon)) continue;
    out.push({ type: canon, rawType: type, verName, remoteUrl, source: src.name });
  }
  return out;
}

// ============================================================================
//  Download .wcp ke temp — streaming + size cap + SSRF revalidate on redirect.
// ============================================================================
async function downloadToTemp(remoteUrl, verName) {
  assertSafeUrl(remoteUrl);
  const safeName = String(verName).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'component';
  const tmpFile = path.join(os.tmpdir(), `wcp-${process.pid}-${safeName}.wcp`);
  const res = await axios.get(remoteUrl, {
    responseType: 'stream',
    timeout: cfg.dlTimeoutMs,
    maxRedirects: 5,
    headers: { 'User-Agent': 'copux-wcp-watch/1' },
    beforeRedirect: (opts) => { assertSafeUrl(`${opts.protocol}//${opts.hostname}${opts.path}`); },
  });
  return await new Promise((resolve, reject) => {
    let bytes = 0;
    let aborted = false;
    const ws = fs.createWriteStream(tmpFile);
    const cleanup = () => { try { fs.unlinkSync(tmpFile); } catch {} };
    const fail = (err) => {
      if (aborted) return;
      aborted = true;
      res.data.destroy();
      ws.destroy();
      cleanup();
      reject(err);
    };
    res.data.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > cfg.maxBytes) fail(new Error(`file > cap (${cfg.maxBytes} B)`));
    });
    res.data.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => { if (!aborted) resolve({ tmpFile, bytes }); });
    res.data.pipe(ws);
  });
}

// ============================================================================
//  Post satu komponen baru ke channel (upload file).
// ============================================================================
async function postComponent(item) {
  const { tmpFile } = await downloadToTemp(item.remoteUrl, item.verName);
  try {
    // Plain text (NO parse_mode) — verName/type/source dari katalog pihak-3, jgn
    // di-render sbg Markdown (cegah caption-injection / link palsu).
    const caption =
      `🧩 ${item.type} — ${item.verName}\n` +
      `📦 sumber: ${item.source}\n` +
      `⚠️ Binary pihak-3 — verifikasi sebelum import.`;
    await bot.sendDocument(
      cfg.channelId,
      tmpFile,
      { caption },
      { filename: path.basename(tmpFile), contentType: 'application/octet-stream' },
    );
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ============================================================================
//  Satu siklus poll.
//  opts.seedOnly = true → cuma record seen, ga post (dipakai run pertama).
// ============================================================================
async function pollOnce(opts = {}) {
  if (polling) return { skipped: true };
  polling = true;
  const seedOnly = !!opts.seedOnly || seen.size === 0;
  let posted = 0, errors = 0, discovered = 0, deferred = 0;
  try {
    for (const src of cfg.sources) {
      let items;
      try { items = await fetchCatalog(src); }
      catch (e) { errors++; errLog(`[wcp] katalog gagal (${src.name}): ${e.message}`); continue; }
      for (const item of items) {
        if (seen.has(item.remoteUrl)) continue;
        discovered++;
        if (seedOnly) { seen.add(item.remoteUrl); continue; }
        if (posted >= cfg.maxPerPoll) { deferred++; continue; }  // cap: sisa nunggu poll berikut (JGN di-seen).
        try {
          await postComponent(item);
          seen.add(item.remoteUrl);
          saveState();          // persist per-sukses → ga double-post kalau crash.
          posted++;
        } catch (e) {
          errors++;
          errLog(`[wcp] post gagal (${item.verName}): ${e.message}`);
          // JGN tandai seen kalau gagal → retry poll berikutnya.
        }
      }
    }
    if (seedOnly && discovered > 0) {
      saveState();
      log(`[wcp] seed run: ${discovered} entri di-record (ga di-post).`);
    }
    if (deferred > 0) log(`[wcp] ${deferred} entri baru ditunda (cap ${cfg.maxPerPoll}/poll) — nyusul poll berikut.`);
  } finally {
    polling = false;
    lastPoll = { ts: Date.now(), posted, errors, deferred };
  }
  return { posted, errors, discovered, deferred, seedOnly };
}

// ============================================================================
//  Public API.
// ============================================================================
function parseSources(rawEnv) {
  // format: "name1=url1,name2=url2" ATAU "url1,url2" (auto-nama dari host/path).
  const out = [];
  for (const part of String(rawEnv || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    let name, url;
    if (eq > 0) { name = part.slice(0, eq).trim(); url = part.slice(eq + 1).trim(); }
    else { url = part; try { name = new URL(url).pathname.split('/').filter(Boolean)[0] || url; } catch { name = url; } }
    if (url) out.push({ name, url });
  }
  return out;
}

function init(opts) {
  bot = opts.bot;
  if (opts.log) log = opts.log;
  if (opts.errLog) errLog = opts.errLog;
  cfg.channelId = opts.channelId != null ? opts.channelId : (process.env.WCP_CHANNEL_ID || null);
  cfg.statePath = opts.statePath || path.join(opts.dataDir || process.cwd(), 'wcp-seen.json');
  cfg.sources = parseSources(opts.sourcesEnv != null ? opts.sourcesEnv : process.env.WCP_SOURCES);
  if (process.env.WCP_TYPES) cfg.types = new Set(process.env.WCP_TYPES.split(',').map(s => s.trim()).filter(Boolean));
  if (process.env.WCP_POLL_MS) cfg.pollMs = Math.max(60000, parseInt(process.env.WCP_POLL_MS, 10) || cfg.pollMs);
  if (process.env.WCP_MAX_MB) cfg.maxBytes = Math.max(1, parseInt(process.env.WCP_MAX_MB, 10) || 100) * 1024 * 1024;
  if (process.env.WCP_MAX_PER_POLL) cfg.maxPerPoll = Math.max(1, parseInt(process.env.WCP_MAX_PER_POLL, 10) || cfg.maxPerPoll);
  loadState();
  return { sources: cfg.sources.length, seen: seen.size, channel: !!cfg.channelId };
}

function start() {
  if (timer) return false;
  if (!cfg.channelId) { errLog('[wcp] WCP_CHANNEL_ID kosong — watch ga jalan.'); return false; }
  if (!cfg.sources.length) { errLog('[wcp] WCP_SOURCES kosong — watch ga jalan.'); return false; }
  timer = setInterval(() => { pollOnce().catch(e => errLog('[wcp] poll error:', e.message)); }, cfg.pollMs);
  if (timer.unref) timer.unref();
  // kick awal (seed kalau state kosong).
  pollOnce().catch(e => errLog('[wcp] initial poll error:', e.message));
  log(`[wcp] watch ON — ${cfg.sources.length} sumber, tiap ${Math.round(cfg.pollMs / 60000)}m.`);
  return true;
}

function stop() {
  if (!timer) return false;
  clearInterval(timer);
  timer = null;
  log('[wcp] watch OFF.');
  return true;
}

function status() {
  return {
    running: !!timer,
    sources: cfg.sources.map(s => s.name),
    channel: cfg.channelId,
    types: Array.from(cfg.types),
    seen: seen ? seen.size : 0,
    pollMinutes: Math.round(cfg.pollMs / 60000),
    maxMB: Math.round(cfg.maxBytes / 1024 / 1024),
    maxPerPoll: cfg.maxPerPoll,
    lastPoll,
  };
}

// seed manual: record semua entri sekarang sbg seen tanpa post.
async function seed() { return pollOnce({ seedOnly: true }); }

module.exports = { init, start, stop, status, pollOnce, seed, parseSources, assertSafeUrl, _cfg: cfg };

