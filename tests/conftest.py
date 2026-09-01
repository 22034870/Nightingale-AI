"""
Shared fixtures for the Nightingale test suite.

WHY THESE TESTS RUN OVER HTTP RATHER THAN AS UNIT TESTS
-------------------------------------------------------
Every assertion here goes through the real server, because the properties the
brief asks us to prove are properties of the deployed system, not of a function
in isolation. A unit test that mocks the database cannot prove Patient A is
unable to read Patient B; only a real request against real Row Level Security
can. The same applies to redaction: what matters is what actually leaves the
process, not what a helper returns.

QUOTA
-----
The Gemini free tier allows 20 generate requests per day per model. Tests that
need a model call are marked `@pytest.mark.llm` and skipped automatically when
quota is exhausted, so a depleted key produces honest skips rather than a wall
of misleading failures. The deterministic safety layer is tested unconditionally
— it is the part that must never depend on a network call.

RUN
---
    Terminal 1:  npm run dev
    Terminal 2:  pytest tests/ -v
    Skip model-dependent tests:  pytest tests/ -v -m "not llm"
"""

import os
import time
import uuid

import pytest
import requests
import yaml

BASE_URL = os.environ.get("NIGHTINGALE_BASE_URL", "http://localhost:3000")
CLINIC_ID = "00000000-0000-0000-0000-000000000001"


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "llm: requires a live model call (skipped when quota is exhausted)"
    )
    config.addinivalue_line(
        "markers", "db: requires SUPABASE_SERVICE_ROLE_KEY to be configured"
    )


@pytest.fixture(scope="session")
def base_url():
    """Fail fast and loudly if the server is not up."""
    for _ in range(30):
        try:
            r = requests.post(
                f"{BASE_URL}/api/risk",
                json={"text": "ping", "include_llm": False},
                timeout=5,
            )
            if r.status_code == 200:
                return BASE_URL
        except requests.RequestException:
            pass
        time.sleep(1)
    pytest.exit(f"Server not reachable at {BASE_URL}. Run `npm run dev` first.")


@pytest.fixture(scope="session")
def red_flags():
    with open("config/red_flags.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


@pytest.fixture(scope="session")
def copy_rules():
    with open("config/copy_rules.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


@pytest.fixture(scope="session")
def channel_rules():
    with open("config/channel_rules.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def post(base, path, body, timeout=90):
    r = requests.post(f"{base}{path}", json=body, timeout=timeout)
    return r.status_code, (r.json() if r.content else {})


def get(base, path, timeout=30):
    r = requests.get(f"{base}{path}", timeout=timeout)
    return r.status_code, (r.json() if r.content else {})


def chat(base, text, **kwargs):
    status, body = post(base, "/api/chat", {"text": text, **kwargs})
    assert status == 200, f"chat failed: {status} {body}"
    return body


def risk(base, text, include_llm=False):
    """Deterministic by default — no quota consumed unless asked for."""
    status, body = post(base, "/api/risk", {"text": text, "include_llm": include_llm})
    assert status == 200, f"risk failed: {status} {body}"
    return body


def model_available(base) -> bool:
    """True when a real generation succeeded; used to skip on exhausted quota."""
    body = chat(base, "What are your opening hours?")
    return bool(body.get("audit", {}).get("model_used"))


@pytest.fixture(scope="session")
def llm_ready(base_url):
    if not model_available(base_url):
        pytest.skip("Model unavailable (quota exhausted or no API key).")
    return True


@pytest.fixture
def database_ready(base_url):
    status, _ = get(base_url, f"/api/metrics?clinicId={CLINIC_ID}")
    if status == 503:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not configured; persistence tests skipped.")
    return True


@pytest.fixture
def new_id():
    return lambda: str(uuid.uuid4())
