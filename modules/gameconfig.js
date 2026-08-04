// modules/gameconfig.js — COPUX game-config puller.
//
// User tanya setting game → COPUX ambil dari repo komunitas The412Banner
// (bannerlator-game-configs) → tampil rapi (DXVK/VKD3D/GPU driver/box64/env
// versi yg jalan di SoC tsb). On-demand, no auto-post, no per-user state.
//
// Sumber: The412Banner/bannerlator-game-configs (public, NO LICENSE).
// Izin verbal dari dev, syarat "give credit" → footer atribusi WAJIB tiap pesan.
// Bisa dimatiin via env GAMECONFIG_ENABLED=0 kalau izin dicabut.
//
// Layout repo: configs/{GAME}/{GAME}-{brand}-{model}-{SoC}-{ts}.json
//   SoC di-escape: "Adreno__TM__830" = "Adreno (TM) 830".
// Config: meta{device,soc,bh_version,upload_token⚠️} + settings{pc_ls_*,bl_ext}
//   + components[] (udah decoded {name,type} → dipakai buat versi komponen).
//
// KEAMANAN (risk surface: network + user input + render data pihak-3):
// - SSRF: allowlist host GitHub, https-only, beforeRedirect re-validate.
// - Input user cuma buat fuzzy-match in-memory — GA PERNAH masuk URL. Path yg
//   di-fetch cuma dari cache tree (whitelist), + encodeURIComponent per segmen.
// - upload_token (PII uploader, ada di 100% config) DI-STRIP sebelum render.
// - Output plain-text (no parse_mode) → nilai pihak-3 ga bisa markdown-inject.
// - Size cap tiap fetch. Cache TTL, lazy (no timer).

'use strict';

const axios = require('axios');

// ---- injected via init() ----
let bot = null;
let log = (...a) => console.log(...a);
let errLog = (...a) => console.error(...a);
let recordError = () => {};

const REPO = 'The412Banner/bannerlator-game-configs';
const BRANCH = 'main';
const CREDIT = '📚 Sumber: The412Banner/bannerlator-game-configs — credit ke dev @The412Banner';

const cfg = {
  enabled: true,
  cacheTtlMs: 60 * 60 * 1000,       // 1 jam
  maxConfigBytes: 1 * 1024 * 1024,  // config ~beberapa KB
  maxIndexBytes: 8 * 1024 * 1024,   // tree recursive bisa ratusan KB
  httpTimeoutMs: 20000,
  maxMatches: 8,                    // batas game yg ditampil kalau ambigu
  maxDevices: 12,                   // batas SoC yg ditampil per game
  allowedHosts: new Set([
    'api.github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'codeload.githubusercontent.com',
  ]),
};

// cache in-memory
let cache = {
  ts: 0,               // kapan terakhir di-build
  stamp: null,         // stats.json generated_utc terakhir
  folders: null,       // Map<folderLower, {folder, files:[{path,label,socEscaped,socPretty,ts}]}>
  names: null,         // [{key, folder, display}] buat fuzzy-search (folder + steam name)
};

// ============================================================================
//  SSRF guard: https-only + host allowlist. Dipakai jg di beforeRedirect.
// ============================================================================
function assertSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('URL invalid'); }
  if (u.protocol !== 'https:') throw new Error(`protokol ditolak: ${u.protocol}`);
  if (!cfg.allowedHosts.has(u.hostname)) throw new Error(`host ga di allowlist: ${u.hostname}`);
  return u;
}

async function getJson(url, maxBytes) {
  assertSafeUrl(url);
  const res = await axios.get(url, {
    timeout: cfg.httpTimeoutMs,
    maxContentLength: maxBytes,
    maxRedirects: 3,
    responseType: 'json',
    headers: { 'User-Agent': 'copux-gameconfig/1', 'Accept': 'application/json' },
    beforeRedirect: (o) => { assertSafeUrl(`${o.protocol}//${o.hostname}${o.path}`); },
  });
  return res.data;
}

