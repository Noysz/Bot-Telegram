// =============================================================================
//  COPUX-FourFect Bot — Telegram (Node.js)
//  Versi gabungan: agentic loop (V1) + persistent history & rate limit (V2)
//
//  Sumber acuan:
//    - /root/memori claude/bot copux.txt   (V1, 16 poin lengkap)
//    - /root/memori claude/text.txt        (V2, persistent + rate + /addfix)
// =============================================================================

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FREEMODEL_KEY = process.env.FREEMODEL_KEY;
if (!TELEGRAM_TOKEN || !FREEMODEL_KEY) {
    console.error('❌  TELEGRAM_TOKEN / FREEMODEL_KEY belum di-set. Isi dulu file .env!');
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Identitas bot — buat deteksi mention & reply di grup.
let BOT_USERNAME = '';
let BOT_ID = null;
bot.getMe().then((me) => {
    BOT_USERNAME = me.username;
    BOT_ID = me.id;
    console.log(`✅  Bot @${me.username} (id ${me.id}) siap.`);
}).catch((e) => console.error('Gagal getMe:', e.message));

const MODEL = 'gpt-5.5';
const MAX_HISTORY = 10;
const MAX_FILE_SIZE = 1024 * 1024;          // 1 MB
const SESSION_TTL = 1000 * 60 * 60 * 6;     // 6 jam
const SAVE_DEBOUNCE_MS = 5000;

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const ADDFIX_FILE = path.join(DATA_DIR, 'addfix.jsonl');

const ADMIN_IDS = new Set(
    (process.env.ADMIN_IDS || '')
        .split(',').map((s) => s.trim()).filter(Boolean)
);

// Rate limit per-user: cooldown antar pesan + cap window
const RATE_COOLDOWN_MS = 5 * 1000;          // minimal 5s antar pesan
const RATE_MAX = 20;                        // dan/atau maks 20 pesan
const RATE_WINDOW_MS = 60 * 1000;           // per 60s
const RATE_WARN_COOLDOWN_MS = 5 * 60 * 1000;
const rateLog = new Map();
const rateLastAt = new Map();
const rateWarnedAt = new Map();

const chatHistory = {};
const lastActive = {};

// =============================================================================
//  PERSISTENCE — load saat boot, save atomic + debounce
// =============================================================================

function loadHistory() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        const now = Date.now();
        let n = 0;
        for (const k in raw) {
            const rec = raw[k];
            if (!rec || !Array.isArray(rec.history)) continue;
            if (now - (rec.lastActive || 0) > SESSION_TTL) continue;
            chatHistory[k] = rec.history;
            lastActive[k] = rec.lastActive || now;
            n++;
        }
        console.log(`💾 history di-load: ${n} sesi dari disk`);
    } catch (e) {
        console.error('Gagal load history.json (mulai fresh):', e.message);
    }
}

let saveTimer = null;
function snapshot() {
    const out = {};
    for (const k in chatHistory) {
        out[k] = { history: chatHistory[k], lastActive: lastActive[k] || Date.now() };
    }
    return JSON.stringify(out);
}
// Atomic write: tulis tmp dulu lalu rename — anti-korup kalau crash di tengah.
function saveHistory() {
    try {
        const tmp = HISTORY_FILE + '.tmp';
        fs.writeFileSync(tmp, snapshot());
        fs.renameSync(tmp, HISTORY_FILE);
    } catch (e) {
        console.error('Gagal simpan history:', e.message);
    }
}
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveHistory(); }, SAVE_DEBOUNCE_MS);
}

