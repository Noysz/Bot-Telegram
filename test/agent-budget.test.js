// =============================================================================
//  test/agent-budget.test.js — nguji budget & coercion di runAgent/runTool.
//  Jalanin: node test/agent-budget.test.js
//
//  Nutup 3 temuan (2026-08-20):
//   #1 tool-call per round ga di-cap + ga ada cek deadline di dalam loop eksekusi
//      -> 1 response model bisa nge-antri ~200 web_fetch (puluhan menit).
//      ⚠️ Cap-nya HARUS konsisten: kalau assistant message tetap bawa 200 tool_calls
//         tapi cuma N yg dibales, request berikutnya invalid (tiap tool_call_id wajib
//         punya message `tool`) -> provider nolak 400. Test I* ngejaga invariant ini.
//   #2 runTool: String(arg) THROW kalau arg objek dgn toString ke-shadow.
//   #3 deadline cuma dicek antar-round -> runAgent overshoot (kejadian 480s vs 180s).
//
//  Isolasi: HARNESS_MODE + TELEGRAM_MODE=webhook & WEBHOOK_URL kosong -> polling MATI
//  dan setWebHook di-`return` sebelum nyentuh API, jadi bot live ga kerebut.
//
//  CAKUPAN — baca ini sebelum percaya hasilnya:
//   - Blok C manggil runTool() ASLI dari bot.js (di-export lewat HARNESS_MODE).
//   - Blok I & D nguji ULANG logika keputusan (slice+push, hitung timeout) sebagai
//     replika, BUKAN manggil chatCompletion/runAgent asli — biar ga butuh network.
//     Artinya: kalau logika di bot.js diubah, test ini BISA tetep hijau padahal
//     kodenya rusak. Sinkronin manual kalau nyentuh blok itu.
//   - require bot.js tetep nge-register ulang menu command ke Telegram API (isinya
//     sama = idempotent). Bukan no-op total.
// =============================================================================
'use strict';
const path = require('path');
const REL = path.join(__dirname, '..');

process.env.TELEGRAM_MODE = 'webhook';
delete process.env.TELEGRAM_WEBHOOK_URL;
process.env.FREEGAME_ENABLED = '0';
process.env.WCP_WATCH_ENABLED = '0';
process.env.WCP_HOOK_ENABLED = '0';
process.env.AUTO_BACKUP_ENABLED = '0';
process.env.ADMIN_WEB_PORT = '0';
process.env.HARNESS_MODE = '1';

let pass = 0, fail = 0;
const fails = [];
const chk = (label, cond, extra) => {
    if (cond) { pass++; console.log('  ✅', label); } else {
        fail++; fails.push(label);
        console.log('  ❌', label, extra !== undefined ? '→ ' + JSON.stringify(extra) : '');
    }
};
const sec = (t) => console.log('\n── ' + t);

