# HANDOFF — COPUX VPS (untuk Kiro)

> Ditulis oleh Claude Code (box Termux), 2026-07-09. Kiro = agent coding kedua di VPS ini
> (model claude-opus-4.8 xhigh). Baca ini dulu sebelum ngoprek. Semua path udah diverifikasi,
> BUKAN tebakan.

## 0. Aturan keras (jangan dilanggar)

1. **JANGAN cetak secret.** Mask semua value key/token — tampilkan panjang + 4 char terakhir doang.
   `.env` cukup dibaca nama var-nya, jangan echo value.
2. **Backup sebelum edit apa pun** yang nyentuh `bot.js`, `.env`, atau `data/`. Format:
   `cp -a file file.bak-$(date +%Y%m%d-%H%M%S)`.
3. **Fix root cause, no bypass.** Gak boleh `--no-verify`, gak boleh nutup gejala.
4. **Verify tiap perubahan.** Repo ini gak punya Jest — pakai smoke test manual + `node -c bot.js`
   (syntax) + cek `pm2 logs copux` setelah restart.
5. **JANGAN sentuh/hapus fitur non-legal COPUX** (`/hunting` dsb). Itu keputusan owner, di luar scope lu.
6. **Koordinasi anti-tabrakan:** ada 2 agent lain yang juga SSH ke VPS ini —
   **Codex** (infra/ops) & **AGY/Antigravity** (produk/persona). Jangan clobber kerjaan mereka.
   Sebelum garap item roadmap, cek dulu status di §3.

## 1. Topologi (verified)

- **VPS `root@64.235.45.52:22` = RUNTIME LIVE COPUX.** Repo: `/root/Bot-Telegram-release`.
- pm2 di VPS: `9router` (proxy LLM :20128), `copux` (bot Telegram, entry `bot.js`), `copux-scrapling`.
- **9router** = gateway multi-provider di `127.0.0.1:20128`, baca pool sqlite
  `/root/.9router/db/data.sqlite`. Combo aktif `copux-stack` (kind=fallback).
- Bot manggil LLM lewat `COPUX_API_URL` (→ 9router) sebagai **primary**, terus punya
  chain fallback sendiri di `bot.js` (lihat §2).

### copux-stack (9router) — SUDAH di-heal 2026-07-09
`["grq/llama-3.3-70b-versatile","cbs/gpt-oss-120b","hc/glm-4.7"]` — 3 layer, semua idup & persona-safe.
Node `hc` = iamhc (`api.hcnsec.cn/v1`, chat wire) baru ditambah. Backup db:
`/root/.9router/db/data.sqlite.bak-20260709-151425`.
**Catatan:** iamhc (`api.hcnsec.cn`) = provider terpisah, dedicated ke glm-4.7 = node `hc`.
Claude Code sekarang jalan di provider lain ("agent router"), BUKAN iamhc — jadi node `hc`
stabil, gak akan kebongkar gara-gara CC.

## 2. BUG LIVE — prioritas #1 (fix ini dulu, sebelum fitur baru)

**Gejala:** `pm2 logs copux` spam terus:
```
LLM provider freemodel-direct gagal: HTTP 401
Error API: HTTP 401 from LLM provider
```

**Root cause (verified):** `bot.js:388-390` selalu nge-push provider hardcoded
`freemodel-direct` ke chain:
```js
if (!providers.some((p) => p.url === DIRECT_FREEMODEL_URL)) {
    providers.push({ name: 'freemodel-direct', url: DIRECT_FREEMODEL_URL, key: FREEMODEL_KEY, model: defaultModel });
}
```
- `DIRECT_FREEMODEL_URL` = `https://api.freemodel.dev/v1/chat/completions` (bot.js:99) — hardcoded.
- `FREEMODEL_KEY` (`.env`, …8138) = **saldo abis / 401**.
- Path ini **BYPASS 9router total** — makanya heal copux-stack (§1) TIDAK nyembuhin dia.
  Jalur ini jalur terpisah yang nembak langsung ke freemodel.dev pakai key mati.

**Kenapa harmful:** tiap primary (9router) meleset sesaat (429/400/timeout), bot jatoh ke
`freemodel-direct` → 401 → user bisa keliatan error, dan log kebanjiran.

