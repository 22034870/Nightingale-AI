# Report E — Platform & Legal Gaps

Research date: 2026-09-01. Fills gaps left by `report-A&B.md`. Confidence flags inline.

---

## 1. Meta private reply time window

**All three claims CORRECT — 7 days from comment creation, exactly one private reply per comment, distinct from the 24-hour window. Verbatim on both docs.**

- IG: "The message must be sent within 7 days from when the comment was created"; "Only one message can be sent to the Instagram user who commented"; "Only when the Instagram user responds to the private message can you continue the conversation within the 24-hour messaging window." — https://developers.facebook.com/docs/messenger-platform/instagram/features/private-replies/
- FB: "The message must be sent within 7 days from when the post or comment was created"; "Only one message can be sent to the person who commented." — https://developers.facebook.com/docs/messenger-platform/discovery/private-replies
- Exception: IG Live comments — reply only during the broadcast. Clock runs from the **comment timestamp**, not webhook receipt.

**BUILD IMPLICATION:** Persist `comment_created_time`, enforce a 7-day TTL and a unique constraint on `comment_id` in the outbound queue. A double-fire burns the single allowed reply permanently; a dead-letter replay after day 7 is unrecoverable.

---

## 2. Meta App Review — timeline and dev-mode demo path

**You can demo comment→DM end-to-end today with NO App Review, as long as every account has a role on the app.** Meta's own wording: "unapproved permissions can only be requested from app users who have a role on the requesting app." — https://developers.facebook.com/docs/app-review

