# VKD3D-Proton — DX12 → Vulkan

VKD3D-Proton itu translator DX12 → Vulkan. **BUKAN DXVK.**
- DX12 → VKD3D-Proton.
- DX9/10/11 → DXVK.

Game DX12 di Android super berat. Bahkan flagship Adreno 8 Elite struggle. Untuk Mali/MTK 2026, jangan pakai rule blanket "mustahil"; pakai driver gate: driver `< v50` jangan, driver `>= v50` boleh coba DX12-light experimental.

Sumber [VERIFIED via GitHub release]: VKD3D-Proton `v3.0.1` (6 Mei 2026) menambah fixes untuk Turnip test suite dan beberapa optimisasi mobile/tile GPU: deferred clears/discards, render pass suspend-resume, dan MSAA resolve work. Ini menaikkan peluang DX12 mobile, tapi bukan jaminan semua game DX12 jalan.

---

## VKD3D_CONFIG = dxr11
WHAT: matikan ray tracing layer di driver.
WHY: ray tracing DX12 (DXR) sangat berat — bahkan GPU mobile flagship ga sanggup smooth. Auto-disable = save VRAM + boost FPS.
TRADE-OFF: visual ga punya RT (tapi RT mobile = ga viable anyway).
DEFAULT-IF: dxr11. WAJIB buat semua game DX12 di mobile.
NOTE: ada beberapa nilai: `dxr`, `dxr11`. `dxr11` lebih agresif.

## VKD3D_FEATURE_LEVEL = 12_1
WHAT: max DX12 feature level yg di-ekspos ke game.
WHY: beberapa game refuse to launch kalau feature level mismatch.
DEFAULT-IF: 12_1.

## VKD3D_DEBUG = none
WHAT: matikan debug log.
WHY: log = waste I/O.
DEFAULT-IF: none.

## VKD3D_SHADER_DEBUG = none
DEFAULT-IF: none.

## VKD3D_SHADER_CACHE_PATH = /path/dir
WHAT: lokasi cache shader VKD3D.
WHY: shader compile DX12 LAMA banget (stuttering shader-compile). Cache = launch 2 dan seterusnya mulus.
DEFAULT-IF: set ke storage cepat (internal storage, bukan SD card lambat).

## VKD3D_FILTER_DEVICE_NAME
WHAT: paksa pake GPU dengan nama spesifik.
WHY: jarang dibutuhin di mobile (cuma 1 GPU).
DEFAULT-IF: kosong.

## Setup wajib game DX12
1. `WINEDLLOVERRIDES="d3d12=n;dxgi=n"`
2. `VKD3D_CONFIG=dxr11`
3. `VKD3D_FEATURE_LEVEL=12_1`
4. Pastikan driver Vulkan support feature: descriptor indexing, mesh shader (kalau game pake).
5. Adreno: minimal Adreno 730 buat usable performance.
6. Mali/MTK:
   - Driver unknown atau `< v50`: jangan rekomendasi DX12; arahkan DX11 mode atau DXVK-Sarek/DXVK 2.x sesuai driver.
   - Driver `>= v50` + Vulkan 1.3+: VKD3D boleh dicoba untuk **DX12 ringan**. Heavy AAA DX12 tetap jangan dijanjikan.
   - Kalau user cuma bilang "Mali bisa DX12 sekarang", minta `Driver version` + `Vulkan version` dulu. Detail: kb_lookup("mtk-mali-modern").

## Game DX12 yg pernah di-verify jalan
- RE4 Remake: butuh `VKD3D_CONFIG=dxr11`, Adreno 7XX flagship.
- Cyberpunk 2077: super berat, ga praktis di mobile.
- Hogwarts Legacy: ada loophole DX11 fallback, prefer pake itu daripada DX12.

## Bot rules Mali/MTK

- Jangan jawab "Mali DX12 impossible" tanpa cek driver. Rule baru: `< v50` = no, `>= v50` = experimental/lightweight.
- Jangan jadikan video/Reddit/X sebagai universal proof. Itu `[COMMUNITY SIGNAL]` per device.
- Kalau user minta preset DX12 di Mali, jawab dengan dua cabang: VKD3D-light test path + DX11 fallback path.
