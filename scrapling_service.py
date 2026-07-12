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
import urllib.parse
import httpx
import random

from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

HOST = "127.0.0.1"
PORT = 8765
MAX_CHARS = 7000
FETCH_TIMEOUT_MS = 25000
MAX_CONCURRENT = 3

_sem = asyncio.Semaphore(MAX_CONCURRENT)

def _is_blocked_ip(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return True
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )

def _extract_text(page) -> str:
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

    ip = (data or {}).get("ip")
    if isinstance(ip, str) and ip and _is_blocked_ip(ip):
        return JSONResponse({"ok": False, "status": 0})

    try:
        from scrapling.fetchers import StealthyFetcher
        import anyio

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
        return JSONResponse({"ok": False, "status": 0})

async def health(request):
    return JSONResponse({"ok": True})

async def fetch_dlc_name_metadata(client: httpx.AsyncClient, dlc_id: int) -> tuple[str, str]:
    dlc_str = str(dlc_id)
    try:
        res = await client.get(f"https://store.steampowered.com/api/appdetails?appids={dlc_str}")
        if res.status_code == 200:
            data = res.json()
            if data and data.get(dlc_str, {}).get("success"):
                raw_name = data[dlc_str]["data"].get("name", f"DLC_Unknown_Asset_{dlc_str}")
                return (dlc_str, raw_name)
    except Exception:
        pass
    return (dlc_str, f"DLC_Unknown_Asset_{dlc_str}")

async def create_asset_mapping(request):
    try:
        data = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Integritas format payload JSON ditolak."})

    appid = str(data.get("appid", "")).strip()
    if not appid.isdigit():
        return JSONResponse({"ok": False, "error": "Parameter 'appid' I/O tidak valid atau bukan merupakan angka metrik numerik utuh."})

    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            res = await client.get(f"https://store.steampowered.com/api/appdetails?appids={appid}")
            if res.status_code != 200:
                return JSONResponse({"ok": False, "error": f"Kegagalan HTTP {res.status_code}: Repositori publik menolak koneksi transmisi."})
            
            api_data = res.json()
            if not api_data or not api_data.get(appid, {}).get("success"):
                return JSONResponse({"ok": False, "error": "Akses metadata diblokir, atau repositori data untuk ID tersebut tidak eksis."})

            app_data = api_data[appid].get("data", {})
            dlcs = app_data.get("dlc", [])
            
            if not dlcs:
                return JSONResponse({"ok": False, "error": "Tidak terdeteksi adanya pemetaan struktur sub-elemen (DLC) untuk arsitektur aplikasi tersebut."})

            dlcs_limited = dlcs[:15]
            tasks = [fetch_dlc_name_metadata(client, d_id) for d_id in dlcs_limited]
            results = await asyncio.gather(*tasks)

            ini_lines = [
                "[steam]",
                f"appid = {appid}",
                "unlockall = true",
                "orgapi = steam_api_o.dll",
                "orgapi64 = steam_api64_o.dll",
                "extraprotection = false",
                "forceappid = false",
                "",
                "[dlc]"
            ]
            
            for d_id, d_name in results:
                safe_dlc_name = d_name.replace('\n', ' ').replace('\r', '').strip()
                ini_lines.append(f"{d_id} = {safe_dlc_name}")

            if len(dlcs) > 15:
                ini_lines.append(f"; ... [Dipotong: Sisa {len(dlcs)-15} entri lainnya digugurkan demi efisiensi I/O transmisi Telegram]")

            return JSONResponse({
                "ok": True,
                "content": "\n".join(ini_lines)
            })
    except httpx.RequestError as exc:
        return JSONResponse({"ok": False, "error": f"Latensi Sistem Jaringan: {str(exc)}"})
    except Exception as exc:
        return JSONResponse({"ok": False, "error": f"Gangguan Eksekusi Node Internal: {str(exc)}"})

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0"
]

TARGETS = [
    {"name": "SteamRIP", "url": "https://steamrip.com/?s={query}", "cf": True},
    {"name": "SteamGG", "url": "https://steamgg.net/?s={query}", "cf": False},
    {"name": "DODIRepacks", "url": "https://dodi-repacks.site/?s={query}", "cf": False},
    {"name": "FitGirl", "url": "https://fitgirl-repacks.site/?s={query}", "cf": False},
    {"name": "OvaGames", "url": "https://ovagames.com/?s={query}", "cf": False},
    {"name": "ElAmigos", "url": "https://elamigos.site/?s={query}", "cf": False},
]

