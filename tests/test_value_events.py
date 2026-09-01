"""
test_value_events.py — the brief's required value-event test.

    Every statistic traces to a live query, e.g. "14 people asked this clinic a
    question this week". Generated value messages are tracked and validated.

The brief is explicit that a fabricated number is gimmicky, and it is right:
the whole premise of the funnel is that a stranger can trust what we tell them,
so the first number they see cannot be a lie.

This is enforced structurally rather than by discipline. liveStat() takes a
query and cannot be passed a literal, and below a floor it returns null so the
UI renders NOTHING — not a rounded number, not "a few". A truthful absence beats
a flattering approximation.
"""

import pytest
from conftest import get, chat, CLINIC_ID


def test_statistics_carry_the_query_that_produced_them(base_url, database_ready):
    """A number with no query behind it should not exist."""
    status, body = get(base_url, f"/api/metrics?clinicId={CLINIC_ID}")
    assert status == 200

    stat = body["asked_this_week"]
    assert "query" in stat and stat["query"], "no query recorded for a displayed statistic"
    assert "floor" in stat


def test_below_floor_renders_nothing_rather_than_a_small_number(base_url, database_ready):
    """
    The brief: "If the query_count is zero or trivial, show nothing or a
    truthful alternative, never a fake number."
    """
    status, body = get(base_url, f"/api/metrics?clinicId={CLINIC_ID}")
    assert status == 200

    stat = body["asked_this_week"]
    if stat["suppressed"]:
        assert stat["value"] is None, "suppressed stat must be null, not zero or a placeholder"
    else:
        assert stat["value"] >= stat["floor"], "a value below the floor was displayed"


def test_metrics_are_empty_rather_than_seeded_when_unavailable(base_url):
    """
    A dashboard full of sample data would contradict the very rule this product
    argues for. Without a database it returns 503 and an empty list.
    """
    status, body = get(base_url, f"/api/metrics?clinicId={CLINIC_ID}")
    if status == 503:
        assert body["funnels"] == []
        assert "honest-numbers" in body["detail"] or "fabricated" in body["detail"]


def test_funnel_reports_drop_off_not_just_totals(base_url, database_ready):
    """
    A bar chart of stage totals hides the thing a clinic needs: WHERE people
    leave. That is a property of the transitions, so both are reported.
    """
    status, body = get(base_url, f"/api/metrics?clinicId={CLINIC_ID}")
    assert status == 200

    for funnel in body["funnels"]:
        assert "stages" in funnel
        assert "conversion" in funnel
        for step in funnel["conversion"]:
            assert {"from", "to", "rate", "lost"} <= set(step)
        assert "biggestDropOff" in funnel


def test_abandonment_is_instrumented_not_guessed(base_url, database_ready):
    """
    The brief asks us to explain where users abandon. Guessing is not an answer.
    """
    status, body = get(base_url, f"/api/metrics?clinicId={CLINIC_ID}")
    assert status == 200
    assert "abandonment" in body
    for row in body["abandonment"]:
        assert {"channel", "lastEvent", "count"} <= set(row)


def test_metrics_payload_is_phi_free(base_url, database_ready):
    """
    PHI-free by construction is what justifies keeping this for 30 days when
    guest chat content is destroyed at 7.
    """
    status, body = get(base_url, f"/api/metrics?clinicId={CLINIC_ID}")
    assert status == 200

    serialised = str(body).lower()
    for leak in ["@", "chest pain", "headache", "advil", "nric", "+60"]:
        assert leak not in serialised, f"possible PHI in metrics payload: {leak!r}"


# ---------------------------------------------------------------------------
# Value events
# ---------------------------------------------------------------------------


def test_value_event_fires_only_on_delivered_value(base_url):
    """
    A value_event is logged on successful delivery, never on intent. An
    escalation is not a value event — nothing was answered.
    """
    body = chat(base_url, "I have crushing chest pain")
    assert body["value_events"] == [], "escalation must not count as delivered value"


@pytest.mark.llm
def test_grounded_answer_logs_a_value_event_with_citations(base_url, llm_ready):
    """VE_01: a question answered from the corpus, with a resolvable citation."""
    body = chat(base_url, "What time do you open on Saturday?")

    assert "VE_01" in body["value_events"]
    assert body["citations"], "a grounded answer must cite its source"
    for citation in body["citations"]:
        assert citation["charEnd"] > citation["charStart"], "citation must span real text"
        assert citation["sourceUrl"]


@pytest.mark.llm
def test_history_completeness_drives_the_value_event(base_url, llm_ready):
    """
    VE_02: the History Engine reaching the threshold IS the value — the person
    now has a structured account of their concern they did not have before.
    """
    state = {"memoryItems": [], "historyFilled": {}, "askedCount": 0}
    history, last = [], None

    for text in [
        "I've had a really bad headache for three days",
        "It's at the front behind my eyes, feels like pressure",
        "It's worse when I bend over, paracetamol helps a little",
    ]:
        last = chat(base_url, text, history=history[-6:], **state)
        state = last["state"]
        history.extend([text, last["reply"]])

    assert last["history"]["completeness_pct"] > 0
    if last["history"]["completeness_pct"] >= 60:
        assert "VE_02" in last["value_events"]


def test_completeness_meter_is_bounded_and_real(base_url):
    """
    The meter is the honest-numbers rule applied to the UI: it counts answered
    fields against a fixed denominator, so it cannot flatter.
    """
    body = chat(base_url, "I have a headache")
    progress = body["history"]["progress"]

    assert progress["total"] > 0
    assert 0 <= progress["done"] <= progress["total"]
    expected = round(progress["done"] / progress["total"] * 100)
    assert abs(body["history"]["completeness_pct"] - expected) <= 1