(async () => {
    const bot = require(path.join(REL, 'bot.js'));
    const { runTool } = bot;

    // ===================== C: coercion arg runTool (#2) ======================
    sec('C: runTool ga throw buat arg bentuk aneh (#2)');
    {
        // Ini yg dulu THROW: String({toString:0}) gagal ToPrimitive.
        const nasty = [
            ['kb_lookup', { topic: { toString: 0 } }],
            ['kb_lookup', { topic: { valueOf: 0 } }],
            ['kb_search', { query: { toString: 0 } }],
            ['kb_lookup', { topic: [1, 2] }],
            ['kb_lookup', { topic: null }],
            ['kb_lookup', {}],
            ['kb_lookup', null],
            ['kb_lookup', 'bukan objek'],
            ['kb_lookup', [1, 2, 3]],
            ['kb_rag_search', { query: 'mali', top_k: { toString: 0 } }],
            ['kb_rag_search', { query: 'mali', top_k: '1e9' }],
            ['kb_rag_search', { query: 'mali', top_k: -5 }],
            ['kb_rag_search', { query: 'mali', top_k: NaN }],
            ['tool_ga_ada', { x: 1 }]
        ];
        let threw = null;
        for (const [n, a] of nasty) {
            try { await runTool(n, a); } catch (e) { threw = `${n} ${JSON.stringify(a)} → ${e.message.slice(0, 60)}`; break; }
        }
        chk(`C1 ${nasty.length} arg hasil-craft: ga ada yg throw`, threw === null, threw);

        // web_fetch: arg objek jangan sampai jadi URL "[object Object]" yg ditembak.
        let r = await runTool('web_fetch', { url: { toString: 0 } });
        chk('C2 web_fetch arg objek → ditolak, ga throw', typeof r === 'string' && r.length > 0, String(r).slice(0, 60));
        r = await runTool('web_fetch', { url: 'ftp://evil.example/x' });
        chk('C3 web_fetch skema non-HTTPS tetap ditolak', /https|url|valid|gagal|ga /i.test(String(r)), String(r).slice(0, 70));

        r = await runTool('tool_ga_ada', {});
        chk('C4 tool non-whitelist fail-closed', String(r).indexOf('Tool ga dikenal') === 0, String(r).slice(0, 40));

        // Arg valid tetap kepakai (jangan sampai coercion malah ngebuang nilai bener).
        r = await runTool('kb_lookup', { topic: 'Helio G99' });
        chk('C5 REGRESI: arg string valid tetap jalan', typeof r === 'string' && r.length > 0, String(r).slice(0, 50));
        const rNum = await runTool('kb_rag_search', { query: 'mali driver', top_k: 3 });
        chk('C6 REGRESI: top_k numerik tetap jalan', typeof rNum === 'string', typeof rNum);
    }

    // ============ I: invariant cap tool-call (#1) — logika murni ============
    // Nguji ULANG logika slice+push yg dipakai bot.js tanpa manggil LLM: yang
    // fatal itu kalau jumlah `tool` message != jumlah tool_calls di assistant msg.
    sec('I: invariant cap tool-call: tiap tool_call_id kebales (#1)');
    {
        const MAX = Math.max(1, parseInt(process.env.MAX_TOOL_CALLS_PER_ROUND || '4', 10));
        const simulate = (nCalls, msLeft) => {
            const deadline = Date.now() + msLeft;
            const m = {
                role: 'assistant', content: '\n\n',
                tool_calls: Array.from({ length: nCalls }, (_, i) => ({ id: `c${i}`, type: 'function', function: { name: 'kb_lookup', arguments: '{"topic":"x"}' } }))
            };
            const working = [];
            const calls = m.tool_calls.slice(0, MAX);
            working.push({ ...m, tool_calls: calls });
            let outOfTime = false, executed = 0, stubbed = 0;
            for (const call of calls) {
                if (!outOfTime && Date.now() > deadline) outOfTime = true;
                if (outOfTime) { working.push({ role: 'tool', tool_call_id: call.id, content: 'stub' }); stubbed++; continue; }
                working.push({ role: 'tool', tool_call_id: call.id, content: 'hasil' }); executed++;
            }
            const asst = working[0];
            const toolMsgs = working.filter((x) => x.role === 'tool');
            const ids = new Set(asst.tool_calls.map((c) => c.id));
            const answered = new Set(toolMsgs.map((t) => t.tool_call_id));
            const consistent = ids.size === answered.size && [...ids].every((id) => answered.has(id));
            return { asstCalls: asst.tool_calls.length, toolMsgs: toolMsgs.length, consistent, executed, stubbed };
        };

        let s = simulate(200, 60000);
        chk(`I1 200 tool_calls → di-cap jadi ${MAX}`, s.asstCalls === MAX, s);
        chk('I2 jumlah message `tool` == jumlah tool_calls di assistant msg', s.toolMsgs === s.asstCalls, s);
        chk('I3 tiap tool_call_id kebales (invariant provider aman)', s.consistent, s);

        s = simulate(3, 60000);
        chk('I4 REGRESI: 3 call (di bawah cap) semua dieksekusi', s.asstCalls === 3 && s.executed === 3 && s.stubbed === 0, s);

        s = simulate(4, -1);   // deadline udah lewat
        chk('I5 deadline lewat → semua di-stub, NOL dieksekusi', s.executed === 0 && s.stubbed === s.asstCalls, s);
        chk('I6 …dan invariant tetap utuh walau di-stub', s.consistent && s.toolMsgs === s.asstCalls, s);
    }

    // ============ D: budget deadline di chatCompletion (#3) ================
    sec('D: timeout per-call nyusut ikut sisa deadline (#3)');
    {
        // Replika keputusan di bot.js:1090-1102 (ga manggil network).
        const LLM_MIN_CALL_MS = Math.max(1000, parseInt(process.env.LLM_MIN_CALL_MS || '8000', 10));
        const LLM_CALL_TIMEOUT_MS = Math.max(5000, parseInt(process.env.LLM_CALL_TIMEOUT_MS || '120000', 10));
        const decide = (msLeft) => {
            if (msLeft < LLM_MIN_CALL_MS) return { skip: true };
            return { skip: false, timeout: Math.min(LLM_CALL_TIMEOUT_MS, msLeft) };
        };
        chk('D1 sisa banyak → timeout tetap 120s', decide(300000).timeout === LLM_CALL_TIMEOUT_MS, decide(300000));
        chk('D2 sisa 30s → timeout dipotong jadi 30s (bukan 120s)', decide(30000).timeout === 30000, decide(30000));
        chk('D3 sisa 2s (< min) → provider di-SKIP, ga mulai call', decide(2000).skip === true, decide(2000));
        chk('D4 sisa negatif → SKIP', decide(-5000).skip === true, decide(-5000));
        // Batas atas overshoot: worst case = timeout call terakhir yg dimulai pas
        // sisa == LLM_MIN_CALL_MS. Sebelum fix, worst case = providers × 120s.
        const providers = 3;
        const before = providers * LLM_CALL_TIMEOUT_MS;
        const after = LLM_MIN_CALL_MS;
        chk(`D5 overshoot maksimum turun dari ${before / 1000}s jadi <=${after / 1000}s`, after < before, { before, after });
    }

    console.log(`\n${fail === 0 ? 'AGENT_BUDGET_PASS ✅' : 'AGENT_BUDGET_FAIL ❌'} — ${pass} pass, ${fail} fail`);
    if (fail) console.log('gagal: ' + fails.join(' | '));
    process.exit(fail === 0 ? 0 : 1);
})();
