"""
Shared plumbing for the evaluation harness.

DESIGN DECISION: the harness measures the REAL risk gate over HTTP rather than
reimplementing the matcher in Python. A reimplementation would drift from the
running system within a week and would then be measuring a fiction. The cost is
that `npm run dev` has to be running; the benefit is that every number produced
here describes the thing actually deployed.

Requests use include_llm=false, so the harness scores the DETERMINISTIC layer
and consumes zero model quota. That is deliberate on both counts: the
deterministic layer is the one that must hold without a network, and a
measurement that costs money per row is a measurement nobody re-runs.
"""

from __future__ import annotations

import json
import pathlib
import urllib.error
import urllib.request
from dataclasses import dataclass

import pyarrow.parquet as pq

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "eval" / "data"
BASE_URL = "http://localhost:3000"

EMERGENCY_TAG = "theme:emergency_referrals"


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------


@dataclass
class Row:
    text: str
    prompt_id: str | None = None
    tags: list[str] | None = None
    source: str = ""

    @property
    def emergency_tagged(self) -> bool:
        return bool(self.tags) and EMERGENCY_TAG in self.tags


def _prompt_text(prompt) -> str:
    """healthbench stores `prompt` as a list of chat messages."""
    if isinstance(prompt, list):
        parts = [
            str(m.get("content", ""))
            for m in prompt
            if isinstance(m, dict) and m.get("role") in (None, "user")
        ]
        if not parts:
            parts = [str(m.get("content", "")) for m in prompt if isinstance(m, dict)]
        return " ".join(p for p in parts if p).strip()
    return str(prompt or "").strip()


def load_healthbench(language: str) -> list[Row]:
    """language: english | malay | indonesian"""
    path = DATA / f"healthbench_{language}.parquet"
    if not path.exists():
        raise SystemExit(f"{path} missing. Run: python eval/download.py")

    table = pq.read_table(path, columns=["example_tags", "prompt", "prompt_id"])
    tags = table.column("example_tags").to_pylist()
    prompts = table.column("prompt").to_pylist()
    ids = table.column("prompt_id").to_pylist()

    rows = []
    for tag, prompt, pid in zip(tags, prompts, ids):
        text = _prompt_text(prompt)
        if not text:
            continue
        rows.append(
            Row(
                text=text,
                prompt_id=str(pid),
                tags=[str(t) for t in (tag or [])],
                source=f"healthbench_{language}",
            )
        )
    return rows


def load_patient_voice() -> list[Row]:
    """
    The negative class: first-person symptom descriptions, overwhelmingly
    non-urgent (dermatology, chronic complaints, minor infections).

    A detector that escalates everything is useless — it buries the real
    emergency. Only a negative set can show whether that is happening.
    """
    rows: list[Row] = []

    p = DATA / "symptom_to_diagnosis.parquet"
    if p.exists():
        t = pq.read_table(p, columns=["input_text", "output_text"])
        for text, label in zip(
            t.column("input_text").to_pylist(), t.column("output_text").to_pylist()
        ):
            if text:
                rows.append(Row(text=str(text), tags=[f"dx:{label}"], source="symptom_to_diagnosis"))

    p = DATA / "symptom2disease.parquet"
    if p.exists():
        t = pq.read_table(p, columns=["text", "label"])
        for text, label in zip(t.column("text").to_pylist(), t.column("label").to_pylist()):
            if text:
                rows.append(Row(text=str(text), tags=[f"dx:{label}"], source="symptom2disease"))

    return rows


def parallel_pairs(a: str, b: str) -> list[tuple[Row, Row]]:
    """
    Join two languages on prompt_id.

    This is the property that makes a fairness audit possible: the clinical
    content is IDENTICAL and only the language differs, so any systematic gap in
    how the detector responds is a language effect rather than a difference in
    what the rows describe.
    """
    left = {r.prompt_id: r for r in load_healthbench(a) if r.prompt_id}
    right = {r.prompt_id: r for r in load_healthbench(b) if r.prompt_id}
    shared = sorted(set(left) & set(right))
    return [(left[i], right[i]) for i in shared]


# ---------------------------------------------------------------------------
# Scoring against the running system
# ---------------------------------------------------------------------------


def score(text: str, include_llm: bool = False, base_url: str = BASE_URL) -> dict:
    body = json.dumps({"text": text[:4000], "include_llm": include_llm}).encode()
    req = urllib.request.Request(
        f"{base_url}/api/risk", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def require_server(base_url: str = BASE_URL) -> None:
    try:
        score("ping", base_url=base_url)
    except (urllib.error.URLError, OSError) as e:
        raise SystemExit(
            f"Cannot reach {base_url}. Start the app first:\n  npm run dev\n\n({e})"
        )


def score_all(rows: list[Row], include_llm: bool = False, label: str = "") -> list[dict]:
    """Score every row, printing progress — thousands of requests take a while."""
    out = []
    total = len(rows)
    for i, row in enumerate(rows, 1):
        if i % 200 == 0 or i == total:
            print(f"    {label} {i}/{total}", flush=True)
        try:
            result = score(row.text, include_llm=include_llm)
        except Exception as e:
            out.append({"row": row, "error": str(e)[:80]})
            continue
        out.append(
            {
                "row": row,
                "risk": result["risk_level"],
                "escalates": result["risk_level"] in ("medium", "high"),
                "high": result["risk_level"] == "high",
                "rule": result.get("matched_rule_id"),
            }
        )
    return out


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------


def wilson_interval(successes: int, total: int, z: float = 1.96) -> tuple[float, float]:
    """
    95% confidence interval for a proportion.

    Wilson rather than normal-approximation because these subgroups are small
    and proportions sit near 0 or 1, where the normal approximation produces
    intervals that extend past the bounds and understate uncertainty. Reporting
    a point estimate alone from a few hundred rows would overstate what the
    measurement supports.
    """
    if total == 0:
        return (0.0, 0.0)
    p = successes / total
    denom = 1 + z**2 / total
    centre = (p + z**2 / (2 * total)) / denom
    margin = z * ((p * (1 - p) / total + z**2 / (4 * total**2)) ** 0.5) / denom
    return (max(0.0, centre - margin), min(1.0, centre + margin))


def four_fifths(rate_a: float, rate_b: float) -> tuple[float, bool]:
    """
    The four-fifths (80%) rule — the disparate-impact test used in the FYP
    fairness audit, applied here to a safety property rather than a hiring one.

    Returns (ratio, passes). A ratio below 0.8 means the disadvantaged group is
    detected at less than 80% the rate of the advantaged group, which is the
    conventional threshold for treating a disparity as material.
    """
    hi, lo = max(rate_a, rate_b), min(rate_a, rate_b)
    if hi == 0:
        return (1.0, True)
    ratio = lo / hi
    return (ratio, ratio >= 0.8)