// Simpan history pas mau mati (pm2 restart kirim SIGINT) biar obrolan ga ilang.
function shutdown(sig) {
    console.log(`\n${sig} diterima — simpan history lalu keluar.`);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveHistory();
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

fs.mkdirSync(DATA_DIR, { recursive: true });
loadHistory();

// =============================================================================
//  SYSTEM PROMPT (persona COPUX-FourFect — versi 2 KELUARGA emulator)
// =============================================================================

const SYSTEM_PROMPT = `Lu adalah COPUX-FourFect, asisten PAKAR emulator PC-di-Android. Tugas utama lu: bantu user BIKIN, SETTING, dan NGASIH SARAN + troubleshooting biar game/aplikasi PC jalan mulus di HP Android mereka.

DOMAIN KEAHLIAN (wajib paham dalem) — ADA 2 KELUARGA EMULATOR, JANGAN cuma tau Winlator:
- KELUARGA A (Winlator-type, Wine+Box64, container, install game .exe MANUAL): brunodev85/winlator (BASE resmi), coffincolors, Winlator-Ludashi (StevenMXZ, basis Bionic), Pipetto-crypto (dev, fokus performa), REF4IK, Ajay. Plus generasi lama (Cmod Bionic/GLibc, Frost) — tau bedanya Bionic vs GLibc.
- KELUARGA B (GameHub/Native-type, integrasi store Steam/Epic/GOG, sering basis FEX): GameNative (utkarshdalal — paling besar), WinNative, GameHub Lite (Producdevity), BannerHub + Bannerhub-Lite/revanced (The412Banner), Mobox (via Termux).
- PENTING: jangan reflek nyaranin Winlator doang. Pahami maunya user dulu, lalu kasih opsi yang relevan dari KEDUA keluarga.
- Komponen inti: Box64/Box86 (preset COMPATIBILITY/INTERMEDIATE/PERFORMANCE & env var BOX64_*), FEX (buat keluarga B), Wine/Proton (versi & wineprefix), Termux (buat Mobox).
- Grafis: DXVK (versi & DXVK_* env, fork performa star-emu/vegas & d8vk buat DX8), WineD3D, VKD3D; driver GPU — Turnip/Mesa (DEFAULT buat Adreno), Zink; MESA_VK_WSI_PRESENT_MODE, ZINK_*, dll.
- Tuning: env var (BOX64_*/DXVK_*/MESA_*) + dxvk.conf — JANGAN cuma ngandelin preset GUI. Alokasi RAM/CPU core (affinity), resolusi/DPI container, audio (ALSA/Pulse), FPS overlay.
- Dependency Windows: VCRedist, .NET, DirectX runtime, cnc-ddraw (game 2D jadul), install via winetricks/exe.
- Hardware awareness: Adreno (Snapdragon) -> Turnip (open-source freedreno, paling matang). Mali (Exynos/MediaTek) -> BUKAN Turnip, pakai VirGL/Zink/WineD3D atau ExynosTools. Cek Android version & arch.
- ANTI-JADUL: setting "Vortek/VirGL buat semua" itu USANG. Buat Adreno modern, default = Turnip + DXVK. VirGL/Vortek/WineD3D cuma buat Mali atau game DX9 lawas tertentu — JANGAN jadiin saran utama buat Adreno.

CARA KERJA:
1. Bahasa Indonesia santai/gaul, tapi JELAS dan teknis. To the point, jangan kebanyakan minta maaf.
2. Kasih langkah-langkah konkret (step by step) yang bisa langsung dipraktekin, sebut menu/opsi spesifik di emulatornya.
3. Kalau butuh info buat ngebantu (chipset/GPU, RAM, versi Android, versi emulator/fork, game apa, error persisnya), TANYA dulu — jangan nebak buta.
4. Kalau user kirim file config/log, bedah teknisnya; sebutin kalau ada data yang kurang.
5. JANGAN ngarang. Kalau lu ga yakin soal fitur/versi tertentu, bilang terus terang dan kasih pendekatan aman yang umum dipakai.
6. Fokus ke aspek teknis/legal-netral (setting & performa), jangan promosiin sumber game bajakan.

ALAT WEB (PENTING): lu punya tool web_search & web_fetch. WAJIB pakai buat pertanyaan kompleks/teknis/spesifik: parameter dxvk.conf, env var (BOX64_*, DXVK_*, MESA_*), error/crash game tertentu, kompatibilitas game, driver per-GPU. JANGAN jawab dari ingatan kalau bisa diverifikasi — search dulu, fetch sumbernya, baru jawab. SELALU cantumin URL sumber di akhir jawaban. Buat obrolan ringan/sapaan, jawab langsung tanpa tool. KALAU web_search balik kosong/ga tersedia: JANGAN ngulang search berkali-kali — langsung web_fetch ke URL sumber yang kamu tahu (mis. https://raw.githubusercontent.com/doitsujin/dxvk/master/dxvk.conf , https://www.pcgamingwiki.com/wiki/<Nama_Game> , halaman /releases driver sesuai GPU).

SUMBER & CARA FETCH (sebagian situs blok server, pakai endpoint yang jalan):
- PCGamingWiki: fetch API https://www.pcgamingwiki.com/w/api.php?action=parse&page=<Nama_Game_underscore>&format=json&prop=wikitext (halaman /wiki/ sering 403). Tapi pas CANTUMIN ke user tulis URL /wiki/ rapi.
- Steam: https://store.steampowered.com/api/appdetails?appids=<APPID>. ProtonDB: https://www.protondb.com/api/v1/reports/summaries/<APPID>.json
- File teknis (dxvk.conf, box64, vkd3d): raw.githubusercontent.com (bukan github.com/blob).
- REPO RESMI EMULATOR — Winlator-type: winlator.org, github.com/brunodev85/winlator, coffincolors/winlator, StevenMXZ/Winlator-Ludashi, Pipetto-crypto/winlator, REF4IK/winlator-ref4ik-, ajay9634/winlator-ajay. GameHub/Native-type: utkarshdalal/GameNative, WinNative-Emu/WinNative (+ Drivers, proton-wine, Components, lsfg-vk-android), Producdevity/gamehub-lite, The412Banner/BannerHub (+ Bannerhub-Lite, bannerhub-revanced).
- Driver/komponen: The412Banner (Banners-Turnip, Nightlies), star-emu (+ vegas DXVK-perf), FEX-Emu/FEX, AlpyneDreams/d8vk (DX8), FunkyFr3sh/cnc-ddraw (2D jadul), doitsujin/dxvk, gitlab.winehq.org/wine/vkd3d, mesa3d.org, winehq.org, ValveSoftware/Proton.
- Komunitas: r/EmulationOnAndroid & r/winlator. Buat fetch thread reddit, TAMBAHIN ".json" di akhir URL karena halaman HTML reddit sering 403 dari server.
- Kalau 1 sumber 403/gagal, JANGAN ngotot — pindah sumber. JANGAN ngarang URL; cuma cantumin yang beneran kamu fetch.

DRIVER TURNIP per Adreno (fetch /releases buat versi terbaru):
- 6XX: github.com/star-emu/star , github.com/Other-backup/freedreno_turnip-CI
- 710/720/722: github.com/Vauzi-17/710
- 735: github.com/Shalaykin1/Adreno-Tools-Drivers-Sh1ma
- 810/829: github.com/DiskDVD/TurniptoolsA8XX
- 825: github.com/bkupaccount/freedreno_turnip-CI
- 8XX (Eden/Citron): github.com/s1mptom/freedreno_turnip-CI
- Umum/AXXX: whitebelyash/freedreno_turnip-CI, StevenMXZ/Adreno-Tools-Drivers, The412Banner/Banners-Turnip, maxjivi05/Components
- Exynos/Mali (BUKAN Adreno, jangan kasih Turnip): github.com/WearyConcern1165/ExynosTools

PLAYBOOK ERROR (jawab TERSTRUKTUR, JANGAN muter-muter):
[ADRENO + black screen / crash] — AKAR: kombinasi driver Turnip + versi DXVK + Box64 preset, BUKAN VirGL/Vortek.
  1. Pasang Turnip yang cocok sama model Adreno (lihat repo per-Adreno).
  2. Graphics/DX Wrapper = DXVK (bukan WineD3D), kecuali game DX9 lawas rewel.
  3. Box64 preset: mulai COMPATIBILITY -> kalau jalan baru naik ke INTERMEDIATE/PERFORMANCE.
  4. Black screen: dxvk.conf -> d3d9.deferSurfaceCreation=True / dxgi.deferSurfaceCreation=True + Offscreen Rendering = Backbuffer + turunin maxAvailableMemory (jgn 4096 di HP).
  5. Masih bermasalah: ganti VERSI Turnip / versi DXVK (2.x <-> 1.10.3) / DXVK-perf fork (star-emu/vegas).
  JANGAN saranin VirGL/Vortek sbg default di Adreno.

[Mali + error vkCreateShaderModule / crash DX8+] — AKAR: driver Vulkan Mali ga punya BCn & gl_ClipDistance yang dibutuhin DXVK.
  1. Tanya DirectX berapa game-nya. Mali realistis cuma kuat DX9 ke bawah.
  2. Game DX9 -> VirGL + WineD3D (BUKAN Turnip/DXVK), atau fork khusus "Winlator Mali".
  3. Tetep mau DXVK / DX10+ -> build dgn driver VORTEK (nambal SPIR-V buang ClipDistance + emulasi BCn via CPU). Atau dxvk-sarek (mis. Winlator-Ludashi).
  4. HP Samsung Exynos/Xclipse -> layer ExynosTools (github.com/WearyConcern1165/ExynosTools) buat BCn virtualization.
  5. Error vkMapMemory / "-5" -> matiin BOX64_MMAP32.
  6. Pamungkas: kombinasi versi DXVK + Box64 preset + graphics driver beda-beda.
  JANGAN kasih driver Turnip ke Mali. JANGAN janjiin DX11/12 jalan mulus di Mali.`;

// =============================================================================
//  HELPER — split message, sendSafe, typing keepalive
// =============================================================================

function splitMessage(text, max = 4000) {
    if (!text) return [''];
    if (text.length <= max) return [text];
    const parts = [];
    let cur = '';
    for (const line of text.split('\n')) {
        if ((cur + '\n' + line).length > max) {
            if (cur) parts.push(cur);
            if (line.length > max) {
                for (let i = 0; i < line.length; i += max) parts.push(line.slice(i, i + max));
                cur = '';
            } else {
                cur = line;
            }
        } else {
            cur = cur ? cur + '\n' + line : line;
        }
    }
    if (cur) parts.push(cur);
    return parts;
}

async function sendSafe(chatId, text, opts = {}) {
    for (const part of splitMessage(text)) {
        try {
            await bot.sendMessage(chatId, part, { parse_mode: 'Markdown', ...opts });
        } catch (e) {
            try {
                await bot.sendMessage(chatId, part, { ...opts });
            } catch (err) {
                console.error(`Gagal kirim pesan ke ${chatId}:`, err.message);
            }
        }
    }
}

async function withTyping(chatId, fn) {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
    const timer = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);
    try {
        return await fn();
    } finally {
        clearInterval(timer);
    }
}