**Pilihan root-cause fix (lu putusin, ini analisa arsitektur):**
- **(A) Buang auto-push `freemodel-direct`** (bot.js:388-390). Alasan: 9router `copux-stack`
  UDAH jadi mekanisme multi-provider fallback (grq→cbs→hc). Jalur direct-ke-freemodel.dev
  itu redundan + nembak endpoint mati. Ini paling bersih kalau 9router reliable.
- **(B) Repoint `freemodel-direct`** ke endpoint+key yang idup (mis. lewat 9router lagi, atau
  provider lain). Mempertahankan lapisan "bypass 9router" kalau 9router-nya sendiri tumbang.
- **(C) Gate push-nya**: cuma tambah `freemodel-direct` kalau `FREEMODEL_KEY` non-empty DAN
  lolos health-check. Minimal invasif tapi masih nyimpen dead-path kalau key diganti nanti.

Rekomendasi gw condong ke **(A) atau (C)** — (A) kalau owner OK ninggalin 1 lapisan, (C) kalau
mau defensif. Konfirmasi ke owner sebelum pilih.

**Bonus temuan (opsional, jangan diprioritaskan di atas bug):**
- **Startup gate rapuh** (bot.js:27): bot `process.exit(1)` kalau `FREEMODEL_KEY` ATAU
  `TOKENROUTER_KEY` kosong. `TOKENROUTER_KEY` = **dead var** — divalidasi wajib tapi gak dipakai
  logic mana pun. Kalau owner mau, boleh dibuang dari gate biar bot gak sandera ke var mati.

## 3. Status roadmap 10-item (audit 2026-07-09, verified di kode + runtime)

| # | Item | Status | Bukti |
|---|------|--------|-------|
| 1 | `/status` admin realtime | ✅ DONE | handler bot.js:2024 |
| 2 | Auto fallback report | ✅ DONE | `notifyAdmins` + selfHeal notif |
| 3 | LLM router ctrl (`/llmstatus /llmroute /llmtest /reloadenv`) | ✅ DONE | handler ada semua |
| 4 | Webhook + HTTPS | ⚠️ CODE READY, BLOCKED | `setWebHook` bot.js:2090 siap, mode masih polling; **nyangkut DNS** `copux.noyszfourfect.my.id` (belum ada record; `wrangler whoami` hang) |
| 5 | Auto backup harian | ✅ DONE | interval bot.js:1946, file backup + sha256 ada |
| 6 | Queue system | 🟡 PARSIAL | `queue` ada di kode, kedalaman perlu dicek |
| 7 | KB RAG vector | ✅ DONE | `modules/kb-rag.js` + `data/kb-rag-index.json` (2MB), commit f8b3173 |
| 8 | Admin web panel | ❌ BELUM | gak ada server web/route |
| 9 | Per-user memory/profile | ✅ DONE | `data/user-profiles.json`, `/profile` |
| 10 | Error self-healing | ✅ DONE | `selfHealTick()` bot.js:568, auto-restart 9router |

**Yang beneran kebuka buat dikerjain (selain bug §2):**
- **#8 Admin web panel** — greenfield, gak nabrak siapa-siapa. Kandidat kerjaan gede buat lu.
- **#4 Webhook** — code kelar, tinggal DNS. Butuh Cloudflare creds / bikin record manual.
  Codex nyangkut di sini; koordinasi dulu.
- **#6 Queue** — audit kedalaman, upgrade kalau dangkal (buat request berat: screenshot/video/ytdlp/ffmpeg).

## 4. Perintah verifikasi yang berguna

```bash
# provider chain aktif (dari dalam VPS, key gak kecetak)
pm2 logs copux --lines 40 --nostream | grep -iE "provider|401|429|fallback|heal"
# probe copux-stack lewat gateway (baca key dari .env, jangan echo)
# (script ada di history box; intinya POST 127.0.0.1:20128/v1/chat/completions model=copux-stack)
node -c bot.js && echo syntax-ok      # cek syntax sebelum restart
pm2 restart copux && sleep 4 && pm2 logs copux --lines 20 --nostream
```

## 5. Ringkas: mulai dari mana

1. Fix **bug §2 (freemodel-direct 401)** — konfirmasi opsi A/C ke owner, backup, edit, verify log bersih.
2. Kalau owner mau lanjut fitur: ambil **#8 web panel** (greenfield) atau bantu unblock **#4 webhook** (DNS).
3. Selalu: mask secret, backup, verify, jangan clobber Codex/AGY.
