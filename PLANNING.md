# Nightingale 48H Build — Planning Document

**Author:** Jason Ong
**Started:** 2026-09-01, 14:00 MYT
**Due:** 2026-09-03, 13:00 MYT

---

> **How to read this file.** Sections 1 and 2 are Jason's. Everything from §3 down was drafted
> by Claude from the research in `research/FINDINGS.md` and from the idea in §1(e), which
> reshaped the whole build. Anything marked **⟨decide⟩** is a real choice where I picked a
> defensible default — override any of them and I'll rebuild around it. Anything marked
> **⟨verify⟩** needs one more check before it goes in a submitted document.
>
> Delete this block and the "How to use this template" guidance before you submit.

---

## 1. Thesis — one sentence

**The one thing this build proves:**

`A patient who is unwell decides to look up the internet based on their symptoms and they can get credible and reliable advice that seemingly acts like a doctor is communicating with them but does not cross legal lines of providing diagnosis.`

**✅ DECIDED — this is the version the build implements:**

> **"Someone frightened by what they found on Google gets the quality of questioning a doctor
> would give them — and none of the conclusions only a doctor may draw."**

**A doctor's rigour, not a doctor's identity.** The original wording — *"seemingly acts like a
doctor"* — had one word doing dangerous work. Legally, "holding out" as a practitioner is the
live risk under the Medical Act 1971. Empirically, Zhu & Broadbent 2025 (N=160, randomised)
found a human-like agent produced *less* honest disclosure than a plain text interface: the
mechanism people respond to is perceived anonymity, not human-likeness, and a convincing
persona reintroduces the observer they were relieved to escape.

What §1(e) actually describes is not impersonation. It is rigour. Same ambition, legally clean,
and it is what the rest of this plan is built to deliver.

**The bet I am making that other candidates probably will not:**

`(a) the funnel refinement you flagged — earning trust before the ask;
 (b) treating the risk gate as deterministic-first rather than LLM-first;
 (c) making every displayed number resolve to a live query;
 (d) the analytics layer as a first-class product surface, not a bonus.
 (e) ask for additional confirmation questions basically reverse prompting that acts like what a doctor would require to make a diagnosis for better and more accurate information that the patient themselves may not even realize`

> **(e) is the differentiator.** It is the only item here that no other candidate will have
> thought of, and it resolves the central tension of the whole brief. Everyone else will build
> a chatbot that answers questions and tries not to diagnose. You are building one that **asks
> the questions a clinician would ask** — and asking is not diagnosing.
>
> It pays off four ways at once:
> - **Non-diagnostic by construction.** Gathering a history is not drawing a conclusion.
> - **It is the value event.** The patient learns which details actually matter — most people
>   don't know that "when did it start" and "what makes it worse" are the questions.
> - **It makes the escalation payload genuinely good.** The brief demands "the record must let
>   a clinician begin a structured review without the patient repeating their story." Nobody
>   else will hit that properly, because they'll hand over an unstructured chat log.
> - **It gives the patient a reason to keep typing.** See §5, VE_02.
>
> This is now the spine of the build. It has a name: **the History Engine** (§6f).

---

## 2. Who is on the other end

**Primary user (guest / prospect):**

`A 30 year old scrolling on Instagram or any Social Media and saw an advertisement stating that so and so symptoms could be potential risks of heart attack but this person only has access to google to check for further information which often is not cleared by professionals but just some online information which may or may not be true.`

**What they are actually afraid of, in order:**

1. `being told it is serious`
2. `being sold to`
3. `someone they know finding out`
4. `wasting money on a consult they do not need`

> Note the ordering, because it dictates the funnel. Fear #1 means the system must never
> *withhold* — a person who suspects you are softening bad news stops trusting you. Fear #2
> means no upsell language anywhere pre-consent. Fear #3 is why the Family Kit (§5, VE_04) is
> opt-in and unbranded. Fear #4 is why "is this worth seeing someone about?" must get an honest
> answer, including *"probably not urgent, here's what to watch for"* — a system that escalates
> everything is a system that costs people money for nothing, and they will learn that fast.

**Secondary user (clinic staff / nurse / clinician):**

`A triage nurse opening a queue at 8am with ~40 overnight leads and 20 minutes before clinic
opens. They do not read chat logs. They need: who is actually unwell, what is the one-line
story, and what did the patient already tell us so I don't ask again. Their failure mode is a
real emergency sitting at position 31 behind thirty price enquiries. So the queue must sort by
clinical concern first and commercial value never — and it must be obvious at a glance which
is which.`

**Cultural / regional constraints I am designing for (SEA, Malaysia-first):**

`- Language: people describe symptoms in Bahasa Rojak — "sesak nafas", "dada sakit", "pening
  gila", "masuk angin". An English-only red-flag matcher misses emergencies outright. The
  lexicon in config/red_flags.yaml carries BM and Manglish variants for every red flag.
- Stigma, not cost, is the primary driver of delayed care (NHMS; mental illness culturally
  misattributed to spiritual weakness or weak faith). So the tone must never imply the person
  waited too long.
- Health decisions are family decisions, not individual ones. A spouse, parent or adult child
  is often the real decision-maker — hence the Family Communication Kit, and hence third-party
  questions ("my mother has chest pain") are treated as first-class, never downgraded.
- Traditional medicine is frequently tried first. Capture it neutrally, never with judgement.
- WhatsApp is the default expectation for clinic contact. We ship Telegram (§8) because it is
  the only rich chat channel with no approval gate, and the adapter makes WhatsApp a config swap.`

---

## 3. Scope — build / cut / refuse

### 3a. Must ship (the vertical slice is broken without these)