// =============================================================================
//  HELPER — session key, rate limit, friendly error, admin, display name
// =============================================================================

// Privat = chatId; grup = chatId:userId (biar memori antar-user di grup ga nyampur).
function sessionKey(msg) {
    const chatId = msg.chat.id;
    const t = msg.chat.type;
    if (t === 'group' || t === 'supergroup') return `${chatId}:${msg.from ? msg.from.id : 'anon'}`;
    return String(chatId);
}

function checkRate(userId) {
    if (userId == null) return { ok: true };
    if (ADMIN_IDS.has(String(userId))) return { ok: true };
    const now = Date.now();

    // (1) Cooldown antar pesan — minimal 5 detik
    const last = rateLastAt.get(userId) || 0;
    const sinceLast = now - last;
    if (sinceLast < RATE_COOLDOWN_MS) {
        const lastWarn = rateWarnedAt.get(userId) || 0;
        const warn = now - lastWarn > RATE_WARN_COOLDOWN_MS;
        if (warn) rateWarnedAt.set(userId, now);
        return { ok: false, reason: 'cooldown', waitSec: Math.ceil((RATE_COOLDOWN_MS - sinceLast) / 1000), warn };
    }

    // (2) Window cap — maks 20 pesan / 60s
    const arr = (rateLog.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (arr.length >= RATE_MAX) {
        rateLog.set(userId, arr);
        const lastWarn = rateWarnedAt.get(userId) || 0;
        const warn = now - lastWarn > RATE_WARN_COOLDOWN_MS;
        if (warn) rateWarnedAt.set(userId, now);
        return { ok: false, reason: 'window', warn };
    }

    arr.push(now);
    rateLog.set(userId, arr);
    rateLastAt.set(userId, now);
    return { ok: true };
}

function friendlyError(e) {
    const status = e.response && e.response.status;
    let body = '';
    try { body = typeof (e.response && e.response.data) === 'string' ? e.response.data : JSON.stringify((e.response && e.response.data) || ''); } catch (_) {}
    if (/usage limit reached/i.test(body)) {
        const m = body.match(/reset[^"]*?on ([^"._}]+)/i);
        const when = m ? m[1].trim() : null;
        return `🪫 Kuota AI lagi abis bro${when ? `, reset sekitar *${when}*` : ''}. Coba lagi nanti ya.`;
    }
    if (e.code === 'ECONNABORTED') return '⏱️ Kelamaan mikir / server lemot. Coba pertanyaan yang lebih singkat, atau ulangi bentar lagi.';
    if (status === 429) return '🚦 Server lagi rame (kena rate limit). Tunggu sebentar terus coba lagi ya.';
    if (status >= 500) return '🛠️ Server AI-nya lagi ngadat (5xx). Coba lagi beberapa saat lagi.';
    return 'Jalur ke server lagi ngadet bro, coba lagi nanti.';
}

