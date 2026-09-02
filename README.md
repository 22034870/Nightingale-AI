# Nightingale

A first-touch-to-care system for private clinics in Malaysia. A stranger with a
frightening symptom gets real, honest help in seconds without giving up their
name — and the moment they choose to be known, nothing they said is lost and
nothing unsafe is hidden.

**Live:** https://nightingale-ai-drab.vercel.app
**Chat:** https://nightingale-ai-drab.vercel.app/chat

Built for the Nightingale 48-hour challenge. Synthetic data only — no real
clinic, no real doctors, no real patients.

---

## The one idea

Everyone else will build a chatbot that answers questions and tries not to
diagnose. This one **asks the questions a clinician would ask**, because *asking
is not diagnosing*.

"Does the pain spread to your arm?" gathers a fact. "That suggests cardiac
ischaemia" draws a conclusion. Nightingale does the first and hard-blocks the
second, which leaves the conclusion with the clinician — exactly where the
Medical Act 1971 puts it.

That single decision pays off four ways: it is non-diagnostic by construction,
it *is* the value the guest receives, it produces an escalation payload a
clinician can actually act on, and it gives a frightened person a bounded task
rather than an open-ended interrogation.

---

## Setup

Requires Node 20+ and Python 3.10+.

```bash
npm install
cp .env.local.example .env.local     # then fill it in
npm run dev                          # http://localhost:3000
```

### Environment

| Variable | Needed for | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | everything | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | everything | Safe in the browser by design |
| `SUPABASE_SERVICE_ROLE_KEY` | persistence, seeding | **Bypasses RLS.** Server only, never committed |
| `GEMINI_API_KEY` | chat, classifier, extraction | AI Studio key |
| `CHAT_MODEL` | chat | Default `gemini-3.5-flash` |
| `CHAT_MODEL_FALLBACK` | quota resilience | Default `gemini-3.5-flash-lite` |
| `RISK_MODEL` | classifier, extraction | Default `gemini-3.5-flash-lite` |

### Database

Run [`db/schema.sql`](db/schema.sql) in the Supabase SQL editor, then seed:

```bash
python db/seed/seed.py
```

Seeding is not optional if you intend to trust the access-control tests — see
the note under Testing.

> **Known limitation.** The Gemini free tier allows **20 requests per day, per
> model**. One five-turn conversation uses 10–15. The chat path falls back to a
> smaller model on 429 rather than serving canned copy mid-sentence, but a
> sustained demo needs billing enabled.

---

## Running the tests

```bash
npm run dev                       # terminal 1
python -m pytest tests/ -v        # terminal 2
```

```bash
python -m pytest tests/ -v -m "not llm"     # skip model-dependent tests
```

The eight required micro-tests run **over HTTP against the real server**, not as
unit tests. The properties the brief asks us to prove are properties of the
deployed system: a unit test that mocks the database cannot prove Patient A is
unable to read Patient B, and a unit test of a redaction helper cannot prove
what actually leaves the process.

| File | Proves |
|---|---|
| `test_risk_escalation.py` | The four mandated phrases classify High **with the model disabled** |
| `test_redaction.py` | Names and IC numbers never reach the model; logs hold no raw values |
| `test_memory_mutation.py` | Advil active → stopped, with provenance surviving for **both** states |
| `test_escalation_payload.py` | Trigger, triage summary, profile, provenance, attribution all persist |
| `test_guest_to_patient_conversion.py` | Provenance still resolves to the original `guest_message` after conversion |
| `test_value_events.py` | Every displayed statistic traces to a live query |
| `test_access_control.py` | RLS refuses, not the application |
| `test_trust.py` | "Are you a real doctor?" gets all three required elements |

Model-dependent tests are marked `@pytest.mark.llm` and skip automatically when
quota is exhausted, so a depleted key produces honest skips rather than a wall
of misleading failures.

