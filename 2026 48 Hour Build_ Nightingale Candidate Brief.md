**48 Hour Build: Nightingale Candidate Brief**

**Goal:** Build a secure first-touch-to-care PWA that connects the first clinic inquiry (Instagram, TikTok, Google, website) into an authenticated messenger that conversationally ingests patient concerns, extracts structured facts (Memory), and hands off to a human clinician when necessary (Escalation). 

It should be easy to use for the patient, as intuitive as Whatsapp, Wechat, Facebook Messenger, while enforcing healthcare‑grade constraints around **latency, privacy, consent, access control, and provenance**. We are evaluating your ability to ship a **real, production‑credible vertical slice** that could be deployed in a clinic next week. 

Clinics pay to acquire prospects on social media and web platforms. Today, these prospects message across scattered platforms or are funneled into WhatsApp, then wait for staff communication and eventually disappear if the response is slow, difficult or asks for too much too early. Your build must catch prospects when they comment or inquire in milliseconds. Catch that moment, then provide immediate, trustworthy and delightful value, so that an anonymous stranger feels comfortable sharing and voluntarily develops a secure, longitudinal patient relationship with a hospital/clinic partner that values them. **Spend your time fine tuning the handoffs where trust breaks and the prospect leaves.** 

**Product Journey**

Click an Ad, Post or Link on a channel: Instagram, Google, TikTok, Google Reviews, Website, Staff  
⬇️  
Initial LeadSession (provide an answer or value without requiring immediate signup, PHI redaction)  
⬇️  
Trust Transition (i.e. “Continue securely to send this to the clinic” or something better)  
⬇️  
Authentication \+ Consent (Initial LeadSession \-\> PatientSession, provenance intact)  
⬇️  
Patient Intake Chat (risk gating, Memory, citations, robust PHI redaction)  
⬇️  
Send to Clinician (complete escalation payload, persisted) 

**Product Requirements**

1\) Channels & Attribution

Simulate acquisition. Real Meta/TikTok integration is bonus. Try to integrate, but if you get stuck, tell us where. **Implement staff\_referral and social\_comment** \+ at least two of the other four contracts below:

**– staff\_referral (mandatory)** a care-team member (clinician, nurse or staff)  types a topic ("asked about egg freezing at today's visit"); the generated personal link opens the portal with that context pre-loaded. This is how in-person visits and phone calls feed the funnel and cues LeadSession with staff\_referral.  

– **social\_comment (mandatory)** platform identified as Instagram\_comment, Tiktok\_comment, Facebook\_comment. Determine if a webhook fires when someone comments on the clinic/hospital’s post and cues the automated private-reply DM that contains a Nightingale portal link. Can likes ever trigger contact creatively? You know the prospect's handle, not their email or phone, so a rule should treat this identity level accordingly. 

**– instagram\_ad\_click / google\_ad\_click** — anonymous, with campaign context.  
– **lead\_form** — identified: arrives with a volunteered email. 

**– google\_reviews** — if anonymous: the clinic's public review reply carries an "ask us" link.

– **website\_widget** — anonymous, with page/topic context.

Each arrival creates a LeadSession retaining full attribution (clinic\_id, source\_channel, campaign\_id, creative, identity\_level, landing\_timestamp). Attribution must survive to the final PatientSession & escalation payload.

## **2\. Guest Value & the Scope Boundary**

Think of how much you hate chatbots and signing up for things before knowing what you will get. LeadSession visitors should get trustworthy, useful and delightful answers without an account: services, hours, availability, general education, remain strictly **non-diagnostic** and include a **value\_event** 

Invent your own **value\_events** 

(A) many people considering care need help articulating their concern. Draft a 240 character message that the prospect can choose to share privately or publicly i.e. “We know it’s hard to talk about \<context healthcare issue\> so here’s a \<contextual medical fact\> \+ \<common responses and questions\> and a kudos for doing something about it instead of waiting.” 

(b) “14 people asked this clinic a question this week.” Know that such number statistics shown to a prospect must resolve to a live query on the system's own data. If the query\_count is zero or trivial, show nothing or a truthful alternative, never a fake number which is gimmicky. 

Boundary: Enforce PHI redaction before patient-specific clinical intake goes to LLM. Read more on how critical PHI is and its redaction criteria. If a guest volunteers sensitive information: encrypt it, and hide it from staff until consent.Destroy guest data every X days and justify keeping any PHI-free guest metadata for i.e. abandonment analytics (why didn’t they sign up?). Rate-limit guest sessions against abuse.

