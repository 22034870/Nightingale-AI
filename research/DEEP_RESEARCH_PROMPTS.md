# Deep Research Prompts — Nightingale 48H Build

**Fire these off FIRST, before you write any code.** Deep research runs take 10–30 min each and run unattended. Start all four now, then go build the scaffold while they cook.

## How to run them

| # | Prompt | Best tool | Why |
|---|--------|-----------|-----|
| A | SEA regulatory & compliance | **Perplexity Deep Research** | Needs current, citable primary sources (statutes, MOH circulars). Perplexity gives URLs you can footnote in the Technical Brief. |
| B | Platform policy (Meta/TikTok/WhatsApp) | **Perplexity Deep Research** | Same — platform ToS change often, you need dated citations. |
| C | PHI redaction patterns + clinical red flags | **Gemini 2.5 Pro Deep Research** | Long synthesis; must produce regex and a lexicon, not just links. |
| D | Trust, drop-off & SEA patient psychology | **Gemini 2.5 Pro Deep Research** | Long synthesis across behavioural science + cultural context. |

**Rules for yourself:**

1. Start A and B on Perplexity, C and D on Gemini — all four at once, in separate tabs.
2. **Do not wait for them.** Timebox: whatever has landed by T+4h is what you use.
3. Save each report to `research/report-A.md`, `research/report-B.md`, etc. Then tell me "reports are in research/" and I'll turn them into config files, regex, and the ethics matrix.
4. Skim each report for **three things only**: a constraint that changes your build, a number you can cite, a phrase you can put in the UI. Ignore the rest. You have 47 hours.

---

## Prompt A — SEA / Malaysia regulatory & compliance

> **Feeds:** Technical Brief channel-ethics matrix (the "legal under PDPA and Malaysia's MAB rules" axis), consent copy, data retention policy, guest-data destruction window.

```text
You are a healthcare compliance researcher. I am building a patient-acquisition and
pre-clinical intake chat product for private clinics in Southeast Asia, with Malaysia
as the primary launch market and Singapore as the secondary market.

Research and report on the following, as of 2026. Cite primary sources (statute text,
regulator circulars, official guidelines) with URLs and dates. Flag anything where the
law changed in the last 24 months.

1. MALAYSIA — Personal Data Protection Act 2010 and its 2024/2025 amendments:
   - What counts as "sensitive personal data" and does health information qualify?
   - Consent requirements: what must a consent notice contain, must it be explicit,
     must it be separable from other terms, and can it be bundled with a signup?
   - Data breach notification duties, data protection officer requirements,
     and any data-localisation or cross-border transfer restrictions.
   - Retention: is there a maximum retention period, or a "no longer than necessary"
     standard? What is defensible for (a) anonymous website-visitor metadata and
     (b) health information volunteered by someone who never created an account?
   - Direct marketing: what is required before sending a marketing message, and what
     is the distinction between a transactional message and a marketing message?

2. MALAYSIA — Medicine Advertisements Board (MAB) / Medicines (Advertisement and Sale)
   Act 1956, and Ministry of Health advertising guidelines for private healthcare
   facilities under the Private Healthcare Facilities and Services Act 1998:
   - What may and may not appear in clinic advertising and clinic-owned digital channels?
   - Are testimonials, before/after images, patient reviews, or condition-specific
     targeting restricted?
   - Do these rules apply to organic social media posts and DM replies, or only to paid ads?
   - What approvals (if any) are needed before a clinic publishes health content?
   - Are there specific restrictions on advertising fertility/IVF, aesthetics, or
     mental health services?

3. MALAYSIA — Telemedicine Act 1997 and MOH telehealth guidance:
   - Where is the legal line between "health information" (permitted from a
     non-clinician system) and "medical advice / diagnosis" (restricted to registered
     practitioners)? Quote the operative language.
   - Does an AI system providing general health education to a prospective patient
     trigger any registration or supervision requirement?

4. SINGAPORE (secondary market) — PDPA, the Healthcare Services Act, and MOH
   advertising rules: summarise the equivalent answers to 1–3 and flag the biggest
   divergences from Malaysia.

5. BRIEFLY — Indonesia (PDP Law 27/2022), Thailand (PDPA), Philippines (Data Privacy
   Act): one paragraph each on whether a Malaysia-compliant design would also be
   broadly compliant there, and the single biggest gap.

OUTPUT FORMAT:
- Section 1: a table with columns [Requirement | Jurisdiction | Source + URL | What my
  system must do | Confidence high/med/low].
- Section 2: a plain-English "consent notice" draft (under 120 words) that would satisfy
  Malaysian PDPA for sharing health information volunteered in a chat with a named clinic.
- Section 3: a recommended data-retention schedule with a justification sentence per
  data class (anonymous metadata, guest chat content, authenticated patient record,
  audit logs).
- Section 4: the top 5 things that would get this product shut down or fined, ranked.
```

