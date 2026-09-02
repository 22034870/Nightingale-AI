#!/usr/bin/env python3
"""
Measure the deterministic risk gate.

    npm run dev                    # in another terminal
    python eval/run_eval.py
    python eval/run_eval.py --limit 300

TWO LABEL-VALIDITY PROBLEMS WERE FOUND BUILDING THIS
----------------------------------------------------
Both would have produced confident, wrong numbers. Both were caught by reading
the rows instead of trusting the column names.

1. healthbench-multilingual tags ~482 of 5,000 rows `theme:emergency_referrals`.
   That sounds like "this message describes an emergency". It does not. It means
   "a good answer should address whether to seek emergency care" — INCLUDING
   when the correct answer is no. Tagged rows include a herbal-supplement
   interaction question, a four-day earache, and a child with a week-old runny
   nose. None is an emergency. Scoring recall against this label would have
   reported terrible recall that actually reflected the detector behaving
   correctly.

2. symptom_to_diagnosis and Symptom2Disease are labelled by DIAGNOSIS, not by
   ACUITY. A row labelled "Bronchial Asthma" may describe a stable chronic
   condition or an acute attack, and nothing distinguishes them. So they are not
   a non-urgent corpus, and their escalation rate is not a false-alarm rate.

Neither is a flaw in the datasets. Both are flaws in the obvious reading of
their names. A number derived from a label that does not mean what it says is
worse than no number.

WHAT THIS THEREFORE MEASURES
----------------------------
  - false alarms on text with NO clinical content, where zero is the only
    correct answer
  - the escalation rate on symptom text, reported as an OUTAGE FLOOR because it
    runs with the classifier disabled
  - which rules fire, so over-broad phrases are visible

Recall against clinician-labelled emergencies is not measured. No openly
licensed dataset provides acuity labels on patient-voice text; the one that does
(MIMIC-IV-ED) needs credentialing, CITI training and a signed DUA. See
research/report-G-datasets.md.
"""

from __future__ import annotations

import argparse
import collections
import textwrap

from harness import (
    EMERGENCY_TAG,
    Row,
    load_healthbench,
    load_patient_voice,
    require_server,
    score_all,
    wilson_interval,
)


# Genuinely non-clinical text. Escalating any of these is unambiguously wrong,
# which is what makes this the only clean false-alarm measurement available.
ADMIN_CONTROL = [
    "What are your opening hours on Saturday?",
    "Do you accept AIA insurance?",
    "How much does an IVF consultation cost?",
    "Where is the clinic and is there parking?",
    "Can I ask for a female doctor?",
    "Do I need an appointment or can I walk in?",
    "How long does a health screening take?",
    "Can I get a receipt for my company claim?",
    "Is the clinic open on public holidays?",
    "Do you have doctors who speak Mandarin?",
    "I threw the receipt in the bin, can you resend it?",
    "My son is doing well after his vaccination, thank you",
    "Can I reschedule my appointment to next week?",
    "What documents should I bring to my first visit?",
    "Do you do home visits?",
]


def label_validity_check(sample: int = 4):
    print("=" * 78)
    print("LABEL VALIDITY — read the data before scoring against it")
    print("=" * 78)

    rows = load_healthbench("english")
    tagged = [r for r in rows if r.emergency_tagged]
    print(f"\n  {len(tagged)} of {len(rows)} rows carry {EMERGENCY_TAG}")
    print("\n  What the tag actually marks:\n")
    for r in tagged[:sample]:
        print(
            textwrap.fill(
                r.text.replace("\n", " ")[:170],
                72,
                initial_indent="      ",
                subsequent_indent="      ",
            )
            + "\n"
        )
    print("  Triage QUESTIONS, not emergency PRESENTATIONS. Using this as a")
    print("  positive class would measure the wrong thing entirely.")


def admin_control():
    """False-alarm rate on text with no clinical content. Zero is the only pass."""
    print("\n" + "=" * 78)
    print("FALSE-ALARM CONTROL — no clinical content")
    print("=" * 78)
    print(f"\n  {len(ADMIN_CONTROL)} administrative questions. Every escalation here")
    print("  would be a nurse summoned for nothing.\n")

    rows = [Row(text=t, source="admin") for t in ADMIN_CONTROL]
    scored = score_all(rows, label="admin")
    ok = [s for s in scored if "risk" in s]
    bad = [s for s in ok if s["escalates"]]

    print(f"\n  escalated : {len(bad)} of {len(ok)}")
    for s in bad:
        print(f"    FALSE ALARM [{s['risk']}] {s['row'].text}")
    if not bad:
        print("    none — clean on non-clinical text")
    return len(bad), len(ok)


def escalation_rate(limit: int | None):
    print("\n" + "=" * 78)
    print("ESCALATION RATE — first-person symptom descriptions")
    print("=" * 78)

    rows = load_patient_voice()
    if limit:
        rows = rows[:limit]
    if not rows:
        raise SystemExit("No patient-voice data. Run: python eval/download.py")

    print(f"\n  {len(rows)} rows from symptom_to_diagnosis + symptom2disease.")
    print("""
  NOT a false-alarm rate — see label problem 2 in this file's docstring. These
  are labelled by diagnosis, not acuity, so many rows genuinely warrant a
  clinician.

  Run with the classifier disabled, so this is the OUTAGE FLOOR: the fail-closed
  rule puts anything carrying clinical signal at medium. Normal operation, with
  the LLM layer, is lower.
""")

    scored = score_all(rows, label="patient-voice")
    ok = [s for s in scored if "risk" in s]
    if not ok:
        raise SystemExit("Nothing scored — is the server running?")

    counts = collections.Counter(s["risk"] for s in ok)
    escalated = [s for s in ok if s["escalates"]]
    high = [s for s in ok if s["high"]]
    n = len(ok)
    lo, hi = wilson_interval(len(escalated), n)

    print(f"\n  scored          : {n}")
    for level in ("low", "medium", "high"):
        c = counts.get(level, 0)
        print(f"    {level:<8}      {c:>5}  {c / n:>6.1%}")
    print(f"\n  escalation rate : {len(escalated) / n:.1%}   95% CI [{lo:.1%}, {hi:.1%}]")
    print(f"  reached HIGH    : {len(high)} ({len(high) / n:.1%})")

    if high:
        print("\n  Which rules reached HIGH, and a sample of each. Read these: the")
        print("  question is whether a clinician would want to see them, not whether")
        print("  the dataset called them urgent.\n")
        by_rule = collections.Counter(s["rule"] for s in high)
        for rule, c in by_rule.most_common(6):
            example = next(s for s in high if s["rule"] == rule)
            print(f"    {rule}  ({c}x)")
            print(f"      {example['row'].text[:96].replace(chr(10), ' ')}")
    return len(escalated) / n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="cap rows for a quick pass")
    args = ap.parse_args()

    require_server()
    label_validity_check()
    false_alarms, control_n = admin_control()
    rate = escalation_rate(args.limit)

    print("\n" + "=" * 78)
    print("SUMMARY")
    print("=" * 78)
    print(f"  false alarms on non-clinical text : {false_alarms}/{control_n}")
    print(f"  escalation rate on symptom text   : {rate:.1%} (outage floor)")
    print("""
  Recall against clinician-labelled emergencies remains UNMEASURED, and saying
  so is the point. The only dataset that would support it is behind a data use
  agreement.

  For the measurement that needs no ground truth at all — whether identical
  clinical content is treated the same in Malay as in English — run:

    python eval/fairness_audit.py
""")


if __name__ == "__main__":
    main()
