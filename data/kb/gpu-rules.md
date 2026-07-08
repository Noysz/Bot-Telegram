# GPU Rules — Modern Stack (2025-2026)

## Driver per vendor — JANGAN KEBOLAK
- **Adreno (Snapdragon)** → **Turnip** + DXVK. BUKAN Vortek/VirGL/WineD3D.
- **Mali (MediaTek/Exynos)** → **driver-gated**. Driver lama/unknown = DXVK-Sarek safe default. MTK/Mali driver `v40+` = DXVK 2.x mulai layak dites. Driver `v50+` = VKD3D/DX12-light experimental. Detail: kb_lookup("mtk-mali-modern").

## DirectX translation layer
- DX9 / DX10 / DX11 → **DXVK** (Mali: Sarek untuk driver lama/unknown; DXVK 2.x untuk driver MTK `v40+` + Vulkan 1.3 path).
- DX12 → **VKD3D-Proton**.
- DX8 (SH2/3 era 2001-03) → **DXVK 2.4+** (d8vk udah merged — d3d8to9 standalone redundant, lihat kb_lookup("evolution")).

---

## Mali stack 2025-2026 (UPDATED — KB lama outdated)

**Outdated rule (sebelum 2024):** Mali = Vortek/WineD3D doang, DX9 max.
**Modern reality (2025+):** Mali handle DX11 via DXVK-Sarek atau DXVK 2.x, tergantung driver. DX12-lite mulai masuk akal di sebagian MTK/Mali driver `v50+`, tapi tetap experimental.

### Default stack Mali modern
- **Driver Vulkan**: Mesa Turnip ga jalan di Mali — pake **driver vendor Mali** (built-in HP) atau **Vortek (Wear/EOA)** kalau emulator support custom driver.
- **DX wrapper**:
  - Driver Mali/MTK unknown atau `< v40` → **DXVK-Sarek** safe default. Fork DXVK khusus GPU tanpa Vulkan 1.3 (nambal BCn + ClipDistance).
  - Driver Mali/MTK `v40-v49` + Vulkan 1.3 → **DXVK 2.x** boleh jadi primary test buat D3D9/10/11. Sarek tetap fallback.
  - Driver Mali/MTK `>= v50` + Vulkan 1.3+ → **DXVK 2.x** primary test, **VKD3D/DX12-light** experimental.
  - **Versi Sarek REAL — 2 repo:**
    - Canonical `pythonlover02/DXVK-Sarek`: 1.10.4–1.10.9, **1.11.0** ("Red River"), **1.12.0** ("Late Anniversary", +dyasync +d7vk).
    - Fork `zeyadadev/DXVK-Sarek`: **`v1.11.1-mali-fix`** (rilis 2025-09-06, base 1.11.0 + fix Mali black-screen + unbound-texture fix, test Mali-G610, asset `dxvk-sarek-v1.11.1-mali-fix.tar.gz`, ~1.5k dl). **Sarek 1.11.1 = REAL**, justru Mali-specific.
  - ⚠️ **JANGAN ketuker:** `DXVK 1.7.2 async` / `1.7.3 async` / `1.10.3 async` itu **build Sporif/dxvk-async** (archived Nov 2025) — BUKAN Sarek. Official DXVK & Sporif GA ADA 1.11.x. Yang punya 1.11.1 cuma fork Sarek zeyadadev.
  - `dynasync` = fitur di Sarek 1.12.0. StevenMXZ `dxvk-11.1-sarek-async.wcp` = Sarek **1.11.1** (mali-fix) varian async.
- **Wine/Proton**: **Proton-arm64ec** (Proton port khusus ARM64EC). Versi: `Proton-10.0.99-arm64ec`, `wine-10.0-arm64ec`.
- **CPU translator**:
  - GameHub/BannerHub → **FEX** (versi 202510, 202604, dll — cek release).
  - Winlator → **Box64** (versi 0.4.2, current — cek kb_lookup("evolution") buat timeline).