// ============================================================================
//  Util nama/SoC.
// ============================================================================
function unescapeSoc(s) {
  // "Adreno__TM__830" → "Adreno (TM) 830"; "G57_MC2" tetep apa adanya-ish.
  return String(s || '').replace(/__TM__/g, ' (TM) ').replace(/\s+/g, ' ').trim();
}
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Parse nama file config → {socEscaped, socPretty, ts, label}. Best-effort.
// Format: {GAME}-{brand}-{model}-{SoC}-{ts}.json ; kita udah tau {GAME} (folder).
function parseConfigFile(folder, fileName) {
  let rest = fileName.replace(/\.json$/i, '');
  // buang prefix "{folder}-" kalau ada (folder bisa beda case, cocokin longgar).
  if (rest.toLowerCase().startsWith(folder.toLowerCase() + '-')) {
    rest = rest.slice(folder.length + 1);
  }
  // buang suffix "-{ts}" (timestamp angka di ujung).
  let ts = 0;
  const tsM = rest.match(/-(\d{6,})$/);
  if (tsM) { ts = parseInt(tsM[1], 10); rest = rest.slice(0, tsM.index); }
  // sisanya "brand-model-SoC". Ambil SoC = 2 segmen terakhir umumnya, tp ga pasti.
  // Buat label kita tampil apa adanya (di-unescape), buat match kita simpen raw.
  const socPretty = unescapeSoc(rest.replace(/^[^-]*-[^-]*-/, '') || rest);
  return {
    socEscaped: rest,
    socPretty: unescapeSoc(rest),
    ts,
    label: unescapeSoc(rest),
  };
}

// ============================================================================
//  Build index dari GitHub (tree recursive + games.json + games_canonical).
//  Lazy: cuma jalan kalau cache basi (TTL) atau stamp berubah.
// ============================================================================
async function ensureIndex(force) {
  const now = Date.now();
  if (!force && cache.folders && (now - cache.ts) < cfg.cacheTtlMs) return cache;

  // cek stamp murah dulu; kalau sama & cache ada, cukup refresh ts.
  let stamp = null;
  try {
    const stats = await getJson(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/stats.json`, 64 * 1024);
    stamp = stats && stats.generated_utc ? String(stats.generated_utc) : null;
  } catch { /* stats opsional */ }
  if (!force && cache.folders && stamp && stamp === cache.stamp) {
    cache.ts = now;
    return cache;
  }

  const tree = await getJson(
    `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`,
    cfg.maxIndexBytes
  );
  const entries = (tree && Array.isArray(tree.tree)) ? tree.tree : [];

  const folders = new Map();
  for (const e of entries) {
    if (!e || e.type !== 'blob' || typeof e.path !== 'string') continue;
    const m = e.path.match(/^configs\/([^/]+)\/([^/]+\.json)$/);
    if (!m) continue;
    const folder = m[1];
    const file = m[2];
    const key = folder.toLowerCase();
    if (!folders.has(key)) folders.set(key, { folder, files: [] });
    const info = parseConfigFile(folder, file);
    folders.get(key).files.push({ path: e.path, ...info });
  }

  // nama buat search: folder name + (kalau ada) steam name dari canonical.
  const names = [];
  for (const { folder } of folders.values()) {
    names.push({ key: norm(folder), folder, display: folder });
  }
  try {
    const canon = await getJson(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/games_canonical.json`, cfg.maxIndexBytes);
    if (canon && typeof canon === 'object') {
      for (const appid of Object.keys(canon)) {
        const g = canon[appid];
        if (!g || !g.name || !Array.isArray(g.folders)) continue;
        for (const folder of g.folders) {
          if (folders.has(String(folder).toLowerCase())) {
            names.push({ key: norm(g.name), folder, display: `${g.name}` });
          }
        }
      }
    }
  } catch { /* canonical opsional; folder-name search tetap jalan */ }

  cache = { ts: now, stamp, folders, names };
  log(`[gameconfig] index built: ${folders.size} game, ${names.length} nama-key, stamp=${stamp || '?'}`);
  return cache;
}

// ============================================================================
//  Fuzzy match query → daftar folder. Scoring: term-freq + prefix bonus.
//  Niru pola kb.kbSemanticSearch (lowercase-tokenize + score).
// ============================================================================
function searchGames(query) {
  const q = norm(query).slice(0, 100);   // cap panjang (cegah blowup O(term×names)).
  if (!q) return [];
  if (!cache.names) return [];   // index belum di-build → no match (guard).
  const terms = q.split(' ').filter(Boolean).slice(0, 12);   // cap jumlah term.
  const byFolder = new Map(); // folder → best score

  for (const entry of cache.names) {
    const hay = entry.key;
    if (!hay) continue;
    let score = 0;
    for (const t of terms) {
      if (!hay.includes(t)) continue;
      const freq = hay.split(t).length - 1;
      score += 2 + Math.min(3, freq);
      if (hay.startsWith(t)) score += 2;      // prefix bonus
    }
    // semua term ketemu → boost (match kuat)
    if (terms.every((t) => hay.includes(t))) score += 3;
    // exact
    if (hay === q) score += 10;
    if (score <= 0) continue;
    const prev = byFolder.get(entry.folder);
    if (!prev || score > prev.score) byFolder.set(entry.folder, { folder: entry.folder, display: entry.display, score });
  }
  return Array.from(byFolder.values()).sort((a, b) => b.score - a.score);
}

