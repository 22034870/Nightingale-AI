#!/usr/bin/env python3
"""
Generate synthetic clinic traffic so the analytics and queue have something real
to compute over.

    python scripts/replay_traffic.py                 # 200 sessions over 30 days
    python scripts/replay_traffic.py --sessions 500 --days 60
    python scripts/replay_traffic.py --wipe          # clear synthetic rows first

WHY THIS EXISTS
---------------
The funnel metrics, the warm-lead view and the triage queue are all real queries
over real tables. Against an empty database they render nothing, which is
correct and useless. This populates those tables so the pipeline can be built
and validated before real traffic exists.

WHY IT WRITES DIRECTLY TO THE DATABASE
--------------------------------------
Not through /api/chat, deliberately. Each turn there costs up to three model
calls, and the free tier allows five requests per MINUTE — 200 sessions would
take hours and exhaust the quota many times over. The safety path is already
tested by pytest against the live API; what analytics needs is volume and
realistic distribution, which is a different job.

THE LIMITATION THAT MATTERS, AND IT IS NOT SMALL
------------------------------------------------
This data encodes MY assumptions about how patients behave — the abandonment
rates, the channel mix, the risk distribution below are numbers I chose. A model
trained on it learns those assumptions, not reality.

That is fine for building and validating a pipeline. It is NOT fine as evidence
about real patients, and any figure derived from this data must be labelled
synthetic wherever it appears. The distributions below are stated openly rather
than buried so that anyone reading a result can see exactly what was assumed.
"""

import argparse
import json
import os
import pathlib
import random
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
CLINIC_ID = "00000000-0000-0000-0000-000000000001"

# ---------------------------------------------------------------------------
# ASSUMED DISTRIBUTIONS — every number here is a choice, not a measurement.
# ---------------------------------------------------------------------------

CHANNEL_MIX = {
    "website_widget": 0.34,
    "instagram_ad_click": 0.24,
    "social_comment": 0.15,
    "staff_referral": 0.12,
    "telegram_bot": 0.09,
    "lead_form": 0.06,
}

# Where sessions die. Loosely shaped by the drop-off literature in
# research/report-F-funnel-evidence.md, but these exact values are assumed.
FURTHEST_STAGE = {
    "visitor": 0.22,               # bounced before typing anything
    "conversation_started": 0.28,  # asked one thing, left
    "value_event": 0.24,           # got real help, did not hand off
    "escalation_sent": 0.26,       # completed the funnel
}

# Risk mix. Emergencies are rare; that rarity is the whole triage problem.
RISK_MIX = {"low": 0.62, "medium": 0.30, "high": 0.08}

CAMPAIGNS = ["ivf_over40", "cardiac_screening_q3", "womens_health_may", None]

CONCERNS = {
    "low": [
        "What are your opening hours on Saturday?",
        "Do you accept AIA insurance?",
        "How much is a health screening?",
        "Do I need to fast before a blood test?",
        "Can I ask for a female doctor?",
    ],
    "medium": [
        "I've had a headache for three days",
        "My stomach has been uncomfortable for a week",
        "I feel tired all the time lately",
        "I have a rash that isn't going away",
        "Saya rasa pening sejak semalam",
    ],
    "high": [
        "I have crushing chest pain",
        "I'm having difficulty breathing",
        "sesak nafas sejak pagi tadi",
        "my baby won't wake up",
        "I have heavy bleeding",
    ],
}


def load_env():
    env = ROOT / ".env.local"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())

    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit(
            "SUPABASE_SERVICE_ROLE_KEY is not set.\n\n"
            "Supabase > Settings > API > service_role, then add it to .env.local:\n"
            "  SUPABASE_SERVICE_ROLE_KEY=eyJ...\n\n"
            "It bypasses RLS, so it must never reach the browser or the repo."
        )
    return url.rstrip("/"), key