> **On `test_access_control.py`.** Against an empty database these assertions
> pass whether RLS is enforced or absent — which is worse than failing, because
> it looks like evidence. The suite checks the database has been seeded and
> **skips itself with an explanation** if not. Run the seed script first.

---

## Where redaction happens

**[`lib/redaction/pipeline.ts`](lib/redaction/pipeline.ts)**, called from
[`lib/chat/respond.ts`](lib/chat/respond.ts) as **step 1 of every turn**, before
the risk gate and before any model call. There is exactly one path from a
patient's words to a language model and it goes through this function.

Three properties worth knowing:

**It fails closed.** If redaction throws or exceeds its 2s deadline, the message
**never reaches the model**. The raw payload goes to `redaction_quarantine`,
encrypted, readable by one role. It is not retried and not silently dropped.

**Validation never gates redaction.** The brief's own fixture `S1234567A` is not
a checksum-valid Singapore NRIC — the correct check letter is `D`. An early
version used the checksum as a gate and the brief's example sailed through
unredacted. Checksums are now a confidence signal recorded on the span. Someone
who mistypes one digit of their IC has not consented to it being sent overseas
in the clear. **Recall over precision, always.**

**Redacted is not anonymous.** The placeholder→original map stays server-side,
and its existence is precisely why redacted text remains *personal data* under
PDPA s.4. That is why redaction alone does not satisfy s.129 and why the consent
gate exists alongside it.

---

## How RBAC is enforced

**In Postgres, not in the application.** [`db/schema.sql`](db/schema.sql) enables
Row Level Security on all 19 tables with default deny, then grants narrowly.

An application check is something a future route can forget to call. An RLS
policy is something no route can bypass, because the refusal happens inside the
database — which is why `test_access_control.py` queries PostgREST directly
rather than going through the app.

| Surface | Policy |
|---|---|
| Patient data | `patients.auth_uid = auth.uid()` on every scoped table |
| Triage queue, warm leads, funnel | `is_care_team()` — staff, nurse, clinician |
| Guest chat content | Care team **only once a `health_sharing` consent row exists** |
| Quarantined payloads | `privacy_officer` alone |
| Clinic facts, corpus, citations | Public — this is the published website |
| `audit_log` | No column exists that could hold message text |

Roles live on the JWT (`app_metadata.role`) so policies read them without a
table join per row. [`lib/db/client.ts`](lib/db/client.ts) keeps two clients: a
service client that bypasses RLS for trusted server routes, and a user client
that carries the caller's JWT so every query is filtered.

---

## Architecture

```
patient message
      │
      ▼
1. REDACT          lib/redaction/pipeline.ts   throws → quarantine, never proceeds
      ▼
2. RISK GATE       lib/risk/gate.ts            deterministic, pure, cannot time out
                   lib/risk/classifier.ts      model adds breadth
                   final = MAX(deterministic, llm) — never lowered
      ▼
3. EXTRACT         lib/history/engine.ts       runs on every path, including escalation
      ▼
4. CRISIS ─────────┐ self-harm: fixed copy, real helplines, model never invoked
5. IDENTITY ───────┤ "are you a real doctor": fixed, not probabilistic
6. HIGH ───────────┤ stop advising, offer handoff, checklist halts
      ▼            │
7. LOW / MEDIUM    │ grounded answer + the next history question, with its reason
      ▼            │
8. GUARD           │ lib/chat/guard.ts — post-generation. Retry once, then vetted copy
      ▼            ▼
   reply       escalation payload
```

**Branches 4–6 never reach a generative model.** Someone describing crushing
chest pain gets a reply assembled from vetted copy. The model is trusted only
with low-risk conversation, and even then its output is checked before a patient
sees it.

### Why the deterministic layer runs first

An LLM classifier catches red flags roughly 99% of the time. For "crushing chest
pain" the missing 1% is a person. So a layer with 100% recall on the mandated
phrases goes in front, and the model adds breadth on top — never subtracts.

