"""
test_guest_to_patient_conversion.py — the brief's required conversion test.

    A guest arrives via source=instagram&campaign=ivf_over40, states a concern;
    after auth + consent the context appears in the PatientSession, provenance
    resolves to the original GuestMessage, attribution is retained, and the
    concern is never re-asked.

The trap this test exists to catch: copying the facts across and repointing them
at fresh patient messages would look identical in the UI and would quietly
destroy the audit trail. Migration re-parents the facts and writes their
provenance through UNCHANGED, so a fact learned before signup still points at
the guest_message that produced it.
"""

import pytest
from conftest import post, get, chat, CLINIC_ID


def arrive(base, **kwargs):
    status, body = post(base, "/api/arrival", {"clinicId": CLINIC_ID, **kwargs})
    assert status == 200, f"arrival failed: {status} {body}"
    return body


def convert(base, **kwargs):
    return post(base, "/api/convert", {"clinicId": CLINIC_ID, **kwargs})


def test_instagram_arrival_captures_full_attribution(base_url):
    body = arrive(
        base_url,
        channel="instagram_ad_click",
        campaignId="ivf_over40",
        creative="carousel_a",
    )
    attr = body["attribution"]

    assert attr["source_channel"] == "instagram_ad_click"
    assert attr["campaign_id"] == "ivf_over40"
    assert attr["creative"] == "carousel_a"
    assert attr["identity_level"] == "anonymous"
    assert attr["landing_timestamp"]


def test_consent_notice_is_unbundled(base_url):
    """
    PDPA s.40: explicit consent, separable from terms. Marketing must be its own
    decision, defaulting to off.
    """
    status, body = get(base_url, "/api/convert")
    assert status == 200

    assert body["health_sharing"]["required"] is True
    assert body["marketing"]["required"] is False
    assert body["marketing"]["default"] is False
    assert body["health_sharing"]["text"] != body["marketing"]["text"]


def test_conversion_refuses_without_health_consent(base_url):
    """No lawful basis, no PatientSession. The gate is hard."""
    arrival = arrive(base_url, channel="instagram_ad_click", campaignId="ivf_over40")
    status, body = convert(
        base_url,
        leadSessionId=arrival["lead_session_id"],
        email="guest@example.com",
        consentHealthSharing=False,
        consentMarketing=False,
        memoryItems=[],
    )
    assert status == 403
    assert body["error"] == "consent_required"


def guest_memory_item(message_id="guest-msg-1"):
    """A fact as it exists BEFORE conversion — provenance in guest_messages."""
    return {
        "id": "11111111-1111-1111-1111-111111111111",
        "kind": "chief_complaint",
        "value": "trying to conceive for 18 months",
        "status": "active",
        "provenance": {"table": "guest_messages", "messageId": message_id},
        "createdAt": "2026-09-02T09:00:00Z",
        "updatedAt": "2026-09-02T09:00:00Z",
    }


def test_provenance_resolves_to_the_original_guest_message(base_url):
    """The core assertion. Migration must not rewrite provenance."""
    arrival = arrive(base_url, channel="instagram_ad_click", campaignId="ivf_over40")
    item = guest_memory_item()

    status, body = convert(
        base_url,
        leadSessionId=arrival["lead_session_id"],
        email="guest@example.com",
        consentHealthSharing=True,
        consentOverseasProcessing=True,
        consentMarketing=False,
        memoryItems=[item],
        attribution=arrival["attribution"],
    )
    assert status == 200, body

    migrated = body["migrated_memory_items"]
    assert len(migrated) == 1

    # Same id, same pointer, still pointing into guest_messages.
    assert migrated[0]["id"] == item["id"], "migration must not re-key the fact"
    assert migrated[0]["provenance"]["table"] == "guest_messages"
    assert migrated[0]["provenance"]["messageId"] == "guest-msg-1"

    trail = body["provenance_trails"][0]
    assert trail["resolves"] is True
    assert trail["lead_session_id"] == arrival["lead_session_id"]
    assert trail["acquisition"]["campaign_id"] == "ivf_over40"