| # | Capability | Rubric line it earns | Done when |
|---|-----------|---------------------|-----------|
| 1 | Guest chat: redaction → deterministic risk gate → LLM → grounded reply w/ citations | Security 3 · Intake 3 | A stranger can ask a real question and get a cited answer, no account |
| 2 | **The History Engine** — structured, one-at-a-time clinical follow-up questions w/ visible completeness meter | Creativity 6 · Memory 6 | Chest-pain scenario produces a 7-field history the patient never had to be asked twice |
| 3 | Living profile: fact extraction + mutation with unbroken provenance | Memory 6 | `test_memory_mutation.py` green |
| 4 | Auth + consent + guest→patient migration, provenance and attribution intact | Acquisition 6 · Security 3 | `test_guest_to_patient_conversion.py` green |
| 5 | Escalation payload persisted: trigger msg, triage summary, profile snapshot, provenance, acquisition context | Creativity 6 | `test_escalation_payload.py` green |
| 6 | 4 channel contracts: `staff_referral`, `social_comment`, `website_widget`, `lead_form` + **live Telegram bot** | Acquisition 6 · Bonus 10 | Same message, two channels, two openings — demoable |
| 7 | Declarative channel rules config (one file, no scattered ifs) | Acquisition 6 · Architecture 4 | `config/channel_rules.yaml` drives all openings |
| 8 | Funnel events + per-channel conversion + warm-lead view with risk override | Acquisition 6 · **your DA edge** | Every displayed number resolves to a live query |
| 9 | The 8 required micro-tests + run instructions | Communication 2 | `pytest` green from a clean clone |
| 10 | README + Technical Brief + ATTRIBUTION.txt + ≤3min demo video | Communication 2 | Submitted |

### 3b. Ship if time allows (in priority order)

1. **Real Instagram comment→DM in Meta Development Mode** — judges added as Testers so they can
   trigger it themselves. Worth up to 10 bonus points; genuinely reachable now that App Review
   is off the critical path (`report-E` §2). Promote to 3a if the scaffold lands early.
2. Session recovery — abandoned guest returns via link within 7 days, context intact.
3. Conflict flagging when extracted facts contradict each other.
4. Dormant-lead lifecycle (active → cooling → dormant → one consented recall → suppressed).
5. Intent-based channel rules on top of channel × identity × time.

### 3c. **[CUT]** — and the honest reason

| Cut | Why | What I did with the time instead |
|-----|-----|----------------------------------|
| WhatsApp Business API | Business Verification is reported at 1–2 months in 2026. Not reachable in 48h at any level of effort. | Built the channel adapter so WhatsApp is a config entry, and shipped **Telegram** live instead — the platform itself enforces user-initiation, which is a *better* consent story than WhatsApp's opt-in |
| TikTok comment webhook | Business Messaging is enterprise-whitelist only; no self-serve path exists | Simulated the exact payload shape; the handler is real and switching it on is a credentials change |
| Meta App Review (public rollout) | No published SLA; third-party reports ~20 days | Demoed the identical code path in Development Mode with real accounts. The integration is real; only its audience is limited |
| ML/NER layer in the redaction pipeline | Deterministic regex + gazetteer covers the structured identifiers that actually leak. An NER model I cannot evaluate in 48h is a false sense of safety | Spent it on the **quarantine queue** (§11) so redaction failure has a defined, auditable destination |
| Full clinician response UI | Out of scope — the brief asks for the *schema* to support it | Designed `escalations.status` + `clinician_responses` so the module attaches later without migration |
| Multilingual generation (BM/Mandarin replies) | Cannot QA safety copy in languages I can't verify under time pressure. Unsafe to ship half-checked medical phrasing | Multilingual **detection** in the red-flag lexicon — we *understand* BM/Manglish input, we just answer in English and say so |

### 3d. Refuse — things I will not build even with time

| Refused | Which axis fails |
|---------|------------------|
| Scraping competitor Google reviews to find dissatisfied patients | **Platform policy · PDPA · trust** — breaches Google ToS, and contacting scraped leads is unlawful direct marketing |
| Monitoring public health groups/threads and DMing symptom posters | **Platform policy · PDPA · trust** — Meta bans it, and it is the single creepiest thing in the brief's list |
| Ad retargeting on inferred health condition | **Platform policy · PDPA** — Meta bans health-condition custom audiences; Google bars remarketing on inferred health |
| Auto-DMing everyone who *likes* a health post | **Technical · platform · trust** — Meta provides no like→DM path, and a like is not an enquiry |
| Auto-DMing a commenter on a stigmatised-condition post with clinical content | **Trust** — a DM notification on a stranger's lock screen can out them. See §4e for what we do instead |
| Unsolicited outbound of any kind | **Legal** — MMC classes touting/canvassing for patients as unethical, and its "Social Media" definition explicitly names WhatsApp and Telegram |

---

## 4. The refined funnel

### 4a. The brief's funnel

```
Click → LeadSession → Trust Transition → Auth + Consent → Intake Chat → Send to Clinician
```

### 4b. My refined funnel

> Built from the 10 ranked trust-breaking moments in `report-C&D` §3.3, each mapped to a
> counter-measure that exists in code.

| # | Moment | What they feel | What the system GIVES here | What breaks trust here | My counter-measure |
|---|--------|---------------|---------------------------|----------------------|-------------------|
| 1 | **Arrival** | Scared, half-convinced by Google, expecting a sales bot | An opening that already knows why they came (campaign/staff note/page topic) and asks nothing | A form. A "Hi! 👋 How can I help you today?" | Channel-rules config picks the opener; no field, no account, cursor already in the box |
| 2 | **First reply** | Testing whether this thing is real | A grounded, cited answer in under 3s — or an honest "I don't know that" | Latency, or a confident wrong answer | p95 < 3s budget; answers cite real spans in the clinic corpus; out-of-corpus → say so |
| 3 | **The turn** | "Maybe this is actually useful" | **The History Engine starts.** One question at a time, each with a stated reason: *"When did it start? The clinician will ask this first."* | Five questions in one bubble; questions with no visible purpose | One `?` per message, enforced post-generation; every question carries its "why" |
| 4 | **Progress** | Invested, wants to finish | Visible completeness: *"Your handoff is 4 of 7 complete."* | Open-ended interrogation with no end in sight | Bounded checklist per complaint. Galesic & Bosnjak 2009: stated length drives drop-off — so state it |
| 5 | **The ask** | Willing, but wary of spam | *"I've got enough for the clinical team. Want me to send it?"* — the thing they get is the thing they already built | Asking for identity before value. 18% of abandoners cite forced account creation (Baymard) | Auth is **triggered by a completed value_event**, never by page-landing |
| 6 | **Consent** | Cautious about who reads this | Named clinic, named purpose, plain 98 words, marketing unticked and separate | Bundled consent; legalese; a pre-ticked box | PDPA s.40 unbundled consent; two separate records, two timestamps |
| 7 | **Handoff** | Anxious about being dropped | A real receipt: what was sent, who sees it, when to expect a reply — computed from clinic hours, not promised | "A doctor will get back to you shortly" at 2am | Dynamic SLA from server time + clinic hours. Chat continues after send |

