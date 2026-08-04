// modules/wcp-hook.js — auto-hook rilis DXVK/VKD3D resmi → build .wcp → post channel.
//
// Beda dari wcp-watch (mirror .wcp jadi dari provider): modul ini tarik tarball
// SOURCE-BINARY resmi (doitsujin/dxvk, HansKristian-Work/vkd3d-proton) yg isinya
// DLL x64/x32 jadi, lalu REPACKAGE sendiri jadi .wcp via mesin wcp-build.js.
//
// Cakupan: cuma komponen yg upstream-nya rilis BINARY (DXVK, VKD3D). box64/FEX
// rilis source (butuh compile) → di luar cakupan, itu lewat wcp-watch (provider).
//
// Alur per repo: GitHub API releases → tag baru (dedup state) → cari asset tarball
// → download (SSRF guard + cap) → wcpBuild.buildFromArchive → sendDocument channel.
//
// KEAMANAN: SSRF allowlist (github + objects), size cap streaming, state atomic,
// seed senyap run pertama, cap per-poll. Build pakai sandbox wcp-build (tar-slip
// guard dll udah di sana).

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

let bot = null;
let wcpBuild = null;
let log = (...a) => console.log(...a);
let errLog = (...a) => console.error(...a);

const cfg = {
  channelId: null,
  statePath: '',
  pollMs: 60 * 60 * 1000,        // default 1 jam (rilis resmi jarang)
  maxBytes: 60 * 1024 * 1024,
  maxPerPoll: 4,
  // repo target: type = tipe WCP, repo = owner/name, assetRe = pola nama asset tarball.
  repos: [
    { type: 'DXVK', repo: 'doitsujin/dxvk', assetRe: /^dxvk-\d[\w.]*\.tar\.(gz|xz|zst)$/i, excludeRe: /native/i },
    { type: 'VKD3D', repo: 'HansKristian-Work/vkd3d-proton', assetRe: /^vkd3d-proton-\d[\w.]*\.tar\.(gz|xz|zst)$/i },
  ],
  allowedHosts: new Set([
    'api.github.com', 'github.com',
    'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
    'codeload.github.com',
  ]),
};

let seen = null;   // Set<"type:tag">
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
    if (Array.isArray(raw && raw.seen)) for (const k of raw.seen) seen.add(String(k));
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

// Ambil rilis terbaru repo via GitHub API (non-draft, non-prerelease pertama).
async function latestRelease(repo) {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=5`;
  assertSafeUrl(url);
  const res = await axios.get(url, {
    timeout: 30000, maxContentLength: 2 * 1024 * 1024, maxRedirects: 3,
    headers: { 'User-Agent': 'copux-wcp-hook/1', 'Accept': 'application/vnd.github+json' },
    beforeRedirect: (o) => { assertSafeUrl(`${o.protocol}//${o.hostname}${o.path}`); },
  });
  const arr = Array.isArray(res.data) ? res.data : [];
  return arr.find((r) => r && !r.draft && !r.prerelease) || arr[0] || null;
}

function pickAsset(rel, spec) {
  const assets = (rel && rel.assets) || [];
  return assets.find((a) => spec.assetRe.test(a.name) && (!spec.excludeRe || !spec.excludeRe.test(a.name))) || null;
}

async function downloadToTemp(url, hintName) {
  assertSafeUrl(url);
  const safe = String(hintName).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'asset';
  const tmpFile = path.join(require('os').tmpdir(), `wcphook-${process.pid}-${safe}`);
  const res = await axios.get(url, {
    responseType: 'stream', timeout: 120000, maxRedirects: 5,
    headers: { 'User-Agent': 'copux-wcp-hook/1' },
    beforeRedirect: (o) => { assertSafeUrl(`${o.protocol}//${o.hostname}${o.path}`); },
  });
  return await new Promise((resolve, reject) => {
    let bytes = 0, aborted = false;
    const ws = fs.createWriteStream(tmpFile);
    const fail = (e) => { if (aborted) return; aborted = true; res.data.destroy(); ws.destroy(); try { fs.unlinkSync(tmpFile); } catch {} reject(e); };
    res.data.on('data', (c) => { bytes += c.length; if (bytes > cfg.maxBytes) fail(new Error('asset > cap')); });
    res.data.on('error', fail); ws.on('error', fail);
    ws.on('finish', () => { if (!aborted) resolve(tmpFile); });
    res.data.pipe(ws);
  });
}