// ============================================================================
//  Formatter: config JSON → teks rapi. STRIP upload_token duluan.
// ============================================================================
function pickComponent(cfgObj, type) {
  const arr = (cfgObj && Array.isArray(cfgObj.components)) ? cfgObj.components : [];
  const c = arr.find((x) => x && String(x.type).toUpperCase() === type);
  return c && c.name != null ? String(c.name) : null;
}
function decodeName(v) {
  // pc_ls_* "component" = string ber-JSON {"name":"..."} ; sisanya plain string.
  if (v == null) return null;
  if (typeof v === 'object') return v.name != null ? String(v.name) : null;
  const s = String(v);
  if (s.startsWith('{')) { try { const o = JSON.parse(s); return o && o.name != null ? String(o.name) : s; } catch { return s; } }
  return s;
}
function clean(v) {
  const s = v == null ? '' : String(v).trim();
  return (!s || s.toLowerCase() === 'none') ? null : s;
}

function formatConfig(raw, gameLabel) {
  // clone + strip PII (jangan mutate input; buang upload_token & meta sensitif).
  const cfgObj = raw && typeof raw === 'object' ? raw : {};
  const meta = { ...(cfgObj.meta || {}) };
  delete meta.upload_token;   // PII uploader — WAJIB buang.

  const s = (cfgObj.settings && typeof cfgObj.settings === 'object') ? cfgObj.settings : {};
  const b = (s.bl_ext && typeof s.bl_ext === 'object') ? s.bl_ext : {};

  const lines = [];
  lines.push(`🎮 ${gameLabel || 'Game'}`);
  const dev = clean(meta.device), soc = clean(meta.soc);
  if (dev || soc) lines.push(`📱 ${[dev, soc].filter(Boolean).join(' · ')}`);
  if (clean(meta.bh_version)) lines.push(`🏷️ Bannerlator ${meta.bh_version}`);
  lines.push('');

  const row = (label, val) => { const c = clean(val); if (c) lines.push(`${label}: ${c}`); };

  // versi komponen — utamakan components[] (udah decoded), fallback pc_ls_*.
  row('DXVK', pickComponent(cfgObj, 'DXVK') || decodeName(s.pc_ls_DXVK));
  row('VKD3D', pickComponent(cfgObj, 'VKD3D') || decodeName(s.pc_ls_VK3k));
  row('GPU driver', pickComponent(cfgObj, 'GPU') || decodeName(s.pc_ls_GPU_DRIVER_));
  row('FEXCore', pickComponent(cfgObj, 'FEXCore') || decodeName(s.pc_set_constant_95));
  row('Container', decodeName(s.pc_ls_CONTAINER_LIST));
  row('Wrapper', decodeName(s.pc_ls_GRAPHICS_WRAPPER));
  row('Renderer', b.renderer);
  row('Resolusi', b.screenSize);

  // box64
  const box = clean(b.box64Version);
  if (box) row('Box64', `${box}${clean(b.box64Preset) ? ' (' + b.box64Preset + ')' : ''}`);
  row('FEX preset', b.fexcorePreset);
  row('DX wrapper', b.dxwrapper);
  row('Boot option', decodeName(s.pc_ls_boot_option));

  const env = clean(s.pc_ls_environment_variable);
  if (env) { lines.push(''); lines.push('⚙️ Env vars:'); lines.push(env); }

  lines.push('');
  lines.push('⚠️ Setting ini dari HP orang lain — sesuaikan sama device lu, ga semua auto-cocok.');
  lines.push(CREDIT);
  return lines.join('\n');
}

