# Evolution per Tool — Inflection Points (2018 → 2026)

Per-tool timeline yang **NGUBAH cara pakai di mobile**. Bukan changelog lengkap — cuma yang impact diagnosis/recommendation.

Sumber: github.com/{doitsujin/dxvk, ptitSeb/box64, FEX-Emu/FEX}/releases.

---

## DXVK — timeline + mobile takeaway

### Era 1.x (2018 – Q1 2022)
- Foundation D3D9/10/11 → Vulkan. Tanpa requirement extension Vulkan modern.
- **Async fork (community)** lahir di sini — solve shader compile stutter. Versi populer mobile: **1.7.2, 1.10.3, 1.11.1**.
- **DXVK Sarek** muncul di akhir era 1.x (1.10+ branch) — fokus Mali Vulkan 1.0/1.1 yang ga punya `graphics_pipeline_library`.
- Mobile take: **kalau driver Mali user PRA-G77 atau Vulkan 1.1 only → KUNCI di DXVK 1.x family (Sarek)**. Vanilla 2.x ga jalan.

### DXVK 2.0 (Q1 2022)
- Migrasi build ke meson. Refactor besar.
- Mulai pake extension Vulkan baru → mobile driver lawas ke-cut.
- Mobile take: **Adreno tua / Mali pre-Valhall → tetep di 1.x.**

### DXVK 2.3 (2023)
- Specialization constants di descriptor cache.
- Mobile take: net positive perf di driver Vulkan 1.3 (Adreno 7xx, Mali-G715+).

### DXVK 2.4 / 2.4.1 (2023)
- **Dynamic memory chunk sizing** — chunk allocation ngikutin pola game, ga lagi konstan 256MB.
- **D8VK ke-merge** ke DXVK — support D3D8 built-in.
- Mobile take: **lupakan d8vk standalone**. Tweak `dxvk.maxChunkSize` jadi sekedar hint, bukan keras.

### DXVK 2.5 (Nov 2024)
- Memory & resource manager di-rewrite. **Periodic defragmentation**.
- Software cursor D3D9 (fix banyak game UE3).
- Sampler pool refactor (UE3 game).
- Mobile take: **stutter mid-session berkurang** karena defrag jalan background. RAM-konstrain HP dapet boost.

### DXVK 2.6 (Mar 2025)
- Nvidia Reflex support D3D11 (low latency).
- Swapchain reworked + MSAA workaround.
- Mobile take: **MSAA bug yang lama suka bikin black flicker → fixed**. Ga perlu lagi `d3d11.disableMsaa` se-agresif dulu.

### DXVK 2.7 / 2.7.1 (mid 2025) — current stable
- **`VK_EXT_descriptor_buffer`** support → CPU overhead turun (AMD/Nvidia desktop dulu, mobile menyusul kalau driver dukung).
- **State cache legacy REMOVED** — pipeline cache via mekanisme baru.
- Memory defrag default ON di Intel Battlemage/Lunar Lake.
- Mobile take: **panduan lawas "hapus dxvk.cache file" → STALE buat 2.7+**. File state-cache udah ga ada.

### Mobile decision matrix (DXVK) — **[THEORETICAL]**
**⚠️ Confidence: matrix ini interpolasi spec Mali + DXVK feature req. BUKAN benchmark database.** Pakai sebagai starting point kalau ga ada `[VERIFIED]` per-game preset di `per-game.md`. Per-game empirical SELALU MENANG.

| Driver Vulkan user | Pakai (theoretical) |
|---|---|
| Vulkan 1.0/1.1 (Mali pre-Valhall / Adreno < 6xx) | DXVK 1.7.2 atau 1.10.3 fork async |
| Vulkan 1.1/1.2 (Mali Valhall awal: G57, G68) | DXVK Sarek 1.10.3 / 1.11.1 |
| Vulkan 1.2 + GPL ga ada (Mali G610/G715 driver tua) | DXVK Sarek 1.12 |
| Vulkan 1.3 + GPL ada (Adreno 7xx, Mali G720+, Turnip baru) | DXVK 2.5/2.6/2.7 vanilla |
| Adreno + adrenotools custom Turnip | DXVK 2.5+ |

**[REVEALED PREFERENCE]** signal komunitas yang LEBIH KUAT dari matrix di atas: StevenMXZ Winlator-Contents CDN ship `dxvk-11.1-sarek-async.wcp` sebagai default Mali. Maintainer udah test cross-device. Itu data komunitas, bukan teori. Untuk Mali default tanpa data per-game = Sarek 1.10.3-1.12, BUKAN vanilla 2.x.

**Empirical override examples (ke-test Noysz):**
- Helio G99 + GTA V DX10 1024x600 Medium = **DXVK 1.7.2 async** > Sarek 1.12 (BCn emu Sarek over-burden Mali-G57 weak CPU)

---