---

## Prompt B — Platform policy for social acquisition channels

> **Feeds:** channel contracts (`social_comment`, `instagram_ad_click`, `google_reviews`), the green/yellow/red ethics matrix ("permitted by platform policy" axis), and your decision on whether to attempt a real Meta integration.

```text
I am building a system that captures healthcare prospects from social media and moves
them into a private, consented chat with a clinic. Research current (2026) platform
policy and technical capability for the following, citing official developer docs and
policy pages with URLs and last-updated dates.

1. META (Instagram + Facebook):
   - Instagram Graph API / Messenger Platform: can a business automatically send a
     private reply (DM) to a user who comments on the business's post? What is the
     exact webhook (field name), what permissions/scopes are required, what App Review
     is needed, and what is the time window for the private reply?
   - The 24-hour standard messaging window and message tags: what applies here?
   - Health and wellness restrictions: what does Meta's advertising policy and its
     business messaging policy say about health conditions, medical claims, and the
     use of health-related user data? Is condition-based ad targeting (e.g. targeting
     people interested in fertility treatment) currently permitted, restricted, or banned?
   - Is there any policy on using someone's public comment on a health-related post
     as a signal to contact them?

2. TIKTOK:
   - Same questions: comment webhooks, automated DM capability for business accounts,
     what the Business Messaging / Business API actually supports in 2026.
   - TikTok advertising policy on healthcare and medical services in Malaysia/SEA.

3. WHATSAPP BUSINESS PLATFORM (Cloud API):
   - Template message requirements and approval, the 24-hour customer service window,
     opt-in requirements, and what counts as valid opt-in.
   - Any health-sector restrictions on WhatsApp Business messaging.
   - What does it realistically take to get a test number working in under 2 hours?

4. GOOGLE:
   - Google Business Profile reviews: is there an API to reply to reviews, and does
     policy allow embedding a link in a public review reply?
   - Google Ads healthcare and medicines policy for Malaysia: certification
     requirements, restricted health claims.

5. ETHICS / GREY ZONES — for each of these, tell me whether it is (i) technically
   possible, (ii) legal under Malaysian PDPA, (iii) permitted by the platform's terms,
   (iv) likely to feel trustworthy or creepy to a patient. Be blunt:
   - Scraping a competitor clinic's Google reviews to find dissatisfied patients.
   - Monitoring public health-support threads / Facebook groups for people describing
     symptoms, then DMing them.
   - Retargeting ads based on an inferred health condition.
   - Auto-DMing everyone who LIKES (not comments on) a health post.
   - Auto-DMing someone who comments on a post about a stigmatised condition
     (mental health, sexual health, fertility) where a DM could out them.

OUTPUT FORMAT:
- Section 1: a capability table [Channel | Can I automate it? | API/webhook name |
  Approval needed | Realistic setup time | Source URL].
- Section 2: the grey-zone list scored green/yellow/red on all four axes, with a
  one-line justification per cell, and for each YELLOW, one concrete design change
  that would turn it green.
- Section 3: two or three acquisition channels that are legitimate but that most
  builders would not think of, with the policy basis for why they are allowed.
```

---

## Prompt C — PHI redaction patterns + clinical red-flag lexicon

> **Feeds:** the redaction pipeline (regex layer), the deterministic risk-gate lexicon, `test_redaction.py`, `test_risk_escalation.py`.