- **Preset preset**: di GameHub/BannerHub mostly **PERFORMANCE / EXTREME** (bukan Compatibility lagi — Compatibility outdated default).
- **Winlator fork populer Mali**: **Star Bionic 1.1 (Ludashi variant)**, **Ludashi 2.9 beta**.

### MediaTek/Mali driver gate — rule baru 2026

**[COMMUNITY SIGNAL + THEORETICAL]** Jangan decide dari nama GPU doang. Driver Android vendor bisa bikin Helio/Dimensity lama naik kelas.

| Driver Mali/MTK | D3D9/10/11 | DX12 | Bot action |
|---|---|---|---|
| Unknown | Jangan tebak | Jangan tebak | Tanya driver + Vulkan. Kalau butuh fallback cepat: Sarek/1.7.x. |
| `< v40` | Sarek/1.7.x | No | Jangan saran DXVK 2.x. |
| `v40-v49` | DXVK 2.x viable test | No / sangat lemah | Tes DXVK 2.5-2.7, fallback Sarek. |
| `>= v50` | DXVK 2.x viable | VKD3D-light experimental | Boleh coba VKD3D untuk DX12 ringan, fallback DX11 mode. |

Detail lengkap: kb_lookup("mtk-mali-modern").

**Sumber Turnip alt** (cross-ref): selain StevenMXZ Adrenotools-Drivers (A8xx only), ada The412Banner/Banners-Turnip yang build Mesa main → 3 zip per release (A6xx/A7xx universal + A8xx + 710/720 test), cadence hourly. User butuh universal/710/720 → Banners-Turnip. Detail: kb_lookup("the412banner").
- **Wrapper extra**: **leegao wrapper** — buat game tertentu (DX9-DX11 legacy heavy).

### Vortek/WineD3D = LEGACY (kapan masih relevan)
- Game DX8 atau OpenGL doang.
- Game lawas yg bener-bener crash di DXVK-Sarek (rare — coba build async ringan `dxvk-1.7.2.wcp` dulu).
- HP super low-end (Helio G35/G37) yg ga sanggup Sarek dynasync.

### Tier per chipset Mali
- **Helio G99 / Mali-G57 MC2**: **[VERIFIED — Noysz, GTA V DX10 1024x600 Medium]** DXVK **1.7.2** (package `dxvk-1.7.2.wcp` StevenMXZ — build ringan; "async" label longgar) — terbukti lebih mulus daripada Sarek 1.12.0 pada stack lama/teruji itu. **Jangan generalisasi ke semua G99 baru.** Kalau driver `v40+`/`v50+` dan Vulkan 1.3.303 muncul, pakai rule `mtk-mali-modern`.
- **Dimensity 8020-8200 / Mali-G610**: driver unknown/old → DXVK 1.7.3 async atau Sarek 1.11.1/1.12.0. Driver `v40+` → DXVK 2.x test path.
- **Dimensity 8400 Ultra / Mali-G720 MC7**: **[VERIFIED]** baseline lama DXVK 1.7.3 async + Proton-10.0.99-arm64ec + Ludashi 2.9+. **[THEORETICAL]** DXVK 2.5/2.6/2.7 vanilla masuk akal kalau Vulkan 1.3+GPL + driver `v40+`; default sekarang = driver-gated, bukan baseline tunggal.

---

## Mali Vulkan limitation (TIER-AWARE, bukan blanket "Selalu Sarek")

Mali Valhall TIER LAMA secara native miss:
1. **BCn texture compression** (BC1-BC7). DXVK vanilla butuh BCn → crash di `vkCreateShaderModule`. **Sarek**: emulate BCn via CPU decompression, atau swap ke uncompressed.
2. **gl_ClipDistance built-in**. DXVK vanilla pake ClipDistance buat clipping plane. **Sarek**: nambal SPIR-V, buang ClipDistance.

**Mali tier BARU (G720+, driver 2025+)** dan sebagian MTK/Mali driver `v40+` mulai bisa punya jalur Vulkan 1.3 yang cukup buat DXVK 2.x. Sarek opsional/fallback, BUKAN mandatory kalau driver benar-benar modern.

