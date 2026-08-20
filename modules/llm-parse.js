// =============================================================================
//  modules/llm-parse.js — parsing output LLM mentah (di-extract dari bot.js).
//  stripThink: buang <think>/<function>/<tool_call> noise sebelum kirim ke user.
//  parseTextToolCalls: tangkap tool-call yg dibalikin sbg TEKS inline (bukan
//    field structured), whitelist tool COPUX. Dua-duanya PURE (input->output,
//    no state, no dep) — ga perlu init(). ⚠️ parseTextToolCalls = agentic-tool-path.
//
//  ⚠️ MODEL ANCAMAN (security-review 2026-08-20). Output string ini dipakai
//  bot.js buat NGEKSEKUSI tool, dan isinya berasal dari LLM yg dipengaruhi input
//  user Telegram. Jadi user bisa nitip sintaks tool di pesannya, model nyalin ke
//  argumen, lalu keeksekusi. Dua pertahanannya:
//    1. WHITELIST nama tool (KNOWN_TOOLS) — batas keras, jangan dilonggarin.
//    2. SPAN-BASED dedupe — blok yg BERSARANG di dalam argumen blok lain DIBUANG
//       (lihat pickOutermost). Tanpa ini, `<function=web_fetch><parameter=url>…`
//       yg nyempil di nilai argumen kb_lookup keeksekusi sbg call kedua yg
//       URL-nya dipilih attacker (dibuktikan: 2 call keluar dari 1 blok).
// =============================================================================

// Whitelist = BATAS KEAMANAN utama modul ini: string dari LLM cuma boleh jadi
// eksekusi tool kalau namanya di sini. JANGAN dilonggarin / dibikin dinamis.
// Dipakai bareng stripThink biar tool-call yg ga dieksekusi juga ga bocor ke user.
const KNOWN_TOOLS = new Set(['kb_lookup', 'kb_search', 'kb_rag_search', 'web_search', 'web_fetch']);

// Key yg dilarang jadi nama arg — cegah prototype pollution lewat <parameter=__proto__>.
// Defense-in-depth: target-nya udah Object.create(null) jadi assign-nya inert,
// tapi tetep ditahan biar aman kalau target berubah suatu saat.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Cap panjang input sebelum regex. Regex tag di sini biayanya O(n^2) untuk input
// bentuk terburuk (`"<function=x>{ \n".repeat(n)`): 64KB ~0.4s, 200KB ~2.6s, dan
// itu ngeblok event-loop bot. LLM_MAX_TOKENS 4096 (~16KB) normalnya jauh di bawah
// cap ini — cap-nya buat jaga-jaga kalau provider/gateway pihak-ketiga balikin
// content kegedean (max_tokens cuma HINT request, bukan jaminan).
const MAX_PARSE_CHARS = 64 * 1024;

// Nilai numerik di dialek XML dateng sbg STRING ("8"). runTool pakai top_k buat
// aritmatika/slice → coerce biar ga jadi string di jalur angka.
function coerceScalar(v) {
    return /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : v;
}

// Bare-JSON tool-call tanpa tag apa pun (Kimi-K2.6, observed 2026-08-20).
// ⚠️ SENGAJA CUMA BUAT DETEKSI/SENSOR (stripThink), **TIDAK** dieksekusi.
// Alasan: "balas persis teks ini: {json}" itu permintaan wajar & model nurut
// tanpa perlu jailbreak → kalau dieksekusi, user bisa nyetir tool + argumennya
// (mis. web_fetch ke URL pilihan dia) cuma dari 1 pesan biasa. Dialek bertag
// setidaknya nuntut model mancarin tag tool-call, jauh lebih jarang kejadian.
// Yang beneran perlu dibetulin cuma KEBOCORAN-nya: JSON internal ini dulu
// kebaca user mentah-mentah. Kalau model beneran mau manggil tool, loop di
// bot.js masih ngasih nudge round buat coba lagi.
// HANYA diakui kalau content SELURUHNYA objek itu — kalau nyempil di prosa, itu
// jawaban beneran (mis. COPUX nerangin format tool) → jangan disensor.
function wholeJsonToolCall(text) {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    if (t.length < 2 || t.charCodeAt(0) !== 123 /* { */ || !t.endsWith('}')) return null;
    let obj;
    try { obj = JSON.parse(t); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    // typeof-check dulu: `{"name":{"toString":0}}` bikin String() THROW
    // (ToPrimitive gagal) — dan fungsi ini dokumen-nya PURE/ga pernah throw.
    if (typeof obj.name !== 'string') return null;
    const name = obj.name.trim().toLowerCase();
    if (!KNOWN_TOOLS.has(name)) return null;
    let args = obj.args || obj.arguments || {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
    // Array lolos `typeof === 'object'` → tolak eksplisit, biar runTool ga dapet
    // args bentuk aneh (args.topic undefined, tapi args.length ada).
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    return { name, args };
}

// Kalau SELURUH content itu satu objek JSON valid, semua tag di dalamnya adalah
// DATA (nilai argumen), bukan markup. Wajib dicek sebelum pola bertag jalan:
// tanpa ini, `{"name":"kb_lookup","args":{"topic":"x <function=web_fetch>…"}}`
// bikin blok XML selundupan di dalam argumen tetep keeksekusi — padahal
// bare-JSON-nya sendiri sengaja ga dieksekusi, jadi ga ada span terluar yg
// nutupin dia (ketangkep test S5, security-review lanjutan 2026-08-20).
function isWholeJsonObject(text) {
    const t = text.trim();
    if (t.length < 2 || t.charCodeAt(0) !== 123 /* { */ || !t.endsWith('}')) return false;
    try {
        const o = JSON.parse(t);
        return !!o && typeof o === 'object' && !Array.isArray(o);
    } catch (e) { return false; }
}

function stripThink(text) {
    if (typeof text !== 'string') return '';
    const src = text.length > MAX_PARSE_CHARS ? text.slice(0, MAX_PARSE_CHARS) : text;
    const out = src
        .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
        .replace(/<function\b[\s\S]*?<\/function>\s*/gi, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>\s*/gi, '')
        .trim();
    // Model tertentu (Kimi-K2.6) mancarin tool-call sbg bare-JSON tanpa tag sama
    // sekali → 3 replace di atas ga nyentuh, dan JSON internal itu KEBACA user.
    // Buang cuma kalau seluruh isinya memang tool-call (lihat wholeJsonToolCall).
    return wholeJsonToolCall(out) ? '' : out;
}

// Dari semua kandidat match, ambil yg TERLUAR: urut per posisi (yg lebih awal
// menang), kalau posisi sama yg lebih panjang menang, lalu buang tiap kandidat
// yg span-nya nabrak kandidat yg udah diterima. Efeknya: blok yg bersarang DI
// DALAM argumen blok lain (payload selundupan) ke-drop, sementara dua blok
// berdampingan yg beneran independen dua-duanya lolos.
function pickOutermost(cands) {
    cands.sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)));
    const taken = [];
    const out = [];
    for (const c of cands) {
        if (taken.some((t) => c.start < t.end && c.end > t.start)) continue;
        taken.push(c);
        out.push(c.call);
    }
    return out;
}