// ============================================================================
//  Pisah nama game vs hint GPU. Repo di-key by GPU (Adreno/Mali/PowerVR/dll),
//  BUKAN chipset. Kalau user nyelipin nama GPU, kita pisah biar (a) match nama
//  game bersih, (b) bisa filter device by GPU. Chipset (Helio/Snapdragon/
//  Dimensity/Exynos) SENGAJA ga di-map ke GPU — data hardware cepet basi; user
//  diarahin ketik GPU-nya lewat auto-list.
const GPU_VENDORS = /\b(adreno|mali|powervr|xclipse|immortalis|maleoon|apple|tegra)\b/i;

function splitGameAndGpu(argline) {
  const toks = String(argline).split(/\s+/).filter(Boolean);
  const vIdx = toks.findIndex((t) => GPU_VENDORS.test(t));
  if (vIdx < 0) return { gameQuery: argline.trim(), gpuHint: '' };
  // dari token vendor ke belakang = hint GPU (vendor + model, mis "mali g57 mc2").
  const gameQuery = toks.slice(0, vIdx).join(' ').trim();
  const gpuHint = toks.slice(vIdx).join(' ').trim();
  return { gameQuery, gpuHint };
}

// ============================================================================
//  Handler command /gameconfig <game> [gpu].
//  ctx: { chatId, userId, sendSafe }.
// ============================================================================
async function handleCommand(msg, ctx) {
  const { chatId, sendSafe } = ctx;
  if (!cfg.enabled) { sendSafe(chatId, '🚧 Fitur game-config lagi dimatiin sementara.'); return; }

  const text = String(msg.text || msg.caption || '');
  const argline = text.replace(/^\/(gameconfig|gc|config)(@\S+)?\s*/i, '').trim().slice(0, 120);
  if (!argline) {
    sendSafe(chatId,
      '🎮 Cari setting game buat Winlator/Bannerlator:\n' +
      '`/gameconfig <nama game>` — mis. `/gameconfig GTA V`\n' +
      'Ada banyak GPU? Tambahin nama GPU (bukan chipset): `/gameconfig GTA V Adreno 750`\n\n' +
      CREDIT);
    return;
  }

  try {
    await ensureIndex(false);
  } catch (e) {
    recordError('gameconfig.index', e);
    errLog('[gameconfig] index gagal:', e.message);
    sendSafe(chatId, '❌ Gagal ambil data config (jaringan). Coba lagi bentar.');
    return;
  }

  // pisah nama game vs hint GPU. Repo di-key by GPU (bukan chipset) — token
  // vendor GPU (adreno/mali/dll) dipisah biar ga ngerusak match nama game.
  const { gameQuery, gpuHint } = splitGameAndGpu(argline);
  const searchQ = gameQuery || argline;
  const matches = searchGames(searchQ);
  if (!matches.length) {
    sendSafe(chatId, `🔍 Ga nemu game "${searchQ.slice(0, 60)}". Coba nama lain / lebih pendek.\n\n${CREDIT}`);
    return;
  }

  // Kumpulin folder kandidat. NFS-style: banyak folder norm-nya identik (uploader
  // beda, game sama). Kalau ada GPU hint, kita sisir SEMUA kandidat sekaligus —
  // user peduli "game X + GPU gua", bukan folder mana. Kalau ga ada GPU hint &
  // game ambigu, baru minta user pilih game (bisa jadi beda game: Black Edition/The Run).
  const top = matches.slice(0, cfg.maxMatches);
  const topScore = top[0].score;
  // kandidat = yg score-nya deket sama top (folder2 "sama" NFS), min 1.
  const near = top.filter((m) => (topScore - m.score) <= 4);
  const clearWinner = matches.length === 1 || (topScore - (top[1] ? top[1].score : 0)) >= 5;

  // pool semua file dari folder kandidat (buat GPU-first).
  const poolFolders = clearWinner ? [top[0]] : near;
  const pool = [];
  for (const m of poolFolders) {
    const r = cache.folders.get(m.folder.toLowerCase());
    if (r) for (const f of r.files) pool.push({ ...f, folder: r.folder, display: m.display });
  }
  if (!pool.length) {
    sendSafe(chatId, `🎮 "${top[0].display}" ada tapi belum ada file config-nya.\n\n${CREDIT}`);
    return;
  }

  // helper: daftar GPU unik dari sebuah pool (tampil apa adanya).
  const listGpusOf = (files) => {
    const uniq = []; const seen = new Set();
    for (const f of files.slice().sort((a, b) => b.ts - a.ts)) {
      const k = f.socPretty.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k); uniq.push(f.socPretty);
      if (uniq.length >= cfg.maxDevices) break;
    }
    return uniq;
  };

  // ---- ADA GPU hint → filter cross-folder by GPU ----
  if (gpuHint) {
    const gpuToks = norm(gpuHint).split(' ').filter((t) => t.length > 1);
    const scored = pool
      .map((f) => {
        const hay = norm(`${f.socPretty} ${f.socEscaped}`);
        return { f, hits: gpuToks.filter((t) => hay.includes(t)).length };
      })
      // butuh SEMUA token match (angka model ga boleh diabaikan: "adreno 999"
      // ga boleh lolos cuma gara2 "adreno" cocok). Fallback ke list kalau 0.
      .filter((x) => x.hits === gpuToks.length && x.hits > 0)
      .sort((a, b) => b.f.ts - a.f.ts);
    if (!scored.length) {
      const label = clearWinner ? top[0].display : `"${searchQ}"`;
      sendSafe(chatId,
        `🎮 ${label} — GPU "${gpuHint.slice(0, 40)}" ga ketemu.\n` +
        `⚠️ Ketik nama GPU-nya (bukan chipset). Yg tersedia:\n` +
        `${listGpusOf(pool).map((s) => `• ${s}`).join('\n')}\n\n${CREDIT}`);
      return;
    }
    await sendConfig(ctx, scored[0].f);
    return;
  }

  // ---- GA ADA GPU hint ----
  // game ambigu (beda game beneran, mis Black Edition/The Run) → minta pilih game.
  if (!clearWinner && matches.length > 1) {
    const list = top.map((m, i) => `${i + 1}. ${m.display}${m.display !== m.folder ? ` (${m.folder})` : ''}`).join('\n');
    sendSafe(chatId,
      `🎮 Ketemu beberapa game/versi. Biar langsung, ketik nama + GPU lu:\n` +
      `\`/gameconfig ${top[0].display} <GPU>\`\n\nAtau pilih yg spesifik:\n${list}\n\n${CREDIT}`);
    return;
  }
  // 1 game jelas tapi banyak GPU → auto-list GPU.
  if (pool.length > 1) {
    sendSafe(chatId,
      `🎮 ${top[0].display} — ada ${pool.length} config buat GPU beda.\n` +
      `⚠️ Ketik nama GPU lu (bukan chipset). Yg tersedia:\n` +
      `${listGpusOf(pool).map((s) => `• ${s}`).join('\n')}\n\n` +
      `Ulang: \`/gameconfig ${top[0].display} <GPU>\`\n\n${CREDIT}`);
    return;
  }
  // 1 game, 1 config → langsung kirim.
  await sendConfig(ctx, pool[0]);
}

