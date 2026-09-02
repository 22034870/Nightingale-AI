#!/usr/bin/env python3
"""
Cross-language fairness audit of the deterministic risk gate.

    npm run dev                        # in another terminal
    python eval/fairness_audit.py
    python eval/fairness_audit.py --limit 500      # quick pass

THE QUESTION
------------
Does the red-flag detector escalate Malay-language descriptions at the same rate
as the identical clinical content in English?

If it catches 30% of English rows and 18% of the same rows in Malay, then
Malay-speaking patients receive measurably worse triage from the same system.
That is a SAFETY inequity, not a marketing one, and it is invisible to every
conventional accuracy metric because the aggregate number looks fine.

WHY THIS WORKS WITHOUT GROUND TRUTH
-----------------------------------
healthbench-multilingual is a true parallel corpus: prompt_id is identical
across languages, so each pair is the same clinical content expressed in two
languages. We are not asking "is this escalation correct?" — we are asking
"does the same content get treated the same way?"

That means the audit is valid even though, as run_eval.py documents, the
dataset's own emergency label does NOT mean what its name suggests. A disparity
between two renderings of the same sentence is a language effect regardless of
whether either verdict is right.

LIMITATIONS, STATED UP FRONT
----------------------------
1. The Malay rows are MACHINE-TRANSLATED from English, so they read formally.
   Real Malaysian patients write Bahasa Rojak — code-switched, colloquial,
   abbreviated. A formal translation is the EASY case, so any gap measured here
   is a LOWER BOUND on the real-world gap.
2. This measures the deterministic lexicon only (include_llm=false). The LLM
   layer would likely narrow the gap, but it is the layer that disappears during
   an outage, so the floor matters.
3. No clinical expert validated the Malay renderings.
"""

from __future__ import annotations

import argparse
import collections

from harness import (
    EMERGENCY_TAG,
    four_fifths,
    load_healthbench,
    parallel_pairs,
    require_server,
    score_all,
    wilson_interval,
)


def audit(language: str, limit: int | None, emergency_only: bool):
    pairs = parallel_pairs("english", language)
    if emergency_only:
        pairs = [(a, b) for a, b in pairs if a.emergency_tagged]
    if limit:
        pairs = pairs[:limit]

    if not pairs:
        print(f"  No parallel rows for english/{language}.")
        return None

    print(f"\n  Scoring {len(pairs)} parallel pairs (english vs {language})…")
    en = score_all([a for a, _ in pairs], label="english")
    other = score_all([b for _, b in pairs], label=language)

    en_hits = sum(1 for r in en if r.get("escalates"))
    ot_hits = sum(1 for r in other if r.get("escalates"))
    n = len(pairs)

    en_rate, ot_rate = en_hits / n, ot_hits / n
    en_ci, ot_ci = wilson_interval(en_hits, n), wilson_interval(ot_hits, n)
    ratio, passes = four_fifths(en_rate, ot_rate)

    print(f"\n  {'':<14}{'escalated':>12}{'rate':>9}{'95% CI':>20}")
    print(f"  {'english':<14}{en_hits:>12}{en_rate:>9.1%}   [{en_ci[0]:.1%}, {en_ci[1]:.1%}]")
    print(f"  {language:<14}{ot_hits:>12}{ot_rate:>9.1%}   [{ot_ci[0]:.1%}, {ot_ci[1]:.1%}]")
    print(f"\n  four-fifths ratio : {ratio:.3f}   {'PASS' if passes else 'FAIL — disparate impact'}")

    # Disagreements are where the lexicon has a language-specific hole. These
    # are the actionable output: each one is a phrase to add.
    disagree = [
        (pairs[i][0], pairs[i][1])
        for i in range(n)
        if en[i].get("escalates") and not other[i].get("escalates")
    ]
    print(f"  caught in English but missed in {language}: {len(disagree)}")

    if disagree:
        print(f"\n  Examples of what the {language} lexicon misses:")
        for a, b in disagree[:5]:
            print(f"    EN: {a.text[:88].replace(chr(10),' ')}")
            print(f"    {language[:2].upper()}: {b.text[:88].replace(chr(10),' ')}")
            print()

    # Which rules carry English but have no counterpart in the other language.
    en_rules = collections.Counter(r["rule"] for r in en if r.get("rule"))
    ot_rules = collections.Counter(r["rule"] for r in other if r.get("rule"))
    gaps = [(rule, c, ot_rules.get(rule, 0)) for rule, c in en_rules.most_common() if c > ot_rules.get(rule, 0)]
    if gaps:
        print("  Rules firing more in English than in " + language + ":")
        for rule, a, b in gaps[:8]:
            print(f"    {rule:<14} en={a:<5} {language[:2]}={b}")

    return {"language": language, "n": n, "en_rate": en_rate, "other_rate": ot_rate,
            "ratio": ratio, "passes": passes, "missed": len(disagree)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="cap pairs per language")
    ap.add_argument("--all-rows", action="store_true",
                    help="audit every row, not just emergency-tagged ones")
    args = ap.parse_args()

    require_server()

    print("=" * 78)
    print("CROSS-LANGUAGE FAIRNESS AUDIT — deterministic risk gate")
    print("=" * 78)
    print("\nDoes identical clinical content get treated the same way in Malay as in")
    print("English? Parallel corpus, so any gap is a language effect.")

    total = len(load_healthbench("english"))
    tagged = sum(1 for r in load_healthbench("english") if r.emergency_tagged)
    scope = "all rows" if args.all_rows else f"emergency-tagged only ({tagged} of {total})"
    print(f"\nScope: {scope}")

    results = []
    for language in ("malay", "indonesian"):
        r = audit(language, args.limit, emergency_only=not args.all_rows)
        if r:
            results.append(r)

    print("\n" + "=" * 78)
    print("SUMMARY")
    print("=" * 78)
    for r in results:
        verdict = "PASS" if r["passes"] else "FAIL"
        print(f"  english vs {r['language']:<12} ratio={r['ratio']:.3f}  {verdict}"
              f"   (missed {r['missed']} of {r['n']})")

    failing = [r for r in results if not r["passes"]]
    if failing:
        print("\n  A ratio below 0.80 means the disadvantaged language is detected at")
        print("  less than 80% the rate of English. Each missed row above is a phrase")
        print("  the lexicon needs. This is a safety gap, not a quality one.")
    else:
        print("\n  No disparate impact at the 0.80 threshold on this sample.")

    print("\n  REMEMBER: the non-English rows are machine-translated and read")
    print("  formally. Real patients write colloquial Bahasa Rojak, which is the")
    print("  harder case — so any gap here is a LOWER BOUND on the real one.")


if __name__ == "__main__":
    main()
