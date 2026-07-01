#!/usr/bin/env python3
import json
import sys
import urllib.error
import urllib.request


URL = "http://127.0.0.1:8765/fetch"


def post_json(payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=35) as res:
        return json.loads(res.read().decode("utf-8"))


def main():
    payloads = [
        ("VALID_HTTPS", {"url": "https://example.com"}, True),
        ("INVALID_HTTP", {"url": "http://example.com"}, False),
        ("SSRF_LOCAL_IP", {"url": "https://example.com", "ip": "127.0.0.1"}, False),
        ("SSRF_PRIVATE_IP", {"url": "https://example.com", "ip": "192.168.1.5"}, False),
        ("INVALID_IP_FORMAT", {"url": "https://example.com", "ip": "not_an_ip"}, False),
    ]

    failed = 0
    for name, payload, expected_ok in payloads:
        print(f"Testing {name}: ", end="")
        try:
            data = post_json(payload)
            ok = bool(data.get("ok"))
            status = data.get("status")
            passed = ok == expected_ok
            failed += 0 if passed else 1
            verdict = "PASS" if passed else "FAIL"
            print(f"{verdict} ok={ok} status={status}")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            failed += 1
            print(f"FAIL request error: {e}")

    return failed


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