### 4c. The trust transition

> The brief's line — *"Continue securely to send this to the clinic"* — centres the clinic's
> need. The person does not care about the clinic's inbox.

**My line:** **"Send this to a nurse — you won't have to explain it again."**

**Why it is better, in one sentence:** it names the thing they actually dread (retelling a
frightening story to a stranger from the beginning) and promises its removal, which is a benefit
to *them*; and unlike the original it is a promise the architecture can actually keep, because
the profile, provenance and history all migrate intact.

**What triggers it (never on page-landing):**
`Fires when EITHER (a) a value_event is logged AND the History Engine is ≥60% complete,
OR (b) risk_level is Medium/High — in which case it fires immediately and outranks everything
else on screen, including any value event in flight.`

### 4d. The empathy / inclusivity rule

> Enforced in `config/copy_rules.yaml`, checked post-generation, not merely requested in a prompt.

**Rules the assistant must follow in every message:**

- Never open with a question. Acknowledge, then ask.
- Exactly one question mark per message. Enforced by regeneration.
- Every question states why it is being asked. This is what turns intake into the value event.
- Modulate empathy by severity. No emotional validation on administrative turns — scripted
  sympathy on "what are your opening hours" is the 3rd-ranked trust breaker.
- Never assume gender, marital status, religion, ability to pay, or that the person is asking
  for themselves.
- If the person expresses fear or shame, acknowledge it before delivering information.
- **Be visibly a machine.** No avatar, no performed feeling, no simulated typing personality.
  Warm, plain, and obviously a system that routes to humans. (Zhu & Broadbent 2025 — a
  human-like agent produced *less* honest disclosure than plain text.)
- Never imply they waited too long. In this region delay is usually stigma, not negligence.

**Normalisation — ✅ DECIDED (`normalisation.mode = live_stat`):**
The requirement — make a person with a stigmatised concern feel less isolated — is sound and
well evidenced. The obvious phrasing is not: `report-C&D` §3.4 names *"you are not alone"* as an
anti-pattern that reads as scripted and minimising. So the payload is delivered three other ways,
all of which are true and checkable:

1. **A real live statistic** — *"9 other people asked this clinic about fertility this week."*
   Same emotional payload, but it resolves to a query and renders nothing below a floor of 5.
2. **The approved line** — *"It takes courage to reach out about this. You've taken the right
   first step."* Rated Safe and specifically effective for stigmatised presentations.
3. **The Family Communication Kit** (VE_04) — which *materially* reduces isolation rather than
   asserting it away, and lands hard in a region where health decisions are family decisions.

The phrase itself is on the banned list. This is a defensible paragraph in the Technical Brief:
*we were asked to make the patient feel less alone; the literature says the phrase that does
this fails; so we did it with data and a shareable artefact instead.*

**Banned phrases (hard list in code):** `"don't worry" · "it's probably nothing" · "everything
will be okay" · "you have" · "you likely have" · "this sounds like <condition>" · "you should
stop taking" · "commit suicide" · "guaranteed results" · "best clinic" · "you are not alone"`
— full list with reasons in `config/copy_rules.yaml`.

### 4e. The stigma rule for social_comment

> This is one of the places the brief invites you to challenge it, and it is worth doing.

If someone comments on a post about a stigmatised topic (mental health, sexual health,
fertility, HIV/STI), an automated DM containing clinical content can **out them** — a
notification preview on a shared or unlocked phone is enough. So:

`For topics flagged sensitive in channel_rules.yaml, the automated private reply contains NO
clinical content. It is a neutral door: "Thanks for reaching out — here's a private link if
you'd like to talk." The clinical conversation happens only after they open the link, on our
surface, where nothing appears on a lock screen.`

---

## 5. Value events

**Definition I am using:** `a value_event is a logged turn in which the system delivered
something the guest could not have got by continuing to scroll — a cited factual answer, a
completed history artefact, a real statistic, or a shareable object. It is logged only on
successful delivery, never on intent, and every one carries the message_id that produced it so
the count in §8 is auditable.`

| ID | Value event | What the guest gets | How it is logged | Shows a number? |
|----|------------|--------------------|--------------------|------------------|
| `VE_01` | **Grounded answer** | A question about services/hours/price/prep answered with a citation resolving to a real span in the clinic corpus | On successful response with ≥1 resolved `citation_id` | No |
| `VE_02` | **History complete** | Their concern turned into a structured clinical history they can see, keep, and hand over | When History Engine completeness ≥ 60% | Yes — the completeness meter, computed from filled fields |
| `VE_03` | **Questions to ask the doctor** | 6 questions *derived from their own session*, not a generic PDF — the ones people forget and later regret | On generation, with the source memory_items recorded | No |
| `VE_04` | **Family Communication Kit** | An unbranded 240-char note they can forward to a spouse or parent, explaining the concern in neutral terms | On generation + on share action | No |
| `VE_05` | **Honest live statistic** | *"9 other people asked this clinic about fertility this week."* | On render, with the query result cached to the event row | **Yes — and this is the one that must never lie** |

