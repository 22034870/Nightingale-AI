#!/usr/bin/env python3
"""
ABANDONMENT MODEL — who stops before they reach care, and can we see it coming?

    python analysis/abandonment_model.py
    python analysis/abandonment_model.py --min-sessions 300

WHAT THIS IS
------------
The same supervised-classification methodology as the FYP churn work, pointed at
a different outcome. Churn asks "will this customer leave?". This asks "will this
person give up before reaching a clinician?" — structurally identical, and the
class imbalance, the leakage traps and the fairness questions all carry over.

WHY IT IS NOT A "LEAD SCORE"
----------------------------
This deliberately does NOT rank people by value, and its output must never
reorder the triage queue. The queue sorts by clinical risk; a model that let
predicted conversion influence who a nurse sees first would turn a safety
ordering into a sales ordering. That is the one thing this project will not do.

The legitimate use is the opposite direction: find the STEPS that lose people,
so the product gets fixed. A model that says "sessions arriving from social
comments at 2am abandon at 80%" is an instruction to improve the after-hours
message, not a licence to deprioritise those people.

LEAKAGE — the part that quietly ruins churn models
--------------------------------------------------
Every feature here must be knowable EARLY, before the outcome is determined.
Including, say, the number of messages exchanged would produce a beautiful AUC
and a useless model, because long conversations are the ones that converted. The
feature builder below is restricted to what is true within the first few minutes
of a session, and `LEAKY` names the fields that are deliberately excluded.
"""

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]

# Features that would leak the outcome. Named, not merely omitted, so the next
# person to extend this can see the boundary rather than rediscover it.
LEAKY = {
    "message_count",       # long chats are the converting ones
    "history_completeness",# only high once the funnel has largely succeeded
    "escalation_sent",     # the label
    "value_event_count",   # downstream of the thing being predicted
}


def load_env():
    env = ROOT / ".env.local"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit(
            "SUPABASE_SERVICE_ROLE_KEY is not set, so there is no data to model.\n"
            "Add it to .env.local, apply db/schema.sql, then:\n"
            "  python scripts/replay_traffic.py --sessions 400"
        )
    return url.rstrip("/"), key


