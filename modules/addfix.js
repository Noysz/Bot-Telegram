// =============================================================================
//  modules/addfix.js — Community KB pipeline (di-extract dari bot.js, refactor).
//  readAddfix (baca addfix.jsonl), sanitizeKbBody, promoteAddfix (append
//  community.md), takeAddfixByTs (reject/promote per-item). Fungsi VERBATIM.
//  ⚠️ sanitizeKbBody = GATE ANTI-INJEKSI (user-content -> KB -> LLM): strip
//     [META] role-spoof, fake confidence tag ([VERIFIED] dst), markdown
//     heading/hr, cap 2000 char. JANGAN ubah logic tanpa security-review.
//  Path (ADDFIX_FILE/COMMUNITY_KB/KB_DIR) di-INJECT resolved dari bot.js via
//  init() — ADDFIX_FILE & KB_DIR dipakai juga di bot.js (handler write/rename).
// =============================================================================

const fs = require('fs');

// --- injected via init() dari bot.js ---
let ADDFIX_FILE = null;    // path addfix.jsonl (resolved)
let COMMUNITY_KB = null;   // path community.md (resolved)
let KB_DIR = null;         // path kb/ (resolved, buat mkdirSync)

const PROMOTE_MAX = 500;   // cap entry per promote — cegah memory spike / event-loop freeze (sec F4).

// ===================== VERBATIM bot.js 1060-1126 ============================
function readAddfix() {
    try {
        if (!fs.existsSync(ADDFIX_FILE)) return [];
        return fs.readFileSync(ADDFIX_FILE, 'utf8')
            .split('\n').filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
            .filter(Boolean)
            .slice(0, PROMOTE_MAX);
    } catch (e) {
        console.error('Gagal baca addfix:', e.message);
        return [];
    }
}

// Sanitasi konten user sebelum masuk KB yg di-feed LLM. Tangkis 3 vektor injeksi:
//  1. [META] role-spoof (sama kayak guard handler).
//  2. confidence tag palsu ([VERIFIED] dst) — user ga boleh naikin priority sort.
//  3. markdown heading / hr — cegah body ke-split jadi section baru tanpa label di loadKB.
function sanitizeKbBody(s) {
    return String(s || '')
        .replace(/\[META(?:\s[^\]]*)?\]/gi, '[meta-filtered]')
        .replace(/\[(VERIFIED|REVEALED\s*PREF(?:ERENCE)?|THEORETICAL)[^\]]*\]/gi, '(tag-filtered)')
        .replace(/^\s*#+\s*/gm, '')          // strip heading '#','##',...
        .replace(/^\s*-{3,}\s*$/gm, '')        // strip '---' hr (pemisah section visual)
        .slice(0, 2000);
}

// Tulis entry addfix ke community.md. User-content disanitasi (strip [META] anti-spoof,
// sama kayak guard di handler) + di-cap [REVEALED PREFERENCE] biar kb_lookup ga
// nyamain bobotnya sama ground-truth maintainer.
function promoteAddfix(entries) {
    fs.mkdirSync(KB_DIR, { recursive: true });   // guard: kb/ mungkin belum ada di fresh install.
    let block = '';
    for (const e of entries) {
        const name = sanitizeKbBody(e.name || 'anon').replace(/\s+/g, ' ').slice(0, 40);
        const body = sanitizeKbBody(e.content || '');
        const date = new Date(e.ts || Date.now()).toISOString().slice(0, 10);
        block += `\n## [COMMUNITY] kontribusi ${name} (${date})\n`
            + `[REVEALED PREFERENCE] report real member via /addfix — bukan ground-truth maintainer, verifikasi sebelum jadiin patokan mutlak.\n`
            + `${body}\n`;
    }
    const header = fs.existsSync(COMMUNITY_KB)
        ? ''
        : '# Community Fixes\n_Kontribusi member via /addfix, di-promote admin. Confidence: [REVEALED PREFERENCE] — real-world report, bukan maintainer ground-truth._\n';
    fs.appendFileSync(COMMUNITY_KB, header + block);
}

// Ambil (dan hapus) satu entry addfix berdasarkan ts, buat tombol Reject/Promote per-item.
// Baca SEMUA baris (bukan slice PROMOTE_MAX) biar rewrite ga ngedrop entry ke-501+.
// Baris korup (JSON invalid) dipertahankan apa adanya — jangan hancurin data yg ga kebaca.
// Return entry yg dihapus, atau null kalau ts ga ketemu (mis. udah diproses klik lain).
function takeAddfixByTs(ts) {
    if (!fs.existsSync(ADDFIX_FILE)) return null;
    const lines = fs.readFileSync(ADDFIX_FILE, 'utf8').split('\n').filter(Boolean);
    let removed = null;
    const keep = [];
    for (const l of lines) {
        let obj = null;
        try { obj = JSON.parse(l); } catch (e) { keep.push(l); continue; }
        if (!removed && obj && Number(obj.ts) === ts) { removed = obj; continue; }
        keep.push(l);
    }
    if (!removed) return null;
    if (keep.length) fs.writeFileSync(ADDFIX_FILE, keep.join('\n') + '\n');
    else { try { fs.unlinkSync(ADDFIX_FILE); } catch (e) {} }   // kosong → hapus file (samain semantik 'udah promote').
    return removed;
}

// ============================ dep injection =================================
function init(deps) {
    deps = deps || {};
    if (deps.ADDFIX_FILE !== undefined) ADDFIX_FILE = deps.ADDFIX_FILE;
    if (deps.COMMUNITY_KB !== undefined) COMMUNITY_KB = deps.COMMUNITY_KB;
    if (deps.KB_DIR !== undefined) KB_DIR = deps.KB_DIR;
}

module.exports = { init, readAddfix, sanitizeKbBody, promoteAddfix, takeAddfixByTs };