**The honest-number rule:**
`Every number rendered anywhere in the product goes through ONE component, <LiveStat>, which
takes a query result and a floor. If count < 5 it renders nothing — not a rounded number, not
"a few", nothing. The component cannot be passed a literal. test_value_events.py walks the
rendered output and fails if any displayed integer has no corresponding query in the event log.`

> ⟨verify⟩ This is your Data Analyst edge made concrete. Most candidates will hardcode "14
> people asked this week." The brief explicitly calls that out as gimmicky. A test that
> *cannot pass* if a number is fake is a much stronger claim than a paragraph saying you
> care about honest numbers.

---

## 6. Safety architecture

### 6a. The core design decision

**The LLM is never the only thing standing between a red-flag phrase and an escalation.**

Layer order for every inbound patient message:

1. **Redaction first, always.** Deterministic regex + gazetteer. If it throws or exceeds its
   timeout, the message never reaches the LLM — it goes to quarantine (§11).
2. **Deterministic lexical match** against `config/red_flags.yaml`, including BM/Manglish
   variants. On hit: `risk = HIGH`, short-circuit, the LLM is never asked for clinical advice.
3. **LLM classifier** (fast model) returns `risk_level`, `risk_reason`, `confidence`.
4. **Merge:** `final_risk = MAX(deterministic, llm)`. **Never downgraded.** Context guards
   (negation, third-party, historical) lower *confidence* and annotate the reason — they have a
   hard floor and can never suppress a match.
5. **On LLM timeout/error:** fail **closed** to Medium, show honest-uncertainty copy, offer Send
   to Clinic. Never fail open to Low.

**Why this ordering:** an LLM classifier catches red flags roughly 99% of the time, and for
"crushing chest pain" the missing 1% is a person, so the only acceptable design puts a
deterministic layer with 100% recall on the mandated phrases in front of it and lets the model
add breadth on top — never subtract.

### 6b. Non-diagnostic enforcement

| Rule | How it is enforced |
|------|-------------------|
| No diagnoses | System prompt + **post-generation** regex against `banned.diagnostic_language` with an exemption list for benign uses ("you have an appointment") → block and regenerate; second failure falls back to approved boundary copy |
| No medication changes | Post-generation match on `banned.medication_advice` → block, regenerate, then fall back |
| No treatment plans | Response schema requires `advice_type ∈ {general_info, clinic_fact, question, escalation}`; anything else is rejected before render |
| No false reassurance on high-risk | `banned.false_reassurance` is checked unconditionally, and when `risk ≥ medium` the reassurance check runs *before* the model output is streamed to the client at all |
| No MAB-restricted claims | `banned.mab_restricted_claims` — superlatives, guarantees, cures. Applies in private DMs too (`report-E` §3) |

> The point is that a prompt is a request and a post-generation check is enforcement. The brief
> asks you to *demonstrate* the constraint. Show the check failing in the demo.

### 6c. Risk record

Every message stores: `risk_level`, `risk_reason`, `confidence`, `risk_provenance` (timestamp),
plus `deciding_layer` (deterministic | llm | merged), `matched_rule_id`, `model_id`,
`model_version`, `classifier_latency_ms`, `guards_applied[]`.

### 6d. The ambiguity doctrine

**My rule:** `Named red-flag phrases — including all four the brief mandates — resolve to HIGH,
which fires the emergency-services banner. Genuinely non-localising vagueness ("my chest feels
funny", "something's not right", "I just feel off") resolves to MEDIUM via the AMBIGUOUS tier.
MEDIUM already stops advice and triggers Send to Clinic under the brief's own rules, so the
person is still escalated — they are just not told to dial 999.`

**Why MEDIUM and not HIGH for "my chest feels funny":** an earlier draft of this section sent
every chest mention straight to HIGH. Testing the lexicon showed why that is wrong. HIGH fires
the emergency banner, and telling someone whose chest "feels funny" to exit and dial 999 is both
clinically disproportionate and actively harmful to the banner itself — **a warning that fires
on everything is a warning people learn to scroll past.** The banner has to stay expensive to
stay useful. MEDIUM does everything the brief asks of the ambiguous case (stop advice, express
uncertainty, offer the handoff) while keeping 999 reserved for what actually warrants it.

**The exact copy shown:**
> "I'm not able to tell from what you've described whether this is something that needs
> attention today, and I don't want to guess about it. Let me get this in front of someone who
> can — it takes about a minute."

### 6e. Always-visible emergency line

Below the composer, persistent, never scrolled away:

> **"If this is an emergency, exit Nightingale and dial 999 for Emergency Services."**

Localised by clinic country (999 MY · 995 SG · 112 ID · 1669 TH · 911 PH). One config lookup,
and it matters for a product targeting SEA.

### 6f. The History Engine — §1(e) made concrete

> **This is the differentiator. It is what makes the escalation payload good, and it is why the
> patient keeps typing.**

**What it is:** per presenting complaint, a bounded checklist of the fields a clinician would
need. For pain, the standard clinical frame (site, onset, character, radiation, timing,
exacerbating/relieving factors, severity). The AI works down it one question at a time, each
question stating why it matters. It **never concludes** — it only collects.

**Why it is not diagnosis:** asking "does it spread to your arm?" gathers a fact. Saying "that
suggests cardiac ischaemia" draws a conclusion. We do the first and hard-block the second. The
clinician draws the conclusion, which is exactly where the law puts it.

**What the patient sees:** a completeness meter — *"Your handoff is 4 of 7 complete."* This
turns intake from interrogation into progress toward something they want, and it is the honest
answer to the drop-off evidence: people abandon open-ended questioning, but they finish bounded
tasks.

**What the clinician gets:** a structured history instead of a chat transcript. This is what
satisfies *"the record must let a clinician begin a structured review without the patient
repeating their story."*

