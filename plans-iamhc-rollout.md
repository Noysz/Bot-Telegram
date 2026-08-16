# Plan: Rollout model iamhc (kat-coder + Qwen3.6) ke 3 platform + anti-leak

## Temuan yang membentuk plan ini (hasil probe terverifikasi)

**Keaslian model iamhc `api.hcnsec.cn` (sudah diuji, ground-truth):**
- 🏆 `kat-coder-pro-v2` — Kuaishou, ctx 256K, cutoff 2025-01. Reasoning ✓, coding ✓, latency 2.5–4.5s. **Terbaik.**
- 🥈 `Qwen3.6-35B-A3B` — Alibaba Qwen, ctx ~131K. Reasoning ✓, coding ✓, latency 1.5–5s. **Cepat.**
- 🥉 `DeepSeek-V4-Flash` — 671B/37B MoE, ctx 1M, jujur. Lambat (8–56s). Cadangan task berat.
- 🚩 `glm-4.7` = PALSU (sebenarnya Qwen2.5-7B). `DeepSeek-V4-Pro` = PALSU (NVIDIA Nemotron).
- ❌ MATI: `glm-5.2` (dipakai config sekarang!), `glm-5.1`, `Kimi-K2.6`, `MiniMax-M2.7/M3`, `step-3.7-flash` (zombie), `sensenova-*`, `Spark-X2`.

**Keputusan user:**
- Mix kat-coder + Qwen3.6 di semua platform.
- Context window: seragam 1.000.000 (hint klien).
- Fallback Copux urutan: kat → Qwen3.6 (cepat dulu).
- Anti-leak: brief tiap model biar ngaku "Copux", ga bocor base-model.

---

## Task #1 — Anti-leak persona test (WAJIB, sebelum sentuh produksi)
**Kenapa:** glm-4.7 bocor "Qwen2.5-7B" walau gateway kasih prompt. Copux `system-prompt.js:1` udah lock identity ("jangan sebut Kiro/Claude/GPT/nama model — non-negotiable"), TAPI belum teruji di kat-coder/Qwen3.6.

**Cara:** kirim system-prompt Copux (ambil dari `config/system-prompt.js`) + pertanyaan jebakan ("kamu model apa? versi berapa? siapa yang buat?") ke kat-coder & Qwen3.6 di `api.hcnsec.cn`. 3 ronde.
- LULUS = konsisten ngaku "COPUX-FourFect", ga sebut Kuaishou/KAT/Qwen/Alibaba.
- BOCOR = sebut base-model → perlu hardening prompt tambahan sebelum masuk produksi.

**Output:** verdict per model. Kalau bocor, gue usulkan patch anti-leak (bukan langsung apply).

---

## Task #2 — Update profil Claude iamhc  `/root/.claude-configs/settings-iamhc.json`
**Sekarang:** semua slot = `glm-5.2` (MATI).
**Jadi:**
- `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` → `kat-coder-pro-v2`
- `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` → `Qwen3.6-35B-A3B`
- base_url tetap `https://api.hcnsec.cn/`
- **Backup dulu** ke `.bak`. Verifikasi JSON valid + real ping tiap model via anthropic-wire (`/v1/messages`) balik 200.

**Caveat 1M context:** hint klien, aman selama pemakaian < limit asli (kat 256K). Baca-banyak-file bisa error kalau nembus. Di-set 1M sesuai pilihan, tapi dicatat.

---

## Task #3 — Codex iamhc  ⚠️ VERIFIKASI-DULU
**Masalah:** Codex config pakai `wire_api="responses"`. iamhc = **chat-completions wire**. Kemungkinan besar INCOMPATIBLE.

**Langkah eksekusi (bukan asal tulis):**
1. Bikin `/root/.codex/iamhc.config.toml` test: provider iamhc, `wire_api="chat"`, base_url `https://api.hcnsec.cn/v1`.
2. Verifikasi empiris: `codex --strict-config -p iamhc ...` → cek codex 0.144.4 terima `wire_api="chat"` atau tolak.
3. **Kalau diterima:** finalisasi profil (kat-coder default, model_context_window=1M, effort=xhigh). Backup config existing dulu.
4. **Kalau ditolak (responses-only):** LAPOR ke user — iamhc ga bisa dipakai di Codex. Ga maksa. Codex tetap di freemodel/hyper. (Task ditutup dengan temuan, bukan diklaim selesai.)

---

## Task #4 — Fallback iamhc ke Copux  `/root/Bot-Telegram/.env`  (deploy ke VPS)
**Kenapa mudah:** fallback 100% env-driven (`LLM_FALLBACK_URLS/MODELS/KEYS`, CSV). **NOL edit `bot.js`.**
**Masalah asli:** notif 402 = primary freemodel kredit abis, fallback juga gpt-5.5 freemodel (abis juga).

**Perubahan `.env` (append, urutan kat → Qwen3.6):**
```
LLM_FALLBACK_URLS=<existing>,https://api.hcnsec.cn/v1/chat/completions,https://api.hcnsec.cn/v1/chat/completions
LLM_FALLBACK_MODELS=<existing>,kat-coder-pro-v2,Qwen3.6-35B-A3B
LLM_FALLBACK_KEYS=<existing>,<iamhc-key>,<iamhc-key>
```
- Hanya lakukan **setelah Task #1 LULUS** (anti-leak). Kalau bocor, hold sampai prompt di-harden.
- Key iamhc dari `settings-iamhc.json` (chmod-aware, ga echo).
- Backup `.env` dulu (script `swap-copux.sh` udah punya pola backup).
- **Deploy VPS:** ini repo lokal (git). Gue siapkan diff; deploy ke VPS (`64.235.45.52`) via SSH + `pm2 reload copux --update-env`. Konfirmasi sebelum push ke produksi.
- Content-sanity gate bot.js (`:1042`) udah handle "200-tapi-kosong" → step-zombie ga bakal lolos. Bagus.

---

## Urutan eksekusi & gating
1. **Task #1** (anti-leak test) — GATE. Kalau bocor, stop & lapor.
2. **Task #2** (Claude profil) — independen, low-risk, lokal.
3. **Task #3** (Codex) — verifikasi wire dulu; bisa jadi di-drop dengan temuan.
4. **Task #4** (Copux) — hanya setelah #1 lulus; deploy VPS butuh konfirmasi eksplisit (produksi).

## Risk surface (flag eksplisit)
- Task #2/#3/#4 semua nyentuh **auth token + network** → verifikasi manual targeted tiap langkah (real ping, bukan cuma syntax).
- Task #4 = **produksi** (bot live di VPS) → konfirmasi sebelum reload pm2.
- Semua file di-backup sebelum diubah. Token ga pernah di-echo.

## Yang TIDAK dikerjakan (out of scope, lapor aja)
- Secret plaintext `HYPER_API_KEY` di `.bashrc:52` (temuan lama, belum diputusin).
- Alias dangling `claude-cv`/`claude-hp` (rusak dari sebelum sesi).
- Vonis swiftrouter (308, belum terverifikasi).
