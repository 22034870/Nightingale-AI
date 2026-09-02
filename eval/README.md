# Risk-gate evaluation harness

Measures the deterministic risk gate against real data, and audits whether it
treats Malay- and Indonesian-language patients the same as English-speaking ones.

```bash
python eval/download.py          # ~110 MB into eval/data (gitignored)
npm run dev                      # the harness measures the RUNNING system
python eval/run_eval.py
python eval/fairness_audit.py
```

Scoring uses `include_llm=false`, so it exercises the **deterministic layer** and
consumes **zero model quota**. That is deliberate: this is the layer that must
hold when the network doesn't, and a measurement that costs money per row is one
nobody re-runs.

---

## Why this exists

Before this harness, the evidence that the risk gate worked was *"24 hand-written
fixtures pass"*. Fixtures I wrote, checked against a lexicon I wrote. That is
circular, and it is a vibe rather than a measurement.

---

## Headline result: a real safety gap, found and closed

The fairness audit compares how the gate treats **identical clinical content**
across languages, using `healthbench-multilingual` — a parallel corpus where
`prompt_id` is the same row in English, Malay and Indonesian.

**Before:**

| Comparison | Escalation rate | Four-fifths ratio | |
|---|---|---|---|
| English vs Malay | 74.0% / 70.8% | **0.957** | PASS |
| English vs Indonesian | 74.0% / 56.8% | **0.768** | **FAIL — disparate impact** |

`RF_RESP_01` (difficulty breathing) fired **15 times in English and 0 times in
Indonesian** on the same clinical content.

**The cause was one letter.** Indonesian spells it *"sesak **na**pas"*; Malay
spells it *"sesak **naf**as"*. The same for cardiac: Indonesian says *"**nyeri**
dada"* where Malay says *"**sakit** dada"*. The lexicon had been sourced from
Malay-language research, so it was blind to Indonesian phrasing — and the
aggregate accuracy number would never have shown it.

**After adding Indonesian variants:**

| Comparison | Four-fifths ratio | |
|---|---|---|
| English vs Malay | **0.978** | PASS |
| English vs Indonesian | **0.962** | PASS |

`RF_RESP_01` in Indonesian: 0 → 11.

This is a **safety** inequity, not a quality one. A detector that misses
breathlessness in one language gives those patients worse triage from the same
system, and no conventional metric surfaces it.

---

## Second finding: false alarms on administrative questions

`run_eval.py` scores 15 questions with no clinical content, where the only
correct answer is zero escalations.

**Before: 4 of 15 escalated.**

```
"Where is the clinic and is there parking?"   → medium
"Can I ask for a female doctor?"              → medium
"Is the clinic open on public holidays?"      → medium
"Do you have doctors who speak Mandarin?"     → medium
```

The cause: `clinic`, `doctor`, `hospital` and `nurse` were in the clinical-signal
vocabulary that scopes the fail-closed rule. Those are **venue and role words** —
they indicate someone is talking *about* the clinic, not about a symptom.

**After removing them: 0 of 15.** Each of those four would have been a nurse
summoned for a parking question.

---

## Two label-validity problems

Both would have produced confident, wrong numbers. Both were caught by reading
rows instead of trusting column names. **This is the most transferable lesson
here.**

### 1. `theme:emergency_referrals` does not mean "this is an emergency"

482 of 5,000 healthbench rows carry the tag. The name suggests a positive class
for a triage detector. It is not — it means *"a good answer should address
whether to seek emergency care"*, **including when the answer is no**. Tagged
rows include:

> "I started taking a new herbal supplement... should I be concerned about
> interactions with my blood pressure medication?"

> "What is recommended for a mild earache that won't go away after four days?"

None is an emergency. Scoring recall against this label would have reported
terrible recall that actually reflected the detector behaving **correctly**.

### 2. `symptom_to_diagnosis` and `Symptom2Disease` are labelled by diagnosis, not acuity

I initially treated these as a non-urgent corpus and reported a 97% "false-alarm
rate". Reading the hits showed most were defensible — *"my throat is swollen and
I have difficulty breathing"* **should** reach a clinician. A row labelled
"Bronchial Asthma" may describe a stable condition or an acute attack, and
nothing in the data distinguishes them.

Neither is a flaw in the datasets. Both are flaws in the obvious reading of their
names.

---

## What is deliberately NOT measured

**Recall against clinician-labelled emergencies.** No openly licensed dataset
provides acuity labels on patient-voice text. The one that does — MIMIC-IV-ED,
with ESI acuity *and* free-text chief complaint — requires credentialing, CITI
training and a signed data use agreement. See `research/report-G-datasets.md`.

Saying so is the point. Recall is the number a reader most wants, and inventing
a proxy for it would be the most damaging thing this harness could do.

---

## Limitations

1. **The non-English rows are machine-translated** and read formally. Real
   Malaysian patients write Bahasa Rojak — code-switched, colloquial,
   abbreviated. Formal translation is the *easy* case, so **the measured gap is
   a lower bound** on the real one.
2. **Deterministic layer only.** The LLM classifier would likely narrow the
   language gap, but it is the layer that disappears during an outage.
3. **No clinical expert** validated the non-English renderings.
4. **n = 250 per language** by default. Confidence intervals are reported;
   pass `--limit 0`-style larger runs for tighter bounds.
5. **Circularity remains partial.** Fixing the Indonesian gap means the lexicon
   was tuned using this corpus. The honest reading is that the audit found a
   *class* of bug (language-specific blind spots), not that the lexicon is now
   complete.

---

## Files

| File | Purpose |
|---|---|
| `download.py` | Fetches parquet directly from HuggingFace |
| `harness.py` | Data loading, HTTP scoring, Wilson intervals, four-fifths rule |
| `run_eval.py` | False-alarm control, escalation rate, label validity |
| `fairness_audit.py` | Cross-language equity — the headline measurement |

Datasets are **not vendored**; licences in `ATTRIBUTION.txt`.

`healthbench-multilingual` MIT · `symptom_to_diagnosis` Apache-2.0 ·
`Symptom2Disease` Apache-2.0
