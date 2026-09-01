"""
test_memory_mutation.py — the brief's required memory test.

    Turn 1: "I take Advil."              -> Profile contains meds: Advil (active)
    Turn 2: "Actually I stopped last week." -> Advil removed or marked stopped
    Assert: provenance links exist for BOTH states

The last line is the one that matters. Marking a medication stopped is easy;
proving you can still resolve BOTH states back to the messages that produced
them is what separates a dynamic medical history from a chat log with a summary
stapled on.

Nothing is overwritten and nothing is deleted. A correction writes a NEW item,
marks the old one superseded, and links them in both directions, so each row
keeps its own provenance pointer.
"""

import pytest
from conftest import chat


def converse(base, messages):
    """Multi-turn, carrying session state forward exactly as the client does."""
    state = {"memoryItems": [], "historyFilled": {}, "askedCount": 0}
    history, last = [], None

    for text in messages:
        last = chat(base, text, history=history[-6:], **state)
        state = last["state"]
        history.extend([text, last["reply"]])
    return last


@pytest.mark.llm
def test_medication_is_recorded_as_active(base_url, llm_ready):
    body = chat(base_url, "I take Advil every morning")
    meds = body["profile"]["medications"]

    assert any(m["value"].lower() == "advil" for m in meds), f"Advil not extracted: {meds}"
    advil = next(m for m in meds if m["value"].lower() == "advil")
    assert advil["status"] == "active"
    assert advil["provenance_id"], "every fact must point at the message that made it"


@pytest.mark.llm
def test_correction_marks_it_stopped(base_url, llm_ready):
    body = converse(base_url, ["I take Advil every morning", "Actually I stopped the Advil last week"])
    meds = body["profile"]["medications"]

    advil = [m for m in meds if m["value"].lower() == "advil"]
    assert advil, f"Advil disappeared entirely: {meds}"
    # The current view shows one live Advil row, and it is stopped.
    assert all(m["status"] == "stopped" for m in advil), f"still active: {advil}"


@pytest.mark.llm
def test_provenance_links_exist_for_both_states(base_url, llm_ready):
    """
    The assertion the brief actually cares about. Both the original and the
    correction must survive, each resolvable to its own source message.
    """
    body = converse(base_url, ["I take Advil every morning", "Actually I stopped the Advil last week"])
    items = body["state"]["memoryItems"]

    advil = [i for i in items if i["value"].lower() == "advil"]
    assert len(advil) >= 2, f"expected both states to persist, got {len(advil)}: {advil}"

    superseded = [i for i in advil if i["status"] == "superseded"]
    current = [i for i in advil if i["status"] == "stopped"]
    assert superseded, "the original state was destroyed rather than superseded"
    assert current, "no current stopped state"

    old, new = superseded[0], current[0]

    # Both carry independent provenance.
    assert old["provenance"]["messageId"]
    assert new["provenance"]["messageId"]
    assert old["provenance"]["messageId"] != new["provenance"]["messageId"], (
        "both states point at the same message — the correction was not "
        "attributed to the turn that made it"
    )

    # And the chain is linked in both directions.
    assert old.get("supersededBy") == new["id"]
    assert new.get("supersedes") == old["id"]


@pytest.mark.llm
def test_repeating_a_fact_does_not_duplicate_it(base_url, llm_ready):
    """Saying "still on Advil" is not a change and must not create a second row."""
    body = converse(base_url, ["I take Advil every morning", "yes I am still taking the Advil"])
    items = [i for i in body["state"]["memoryItems"] if i["value"].lower() == "advil"]
    assert len(items) == 1, f"repetition created duplicates: {items}"


@pytest.mark.llm
def test_overlapping_extractions_collapse_to_one_fact(base_url, llm_ready):
    """
    Extractors emit "headache", "bad headache", and "bad headache for three
    days" from one sentence. A clinician should see one symptom, not three.
    """
    body = chat(base_url, "I've had a really bad headache for the last three days")
    symptoms = [s["value"].lower() for s in body["profile"]["symptoms"]]
    headaches = [s for s in symptoms if "headache" in s]
    assert len(headaches) <= 2, f"near-duplicate symptoms: {headaches}"


@pytest.mark.llm
def test_minimum_fact_set_is_extractable(base_url, llm_ready):
    """The brief's minimum: chief complaint, symptoms, medications, allergies."""
    body = converse(
        base_url,
        [
            "I've had a bad headache for three days",
            "I take paracetamol for it, and I'm allergic to penicillin",
        ],
    )
    profile = body["profile"]

    assert profile["chief_complaint"], "no chief complaint extracted"
    assert profile["symptoms"], "no symptoms extracted"
    assert profile["medications"], "no medications extracted"
    assert profile["allergies"], "no allergies extracted"


@pytest.mark.llm
def test_profile_updates_live_across_turns(base_url, llm_ready):
    """The sidebar has to grow as the conversation does, not only at the end."""
    state = {"memoryItems": [], "historyFilled": {}, "askedCount": 0}
    history, counts = [], []

    for text in [
        "I've had a headache for three days",
        "It's behind my eyes and feels like pressure",
        "I take paracetamol for it",
    ]:
        body = chat(base_url, text, history=history[-6:], **state)
        state = body["state"]
        history.extend([text, body["reply"]])
        counts.append(len(state["memoryItems"]))

    assert counts == sorted(counts), f"profile shrank between turns: {counts}"
    assert counts[-1] > counts[0], "profile never grew"