# Sumber API-based / SPA (bukan HTML-anchor scrape spt TARGETS) — handler custom masing2.
# Relevance STRICT (word-boundary AND) biar ga bocor spt "war"->"warlocks".
_HUNT_STOPWORDS = {"of", "the", "a", "and", "di", "de", "game"}


def _rel_words(query: str) -> list:
    return [w for w in re.sub(r'[^\w\s]', ' ', query).lower().split()
            if len(w) > 2 and w not in _HUNT_STOPWORDS]


def _strict_match(title: str, words: list) -> bool:
    # word-boundary: 'war' TIDAK match 'warlocks'; semua kata query wajib ada (AND).
    low = title.lower()
    return bool(words) and all(re.search(r'\b' + re.escape(w) + r'\b', low) for w in words)


async def _hunt_squid(client: httpx.AsyncClient, query: str):
    # gog.squid.wtf: JSON API /api/games?search= (butuh quote_plus, response key 'games').
    name = "GOG.squid"
    try:
        url = "https://gog.squid.wtf/api/games?search=" + urllib.parse.quote_plus(query)
        r = await client.get(url, headers={"Accept": "application/json"})
        if r.status_code != 200:
            return name, []
        d = r.json()
        items = d.get("games") or d.get("data") or (d if isinstance(d, list) else [])
        words = _rel_words(query)
        out = []
        for it in items:
            title, slug = it.get("title", ""), it.get("slug", "")
            if slug and _strict_match(title, words):
                out.append({"title": title, "link": f"https://gog.squid.wtf/game/{slug}"})
            if len(out) >= 2:
                break
        return name, out
    except Exception:
        return name, []


async def _hunt_goggames(client: httpx.AsyncClient, query: str):
    # gog-games.to: SPA, API /api/web/all-games balik FULL katalog (~6400) -> filter client-side.
    name = "GOG-Games"
    try:
        r = await client.get("https://gog-games.to/api/web/all-games",
                             headers={"Accept": "application/json"}, timeout=30.0)
        if r.status_code != 200:
            return name, []
        d = r.json()
        items = d if isinstance(d, list) else d.get("data", [])
        words = _rel_words(query)
        out = []
        for it in items:
            title, slug = it.get("title", ""), it.get("slug", "")
            if slug and _strict_match(title, words):
                out.append({"title": title, "link": f"https://gog-games.to/game/{slug}"})
            if len(out) >= 2:
                break
        return name, out
    except Exception:
        return name, []


async def _hunt_rexa(client: httpx.AsyncClient, query: str):
    # rexagames.com: forum IPS, search /search/?q=&type=downloads_file -> anchor /files/file/.
    # Dedup by clean path (buang ?do=findComment), strip varian "More information about".
    from bs4 import BeautifulSoup
    name = "RexaGames"
    try:
        url = ("https://rexagames.com/search/?q=" + urllib.parse.quote_plus(query)
               + "&type=downloads_file")
        r = await client.get(url, headers={"User-Agent": random.choice(USER_AGENTS)},
                            follow_redirects=True)
        if r.status_code != 200:
            return name, []
        soup = BeautifulSoup(r.text, "html.parser")
        words = _rel_words(query)
        out, seen = [], set()
        for a in soup.find_all("a", href=re.compile(r'/files/file/\d')):
            href = (a.get("href", "") or "").split("?")[0].rstrip("/")
            title = re.sub(r'\s+', ' ', (a.get("title") or a.get_text() or "").strip())
            title = re.sub(r'^More information about\s*.?', '', title).strip('"')
            if not href or href in seen or not title or len(title) < 4:
                continue
            if _strict_match(title, words):
                seen.add(href)
                out.append({"title": title, "link": href})
            if len(out) >= 2:
                break
        return name, out
    except Exception:
        return name, []