## **3\. Channel Rules**

A declarative configuration (one file or table, not scattered if-statements) maps channel × identity\_level × time\_of\_day to an opening strategy. Observable minimum: the same message from two channels gets channel-appropriate openings; an identified lead is never asked for what they already provided. Intent-based rules are a bonus.

## **4\. Conversion & Identity**

Authentication triggers on value or clinical intent, not immediately with page-landing. Don’t make guests sign up for something unless they get value first from (Section 2). Then show them, “Continue securely to send this to the clinic” or **invent something better here**. On continue: authenticate, obtain consent to share healthcare info with clinic name, migrate permitted guest context into the PatientSession, preserve provenance to the original guest messages and acquisition source. The patient never repeats what they already said.

•    **Identity:** collect verified email (login identifier) and phone (contact point) at signup. Can store social handles (instagram, tiktok, etc.) Primary key is an immutable internal ID — design the schema so either contact point could change without breaking history; implementing the change flow is optional. 

•    **The earned email:** pre-signup, offer something personal in exchange for an email. Here is an example: "Want me to email you a summary of this conversation plus 6 valuable questions people often forget to ask the doctor?" Derived from their session, not a generic PDF. That send is transactional; anything further requires a separate, timestamped marketing-consent checkbox. Redact PHI from email. 

•    **Session recovery:** an abandoned guest returns via link with context intact within your determined days from (Section 2); can an interrupted signup complete correctly?

## **5\. Funnel Events & Warm Leads**

Emit structured events: visitor → conversation\_started → value\_event → auth\_started → consented → patient\_created → escalation\_sent. A value\_event is a turn where the system delivered substantive help (answered a service question, produced a summary, prepared questions). Define and log yours explicitly. Display simple conversion metrics per channel; a full dashboard is bonus.

**Warm-lead view:** rank leads by a simple transparent score (recency, channel, identity\_level, funnel stage) with each lead's top concern, so the clinic knows who requires a more personal touch. Contact suggestions only where contact info and consent exist. The safety rule: high-risk clinical content routes to escalation, never to a sales touch — a high score on a clinical concern is a compassion priority, not a sales priority. Composite weighting and decay curves are bonus. 

6\. Patient Intake Chat 

* ## **Interface:** a patient chats with “Nightingale AI” 1x1 in a messenger-style thread. 

* ## **Medical Tuning:** The AI must be empathetic, but strictly non-diagnostic 

- [ ] No diagnoses (“you have X”)  
- [ ] No medication changes  
- [ ] No treatment plans beyond general info \+ “consult clinician”  
- [ ] No false reassurance on high-risk symptoms

* ## **Risk Gating:** For every patient message, system should calculate risk\_level (Low/Med/High) before responding, risk\_reason (short explanation), confidence ∈ {low, med, high} for the assistant’s response, risk\_provenance (time stamp)

- [ ] Low Risk: Provide education/support with citations.  
- [ ] **Med/High Risk:** Stop advice. Trigger Send to Clinic (see Section 8\)  
* Your build must not miss any of these as High: "crushing chest pain", "difficulty breathing", "heavy bleeding", "want to hurt myself". Ambiguous symptoms ("my chest feels funny") must escalate or honestly express uncertainty. Clearly below the text box in the messenger, there should be a statement regarding “If this is an emergency, exit Nightingale and dial 999 for Emergency Services.”

#### **7\. Living Memory (Fact Extraction \+ Mutation)**

## The system must maintain a "Patient Profile" (sidebar/state) that updates live.

* **Extraction:** As chat progresses, the system must extract structured facts (minimum set):

- [ ] ## Chief complaint

- [ ] ## Key symptoms (+ timeline if present)

- [ ] ## Current medications

- [ ] ## Allergies (if present)

* ## **Mutation:** When the patient corrects something, the profile must update accordingly with an unbroken provenance chain.    *Example:* "I take Advil." → Meds: \[Advil (Active)\].    *Correction:* "Actually I stopped last week." → Meds: \[Advil (Stopped Timestamp)\].

* ## **Data Model Requirement:** Memory items must include value, status, provenance\_pointer(link to source message), and updated\_at. This is what proves you can build a dynamic medical history, not a static chat log. Guest facts that survive conversion keep their original GuestMessage provenance. Conflict flagging on contradictions is bonus.