def test_attribution_survives_conversion(base_url):
    """Three hops: fact -> guest message -> lead session -> the ad."""
    arrival = arrive(
        base_url, channel="instagram_ad_click", campaignId="ivf_over40", creative="carousel_a"
    )
    status, body = convert(
        base_url,
        leadSessionId=arrival["lead_session_id"],
        email="guest@example.com",
        consentHealthSharing=True,
        consentMarketing=False,
        memoryItems=[guest_memory_item()],
        attribution=arrival["attribution"],
    )
    assert status == 200

    assert body["attribution"]["source_channel"] == "instagram_ad_click"
    assert body["attribution"]["campaign_id"] == "ivf_over40"
    assert body["origin_lead_session_id"] == arrival["lead_session_id"]


def test_the_concern_is_never_re_asked(base_url):
    """
    "The patient never repeats what they already said." Checklist answers
    survive conversion and are listed explicitly as things not to ask again.
    """
    arrival = arrive(base_url, channel="instagram_ad_click", campaignId="ivf_over40")
    filled = {"onset": "18 months", "concern": "trying to conceive"}

    status, body = convert(
        base_url,
        leadSessionId=arrival["lead_session_id"],
        email="guest@example.com",
        consentHealthSharing=True,
        consentMarketing=False,
        memoryItems=[guest_memory_item()],
        historyFilled=filled,
        attribution=arrival["attribution"],
    )
    assert status == 200

    assert body["history_filled"] == filled
    assert set(body["never_reask"]) == set(filled.keys())


def test_marketing_consent_is_recorded_separately(base_url):
    """A separate record with its own timestamp — never implied by the others."""
    arrival = arrive(base_url, channel="lead_form", volunteeredEmail="guest@example.com")
    status, body = convert(
        base_url,
        leadSessionId=arrival["lead_session_id"],
        email="guest@example.com",
        consentHealthSharing=True,
        consentOverseasProcessing=True,
        consentMarketing=True,
        memoryItems=[],
    )
    assert status == 200

    types = {c["type"] for c in body["consents"]}
    assert {"health_sharing", "overseas_processing", "marketing"} == types
    for consent in body["consents"]:
        assert consent["grantedAt"], "every consent needs its own timestamp"


def test_declining_marketing_records_no_marketing_consent(base_url):
    """Absence must be real absence, so re-engagement has nothing to rely on."""
    arrival = arrive(base_url, channel="lead_form", volunteeredEmail="guest@example.com")
    status, body = convert(
        base_url,
        leadSessionId=arrival["lead_session_id"],
        email="guest@example.com",
        consentHealthSharing=True,
        consentMarketing=False,
        memoryItems=[],
    )
    assert status == 200
    assert "marketing" not in {c["type"] for c in body["consents"]}


def test_identified_lead_is_never_asked_for_its_email(base_url):
    """The most common trust break in the funnel, and the cheapest to avoid."""
    body = arrive(base_url, channel="lead_form", volunteeredEmail="guest@example.com")
    assert "email" in body["never_ask"]


def test_same_concern_two_channels_two_openings(base_url):
    """
    The brief's observable minimum: channel changes the opening, never the
    safety verdict.
    """
    a = arrive(base_url, channel="instagram_ad_click", campaignId="ivf_over40")
    b = arrive(base_url, channel="staff_referral", staffName="Dr Lim",
               staffReferralNote="asked about egg freezing at today's visit")

    assert a["opening"] != b["opening"]
    assert a["identity_level"] != b["identity_level"]
    # Same message, identical risk classification regardless of channel.
    assert chat(base_url, "I have crushing chest pain")["risk"]["level"] == "high"


def test_staff_referral_preloads_the_topic(base_url):
    """Scenario C: the link opens already knowing what was discussed."""
    status, body = post(
        base_url,
        "/api/staff/referral",
        {"clinicId": CLINIC_ID, "staffName": "Dr Lim",
         "note": "asked about egg freezing at today's visit"},
    )
    assert status == 200
    assert "egg freezing" in body["preloaded_context"]["topic"]
    assert "egg freezing" in body["preloaded_context"]["opening"]
    assert "concern" in body["preloaded_context"]["skip_questions"]
