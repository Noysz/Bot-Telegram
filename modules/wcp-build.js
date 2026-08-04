// modules/wcp-build.js — on-demand WCP builder.
// User bawa .tar.gz (isi binary komponen), COPUX bungkus jadi .wcp siap install.
//
// Alur: user upload .tar.gz (caption /buildwcp ATAU reply ke document) →
//   download (cap 20MB, batas getFile Telegram) → safe-extract ke sandbox temp →
//   auto-detect tipe (DXVK/VKD3D/FEXCore/Box64) + versi → normalisasi struktur
//   (x64→system32, x32→syswow64) → generate profile.json type-aware →
//   repackage tar + xz → kirim .wcp balik ke user → cleanup.
//
// KEAMANAN (input = file arbitrer dari user, treat as hostile):
// - Ekstraksi via `tar` spawn (arg array, NO shell) — nama file user ga pernah
//   kena shell (anti command-injection).
// - Anti tar-slip: sebelum extract, list isi & TOLAK entri absolut / ".." /
//   symlink / hardlink / device. Extract cuma kalau semua entri aman.
// - Anti decompression-bomb: cap total uncompressed + jumlah entri.
// - Sandbox per-request di os.tmpdir, di-rm rekursif di finally (sukses/gagal).
// - Concurrency cap global (build berat CPU/disk).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ---- injected via init() ----
let bot = null;
let log = (...a) => console.log(...a);
let errLog = (...a) => console.error(...a);

const cfg = {
  maxDownloadBytes: 20 * 1024 * 1024,   // batas getFile Telegram
  maxUncompressedBytes: 300 * 1024 * 1024,
  maxEntries: 4000,
  maxConcurrent: 1,                     // build berat → serialisasi default
  spawnTimeoutMs: 90000,
};
let inFlight = 0;

// ============================================================================
//  Util spawn (NO shell) → resolve {code, stdout, stderr}. Timeout + kill.
// ============================================================================
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`${cmd} timeout ${cfg.spawnTimeoutMs}ms`));
    }, cfg.spawnTimeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > 1e6) out = out.slice(-1e6); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 1e6) err = err.slice(-1e6); });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    child.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

// ============================================================================
//  Guard: validasi daftar entri tar SEBELUM extract (anti slip/symlink/bomb).
//  Pakai `tar -tvf` → parse tiap baris. Reject kalau ada yg berbahaya.
// ============================================================================
function assertSafeTarListing(tvfOutput) {
  const lines = tvfOutput.split('\n').filter((l) => l.trim());
  if (lines.length > cfg.maxEntries) throw new Error(`terlalu banyak entri (${lines.length} > ${cfg.maxEntries})`);
  let totalBytes = 0;
  for (const line of lines) {
    // format GNU tar -tvf: "perms owner/group   size date time name[ -> link]"
    const typeChar = line[0];               // '-' file, 'd' dir, 'l' symlink, 'h' hardlink
    if (typeChar === 'l' || typeChar === 'h') throw new Error('entri symlink/hardlink ditolak');
    if (typeChar === 'c' || typeChar === 'b' || typeChar === 'p') throw new Error('entri device/pipe ditolak');
    const sizeMatch = line.match(/\s(\d+)\s+\d{4}-\d{2}-\d{2}/);
    if (sizeMatch) totalBytes += parseInt(sizeMatch[1], 10);
    // ambil nama (setelah kolom waktu). Simpel: bagian setelah "HH:MM ".
    const nameMatch = line.match(/\d{2}:\d{2}\s+(.+)$/);
    let name = nameMatch ? nameMatch[1] : '';
    if (name.includes(' -> ')) name = name.split(' -> ')[0];  // symlink udah ditolak, jaga2
    if (!name) continue;
    if (path.isAbsolute(name) || name.startsWith('/')) throw new Error(`path absolut ditolak: ${name}`);
    // normalisasi & cek escape ".."
    const norm = path.normalize(name);
    if (norm.startsWith('..') || norm.includes('/../') || norm === '..') throw new Error(`path traversal ditolak: ${name}`);
  }
  if (totalBytes > cfg.maxUncompressedBytes) throw new Error(`uncompressed > cap (${totalBytes} > ${cfg.maxUncompressedBytes})`);
  return { entries: lines.length, totalBytes };
}

