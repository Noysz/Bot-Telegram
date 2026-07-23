# Forks & Components Landscape — 2026

Status, versi, dan posisi tiap komponen di stack Winlator/GameHub/WinNative-keluarga. Update terakhir: Juli 2026.

Tujuan file ini: bot tau **mana yang harus direkomendasiin**, **mana yang vaporware/dormant**, dan **mana yang current** sebelum nge-saranin.

---

## Winlator family (frontend / runtime container)

### Winlator (main) — brunodev85

- **Status:** active maintained
- **Latest:** v11.1 hotfix 2 (12 Jun 2026)
- **Repo:** github.com/brunodev85/winlator
- **Site:** winlator.org
- **Posisi:** baseline upstream. Pake Wine + Box86/64. Default Bionic libc (Android native).
- **Saranin kalau:** user baru, mau yang paling stabil + paling banyak doc, GPU Adreno standar.
- **Limit:** perf di Mali jelek tanpa tweak; .NET Framework butuh Wine Mono manual; Unity engine kadang flaky.

### Winlator CMOD — coffincolors / ConcursivePulp

- **Status:** active maintained (heavily forked dari main)
- **Latest:** v13.1.1-cmod (Aug 2025). User pake "7.1.4x-cmod" = legacy branch lama.
- **Repo:** github.com/coffincolors/winlator (branch `cmod_bionic`)
- **Posisi:** quality-of-life + perf tweak di atas main. Termasuk integrasi adrenotools, GPU profile, custom DXVK shipping.
- **Saranin kalau:** Adreno user pengen ganti Turnip driver gampang, user yang mau preset perf siap pakai.
- **Catatan:** ada juga branch `cmod_glibc` — gabungan filosofi CMOD + glibc base.

### Winlator Bionic Ludashi — StevenMXZ

- **Status:** community fork (low visibility public repo)
- **Latest:** v3.1.h hotfix (22 Jun 2026)
- **Posisi:** variant CMOD-style yang ditune buat Ludashi benchmark / use-case spesifik Asia gaming.
- **Saranin kalau:** user explicit nyebutin Ludashi atau punya rekomendasi grup tertentu.
- **Catatan jujur:** dokumentasi tipis, jangan halu — kalau user nanya detail, tanya balik / arahin ke sumber rilis langsung.

### Winlator GLIBC — longjunyu2

- **Status:** ⚠️ **INACTIVE sejak Okt 2024.** Maintainer hilang kontak.
- **Latest:** v7.1.3 (29 Aug 2024)
- **Repo:** github.com/longjunyu2/winlator
- **Posisi:** Wine jalan di atas glibc proot (bukan Bionic). Lebih kompat sama binary Linux yang assume glibc; tradeoff: ukuran lebih besar, boot lebih lambat.
- **Saranin kalau:** user butuh kompatibilitas binary tertentu yang fail di Bionic + sadar fork ini ga di-update.
- **Catatan:** banyak community fork lanjutan (coffincolors cmod_glibc, dll) yang tetep maintained — arahin ke sana, bukan ke repo asli.

---

## GameHub-native family (frontend store + FEX/Proton stack)

### GameHub Lite — Producdevity

