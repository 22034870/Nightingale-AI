# Research Digest — what the reports actually give you

**Read this instead of re-reading the reports.** Every finding below is mapped to the
`PLANNING.md` section it fills in. Two background agents are filling identified gaps
(→ `report-E-platform-gaps.md`, `report-F-funnel-evidence.md`).

**Verdict on the reports:** A&B is solid on law, weak on platform mechanics. C&D is the
stronger of the two and is genuinely build-ready in places. Neither needs redoing.

---

## 🔴 Decisions you must make now (these block the build)

### D1. The research directly contradicts one of your stated requirements

You told me the system should *"show signs of empathy… making sure that it consults the
patient that they are not alone."*

Report C&D, §3.4 Deliberate Anti-Patterns, says:

> **DO NOT** use the phrase "You are not alone." Psychological research shows that while
> well-intentioned, this phrase often reads as dismissive, scripted, and minimises the
> patient's unique, individualised distress.

And §4.3 rates *"Many patients visit our clinic for similar concerns"* as **Caution** —
safe for fertility or dermatology, dismissive for rare disease or acute trauma.

**I think your instinct is right and the phrasing is wrong.** The need you identified is real:
in a region where the report confirms stigma is the primary driver of delayed care (§4.1 —
mental illness misattributed to spiritual weakness, fear of *muka*/loss of face), a person
disclosing something shameful needs normalisation. What fails is the *generic platitude*.

**My recommendation — resolve it with your DA angle instead of a phrase:**