```text
I am building a non-diagnostic healthcare intake chat for Southeast Asia. Two safety
systems need to be grounded in real standards, not guesswork. Produce a technical
reference I can implement directly.

PART 1 — PII/PHI IDENTIFIER FORMATS FOR SEA
For each of Malaysia, Singapore, Indonesia, Thailand and the Philippines, document the
exact format of national identity numbers and common contact identifiers, and give me
a tested regular expression for each:
  - National ID (Malaysian NRIC/MyKad, Singapore NRIC/FIN incl. the checksum letter,
    Indonesian NIK, Thai national ID, Philippine PhilSys)
  - Mobile phone number formats, including international (+60, +65, +62, +66, +63)
    and local dialling variants, and how people actually type them (spaces, dashes)
  - Passport number formats used in the region
  - Medical record number / clinic patient ID conventions in private hospitals
  - Bank card and insurance/policy number patterns
Also cover: how the US HIPAA Safe Harbor 18 identifiers map onto this context, and
which of the 18 are relevant even though HIPAA does not apply in Malaysia.

For NAMES specifically: explain why regex fails for Malay, Chinese, Indian and
indigenous naming conventions in Malaysia (bin/binti, a/l a/p, generational names,
romanisation variants), and describe the practical detection strategies used in
production de-identification systems, with their known failure modes.

PART 2 — DE-IDENTIFICATION SYSTEM DESIGN
Summarise how production clinical de-identification pipelines are built:
  - The layered approach (deterministic pattern matching, gazetteers/dictionaries,
    NER models, context rules) and the accepted order of operations.
  - Precision vs recall trade-off: in a system where a leak is unacceptable, what is
    the standard bias and what does over-redaction cost?
  - Reported accuracy figures for named open-source tools (Microsoft Presidio,
    Philter, scrubadub, spaCy-based NER, deid) with citations.
  - What the literature says about re-identification risk from quasi-identifiers
    (age + postcode + rare condition) that survive naive redaction.
  - Recommended handling when the redactor itself fails or times out.

PART 3 — CLINICAL RED-FLAG LEXICON (NON-DIAGNOSTIC TRIAGE)
Using established triage frameworks — the Manchester Triage System, the Emergency
Severity Index, NHS 111 / NHS Pathways red flags, and WHO emergency triage (ETAT) —
compile a red-flag symptom lexicon suitable for a text-based system that must NEVER
miss an emergency. Organise by body system. For each red flag give:
  - The clinical phrase (e.g. "crushing chest pain")
  - Lay and colloquial variants a patient would actually type, INCLUDING Malaysian
    English/Manglish, Bahasa Malaysia, and common Singlish phrasings
    (e.g. "dada sakit", "sesak nafas", "susah bernafas", "chest feel funny")
  - Why it is a red flag, in one sentence
  - Whether it warrants immediate emergency services vs same-day clinical contact

Cover at minimum: cardiac, respiratory, neurological (incl. stroke FAST), obstetric
and gynaecological haemorrhage, sepsis, anaphylaxis, acute abdomen, paediatric
red flags, and mental health crisis / self-harm / suicidal ideation.

For the mental health section, also research: safe messaging guidelines for suicide
and self-harm (WHO, Samaritans media guidelines, #chatsafe), what an automated system
should and should not say, and the correct crisis resources for Malaysia and
Singapore (name, number, hours, and whether they accept text/chat).

PART 4 — AMBIGUITY
How do triage protocols handle vague presentations ("my chest feels funny", "I just
feel off", "something's not right")? What is the standard doctrine on erring toward
escalation, and what language do clinicians use to escalate without alarming?

OUTPUT FORMAT:
- Part 1: a table [Identifier | Country | Format | Regex | Example | False-positive risk].
- Part 3: a machine-readable list I can paste into a config file, grouped by
  body system, each entry as {phrase, variants[], language, severity, rationale}.
- Every clinical claim must carry a citation to the source protocol.
- End with: the 10 phrases my system absolutely must never fail to escalate,
  and for each, five ways a real patient might phrase it.
```

---

## Prompt D — Trust, drop-off, and SEA patient psychology

> **Feeds:** your refined pre-clinical funnel, the value_events you invent, the empathy/inclusivity requirement, UI copy, and the "where do users abandon" part of the demo.

