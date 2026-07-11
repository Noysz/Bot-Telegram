# DEPLOY — COPUX bot (single source of truth)

> Ditetapkan 2026-07-11 buat stop repo-drift (dulu ada 2 dir VPS + edit-langsung-live
> bikin git kacau). Aturan: **box repo = sumber → GitHub `main` → VPS pull**. JANGAN
> edit langsung di VPS lagi.

## Topologi (verified)

| Lokasi | Path | Peran |
|---|---|---|
| Box (Termux) | `/root/Bot-Telegram` | **SOURCE** — git working copy, SSH remote, tempat ngoprek |
| GitHub | `Noysz/Bot-Telegram` (`main`) | **HUB** — semua perubahan lewat sini |
| VPS `-release` | `/root/Bot-Telegram-release` | **LIVE** — pm2 `copux` jalanin `bot.js` di sini |

- pm2 `copux` exec path = `/root/Bot-Telegram-release/bot.js` (cek: `pm2 jlist | grep pm_exec_path`).
- VPS remote = HTTPS (read-only, **ga bisa push**) → VPS cuma `pull`, ga pernah jadi source.
- `.env` / `.copux-keys.json` = per-lokasi, gitignored, JANGAN di-commit.

## Alur deploy (edit → live)

```bash
# 1. Di BOX: edit + verify + commit
cd /root/Bot-Telegram
#   ...edit bot.js / modules/... 
node -c bot.js                      # syntax
#   + smoke test relevan (repo ga punya Jest)
git add <file spesifik>             # JANGAN git add -A buta
git commit -m "type: ..."
#   secret-scan sebelum push:
git diff HEAD~1 | grep -E '^\+' | grep -E 'fe_oa_|sk-[A-Za-z0-9]{20,}|ksk_|[0-9]{8,12}:[A-Za-z0-9_-]{35}'  # harus kosong
git push origin main

# 2. Di VPS -release: pull + restart
cd /root/Bot-Telegram-release
git fetch origin && git reset --hard origin/main   # disk == main persis
pm2 restart copux
pm2 logs copux --lines 20 --nostream               # pastiin boot bersih (0 module-error)
```

## Aturan keras

1. **JANGAN edit langsung di `-release`.** Semua lewat box → push → pull. Kalau kepaksa
   hotfix di VPS: langsung mirror balik ke box + commit + push di sesi yang sama.
2. **`-release` = deploy target murni.** `git reset --hard origin/main` boleh (disk selalu
   == main). Kalau `git status` di `-release` ga bersih = ada yang salah, investigate.
3. **community.md / user-content** = drift wajar (di-promote live via /addfix). Kalau mau
   preserve, commit dari box, bukan dari VPS.
4. **Backup sebelum reset/clean** yang nyentuh `-release` (`tar` source, exclude venv/node_modules).
5. **Verify bot hidup** tiap habis restart (`pm2 describe copux` + logs), rule: syntax-check ≠ jalan.

## Riwayat perbaikan drift

- **2026-07-11:** konsolidasi. Hapus dir basi `/root/Bot-Telegram` (VPS, HEAD d60e5e9, 0 commit
  unik). `-release` di-reset ke `origin/main` (a39ebe5), sapu 18 `.bak` clutter. git status bersih.
