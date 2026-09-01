# Report G — Datasets for the risk-gate evaluation harness

Every dataset below was verified by loading the live page or API on 2026-09-01. HuggingFace
entries were confirmed by pulling **actual first rows**, so column names and text register are
observed rather than claimed.

**The finding that matters:** a single MIT-licensed parallel corpus gives you both a labelled
emergency class and a methodologically clean cross-language recall comparison. That is the
fairness audit, handed to you.

---

## TOP 3 PICKS

### 1. `projetogabi/healthbench-multilingual` — the centrepiece

<https://huggingface.co/datasets/projetogabi/healthbench-multilingual> · **MIT** · not gated ·
~28 MB for the Malay config

33 languages, each a separate config of 5,000 rows, including **Malay**, **Indonesian** and
**English_original**. Columns: `example_tags`, `ideal_completions_data`, `prompt`, `prompt_id`,
`rubrics`, `canary`.

Two verified properties make this exceptional for our use case:

- **It is a true parallel corpus.** `prompt_id` values are identical across
  English_original / Malay / Indonesian — row 0 is the same clinical content in all three. You
  can hold the medicine constant and vary *only* language. That is a clean fairness audit rather
  than a hand-wave.
- **It ships an urgency label.** `theme:emergency_referrals` appears in ~9.5% of rows
  (353 of 3,700 sampled → roughly 475 across the full 5,000).

Prompts are conversation turns in lay first person. Verified Malay row:
*"Saya berumur 6 minggu selepas bersalin, tidak mempunyai pemikiran berbahaya..."*

**The audit:** `emergency_referrals` = positive class, everything else = negative. Run the
lexicon over Malay and English separately. Compare recall. **~90 minutes to first result.**

### 2. `gretelai/symptom_to_diagnosis` + `NeuronZero/Symptom2Disease`

<https://huggingface.co/datasets/gretelai/symptom_to_diagnosis> · Apache 2.0 · 1,065 rows · 218 KB
<https://huggingface.co/datasets/NeuronZero/Symptom2Disease> · Apache 2.0 · 1,200 rows
(Kaggle original is CC0: <https://www.kaggle.com/datasets/niyarrbarman/symptom2disease>)

~2,265 rows of clean first-person **patient voice**, verified:
*"I've been having a lot of pain in my neck and back. I've also been having trouble with my balance..."*

Symptom2Disease is mostly dermatology and chronic complaints with few true emergencies — which
makes it the ideal **negative class** for measuring precision. Small enough to read every row,
so the ground truth is actually trustworthy. At this deadline, trustworthy beats large.
**~2 hours including hand-labelling.**

### 3. `lavita/ChatDoctor-HealthCareMagic-100k` — the realistic-noise set

<https://huggingface.co/datasets/lavita/ChatDoctor-HealthCareMagic-100k> · 112,165 rows · 70.5 MB

The `input` field is genuine, unedited patient writing. Verified row:
*"I woke up this morning feeling the whole room is spinning when i was sitting down... i still feel"*

Note the lowercase "i", the run-on, the truncation. **That is the real input distribution** —
this is where the precision number gets honest. Sample 300–500 and hand-label.

⚠️ **Licence not stated on the card.** Scraped from HealthCareMagic. Fine to cite for a portfolio
demo; do not redistribute rows in the repo.

---

## Ruled out, and why

| Dataset | Why not |
|---|---|
| **MIMIC-IV-ED** | Has exactly what we want — ESI acuity *plus* free-text chief complaint — and is unreachable. Credentialed access + CITI training (hours) + signed DUA, with no published approval timeline. Painful, but let it go. |
| **eICU-CRD 2.0** | Identical gate. |
| **n2c2 / i2b2** | Portal returned 403; has always needed a DUA with institutional sign-off. |
| **Yale Hospital Triage (Kaggle)** | 560k rows, but chief complaint is **coded into binary columns**, not free text — zero use for a lexicon. Licence field literally says "Unknown", which is indefensible to an employer. |
| **Synthea** | Emits FHIR/CSV with SNOMED/LOINC codes. **No free-text symptom narratives at all.** Our component reads prose. Skip. |
| **MTSamples** | **Clinician voice** — *"SUBJECTIVE:, This 23-year-old white female presents with complaint of allergies."* Wrong register. Only useful as a deliberate negative control showing recall drops on clinical dictation. |
| **MedQuAD** | Templated NIH strings, not spontaneous patient text. |
| **`li-lab/HealMed`** | Has a `ms` config, but the content is MCQA exam questions. |
| **`olaflaitinen/fedmml-ed-triage`** | The only ESI + free-text option with a real licence (CC BY 4.0, 87k rows), but **gated and unverifiable** — the API returned 401 so nobody has eyeballed the rows. Synthetic, 55 downloads, one author. If used, sanity-check that `clinical_notes` are not repetitive template output first. |

---

## Nothing good exists for

- **Bahasa Malaysia patient symptom text with urgency labels.** Zero. `hermanshid/doctor-id-qa`
  (Apache 2.0, 6,327 rows) is authentic Indonesian patient writing — *"Assalamaualaikum dok, saya
  mau konsul mengenai feses bayi..."* — but unlabelled, and Bahasa Indonesia ≠ Bahasa Malaysia.
  Lexical overlap on symptom words (demam, sakit dada, sesak nafas, muntah) is high; state that
  caveat explicitly if used.
- **Manglish / Malaysian code-switched clinical text.** Absolutely nothing, at any size, anywhere.
  HF searches for `malay medical`, `malay health`, `malaysian medical` returned **0 hits each**.
- **Open-licence free-text ED triage notes with ESI.** Only MIMIC-IV-ED, which is gated.

---

## The defensible 2-hour fallback for Malay/Manglish

Since no Manglish corpus exists, construct one — but construct it in a way that survives scrutiny:

1. Take the ~475 `emergency_referrals` prompts plus a matched non-emergency sample from
   healthbench's **English_original**.
2. Produce Manglish/BM renderings of the **symptom-bearing clause only** — not free translation.
3. Freeze the English `prompt_id` as the join key so the label transfers unchanged.

**Three caveats that must be written into the report**, because a named limitation earns far more
credit than a silent one:

- **(a) Author bias.** You would be partly testing your own lexicon against your own phrasing.
  Mitigate by writing the BM/Manglish variants **before** looking at `red_flags.yaml`, and log
  that you did so. This is pre-registration, and it is the difference between an audit and a
  self-congratulation.
- **(b) Small n.** n ≈ 900 means wide confidence intervals. Report the intervals, not just point
  recall.
- **(c) Register skew.** healthbench's Malay is machine-translated from English, so it reads
  formal. It will **understate** the true Manglish gap. Say so — the real-world gap is likely
  worse than what you measure.
