#!/usr/bin/env python3
"""
COPUX scrapling web-fetch microservice.

Localhost-only (127.0.0.1) HTTP service yang dipanggil bot.js webFetch buat
nembus anti-bot/Cloudflare lewat Scrapling. Bot.js TETEP yang jadi otoritas
SSRF (resolve + pin IP + reject private) SEBELUM manggil service ini — service
cuma defense-in-depth: re-reject private IP sendiri biar ga ada single point.

Kontrak: POST /fetch {"url": "...", "ip": "1.2.3.4"} -> {"ok", "status", "text"}
- Ga pernah echo error internal (cuma {"ok": false, "status": 0}) — anti SSRF-probe leak.
- Output di-truncate biar match webFetch MAX.
Run: /root/.venv/bin/python scrapling_service.py
"""
import asyncio
import ipaddress
import re

from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

HOST = "127.0.0.1"
PORT = 8765
MAX_CHARS = 7000
FETCH_TIMEOUT_MS = 25000
MAX_CONCURRENT = 3   # cap sesi Playwright paralel — anti OOM (tiap fetch = 1 chromium)

_sem = asyncio.Semaphore(MAX_CONCURRENT)


def _is_blocked_ip(addr: str) -> bool:
    """Tolak loopback/private/link-local/CGNAT/reserved. Belt-and-suspenders;
    bot.js udah reject duluan, tapi jangan percaya itu sebagai satu-satunya gate."""
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return True  # bukan IP valid → tolak
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def _extract_text(page) -> str:
    """Ambil teks dari hasil fetch Scrapling. Page punya .get_all_text()/.body;
    fallback ke regex-strip biar ga pernah throw cuma karena bentuk objek beda versi."""
    try:
        txt = page.get_all_text(ignore_tags=("script", "style"))
        if txt:
            return txt
    except Exception:
        pass
    try:
        body = page.body
        if body:
            return re.sub(r"<[^>]+>", " ", body)
    except Exception:
        pass
    return ""


async def fetch(request):
    try:
        data = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "status": 0})

    url = (data or {}).get("url")
    if not isinstance(url, str) or not url.lower().startswith("https://"):
        return JSONResponse({"ok": False, "status": 0})

    # Defense-in-depth: kalau bot ngirim IP tervalidasi, pastiin bukan private.
    # Kalau ga ngirim IP, service ga resolve sendiri (biar ga jadi SSRF resolver) —
    # cukup andelin bot guard + reject yang jelas-jelas private kalau ip disertakan.
    ip = (data or {}).get("ip")
    if isinstance(ip, str) and ip and _is_blocked_ip(ip):
        return JSONResponse({"ok": False, "status": 0})

    try:
        # Import di dalam handler biar startup cepet & error import ga matiin proses.
        from scrapling.fetchers import StealthyFetcher
        import anyio

        # StealthyFetcher pakai Playwright SYNC API — kalau dipanggil langsung di
        # dalam asyncio loop dia throw "Sync API inside the asyncio loop". Jalanin
        # di threadpool biar sync fetch ga nabrak event loop starlette.
        def _blocking_fetch():
            return StealthyFetcher.fetch(
                url,
                headless=True,
                network_idle=False,
                timeout=FETCH_TIMEOUT_MS,
            )

        async with _sem:
            page = await anyio.to_thread.run_sync(_blocking_fetch)
        status = getattr(page, "status", 0) or 0
        text = _extract_text(page)
        text = re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", text)).strip()
        if len(text) > MAX_CHARS:
            text = text[:MAX_CHARS] + "\n...[dipotong]"
        return JSONResponse({"ok": True, "status": int(status), "text": text})
    except Exception:
        # JANGAN bocorin detail (host/IP/stack) — anti SSRF-probe confirmation.
        return JSONResponse({"ok": False, "status": 0})


async def health(request):
    return JSONResponse({"ok": True})


app = Starlette(
    routes=[
        Route("/fetch", fetch, methods=["POST"]),
        Route("/health", health, methods=["GET"]),
    ]
)


if __name__ == "__main__":
    import uvicorn

    # bind 127.0.0.1 SAJA — jangan 0.0.0.0. Service ga boleh ke-reach dari LAN.
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