function isAdmin(userId) { return userId != null && ADMIN_IDS.has(String(userId)); }
function displayName(from) {
    if (!from) return 'Anonim';
    const nm = [from.first_name, from.last_name].filter(Boolean).join(' ');
    return nm || (from.username ? '@' + from.username : 'Anonim');
}

// =============================================================================
//  ADDFIX — Community Knowledge Base
// =============================================================================

const ADDFIX_INFO = `📢 *BANTU BANGUN OTAK BOT — SHARE FIX LU!* 🧠

Bot ini punya *Community Knowledge Base* — kumpulan solusi REAL dari pengalaman member, bukan cuma teori web. Pas ada yg nanya "error X di HP Y", bot kasih fix yg UDAH TERBUKTI work dari kalian. 🔥

🙋 *Cara nyumbang:* ketik /addfix lalu isi format ini (boleh 1 pesan, multi-baris):

\`/addfix\`
\`HP/Chipset : Poco X5, Snapdragon 695, Adreno 619\`
\`Emulator   : Winlator Cmod 10\`
\`Game/App   : GTA SA\`
\`Problem    : black screen pas loading\`
\`FIX        : ganti DXVK ke 1.10.3 + Box64 preset COMPATIBILITY\`

⚠️ *Catatan:*
- Yg dibutuhin fix yg BENERAN lu coba & berhasil, bukan tebakan.
- Semua kiriman di-filter & diverifikasi admin dulu sebelum masuk bot.
- Fix yg kepake, nama lu dicantumin sebagai kontributor. 🙌

Bebas mau share atau nggak — yg banyak nyumbang = bot makin sakti buat kita semua! 🚀`;