**[THEORETICAL]** Decision matrix (interpolasi spec Mali + DXVK feature reqs — **BELUM** dari bench database):
| Mali tier | Vulkan | DXVK (theoretical) |
|-----------|--------|--------------------|
| Valhall awal (G57, G68, Helio G99) + driver `< v40` | 1.1/1.2 | Sarek **1.11.1-mali-fix / 1.12.0** atau 1.7.x per-game |
| Valhall awal/G610/G615 + driver `v40+` | 1.3 path | DXVK **2.5/2.6/2.7 vanilla** test path; Sarek fallback |
| MTK/Mali driver `v50+` | 1.3+ | DXVK 2.x primary test + VKD3D-light experimental |
| G720+ (Dim 8400 Ultra, G725, Immortalis G720/G925) + GPL ada | 1.3 | DXVK **2.5/2.6/2.7 vanilla** (architectural, driver-gated) |

**[REVEALED PREFERENCE]** community signal: StevenMXZ Winlator-Contents CDN ship DXVK 11.1-sarek-async sebagai mainline default untuk Mali. Itu tetap kuat untuk driver unknown/lama. Tapi kalau user nunjukin driver MTK `v40+`/`v50+`, jangan override bukti driver baru dengan rule Sarek lama.

**Confidence rules buat bot:**
- Per-game `[VERIFIED]` preset di `per-game.md` → SELALU MENANG dari matrix manapun
- Matrix di sini = `[THEORETICAL]` — kalau dipake, WAJIB echo ke user dengan label "ini estimasi, belum ke-test"
- StevenMXZ CDN default Sarek = bukti komunitas, layak jadi soft-default kalau user belum ada driver info/empirical
- MTK/Mali driver `v40+` dan `v50+` = wajib cek `mtk-mali-modern.md` sebelum jawab DXVK 2.x/DX12.

## Exynos / Xclipse
Sub-family Mali tapi quirky. Pake **ExynosTools** layer.
Repo: `github.com/WearyConcern1165/ExynosTools`.

---

## GPU spoofing (DXVK)
Vendor ID: NVIDIA `10de`, AMD `1002`, Intel `8086`.

Spoofing **CUMA ubah identitas**, BUKAN naikin performa.

Mapping rekomendasi:
- Helio G99 / Dim 6k-7k → RTX 2060 SUPER (`10de` / `1f06`)
- Dim 8020-8200 → RTX 3060 (`10de` / `2503`)
- Dim 8300-8350 → RTX 3070 (`10de` / `2484`)
- Dim 8400 Ultra → RTX 3080 (`10de` / `2206`)
- SD 8 Elite → RTX 4080 (`10de` / `2704`)

Setting dxvk.conf:
```
dxgi.customVendorId = 10de
dxgi.customDeviceId = 2484
dxgi.customDeviceDesc = "NVIDIA GeForce RTX 3070"
```

---

## Common error → fix mapping
- `vkCreateShaderModule failed` (Mali driver old/unknown) → ganti ke **DXVK-Sarek**. Bukan WineD3D.
- `DXVK 2.x crash di MTK/Mali driver v40+` → fallback Sarek/1.7.x; jangan langsung blame Wine.
- `DX12 Mali gagal launch` → kalau driver `< v50`, itu expected. Kalau `>= v50`, treat sebagai VKD3D-light experimental, coba DX11 mode.
- `vkMapMemory -5` (Mali) → `BOX64_MMAP32=0` ATAU Sarek terbaru.
- `VK_ERROR_OUT_OF_DEVICE_MEMORY` → turunin `d3d9.maxAvailableMemory` atau `dxvk.maxChunkSize`.
- Black screen intro DX9/11 → `deferSurfaceCreation=True` (kecuali Payday 2).
- Game refuse launch karena cek GPU → spoof vendor ke NVIDIA/AMD.
- Shader stutter di Mali → DXVK **dynasync** branch (bukan async biasa).