// Fetch + format + kirim 1 config file. Dipisah biar dipakai di beberapa cabang.
async function sendConfig(ctx, fileRec) {
  const { chatId, sendSafe } = ctx;
  let rawCfg;
  try {
    const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/` +
      fileRec.path.split('/').map(encodeURIComponent).join('/');
    rawCfg = await getJson(url, cfg.maxConfigBytes);
  } catch (e) {
    recordError('gameconfig.fetch', e);
    errLog('[gameconfig] fetch config gagal:', e.message);
    sendSafe(chatId, '❌ Gagal ambil file config-nya. Coba lagi.');
    return;
  }
  const out = formatConfig(rawCfg, fileRec.folder);
  // plain-text: nilai pihak-3 ga di-parse markdown (anti-injection).
  sendSafe(chatId, out, { parse_mode: undefined });
}

// ============================================================================
function init(opts) {
  bot = opts.bot;
  if (opts.log) log = opts.log;
  if (opts.errLog) errLog = opts.errLog;
  if (opts.recordError) recordError = opts.recordError;
  if (process.env.GAMECONFIG_ENABLED === '0') cfg.enabled = false;
  if (process.env.GAMECONFIG_TTL_MIN) {
    cfg.cacheTtlMs = Math.max(5, parseInt(process.env.GAMECONFIG_TTL_MIN, 10) || 60) * 60 * 1000;
  }
  return { enabled: cfg.enabled, repo: REPO, ttlMin: Math.round(cfg.cacheTtlMs / 60000) };
}

module.exports = {
  init, handleCommand,
  // exports buat test:
  assertSafeUrl, searchGames, formatConfig, parseConfigFile, ensureIndex,
  unescapeSoc, decodeName, splitGameAndGpu, _cfg: cfg, _cache: () => cache,
};