function saveAddfix(entry) {
    try {
        fs.appendFileSync(ADDFIX_FILE, JSON.stringify(entry) + '\n');
    } catch (e) {
        console.error('Gagal simpan addfix:', e.message);
    }
}

// =============================================================================
//  WEB TOOLS — search (Serper -> Tavily -> DDG) + fetch
// =============================================================================

const MAX_TOOL_ROUNDS = 4;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Cari di web buat dapet sumber/link terkait pertanyaan teknis emulator, error game, atau setting per-game. Balikin daftar judul + URL.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'kata kunci pencarian' } },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Ambil isi teks dari sebuah URL (mis. github raw dxvk.conf, halaman pcgamingwiki/protondb, release notes driver). Pakai setelah web_search buat baca detail isinya.',
            parameters: {
                type: 'object',
                properties: { url: { type: 'string', description: 'URL lengkap (http/https)' } },
                required: ['url']
            }
        }
    }
];

function htmlToText(html) {
    if (!html) return '';
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;|&#x27;/gi, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function serperSearch(query) {
    const res = await axios.post('https://google.serper.dev/search',
        { q: query, num: 6 },
        { headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const items = (res.data && res.data.organic) || [];
    if (!items.length) return null;
    return items.slice(0, 6).map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.link}\n   ${(r.snippet || '').slice(0, 160)}`
    ).join('\n');
}

async function tavilySearch(query) {
    const res = await axios.post('https://api.tavily.com/search',
        { api_key: process.env.TAVILY_API_KEY, query, max_results: 6, search_depth: 'basic' },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const items = (res.data && res.data.results) || [];
    if (!items.length) return null;
    return items.slice(0, 6).map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.content || '').slice(0, 160)}`
    ).join('\n');
}

async function ddgSearch(query) {
    const res = await axios.get('https://html.duckduckgo.com/html/', {
        params: { q: query },
        headers: { 'User-Agent': UA },
        timeout: 15000,
        maxContentLength: 5 * 1024 * 1024,
        responseType: 'text',
        transformResponse: (x) => x,
        validateStatus: () => true
    });
    if (res.status === 202 || /anomaly|unusual traffic/i.test(res.data || '')) return null;
    const out = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(res.data)) && out.length < 6) {
        let url = m[1];
        const uddg = url.match(/[?&]uddg=([^&]+)/);
        if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch (e) {} }
        if (url.startsWith('//')) url = 'https:' + url;
        out.push(`${out.length + 1}. ${htmlToText(m[2]).replace(/\s+/g, ' ').trim()}\n   ${url}`);
    }
    return out.length ? out.join('\n') : null;
}

// Fallback berlapis: Serper -> Tavily -> DuckDuckGo.
async function webSearch(query) {
    const providers = [
        ['Serper', () => process.env.SERPER_API_KEY ? serperSearch(query) : null],
        ['Tavily', () => process.env.TAVILY_API_KEY ? tavilySearch(query) : null],
        ['DuckDuckGo', () => ddgSearch(query)]
    ];
    for (const [name, fn] of providers) {
        try {
            const r = await fn();
            if (r) { console.log(`🔍 search via ${name}`); return r; }
        } catch (e) {
            console.error(`search ${name} gagal: ${e.message}`);
        }
    }
    return 'web_search lagi ga tersedia (semua search engine nge-throttle/limit). JANGAN ulang web_search; langsung pakai web_fetch ke URL sumber yang relevan — contoh: https://raw.githubusercontent.com/doitsujin/dxvk/master/dxvk.conf , https://www.pcgamingwiki.com/wiki/<Nama_Game> , atau halaman /releases driver yang cocok sama GPU-nya.';
}