## Box64 — timeline + mobile takeaway

### Era v0.1.x – v0.2.x (2020 – 2022)
- DynaRec dasar lahir, BOX64_DYNAREC default on.
- BOX64_DYNAREC_BIGBLOCK + STRONGMEM diperkenalkan.
- Mobile take: fondasi semua tweak setelah-nya. User Winlator lama (pre-2022 build) → DynaRec primitif, **saranin update**.

### v0.3.0 – v0.3.2 (2022)
- **Box32** diperkenalkan (32-bit x86 emulation kompanion Box86). Sebelumnya Winlator wajib bundle Box86 terpisah.
- **NATIVEFLAGS** default ON di semua backend — perf boost gratis tanpa user tweak.
- Mobile take: ga perlu user manual set `BOX64_DYNAREC_NATIVEFLAGS=1` di Box64 0.3.2+. Saran lama itu **stale**.

### v0.3.4 (Mar 2023)
- RV64 RVV vector emulation (RISC-V doang).
- BOX64_CPUTYPE introduced — spoof CPU vendor (Intel/AMD).
- Mobile take: `BOX64_CPUTYPE=Intel` kadang fix anti-cheat / game vendor-lock.

### v0.3.6 (Jun 2023)
- **Volatile Metadata** support buat Windows executable — handle binary yang ngambek soal flag CPU.
- WowBox64.dll buat Hangover (Wine WOW64) integration.
- Mobile take: game Windows yang dulunya nge-fail di Winlator pre-0.3.6 lewat WOW64 → upgrade Box64 langsung fix.

### v0.3.8 (Oct 2023) — INFLECTION POINT
- **DynaCache** — JIT code di-cache ke disk. Launch ke-2 dst lebih cepet drastis.
- Mobile take: **wajib aktif** di mobile (penyimpanan disk lebih cepet dari RAM yang sempit). `BOX64_DYNACACHE=1`.
- AVX scalar di RV64/LA64 ditambah.

### v0.4.0 (Jan 2024)
- **Opcode prefix decoder rewrite** — DynaRec lebih akurat.
- **FSGSBASE** support — segment register handling simplified. Bantu game pakai TLS lawas.
- BOX64_ARCH introduced (multi-arch select).
- Mobile take: 0.4.x mark titik aman default. Pre-0.4.0 → saranin upgrade.

### v0.4.2 (Apr 2026) — current
- Vulkan x64 overlay.
- PPC64LE backend dev (irrelevant mobile).
- SteamRT3 + Proton 11 support.
- Mobile take: **versi sweet spot**. Semua Winlator/CMOD/GameHub modern bundle 0.4.x.

### Mobile decision matrix (Box64)
| Symptom user | Cek Box64 versi → solusi |
|---|---|
| Launch lambat tiap kali | <0.3.8 → upgrade + enable DynaCache |
| WOW64 game crash | <0.3.6 → upgrade |
| Anti-cheat vendor check fail | Coba `BOX64_CPUTYPE=Intel` (0.3.4+) |
| Game pake TLS lama segfault | <0.4.0 → upgrade buat FSGSBASE |
| User pake setting `NATIVEFLAGS=1` manual | 0.3.2+ udah default ON, ga perlu manual |

---

## FEX — timeline + mobile takeaway

### Era pre-2109 (2021)
- Awal Linux x86-64 → ARM64 emulator. TSO emulation experimental.
- Mobile take: pra-GameHub era. Skip.

### FEX-2109 – 2210 (2021 Q3 – 2022)
- TSO support matang. `TSOEnabled` knob jadi default true.
- AVX (256-bit) di 64-bit binary.
- Mobile take: titik mula bisa dipake serius buat game Unity / DX11. GameHub Lite muncul di era ini.

### FEX-2305 – 2308 (May – Aug 2023)
- Mono ARM64EC/WOW64 perf hacks.
- 3DNow! di-disable di Wine WOW64 (banyak game game old false-detect 3DNow).
- Mobile take: kalau user mention "Wine WOW64 game lawas false-CPU-detect" → versi 2305+ udah handle.

### FEX-2510 (Oct 2023) — INFLECTION
- **x87 intermediate result caching** di slow path → 2-3x instruction reduction. Game pakai math FP87 (lawas) langsung jauh lebih cepet.
- FEXInterpreter rename → FEX (cleanup).
- Mobile take: **upgrade ke 2510+ KASIH FREE PERF 2-3x** di game-game older. Major leap.

### FEX-2511 (Nov 2023)
- **AVX di 32-bit default ON** (sebelumnya cuma 64-bit).
- WritePriorityMutex.
- L1/L2 cache memory optimization.
- Mobile take: game 32-bit yang ngotot AVX → 2511+ langsung jalan tanpa tweak.

