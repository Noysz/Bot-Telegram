# COPUX

Bot Telegram buat komunitas emulator Windows-di-Android — Winlator, GameHub Lite, BannerHub, GameNative, WinNative, Box86/64, FEX, DXVK, Turnip, dll. Gw bikin ini karena capek jawab pertanyaan crash yang sama berulang-ulang di grup, jadi tinggal lempar ke bot.

`@Noysz_bot` — Node.js, single file, jalan di Termux.

## Cara kerjanya

Bot-nya gw kunci ke domain emulator doang. Nanya resep masakan atau soal coding umum bakal dijawab seadanya/diarahin balik. Kalau ada yang nyebut Mobox/ExaGear/Cassia sebagai solusi, bot bakal nyolot duluan — itu vaporware/udah mati, jangan disaranin lagi.

Format jawaban crash dipaksa terstruktur: `Crash di L<X> — <komponen>. Root cause: <mekanisme>. Fix: <langkah>.` Gw capek baca jawaban AI yang ngambang nggak jelas root cause-nya apa, jadi format ini gw paksa dari prompt level.

LLM-nya lewat freemodel.dev (default GPT-5.5).

## Fitur

### Search

`/cari <keyword>` atau nanya natural langsung, bot bakal trigger search sendiri kalau kebutuhan data terbaru. Urutan fallback: Serper → Tavily → DuckDuckGo. DDG nggak butuh API key jadi minimal selalu ada yang jalan.

### Vision

Kirim screenshot error, bot baca isinya (handle magic-byte detection karena Telegram suka kirim MIME `application/octet-stream` yang ngaco). Paste link YouTube, bot ambil 6 frame thumbnail pake yt-dlp + ffmpeg buat dianalisa — kepake banget buat video tutorial yang errornya kelihatan di gambar.

### Sesi

DM itu 1 sesi per chatId. Di grup, per `chatId:userId` biar konteks user A sama B nggak nyampur. Auto-save ke disk tiap 5 detik (debounced), atomic write jadi aman kalau prosesnya mati di tengah jalan. Expired session di-prune otomatis (default TTL 6 jam).

### Rate limit

5 detik cooldown antar pesan, cap 20 pesan/60 detik. Kena limit dapet warning, bukan langsung di-ban, tapi cooldown warning-nya sendiri 5 menit biar nggak spam warning juga. Admin (`ADMIN_IDS`) bebas dari semua ini + bisa akses `/stats`.

### Resource cap

Ini yang paling penting karena jalan di HP. Concurrency LLM di-semaphore (default 3 paralel), per-session lock biar nggak race condition pas nulis ke chatHistory bersamaan. Ada garbage collector buat bersihin rate-log map sama user stats yang udah nggak aktif. Global error handler nangkep `unhandledRejection`/`uncaughtException` dan nyimpen history dulu sebelum proses mati.

### File reader

Kirim dokumen text/log/json/code (≤1MB), bot baca isinya buat konteks reply.

## Commands

| Command | Akses | Fungsi |
|---|---|---|
| `/start` | semua | sapaan |
| `/reset` | semua | clear history sesi |
| `/cari <query>` | semua | force web search |
| `/stats` | admin | statistik user |

Grup: mention atau reply pesan bot. DM: langsung chat aja.

## Tuning buat ARM/Termux

Semua cap di bawah ini env-tunable. Default-nya gw set buat HP 4-6GB RAM:

| Env | Default | Turunin kalau | Naikin kalau |
|---|---|---|---|
| `MAX_HISTORY` | 10 | HP <4GB, ke 6-8 | server, ke 20+ |
| `MAX_CONCURRENT_LLM` | 3 | HP 2-4GB, ke 1-2 | server, ke 5+ |
| `MAX_PHOTO_BYTES` | 6MB | low-RAM, ke 3MB | — |
| `MAX_FILE_SIZE_BYTES` | 1MB | — | server, ke 4-8MB |
| `MAX_FETCH_BYTES` | 4MB | — | — |
| `SESSION_TTL_MS` | 6 jam | RAM ketat, ke 2-3 jam | — |
| `SAVE_DEBOUNCE_MS` | 5000 | — | I/O lambat, ke 10000 |

Detail di `.env.example`.

## Install

Butuh Node 18+, git, PM2 (`npm install -g pm2`). Opsional `yt-dlp` + `ffmpeg` kalau mau fitur YouTube extractor.

```bash
git clone https://github.com/Noysz/Bot-Telegram.git
cd Bot-Telegram
npm install
cp .env.example .env
nano .env
```

Yang wajib diisi:

```
TELEGRAM_TOKEN=
FREEMODEL_KEY=
```

Opsional (kosongin aja kalau ga punya, fallback ke DDG):

```
SERPER_API_KEY=
TAVILY_API_KEY=
```

Admin, pisah koma:

```
ADMIN_IDS=
```

Jalanin:

```bash
pm2 start bot.js --name copux
pm2 save
pm2 startup
```

Cek:

```bash
pm2 status
pm2 logs copux --lines 50
```

## Yang masih jelek

Single file ~1.1k baris, masih kebaca tapi udah mulai sesak — kalau scope nambah lagi gw harus pecah ke `handlers/`, `services/`, `prompts/`.

State (rate log, in-flight, stats) di RAM doang, restart ya hilang. History-nya aman karena ke disk, tapi yang lain nggak.

No database, pure JSON file (`data/history.json`). Cukup buat skala grup komunitas, jangan dipake buat traffic gede.

Polling mode, bukan webhook — lebih simple deploy tapi boros koneksi dikit. Belum sempet bikin webhook mode.

LLM-nya 100% gantung ke freemodel.dev. Gateway-nya down, bot bisu. Belum ada fallback ke provider lain.

Rate limit-nya per-user, bukan per-grup. Grup gede kalau 20 orang nge-spam bareng, bisa kena 429 dari upstream.

Single tenant — satu instance cuma buat satu bot token. Mau multi-bot, harus refactor token handling-nya dulu.

## Struktur

```
Bot-Telegram/
├── bot.js          # semuanya ada di sini — handler, AI call, persona, vision, search
├── package.json
├── .env            # gitignored
├── .env.example
└── data/
    ├── history.json
    └── kb/         # knowledge base curated, di-track
```

## Stack

Node 18+, `node-telegram-bot-api` (polling), `axios`, `dotenv`, PM2. LLM lewat freemodel.dev. Search: Serper/Tavily/DDG. Media: yt-dlp + ffmpeg (opsional).

## Mau dibenerin

- Pecah `bot.js` jadi modul
- Rate limit per-grup
- Webhook mode
- Fallback LLM kalau freemodel down
- SQLite buat stats/rate log, biar nggak hilang pas restart

## License

ISC © Noysz (Fourfect Group)

## Kontribusi

PR boleh, tapi jangan rusak persona bot-nya — no ceramah DRM, no nyaranin Mobox/ExaGear/Cassia, no jawaban ngambang. Diskusi dulu di issue kalau mau ubah yang gede-gede.