**Interaction with the risk gate:** the History Engine **stops immediately** on HIGH. It is not
more important than escalation. A person with crushing chest pain does not get asked seven
questions — they get the emergency line and the handoff, and any partial history goes with them.

**⟨verify⟩** Checklists must be reviewed against the red-flag lexicon so no History Engine
question ever reads as reassurance. Do this at the Sep 3 07:00 freeze.

---

## 7. Data model

| Table | Purpose | Key fields | Links to |
|-------|---------|-----------|----------|
| `clinics` | Tenant root | `id`, `name`, `country`, `hours_json`, `dpo_email`, `emergency_number` | — |
| `clinic_documents` | Grounding corpus (§10) | `id`, `clinic_id`, `title`, `source_url`, `raw_text`, `ingested_at` | clinics |
| `document_chunks` | Citable spans | `id`, `document_id`, `char_start`, `char_end`, `text`, `embedding` | clinic_documents |
| `lead_sessions` | Anonymous arrival + attribution | `id`, `clinic_id`, `source_channel`, `campaign_id`, `creative`, `identity_level`, `landing_ts`, `staff_referral_note`, `page_topic`, `social_handle`, `expires_at` | clinics |
| `guest_messages` | Pre-auth turns | `id`, `lead_session_id`, `role`, `text_redacted`, `redaction_map_id`, `risk_*`, `created_at` | lead_sessions |
| `patients` | **Immutable identity** | `id` (PK, never changes), `clinic_id`, `created_at` | clinics |
| `patient_contacts` | Changeable contact points | `id`, `patient_id`, `type` (email/phone/instagram/telegram), `value_encrypted`, `is_login_identifier`, `verified_at`, `superseded_by` | patients |
| `patient_sessions` | Post-auth thread | `id`, `patient_id`, `origin_lead_session_id`, `created_at` | patients, lead_sessions |
| `messages` | Unified turns | `id`, `patient_session_id`, `role`, `text_redacted`, `risk_*`, `deciding_layer`, `model_id`, **`audio_asset_id`**, **`transcript_source`**, **`asr_confidence`**, **`audio_duration_ms`**, **`language_detected`** | patient_sessions |
| `memory_items` | **Living profile** | `id`, `patient_id`, `kind` (complaint/symptom/med/allergy/history_field), `value`, `status` (active/stopped/corrected/superseded), `provenance_pointer`, `superseded_by`, `updated_at` | patients, messages ∪ guest_messages |
| `history_checklists` | The History Engine | `id`, `patient_session_id`, `complaint_type`, `fields_json`, `completeness_pct` | patient_sessions |
| `citations` | Grounding proof | `id`, `message_id`, `chunk_id`, `char_start`, `char_end` | messages, document_chunks |
| `escalations` | Send to Clinic | `id`, `patient_id`, `trigger_message_id`, `triage_summary`, `profile_snapshot_json`, `acquisition_context_json`, `status` (sent/acknowledged/in_review/responded/closed), `sla_due_at`, `created_at` | patients, messages |
| `clinician_responses` | **Reserved for the module that attaches later** | `id`, `escalation_id`, `clinician_id`, `body`, `created_at` | escalations |
| `funnel_events` | The event stream | `id`, `lead_session_id`, `patient_id`, `event_type`, `value_event_id`, `metadata_json`, `created_at` | both sessions |
| `consents` | Unbundled, timestamped | `id`, `patient_id`, `type` (health_sharing/marketing/overseas_processing), `granted_at`, `revoked_at`, `notice_version`, `scope_json` | patients |
| `redaction_quarantine` | Fail-closed destination | `id`, `raw_payload_encrypted`, `failure_reason`, `reviewed_by`, `reviewed_at` | — |
| `channel_outbound` | Telegram/IG sends | `id`, `channel`, `external_comment_id` **UNIQUE**, `comment_created_time`, `sent_at`, `ttl_expires_at` | lead_sessions |
| `audit_log` | **PHI-free by construction** | `id`, `actor_id`, `actor_role`, `action`, `resource_type`, `resource_id`, `content_hash`, `created_at` | — |

**Voice-readiness:** the bolded fields on `messages` exist now and are unused. An audio turn
becomes a `messages` row with `transcript_source='asr'`, an `audio_asset_id`, and a confidence
score that the risk gate can threshold on — low ASR confidence on a red-flag phrase should
escalate, not resolve. No schema change required.

**The provenance chain, in one sentence:**
`Every memory_item points at the message that created it; a fact learned before signup points at
a guest_message, which points at a lead_session, which carries campaign_id and creative — so any
line on a clinician's screen resolves in three hops back to the Instagram ad it started from,
and test_guest_to_patient_conversion.py asserts exactly that walk.`

---

## 8. Channel rules

**Format:** `config/channel_rules.yaml` — one file, keyed `channel × identity_level × time_of_day`.

| Channel | Identity level | Mandatory? | Simulated or real? | Opening strategy |
|---------|---------------|-----------|--------------------|------------------|
| `staff_referral` | named-by-staff | ✅ | **Real** — staff types a topic, link generated | Opens *knowing the topic*: "Dr Lim mentioned you asked about egg freezing today." Asks nothing already known |
| `social_comment` (IG/TT/FB) | handle-only | ✅ | **Real (Telegram)** + IG in dev mode if 3b lands | Neutral door. No clinical content in the DM if the topic is sensitive (§4e) |
| `website_widget` | anonymous | — | Real | Uses `page_topic` — a person on the IVF page is not greeted like a person on the paediatrics page |
| `lead_form` | identified (email volunteered) | — | Real | **Never re-asks for the email.** Opens with what the email unlocked |
| `telegram_bot` | telegram handle | — | **Real, live in the demo** | User must press Start — the platform enforces initiation |
| `instagram_ad_click` | anonymous + campaign | — | Simulated payload, real handler | Campaign-aware: `ivf_over40` opens differently from `general_screening` |

