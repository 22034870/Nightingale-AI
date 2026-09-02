"""
test_admin_auth.py — the staff surfaces are not public.

Before this gate existed, /dashboard and /clinician were reachable by anyone who
knew the URL. They carry chief complaints and the conversations behind them, so
that was a disclosure of exactly the material the rest of this project spends
its effort protecting. `robots: noindex` keeps a page out of Google; it is not
access control.

WHAT THESE ASSERT, AND WHY EACH ONE IS HERE
-------------------------------------------
Gating the PAGE while leaving the API open would be theatre — the data is one
fetch away from anyone reading the page source — so the API routes are asserted
separately rather than assumed to follow.

The patient path is asserted to stay OPEN. A regression that gated /chat would
put a login screen in front of someone in distress, which is a worse failure
than the one this file exists to prevent, and it would otherwise look like the
tests passing harder.

The forged-cookie case is the one that proves the design rather than the
configuration: the cookie carries its own expiry, so a gate that trusted that
value without checking the signature over it could be opened by anyone who can
type a large number.
"""

import os

import pytest
import requests

PASSWORD = os.environ.get("ADMIN_PASSWORD")

GATED_PAGES = ["/dashboard", "/clinician"]
GATED_APIS = ["/api/analytics", "/api/clinician/queue"]
# Must never require a login.
PATIENT_PATHS = ["/", "/chat"]


def test_gated_pages_redirect_anonymous_visitors(base_url):
    for path in GATED_PAGES:
        r = requests.get(base_url + path, allow_redirects=False, timeout=15)
        assert r.status_code in (302, 307), f"{path} was not gated: {r.status_code}"
        assert "/admin/login" in r.headers.get("location", ""), (
            f"{path} redirected somewhere other than the login page"
        )


def test_gated_apis_refuse_anonymous_callers(base_url):
    """The page redirect is worthless if the JSON behind it is public."""
    for path in GATED_APIS:
        r = requests.get(base_url + path, timeout=15)
        assert r.status_code == 401, f"{path} returned {r.status_code}, expected 401"
        assert "queue" not in r.text.lower() or r.json().get("error") == "unauthorised"


def test_patient_paths_are_never_gated(base_url):
    """
    Someone in distress must not meet a login screen. If this fails, the matcher
    has grown too wide — and that is a worse bug than the one the gate fixes.
    """
    for path in PATIENT_PATHS:
        r = requests.get(base_url + path, allow_redirects=False, timeout=15)
        assert r.status_code == 200, f"{path} should be open, got {r.status_code}"


def test_a_forged_cookie_is_rejected(base_url):
    """
    The cookie states its own expiry. Without verifying the HMAC over that
    value, anyone could grant themselves a session until the year 5138.
    """
    r = requests.get(
        base_url + "/api/analytics",
        cookies={"nightingale_admin": "99999999999999.deadbeef"},
        timeout=15,
    )
    assert r.status_code == 401


def test_a_tampered_expiry_invalidates_the_signature(base_url):
    """A real token whose expiry is edited must stop verifying."""
    if not PASSWORD:
        pytest.skip("ADMIN_PASSWORD not set in the environment")

    s = requests.Session()
    login = s.post(base_url + "/api/admin/login", json={"password": PASSWORD}, timeout=15)
    assert login.status_code == 200

    token = s.cookies.get("nightingale_admin")
    assert token and "." in token
    _, signature = token.rsplit(".", 1)

    r = requests.get(
        base_url + "/api/analytics",
        cookies={"nightingale_admin": f"99999999999999.{signature}"},
        timeout=15,
    )
    assert r.status_code == 401, "a signature was accepted for a different expiry"


def test_wrong_password_is_refused(base_url):
    r = requests.post(
        base_url + "/api/admin/login",
        json={"password": "definitely-not-the-password"},
        timeout=15,
    )
    assert r.status_code in (401, 429, 503)
    assert r.status_code != 200


def test_correct_password_opens_every_gated_surface(base_url):
    if not PASSWORD:
        pytest.skip("ADMIN_PASSWORD not set in the environment")

    s = requests.Session()
    login = s.post(base_url + "/api/admin/login", json={"password": PASSWORD}, timeout=15)
    assert login.status_code == 200, f"sign-in failed: {login.status_code} {login.text[:200]}"

    for path in GATED_PAGES + GATED_APIS:
        r = s.get(base_url + path, timeout=20)
        assert r.status_code == 200, f"{path} still blocked after sign-in: {r.status_code}"


def test_sign_out_closes_the_session(base_url):
    if not PASSWORD:
        pytest.skip("ADMIN_PASSWORD not set in the environment")

    s = requests.Session()
    s.post(base_url + "/api/admin/login", json={"password": PASSWORD}, timeout=15)
    assert s.get(base_url + "/api/analytics", timeout=20).status_code == 200

    s.delete(base_url + "/api/admin/login", timeout=15)
    assert s.get(base_url + "/api/analytics", timeout=20).status_code == 401


def test_login_does_not_become_an_open_redirect(base_url):
    """
    `next` is attacker-controllable. A value like //evil.example would send
    someone who just authenticated to a page of somebody else's choosing.
    """
    r = requests.get(
        base_url + "/admin/login",
        params={"next": "//evil.example/steal"},
        timeout=15,
    )
    assert r.status_code == 200

    # Assert on the PROP the component receives, which is the value it will
    # navigate to — not on the raw page text. The original query string also
    # appears in Next's router state (the URL segment and the page cache key),
    # and asserting its absence would fail while the sanitiser was working
    # perfectly. What matters is that the off-site value never becomes the
    # destination.
    assert '\\"next\\":\\"/dashboard' in r.text, (
        "the off-site next value was not replaced with a safe default"
    )
    assert '\\"next\\":\\"//evil' not in r.text, "an off-site value reached the prop"


def test_a_safe_next_path_is_preserved(base_url):
    """Sanitising must not flatten every destination to /dashboard."""
    r = requests.get(base_url + "/admin/login", params={"next": "/clinician"}, timeout=15)
    assert r.status_code == 200
    assert '\\"next\\":\\"/clinician' in r.text