- **Status:** active maintained
- **Latest:** v5.1.8 (2 Jul 2026)
- **Repo:** github.com/Producdevity/gamehub-lite
- **Posisi:** base ringan GameHub Lite, dipakai juga sebagai referensi BannerHub Lite.
- **Catatan security:** v5.1.8 redacts Steam/auth token fields di logs. Kalau user pernah post log lama yang berisi token, suruh hapus/redact.
- **[COMMUNITY SIGNAL] Container gagal init / stuck saat start:** coba ganti compatibility layer version — user report switch Proton 10.0 → 11.0 bikin container init normal (GameHub-Lite #130, Snapdragon 7 Gen3). Ini fix lintas-chipset, bukan device-specific.

### GameNative — utkarshdalal

- **Status:** active, fast-moving
- **Latest:** v1.1.0 (1 Jul 2026)
- **Repo:** github.com/utkarshdalal/GameNative
- **Posisi:** launcher native besar dengan FEX/Proton stack, device compatibility data, store integration.
- **Highlight 1.1.0:** device compatibility data lebih granular, Pulse audio lebih reliable/low-latency, SurfaceFlinger renderer option, searchable driver/DXVK lists, gmem auto untuk Adreno 710/720/732.
- **Mali signal:** upstream/community mulai push VKD3D/DX12-light on Mali. Treat sebagai `[COMMUNITY SIGNAL]`, tetap cek driver MTK `v50+`.

### WinNative — WinNative-Emu

- **Status:** active, beta
- **Latest:** v0.2.0-beta (7 Jun 2026)
- **Repo:** github.com/WinNative-Emu/WinNative
- **Posisi:** native launcher dengan store download/session support.
- **Highlight 0.2.0-beta:** OpenGL renderer diganti Vulkan Compositor, frame pacing/1% lows/FPS membaik, Snapdragon Game Super Resolution masuk FX menu, FPS limiter 30 Hz sampai refresh-rate.
- **Catatan:** custom Steam client default butuh internet dan Proton/Wine tertentu yang diberi tag di component downloader.

---

## CPU translation layer

### Box64 — ptitSeb

- **Status:** active
- **Latest:** v0.4.2 (Apr 2026)
- **Repo:** github.com/ptitSeb/box64
- **Posisi:** x86_64 → ARM64 dynarec. Default di Winlator family.
- **Detail tuning:** lihat `box64-envs.md`.

### Box86 — ptitSeb

- **Status:** active (companion Box64)
- **Posisi:** x86 (32-bit) → ARM64. Dipake bareng Box64 buat game 32-bit dan installer lama.

### FEX-Emu — FEX-Emu team

- **Status:** active, fast-moving
- **Latest:** FEX-2607 (4 Jul 2026)
- **Repo:** github.com/FEX-Emu/FEX
- **Posisi:** alternatif Box64 dengan TSO emulation + dispatcher tier. Lebih akurat di game yang sensitif memory ordering (Unity, beberapa anti-tamper).
- **Dipake utama oleh:** GameHub Lite, BannerHub, GameNative, WinNative.
- **Detail tuning:** lihat `fex-translation.md` + `fex-extreme-params.md`.
- **Trade vs Box64:** lebih akurat → kompat lebih baik di game baru; tapi overhead lebih tinggi, kalah perf di game lawas yang ga butuh TSO.

---

## GPU / driver tooling

### libadrenotools — bylaws

- **Status:** ⚠️ **DORMANT sejak Jul 2022** (tapi masih fungsional, banyak fork hidup pake)
- **Repo:** github.com/bylaws/libadrenotools
- **Posisi:** loader custom driver Adreno tanpa root. Pakai redirect file ops; per-app, bukan system-wide.
- **Saranin kalau:** user Adreno mau ganti Turnip community build (KIMCHI dll).
- **Limit keras:** Adreno-only. Mali/Xclipse ga punya equivalent — JANGAN saranin libadrenotools ke user non-Adreno.

### Mesa Turnip — Mesa upstream + community forks

- **Posisi:** Vulkan driver open-source buat Adreno. Vendor driver Qualcomm sering crash/buggy → Turnip community build (KIMCHI, MrPurple666, dll) jadi solusi.
- **Per-Adreno detail:** lihat `turnip-per-adreno.md`.

### Mesa Zink

- **Posisi:** OpenGL → Vulkan layer (bagian Mesa). Jarang kepake langsung di Winlator (Wine udah OpenGL→native, atau lewat DXVK). Relevant kalau game pake OpenGL native + driver Vulkan-only.

---

## DirectX → Vulkan wrappers

### DXVK — doitsujin

- **Status:** active
- **Latest upstream:** v3.0.1 (5 Jul 2026)
- **Practical mobile latest:** v2.7.1 kecuali device report Vulkan 1.4.
- **Repo:** github.com/doitsujin/dxvk
- **Cover:** D3D8/9/10/11 → Vulkan. (D3D8 ke-merge dari d8vk.)
- **Detail tuning:** lihat `dxvk-conf.md`.

### DXVK Sarek (fork Mali — pythonlover02)

- **Posisi:** community fork khusus GPU tanpa Vulkan 1.3 / `graphics_pipeline_library` (Mali, Adreno tua). Base DXVK 1.10.x.
- **Versi Sarek REAL:** canonical pythonlover02 = 1.10.4–1.10.9, **1.11.0** ("Red River"), **1.12.0** ("Late Anniversary", +dyasync +d7vk). Fork zeyadadev = **`v1.11.1-mali-fix`** (base 1.11.0 + fix Mali black-screen, real, ~1.5k dl).
- ⚠️ **JANGAN ketuker:** `1.7.2` / `1.10.3` itu build **Sporif/dxvk-async** (archived Nov 2025), BUKAN Sarek. Official DXVK & Sporif GA ADA 1.11.x — yang punya 1.11.1 cuma fork Sarek. `gplasync` (Ph42oN) beda lagi — butuh Vulkan 1.3, BUKAN buat Mali tua.
- **Async vs dynasync:** "async" (Sporif) shader compile background, sering crash. "dyasync" = fitur di Sarek 1.12.0. "gplasync" = generasi GPL (Vulkan 1.3+). Detail: kb_lookup("evolution").
- **Saranin kalau:** user Mali black-screen / stutter shader compile.

### VKD3D-Proton — winehq + community

- **Status:** active
- **Cover:** D3D12 → Vulkan. Banyak GPU mobile ga punya feature DX12 → fallback mungkin perlu.
- **Detail:** lihat `vkd3d.md`.

### D8VK — AlpyneDreams

- **Status:** ✅ **MERGED ke DXVK upstream** (Mei 2023). Repo lama jadi reference doang.
- **Posisi:** dulu standalone, sekarang built-in DXVK 2.x. Kalau ada game DX8, pake DXVK aja, ga perlu d8vk standalone.

### CNC DDraw — FunkyFr3sh

- **Status:** active
- **Latest:** v7.1 (Dec 2024)
- **Repo:** github.com/FunkyFr3sh/cnc-ddraw
- **Cover:** DirectDraw (pra-D3D, 1990s–early 2000s). Backend GDI/OpenGL/D3D9.
- **Saranin kalau:** user main game era DirectDraw (C&C lama, StarCraft, Diablo 1/2 classic, Baldur's Gate) — DXVK ga handle DDraw langsung.

### dxwrapper — elishacloud

- **Status:** active
- **Latest:** v1.7.8400.25 (May 2026)
- **Repo:** github.com/elishacloud/dxwrapper
- **Cover:** comprehensive — ddraw, d3d8/9, dsound, dinput, winmm, dwmapi, dll. Bisa convert DDraw/D3D1–7 → D3D9, D3D8 → D3D9.
- **Saranin kalau:** game lawas butuh tweak compat spesifik (resolution unlock, audio fix, input fix) di luar grafis murni — bukan substitute DXVK, tapi complement.

---

## Quick decision matrix

| User punya | Saranin |
|---|---|
| Adreno 7xx + game DX11 modern | Winlator main / CMOD + DXVK 2.x + Turnip community |
| Adreno 6xx older + game DX11 | Winlator CMOD + DXVK stable + adrenotools + Turnip per-chip |
| Mali + game DX11 black screen | Driver unknown/old: DXVK Sarek **1.11.1-mali-fix** atau 1.12.0. Driver MTK `v40+`: DXVK 2.x test path + Sarek fallback |
| Mali + game DX12 | Driver `< v50`: jangan. Driver `>= v50`: VKD3D-light experimental + DX11 fallback |
| Game DDraw (90s–00s) | CNC DDraw, bukan DXVK |
| Game DX8 | DXVK 2.x (d8vk merged); jangan cari d8vk standalone |
| Game butuh tweak compat eksotis | dxwrapper |
| Game Unity baru / anti-cheat sensitif | FEX (bukan Box64) — pake GameHub/BannerHub/GameNative |
| User nanya "fork mana yang paling bagus" | Tanya GPU + Android version dulu, baru jawab |

---

## Anti-vaporware list (JANGAN saranin)

- **Mobox** — udah lama ga update, banyak issue
- **ExaGear** — discontinued
- **Cassia** — vaporware / belum public usable
- **Winlator GLIBC asli (longjunyu2)** — maintainer hilang Okt 2024. Arahin ke fork yang aktif.
- **libadrenotools standalone** — kalau user nanya generic recommendation. Tools-nya OK, tapi dormant.
- **d8vk standalone** — udah merged ke DXVK 2.x.

Ini live list; kalau user ngotot bilang X masih bagus, minta evidence (commit recent, release recent). Anti-halu.
