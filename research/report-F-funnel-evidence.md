# Report F — Funnel Abandonment Evidence Base (verification pass)

The prior pass sourced the funnel table to form-builder marketing blogs (orbitforms.ai,
ovoform.com). Those are not evidence. This pass replaces what can be replaced and marks the
rest unsubstantiated.

Tiers: **PEER-REVIEWED** · **INDUSTRY-BENCHMARK** (published aggregate analytics/survey,
methodology partly disclosed) · **VENDOR-MARKETING** (do not cite).

---

## 1. Form and intake abandonment — verify or replace

**Not one of the five stage-level percentages in the original table can be traced to a credible source; the real evidence that exists is coarser (whole-form, not per-stage) and generally shows *worse* abandonment than the table claimed.**

| Figure | Source | Method / n | Year | Tier |
|---|---|---|---|---|
| Healthcare forms: **44.37% overall completion** of started sessions (desktop 49.87%, mobile 40.82%, tablet 37.04%); healthcare has the **lowest view-to-completion of any sector, 21.4%** | [Zuko Analytics industry benchmarking](https://www.zuko.io/benchmarking/industry-benchmarking) | 727,492 healthcare sessions; 93,022,997 all-sector (all-sector completion 51.71%) | 2025 | INDUSTRY-BENCHMARK |
| **70.22%** average documented cart abandonment | [Baymard Institute](https://baymard.com/lists/cart-abandonment-rate) | Meta-analysis of 50 studies | 2026 ed. | INDUSTRY-BENCHMARK |
| Reasons for abandonment (excl. "just browsing"): extra costs **40%**, distrust of entering card **19%**, **site wanted account creation 18%**, checkout too long/complicated **17%** | [Baymard](https://baymard.com/lists/cart-abandonment-rate) | Baymard survey; **sample size NOT DISCLOSED on the public page** (secondary sites claim 4,329 US adults — unverified) | 2024–26 | INDUSTRY-BENCHMARK |
| **14%** of online shoppers say they would never give a phone number to an online store; **39%** of benchmarked sites require phone with no explanation | [Baymard](https://baymard.com/blog/explain-phone-number-field) | Quantitative study, 1,026 shoppers + large-scale UX testing | pub. 2020, upd. 2025 | INDUSTRY-BENCHMARK |
| Stated length **10 / 20 / 30 min** → **75% / 64.9% / 62.4%** started; **68.2% / 56.8% / 46.8%** completed | Galesic & Bosnjak, *Public Opinion Quarterly* 73(2):349–360, [link](https://academic.oup.com/poq/article-abstract/73/2/349/1939196) | Randomised web-survey experiment | 2009 | PEER-REVIEWED |
| Web/mobile survey breakoff ranges **0.4%–30.9%** | Mavletova & Couper, [record](https://www.semanticscholar.org/paper/A-Meta-Analysis-of-Breakoff-Rates-in-Mobile-Web-Mavletova-Couper/3d8a2ac8010c70b13c7775dd015e78444a017a28) | Meta-analysis, 14 studies, 39 samples | 2015 | PEER-REVIEWED |
| NHS App: **8,524,882 downloads vs 4,449,869 registrations** (~52%) | KC S, Tewolde S, Laverty AA et al., *Br J Gen Pract* 73(737):e932–e940, doi:10.3399/BJGP.2022.0150, [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC10562999/) | Observational, practice-level, Jan 2019–May 2021 | 2023 | PEER-REVIEWED — **caveat below** |

⚠️ Caveat on the NHS App figure: downloads are not unique people, and the paper does not frame
this as an abandonment rate. Use only as an order-of-magnitude illustration that
identity/registration is a large real-world loss point — never as "48% abandon registration."

⚠️ **Progressive profiling (identity early vs late): NOT FOUND.** Every "progressive profiling
lifts completion 35%" figure traces to marketing pages citing a "Marketo Benchmark Report 2024" /
"Eloqua Study 2024" that could not be located. **Treat as fabricated.** The only defensible
identity-timing evidence is Baymard's 18% forced-account-creation figure — e-commerce,
self-reported.

---

## 2. Chatbot response latency

**There is no research supporting a "3-second cliff"; the literature supports a ~1s target, tolerance to roughly 2–4s with a visible indicator, degradation past ~8–10s — and one strong finding that added delay actively hurts experienced users.**

- **Nielsen's three limits — 0.1s (instantaneous), 1.0s (flow of thought uninterrupted), 10s
  (limit of attention; beyond this give a progress estimate).**
  [NN/g](https://www.nngroup.com/articles/response-times-3-important-limits/). Foundational HCI
  (Miller 1968; Card et al. 1991).
- **Gnewuch, Morana, Adam & Maedche (2022), "Opposing Effects of Response Time in Human–Chatbot
  Interaction," *Business & Information Systems Engineering* 64(6):773–791.**
  [AISeL](https://aisel.aisnet.org/bise/vol64/iss6/5/). Lab experiment, **N = 202**.
  Instant = 200–400 ms; delayed = 2.3 s average. Delay raised social presence for **novices**
  (b = 0.69, p < .05, CI [0.14, 1.23]) but *lowered* it for **experienced users**
  (b = −0.51, p < .05, CI [−1.02, −0.01]). Indirect effect on intention to use:
  **+0.45 novices, −0.15 experienced**. Authors state 2.3s "was still rather short" and that they
  could not test overly long delays. PEER-REVIEWED.
- **Gnewuch et al. (2018), ECIS 2018.** [AISeL](https://aisel.aisnet.org/ecis2018_rp/113/).
  Dynamic delays (scaled to message/response complexity) increased humanness, social presence and
  satisfaction vs near-instant. Exact N and delay seconds NOT FOUND in accessible sources.
  PEER-REVIEWED (conference).
- **Miller, Meyer & Smart (2025), Oregon State MS project**,
  [PDF](https://ir.library.oregonstate.edu/downloads/h415pk244). Reports conversation-analysis
  thresholds: pauses >~700 ms read as hesitation, >2 s signal confusion or breakdown; summarises
  prior work where users tolerated up to 4 s with satisfaction dropping sharply approaching 8 s,
  and where up to 20 s stayed acceptable when process indicators were shown.
  ⚠️ Master's project + secondary citation — weakest tier; cite as "reported in the HRI
  literature," not as this study's own result.
- ⚠️ **Health-chatbot-specific latency-to-abandonment threshold: NOT FOUND.** No study measures
  abandonment against response latency in a health or triage chatbot. Any such number is invented.

**Defensible timeout budget:** p50 < 1s, p95 < 3s, typing/progress indicator visible from ~400 ms,
explicit "still working" message before 10s, hard fallback at 10s. **Do not add artificial
delay** — Gnewuch 2022 shows it backfires on experienced users, and by 2026 most users are
experienced.

---

## 3. Disclosure to machines

**Well supported that removing a perceived human observer increases disclosure of stigmatised health information — but the mechanism is perceived anonymity, not "chatbot", and the newest randomised trial finds a human-like agent can make disclosure worse than a plain form.**

### Supporting

- **Lucas, Gratch, King & Morency (2014), *Computers in Human Behavior* 37:94–100.**
  [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0747563214002647).
  **N = 239** adults (18–65). 2 (frame: computer vs human-operated) × 2 (method) design, simulated
  clinic admission. Computer framing → lower fear of self-disclosure, lower impression management,
  more intense sadness displays, higher observer-rated willingness to disclose.
  ⚠️ Exact F/p/effect sizes NOT VERIFIED — full text paywalled. **Do not quote effect sizes.**
- **Lucas, Rizzo, Gratch, Scherer, Stratou, Boberg & Morency (2017), *Frontiers in Robotics and AI*
  4:51**, doi:10.3389/frobt.2017.00051.
  [Full text](https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2017.00051/full).
  Study 1, **N = 24** National Guard: PTSD symptoms to virtual human M = 0.79 vs official PDHA
  M = 0.25, F(1,23) = 7.38, p = .01; vs anonymised PDHA M = 0.33, F(1,23) = 4.84, p = .04;
  official vs anonymised n.s. (p = .66). Study 2, **N = 126**: overall only marginal,
  t(125) = 1.76, **p = .08**; significant only in the subthreshold-PTSD subgroup,
  t(63) = 3.77, p < .001.
  ⚠️ Cite honestly — Study 1 is very small, Study 2's main effect did not reach significance.
- **Turner, Ku, Rogers, Lindberg, Pleck & Sonenstein (1998), *Science* 280:867–873.**
  [PubMed](https://pubmed.ncbi.nlm.nih.gov/9572724/). **N = 1,690**, 1995 National Survey of
  Adolescent Males, randomised audio-CASI vs paper. Reported prevalence of male-male sex,
  injection drug use and sex with IDU partners **higher by factors of 3 or more** under computer
  administration. **Strongest citation available in this whole report.**

### Contrary / qualifying

- **Zhu & Broadbent (2025), *Computers in Human Behavior* 169:108683.**
  [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S074756322500130X).
  **N = 160** randomised to realistic virtual human, text chatbot, or online questionnaire. On
  sensitive items the **virtual human group showed *higher* socially desirable responding** —
  lower loneliness scores, higher rates of declining to answer.
  **Implication: a plain text intake may outperform an anthropomorphic avatar.**
- **Longoni, Bonezzi & Morewedge (2019), *Journal of Consumer Research* 46(4):629–650.**
  [OUP](https://academic.oup.com/jcr/article-abstract/46/4/629/5485292). Nine studies: consumers
  resist AI-delivered healthcare ("uniqueness neglect"); resistance drops when AI is framed as
  personalised or as *supporting* rather than replacing a clinician.

---

## 4. Honesty check — what could not be substantiated

| Original row | Verdict | How to phrase it instead |
|---|---|---|
| Landing / symptom input 15–25% | **Unsubstantiated.** No source. Vendor analytics point to a far larger landing loss in healthcare. | Drop the range. Say: "healthcare forms have the lowest view-to-completion of any sector at 21.4% (Zuko, vendor analytics, 727k sessions)." |
| Authentication 30–50% | **Unsubstantiated.** Nothing close to 30–50% exists for identity capture. | Replace with "18% of abandoning shoppers cite forced account creation" and "14% would never give a phone number" (Baymard, self-reported, e-commerce — label the transfer). |
| Medical history 20–40% | **Partially substantiable, by analogy only.** | "Survey-methodology evidence, not clinic intake: completion fell 68.2% → 46.8% as stated length went 10→30 min (Galesic & Bosnjak 2009)." |
| Triage latency >3s → 10–20% | **Unsubstantiated. NOT FOUND — no study links a 3s chatbot delay to any abandonment rate.** | Delete the percentage. State the design rule instead (Nielsen 1s/10s; Gnewuch 2022 tested 2.3s). |
| Booking / payment 10–15% | **Unsubstantiated for healthcare.** | Drop, or: "directional, e-commerce transfer: 19% cite distrust of entering card details (Baymard)." |

---

## Safe to cite in the brief

1. **Healthcare forms complete 44.37% of started sessions; lowest view-to-completion of any sector
   at 21.4%.** [Zuko Analytics, 727,492 healthcare sessions, 2025](https://www.zuko.io/benchmarking/industry-benchmarking)
   — INDUSTRY-BENCHMARK (vendor analytics; label as such).
2. **Announced form length drives drop-off: completion 68.2% → 56.8% → 46.8% at stated
   10/20/30 minutes.** Galesic & Bosnjak, *POQ* 73(2):349–360, 2009 — PEER-REVIEWED.
3. **18% of abandoning shoppers cite forced account creation; 14% would never give a phone
   number.** [Baymard](https://baymard.com/lists/cart-abandonment-rate) /
   [phone field](https://baymard.com/blog/explain-phone-number-field) — INDUSTRY-BENCHMARK,
   e-commerce.
4. **Latency budget: 1s keeps flow of thought, 10s is the attention limit; a 2.3s chatbot delay
   helps novices but hurts experienced users (N=202).**
   [NN/g](https://www.nngroup.com/articles/response-times-3-important-limits/) — canonical HCI;
   Gnewuch et al., *BISE* 64(6):773–791, 2022 — PEER-REVIEWED.
5. **Computer administration raises reporting of stigmatised behaviours by 3× or more (N=1,690,
   randomised).** Turner et al., *Science* 280:867–873, 1998 — PEER-REVIEWED.
6. **Framing an interviewer as a computer lowers fear of self-disclosure and impression
   management (N=239).** Lucas et al., *CHB* 37:94–100, 2014 — PEER-REVIEWED (direction only,
   not effect sizes).
7. **Counterweight, cite alongside #6:** a realistic virtual human produced *more* socially
   desirable responding than a text chatbot or plain questionnaire (N=160, randomised).
   Zhu & Broadbent, *CHB* 169:108683, 2025 — PEER-REVIEWED.
