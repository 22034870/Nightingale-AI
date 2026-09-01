"""
test_escalation_payload.py — the brief's required escalation test.

    Send to Clinic persists the triggering message, triage summary, profile
    snapshot, provenance, and acquisition context.

Plus the requirement underneath it, which is the harder one:

    "The record must let a clinician begin a structured review without the
     patient repeating their story."

A chat transcript does not satisfy that. The History Engine snapshot does, and
that is the entire reason it exists.
"""

import pytest
from conftest import post, chat, CLINIC_ID


def escalate(base, text, **kwargs):
    status, body = post(base, "/api/escalate", {"text": text, "clinicId": CLINIC_ID, **kwargs})
    assert status == 200, f"escalate failed: {status} {body}"
    return body


def test_payload_contains_every_required_component(base_url):
    body = escalate(base_url, "I have crushing chest pain")
    payload = body["payload"]

    assert payload["triggering_message"], "missing triggering message"
    assert payload["triage_summary"], "missing triage summary"
    assert payload["profile_snapshot"], "missing profile snapshot"
    assert payload["history_snapshot"], "missing history snapshot"
    assert "acquisition_context" in payload, "missing acquisition context"
    assert payload["risk"]["provenance"], "missing risk provenance timestamp"


def test_triggering_message_is_redacted(base_url):
    """Only the redacted form is ever persisted."""
    body = escalate(base_url, "My name is John Doe and I have crushing chest pain")
    assert "John Doe" not in body["payload"]["triggering_message"]
    assert "[NAME_1]" in body["payload"]["triggering_message"]


def test_triage_summary_is_bounded_and_deterministic(base_url):
    """
    1-5 bullets, assembled from extracted facts rather than generated prose. A
    summary a clinician acts on should be a projection of what the patient
    actually said, not a paraphrase that can drift.
    """
    body = escalate(base_url, "I have crushing chest pain")
    bullets = [b for b in body["payload"]["triage_summary"].split("\n") if b.strip()]

    assert 1 <= len(bullets) <= 5, f"expected 1-5 bullets, got {len(bullets)}"
    assert all(b.strip().startswith("•") for b in bullets)
    # The risk line is what tells a nurse why this arrived.
    assert any("risk" in b.lower() for b in bullets)


def test_risk_provenance_names_the_deciding_layer(base_url):
    """
    A clinician should be able to see the model never got a vote on this one.
    """
    body = escalate(base_url, "I have crushing chest pain")
    risk = body["payload"]["risk"]

    assert risk["level"] == "high"
    assert risk["deciding_layer"] in ("deterministic", "merged", "fallback")
    assert risk["matched_rule_id"], "must name the rule that fired"
    assert risk["reason"]


def test_acquisition_context_survives_to_the_payload(base_url):
    """
    The brief: attribution must survive to the final escalation payload. A fact
    on a clinician's screen resolves back to the ad that started it.
    """
    attribution = {
        "source_channel": "instagram_ad_click",
        "campaign_id": "ivf_over40",
        "creative": "carousel_a",
        "identity_level": "anonymous",
        "landing_timestamp": "2026-09-02T09:00:00Z",
    }
    body = escalate(base_url, "I have crushing chest pain", attribution=attribution)
    got = body["payload"]["acquisition_context"]

    assert got["source_channel"] == "instagram_ad_click"
    assert got["campaign_id"] == "ivf_over40"
    assert got["creative"] == "carousel_a"


def test_history_snapshot_is_structured_not_a_transcript(base_url):
    """
    The difference between a clinician starting a review and a clinician
    reading a chat log. Fields are named and individually answerable.
    """
    body = escalate(base_url, "I have crushing chest pain")
    snapshot = body["payload"]["history_snapshot"]

    assert "complaint_type" in snapshot
    assert "completeness_pct" in snapshot
    assert isinstance(snapshot["fields"], list) and snapshot["fields"]
    for field in snapshot["fields"]:
        assert {"id", "label", "value", "answered"} <= set(field)


def test_high_risk_halts_the_checklist(base_url):
    """
    Someone with crushing chest pain is not asked seven questions. Whatever
    partial history exists travels with the handoff.
    """
    body = escalate(base_url, "I have crushing chest pain")
    assert body["payload"]["history_snapshot"]["halted_reason"] == "high_risk"


def test_response_expectation_is_computed_not_promised(base_url):
    """
    The brief specifies a static "12 to 18 hours". Report C&D §3.3 #8 ranks a
    promise the clinic cannot keep as a top-ten trust breaker, so this is
    derived from clinic hours and server time instead.
    """
    body = escalate(base_url, "I have crushing chest pain")

    assert body["response_expectation"]
    assert body["sla_due_at"], "must give a concrete time, not a vague promise"
    # And it always says what to do if things get worse first.
    assert "999" in body["response_expectation"] or "emergency" in body["response_expectation"].lower()


def test_conversation_continues_after_sending(base_url):
    """The brief: after the message is sent, patient and AI can keep chatting."""
    body = escalate(base_url, "I have crushing chest pain")
    assert body["conversation_continues"] is True


def test_confirmation_is_honest_about_persistence(base_url):
    """
    Never claim something happened that did not. Without a database configured
    the response says persisted:false rather than showing a false confirmation.
    """
    body = escalate(base_url, "I have crushing chest pain")
    assert "persisted" in body
    if not body["persisted"]:
        assert body.get("persist_error"), "a failed write must explain itself"
        assert body["escalation_id"] is None, "no id may be invented for a write that failed"


@pytest.mark.db
def test_escalation_is_actually_persisted(base_url, database_ready):
    body = escalate(base_url, "I have crushing chest pain")
    assert body["persisted"] is True
    assert body["escalation_id"]
    assert body["status"] == "sent"