**Observable minimum to demo:** the same sentence — *"I've been having chest pain"* — entered
via `staff_referral` and via `instagram_ad_click` produces two different openings and two
different consent prompts, while producing the *identical* risk classification. That last part
matters: channel changes tone, never safety.

**Time-of-day rule:** `After 22:00 local, every opening leads with the emergency line before
anything else, and the response-expectation copy switches from a computed same-day SLA to
"first thing tomorrow" — because a promise made at 2am that the clinic cannot keep is the
8th-ranked trust breaker.`

---

## 9. Architecture & stack

| Layer | Choice | Why | Fallback |
|-------|--------|-----|----------|
| App | **Next.js 15 + TypeScript**, App Router, single deployable | PWA is a manifest + service worker; one repo, one deploy | — |
| DB | **Supabase Postgres** | Gives auth + RLS + Postgres in one service | Local Postgres + Docker |
| Auth | **Supabase Auth** (email OTP) | Verified email as login identifier, free | — |
| Access control | **RLS policies, server-side, plus route middleware** | The brief wants access control *demonstrated*. A policy file is the most convincing possible artefact | — |
| LLM (chat) | **Claude Sonnet 5** via Bedrock `ap-southeast-1` | Quality for the conversation. **Singapore region is a legal decision, not a latency one** (`report-E` §6) | Direct Anthropic API, documented as a compliance regression |
| LLM (risk classify) | **Claude Haiku 4.5** | Runs on every message; needs to be fast and cheap | Deterministic layer alone still holds the floor |
| Channel | **Telegram Bot API** | Zero approvals, live in the demo, platform-enforced user-initiation | — |
| Tests | **pytest** against the HTTP API | Matches the brief's `test_*.py` filenames, plays to your strengths, and API-level tests are *stronger* evidence for RBAC than unit tests | — |
| Hosting | **Vercel** | One target | — |

**✅ DECIDED. Why not Python end-to-end**, given Jason is a Python person: Supabase's RLS + Auth
saves ~4 hours that do not exist in this schedule, and the PWA requirement is near-free in
Next.js. The tests stay in **pytest**, which is where the debugging instincts live — and
API-level tests are stronger evidence for server-side RBAC than unit tests would be, because
they exercise the real policy boundary rather than a mock of it.

**The rule this locks in:** the stack is not revisited. If something fights us, we work around
it and write the workaround into §3c as a cut. Re-platforming at hour 20 is not survivable.

**Deploy early rule:** hello-world live on a public URL **before any feature work**. `[ ☐ ]`

---

## 10. Grounding — "websites read by agents"

**General grounding corpus:** a synthetic clinic website (services, hours, doctors, pricing,
prep instructions, FAQs) ingested into `clinic_documents` → `document_chunks` with **character
offsets preserved**, so a citation resolves to a real span rather than a plausible-looking URL.
The bonus test — "citations resolve to real spans" — passes by construction, not by luck.

**Personalisation grounding:** `lead_session` attribution (campaign, creative, page topic),
the `staff_referral_note`, prior guest messages, and extracted `memory_items`.

**When the answer is not in the corpus:**
> "I don't have that in what the clinic has published, and I'd rather not guess at it. I can
> ask them directly for you — or if you'd like, I can tell you what I *do* have on {topic}."

The LLM is never permitted to free-associate a clinic fact. Out-of-corpus → say so. This is
also the honest answer that earns trust per the research on stated uncertainty.

---

## 11. Failure modes, fallbacks, timeouts

> Design rule: **every failure fails toward safety and honesty, never toward silence.**

| What fails | Detection | Fallback | What the user sees | Logged |
|-----------|-----------|----------|--------------------|--------|
| LLM timeout (>10s) | Request deadline | Fail **closed** to `risk=medium`; serve approved honest-uncertainty copy; offer Send to Clinic | Honest message + handoff button | `event=llm_timeout`, latency, no content |
| LLM malformed JSON | Schema validation | One retry with a repair prompt, then approved fallback copy | Never sees it | `event=llm_schema_fail`, attempt count |
| **Redaction throws or times out** | try/catch + 2s deadline | **Message never reaches the LLM.** Raw payload → `redaction_quarantine`, encrypted, privacy-officer role only | "I couldn't process that safely — could you resend it?" | `event=redaction_fail`, quarantine_id only |
| Redaction low confidence | Confidence < threshold | Over-redact and proceed. Precision is expendable; recall is not | Slightly over-redacted text | `event=redaction_lowconf` |
| Auth provider down | Health check | Guest chat **continues working**; the trust transition defers with an honest reason | "Sign-in is having trouble — we can keep going and I'll save this" | `event=auth_unavailable` |
| DB write fails after LLM reply | Transaction boundary | Reply is not shown unless persisted. No orphan advice | Retry indicator | `event=persist_fail` |
| Guest rate limit hit | Per-session + per-IP counter | Soft throttle, then a truthful cooldown message | Honest cooldown, not a fake error | `event=rate_limited` |
| Escalation send fails | Queue ack | Retry w/ backoff; on final failure surface it — **never a false confirmation** | "This hasn't sent yet. I'm retrying." | `event=escalation_retry` |
| Deterministic and LLM disagree | Merge step | `MAX()` wins; disagreement flagged for review | Nothing | `event=risk_disagreement`, both values |
| Telegram API down | Send failure | Queue with TTL; portal link still works | Nothing | `event=channel_down` |

**Global timeouts:** chat **10s** hard · risk classify **3s** · redaction **2s** ·
latency budget p50 <1s, p95 <3s. **No artificial delay** — Gnewuch 2022 shows padding backfires
on experienced users.

**Global principle:** `The system may be slow, wrong, or unavailable — it may never be
silently unsafe, and it may never claim something happened that did not.`

---

## 12. Privacy, consent, retention