| Instead of | Do this |
|---|---|
| "You are not alone" (scripted, unverifiable) | A live-query stat: *"9 other people asked this clinic about fertility this week."* Real number, same emotional payload, and it satisfies the brief's honest-numbers rule |
| Generic empathy on every turn | Modulate by severity (C&D §3.3 #3 — uncanny-valley empathy from repetitive validation is the **3rd-ranked trust breaker**) |
| Telling them they're not alone | Give them the Family Communication Kit — the shareable note. §4.1 says health decisions in SEA are family decisions, not individual ones. That *materially* reduces isolation instead of asserting it away |

This is a genuinely strong Technical Brief paragraph: *"We were asked to make the patient feel
less alone. The literature says the phrase that does this fails. So we did it with data and a
shareable artefact instead."*

**→ Your call. Fill into `PLANNING.md` §4d.** If you disagree, say so and I'll build it your
way — but the banned-phrase list needs to reflect whichever you pick.

### D2. Cross-border transfer — ANSWERED, and redaction alone is not enough ✅

Report A&B flagged **PDPA s.129**: streaming unredacted patient health chat to a foreign LLM
API is one of the **top 5 things that get you fined**. Agent E has now answered the follow-up
(report-E §6), and the answer changes your architecture:

**Redacted text still counts as personal data.** PDPA s.4 defines personal data as information
about someone "identifiable from that information **or from that and other information in the
possession of a data controller**." The clinic keeps the mapping from `PATIENT_1` back to a real
name — it has to, in order to book them. So the pseudonymised payload is still personal data in
the controller's hands, and symptom narrative is *sensitive* personal data on top.

Worse: the old **whitelist was abolished** by the 2024 amendment. Amended s.129 took effect
1 April 2025. The "destination has adequate protection" limb **fails outright for US endpoints**
because Malaysia publishes no adequacy list.

**Three things, cheapest first:**

1. **Keep PHI redaction.** It is now your *due-diligence evidence* under s.129(2), not just
   good engineering. It also caps breach blast radius.
2. **Add a consent gate as message one**, naming "AI processing by overseas service providers."
   Store `consent_id + timestamp + notice_version`. This is the cheapest lawful basis.
3. **Make the LLM endpoint a config value, default `ap-southeast-1` (Singapore).** One line.
   It moves you from a dead legal limb to an arguable one, since Singapore's PDPA 2012 is a
   plausible "substantially similar" finding. Claude is not served from the Malaysia Bedrock
   region, so Singapore is the closest you can get.

TIA and SCCs go in your roadmap appendix, not the 48 hours. **→ `PLANNING.md` §9 and §12.**

### D3. Fail-closed has two flavours — pick one

C&D §2.4 gives two options when the redactor fails. Pick now, it changes your schema:

- **Synchronous blocking** — refuse the message, ask the user to retry. Simple. Bad UX.
- **Human quarantine** — accept the message, route the raw payload to an isolated queue that
  only a privacy-officer role can open. Needs one extra table + one extra RBAC role.

**My recommendation: quarantine.** It costs you ~30 minutes, it is demoable, and "we built a
quarantine queue with its own access role for redaction failures" is a much better answer to
"what happens when redaction fails?" (a required Technical Brief item) than "we drop the message."
**→ `PLANNING.md` §11.**

### D4. ⚠️ Report A&B cites a law that was never brought into force

Report A&B lists **Telemedicine Act 1997 (Act 564) s.3** as binding, at "High" confidence, and
builds its #1 shutdown risk on it. Agent E checked the commencement provision: s.1 says the Act
"shall come into force on a date to be appointed by the Minister by notification in the Gazette"
— **and no such notification was ever made.** The Act has sat un-commenced since 1997.

If your Technical Brief cites Act 564 as governing law, that is a hole a judge with any Malaysian
legal literacy will open immediately.

**What to cite instead:** the **Medical Act 1971** (holding out as a registered practitioner) and
the **MMC Telemedicine Guideline**. Your non-diagnostic constraint is unchanged — it just rests
on live law now. Agent E has the verbatim s.3(1) text if you want to reference the Act as
*pending* rather than binding, which is actually the more sophisticated framing.

⚠️ Sourced to CommonLII's "year in force" record plus Wikipedia. It is a well-known point among
Malaysian health-law practitioners, but **verify once more before it goes in a submitted brief** —
it is load-bearing.

### D5. You can demo a REAL Instagram integration with zero App Review 🎯

This is the biggest unlock in the report. The 10-point Nightingale Alignment bonus wants real
Meta/Instagram integration, and everyone will assume App Review makes that impossible in 48 hours.

**Meta Development Mode lets you request unapproved permissions from any account that holds a
role on the app** (Administrator / Developer / Tester / Analytics User). So: a burner IG Business
account, a real post, a real comment, a real webhook, a real `POST /{comment-id}/replies`, a real
DM delivered. All of it genuine. Only the general public is excluded.

**Add the judges as Testers** and they can try it themselves.

Two hard constraints to encode (report-E §1, verbatim from Meta's docs):
- **7 days** from comment creation to send the private reply — clock runs from the *comment
  timestamp*, not webhook receipt
- **Exactly one** private reply per comment, ever

→ Persist `comment_created_time`, put a **unique constraint on `comment_id`** in the outbound
queue, and enforce a 7-day TTL. A double-fire permanently burns the single allowed reply.

**→ `PLANNING.md` §3b (promote to §3a if the scaffold goes well) and §8.**

### D6. Ship Telegram as the working demo channel

Agent E's answer to "a green channel nobody pitches": an **inbound-only Telegram bot**. Green on
all four axes and the only rich chat channel shippable end-to-end in 48 hours with **zero platform
approvals** — no app review, no business verification, no message templates.

The elegant part for your ethics matrix: **a Telegram bot cannot message a user who has not
pressed Start.** The platform itself enforces user-initiation, which is exactly the consent
property MAB's anti-canvassing rule cares about. That's a strong paragraph in the brief.

Build IG, WhatsApp and Telegram as one adapter behind a channel interface; Telegram is the one
that actually runs live in the demo. **→ `PLANNING.md` §8.**

---

## ✅ What is ready to use right now

I've already extracted these into config files — see the bottom of this doc.

| Finding | Source | Fills |
|---|---|---|
| Red-flag lexicon w/ Bahasa + Manglish variants | C&D §5.1, §5.3 | §6, `test_risk_escalation.py` |
| 15 phrases rated Safe / Caution / Unsafe | C&D §4.3 | §4d |
| 10 ranked trust-breaking moments + counter-measures | C&D §3.3 | §4b — this is *literally* your funnel table |
| Crisis resources MY + SG (Befrienders, Talian Kasih, SOS) | C&D §5.2 | §6 |
| Consent notice, 98 words, PDPA-shaped | A&B §2 | §12, consent UI |
| Retention schedule w/ per-class justification | A&B §3 | §12 — this fills the "destroy guest data every X days" requirement |
| Layered redaction pipeline order | C&D §2.1 | §6a, §11 |
| Regional ID regex | C&D §1.1 | redaction layer — **but see warning below** |
| Channel capability matrix w/ real endpoints | A&B §B1 | §8 |
| 3 compliant acquisition channels | A&B §B3 | §8, ethics matrix |

### The single best thing in either report

**C&D §3.3 — the 10 ranked trust-breaking moments.** Each has a named counter-measure. That is
your `PLANNING.md` §4b funnel table, pre-written, evidence-backed. Map each one to a design
decision and you have earned most of the Acquisition + Trust Funnel score. Highlights:

1. Diagnostic confidence ("this sounds like cancer") → guardrails, never name conditions
2. **Premature authentication** → progressive profiling. This is your funnel refinement, confirmed
4. Ignoring red flags → *"deterministic red-flag lexicons that override NLP logic"* — the report
   independently arrived at the architecture I recommended. Cite it in the brief.
8. False promises of immediacy → **dynamic SLAs from server time.** The brief tells you to promise
   "12 to 18 hours." The research says a static promise is a trust breaker. That's a legitimate
   place to challenge the brief (§15).
9. Interrogative pacing → **one question per message, enforced.** Cheap to implement, high impact.

### Retention numbers — just take these

From A&B §3, defensible under PDPA "no longer than necessary":

- Anonymous session metadata: **30 days**
- Guest chat transcripts (never converted): **7 days**
- Authenticated patient records: **7 years** (PHFSA 1998 record-keeping mandate)
- Audit logs + consent receipts: **2 years after deletion**

The 7-day guest number answers the brief's "destroy guest data every X days" with a citation
attached. Use it.

---

## ⚠️ Do not use as-is

### The regex table is corrupted

Several patterns in C&D §1.1 use `|` alternation, which broke the markdown table cells.
**Malaysia phone, Indonesia phone, Thailand phone, bank card, MRN and insurance patterns are all
truncated or mangled.** The Singapore NRIC and MyKad patterns survived intact.

Do not paste these into code. I'll rebuild the set properly with unit tests when we build the
redaction layer — the report's *analysis* is what's valuable (which formats exist, what the
false-positive risks are), not its literal strings.

Also note the report's own warning: MyKad `\d{6}-\d{2}-\d{4}` is **high false-positive risk**
against any 12-digit number. Needs a context rule or a date-validity check on the first 6 digits.

### The abandonment percentages — CONFIRMED FABRICATED ❌

Agent F checked all five. **Not one survives.** Delete C&D §3.2's drop-off table entirely
(15–25% landing, 30–50% auth, 20–40% history, 10–20% latency, 10–15% booking). No source exists
for any of them, and the real evidence shows healthcare abandonment is *worse* than the table
claimed, not better.

Also fabricated: **every "progressive profiling lifts conversion 35%" figure** circulating
online. They all trace to a "Marketo Benchmark Report 2024" / "Eloqua Study 2024" that does not
exist. The *doctrine* of delaying identity capture is still sound — it just rests on Baymard's
forced-account-creation data, not on a conversion-lift number.

**Use these instead** (full citations in `report-F-funnel-evidence.md` → "Safe to cite"):

| Claim | Source | Tier |
|---|---|---|
| Healthcare forms complete **44.37%** of started sessions; **lowest view-to-completion of any sector at 21.4%** | Zuko Analytics, 727,492 healthcare sessions, 2025 | Industry benchmark — label as vendor analytics |
| Stated length drives drop-off: completion **68.2% → 56.8% → 46.8%** at 10/20/30 min | Galesic & Bosnjak, *POQ* 73(2), 2009 | **Peer-reviewed** |
| **18%** of abandoning users cite forced account creation; **14%** would never give a phone number | Baymard | Industry benchmark, e-commerce — label the transfer |
| Computer administration raises reporting of stigmatised behaviours **3× or more** | Turner et al., *Science* 280:867–873, 1998, N=1,690 randomised | **Peer-reviewed — the best citation you have** |

That Zuko figure is the one to open your brief with: *healthcare has the worst form completion
of any sector measured.* That is the problem you are solving, in one number, properly sourced.

### Minor sourcing weaknesses to note

- The Singapore NRIC checksum is cited to a Blogspot and a GeoCities page. The algorithm is
  correct and easily verified in code — just don't footnote those URLs in your brief.
- One citation is an arXiv link dated 2604. Ignore it.
- C&D §2.3's Latanya Sweeney re-identification work (87% from ZIP+DOB+gender) **is** real and
  well-known. Safe to cite. It's your justification for treating quasi-identifiers as PHI —
  a genuinely sophisticated point most candidates will miss.

---

### The "3-second cliff" does not exist

C&D §3.2 claims users abandon after waiting >3 seconds for a bot reply. Agent F: **no study
links a 3s chatbot delay to any abandonment rate, in health or anywhere else.** Drop the number.

What the literature actually supports, and what to set your timeouts to:

- **Nielsen's limits:** 0.1s instantaneous · **1.0s keeps flow of thought** · **10s is the limit
  of attention** (past that, show a progress estimate). Canonical HCI.
- **Gnewuch et al. 2022** (*BISE* 64(6), N=202, peer-reviewed): a 2.3s delay *raised* social
  presence for novices (b=0.69) but **lowered it for experienced users** (b=−0.51).

**Budget: p50 < 1s, p95 < 3s, indicator from ~400ms, "still working" before 10s, hard fallback
at 10s.** And **do not add artificial delay** — it backfires on experienced users, which by 2026
is most people. This also overrides C&D §3.4's typing-indicator advice, which was directionally
right for the wrong reason.

### D7. The research argues *against* a human-like persona

C&D §3.1 says trust peaks at a "Goldilocks" level of anthropomorphism. Agent F found harder,
newer evidence pointing further than that:

**Zhu & Broadbent 2025** (*CHB* 169, N=160, randomised): on sensitive items, a realistic virtual
human produced **more socially desirable responding** — lower disclosure, more refusals — than
either a plain text chatbot or an online questionnaire.

Combined with Turner et al. 1998 (computer administration → 3× higher reporting of stigmatised
behaviours), the mechanism is **perceived anonymity, not human-likeness**. People disclose more
when they feel unobserved, and a convincing avatar reintroduces the observer.

**Design implication:** make Nightingale plainly, visibly automated. No avatar, no fake typing
personality, no "I feel for you." Warm, plain, and clearly a machine that routes to humans. This
also aligns with `test_trust` — the honest answer to "are you a real doctor?" is easier to give
when the whole interface has never pretended otherwise.

Cite **Longoni et al. 2019** alongside it: resistance to AI healthcare drops when the AI is
framed as *supporting* a clinician rather than replacing one. That is exactly your product.
**→ `PLANNING.md` §4d and §15.**

---

## Files I generated from the reports

- `config/red_flags.yaml` — merged lexicon from C&D §5.1 + §5.3, with the four brief-mandated
  phrases explicitly covered, plus negation and third-party guards the reports didn't address
- `config/copy_rules.yaml` — banned / caution / safe phrases, empathy rules, crisis resources

Read the header comments in both — I flagged two things the reports missed.