// ============================================================================
//  Safe extract: list dulu (validasi), baru extract ke sandbox.
// ============================================================================
async function safeExtract(tarPath, destDir) {
  const lst = await run('tar', ['-tvf', tarPath]);
  if (lst.code !== 0) throw new Error(`tar list gagal: ${(lst.stderr || '').slice(0, 120)}`);
  const info = assertSafeTarListing(lst.stdout);
  const ex = await run('tar', [
    '-xf', tarPath, '-C', destDir,
    '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir',
  ]);
  if (ex.code !== 0) throw new Error(`tar extract gagal: ${(ex.stderr || '').slice(0, 120)}`);
  return info;
}

// ============================================================================
//  Cari root payload sebenarnya (buang wrapper "./" atau 1 folder pembungkus).
// ============================================================================
function resolveRoot(destDir) {
  let cur = destDir;
  for (let i = 0; i < 3; i++) {
    const kids = fs.readdirSync(cur, { withFileTypes: true }).filter((d) => d.name !== '.' && d.name !== '..');
    // kalau cuma 1 subfolder pembungkus & ga ada file di level ini → turun.
    if (kids.length === 1 && kids[0].isDirectory()) { cur = path.join(cur, kids[0].name); continue; }
    break;
  }
  return cur;
}

// list semua file relatif (buat detect + profile).
function walkFiles(root, base = root, acc = []) {
  for (const d of fs.readdirSync(base, { withFileTypes: true })) {
    if (d.name === '.' || d.name === '..') continue;
    const full = path.join(base, d.name);
    if (d.isDirectory()) walkFiles(root, full, acc);
    else if (d.isFile()) acc.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return acc;
}

// ============================================================================
//  Normalisasi struktur: rename x64→system32, x32/x86→syswow64 (gaya toolkit).
//  Idempoten: kalau udah system32/syswow64, biarin.
// ============================================================================
function normalizeStructure(root) {
  const ren = { x64: 'system32', x32: 'syswow64', x86: 'syswow64' };
  for (const from of Object.keys(ren)) {
    const src = path.join(root, from);
    const dst = path.join(root, ren[from]);
    if (fs.existsSync(src) && fs.statSync(src).isDirectory() && !fs.existsSync(dst)) {
      fs.renameSync(src, dst);
    }
  }
}

// ============================================================================
//  Auto-detect tipe dari daftar file (basename lowercase).
// ============================================================================
function detectType(files) {
  const base = files.map((f) => f.split('/').pop().toLowerCase());
  const has = (n) => base.includes(n);
  if (base.some((b) => b === 'box64')) return 'Box64';
  if (has('libarm64ecfex.dll') || has('libwow64fex.dll')) return 'FEXCore';
  if (has('d3d12core.dll') || has('d3d12.dll')) return 'VKD3D';
  if (has('d3d11.dll') || has('dxgi.dll') || has('d3d9.dll') || has('d3d10core.dll')) return 'DXVK';
  return null;
}

// ============================================================================
//  Bangun layout final + profile.json (type-aware, verified dari sample asli).
//  Return { files:[{source,target}], stage:[relpath...] } atau throw.
// ============================================================================
function buildProfile(root, type) {
  const all = walkFiles(root);
  const files = [];
  const stage = [];
  const pushMap = (rel, target) => { files.push({ source: rel, target }); stage.push(rel); };

  if (type === 'Box64') {
    const bin = all.find((f) => f.split('/').pop() === 'box64');
    if (!bin) throw new Error('binary "box64" ga ketemu di arsip');
    if (bin !== 'box64') fs.renameSync(path.join(root, bin), path.join(root, 'box64'));
    try { fs.chmodSync(path.join(root, 'box64'), 0o755); } catch {}  // box64 wajib executable.
    pushMap('box64', '${bindir}/box64');
  } else if (type === 'FEXCore') {
    const fex = all.filter((f) => /(?:^|\/)(libarm64ecfex|libwow64fex)\.dll$/i.test(f));
    if (!fex.length) throw new Error('DLL FEX (libarm64ecfex/libwow64fex) ga ketemu');
    fs.mkdirSync(path.join(root, 'system32'), { recursive: true });
    for (const f of fex) {
      const bn = f.split('/').pop();
      const rel = `system32/${bn}`;
      if (f !== rel) fs.renameSync(path.join(root, f), path.join(root, rel));
      pushMap(rel, '${system32}/' + bn);
    }
  } else { // DXVK / VKD3D → system32 + syswow64
    for (const dir of ['system32', 'syswow64']) {
      const dpath = path.join(root, dir);
      if (!fs.existsSync(dpath)) continue;
      const ph = dir === 'system32' ? '${system32}' : '${syswow64}';
      for (const f of walkFiles(root, dpath)) {
        const bn = f.split('/').pop();
        pushMap(`${dir}/${bn}`, `${ph}/${bn}`);
      }
    }
    if (!files.length) throw new Error('ga ada file di system32/ atau syswow64/ (struktur ga dikenali)');
  }
  return { files, stage };
}

// ============================================================================
//  Repackage: tulis profile.json + tar (member eksplisit) + xz → .wcp.
// ============================================================================
async function repackage(root, type, versionName, stageFiles, profileFiles, outPath) {
  const profile = {
    type,
    versionName,
    versionCode: 0,
    description: `${type} ${versionName}`,
    author: 'COPUX',
    files: profileFiles,
  };
  fs.writeFileSync(path.join(root, 'profile.json'), JSON.stringify(profile, null, 2), 'utf8');
  const members = ['profile.json', ...stageFiles];  // eksplisit → ga nyertain sampah.
  const tarOut = outPath + '.tar';
  const t = await run('tar', ['-cf', tarOut, '-C', root, ...members]);
  if (t.code !== 0) throw new Error(`tar create gagal: ${(t.stderr || '').slice(0, 120)}`);
  const x = await run('xz', ['-z', '-9', '-C', 'crc64', '-f', tarOut]); // → tarOut.xz
  if (x.code !== 0) throw new Error(`xz gagal: ${(x.stderr || '').slice(0, 120)}`);
  fs.renameSync(tarOut + '.xz', outPath);
  return outPath;
}

function normalizeType(t) {
  const m = String(t || '').trim().toLowerCase();
  if (m === 'dxvk' || m === 'd7vk') return 'DXVK';
  if (m === 'vkd3d' || m === 'vkd3d-proton') return 'VKD3D';
  if (m === 'fexcore' || m === 'fex') return 'FEXCore';
  if (m === 'box64') return 'Box64';
  return null;
}

function safeVersionFromName(origName, hint) {
  if (hint) return String(hint).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60) || 'unknown';
  let n = String(origName || 'component');
  n = n.replace(/\.(tar\.gz|tgz|tar\.xz|txz|tar)$/i, '');
  return n.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'component';
}