## 8\. **Send to Clinic** 

## When risk\_level is **High** OR **Medium/Ambiguous** or when patient is sounding unsure, wanting more clarity or a diagnosis, AI shows a single clear action: **"Send to Nurse/Clinic"**. The payload must include: Triggering message, Triage Summary (1-5 bullets), and Profile Snapshot, provenance points, context from Section 1\.  It should show a confirmation and a response expectation (12 to 18 hours). After message is sent to clinician, patient and AI can continue chatting. The record must let a clinician begin a structured review without the patient repeating their story. Design the schema for that stage (status field, room for ClinicianResponse).

## **Technical Constraints and Architecture:** 

* ## **Access Control RBAC:** Enforced server-side. Guest or Patient cannot access patient data or other LeadSessions. Patient A cannot reach Patient B; users must authenticate before accessing the PWA. Unauthorized access attempts must be rejected server‑side. Staff, Clinicians and Nurses can log in to view warm-lead views, perform  staff actions from Section 1, etc. You must demonstrate how access control is enforced (RLS, middleware, backend checks, etc.).

* ## **Privacy and Security:** Synthetic Data Only. Include a No PHI Redaction Pipeline: You must redact names, IC/ID numbers, and phones *before* sending text to the LLM. TLS in transit \+ encryption at rest. 

* **Explainable handoffs** i.e. when and how a LeadSession becomes a PatientSession.  
* **Audit Logs:** Must be PHI-free (IDs/hashes/metadata only). No raw message content in database logs. Structured logs (JSON) for all events.   
* **Failure modes:** document what happens when the LLM times out, redaction fails, or auth is down.   
* **Tech Stack:** Choose whatever gives you speed to bring idea to execution. Python/Node suggested. Any LLM. PWA must be mobile-responsive.   
* Voice Readiness: You do not need to build audio recording, but your **Database Schema** must have fields to support audio transcripts/IDs for future integration. 

---

## **Required Micro‑Tests:** Include automated tests and how to run tests steps:

1. ## **Test\_guest\_to\_patient\_conversion.py**

   ## guest arrives via source=instagram\&campaign=ivf\_over40, states a concern; after auth \+ consent the context appears in the PatientSession, provenance resolves to the original GuestMessage, attribution retained, concern never re-asked.

2. ## **test\_value\_events.py**

##       every statistic traces to a live query i.e. “14 people asked this clinic a question this week.” Generated value  messages are tracked and validated for accuracy . 

3. ## **test\_escalation\_payloa.py**

   ## Send to Clinic persists triggering message, triage summary, profile snapshot, provenance, and acquisition context.

4. ## **test\_risk\_escalation.py**

* ## Input: “I have crushing chest pain.”

* ## Assert:

- [ ] ## risk\_level \== high

- [ ] ## AI does **not** provide advice

- [ ] ## escalation\_required \== true

5. ## **test\_memory\_mutation.py**

* ## Turn 1: “I take Advil.” → Profile contains meds: Advil (active)

* ## Turn 2: “Actually I stopped last week.” → Profile meds: Advil removed or marked stopped

* ## Assert provenance links exist for both states

6. ## **test\_redaction.py**

* ## Input: “My name is John Doe and my IC is S1234567A.”

* ## Assert the LLM input contains \[REDACTED\] for those fields

* ## Assert logs do not contain the raw values

7. ## **test\_access\_control.py**

* ## Patient A cannot fetch Patient B chat history

* ## Patient cannot fetch clinician triage queue

* ## Clinician, Staff, Nurse access can see all consented patients. 

8. **test\_trust**  
   If a guest asks "Are you a real doctor?" they should get a precise, honest answer: what the AI is, what the clinic is, when a human gets involved.

## Bonus tests: channel rules differentiation; session recovery; staff-referral context prefill; warm-lead-score behavior; grounding (citations resolve to real spans); re-engagement consent (no recall without recorded marketing consent). More tests confirm what you have built matches your intention. 

---

## **Deliverables**

1. ## Git repository with:

   ## o   working application

   ## o   tests

   ## o   clear commit history

2. ## README with setup & run instructions, how to run tests, where redaction happens, RBAC enforcement.

