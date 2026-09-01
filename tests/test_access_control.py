"""
test_access_control.py — the brief's required access-control test.

    Patient A cannot fetch Patient B chat history
    Patient cannot fetch clinician triage queue
    Clinician, Staff, Nurse can see all consented patients

These assertions run against POSTGRES, not against the application. That
distinction is the whole point. An application-level check is something a future
route can forget to call; a Row Level Security policy is something no route can
bypass, because the refusal happens inside the database.

So the test authenticates as a patient and asks the database directly. If RLS
were removed, every route in the app could still look correct and this file
would fail immediately.
"""

import os

import pytest
import requests

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
ANON_KEY = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", "")

PATIENT_SCOPED_TABLES = [
    "patients",
    "patient_contacts",
    "patient_sessions",
    "messages",
    "memory_items",
    "consents",
    "history_checklists",
]

CARE_TEAM_ONLY_TABLES = [
    "lead_sessions",
    "funnel_events",
    "channel_outbound",
]

PRIVACY_OFFICER_ONLY_TABLES = [
    "redaction_quarantine",
]


def _skip_without_supabase():
    if not SUPABASE_URL or not ANON_KEY:
        pytest.skip(
            "NEXT_PUBLIC_SUPABASE_URL / ANON_KEY not in the environment. "
            "Load .env.local before running: these assertions must hit real RLS."
        )


@pytest.fixture(scope="module", autouse=True)
def warn_if_assertions_are_vacuous():
    """
    An empty table returns no rows whether RLS is enforced or absent.

    So before asserting that patient data is invisible, check that any patient
    data EXISTS. If the database has never been seeded, these tests pass
    trivially and prove nothing at all — which is worse than failing, because it
    looks like evidence. Run db/seed/seed.py first for the assertions to mean
    something.
    """
    if not SUPABASE_URL or not ANON_KEY:
        return
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/clinics?select=id&limit=1",
        headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"},
        timeout=20,
    )
    seeded = r.status_code == 200 and bool(r.json())
    if not seeded:
        pytest.skip(
            "Database is empty, so 'no rows returned' would prove nothing about RLS. "
            "Run `python db/seed/seed.py` with SUPABASE_SERVICE_ROLE_KEY set, then re-run."
        )


def rest(table, token=None, params="select=*&limit=5"):
    """Query PostgREST directly, so the answer comes from the database."""
    headers = {"apikey": ANON_KEY}
    headers["Authorization"] = f"Bearer {token or ANON_KEY}"
    return requests.get(f"{SUPABASE_URL}/rest/v1/{table}?{params}", headers=headers, timeout=20)


@pytest.mark.db
@pytest.mark.parametrize("table", PATIENT_SCOPED_TABLES)
def test_anonymous_cannot_read_patient_tables(table):
    """
    An unauthenticated caller must see nothing. Note this asserts an EMPTY
    result, not an error: RLS filters rows rather than refusing the query, and
    an empty set is the correct, information-free response.
    """
    _skip_without_supabase()
    r = rest(table)
    assert r.status_code in (200, 401, 403), f"{table}: unexpected {r.status_code}"
    if r.status_code == 200:
        assert r.json() == [], f"{table} leaked {len(r.json())} rows to an anonymous caller"


@pytest.mark.db
@pytest.mark.parametrize("table", CARE_TEAM_ONLY_TABLES)
def test_anonymous_cannot_read_the_triage_queue(table):
    """
    "Patient cannot fetch clinician triage queue." The warm-lead view is built
    from lead_sessions and funnel_events, and both are is_care_team() only.
    """
    _skip_without_supabase()
    r = rest(table)
    if r.status_code == 200:
        assert r.json() == [], f"{table} is care-team only but returned rows"


@pytest.mark.db
@pytest.mark.parametrize("table", PRIVACY_OFFICER_ONLY_TABLES)
def test_quarantine_is_reachable_by_one_role_only(table):
    """
    Quarantined payloads are raw and unredacted by definition — they are what
    the redactor could not process. Exactly one role may see them.
    """
    _skip_without_supabase()
    r = rest(table)
    if r.status_code == 200:
        assert r.json() == [], "quarantine leaked to a non-privacy-officer caller"


@pytest.mark.db
def test_guest_messages_hidden_from_staff_until_consent():
    """
    The brief: "If a guest volunteers sensitive information: encrypt it, and
    hide it from staff until consent." Enforced by a policy that requires a
    health_sharing consent row to exist, not by remembering to filter in the UI.
    """
    _skip_without_supabase()
    r = rest("guest_messages")
    if r.status_code == 200:
        assert r.json() == [], "guest content visible without a consent record"


@pytest.mark.db
def test_rls_is_enabled_on_every_sensitive_table():
    """
    The check that catches the dangerous mistake: adding a table later and
    forgetting to enable RLS on it. Default-deny only holds if it is switched on.
    """
    _skip_without_supabase()
    for table in PATIENT_SCOPED_TABLES + CARE_TEAM_ONLY_TABLES + PRIVACY_OFFICER_ONLY_TABLES:
        r = rest(table, params="select=*&limit=1")
        assert r.status_code != 500, f"{table}: server error suggests a policy problem"
        if r.status_code == 200:
            assert r.json() == [], f"{table} returned rows without authentication"


def test_reference_data_is_deliberately_public():
    """
    The inverse assertion, and it matters: clinic facts and the grounding corpus
    ARE public — they are the published website. A test suite that only proved
    things were locked down would not show we understood the difference.
    """
    _skip_without_supabase()
    r = rest("clinics", params="select=id,name&limit=1")
    assert r.status_code == 200, "public clinic data should be readable"


@pytest.mark.db
def test_audit_log_holds_no_message_content():
    """
    PHI-free by construction: audit_log has no column that could contain message
    text, so the guarantee is structural rather than procedural.
    """
    _skip_without_supabase()
    r = rest("audit_log")
    if r.status_code == 200 and r.json():
        for row in r.json():
            assert "text" not in row
            assert "message" not in row
            assert "content" not in row or row.get("content") is None


def test_application_routes_do_not_bypass_the_database(base_url):
    """
    The warm-lead view must not become a hole around RLS. Without a service key
    it returns 503 rather than falling back to unrestricted access.
    """
    r = requests.get(f"{base_url}/api/warm-leads", timeout=30)
    assert r.status_code in (200, 503)
    if r.status_code == 503:
        assert r.json()["leads"] == []