| Data class | Encrypted? | Visible to staff? | Retention | Justification |
|-----------|-----------|-------------------|-----------|---------------|
| Anonymous session metadata | In transit + at rest | Aggregate only | **30 days** | Abandonment analytics. PHI-free by construction, which is what justifies keeping it |
| Guest chat content | At rest | **No — hidden until consent** | **7 days** | PDPA "no longer than necessary". This is the brief's "destroy guest data every X days" |
| Volunteered sensitive info pre-consent | At rest, separate key | **No** | 7 days | Encrypt, hide from staff, expire |
| Authenticated patient record | At rest | Yes, consented staff | **7 years** | PHFSA 1998 record-keeping mandate |
| Audit logs | At rest | Privacy officer | **2 years** after data destruction | PDPA compliance evidence. IDs and hashes only |
| Quarantined raw payloads | Separate key | **Privacy officer role only** | 7 days | Fail-closed destination |

**Cross-border (`report-E` §6):** redaction alone is *not* a lawful basis. Three layers:
(1) PHI redaction as due-diligence evidence, (2) an explicit consent gate naming overseas AI
processing, stored as `consents.type='overseas_processing'` with notice version, (3) LLM endpoint
as config, defaulting to `ap-southeast-1`.

**Where redaction happens:** `lib/redaction/pipeline.ts` — called in `app/api/chat/route.ts`
**before** any model call. There is exactly one path to the LLM and it goes through this function.

**How RBAC is enforced:** Postgres RLS on every patient-scoped table, keyed to
`auth.uid()` → `patients.id`, plus route middleware asserting role for `/api/clinician/*`.
Roles: `guest`, `patient`, `staff`, `nurse`, `clinician`, `privacy_officer`.
`test_access_control.py` asserts Patient A cannot fetch Patient B, and that a patient JWT
against the triage queue returns 403 from the database policy, not from application code.

---

## 13. Timeline — replanned from 16:30 Sep 1

> Research finished ~2.5h faster than budgeted. That slack is already spent; the schedule below
> is the real one.

| Block | Clock (MYT) | Goal | Gate |
|-------|------------|------|------|
| B | Sep 1, 16:30–18:00 | `git init`, Next.js scaffold, Supabase project, **hello-world deployed to a public URL** | Public URL live |
| C | 18:00–20:00 | Schema + migrations + RLS policies + synthetic clinic seed data | `test_access_control.py` green |
| — | 20:00–20:30 | Dinner | |
| D | 20:30–23:30 | Guest chat E2E: redaction → deterministic gate → LLM → cited reply, streaming | `test_redaction.py` + `test_risk_escalation.py` green |
| E | 23:30–01:30 | Living memory + mutation + **History Engine v1** | `test_memory_mutation.py` green |
| — | Sep 2, 01:30–08:00 | **Sleep. Non-negotiable.** | |
| F | 08:00–08:30 | **PROTOTYPE GATE.** Demo to yourself out loud. Cut against §3 | Honest assessment |
| G | 08:30–11:30 | Auth + consent + guest→patient migration, provenance intact | `test_guest_to_patient_conversion.py` green |
| — | 11:30–12:15 | Lunch | |
| H | 12:15–15:30 | Channel contracts + `channel_rules.yaml` + **live Telegram bot** | Two channels, two openings |
| I | 15:30–18:30 | Escalation payload + clinician/nurse queue + dynamic SLA | `test_escalation_payload.py` green |
| — | 18:30–19:15 | Dinner | |
| J | 19:15–23:00 | Funnel events + per-channel metrics + warm-lead view + `<LiveStat>` | `test_value_events.py` green |
| — | 23:00–05:30 | **Sleep.** | |
| K | Sep 3, 05:30–07:00 | `test_trust.py` + gaps + full suite from a clean clone | All 8 green |
| L | 07:00–09:30 | **FEATURE FREEZE.** README + Technical Brief + ATTRIBUTION.txt | Deliverables 2–4 |
| M | 09:30–11:15 | Demo video, ≤3 min. Budget 3 takes | Exported |
| N | 11:15–12:15 | Buffer. Clean commit history. Rubric self-check §17 | |
| O | 12:15–12:45 | **Submit** — irakumar@ntngale.com, cc yunxint@sunway.edu.my, subject `Nightingale 48HR Build — Jason Ong` | Sent |
| — | 12:45–13:00 | Reserve. Touch nothing. | |

**Hard rules:** Feature freeze Sep 3 07:00, no exceptions. Commit at every gate. Overrun >45min
→ cut from §3b, never from §3a and never from sleep.

---

## 14. Demo script (≤3 minutes)

| Time | Beat | On screen | The line |
|------|------|-----------|----------|
| 0:00–0:12 | The problem | The Zuko number | "Healthcare has the worst form completion of any sector measured — 21.4%. People arrive scared and leave before they ever reach a clinician." |
| 0:12–1:00 | **Scenario A** — IG ad → guest value → History Engine → trust transition → consent → context lands live in the profile | Split: chat left, profile filling right | "She never made an account to get help. And she never repeats herself." |
| 1:00–1:40 | **Scenario B** — "crushing chest pain" → deterministic layer fires → AI stops → Send to Clinic → persisted record | Show `deciding_layer=deterministic` in the record | "The model never got a vote on this one. That's deliberate." |
| 1:40–2:05 | **Scenario C** — staff referral link opens already knowing the topic; then the **live Telegram bot** | Phone screen, real message | "This is a real bot. No mock." |
| 2:05–2:40 | **Scenario D** — funnel per channel, warm-lead view, and the clinical-concern override outranking a high-value sales lead | Dashboard | "Every number here is a live query. Drop the threshold and it shows nothing rather than lie." |
| 2:40–3:00 | The challenge | §15 | "One thing in your brief I think is wrong, and what I built instead." |

---

## 15. Assumptions, first-principles, and where I challenge the brief

**Assumptions:**

1. A prospect who feels *processed* leaves, and one who feels *heard* completes — so the
   scarcest resource in the funnel is the person's willingness to type one more sentence, and
   every design decision spends or earns that.