3. ## Technical Brief (2–3 pages)covering:

   ## o   architecture: DIagram or explanation

   ## o   data schema: How Messages ↔ Profile ↔ Citations ↔ Escalations are linked and how a clinician module that  receives messages can be attached later. 

   ## o   channel considerations: classify every channel you considered and new ones that few have considered before. Discuss ethics in competitor-review scraping, health-thread DMs, condition-based retargeting  as green/yellow/red on four axes: technically possible; legal under PDPA and Malaysia's MAB healthcare-advertising rules; permitted by platform policy; trust-compatible. Implement only greens and consider how yellows can be improved. A red channel implemented, however well-coded, loses points. 

   ## o   Assumptions or your First-principles thinking

   ## o   Trade‑offs/scope: what you cut and why

   ## o   VoiceAI strategy: how audio would slot into this schema

4. ## ATTRIBUTION.txt listing all external libraries, models, and licenses

5. ## Demo Video (3 mins max) see scenarios below for ideas

## Recommended Demo Scenarios:

1) ## Scenario A  **Instagram to Patient:** campaign click → useful guest exchange → value-based invitation → auth \+ consent → context arrives in the Profile, updating live during intake.

2) ## Scenario B **Risk Gate & Handoff:** high-risk symptom → AI stops → Send to Clinic → show the persisted Escalation record and honest confirmation.

3) Scenario C **The Warm Handoff:** staff types "asked about egg freezing at today's visit"; the patient's link opens already knowing the topic.  
4) Scenario D **Conversion Intelligence:** funnel metrics per channel and the warm-lead view; explain where users abandon and what you delayed until authentication.  
5) Other scenarios you want to show. 

## **Scoring (30 pts)**

* **Acquisition \+ Trust Funnel (6):** channel contracts incl. staff\_referral; rules config; value\_events; honest numbers; earned email; warm-lead view; a defensible guest/clinical boundary; attribution end-to-end; session recovery.  
* **Memory & provenance (6):** Trustworthy, empathetic UX/API with provenance\_id. Does the schema support structured facts? Are they mutable with provenance-linked context?  
* **Creativity & product fit (6):** Solves a real step from the problem statement or non-negotiables above i.e. Does the "Escalation" feel seamless? Does the AI handle medical ambiguity safely? Even better if your build invalidates a non-negotiable with a better consideration. Don’t respect us, challenge us.    
* **Speed & architecture (4):** Minimal moving parts; clear, simple schema i.e Is the "Living Profile" implementation robust?   
* **Intake \+ Risk Gating (3):** non-diagnostic conversation; no missed emergency phrases; honest handling of ambiguity.  
* **Security & safety (3):** Auth & Consent enforced; redaction works; no PHI in logs.   
* **Communication (2):** Brief is tight, demo is crisp; constraints & trade-offs explicit.   
* **Bonus: Nightingale Alignment (10):** implementing real WhatsApp, Meta, Tiktok, Instagram integration. social\_comment DM delivers **value\_events (see Section 2\)** i.e. Family Communication Kit: a personal, research-grounded, unbranded note the person can forward to family. Bonus for dormant-lead lifecycle (active → cooling → dormant → one consented recall → suppressed, risk-aware); full engagement-score composite with decay; intent-based rules; conflict flagging; synthetic-traffic replay; Bonus for integration with current Voice schema thinking or clinical summary generation. Bonus especially for convincingly invalidating one of our assumptions on this challenge. 

## **Timeline & submission**

* **Due:** **Thurs, Sep 3 2026, 1:00 PM SGT/MYT**   
* **Submit:** email your **repo link (or zip)**, **brief** and **deliverables**  to [**irakumar@ntngale.com**](mailto:ira.kumar@ntngale.com)**,** (cc [yunxint@sunway.edu.my](mailto:yunxint@sunway.edu.my) ), **Subject:** Nightingale 48HR Build — \<Your Name\>

## **Tools & data**

* Use any resources (ChatGPT, coding copilots, open-source models, etc). Can use synthetic data sets. Your presentation, creativity, and brief will give us strong clues about how much you care. If this problem *doesn’t* pull you in, go solve another problem.   
* Don’t build a generic messenger application or an inquiry bot. Think about the psychology behind the build. We trust LLMs but up to a point and then we need reassurance and validation from clinicians/staff. How do we build a system for that?

*Candidates pro-tip: Focus on the core problems and build a working prototype that is actually safe and useful. Ask yourself: would you or your family use it? Clarity and relentlessness beat polish. If you get stuck, keep asking questions and keep building. **A great build has your purest intention and is a gift to the universe.***   