async function webFetch(url) {
    try {
        if (!/^https?:\/\//i.test(url)) return 'URL ga valid (harus diawali http/https).';
        const res = await axios.get(url, {
            headers: { 'User-Agent': UA },
            timeout: 20000,
            maxContentLength: 4 * 1024 * 1024,
            responseType: 'text',
            transformResponse: (x) => x
        });
        const ct = (res.headers['content-type'] || '').toLowerCase();
        let text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        if (ct.includes('html') || /^\s*</.test(text)) text = htmlToText(text);
        text = text.replace(/\n{3,}/g, '\n\n').trim();
        const MAX = 7000;
        if (text.length > MAX) text = text.slice(0, MAX) + '\n...[dipotong, terlalu panjang]';
        return text || '(halaman kosong)';
    } catch (e) {
        return 'web_fetch gagal: ' + e.message;
    }
}

async function runTool(name, args) {
    if (name === 'web_search') return await webSearch(String(args.query || ''));
    if (name === 'web_fetch') return await webFetch(String(args.url || ''));
    return 'Tool ga dikenal: ' + name;
}

// =============================================================================
//  AGENTIC LOOP — chatCompletion + tool calls
// =============================================================================

async function chatCompletion(messages, model, useTools) {
    const body = { model, messages };
    if (useTools) { body.tools = TOOLS; body.tool_choice = 'auto'; }
    const res = await axios.post('https://api.freemodel.dev/v1/chat/completions', body, {
        headers: { 'Authorization': `Bearer ${FREEMODEL_KEY}`, 'Content-Type': 'application/json' },
        timeout: 120000
    });
    return res.data;
}

// Model boleh manggil web_search/web_fetch beberapa kali sebelum jawab final.
// Riwayat tool cuma dipakai sementara (working), ga disimpen ke chatHistory.
async function runAgent(key, model, images) {
    const working = [...chatHistory[key]];

    // Suntik gambar ke pesan user terakhir (cuma di working copy biar ga berat).
    if (images && images.length) {
        const last = working[working.length - 1];
        const txt = last && typeof last.content === 'string' ? last.content : 'Analisa gambar ini.';
        working[working.length - 1] = {
            role: 'user',
            content: [
                { type: 'text', text: txt },
                ...images.map((u) => ({ type: 'image_url', image_url: { url: u } }))
            ]
        };
    }

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const lastRound = round === MAX_TOOL_ROUNDS;
        if (lastRound) working.push({ role: 'system', content: 'Cukup pencariannya. Jawab SEKARANG pakai info yang sudah didapat, jangan panggil tool lagi. Sertakan URL sumber.' });
        const data = await chatCompletion(working, model, !lastRound);
        const m = data && data.choices && data.choices[0] && data.choices[0].message;
        if (!m) return '(server ga balikin jawaban, coba lagi)';
        if (!lastRound && m.tool_calls && m.tool_calls.length) {
            working.push(m);
            for (const call of m.tool_calls) {
                let args = {};
                try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
                const result = await runTool(call.function.name, args);
                console.log(`[${key}] 🔧 ${call.function.name}(${JSON.stringify(args).slice(0, 90)})`);
                working.push({ role: 'tool', tool_call_id: call.id, content: result });
            }
            continue;
        }
        if (m.content && m.content.trim()) return m.content;
        working.push({ role: 'user', content: 'Tulis jawaban finalnya sekarang dalam teks ya.' });
    }
    return '(kebanyakan langkah pencarian, coba persempit pertanyaannya)';
}

// =============================================================================
//  YOUTUBE — frame via yt-dlp (kalau cookies ada), fallback thumbnail
// =============================================================================

function run(cmd, args, ms) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: ms, maxBuffer: 12 * 1024 * 1024 }, (err) => err ? reject(err) : resolve());
    });
}

async function ytFrames(id) {
    const dir = `/tmp/yt/${id}`;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await run('yt-dlp', ['--cookies', '/root/yt-cookies.txt', '--no-playlist', '-f', 'worst[height>=240]/worst', '-o', `${dir}/v.%(ext)s`, `https://youtu.be/${id}`], 150000);
    const vf = fs.readdirSync(dir).find((f) => f.startsWith('v.'));
    if (!vf) throw new Error('video ga keunduh');
    await run('ffmpeg', ['-y', '-i', `${dir}/${vf}`, '-vf', 'fps=1/12,scale=512:-1', '-frames:v', '6', `${dir}/f%02d.jpg`], 60000);
    const frames = fs.readdirSync(dir).filter((f) => /^f\d+\.jpg$/.test(f)).sort().slice(0, 6)
        .map((f) => `data:image/jpeg;base64,${fs.readFileSync(`${dir}/${f}`).toString('base64')}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return frames;
}

async function processYouTube(url) {
    const id = (url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/) || [])[1];
    if (!id) return null;
    let meta = 'Video YouTube';
    try {
        const o = await axios.get(`https://www.youtube.com/oembed?url=https://youtu.be/${id}&format=json`, { timeout: 10000 });
        meta = `Judul: ${o.data.title}\nChannel: ${o.data.author_name}`;
    } catch (e) { /* metadata opsional */ }
    let images = [], mode = 'meta';
    if (fs.existsSync('/root/yt-cookies.txt')) {
        try {
            const fr = await ytFrames(id);
            if (fr.length) { images = fr; mode = 'frames'; }
        } catch (e) { console.error('YT frames gagal:', e.message); }
    }
    if (!images.length) {
        try {
            const t = await axios.get(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, { responseType: 'arraybuffer', timeout: 10000 });
            images = [`data:image/jpeg;base64,${Buffer.from(t.data).toString('base64')}`];
            mode = 'thumbnail';
        } catch (e) { /* thumbnail opsional */ }
    }
    return { meta, images, mode };
}