2. Clinic staff will not read chat logs. Anything requiring them to is decoration.
3. Synthetic data throughout. No real PHI touches this build at any point.
4. The un-commenced status of the Telemedicine Act 1997 does not reduce the safety obligation —
   it only changes which statute we cite. **⟨verify⟩ before submission.**

**Where I think the brief is wrong:**

| Brief says | I think | What I built | Evidence |
|-----------|---------|-------------|----------|
| "Catch prospects when they comment or inquire **in milliseconds**" | For commerce, yes. For health, speed reads as **surveillance**. A DM landing seconds after someone comments on a fertility post is frightening, not delightful — and it can out them | Sub-second on *our* surface where they chose to be; on social, a neutral door with no clinical content, deliberately unhurried for sensitive topics (§4e) | Meta permits a 7-day private-reply window — the platform itself does not expect milliseconds. MMC classes unsolicited contact as canvassing |
| Response expectation of **"12 to 18 hours"**, stated | A static promise made at 2am the clinic cannot keep is a trust breaker | Dynamic SLA computed from clinic hours + server time, shown as a real time | `report-C&D` §3.3 #8 — false promises of immediacy |
| Show the prospect **"14 people asked this week"** | Right instinct, but only if it is true. A fake number is worse than no number | `<LiveStat>` with a hard floor of 5 and a test that fails on any unbacked integer | The brief's own warning against gimmicky numbers |
| **"Send to Nurse/Clinic"** as a single clear action | The word "send" describes the *system's* action. The person's fear is having to retell it | "Send this to a nurse — you won't have to explain it again" | §2 fear ordering |
| *(implicit)* An empathetic AI should feel human | A human-like agent measurably **reduces** honest disclosure of stigmatised symptoms | Plainly automated, no avatar, no performed feeling — warm and obviously a machine | Zhu & Broadbent 2025, N=160 randomised; Turner et al. 1998, N=1,690 |

> **The one to lead with in the video:** the milliseconds challenge. It is the brief's own
> opening claim, it is wrong specifically in healthcare, and you can show the design that
> replaces it.

---

## 16. Where my Data Analyst background is the advantage

| Rubric line | Most candidates will | I do |
|------------|---------------------|------|
| Honest numbers resolving to a live query | Hardcode "14 people asked this week" | One `<LiveStat>` component that cannot accept a literal, a floor of 5, and `test_value_events.py` failing on any displayed integer without a logged query |
| Warm-lead transparent score | Invent weights | Explicit documented formula, per-lead contribution breakdown visible in the UI, and a stated note on what calibration data it would need to be trusted |
| Conversion metrics per channel | A bar chart | Funnel table with per-stage conversion *and* drop-off, segmented by channel × identity_level, every event defined so the numbers are auditable |
| "Explain where users abandon" | Guess | Instrument abandonment explicitly (last event before session death), PHI-free, retained 30 days with the justification written down |

**Warm-lead score:**

```
score = 0.35·recency_decay(hours_since_last_event, half_life=12h)   # 0..1
      + 0.25·channel_weight[source_channel]                          # 0..1, from config
      + 0.20·identity_level_weight                                   # anon .2, handle .5, email .8, verified 1.0
      + 0.20·funnel_stage_weight                                     # visitor .1 → consented .9

THEN, applied AFTER scoring and never as a term:
  if risk_level in (medium, high):
      route = CLINICAL_ESCALATION
      suppress_all_sales_contact_suggestions()
      badge = "Compassion priority"
```

**The safety rule, made visible:** a high score on a clinical concern is a **compassion
priority, not a sales priority**. The risk override is applied *after* scoring so the UI can
show both — "this lead scored 0.91, and we are deliberately not selling to them." That
contrast is one of the most demoable ideas in the build, and it is the brief's own stated rule
enforced in code rather than promised in prose.

---

## 17. Rubric self-check (do this Sep 3, 07:00)

| Points | Area | Evidence | Self-score |
|--------|------|----------|-----------|
| 6 | Acquisition + Trust Funnel | | /6 |
| 6 | Memory & provenance | | /6 |
| 6 | Creativity & product fit | | /6 |
| 4 | Speed & architecture | | /4 |
| 3 | Intake + Risk Gating | | /3 |
| 3 | Security & safety | | /3 |
| 2 | Communication | | /2 |
| +10 | Nightingale Alignment (bonus) | | /10 |

- [ ] Git repo — working app, tests, clear commit history
- [ ] README — setup, run, tests, **where redaction happens**, **how RBAC is enforced**
- [ ] Technical Brief — architecture, schema, channel ethics matrix, assumptions, trade-offs, VoiceAI
- [ ] ATTRIBUTION.txt
- [ ] Demo video ≤3 min
- [ ] Email sent, cc'd, correct subject line

---

## 18. Open questions / risks

| Risk | Likelihood | If it happens | Mitigation now |
|------|-----------|--------------|----------------|
| Supabase RLS fights me and eats 4h | Medium | Drop to middleware-only checks, document as a cut, keep one RLS policy as the demonstration | Write and test RLS in block C, before any feature depends on it |
| Telegram bot is my first ever — unknown unknowns | Medium | Portal link still works standalone; bot degrades to a link dispenser | Timebox to 90 min inside block H. If it isn't talking by 14:00 Sep 2, cut it |
| History Engine feels like an interrogation in practice | Medium | Cut to 4 fields from 7; keep the meter | Test it on yourself at the prototype gate — read it aloud |
| Demo video overruns 3 min | High | Script is written (§14); cut Scenario D first | Record a rough take at the Sep 2 prototype gate |
| Telemedicine Act claim is wrong in the brief | Low | Cite Medical Act 1971 + MMC only | ⟨verify⟩ during block L |
| I run out of time before the Technical Brief | Medium | The brief is worth more than another feature | Feature freeze at 07:00 is the mitigation. Honour it |