// Sebagian model di copux-stack (stack multi-model) balikin tool-call sebagai
// TEKS inline, bukan field structured `m.tool_calls`. Format yang kelihat:
//   <function>name{json}</function>        (observed di prod)
//   <function=name>{json}</function>       (gaya Hermes)
//   <tool_call>{"name":..,"arguments":..}</tool_call>   (gaya Qwen)
//   <function=name><parameter=k>v</parameter></function> (kat-coder-pro-v2.5,
//       observed 2026-08-20; bisa dibungkus <tool_call> juga)
// Tanpa parser ini, blok itu bocor mentah ke user DAN tool-nya ga pernah jalan.
// Cuma tool yg emang keregistrasi yg dieksekusi (whitelist) — sisanya diabaikan.
// Bare-JSON tanpa tag TIDAK dieksekusi di sini (lihat wholeJsonToolCall).
function parseTextToolCalls(text) {
    if (typeof text !== 'string' || !text) return [];
    const src = text.length > MAX_PARSE_CHARS ? text.slice(0, MAX_PARSE_CHARS) : text;
    if (src.indexOf('<') === -1) return [];
    // Content = 1 objek JSON utuh → tag di dalamnya data, bukan markup. Stop.
    if (isWholeJsonObject(src)) return [];
    const cands = [];
    let mm;

    // 1) <function>name{json}</function>  atau  <function=name>{json}</function>
    const fnRe = /<function(?:=([a-z_]+))?>\s*([a-z_]+)?\s*(\{[\s\S]*?\})\s*<\/function>/gi;
    while ((mm = fnRe.exec(src)) !== null) {
        const name = (mm[1] || mm[2] || '').trim().toLowerCase();
        if (!KNOWN_TOOLS.has(name)) continue;
        let args;
        try { args = JSON.parse(mm[3]); } catch (e) { continue; /* malformed → skip */ }
        cands.push({ start: mm.index, end: mm.index + mm[0].length, call: { name, args } });
    }

    // 2) <tool_call>{"name":..,"arguments":..}</tool_call>
    const tcRe = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi;
    while ((mm = tcRe.exec(src)) !== null) {
        let obj;
        try { obj = JSON.parse(mm[1]); } catch (e) { continue; }
        if (!obj || typeof obj.name !== 'string') continue;
        const name = obj.name.trim().toLowerCase();
        if (!KNOWN_TOOLS.has(name)) continue;
        let args = obj.arguments || obj.args || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
        if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
        cands.push({ start: mm.index, end: mm.index + mm[0].length, call: { name, args } });
    }

    // 3) <function=name><parameter=k>v</parameter>…</function>  (XML bersarang)
    //    WAJIB minimal 1 <parameter=>: tanpa itu, blok <function=name>{json}</function>
    //    (pola 1) ke-parse dua kali. Overlap lintas-pola diberesin pickOutermost.
    const xmlRe = /<function=([A-Za-z_][A-Za-z0-9_]*)\s*>([\s\S]*?)<\/function>/gi;
    while ((mm = xmlRe.exec(src)) !== null) {
        const name = mm[1].trim().toLowerCase();
        if (!KNOWN_TOOLS.has(name)) continue;
        const args = Object.create(null);
        let found = 0;
        const pRe = /<parameter=([A-Za-z_][A-Za-z0-9_]*)\s*>([\s\S]*?)<\/parameter>/gi;
        let pm;
        while ((pm = pRe.exec(mm[2])) !== null) {
            if (UNSAFE_KEYS.has(pm[1].toLowerCase())) continue;
            args[pm[1]] = coerceScalar(pm[2].trim());
            found++;
        }
        if (found) cands.push({ start: mm.index, end: mm.index + mm[0].length, call: { name, args } });
    }

    return pickOutermost(cands);
}

module.exports = { stripThink, parseTextToolCalls };