def fetch(url, key, table, select, limit=50000):
    req = urllib.request.Request(
        f"{url}/rest/v1/{table}?select={select}&limit={limit}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"{table}: HTTP {e.code} {e.read().decode()[:300]}")


def build_frame(events):
    """One row per session. Features from the FIRST event only, plus timing."""
    sessions = defaultdict(list)
    for e in events:
        if e.get("lead_session_id"):
            sessions[e["lead_session_id"]].append(e)

    rows = []
    for sid, evs in sessions.items():
        evs.sort(key=lambda x: x["created_at"])
        first = evs[0]
        meta = first.get("metadata_json") or {}
        types = {e["event_type"] for e in evs}

        t0 = datetime.fromisoformat(first["created_at"].replace("Z", "+00:00"))

        # Time from arrival to the first thing they typed. Available within
        # minutes, and one of the few honest early signals of engagement.
        spoke_at = next(
            (e for e in evs if e["event_type"] == "conversation_started"), None
        )
        mins_to_first_message = (
            (
                datetime.fromisoformat(spoke_at["created_at"].replace("Z", "+00:00"))
                - t0
            ).total_seconds()
            / 60
            if spoke_at
            else None
        )

        risk = None
        for e in evs:
            r = (e.get("metadata_json") or {}).get("risk_level")
            if r:
                risk = r
                break

        rows.append({
            "session_id": sid,
            # --- features, all knowable early ---
            "source_channel": meta.get("source_channel") or "unknown",
            "identity_level": meta.get("identity_level") or "anonymous",
            "has_campaign": int(bool(meta.get("campaign_id"))),
            "hour_of_day": t0.astimezone(timezone.utc).hour,
            "is_after_hours": int(t0.hour < 8 or t0.hour >= 18),
            "is_weekend": int(t0.weekday() >= 5),
            "risk_level": risk or "none",
            "spoke_at_all": int(spoke_at is not None),
            "mins_to_first_message": (
                round(mins_to_first_message, 2) if mins_to_first_message is not None else -1.0
            ),
            # --- label ---
            "abandoned": int("escalation_sent" not in types and "patient_created" not in types),
            # --- audit only, never a feature ---
            "_synthetic": bool(meta.get("synthetic")),
        })
    return rows


def four_fifths(rates: dict) -> tuple[float, str, str]:
    """Adverse-impact ratio: worst group over best. Same rule as the eval harness."""
    if len(rates) < 2:
        return 1.0, "", ""
    best = max(rates, key=rates.get)
    worst = min(rates, key=rates.get)
    ratio = rates[worst] / rates[best] if rates[best] else 1.0
    return ratio, worst, best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-sessions", type=int, default=150)
    ap.add_argument("--out", default="analysis/abandonment_report.md")
    args = ap.parse_args()

    try:
        import numpy as np
        import pandas as pd
        from sklearn.compose import ColumnTransformer
        from sklearn.ensemble import HistGradientBoostingClassifier
        from sklearn.inspection import permutation_importance
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import (
            average_precision_score,
            brier_score_loss,
            roc_auc_score,
        )
        from sklearn.model_selection import train_test_split
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import OneHotEncoder, StandardScaler
    except ImportError:
        sys.exit("pip install scikit-learn pandas numpy")

    url, key = load_env()
    print("Fetching funnel_events…")
    events = fetch(
        url, key, "funnel_events",
        "event_type,lead_session_id,created_at,metadata_json",
    )
    rows = build_frame(events)
    df = pd.DataFrame(rows)

    if len(df) < args.min_sessions:
        sys.exit(
            f"Only {len(df)} sessions. Below {args.min_sessions}, a model would be "
            f"fitting noise and any accuracy figure would be meaningless.\n"
            f"Generate traffic first:  python scripts/replay_traffic.py --sessions 400"
        )

    synthetic_share = df["_synthetic"].mean()
    base_rate = df["abandoned"].mean()

    print(f"\n{len(df)} sessions · {base_rate:.1%} abandoned · "
          f"{synthetic_share:.0%} synthetic")

    if synthetic_share > 0:
        print(
            "\n!! SYNTHETIC DATA IN THE TRAINING SET.\n"
            "   Numbers below describe scripts/replay_traffic.py's assumptions,\n"
            "   NOT real patients. The pipeline is what is being validated here."
        )

    cat = ["source_channel", "identity_level", "risk_level"]
    num = ["has_campaign", "hour_of_day", "is_after_hours", "is_weekend",
           "spoke_at_all", "mins_to_first_message"]

    assert not (set(cat + num) & LEAKY), "a leaky feature reached the matrix"

    X = df[cat + num]
    y = df["abandoned"]

    # Stratified: abandonment is the majority class here, but on real traffic the
    # balance will shift and the split must not drift with it.
    X_tr, X_te, y_tr, y_te, g_tr, g_te = train_test_split(
        X, y, df["source_channel"], test_size=0.25, random_state=42, stratify=y
    )

    pre = ColumnTransformer([
        ("cat", OneHotEncoder(handle_unknown="ignore"), cat),
        ("num", StandardScaler(), num),
    ])

    models = {
        # The baseline that must be beaten before complexity is justified.
        "logistic_regression": Pipeline([
            ("pre", pre),
            ("clf", LogisticRegression(max_iter=1000, class_weight="balanced")),
        ]),
        "gradient_boosting": Pipeline([
            ("pre", pre),
            ("clf", HistGradientBoostingClassifier(max_iter=200, random_state=42)),
        ]),
    }

    results = {}
    for name, pipe in models.items():
        pipe.fit(X_tr, y_tr)
        p = pipe.predict_proba(X_te)[:, 1]
        results[name] = {
            "roc_auc": roc_auc_score(y_te, p),
            "pr_auc": average_precision_score(y_te, p),
            # Calibration matters more than ranking here: the output is meant to
            # be read as a probability by a human, not thresholded by a machine.
            "brier": brier_score_loss(y_te, p),
            "pipe": pipe,
            "proba": p,
        }
        print(f"\n{name}")
        print(f"  ROC-AUC {results[name]['roc_auc']:.3f}  "
              f"PR-AUC {results[name]['pr_auc']:.3f}  "
              f"Brier {results[name]['brier']:.3f}")

    best_name = max(results, key=lambda k: results[k]["pr_auc"])
    best = results[best_name]
    print(f"\nBest by PR-AUC: {best_name}")

    # ---- Does it fail unevenly? Same question the safety eval asks. ---------
    print("\nPer-channel error rates (are we wrong more often for some groups?)")
    per_group, group_n = {}, {}
    for ch in sorted(set(g_te)):
        mask = (g_te == ch).values
        if mask.sum() < 15:
            continue
        pred = (best["proba"][mask] >= 0.5).astype(int)
        acc = float((pred == y_te[mask]).mean())
        per_group[ch] = acc
        group_n[ch] = int(mask.sum())
        print(f"  {ch:<22} n={mask.sum():<4} accuracy {acc:.3f}")

    ratio, worst, bestg = four_fifths(per_group)
    verdict = "PASS" if ratio >= 0.8 else "FAIL"
    # A ratio computed off a handful of rows is noise wearing a verdict's
    # clothing. Reporting "FAIL" from n=16 would be the same overclaiming the
    # rest of this project refuses, so the sample size qualifies the finding
    # rather than hiding behind it.
    smallest = min(group_n.values()) if group_n else 0
    underpowered = smallest < 50
    if underpowered:
        verdict = f"{verdict}, UNDERPOWERED"

    if per_group:
        print(f"\nFour-fifths ratio: {ratio:.3f} ({verdict})")
        if underpowered:
            print(f"  Smallest group has n={smallest}. Below ~50 this ratio swings "
                  f"wildly on a few rows — treat it as a flag to collect more data, "
                  f"not as a measured disparity.")
        if ratio < 0.8:
            print(f"  Worst: {worst} vs best: {bestg}. On this evidence the model "
                  f"is less reliable for {worst} — do not deploy against that group "
                  f"until the sample supports the claim either way.")

    # ---- What actually drives it -------------------------------------------
    imp = permutation_importance(
        best["pipe"], X_te, y_te, n_repeats=10, random_state=42, scoring="average_precision"
    )
    order = np.argsort(imp.importances_mean)[::-1]
    print("\nWhat drives abandonment (permutation importance):")
    drivers = []
    for i in order[:8]:
        col = (cat + num)[i]
        drivers.append((col, float(imp.importances_mean[i])))
        print(f"  {col:<24} {imp.importances_mean[i]:+.4f}")

    # ---- Where the losses concentrate --------------------------------------
    losses = Counter()
    for _, r in df[df["abandoned"] == 1].iterrows():
        losses[(r["source_channel"], "never spoke" if not r["spoke_at_all"] else "spoke, then left")] += 1

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Abandonment model",
        "",
        f"Generated {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC · "
        f"{len(df)} sessions · base abandonment rate {base_rate:.1%}",
        "",
    ]
    if synthetic_share > 0:
        lines += [
            "> **These figures describe synthetic data.**",
            f"> {synthetic_share:.0%} of sessions were generated by "
            "`scripts/replay_traffic.py` using assumed distributions. They validate",
            "> that the pipeline runs end to end; they say nothing about real patients.",
            "> Re-run once real traffic accumulates before quoting any number here.",
            "",
        ]
    lines += [
        "## Models",
        "",
        "| model | ROC-AUC | PR-AUC | Brier |",
        "|---|---|---|---|",
    ]
    for name, r in results.items():
        lines.append(f"| {name} | {r['roc_auc']:.3f} | {r['pr_auc']:.3f} | {r['brier']:.3f} |")
    lines += [
        "",
        f"Selected: **{best_name}** (highest PR-AUC; with an imbalanced label, "
        "PR-AUC is the honest headline and ROC-AUC flatters).",
        "",
        "## Fairness",
        "",
        f"Four-fifths ratio across channels: **{ratio:.3f}** ({verdict})",
        "",
    ]
    if underpowered:
        lines += [
            f"> Smallest group has n={smallest}. Below roughly 50 this ratio swings",
            "> wildly on a few rows — read it as a flag to collect more data, not as",
            "> a measured disparity.",
            "",
        ]
    for ch, acc in sorted(per_group.items(), key=lambda kv: kv[1]):
        lines.append(f"- `{ch}` — accuracy {acc:.3f} (n={group_n[ch]})")
    lines += [
        "",
        "## What drives it",
        "",
    ]
    for col, val in drivers:
        lines.append(f"- `{col}` — {val:+.4f}")
    lines += [
        "",
        "## Where people are lost",
        "",
    ]
    for (ch, how), n in losses.most_common(10):
        lines.append(f"- {n} · {ch} · {how}")
    lines += [
        "",
        "## How this may be used",
        "",
        "This model identifies **steps that lose people**, so the product can be",
        "fixed. It must not rank patients, and its output must never influence the",
        "order of the triage queue — that queue sorts by clinical risk, and letting",
        "predicted conversion touch it would convert a safety ordering into a sales",
        "ordering.",
        "",
        f"Excluded as leakage: {', '.join(sorted(LEAKY))}.",
    ]
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