async function pollOnce(opts = {}) {
  if (polling) return { skipped: true };
  polling = true;
  const seedOnly = !!opts.seedOnly || seen.size === 0;
  let posted = 0, errors = 0, discovered = 0, deferred = 0;
  try {
    for (const spec of cfg.repos) {
      let rel;
      try { rel = await latestRelease(spec.repo); }
      catch (e) { errors++; errLog(`[wcphook] release gagal (${spec.repo}): ${e.message}`); continue; }
      if (!rel || !rel.tag_name) continue;
      const key = `${spec.type}:${rel.tag_name}`;
      if (seen.has(key)) continue;
      discovered++;
      if (seedOnly) { seen.add(key); continue; }
      if (posted >= cfg.maxPerPoll) { deferred++; continue; }

      const asset = pickAsset(rel, spec);
      if (!asset || !asset.browser_download_url) {
        errLog(`[wcphook] ${spec.type} ${rel.tag_name}: asset tarball ga ketemu`);
        continue; // JGN seen → retry (asset mungkin nyusul di-upload)
      }
      let tmpTar = null, build = null;
      try {
        tmpTar = await downloadToTemp(asset.browser_download_url, asset.name);
        build = await wcpBuild.buildFromArchive({ localTar: tmpTar, origName: asset.name, typeHint: spec.type });
        if (!build.ok) throw new Error(build.needType ? 'tipe ga kedetect' : 'build gagal');
        const cap = `🧩 ${build.type} — ${build.versionName}\n📦 auto-build dari rilis resmi (${spec.repo})\n🏷️ ${rel.tag_name}\n⚠️ Test dulu sebelum dipakai serius.`;
        await bot.sendDocument(cfg.channelId, build.wcpPath, { caption: cap },
          { filename: path.basename(build.wcpPath), contentType: 'application/octet-stream' });
        seen.add(key); saveState(); posted++;
        log(`[wcphook] posted ${build.type} ${build.versionName} (${rel.tag_name})`);
      } catch (e) {
        errors++;
        errLog(`[wcphook] ${spec.type} ${rel.tag_name} gagal: ${e.message}`);
      } finally {
        if (tmpTar) { try { fs.unlinkSync(tmpTar); } catch {} }
        if (build && build.work) { try { fs.rmSync(build.work, { recursive: true, force: true }); } catch {} }
      }
    }
    if (seedOnly && discovered > 0) { saveState(); log(`[wcphook] seed: ${discovered} rilis di-record (ga di-post).`); }
    if (deferred > 0) log(`[wcphook] ${deferred} ditunda (cap ${cfg.maxPerPoll}/poll).`);
  } finally {
    polling = false;
    lastPoll = { ts: Date.now(), posted, errors, deferred };
  }
  return { posted, errors, discovered, deferred, seedOnly };
}

function init(opts) {
  bot = opts.bot;
  wcpBuild = opts.wcpBuild;
  if (opts.log) log = opts.log;
  if (opts.errLog) errLog = opts.errLog;
  cfg.channelId = opts.channelId != null ? opts.channelId : (process.env.WCP_HOOK_CHANNEL_ID || process.env.WCP_CHANNEL_ID || null);
  cfg.statePath = opts.statePath || path.join(opts.dataDir || process.cwd(), 'wcp-hook-seen.json');
  if (process.env.WCP_HOOK_POLL_MS) cfg.pollMs = Math.max(300000, parseInt(process.env.WCP_HOOK_POLL_MS, 10) || cfg.pollMs);
  loadState();
  return { repos: cfg.repos.map((r) => r.type), seen: seen.size, channel: !!cfg.channelId };
}

function start() {
  if (timer) return false;
  if (!cfg.channelId) { errLog('[wcphook] channel kosong — hook ga jalan.'); return false; }
  if (!wcpBuild) { errLog('[wcphook] wcpBuild belum di-inject.'); return false; }
  timer = setInterval(() => { pollOnce().catch((e) => errLog('[wcphook] poll err:', e.message)); }, cfg.pollMs);
  if (timer.unref) timer.unref();
  pollOnce().catch((e) => errLog('[wcphook] initial poll err:', e.message));
  log(`[wcphook] hook ON — ${cfg.repos.length} repo, tiap ${Math.round(cfg.pollMs / 60000)}m.`);
  return true;
}

function stop() { if (!timer) return false; clearInterval(timer); timer = null; log('[wcphook] hook OFF.'); return true; }

function status() {
  return {
    running: !!timer,
    repos: cfg.repos.map((r) => `${r.type}(${r.repo})`),
    channel: cfg.channelId,
    seen: seen ? seen.size : 0,
    pollMinutes: Math.round(cfg.pollMs / 60000),
    lastPoll,
  };
}

async function seed() { return pollOnce({ seedOnly: true }); }

module.exports = { init, start, stop, status, pollOnce, seed, assertSafeUrl, pickAsset, _cfg: cfg };