```text
I am designing the first five minutes of a relationship between an anonymous person
worried about a health issue and a private clinic in Malaysia. They arrive from an
Instagram ad, a TikTok comment, a Google review, or a staff referral link. My goal is
that they voluntarily share enough to get real help and consent to contact a clinician
— without being pushed, and without ever being diagnosed by a machine.

Research the following. Prioritise peer-reviewed behavioural science, health
communication research, and published conversion/UX studies. Cite everything.

1. DISCLOSURE AND TRUST
   - What does research say about why people disclose sensitive health information to
     a computer versus a human? (Include the literature on reduced self-presentation
     bias / disclosure to virtual agents.)
   - What specific interface and language factors increase willingness to disclose:
     stated confidentiality, visible data handling, anthropomorphism level, response
     latency, whether the system admits it is an AI?
   - What DESTROYS trust fastest in a health chatbot? Rank the failure modes.
   - Does an AI that clearly states its limits gain or lose trust? What is the
     evidence on "honest uncertainty" versus confident answers?

2. FUNNEL DROP-OFF
   - Published data on abandonment in healthcare intake forms, patient registration,
     and appointment booking flows. Where exactly do people leave, and what fields
     cause the steepest drop?
   - Evidence on the cost of asking for email or phone number too early, and on
     progressive profiling / delayed authentication as a mitigation.
   - What is the measured effect of giving value before asking for identity?
   - How long will someone engage with a health chat before abandoning, and what
     response latency is tolerable?

3. SOUTHEAST ASIAN CONTEXT — MALAYSIA FIRST
   - Health-seeking behaviour: what causes delay between symptom onset and seeking
     care in Malaysia and the region? Cost, fear, stigma, family authority, work
     leave, distrust of private care, traditional/complementary medicine first?
   - Stigma specifics for: mental health, fertility and infertility, sexual and
     reproductive health, HIV/STI, cancer, obesity. Who does a person tell first?
   - The role of family in health decisions — how often is a spouse, parent or
     child involved in the decision to seek care, and what does that imply for a
     product feature that helps someone tell their family?
   - Language: how do Malaysians actually mix English, Bahasa Malaysia, Mandarin and
     Tamil when describing symptoms online? Give real examples of code-switching.
     What tone reads as warm versus clinical versus condescending in Malaysian English?
   - Digital behaviour: WhatsApp vs Instagram vs TikTok usage for health topics by
     age group; trust in social media health content; who they ask first.

4. EMPATHY THAT IS NOT PATRONISING
   - Evidence-based phrasing for validating a health concern WITHOUT reassuring
     falsely and WITHOUT diagnosing. Give concrete example sentences.
   - Research on "you are not alone" style normalisation: when does it help and when
     does it feel dismissive or scripted?
   - How to communicate uncertainty and hand off to a human in a way that feels like
     care rather than rejection or a brush-off.
   - Accessibility and inclusivity: phrasing that works regardless of gender, marital
     status, religion, literacy level, or whether the person has insurance.

5. WHAT PEOPLE ACTUALLY WANT TO KNOW
   - For 4–5 common private-clinic topics in Malaysia (fertility/IVF, women's health,
     paediatrics, chronic disease screening, mental health), what are the top questions
     prospective patients ask BEFORE they book? What do they forget to ask and later
     regret not asking?

OUTPUT FORMAT:
- A ranked list of the top 10 trust-breaking moments in a flow like mine, each with
  the specific design counter-measure and the evidence behind it.
- A table of drop-off points with published abandonment rates where available.
- 15 example sentences: empathetic, non-diagnostic, non-patronising, written for a
  Malaysian audience. Mark which are safe to use verbatim in a product.
- For each of the 5 clinic topics, "6 questions people forget to ask their doctor",
  grounded in real patient-experience research, with sources.
- A short list of things my product should deliberately NOT do, with the reason.
```

---

## After the reports land

Bring them back here and say: **"Reports are in `research/`."** I'll convert them into:

- `config/redaction_patterns.py` — regex layer from Prompt C Part 1
- `config/red_flags.yaml` — the deterministic risk lexicon from Prompt C Part 3
- `config/channel_rules.yaml` — the declarative channel × identity × time config
- `docs/channel-ethics-matrix.md` — the green/yellow/red table for the Technical Brief
- UI copy and consent text grounded in Prompts A and D

Do not read all four reports end to end. Extract, then move.
