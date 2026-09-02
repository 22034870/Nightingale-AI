#!/usr/bin/env python3
"""
Download the evaluation datasets.

    python eval/download.py

Pulls parquet files directly from HuggingFace rather than going through the
datasets-server rows API, which returned 500s intermittently while this was
built. The parquet files are static objects and download reliably.

Everything lands in eval/data/, which is gitignored — datasets are not vendored
into the repository. Licences and provenance are recorded in ATTRIBUTION.txt and
research/report-G-datasets.md.

DATASETS
--------
projetogabi/healthbench-multilingual   MIT
    33 languages, 5,000 rows each, as a TRUE PARALLEL CORPUS: prompt_id is
    identical across English_original / Malay / Indonesian, so the clinical
    content is held constant and only the language varies. Roughly 9.5% of rows
    carry theme:emergency_referrals, which is the positive class.

    This is what makes a fairness audit possible rather than hand-wavy. Without
    a parallel corpus you cannot separate "the detector is worse at Malay" from
    "the Malay rows happen to describe different things".

gretelai/symptom_to_diagnosis          Apache-2.0   1,065 rows
NeuronZero/Symptom2Disease             Apache-2.0   1,200 rows
    First-person patient voice, mostly non-urgent (dermatology, chronic
    complaints). Used as the NEGATIVE class to measure false alarms — a detector
    that escalates everything is useless, and only a negative set can show that.
"""

import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "eval" / "data"

HF = "https://huggingface.co/datasets"

FILES = {
    # healthbench-multilingual: one parquet per language config.
    "healthbench_english.parquet":
        f"{HF}/projetogabi/healthbench-multilingual/resolve/refs%2Fconvert%2Fparquet/"
        "English_original/test/0000.parquet",
    "healthbench_malay.parquet":
        f"{HF}/projetogabi/healthbench-multilingual/resolve/refs%2Fconvert%2Fparquet/"
        "Malay/test/0000.parquet",
    "healthbench_indonesian.parquet":
        f"{HF}/projetogabi/healthbench-multilingual/resolve/refs%2Fconvert%2Fparquet/"
        "Indonesian/test/0000.parquet",
    # Negative class — patient-voice, largely non-urgent.
    "symptom_to_diagnosis.parquet":
        f"{HF}/gretelai/symptom_to_diagnosis/resolve/refs%2Fconvert%2Fparquet/"
        "default/train/0000.parquet",
    "symptom2disease.parquet":
        f"{HF}/NeuronZero/Symptom2Disease/resolve/refs%2Fconvert%2Fparquet/"
        "default/train/0000.parquet",
}


def download(name: str, url: str) -> bool:
    target = DATA / name
    if target.exists() and target.stat().st_size > 1000:
        print(f"  {name:<34} already present ({target.stat().st_size/1e6:.1f} MB)")
        return True

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "nightingale-eval"})
        with urllib.request.urlopen(req, timeout=180) as r:
            data = r.read()
        target.write_bytes(data)
        print(f"  {name:<34} {len(data)/1e6:6.1f} MB")
        return True
    except urllib.error.HTTPError as e:
        print(f"  {name:<34} FAILED HTTP {e.code}")
        print(f"      {url}")
        return False
    except Exception as e:
        print(f"  {name:<34} FAILED {e}")
        return False


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    print(f"Downloading to {DATA}")

    ok = all([download(name, url) for name, url in FILES.items()])

    gitignore = DATA / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text("*\n", encoding="utf-8")

    if not ok:
        sys.exit(
            "\nOne or more downloads failed. The parquet paths on HuggingFace can "
            "change;\ncheck the dataset page and update FILES in this script."
        )

    print("\nNext:")
    print("  npm run dev                 # the harness measures the REAL risk gate over HTTP")
    print("  python eval/run_eval.py     # confusion matrix")
    print("  python eval/fairness_audit.py")


if __name__ == "__main__":
    main()
