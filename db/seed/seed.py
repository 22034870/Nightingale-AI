#!/usr/bin/env python3
"""
Seed the database with synthetic data.

    python db/seed/seed.py

Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
environment (or in .env.local, which this script reads).

WHY THIS MATTERS BEYOND CONVENIENCE
-----------------------------------
test_access_control.py asserts that patient data is invisible to an
unauthenticated caller. Against an EMPTY database those assertions pass whether
Row Level Security is enforced or absent — which is worse than failing, because
it looks like evidence. The suite skips itself until this has run.

SYNTHETIC DATA ONLY. No real clinic, no real doctors, no real patients. The
clinic corpus is the same file the grounding layer reads, chunked with character
offsets preserved so citations resolve to real spans.
"""

import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLINIC_ID = "00000000-0000-0000-0000-000000000001"


def load_env():
    env_file = ROOT / ".env.local"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())

    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit(
            "SUPABASE_SERVICE_ROLE_KEY is not set.\n"
            "Get it from Supabase > Settings > API and add it to .env.local.\n"
            "It bypasses RLS, so it must never reach the browser or the repo."
        )
    return url.rstrip("/"), key


def request(url, key, table, rows, method="POST"):
    body = json.dumps(rows).encode()
    req = urllib.request.Request(
        f"{url}/rest/v1/{table}",
        data=body,
        method=method,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # Idempotent: re-running the seed updates rather than duplicating.
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:300]
        print(f"  ! {table}: HTTP {e.code} {detail}")
        return e.code


def chunk_document(raw: str):
    """Mirrors lib/grounding/corpus.ts — offsets must match exactly."""
    chunks, cursor, n = [], 0, 0
    for block in raw.split("\n\n"):
        start = raw.find(block, cursor)
        if start == -1:
            continue
        cursor = start + len(block)
        text = block.strip()
        if len(text) < 20:
            continue
        offset = block.find(text)
        chunks.append((start + offset, start + offset + len(text), text))
        n += 1
    return chunks


def main():
    url, key = load_env()
    corpus = json.loads((ROOT / "db" / "seed" / "clinic-corpus.json").read_text(encoding="utf-8"))
    clinic = corpus["clinic"]

    print(f"Seeding {url}")

    print("  clinics")
    request(url, key, "clinics", [{
        "id": CLINIC_ID,
        "name": clinic["name"],
        "country": clinic["country"],
        "emergency_number": clinic["emergency_number"],
        "hours_json": clinic["hours_json"],
        "dpo_email": clinic["dpo_email"],
    }])

    print("  clinic_documents + document_chunks")
    for i, doc in enumerate(corpus["documents"]):
        doc_id = f"00000000-0000-0000-0000-00000000{i + 10:04d}"
        request(url, key, "clinic_documents", [{
            "id": doc_id,
            "clinic_id": CLINIC_ID,
            "title": doc["title"],
            "source_url": doc["source_url"],
            "raw_text": doc["raw_text"],
        }])

        chunks = chunk_document(doc["raw_text"])
        if chunks:
            request(url, key, "document_chunks", [{
                "document_id": doc_id,
                "char_start": s,
                "char_end": e,
                "text": t,
            } for s, e, t in chunks])
        print(f"    {doc['title']}: {len(chunks)} chunks")

    # A minimal patient record, so test_access_control has something that MUST
    # stay invisible. Without this the RLS assertions are vacuous.
    print("  synthetic patient (so RLS assertions are not vacuous)")
    patient_id = "00000000-0000-0000-0000-0000000000aa"
    request(url, key, "patients", [{"id": patient_id, "clinic_id": CLINIC_ID}])
    request(url, key, "patient_contacts", [{
        "patient_id": patient_id,
        "type": "email",
        "value_encrypted": "synthetic.patient@example.invalid",
        "is_login_identifier": True,
    }])
    session_id = "00000000-0000-0000-0000-0000000000bb"
    request(url, key, "patient_sessions", [{"id": session_id, "patient_id": patient_id}])
    request(url, key, "messages", [{
        "patient_session_id": session_id,
        "role": "user",
        "text_redacted": "I have been getting headaches for three days",
        "risk_level": "medium",
    }])

    print("\nDone. Re-run tests to confirm the RLS assertions now mean something:")
    print("  python -m pytest tests/test_access_control.py -v")


if __name__ == "__main__":
    main()