def _parse_results(html: str, target: dict, query: str) -> list:
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')

    query_words = [w.lower() for w in query.split() if len(w) > 2]
    if not query_words:
        query_words = [query.lower()]

    clean_results = []
    for a in soup.find_all('a'):
        href = a.get('href', '').strip()
        if not href or href.startswith('#') or href.startswith('javascript'):
            continue

        title = (a.get('title') or a.text).strip()
        title = re.sub(r'<[^>]+>', '', title).strip()
        if not title or len(title) < 4:
            continue

        href_lower = href.lower()
        if any(x in href_lower for x in ['login', 'register', 'password', 'setting', 'contact', 'about', 'faq', 'term', 'tag/', 'category/']):
            continue

        title_lower = title.lower()
        
        # Beautify generic titles first (so they can pass relevance check)
        if title_lower == "download" or title_lower == "read more" or "random" in title_lower:
            extracted = href.split('/')[-1].replace('_', ' ').replace('-v1', '').replace('.html', '').replace('-', ' ').strip()
            # clean up url parameters if any
            extracted = extracted.split('?')[0]
            title = extracted if len(extracted) > 4 else f"{target['name']} Release"
            title_lower = title.lower()

        # Strict relevance check ONLY on title, to prevent metadata/date links from passing
        is_relevant = any(w in title_lower for w in query_words)
        if not is_relevant:
            continue

        base_url = target["url"].split('?')[0]
        absolute_link = urllib.parse.urljoin(base_url, href)

        if not any(x['link'] == absolute_link for x in clean_results):
            clean_results.append({"title": title, "link": absolute_link})

        if len(clean_results) >= 2:
            break

    return clean_results

async def _fetch_target(client: httpx.AsyncClient, target: dict, query: str):
    url = target["url"].format(query=urllib.parse.quote(query))
    headers = {"User-Agent": random.choice(USER_AGENTS)}

    try:
        res = await client.get(url, headers=headers, follow_redirects=True)

        # Jika kena Cloudflare 403 dan target ditandai cf=True, fallback ke Playwright
        if res.status_code == 403 and target.get("cf"):
            try:
                from scrapling.fetchers import StealthyFetcher
                import anyio

                def _stealth():
                    return StealthyFetcher.fetch(url, headless=True, network_idle=True, timeout=20000)

                async with _sem:
                    page = await anyio.to_thread.run_sync(_stealth)
                html = getattr(page, 'body', '') or ''
                if html:
                    return target["name"], _parse_results(html, target, query)
            except Exception:
                pass
            return target["name"], []

        if res.status_code != 200:
            return target["name"], []

        return target["name"], _parse_results(res.text, target, query)
    except Exception as exc:
        return target["name"], []

async def hunt_game_handler(request):
    try:
        data = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Integritas format payload JSON ditolak."})

    raw_query = str(data.get("query", "")).strip()
    query = re.sub(r'[^\w\s\-\.]', ' ', raw_query).strip()
    if not query:
        return JSONResponse({"ok": False, "error": "Parameter 'query' I/O tidak valid."})

    try:
        async with httpx.AsyncClient(verify=False, timeout=25.0) as client:
            tasks = [_fetch_target(client, t, query) for t in TARGETS]
            tasks += [_hunt_squid(client, query),
                      _hunt_goggames(client, query),
                      _hunt_rexa(client, query)]
            results_tuples = await asyncio.gather(*tasks)
            
        grouped = {k: v for k, v in results_tuples if v}
        
        if not grouped:
            return JSONResponse({"ok": True, "content": "❌ Matriks data tidak ditemukan di parameter domain indeks Pre-installed FMHY."})
            
        lines = []
        lines.append("🗃️ [PRE-INSTALLED / PORTABLE DIRECT PLAY INDEX]")
        lines.append("══════════════════════════════════════")
        lines.append(f"🔍 Pencarian Agregasi: `{query}`\n")
        
        for name, items in grouped.items():
            lines.append(f"📦 *{name}*")
            for item in items:
                lines.append(f"🎮 {item['title']}")
                lines.append(f"🔗 {item['link']}\n")
                
        final_content = "\n".join(lines).strip()
        return JSONResponse({"ok": True, "content": final_content})
    except Exception as exc:
        return JSONResponse({"ok": False, "error": f"Gangguan Eksekusi Node Internal: {str(exc)}"})

route_hunt_game = Route("/api/v1/hunt-game", hunt_game_handler, methods=["POST"])

app = Starlette(
    routes=[
        Route("/fetch", fetch, methods=["POST"]),
        Route("/api/v1/asset-mapping", create_asset_mapping, methods=["POST"]),
        route_hunt_game,
        Route("/health", health, methods=["GET"]),
    ]
)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
