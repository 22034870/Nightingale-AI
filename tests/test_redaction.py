"""
test_redaction.py — the brief's required redaction test.

    Input:  "My name is John Doe and my IC is S1234567A."
    Assert: the LLM input contains [REDACTED] for those fields
            logs do not contain the raw values

Under PDPA s.129 this is not merely good engineering. Malaysia's cross-border
whitelist was abolished by the 2024 amendment, so sending patient text to a
foreign model endpoint needs a lawful basis, and this pipeline is the
"reasonable precautions and due diligence" evidence for it.

Note on the fixture: S1234567A is NOT a checksum-valid Singapore NRIC — the
correct check letter is D. An early version of the pipeline used the checksum as
a gate, so the brief's own example sailed through unredacted. Validation is now
a confidence signal, never a reason to skip. Someone who mistypes one digit of
their IC has not consented to it being sent overseas in the clear.
"""

import requests
from conftest import post, chat


def redact(base, text):
    status, body = post(base, "/api/redact", {"text": text})
    assert status == 200, f"redact failed: {status} {body}"
    return body


def test_brief_fixture_redacts_name_and_ic(base_url):
    body = redact(base_url, "My name is John Doe and my IC is S1234567A.")
    llm_input = body["llm_input"]

    assert "John Doe" not in llm_input
    assert "S1234567A" not in llm_input
    assert "[NAME_1]" in llm_input
    assert "[IC_1]" in llm_input

    kinds = {s["type"] for s in body["spans"]}
    assert {"NAME", "IC"} <= kinds


def test_invalid_checksum_is_still_redacted(base_url):
    """The regression that motivated the design. Recall over precision."""
    body = redact(base_url, "my ic is S1234567A")
    assert "S1234567A" not in body["llm_input"]


def test_sea_identifiers(base_url):
    text = (
        "Saya Ahmad bin Abdullah, IC 890415-14-5563, "
        "call +6012-345 6789 or ahmad@example.com"
    )
    out = redact(base_url, text)["llm_input"]

    assert "Ahmad bin Abdullah" not in out, "Malay patronymic must be captured whole"
    assert "890415-14-5563" not in out
    assert "345 6789" not in out
    assert "ahmad@example.com" not in out


def test_response_never_returns_the_mapping(base_url):
    """
    The placeholder->original map is what keeps redacted text legally personal
    data. It must never leave the server.
    """
    body = redact(base_url, "My name is John Doe and my IC is S1234567A.")
    assert "map" not in body
    for span in body["spans"]:
        assert "original" not in span


def test_clinical_detail_survives_redaction(base_url):
    """
    Over-redaction is cheap but not free. Destroying "worse when I bend over"
    would strip the mechanism a clinician needs and break the History Engine.
    """
    text = "I have been having chest pain since Monday and it gets worse when I walk"
    out = redact(base_url, text)["llm_input"]
    for phrase in ["chest pain", "since Monday", "worse when I walk"]:
        assert phrase in out, f"clinical detail {phrase!r} was destroyed"


def test_known_false_positives_are_not_redacted(base_url):
    """
    Report C&D §1.3: "bin" is both a Malay patronymic and an English noun.
    Requiring capitalisation on both sides is what separates them.
    """
    for text in [
        "I threw the receipt in the bin and now I cannot find it",
        "My anak has a fever of 39 degrees",
        "Do you accept AIA insurance?",
    ]:
        out = redact(base_url, text)["llm_input"]
        assert "[NAME" not in out, f"false positive on {text!r}"
        assert "[POLICY" not in out, f"false positive on {text!r}"


def test_audit_record_is_phi_free(base_url):
    """
    Audit output carries counts and types only. The brief: logs must be PHI-free,
    IDs and hashes only, no raw message content.
    """
    body = redact(base_url, "My name is John Doe and my IC is S1234567A.")
    serialised = str(body["audit"])
    assert "John Doe" not in serialised
    assert "S1234567A" not in serialised
    assert "redaction_stats" in body["audit"]


def test_chat_audit_never_leaks_raw_values(base_url):
    """The same guarantee on the path a real message actually takes."""
    body = chat(base_url, "My name is John Doe, my IC is S1234567A. What are your fees?")
    serialised = str(body["audit"])
    assert "John Doe" not in serialised
    assert "S1234567A" not in serialised
    assert "John Doe" not in body["reply"]
    assert "[NAME_1]" not in body["reply"], "placeholders are internal, never shown"


def test_quasi_identifiers_are_counted_not_ignored(base_url):
    """
    Sweeney: 87% of a population is re-identifiable from ZIP + DOB + gender.
    We keep these — removing them would destroy the clinical picture — but we
    measure the re-identification pressure they create.
    """
    body = redact(base_url, "I am 42 years old and I live in Taman Desa, postcode 58100")
    assert body["audit"]["quasi_identifier_count"] >= 2
    # Clinical context preserved.
    assert "42 years old" in body["llm_input"]


def test_redaction_endpoint_is_disabled_in_production(base_url):
    """
    A test surface must not be a product surface. In production both inspection
    endpoints return 404 unless explicitly enabled.
    """
    import os

    prod = os.environ.get("NIGHTINGALE_PROD_URL")
    if not prod:
        return  # nothing to assert against locally
    r = requests.post(f"{prod}/api/redact", json={"text": "x"}, timeout=20)
    assert r.status_code == 404
