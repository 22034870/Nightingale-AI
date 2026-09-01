#!/usr/bin/env python3
"""
Point your Telegram bot at the deployed webhook.

    python scripts/telegram_setup.py
    python scripts/telegram_setup.py --url https://your-app.vercel.app
    python scripts/telegram_setup.py --status
    python scripts/telegram_setup.py --delete

Reads TELEGRAM_BOT_TOKEN from .env.local. Generates a webhook secret on first
run and tells you to add it to .env.local and to Vercel.

WHY THE SECRET MATTERS: without it, the webhook endpoint is a public,
unauthenticated way for anyone to drive your bot on someone else's behalf.
Telegram signs every request with it, and the route rejects anything that
doesn't match.

The webhook must be HTTPS and publicly reachable — Telegram cannot call
localhost. Use the Vercel URL.
"""

import argparse
import json
import pathlib
import secrets
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
ENV = ROOT / ".env.local"
DEFAULT_URL = "https://nightingale-ai-drab.vercel.app"


def read_env() -> dict:
    values = {}
    if ENV.exists():
        for line in ENV.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                values[k.strip()] = v.strip()
    return values


def api(token: str, method: str, payload: dict | None = None):
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = json.dumps(payload).encode() if payload else None
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"} if data else {}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"ok": False, "description": f"HTTP {e.code}"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=None, help="Public HTTPS base URL of the deployment")
    ap.add_argument("--status", action="store_true", help="Show current webhook state")
    ap.add_argument("--delete", action="store_true", help="Remove the webhook")
    args = ap.parse_args()

    env = read_env()
    token = env.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        sys.exit(
            "TELEGRAM_BOT_TOKEN is not set in .env.local.\n\n"
            "Get one from @BotFather in Telegram:\n"
            "  1. Message @BotFather\n"
            "  2. Send /newbot\n"
            "  3. Choose a display name, then a username ending in 'bot'\n"
            "  4. Copy the token it gives you into .env.local as TELEGRAM_BOT_TOKEN"
        )

    me = api(token, "getMe")
    if not me.get("ok"):
        sys.exit(f"Token rejected by Telegram: {me.get('description')}")
    bot = me["result"]
    print(f"Bot: @{bot['username']} ({bot.get('first_name')})")

    if args.status:
        info = api(token, "getWebhookInfo").get("result", {})
        print(f"  url               : {info.get('url') or '(none)'}")
        print(f"  pending updates   : {info.get('pending_update_count', 0)}")
        if info.get("last_error_message"):
            print(f"  LAST ERROR        : {info['last_error_message']}")
            print("  (Telegram retries; a persistent error here means the route is failing)")
        return

    if args.delete:
        r = api(token, "deleteWebhook", {"drop_pending_updates": True})
        print("Webhook removed." if r.get("ok") else f"Failed: {r.get('description')}")
        return

    secret = env.get("TELEGRAM_WEBHOOK_SECRET", "").strip()
    generated = False
    if not secret:
        secret = secrets.token_urlsafe(32)
        generated = True

    base = (args.url or env.get("NEXT_PUBLIC_BASE_URL") or DEFAULT_URL).rstrip("/")
    if not base.startswith("https://"):
        sys.exit(f"Webhook URL must be HTTPS and public. Got: {base}\nTelegram cannot reach localhost.")

    hook = f"{base}/api/telegram/webhook"
    result = api(
        token,
        "setWebhook",
        {
            "url": hook,
            "secret_token": secret,
            "allowed_updates": ["message", "callback_query"],
            "drop_pending_updates": True,
        },
    )

    if not result.get("ok"):
        sys.exit(f"setWebhook failed: {result.get('description')}")

    print(f"Webhook set: {hook}")

    if generated:
        print("\n" + "=" * 68)
        print("ADD THIS SECRET IN TWO PLACES, then redeploy:")
        print(f"\n  TELEGRAM_WEBHOOK_SECRET={secret}\n")
        print("  1. .env.local")
        print("  2. Vercel > Settings > Environment Variables")
        print("\nUntil it is set in Vercel, the endpoint accepts unsigned requests.")
        print("=" * 68)

    info = api(token, "getWebhookInfo").get("result", {})
    if info.get("last_error_message"):
        print(f"\nTelegram reports a recent error: {info['last_error_message']}")

    print(f"\nOpen https://t.me/{bot['username']} and send /start")


if __name__ == "__main__":
    main()