- "Apps in Development mode can only request permissions from role users." Roles: Administrator, Developer, Tester, Analytics User. — https://developers.facebook.com/docs/development/build-and-test/app-modes/ , https://developers.facebook.com/docs/development/build-and-test/app-roles/
- **Works in dev mode:** your own IG Business account/Page, real comment, real webhook, real `POST /{comment-id}/replies`, real DM delivered.
- **Does not work:** the general public.
- Timeline: **Meta publishes no SLA.** Third-party 2026 reports: historically 2–7 business days, now ~20 days (https://bundle.social/blog/meta-app-review-20-days); Business Verification threads report 1–2 months stuck (https://communityforums.atmeta.com/discussions/Questions_Discussions/business-verification-stuck-in-review-for-2-months---messenger-webhook-blocked/1369145).
  ⚠️ **Low confidence on the number** — vendor blogs and forum anecdotes, not Meta.

**BUILD IMPLICATION:** Demo on a Development Mode app with a burner IG Business account and judges added as Testers. Budget zero hackathon hours for App Review; treat it as a 3–8 week GTM item including Business Verification.

---

## 3. MAB scope — organic vs paid vs private DM

**(a) Organic clinic posts: IN scope. (b) Automated DM reply and (c) private 1-to-1 chat: outside the approval requirement on the "general public" hook — but this is a reading, not a rule.**

Operative definition, MAS Act 1956 s.2: "'advertisement' includes any notice, circular, report, commentary, pamphlet, label, wrapper or other document, and any announcement made orally **or by any means of producing or transmitting light or sound**" — medium-neutral, catches all digital.

The prohibition (s.4A) bites on "**publication** of any advertisement… which refers to any skill or service relating to the treatment, prevention or diagnosis of any ailment… and which is capable of inducing, or contains an invitation, express or implied, to any person to seek advice of the advertiser," unless MAB-approved. — https://pharmacy.moh.gov.my/sites/default/files/document-upload/medicine-advertisement-sale-act-1956-act-290_1.pdf

**The hook is publicity, not payment** — paid/organic is a distinction the guidelines never draw. MAB Guideline 2.1 governs advertisements "**disseminated to the general public**"; 9.1 extends them to anything "available to the general public in Malaysia (e.g. through the internet)." — https://pharmacy.moh.gov.my/sites/default/files/document-upload/advertising-guidelines-healthcare-facilities-and-services-mab-3.2023.pdf

Two hazards: MMC defines "advertising" as being "made publicly known… for the purpose of obtaining patients," says "touting or canvassing for patients… fall under the definition of advertising and are unethical," and its definition of "Social Media" **explicitly names WhatsApp and Telegram**. — https://mmc.gov.my/wp-content/uploads/2025/09/The-Dissemination-of-Information-by-Medical-Profesionals-Including-on-Social-Media.pdf

⚠️ **No source states private messages are exempt. Medium confidence.**

**BUILD IMPLICATION:** Two content tiers. **Public** (posts, ads, website) = MAB-approved static copy only with KKLIU displayed; the AI never generates it. **Private** (DM) = factual, no cure/outcome claims, no price comparisons, no free offers, no gifts (banned by MAB 5.1/7.1.3/7.2) — and always a **response** to a user-initiated comment, never unsolicited outbound, or it is canvassing.

---

## 4. Telemedicine Act 1997 s.3 — operative text

**Verbatim s.3(1):** "No person other than — (a) a fully registered medical practitioner holding a valid practising certificate; or (b) a medical practitioner who is registered or licensed outside Malaysia and (i) holds a certificate to practise telemedicine issued by the Council; and (ii) practises telemedicine from outside Malaysia through a fully registered medical practitioner holding a valid practising certificate, may practise telemedicine."

Penalty: fine up to RM500,000 or 5 years imprisonment or both. — http://www.commonlii.org/my/legis/consol_act/ta1997113/s3.html (text via https://www.wipo.int/wipolex/en/text/201834)

s.2: "telemedicine" means "**the practice of medicine using audio, visual and data communications**."

### ⚠️ CRITICAL CORRECTION TO REPORT A&B

**Act 564 has never been brought into force.** s.1 says it "shall come into force on a date to be appointed by the Minister by notification in the Gazette"; no notification has been made. — https://www.commonlii.org/my/legis/consol_act/ta1997yif269/ ; https://en.wikipedia.org/wiki/Telemedicine_Act_1997

Report A&B cites this Act as binding law with "High" confidence. That is wrong.

**Inside or outside the restriction? Outside, on two independent grounds.**
1. Not in force — s.3 creates no live offence.
2. Even if in force, the restricted act is "the practice of medicine"; supplying service/price/location facts and collecting intake answers is not diagnosis, prescription or treatment.

The live constraints are the **Medical Act 1971** (holding out as a practitioner) and **MMC's Telemedicine Guideline**.

**BUILD IMPLICATION:** Cite the Medical Act + MMC guidance as governing, not Act 564 — a brief leaning on an un-commenced statute is a hole a judge will open. Hard-block diagnosis, triage severity and medication advice; route to "a doctor will confirm at your appointment."

---

## 5. Google Ads healthcare certification — Malaysia

**A Malaysian private clinic advertising its own clinical services needs NO Google healthcare certification.**

Certification covers six categories only: prescription drug services providers, pharmaceutical manufacturers, government/non-profit health advocacy orgs, addiction services providers, health insurance (US), FDA cell/gene therapy licensees (US). — https://support.google.com/google-ads/troubleshooter/6099627 , https://support.google.com/adspolicy/answer/176031

For Malaysia the policy page lists certification for **pharmaceutical manufacturers** only, and allows OTC medicine promotion "in accordance with the local law in Malaysia." Malaysia is absent from the certification application country list — a mild inconsistency between the two Google pages. ⚠️ Medium confidence, immaterial for a clinic.

Restricted claims: nothing implying a product is as effective as a prescription drug; no non-government-approved products marketed as safe/effective to prevent, cure or treat disease; no unapproved substances; speculative/experimental treatments prohibited. Google's personalised-advertising rules also bar remarketing on inferred health conditions.

**BUILD IMPLICATION:** The real Malaysian gate on paid search is MAB/KKLIU, not Google. Store `kkliu_number` + expiry (3-year validity) per creative and block publish without it.

---

## 6. PDPA cross-border transfer to a US LLM API

**Redaction alone is NOT sufficient. The architecture is strong risk reduction, but a lawful transfer basis is also required — cheapest is explicit consent at chat start, backed by a DPA + SCCs.**

### (a) Does redacted text still count as personal data?

Only *truly anonymised* data escapes. PDPA s.4: personal data is information relating to a subject "who is identified or **identifiable** from that information **or from that and other information in the possession of a data controller**." The clinic must retain the mapping from `PATIENT_1` back to a name in order to book them — so the pseudonymised payload remains personal data in the controller's hands. Free-text symptom narrative is also **sensitive personal data** (physical/mental health). — https://www.dlapiperdataprotection.com/index.html?t=law&c=MY

### (b) What makes the transfer lawful?

The **whitelist was abolished** by the Personal Data Protection (Amendment) Act 2024 (Act A1727); amended s.129 took effect **1 April 2025**; Guideline 03/2025 issued 29 April 2025.

- **Limb (i)** — destination has "substantially similar" law or "adequate level of protection". The US does not, and Malaysia publishes no adequacy list, so **this limb fails for US endpoints**.
- **Limb (ii)**, s.129(2)/(3) exceptions — **explicit consent** (recorded, with a notice naming the class of third parties and the purpose), contract necessity, or **"all reasonable precautions and due diligence"** evidenced by BCRs, ASEAN Model Contractual Clauses or EU SCCs, plus a Transfer Impact Assessment valid 3 years.

— https://www.mayerbrown.com/en/insights/publications/2025/07/from-legislative-reform-to-practical-guidance-key-amendments-to-malaysias-pdpa-and-the-launch-of-cross-border-transfer-guidelines , https://cms.law/en/sgp/legal-updates/malaysian-guidelines-on-cross-border-data-transfers

### (c) Does a Singapore/Malaysia endpoint change the analysis?

**Yes, materially.** Malaysia in-region = no s.129 question at all. Singapore = still cross-border, but limb (i) becomes *arguable* (Singapore PDPA 2012 is a plausible "substantially similar" finding) instead of dead.

Note: AWS Bedrock exists in ap-southeast-5 (Malaysia) but Claude is **not** served in-region there; nearest Claude-serving Bedrock region is Singapore `ap-southeast-1`. — https://modelavailability.com/platforms/aws/regions

**BUILD IMPLICATION:** Do all three, cheapest first.
1. Keep PHI redaction — it is the due-diligence evidence and caps breach blast radius.
2. Add a one-tap consent gate as message one of every chat naming "AI processing by overseas service providers"; store `consent_id + timestamp + notice_version`.
3. Make the LLM endpoint a **config value** defaulting to Bedrock `ap-southeast-1` — one line that moves you from failed limb (i) to arguable limb (i).

TIA and SCC/DPA go in the roadmap appendix, not the 48 hours.

---

## 7. The channel nobody pitches: an inbound-only Telegram bot

**Telegram Bot API — green on all four axes, and the only rich chat channel shippable end-to-end in 48 hours with zero platform approvals.**

Policy basis:
1. **Platform** — the Bot API is open, needs no app review, no business verification and no message templates, and a bot *cannot* message a user who has not pressed Start, so the platform itself enforces user-initiation.
2. **Legal** — patient-initiated and 1-to-1, so it is not "disseminated to the general public" under MAB Guideline 2.1 and needs no KKLIU for conversational content, while PDPA consent is captured in the first turn rather than assumed.
3. **Trust and reach** — roughly 8–10 million Malaysian users, second only to WhatsApp, so it is familiar rather than novel. — https://hashmeta.com/blog/telegram-statistics-southeast-asia-complete-growth-market-analysis/

Caveat: MMC's 2025 guideline names Telegram inside its "Social Media" definition, so gap 3's content rules apply in-bot. ⚠️ Reach figures are vendor estimates — low confidence on the number, high on the ranking.

**BUILD IMPLICATION:** Ship Telegram as the working demo channel with IG/WhatsApp as the same adapter behind a channel interface, gated on approvals. It is the difference between demoing a real conversation and demoing a mock.