def request(url, key, table, rows=None, method="POST", query=""):
    body = json.dumps(rows).encode() if rows is not None else None
    req = urllib.request.Request(
        f"{url}/rest/v1/{table}{query}",
        data=body,
        method=method,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status < 300
    except urllib.error.HTTPError as e:
        print(f"  ! {table}: HTTP {e.code} {e.read().decode()[:180]}")
        return False


def weighted(mapping):
    return random.choices(list(mapping), weights=list(mapping.values()))[0]


def build(sessions: int, days: int):
    """Return (lead_sessions, guest_messages, funnel_events, escalations)."""
    now = datetime.now(timezone.utc)
    leads, messages, events, escalations = [], [], [], []

    for _ in range(sessions):
        sid = str(uuid.uuid4())
        channel = weighted(CHANNEL_MIX)
        risk = weighted(RISK_MIX)
        stage = weighted(FURTHEST_STAGE)
        started = now - timedelta(
            days=random.uniform(0, days), hours=random.uniform(0, 24)
        )
        campaign = random.choice(CAMPAIGNS) if channel == "instagram_ad_click" else None

        identity = {
            "staff_referral": "handle_only",
            "social_comment": "handle_only",
            "telegram_bot": "handle_only",
            "lead_form": "identified",
        }.get(channel, "anonymous")

        leads.append({
            "id": sid,
            "clinic_id": CLINIC_ID,
            "source_channel": channel,
            "campaign_id": campaign,
            "identity_level": identity,
            "landing_timestamp": started.isoformat(),
            "expires_at": (started + timedelta(days=7)).isoformat(),
            "recovery_token": f"synthetic_{uuid.uuid4().hex}",
        })

        meta = {
            "source_channel": channel,
            "campaign_id": campaign,
            "identity_level": identity,
            "synthetic": True,   # every row is labelled, so it can be excluded
        }
        events.append({
            "clinic_id": CLINIC_ID, "lead_session_id": sid,
            "event_type": "visitor", "metadata_json": meta,
            "created_at": started.isoformat(),
        })
        if stage == "visitor":
            continue

        # They typed something.
        t1 = started + timedelta(minutes=random.uniform(0.2, 3))
        text = random.choice(CONCERNS[risk])
        msg_id = str(uuid.uuid4())
        messages.append({
            "id": msg_id, "lead_session_id": sid, "role": "user",
            "text_redacted": text, "risk_level": risk,
            "deciding_layer": "deterministic" if risk == "high" else "merged",
            "created_at": t1.isoformat(),
        })
        events.append({
            "clinic_id": CLINIC_ID, "lead_session_id": sid,
            "event_type": "conversation_started",
            "metadata_json": {**meta, "risk_level": risk},
            "created_at": t1.isoformat(),
        })
        if stage == "conversation_started":
            continue

        t2 = t1 + timedelta(minutes=random.uniform(0.5, 6))
        events.append({
            "clinic_id": CLINIC_ID, "lead_session_id": sid,
            "event_type": "value_event",
            "value_event_id": "VE_01" if risk == "low" else "VE_02",
            "metadata_json": {**meta, "risk_level": risk},
            "created_at": t2.isoformat(),
        })
        if stage == "value_event":
            continue

        t3 = t2 + timedelta(minutes=random.uniform(1, 12))
        escalations.append({
            "id": str(uuid.uuid4()),
            "lead_session_id": sid,      # guest escalation: patient_id stays null
            "trigger_message_id": msg_id,
            "triage_summary": (
                f"• Chief complaint: {text[:60]}\n"
                f"• Risk {risk} (deterministic), history "
                f"{random.choice([33, 44, 56, 67, 78])}% complete."
            ),
            "profile_snapshot_json": {
                "current": {"chief_complaint": text[:60], "symptoms": [], "medications": []},
                "history": [],
            },
            "acquisition_context_json": {**meta, "lead_session_id": sid},
            "history_snapshot_json": {"complaint_type": "general", "fields": []},
            "status": random.choice(["sent", "sent", "acknowledged", "closed"]),
            "sla_due_at": (t3 + timedelta(hours=random.choice([12, 14, 18]))).isoformat(),
            "created_at": t3.isoformat(),
        })
        events.append({
            "clinic_id": CLINIC_ID, "lead_session_id": sid,
            "event_type": "escalation_sent",
            "metadata_json": {**meta, "risk_level": risk, "top_concern": text[:60]},
            "created_at": t3.isoformat(),
        })

    return leads, messages, events, escalations


def normalise(rows):
    """Give every row the same keys.

    PostgREST rejects a bulk insert whose objects differ in shape — "All object
    keys must match" — and these rows legitimately differ: value_event_id is set
    only on value events. Missing keys become explicit nulls so the column
    default is not silently relied upon.
    """
    keys = set()
    for r in rows:
        keys.update(r)
    return [{k: r.get(k) for k in keys} for r in rows]


def chunked(rows, size=200):
    for i in range(0, len(rows), size):
        yield rows[i : i + size]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", type=int, default=200)
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--wipe", action="store_true", help="delete synthetic rows first")
    ap.add_argument("--seed", type=int, default=None, help="make the run reproducible")
    args = ap.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    url, key = load_env()

    if args.wipe:
        print("Wiping previous synthetic traffic…")
        # The synthetic flag in the JSON is what makes these rows identifiable,
        # so only generated data is removed and anything real is left alone.
        # escalations and guest_messages go first — they reference lead_sessions,
        # and deleting the parent would cascade into rows we have not checked.
        request(url, key, "escalations", method="DELETE",
                query="?acquisition_context_json->>synthetic=eq.true")
        request(url, key, "funnel_events", method="DELETE",
                query="?metadata_json->>synthetic=eq.true")
        # lead_sessions are tagged by a recovery_token prefix — an indexed
        # column that already exists — so generated sessions can be removed
        # exactly, without guesswork. guest_messages cascade from them.
        request(url, key, "lead_sessions", method="DELETE",
                query="?recovery_token=like.synthetic_*")

    leads, messages, events, escalations = build(args.sessions, args.days)
    print(f"Generated {args.sessions} sessions over {args.days} days:")
    print(f"  lead_sessions  {len(leads)}")
    print(f"  guest_messages {len(messages)}")
    print(f"  funnel_events  {len(events)}")
    print(f"  escalations    {len(escalations)}")

    print("\nWriting…")
    failed = False
    for name, rows in (
        ("lead_sessions", leads),
        ("guest_messages", messages),
        ("escalations", escalations),
        ("funnel_events", events),
    ):
        written = 0
        for batch in chunked(normalise(rows)):
            if request(url, key, name, batch):
                written += len(batch)
        # Report what LANDED, not what was intended. The first version printed
        # len(rows) regardless of outcome, so a table that took zero rows still
        # reported a full write — total failure looked exactly like success.
        if written != len(rows):
            failed = True
        note = "ok" if written == len(rows) else f"FAILED — {len(rows) - written} lost"
        print(f"  {name:<16} {written}/{len(rows)}  {note}")

    if failed:
        print("\nSome rows did not land. The dashboard will under-report until fixed.")
        sys.exit(1)

    print("\nDone. Now look at:")
    print("  /dashboard   funnel, drop-off, channels")
    print("  /clinician   the triage queue")
    print("\nEvery row is tagged synthetic:true. Re-run with --wipe to reset.")
    print("These distributions are ASSUMED, not measured — see this file's docstring.")


if __name__ == "__main__":
    main()