// =============================================================================
//  GARBAGE COLLECTOR — hapus memori chat yang idle > 6 jam
// =============================================================================

setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const id in lastActive) {
        if (now - lastActive[id] > SESSION_TTL) {
            delete chatHistory[id];
            delete lastActive[id];
            cleaned++;
        }
    }
    if (cleaned) { console.log(`🧹 GC: hapus ${cleaned} sesi idle`); scheduleSave(); }
}, 1000 * 60 * 30);

// =============================================================================
//  HANDLER — command + gate grup + vision + file + YouTube
// =============================================================================

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from ? msg.from.id : null;
    const key = sessionKey(msg);
    const text = msg.text || msg.caption || '';
    const documentToProcess = msg.document || (msg.reply_to_message ? msg.reply_to_message.document : null);

    lastActive[key] = Date.now();
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    // Normalisasi command (di grup bisa /reset@NamaBot)
    const cmd = text.startsWith('/') ? text.split(/\s+/)[0].replace(/@.*/, '').toLowerCase() : '';

    if (cmd === '/start') {
        chatHistory[key] = [{ role: 'system', content: SYSTEM_PROMPT }];
        scheduleSave();
        sendSafe(chatId, '🤖 *COPUX-FourFect* aktif!\n\nGw asisten pakar emulator PC-di-Android (Winlator & semua fork, GameHub, Mobox, Box64, DXVK, Turnip, dll). Buat pertanyaan teknis, gw bisa *deep search* ke web (pcgamingwiki, protondb, github dxvk/driver) biar jawabannya akurat & ada sumbernya.\n\n📸 Bisa kirim *screenshot* error/setting juga — nanti gw bedah langsung dari gambarnya.\n\n*Perintah:*\n/cari <kata kunci> - paksa cari di web\n/reset - bersihin memori obrolan\n/addfix - sumbang fix ke Community KB\n\nDi grup: panggil gw pake @' + (BOT_USERNAME || 'namabot') + ' atau reply pesan gw.\n\n———\n💡 Bot ini jalan pakai kredit dari freemodel. Kalau ngerasa kebantu & mau dukung biar tetap nyala, daftar lewat link gw (gratis, lu juga dapet kreditnya):\nhttps://freemodel.dev/invite/FRE-681bce55');
        return;
    }
    if (cmd === '/reset') {
        chatHistory[key] = [{ role: 'system', content: SYSTEM_PROMPT }];
        scheduleSave();
        sendSafe(chatId, '🧹 Memori dibersihin, mulai dari awal.');
        return;
    }
    if (cmd === '/addfix') {
        const body = text.replace(/^\/addfix(@\S+)?\s*/i, '').trim();
        if (!body) { sendSafe(chatId, ADDFIX_INFO); return; }
        saveAddfix({
            ts: Date.now(),
            userId,
            name: displayName(msg.from),
            chatId,
            content: body
        });
        sendSafe(chatId, '✅ Fix lu udah masuk antrian review admin. Makasih kontribusinya bro! 🙌');
        return;
    }
    if (cmd && cmd !== '/cari') return;

    // GATE GRUP: cuma berlaku buat pesan biasa (bukan command). /cari tetep jalan.
    let promptText = text;
    if (isGroup && !cmd) {
        const repliedToBot = !!(msg.reply_to_message && BOT_ID && msg.reply_to_message.from && msg.reply_to_message.from.id === BOT_ID);
        const mentioned = BOT_USERNAME ? new RegExp('@' + BOT_USERNAME + '(?!\\w)', 'i').test(text) : false;
        if (!repliedToBot && !mentioned) return;
        if (mentioned && BOT_USERNAME) promptText = text.replace(new RegExp('@' + BOT_USERNAME + '(?!\\w)', 'ig'), '').trim();
    }

    // RATE LIMIT
    const rate = checkRate(userId);
    if (!rate.ok) {
        if (rate.warn) {
            if (rate.reason === 'cooldown') {
                sendSafe(chatId, `⏳ Santai bro, jeda *${RATE_COOLDOWN_MS / 1000} detik* antar pesan ya. Tunggu ~${rate.waitSec}s lagi.`);
            } else {
                sendSafe(chatId, `🚦 Slow down bro, lu udah *${RATE_MAX} pesan* dalam ${RATE_WINDOW_MS / 1000}s. Istirahat dulu ya.`);
            }
        }
        return;
    }

    // /cari = paksa deep search dulu sebelum jawab
    if (cmd === '/cari') {
        const q = text.replace(/^\/cari(@\S+)?\s*/i, '').trim();
        if (!q) { sendSafe(chatId, 'Format: */cari <kata kunci>*\nContoh: `/cari setting dxvk Elden Ring Adreno 730`'); return; }
        promptText = '[WAJIB pakai web_search lalu web_fetch sumbernya sebelum menjawab] ' + q;
    }

    bot.sendChatAction(chatId, 'typing');

    // === FILE DOKUMEN ===
    let fileContent = '';
    if (documentToProcess) {
        if (documentToProcess.file_size && documentToProcess.file_size > MAX_FILE_SIZE) {
            sendSafe(chatId, '⚠️ Filenya kegedean (maks 1MB). Kirim yang lebih kecil ya.');
            return;
        }
        try {
            const link = await bot.getFileLink(documentToProcess.file_id);
            const res = await axios.get(link, { responseType: 'text', maxContentLength: MAX_FILE_SIZE });
            fileContent = `\n\n[ISI FILE]:\n${res.data}`;
        } catch (err) {
            fileContent = '\n\n[Gagal baca file]';
        }
    }

    // === VISION: foto + frame YouTube ===
    const images = [];

    // 1) Foto / screenshot
    const photos = msg.photo || (msg.reply_to_message ? msg.reply_to_message.photo : null);
    if (photos && photos.length) {
        try {
            const big = photos[photos.length - 1];
            const link = await bot.getFileLink(big.file_id);
            const res = await axios.get(link, { responseType: 'arraybuffer', maxContentLength: 6 * 1024 * 1024 });
            const buf = Buffer.from(res.data);
            // Telegram sering balikin 'application/octet-stream', deteksi dari magic bytes.
            let mime = res.headers['content-type'] || '';
            if (!/^image\//i.test(mime)) {
                if (buf[0] === 0xFF && buf[1] === 0xD8) mime = 'image/jpeg';
                else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) mime = 'image/png';
                else if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') mime = 'image/webp';
                else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) mime = 'image/gif';
                else mime = 'image/jpeg';
            }
            images.push(`data:${mime};base64,${buf.toString('base64')}`);
        } catch (err) {
            console.error('Gagal ambil foto:', err.message);
        }
    }

    // 2) Link YouTube
    const ytUrl = (promptText.match(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i) || [])[0];
    if (ytUrl) {
        const yt = await withTyping(chatId, () => processYouTube(ytUrl));
        if (yt) {
            if (yt.images.length) {
                images.push(...yt.images);
                const seen = yt.mode === 'frames'
                    ? 'Kamu dikasih beberapa FRAME dari video ini. Analisa dari frame + judul.'
                    : 'Video aslinya TIDAK bisa diunduh (YouTube blokir IP server), jadi kamu HANYA dikasih THUMBNAIL + judul. Analisa seadanya, dan JUJUR bilang ini berdasar thumbnail+judul, bukan nonton videonya.';
                promptText += `\n\n[KONTEN YOUTUBE]\n${yt.meta}\n[${seen}]`;
            } else {
                promptText += `\n\n[KONTEN YOUTUBE]\n${yt.meta}\n[Thumbnail & video ga keambil; cuma judul yang ada. Jujur ke user soal keterbatasan ini.]`;
            }
        }
    }

    if (images.length && !promptText.trim()) {
        promptText = 'Jelasin gambar/screenshot ini. Kalau ada error, setting, atau log emulator di dalamnya, bedah & kasih solusinya.';
    }
    if (!promptText.trim() && !fileContent && !images.length) return;

    if (!chatHistory[key]) chatHistory[key] = [{ role: 'system', content: SYSTEM_PROMPT }];
    chatHistory[key].push({ role: 'user', content: promptText + fileContent + (images.length ? `\n[user mengirim ${images.length} gambar]` : '') });
    while (chatHistory[key].length > MAX_HISTORY + 1) chatHistory[key].splice(1, 1);

    try {
        const reply = await withTyping(chatId, () => runAgent(key, MODEL, images));
        console.log(`[${key}] otak: ${MODEL} | jawaban ${reply.length} char`);
        chatHistory[key].push({ role: 'assistant', content: reply });
        scheduleSave();
        await sendSafe(chatId, reply, isGroup ? { reply_to_message_id: msg.message_id } : {});
    } catch (e) {
        const detail = e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
        console.error('Error API:', detail);
        chatHistory[key].pop();
        await sendSafe(chatId, friendlyError(e));
    }
});

console.log('🚀 Bot COPUX-FourFect (gabungan V1+V2) startup…');
