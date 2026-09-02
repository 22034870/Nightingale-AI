#!/usr/bin/env python3
"""
Point your Telegram bot at the deployed webhook.

    python scripts/telegram_setup.py
    python scripts/telegram_setup.py --url https://your-app.vercel.app
    python scripts/telegram_setup.py --status
    python scripts/telegram_setup.py --delete

Reads TELEGRAM_BOT_TOKEN from .env.local, and generates a webhook secret on
first run — writing it straight into .env.local so re-running is idempotent.

WHY THE SECRET MATTERS: without it, the webhook endpoint is a public,
unauthenticated way for anyone to drive your bot on someone else's behalf.
Telegram signs every request with it, and the route rejects anything that
doesn't match.

WHY IT IS WRITTEN TO THE FILE RATHER THAN PRINTED: an earlier version printed
the secret and asked for two manual copies, into .env.local and into Vercel. The
natural failure is copying it to only one — and then every re-run generated
ANOTHER secret and re-registered it with Telegram, leaving Telegram and the
deployment permanently out of step. The webhook returned 401 with no obvious
cause. Persisting it here makes that impossible.

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


def write_secret(secret: str) -> None:
    """Persist the webhook secret so re-running never regenerates it."""
    text = ENV.read_text(encoding="utf-8") if ENV.exists() else ""
    key = "TELEGRAM_WEBHOOK_SECRET="

    if key in text:
        lines = [
            f"{key}{secret}" if line.strip().startswith(key) else line
            for line in text.splitlines()
        ]
        text = "\n".join(lines) + "\n"
    else:
        text = text.rstrip("\n") + f"\n{key}{secret}\n"

    ENV.write_text(text, encoding="utf-8")
    print(f"Wrote TELEGRAM_WEBHOOK_SECRET to {ENV.name}")


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
            "  4. Copy the token into .env.local as TELEGRAM_BOT_TOKEN"
        )

    me = api(token, "getMe")
    if not me.get("ok"):
        sys.exit(f"Token rejected by Telegram: {me.get('description')}")
    bot = me["result"]
    print(f"Bot: @{bot['username']} ({bot.get('first_name')})")

    if args.status:
        info = api(token, "getWebhookInfo").get("result", {})
        print(f"  url             : {info.get('url') or '(none)'}")
        print(f"  pending updates : {info.get('pending_update_count', 0)}")
        if info.get("last_error_message"):
            print(f"  LAST ERROR      : {info['last_error_message']}")
            if "401" in str(info["last_error_message"]):
                print(
                    "\n  A 401 means the secret in Vercel does not match the one\n"
                    "  Telegram is sending. Copy the value below into Vercel and\n"
                    "  redeploy:\n"
                )
                print(f"    TELEGRAM_WEBHOOK_SECRET={env.get('TELEGRAM_WEBHOOK_SECRET', '(not set locally)')}")
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
        write_secret(secret)

    base = (args.url or env.get("NEXT_PUBLIC_BASE_URL") or DEFAULT_URL).rstrip("/")
    if not base.startswith("https://"):
        sys.exit(
            f"Webhook URL must be HTTPS and public. Got: {base}\n"
            "Telegram cannot reach localhost."
        )

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
    print("=" * 72)
    print("PUT THIS EXACT VALUE IN VERCEL, then redeploy:")
    print(f"\n  TELEGRAM_WEBHOOK_SECRET={secret}\n")
    print("  Vercel > Settings > Environment Variables")
    print("  Then: Deployments > newest > ... > Redeploy (untick build cache)")
    if generated:
        print("\nSaved to .env.local, so re-running this script reuses it.")
    else:
        print("\nRe-used the existing secret from .env.local — running this")
        print("script again will not change it.")
    print("=" * 72)

    info = api(token, "getWebhookInfo").get("result", {})
    if info.get("last_error_message"):
        print(f"\nTelegram's last error: {info['last_error_message']}")
        print("(Expected until the value above is live in Vercel.)")

    print(f"\nThen open https://t.me/{bot['username']} and send /start")


if __name__ == "__main__":
    main()