The layering earns its place in both directions. Live testing showed *"I've been
feeling more and more hopeless lately and don't see the point"* scoring **low**
deterministically (no lexicon phrase matched) and **high** from the model, which
read it correctly as psychiatric. `MAX()` took high. That gap is now closed in
the lexicon too, because an outage would have held it at low.

---

## Configuration is data, not prose

| File | Contains |
|---|---|
| [`config/red_flags.yaml`](config/red_flags.yaml) | 16 rules, 146 phrase variants across English, Bahasa Malaysia and Manglish |
| [`config/copy_rules.yaml`](config/copy_rules.yaml) | Banned/approved phrases, crisis protocol, consent text, retention schedule |
| [`config/history_checklists.yaml`](config/history_checklists.yaml) | Five clinical frames; every field carries the *why* the assistant states |
| [`config/channel_rules.yaml`](config/channel_rules.yaml) | Channel × identity × time openings, plus the ethics matrix inline |

A prompt is a *request*. A post-generation check against this data is
*enforcement*. The brief asks us to demonstrate the non-diagnostic constraint,
not to assert it — so `lib/chat/guard.ts` reads these files and can refuse.

The pytest suite reads the same YAML the app does, so a test cannot silently
drift from the behaviour it claims to verify.

---

## Try it

```
/chat?channel=staff_referral&staff=Dr%20Lim&note=asked%20about%20egg%20freezing
/chat?channel=instagram_ad_click&campaign=ivf_over40
/chat?channel=website_widget&topic=cardiac%20screening
```

Same page, three different openings — resolved server-side from config. Then
type *"I have crushing chest pain"* into any of them and watch the profile fill,
the checklist pause, and the handoff appear.

| Endpoint | Purpose |
|---|---|
| `POST /api/chat` | A turn: redact → risk → extract → reply |
| `POST /api/escalate` | Send to Clinic with the full payload |
| `POST /api/arrival` | Create a LeadSession with attribution |
| `POST /api/staff/referral` | Generate a context-preloaded link |
| `GET \| POST /api/convert` | Consent notice, then guest → patient |
| `GET /api/metrics` | Per-channel funnel and drop-off |
| `GET /api/warm-leads` | Ranked leads with the compassion override |
| `POST /api/risk`, `/api/redact` | Test surfaces — **404 in production** |

---

## What is not built

Stated plainly, because an unfinished feature scores worse than an absent one
you justified. Full reasoning in [PLANNING.md](PLANNING.md) §3c.

- **WhatsApp Business API** — verification is reported at 1–2 months. Telegram
  ships instead: no approvals, and the platform itself enforces user-initiation,
  which is a *better* consent story.
- **Real Meta webhook** — App Review is off the critical path for a demo
  (Development Mode works with role-holding accounts), but was not reached.
- **Clinician response UI** — the brief asks for the *schema* to support it;
  `escalations.status` and `clinician_responses` are ready, no migration needed.
- **ML/NER redaction layer** — a model I cannot evaluate in 48 hours is a false
  sense of safety. The time went to the quarantine queue instead.
- **Multilingual generation** — we *understand* Bahasa and Manglish input; we
  answer in English and say so. Shipping unverified medical phrasing in a
  language I cannot QA would be worse than the limitation.

---

## Documents

- [PLANNING.md](PLANNING.md) — decisions, cuts, and where I disagree with the brief
- [docs/TECHNICAL_BRIEF.md](docs/TECHNICAL_BRIEF.md) — architecture, schema, ethics matrix
- [docs/system-brief.html](docs/system-brief.html) — illustrated overview: request lifecycle, the roles of Supabase and Vercel, and where the machine-learning methodology was applied. Open it in a browser
- [research/FINDINGS.md](research/FINDINGS.md) — research digest and its corrections
- [ATTRIBUTION.txt](ATTRIBUTION.txt) — libraries, models, licences
