# Nightingale — Technical Brief

**Jason Ong Yann Jing · September 2026 · [nightingale-ai-drab.vercel.app](https://nightingale-ai-drab.vercel.app)**

---

## The problem, in one properly-sourced number

**Healthcare has the worst form view-to-completion of any sector measured: 21.4%.**
(Zuko Analytics, 727,492 healthcare sessions, 2025 — vendor analytics, labelled as such.)

People arrive frightened and leave before they ever reach a clinician. The
industry answer is to capture them faster. I think that instinct is wrong in
healthcare, and most of what follows is the argument for why.

---

## The one idea

Everyone builds a chatbot that answers questions and tries not to diagnose.
Nightingale **asks the questions a clinician would ask** — because *asking is not
diagnosing*.

> "Does the pain spread to your arm?" gathers a fact.
> "That suggests cardiac ischaemia" draws a conclusion.

We do the first and hard-block the second. The conclusion stays with the
clinician, which is exactly where the Medical Act 1971 puts it.

This is the **History Engine** (`lib/history/engine.ts`,
`config/history_checklists.yaml`): per presenting complaint, a bounded checklist
of what a clinician needs, asked one question at a time, each stating why it
matters.

> *"When did it start? That is usually the first thing the doctor will want to know."*

It pays off four ways at once. It is non-diagnostic by construction. It **is**
the value the guest receives — most people do not know that onset and modifying
factors are the questions that matter. It produces an escalation payload a
clinician can act on. And it gives a frightened person a bounded task with a
visible end, rather than open-ended interrogation.

It halts on high risk. Someone with crushing chest pain is not asked seven
questions; they get the emergency line and the handoff, and the partial history
travels with them.

---

## Architecture

```
patient message
      │
      ▼
1. REDACT ─────────── lib/redaction/pipeline.ts
      │               deterministic, 2s deadline, FAILS CLOSED
      │               throws → redaction_quarantine, never proceeds
      ▼
2. RISK GATE ──────── lib/risk/gate.ts        deterministic, pure, cannot time out
      │               lib/risk/classifier.ts  model adds breadth
      │               final = MAX(deterministic, llm)   — never lowered
      ▼
3. EXTRACT ────────── lib/history/engine.ts
      │               runs on EVERY path, including escalation
      ▼
   ┌──┴─────────────────────────────────────────┐
   │ 4. CRISIS      self-harm → fixed copy      │  model never
   │ 5. IDENTITY    "real doctor?" → fixed      │  invoked on
   │ 6. HIGH        stop advice, offer handoff  │  these branches
   └──┬─────────────────────────────────────────┘
      ▼
7. LOW / MEDIUM ───── grounded answer + next history question, with its reason
      ▼
8. GUARD ──────────── lib/chat/guard.ts — post-generation
      │               blocked once → regenerate; blocked twice → vetted copy
      ▼
   reply  +  escalation payload
```

**Three branches never reach a generative model.** The model is trusted only
with low-risk conversation, and even then its output is checked before a patient
sees it. That is the difference between a chatbot with a warning label and a
system with a boundary.

### Why deterministic-first

An LLM classifier catches red flags roughly 99% of the time. For "crushing chest
pain" the missing 1% is a person. So a layer with **100% recall on the mandated
phrases** goes in front, and the model adds breadth on top — never subtracts.

The layering proved itself in both directions during testing:

| Message | Deterministic | Model | Final |
|---|---|---|---|
| "I have crushing chest pain" | **high** | high | high |
| "my chest feels funny" | medium | **high** | high |
| "feeling hopeless… don't see the point" | **low** | **high** | high |

The third row is the argument for having a model at all — the lexicon had no
phrase for generalised hopelessness. It is also why that gap is now closed in
the lexicon too: during an outage it would have stayed low.

### Failure modes

Every failure fails toward safety and honesty, never toward silence.

| Failure | Behaviour |
|---|---|
| LLM timeout (>10s) | Fail **closed** to medium *if the message carries clinical signal*, else hold at low |
| Redaction throws or times out | Message never reaches the model. Raw payload → quarantine, privacy-officer only |
| Redaction low confidence | Over-redact and proceed. Precision is expendable; recall is not |
| Model quota (429) | Distinct failure category. Downgrade to a smaller model rather than serve canned copy mid-sentence |
| Model returns no parts | Treated as unavailable, not as an empty answer — an empty answer renders to a patient as silence |
| Database write fails | Reply still delivered; the response says `persisted:false`. **Never a false confirmation** |
| Guard blocks twice | Discard the model, serve approved copy. We never *edit* generated text into compliance — "you have angina" patched to "you may have angina" reads safe and still asserts a diagnosis |

Scoping the fail-closed rule mattered more than expected. An early version
floored **every** message at medium during an outage, which would have buried a
real emergency behind thirty price enquiries — the exact failure this product
exists to prevent.

---

## Data schema

19 tables, RLS on all of them, default deny. Full DDL in `db/schema.sql`.

```
clinics ──┬── clinic_documents ── document_chunks ◄── citations
          │      (char offsets preserved, so citations resolve to real spans)
          │
          ├── lead_sessions ──── guest_messages ◄──────────┐
          │        │              (7-day retention)         │ provenance
          │        │                                        │ survives
          │        └──► patient_sessions ── messages ◄──────┤ conversion
          │                   │                             │
          ├── patients ───────┼── patient_contacts (rows, not columns)
          │        │          │
          │        ├── memory_items ────────────────────────┘
          │        │      value · status · provenance(table,id) · supersedes
          │        ├── history_checklists
          │        ├── consents (unbundled, separately timestamped)
          │        └── escalations ── clinician_responses  ← reserved, no migration needed
          │
          ├── funnel_events (PHI-free by construction)
          ├── channel_outbound  UNIQUE(channel, external_comment_id)
          ├── redaction_quarantine
          └── audit_log (no column can hold message text)
```

**Messages ↔ Profile ↔ Citations ↔ Escalations.** Every `memory_item` carries a
`(provenance_table, provenance_message_id)` pair. Citations carry
`(chunk_id, char_start, char_end)` into a real document. Escalations snapshot
both. So any line on a clinician's screen resolves in three hops back to the
Instagram ad it started from.

**Provenance is a pair, not a foreign key**, precisely so a fact learned before
signup keeps pointing at its `guest_message` after conversion. Copying facts and
repointing them at fresh patient messages would look identical in the UI and
would quietly destroy the audit trail. That is the trap
`test_guest_to_patient_conversion.py` exists to catch.

**Mutation never overwrites.** A correction writes a NEW item, marks the old one
superseded, and links both ways. A clinician reading "Advil (stopped last week)"
can click through to the sentence where the patient said so, *and* to the earlier
sentence where they said they were taking it.

**Voice readiness.** `messages` already carries `audio_asset_id`,
`transcript_source`, `asr_confidence`, `audio_duration_ms`, `language_detected`.
See the VoiceAI section below.

**The clinician module attaches later** with no migration: `escalations.status`
is an enum through `responded`/`closed`, and `clinician_responses` exists and is
empty.

---

## Channels and ethics

`config/channel_rules.yaml` is one declarative file — channel × identity_level ×
time_of_day → opening strategy. `lib/channels/rules.ts` contains **no channel
names in its logic**; adding WhatsApp is a config edit. The ethics scoring lives
inline beside each channel, so a rule sits next to its justification.

### Implemented

| Channel | Technical | PDPA + MAB | Platform | Trust | Note |
|---|---|---|---|---|---|
| `staff_referral` | 🟢 | 🟢 | 🟢 | 🟢 | Consent is face to face. The strongest we handle |
| `social_comment` | 🟢 | 🟡 | 🟢 | 🟡 | Implemented **de-risked** — see below |
| `website_widget` | 🟢 | 🟢 | 🟢 | 🟢 | They came to us, on our page |
| `lead_form` | 🟢 | 🟢 | 🟢 | 🟢 | Email volunteered for this purpose |
| `telegram_bot` | 🟢 | 🟢 | 🟢 | 🟢 | The one nobody pitches — see below |
| `instagram_ad_click` | 🟢 | 🟢 | 🟢 | 🟢 | Real handler, simulated payload |

### Refused — implemented by nobody here

| Channel | Fails | Why |
|---|---|---|
| Competitor review scraping | Legal · Platform · Trust | Breaches Google ToS; contacting scraped leads is unlawful direct marketing |
| Health-group DM monitoring | Legal · Platform · Trust | Meta bans it, and it is the creepiest option available |
| Inferred-condition retargeting | Legal · Platform | Meta bans health-condition audiences; Google bars inferred-health remarketing |
| Auto-DM on *like* | Technical · Platform · Trust | No like→DM path exists, and a like is not an enquiry |
| Unsolicited outbound | Legal · Trust | MMC classes touting for patients as unethical, and its "Social Media" definition explicitly names WhatsApp and Telegram |

### The yellow, and how it was improved

`social_comment` is yellow on legal and trust, and shipped in a form that
addresses both. **A DM naming a stigmatised condition can out someone** — a
lock-screen preview on a shared phone is enough. So for topics flagged sensitive
(mental health, sexual health, fertility, HIV/STI, addiction) the automated reply
carries **no clinical content at all**:

> "Thanks for reaching out. Here's a private link if you'd like to talk —
> nothing about your message appears in this reply."

It is a door, not a conversation. We convert less and harm nobody. That is the
right trade, and it is the concrete form of the inclusivity requirement.

### The channel few consider: an inbound-only Telegram bot

Green on all four axes, and the only rich chat channel shippable in 48 hours with
zero approvals. The elegant part: **a Telegram bot cannot message anyone who has
not pressed Start.** The platform itself enforces user-initiation — precisely the
property MAB's anti-canvassing rule cares about. Roughly 8–10 million Malaysian
users, second only to WhatsApp.

### Meta, verified

If pursued: private replies are limited to **7 days from comment creation** (not
webhook receipt) and **exactly one per comment, ever**. `channel_outbound` carries
a unique constraint on `(channel, external_comment_id)` because a double-fire
burns the only reply available, permanently.

---

## Compliance

**PDPA s.129 is the load-bearing constraint.** The cross-border whitelist was
abolished by the 2024 amendment (effective 1 April 2025). The "adequate
protection" limb fails outright for US endpoints, and **redaction alone is not
sufficient** — s.4 defines personal data as identifiable "from that *and other
information in the possession of a data controller*", and the clinic keeps the
mapping in order to book anyone. Redacted text is pseudonymised, not anonymised.

Three layers, cheapest first: PHI redaction as due-diligence evidence; an
explicit consent gate naming overseas processing; and the endpoint region as a
config value.

> **Stated limitation, not hidden.** This deployment uses the Gemini AI Studio
> API, which exposes no region control. `LLM_REGION` records intent. Production
> would use Vertex AI in `asia-southeast1`.

**Correction to a common assumption:** the **Telemedicine Act 1997 (Act 564) has
never been brought into force** — s.1 requires a Ministerial notification that was
never made. A brief citing it as binding law has a hole in it. The live
constraints are the **Medical Act 1971** and **MMC guidance**.

**Retention** (`config/copy_rules.yaml`): anonymous metadata 30 days · guest chat
7 days · patient records 7 years (PHFSA 1998) · audit logs 2 years after
destruction. The 30-day metadata retention is justified *because* it is PHI-free
by construction — which is what makes abandonment analytics defensible.

---

## Honest numbers

The brief warns that a fabricated "14 people asked this week" is gimmicky. It is
right, and the premise of the whole funnel is that a stranger can trust what we
tell them — so the first number they see cannot be a lie.

Enforced structurally rather than by discipline: `liveStat()` takes a **query**
and cannot be passed a literal, and below a floor of 5 it returns `null` so the
UI renders **nothing** — not a rounded number, not "a few".

This is also the honest replacement for *"you are not alone."* The research
names that phrase an anti-pattern — scripted, minimising. But the need behind it
is real: stigma, not cost, is the primary driver of delayed care in Malaysia. So
the payload is delivered three other ways: a true live statistic, the approved
line *"It takes courage to reach out about this"*, and the **Family Communication
Kit** — a shareable, unbranded note, which *materially* reduces isolation in a
region where health decisions are family decisions.

**Warm-lead score**, stated rather than fitted:

```
score = 0.35·recency_decay(h, half_life=12h)
      + 0.25·channel_weight
      + 0.20·identity_level_weight
      + 0.20·funnel_stage_weight

THEN, applied AFTER scoring and never as a term:
  if risk ∈ (medium, high): route = CLINICAL_ESCALATION, suppress all sales contact
```

The override is applied after scoring **deliberately**, so the UI can show both
and say: *this lead scored 0.91, and we are not selling to them.* Folding risk
into the weighted sum would route identically and lose the ability to demonstrate
the principle. Weights are stated, not tuned — there is no outcome data, and
claiming calibration would be the same dishonesty as a fabricated statistic.

---

## Where I disagree with the brief

| The brief says | I think | What I built |
|---|---|---|
| Catch prospects **"in milliseconds"** | For commerce, yes. For health, speed reads as **surveillance**. A DM landing seconds after someone comments on a fertility post is frightening, and can out them | Sub-second on *our* surface where they chose to be. On social, a neutral door with no clinical content. Meta itself allows 7 days — the platform does not expect milliseconds |
| Response expectation of **"12 to 18 hours"**, stated | A static promise made at 2am the clinic cannot keep is a top-ten trust breaker | Computed from clinic hours and server time. At night: "the team will see this in the morning", always appended with what to do if it gets worse first |
| Show **"14 people asked this week"** | Right instinct, only if true | `<LiveStat>` with a hard floor and a test that fails on any unbacked integer |
| **"Send to Nurse/Clinic"** as the action | "Send" describes the *system's* action. Their fear is having to retell it | **"Send this to a nurse — you won't have to explain it again"** |
| *(implicit)* Empathetic AI should feel human | A human-like agent measurably **reduces** honest disclosure of stigmatised symptoms | Plainly automated. No avatar, no performed feeling. Zhu & Broadbent 2025 (N=160); Turner et al. 1998 (N=1,690) |

**The one I would defend hardest is the first.** "Milliseconds" is the brief's
own opening claim, and in healthcare it is backwards. The scarcest resource in
this funnel is not the clinic's response time — it is the person's willingness to
type one more sentence.

---

## VoiceAI strategy

The schema is ready; no migration is required.

An audio turn becomes an ordinary `messages` row with `transcript_source='asr'`,
an `audio_asset_id` pointing at object storage, `asr_confidence`,
`audio_duration_ms`, and `language_detected`.

**The safety-critical detail:** ASR confidence must feed the risk gate, and it
must only ever raise risk. A low-confidence transcription of a red-flag phrase —
"chest pain" heard as "just pain", "sesak nafas" heard as anything — should
escalate on uncertainty, not resolve it. Concretely: when
`asr_confidence < 0.8` and the deterministic layer finds nothing, the fail-closed
floor applies exactly as it does during a classifier outage.

Voice also makes `language_detected` load-bearing rather than decorative. The
lexicon already carries Bahasa and Manglish variants because Malaysians *type*
that way; they speak that way more. The redaction pipeline runs unchanged on the
transcript — it is text by the time it reaches us — but spoken IC numbers arrive
as words rather than digits ("eight nine oh four one five…"), which is a real gap
and would need a number-normalisation pass before the regex layer.

---

## Trade-offs and what I cut

| Cut | Why | Instead |
|---|---|---|
| WhatsApp Business API | Business Verification reported at 1–2 months. Not reachable at any effort level | Telegram, where the platform enforces user-initiation — a *better* consent story |
| Real Meta webhook | Development Mode makes it reachable, but time ran out | Real handler, simulated payload, exact constraints encoded |
| Clinician response UI | The brief asks for the *schema* to support it | `escalations.status` + `clinician_responses`, ready |
| ML/NER redaction layer | A model I cannot evaluate in 48 hours is a false sense of safety | The quarantine queue, so failure has a defined destination |
| Multilingual generation | Cannot QA safety copy in a language I cannot verify | Multilingual **detection** — we understand BM/Manglish, answer in English, and say so |
| Recall against clinician-labelled emergencies | No openly licensed dataset has acuity labels on patient-voice text; MIMIC-IV-ED needs credentialing and a DUA | Measured what the data honestly supports — see the evaluation section below |

---

## Measuring the risk gate — and the gap it found

The evidence that the risk gate worked used to be "24 hand-written fixtures
pass" — fixtures I wrote, checked against a lexicon I wrote. That is circular.
`eval/` replaces it with measurement. Full methodology in `eval/README.md`.

### The headline: a real safety inequity, found and closed

`healthbench-multilingual` is a **parallel corpus** — `prompt_id` identifies the
same clinical content in English, Malay and Indonesian. So the audit needs no
ground truth at all: it asks whether identical content is treated identically,
and any systematic gap is a language effect.

| Comparison | Four-fifths ratio | |
|---|---|---|
| English vs Malay | 0.957 | PASS |
| **English vs Indonesian** | **0.768** | **FAIL — disparate impact** |

`RF_RESP_01` (difficulty breathing) fired **15 times in English and 0 times in
Indonesian** on the same rows.

**The cause was one letter.** Indonesian spells it *sesak **na**pas*; Malay,
*sesak **naf**as*. Likewise ***nyeri** dada* versus ***sakit** dada*. The lexicon
had been sourced from Malay-language research and was simply blind to Indonesian
phrasing — and no aggregate accuracy number would ever have shown it.

After adding Indonesian variants: **0.978 and 0.962, both PASS.** Indonesian
`RF_RESP_01` detections went 0 → 11.

This is the four-fifths rule — a disparate-impact test — applied to a safety
property rather than a hiring one. A detector that misses breathlessness in one
language gives those patients worse triage from the same system.

### Second finding: four false alarms in fifteen

On administrative questions with no clinical content, where zero is the only
correct answer, the gate escalated *"Where is the clinic and is there parking?"*
and *"Do you have doctors who speak Mandarin?"*. The cause: `clinic`, `doctor`,
`hospital` and `nurse` sat in the clinical-signal vocabulary. Those are **venue
and role words** — they say someone is talking *about* the clinic, not about a
symptom. Removed: 0 of 15.

### Two label-validity problems, and the lesson

Both would have produced confident, wrong numbers.

**`theme:emergency_referrals` does not mean "this is an emergency."** It means "a
good answer should address whether to seek emergency care" — *including when the
answer is no*. Tagged rows include a herbal-supplement interaction question and a
four-day earache. Scoring recall against it would have reported terrible recall
that actually reflected the detector behaving correctly.

**`symptom_to_diagnosis` is labelled by diagnosis, not acuity.** I first called
its 97% escalation rate a "false-alarm rate". Reading the hits showed most were
defensible — *"my throat is swollen and I have difficulty breathing"* should
reach a clinician.

Neither is a flaw in the datasets. Both are flaws in the obvious reading of their
names, and reading rows is what caught them.

### What remains unmeasured, deliberately

**Recall against clinician-labelled emergencies.** No open dataset provides
acuity labels on patient-voice text. MIMIC-IV-ED has exactly that — ESI acuity
plus free-text chief complaint — behind credentialing, CITI training and a DUA.

Recall is the number a reader most wants. Inventing a proxy would be the most
damaging thing this harness could do.

**And a limitation worth stating twice:** the non-English rows are
machine-translated and read formally. Real patients write Bahasa Rojak —
code-switched and colloquial. Formal translation is the *easy* case, so the
measured gap is a **lower bound** on the real one.

---

## Assumptions

1. The scarcest resource in the funnel is the person's willingness to type one
   more sentence. Every design decision spends or earns that.
2. Clinic staff will not read chat logs. Anything requiring them to is decoration
   — hence a structured history rather than a transcript.
3. Synthetic data throughout. No real PHI touched this build.
4. Over-redaction is recoverable; under-redaction is a reportable breach. The
   pipeline is biased accordingly, and accepts destroying some clinical context.

---

## What testing changed

Fifteen defects were found by running the real path rather than reading the code,
and several changed the design rather than just fixing it:

- **The checksum was gating redaction.** The brief's own `S1234567A` is not
  checksum-valid, so it passed through unredacted. Validation is now a confidence
  signal — never a reason to skip.
- **`not` matched inside "can·not·breathe"**, so a report of breathlessness read
  as a *negation* of it. Token-boundary matching now, after "o·pening hours"
  matched `pening` (Bahasa for dizzy).
- **Medium risk was returning fixed copy** and skipping the History Engine, so a
  three-day headache got the identical sentence five turns running. The brief says
  stop *advice*, not stop the conversation.
- **`test_access_control.py` passed 16/16 against an empty database** — and an
  empty table returns no rows whether RLS is enforced or absent. Passing vacuously
  is worse than failing, because it looks like evidence. The suite now refuses to
  run unseeded.

That last one is the one I would want a reviewer to look at.