### FEX-2512 (Dec 2023)
- io_uring syscall DISABLED (workaround Termux yang sering kacau).
- FEAT_LRCPC2 errata handling.
- Mobile take: **kalau user di Termux/proot pernah lihat "io_uring" error → upgrade ke 2512+**.

### FEX-2603 (Mar 2024)
- **RPMalloc allocator integration** — memory footprint turun drastis.
- vzeroupper via DC ZVA optimization.
- Mobile take: **OOM kill di HP <6GB → upgrade ke 2603+**, RAM consumption drop signifikan.

### FEX-2604 (Apr 2024)
- **Dynamic L1 cache** + L2 disabled by default → memory turun lagi.
- **x87 transcendental inlining → 3.7x speedup**.
- Mobile take: kombinasi 2603 + 2604 = best FEX buat HP RAM ketat.

### FEX-2605 (May 2024) — current bundled di emulator modern
- Snapdragon X2 Elite improvements + atomic split-lock emulation.
- ARM64EC controller crash fixes.
- CLZERO support.
- Mobile take: **stable + future-proof buat HP SD8 Elite generation**.

### Mobile decision matrix (FEX)
| Symptom | Cek FEX versi → solusi |
|---|---|
| Game x87-heavy (PES lama, SH2 classic, GTA SA) slow | <2510 → upgrade buat 2-3x speedup |
| Game 32-bit AVX false detect | <2511 → upgrade |
| Termux io_uring error | <2512 → upgrade |
| OOM di HP 4-6GB RAM | <2603 → upgrade (RPMalloc) |
| Trig-heavy game (rotasi kamera ngaco) | <2604 → upgrade (3.7x sin/cos) |
| HP SD8 Elite / X2 Elite controller crash | <2605 → upgrade |

---

## Implementasi ke emulator family (best-effort dari changelog cross-ref)

### Winlator (main, brunodev85)
- v11.x (2025-2026) bundle: **Box64 0.4.x + DXVK 2.5-2.7 + Wine 9-staging**. Default ga ada FEX.
- v9.x lama (2024): **Box64 0.3.8 + DXVK 2.3** baseline.

### Winlator CMOD (coffincolors)
- v13.x bundle: **Box64 0.4.x + DXVK 2.x atau Sarek pilihan + libadrenotools integrasi**.
- Switch Box64 vs FEX bukan default — CMOD utamain Box64.

### GameHub Lite (Producdevity) + BannerHub + GameNative + WinNative
- Bundle: **FEX (2510+) sebagai default x86 emu** — bukan Box64.
- Khusus FEX karena akurasi TSO buat Unity / anti-cheat modern.
- DXVK seringan + per-game switchable.

### Pattern bot recommendation
- **User pake Winlator CMOD + game tua (PES, SH2, GTA SA)**: cukup Box64 0.4.x + DXVK Sarek. FEX overkill.
- **User pake GameHub/BannerHub + game baru (Unity, modern AC)**: FEX 2603+ wajib. Box64 ga cocok di sini.
- **User stuck di Mobox**: arahin migrasi. Mobox proyek ga update lagi.

---

## Bot rules ke-extract dari evolution

1. **Sebelum kasih tweak `BOX64_DYNAREC_NATIVEFLAGS=1`**: cek versi user. 0.3.2+ udah default ON → tweak lo redundant.
2. **Sebelum kasih panduan "hapus state-cache DXVK"**: cek versi. 2.7+ udah ga ada state cache → panduan lo stale.
3. **OOM di HP RAM ketat + user pake GameHub**: pertanyakan versi FEX. <2603 → upgrade lebih ampuh dari tweak.
4. **Launch game Winlator lama (>30 detik tiap kali)**: cek Box64 versi. <0.3.8 → DynaCache bakal solve lebih baik dari tweak BIGBLOCK.
5. **Mali user "DXVK 2.x crash"**: konfirmasi ulang Vulkan version + GPL support. Kalau ga ada GPL → arahin ke Sarek, jangan paksain 2.x.
6. **d8vk standalone** ditanya: tegasin — udah ke-merge ke DXVK 2.4. Pake DXVK aja.
7. **Sebelum bilang "upgrade Box64 + DXVK + FEX"**: tanya emulator dulu. Winlator family beda paradigm dari GameHub family.
8. **User Ludashi-plus v3.1.2-pre2+ LSFG frame-gen ga jalan**: ingatin — Lossless.dll BUKAN bundled lagi di pre2 (compliance). User wajib **Settings → Import Lossless.dll** manual. v3.1.1 dan lebih lama masih bundled. Detail: kb_lookup("the412banner").
9. **User upgrade BannerHub v3.x → BannerHub v6 fail install**: SHARED_USER_INCOMPATIBLE karena keystore beda. WAJIB uninstall produk lama dulu (backup config via Export Config sebelumnya). 3 produk BannerHub (v3.x / Lite / v6) NEVER update-over-able. Detail: kb_lookup("the412banner").