function cleanup(work) {
  if (!work) return;
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
}

// ============================================================================
//  Orkestrasi build 1 arsip → { ok, wcpPath, ... } | { needType:true }.
// ============================================================================
async function buildFromArchive({ localTar, origName, typeHint, versionHint }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wcpbuild-'));
  const extractDir = path.join(work, 'x');
  fs.mkdirSync(extractDir);
  try {
    const info = await safeExtract(localTar, extractDir);
    const root = resolveRoot(extractDir);
    normalizeStructure(root);
    const type = normalizeType(typeHint) || detectType(walkFiles(root));
    if (!type) { cleanup(work); return { needType: true }; }
    const versionName = safeVersionFromName(origName, versionHint);
    const { files, stage } = buildProfile(root, type);
    const outPath = path.join(work, `${type}-${versionName}.wcp`);
    await repackage(root, type, versionName, stage, files, outPath);
    return { ok: true, wcpPath: outPath, type, versionName, fileCount: files.length, work, srcBytes: info.totalBytes };
  } catch (e) {
    cleanup(work);
    throw e;
  }
}

// ============================================================================
//  Command handler /buildwcp — download document, build, kirim balik ke user.
//  ctx: { chatId, sendSafe }. msg = pesan Telegram.
// ============================================================================
async function handleCommand(msg, ctx) {
  const { chatId, sendSafe } = ctx;
  const doc = msg.document || (msg.reply_to_message ? msg.reply_to_message.document : null);
  if (!doc) {
    sendSafe(chatId, '📎 Kirim `.tar.gz` sbg document + caption `/buildwcp`, ATAU reply `/buildwcp` ke document-nya.\nOpsional: `/buildwcp DXVK 3.0.2` set tipe+versi manual.');
    return;
  }
  const name = String(doc.file_name || '');
  if (!/\.(tar\.gz|tgz|tar\.xz|txz|tar)$/i.test(name)) {
    sendSafe(chatId, `❌ Format ga didukung: \`${name.slice(0, 60)}\`. Kirim .tar.gz / .tgz / .tar.xz.`);
    return;
  }
  if (doc.file_size && doc.file_size > cfg.maxDownloadBytes) {
    sendSafe(chatId, `❌ File ${(doc.file_size / 1048576).toFixed(1)}MB > batas ${cfg.maxDownloadBytes / 1048576}MB (limit Telegram getFile).`);
    return;
  }
  if (inFlight >= cfg.maxConcurrent) { sendSafe(chatId, '⏳ Lagi ada build jalan, coba lagi bentar.'); return; }

  const argline = String(msg.caption || msg.text || '').replace(/^\/buildwcp(@\S+)?\s*/i, '').trim();
  const parts = argline.split(/\s+/).filter(Boolean);
  const typeHint = parts[0] || null;
  const versionHint = parts[1] || null;

  inFlight++;
  const tmpTar = path.join(os.tmpdir(), `wcpin-${process.pid}-${Date.now()}.bin`);
  let result = null;
  try {
    sendSafe(chatId, '⏳ Download & build .wcp…');
    const axios = require('axios');
    const link = await bot.getFileLink(doc.file_id);
    const res = await axios.get(link, { responseType: 'stream', timeout: 60000, maxContentLength: cfg.maxDownloadBytes });
    await new Promise((resolve, reject) => {
      let bytes = 0, aborted = false;
      const ws = fs.createWriteStream(tmpTar);
      const fail = (e) => { if (aborted) return; aborted = true; res.data.destroy(); ws.destroy(); reject(e); };
      res.data.on('data', (c) => { bytes += c.length; if (bytes > cfg.maxDownloadBytes) fail(new Error('file > cap')); });
      res.data.on('error', fail); ws.on('error', fail);
      ws.on('finish', () => { if (!aborted) resolve(); });
      res.data.pipe(ws);
    });

    result = await buildFromArchive({ localTar: tmpTar, origName: name, typeHint, versionHint });
    if (result.needType) {
      sendSafe(chatId, '🤔 Tipe komponen ga kedeteksi. Ulangi dgn tipe eksplisit:\n`/buildwcp DXVK <versi>` (atau VKD3D / FEXCore / Box64).');
      return;
    }
    const cap = `✅ ${result.type} — ${result.versionName}\n📦 ${result.fileCount} file dibungkus.\n⚠️ Test dulu sebelum dipakai serius.`;
    await bot.sendDocument(chatId, result.wcpPath, { caption: cap }, { filename: path.basename(result.wcpPath), contentType: 'application/octet-stream' });
    log(`[wcpbuild] ok: ${result.type} ${result.versionName} (${result.fileCount} file)`);
  } catch (e) {
    errLog('[wcpbuild] gagal:', e.message);
    sendSafe(chatId, `❌ Build gagal: ${String(e.message || e).slice(0, 160)}`);
  } finally {
    inFlight--;
    try { fs.unlinkSync(tmpTar); } catch {}
    if (result && result.work) cleanup(result.work);
  }
}

function init(opts) {
  bot = opts.bot;
  if (opts.log) log = opts.log;
  if (opts.errLog) errLog = opts.errLog;
  if (process.env.WCP_BUILD_MAX_MB) cfg.maxDownloadBytes = Math.max(1, parseInt(process.env.WCP_BUILD_MAX_MB, 10) || 20) * 1024 * 1024;
  if (process.env.WCP_BUILD_MAX_CONCURRENT) cfg.maxConcurrent = Math.max(1, parseInt(process.env.WCP_BUILD_MAX_CONCURRENT, 10) || 1);
  return { maxMB: Math.round(cfg.maxDownloadBytes / 1048576), maxConcurrent: cfg.maxConcurrent };
}

module.exports = {
  init, handleCommand, buildFromArchive,
  assertSafeTarListing, detectType, normalizeType, normalizeStructure,
  buildProfile, resolveRoot, walkFiles, safeVersionFromName, run, _cfg: cfg,
};
