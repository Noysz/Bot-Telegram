// =============================================================================
//  modules/persistence.js — chatHistory persist (load boot + save atomic+debounce)
//  di-extract dari bot.js. Fungsi load/snapshot/save/saveAsync/scheduleSave VERBATIM.
//  ⚠️ chatHistory + lastActive di-INJECT BY-REFERENCE (const object di bot.js, cuma
//     di-mutate ga di-reassign → modul operate objek yg SAMA, ga duplikat state).
//     Private save-state (timer/in-flight/pending) pindah ke sini.
//     flush() = save-logic dari shutdown lama (clear timer + await in-flight | sync
//     save); bot.js shutdown/crash-handler panggil persistence.flush()/saveHistory().
// =============================================================================

const fs = require('fs');

// --- injected via init() dari bot.js ---
let chatHistory = {};      // by-ref (objek sama dgn bot.js)
let lastActive = {};       // by-ref
let HISTORY_FILE = null;
let SESSION_TTL = 0;
let SAVE_DEBOUNCE_MS = 0;

// ===================== VERBATIM bot.js 651-723 =============================
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
// Sync version dipake cuma di shutdown handler (SIGINT/SIGTERM) — di hot path
// pake saveHistoryAsync biar event loop ga blocking.
function saveHistory() {
    try {
        const tmp = HISTORY_FILE + '.tmp';
        fs.writeFileSync(tmp, snapshot());
        fs.renameSync(tmp, HISTORY_FILE);
    } catch (e) {
        console.error('Gagal simpan history (sync):', e.message);
    }
}
let saveInFlight = false;
let saveInFlightPromise = null;   // ref ke promise berjalan; dipakai shutdown buat await beneran (bukan polling boolean).
let pendingSave = false;
async function saveHistoryAsync() {
    if (saveInFlight) {
        pendingSave = true;
        return saveInFlightPromise;
    }
    saveInFlight = true;
    pendingSave = false;
    const work = (async () => {
        try {
            const tmp = HISTORY_FILE + '.tmp';
            await fs.promises.writeFile(tmp, snapshot());
            await fs.promises.rename(tmp, HISTORY_FILE);
        } catch (e) {
            console.error('Gagal simpan history (async):', e.message);
        } finally {
            saveInFlight = false;
            saveInFlightPromise = null;
            if (pendingSave) {
                scheduleSave();
            }
        }
    })();
    saveInFlightPromise = work;
    return work;
}
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveHistoryAsync(); }, SAVE_DEBOUNCE_MS);
}

// flush: dipanggil bot.js shutdown handler (SIGINT/SIGTERM) — clear debounce timer,
// await async save in-flight (cap 5s) biar PM2 ga lama, atau sync save kalau ga ada.
// (Logic di-pindah verbatim dari shutdown lama; bot.js shutdown wrapper panggil ini.)
async function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (saveInFlightPromise) {
        try {
            await Promise.race([
                saveInFlightPromise,
                new Promise((r) => setTimeout(r, 5000))
            ]);
        } catch { /* ignore — exit anyway */ }
    } else {
        saveHistory();
    }
}

function init(deps) {
    deps = deps || {};
    if (deps.chatHistory) chatHistory = deps.chatHistory;
    if (deps.lastActive) lastActive = deps.lastActive;
    if (deps.HISTORY_FILE !== undefined) HISTORY_FILE = deps.HISTORY_FILE;
    if (deps.SESSION_TTL !== undefined) SESSION_TTL = deps.SESSION_TTL;
    if (deps.SAVE_DEBOUNCE_MS !== undefined) SAVE_DEBOUNCE_MS = deps.SAVE_DEBOUNCE_MS;
}

module.exports = { init, loadHistory, saveHistory, scheduleSave, flush };
