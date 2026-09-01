/**
 * SEA identifier patterns for the redaction pipeline.
 *
 * These were rebuilt rather than copied. The deep-research report's regex table
 * was mangled by markdown (alternation pipes broke the table cells), and its own
 * notes flagged several of the surviving patterns as HIGH false-positive risk.
 * Where a checksum or a structural check can distinguish a real identifier from
 * a coincidental digit run, we do that check rather than accepting the noise.
 *
 * Ordering matters. Patterns run most-specific first so that a Singapore NRIC is
 * claimed as an NRIC before a looser passport pattern can take it.
 */

export type PiiType =
  | "IC"        // national identity number
  | "PHONE"
  | "EMAIL"
  | "PASSPORT"
  | "MRN"       // medical record / clinic patient number
  | "POLICY"    // insurance policy
  | "CARD"      // payment card
  | "NAME"
  | "ADDRESS"
  | "URL";

export interface PatternRule {
  type: PiiType;
  label: string;
  regex: RegExp;
  /**
   * Type DISAMBIGUATION only — returning false hands the match to another rule
   * that will still redact it. Never use this to suppress redaction outright.
   */
  disambiguate?: (match: string) => boolean;
  /**
   * Soft signal recorded alongside the span. A failing check LOWERS CONFIDENCE;
   * it never prevents redaction.
   *
   * This distinction is the whole lesson of the brief's own test fixture:
   * `S1234567A` is not a checksum-valid Singapore NRIC (the correct check
   * letter is D). An earlier version of this file used the checksum as a gate,
   * so the brief's example sailed through to the model unredacted. Synthetic
   * and mistyped identifiers are exactly the case a health system must still
   * protect — a person who fat-fingers one digit of their IC has not thereby
   * consented to it being sent overseas in the clear.
   *
   * Recall over precision. Always.
   */
  confidence?: (match: string) => boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Singapore NRIC/FIN checksum. Weights 2,7,6,5,4,3,2 over the seven digits;
 * the check letter is drawn from a table selected by the prefix.
 *
 * This is why the SG pattern is low false-positive and the others are not:
 * a random 9-character string passes the regex roughly 1 in 11 times, and the
 * checksum removes almost all of those.
 */
export function isValidSingaporeNric(value: string): boolean {
  const v = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[STFGM]\d{7}[A-Z]$/.test(v)) return false;

  const prefix = v[0];
  const digits = v.slice(1, 8).split("").map(Number);
  const weights = [2, 7, 6, 5, 4, 3, 2];
  let sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);

  // Post-2000 series and the M series carry a constant offset.
  if (prefix === "T" || prefix === "G") sum += 4;
  if (prefix === "M") sum += 3;

  const tables: Record<string, string> = {
    ST: "JZIHGFEDCBA",
    FG: "XWUTRQPNMLK",
    M: "XWUTRQPNJLK",
  };
  const table = prefix === "M" ? tables.M : "ST".includes(prefix) ? tables.ST : tables.FG;
  const expected = table[sum % 11];
  return v[8] === expected;
}

/**
 * Malaysian MyKad is YYMMDD-PB-###G. The research flagged the naive 12-digit
 * pattern as high false-positive against any long number. We reject anything
 * whose first six digits are not a plausible date, which removes most
 * order numbers, reference codes and amounts while costing us nothing real.
 */
export function isPlausibleMyKad(value: string): boolean {
  const d = value.replace(/\D/g, "");
  if (d.length !== 12) return false;

  const month = Number(d.slice(2, 4));
  const day = Number(d.slice(4, 6));
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  // Place-of-birth code. 00 and 83-98 are unassigned in the official table.
  const pb = Number(d.slice(6, 8));
  if (pb === 0 || (pb >= 83 && pb <= 98)) return false;

  return true;
}

/** Luhn, so a payment card is only redacted when it could actually be one. */
export function isValidLuhn(value: string): boolean {
  const d = value.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Patterns — most specific first
// ---------------------------------------------------------------------------

export const PATTERNS: PatternRule[] = [
  {
    type: "EMAIL",
    label: "email",
    regex: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/gi,
  },
  {
    type: "IC",
    label: "sg_nric",
    regex: /\b[STFGMstfgm]\d{7}[A-Za-z]\b/g,
    confidence: isValidSingaporeNric,
    note: "Redacted on shape. Checksum recorded as confidence, never as a gate.",
  },
  {
    type: "IC",
    label: "my_mykad",
    regex: /\b\d{6}[-\s]?\d{2}[-\s]?\d{4}\b/g,
    confidence: isPlausibleMyKad,
    note:
      "Redacted on shape. The DOB + place-of-birth check is recorded but does " +
      "not gate: in a health chat a bare 12-digit run is far more likely an IC " +
      "than an order number, and the cost of the two errors is not symmetric.",
  },
  {
    type: "IC",
    label: "id_nik",
    regex: /\b\d{16}\b/g,
    // Routing, not suppression: if it satisfies Luhn the payment-card rule
    // claims it and it is still redacted, just under the correct type.
    disambiguate: (m) => !isValidLuhn(m),
    note: "16 digits collides with payment card PANs; Luhn routes between them.",
  },
  {
    type: "IC",
    label: "th_national_id",
    regex: /\b[1-8]\d{12}\b/g,
    note: "Thai national ID. Mod-11 check digit exists but is not implemented — low volume for a Malaysia-first launch.",
  },
  {
    type: "CARD",
    label: "payment_card",
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    confidence: isValidLuhn,
  },
  {
    // International first so "+60 12-345 6789" is consumed whole rather than
    // leaving a stray "+60" behind.
    type: "PHONE",
    label: "phone_intl_sea",
    regex: /\+(?:60|65|62|66|63)[-\s]?\d{1,2}[-\s]?\d{3,4}[-\s]?\d{3,5}\b/g,
  },
  {
    type: "PHONE",
    label: "phone_my_local",
    regex: /\b01[0-46-9][-\s]?\d{3,4}[-\s]?\d{4}\b/g,
  },
  {
    type: "PHONE",
    label: "phone_sg_local",
    regex: /\b[89]\d{3}[-\s]?\d{4}\b/g,
    note: "8 digits collides with lab values and clinic IDs. Accepted: over-redaction is cheaper than a leak.",
  },
  {
    type: "MRN",
    label: "mrn",
    regex: /\b(?:MRN|PAT|PATIENT|ID)[-\s#]?\d{4,10}\b/gi,
  },
  {
    type: "POLICY",
    label: "insurance_policy",
    // The identifier portion must contain at least one digit. Without that
    // lookahead the case-insensitive "INS" prefix eats the word "INSurance"
    // itself — "Do you accept AIA insurance?" was being redacted to
    // "Do you accept AIA [POLICY_1]?", which is both wrong and destroys a
    // perfectly ordinary billing question the clinic wants to answer.
    regex: /\b(?:POL|PLY|INS|POLICY)[-\s#]?(?=[A-Z0-9]*\d)[A-Z0-9]{6,12}\b/gi,
  },
  {
    type: "PASSPORT",
    label: "passport",
    regex: /\b[A-Z]{1,2}\d{7,9}\b/g,
    note: "Collides with product codes. Runs last so IC/MRN claim their matches first.",
  },
  {
    type: "URL",
    label: "url",
    regex: /\bhttps?:\/\/\S+/gi,
  },
];

// ---------------------------------------------------------------------------
// Names — the hard case
// ---------------------------------------------------------------------------

/**
 * The research is explicit that regex fails for Malaysian names, and it is
 * right. Malay patronymics use `bin`/`binti`, Indian Malaysian names use
 * `a/l`/`a/p`, East Malaysian names use `anak` — and `bin` and `anak` are also
 * ordinary words ("threw it in the bin", "my anak has a fever"). Chinese names
 * romanise inconsistently across dialects and often carry a prepended Western
 * given name.
 *
 * So we do not try to detect names in general. We detect the three contexts
 * where a name is being ASSERTED, which is where names actually appear in an
 * intake chat:
 *
 *   1. Self-introduction  — "my name is X", "nama saya X", "I'm X"
 *   2. Honorific-prefixed — "Dr X", "Encik X", "Puan X", "Mr X"
 *   3. Patronymic-linked  — Capitalised + bin/binti/a/l/a/p + Capitalised
 *
 * Case 3 requires capitalisation on BOTH sides, which is what stops "in the
 * bin" and "my anak" from matching. That specific false positive is in the
 * should_be_low fixtures in red_flags.yaml and is asserted by the test suite.
 *
 * KNOWN LIMITATION, stated honestly in the brief: a bare name volunteered with
 * no context ("This is Ahmad, I have a fever") is not caught by these rules.
 * The mitigation is that names are not required anywhere in the guest flow, and
 * the LLM never receives a message that failed redaction (§11 fail-closed).
 */
export const NAME_PATTERNS: PatternRule[] = [
  {
    type: "NAME",
    label: "self_introduction",
    // The trigger must match regardless of case ("My name is" at the start of a
    // sentence is the common case), but the NAME capture must stay
    // case-SENSITIVE — capitalisation is the only signal separating "I'm Ahmad"
    // from "I'm breathless". So the case-insensitivity is spelled out per
    // trigger rather than applied globally with an /i flag, which would make
    // [A-Z] match everything and cause the rule to swallow ordinary sentences.
    regex:
      /\b(?:[Mm]y name is|[Mm]y name's|[Ii] am|[Ii]'m|[Tt]his is|[Nn]ama saya|[Nn]ama penuh saya|[Ss]aya)\s+((?:[A-Z][\p{L}'-]+)(?:\s+(?:bin|binti|a\/l|a\/p|anak)\s+[A-Z][\p{L}'-]+)?(?:\s+[A-Z][\p{L}'-]+){0,3})/gu,
    note: "Captures the asserted name only, not the trigger phrase.",
  },
  {
    type: "NAME",
    label: "honorific",
    regex:
      /\b(?:[Dd]r|[Dd]octor|[Pp]rof|[Mm]r|[Mm]rs|[Mm]s|[Mm]iss|[Ee]ncik|[Pp]uan|[Cc]ik|[Tt]uan|[Dd]atuk|[Dd]ato'|[Tt]an [Ss]ri)\.?\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,3})/gu,
  },
  {
    type: "NAME",
    label: "patronymic",
    // Capitalisation required on both sides — this is what defeats "in the bin".
    regex:
      /\b[A-Z][\p{L}'-]+\s+(?:bin|binti|bt|a\/l|a\/p|anak)\s+[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?/gu,
  },
];

/**
 * Quasi-identifiers. Not redacted — redacting age and location would destroy the
 * clinical picture — but COUNTED, because Sweeney showed 87% of a population is
 * re-identifiable from date of birth + postcode + gender alone. When several of
 * these co-occur with a rare condition the record is effectively identified even
 * though every explicit identifier was stripped.
 *
 * The pipeline reports a quasi-identifier count so the escalation payload can be
 * flagged for tighter handling. This is the difference between de-identification
 * theatre and actually thinking about re-identification risk.
 */
export const QUASI_IDENTIFIER_PATTERNS: PatternRule[] = [
  { type: "ADDRESS", label: "my_postcode", regex: /\b\d{5}\b/g },
  { type: "ADDRESS", label: "age_statement", regex: /\b(?:i am|i'm|aged?)\s+\d{1,3}\s*(?:years? old|yo|tahun)\b/gi },
  { type: "ADDRESS", label: "locality", regex: /\b(?:Taman|Kampung|Kg\.?|Jalan|Jln\.?|Lorong|Bandar|Mukim)\s+[A-Z][\p{L}]+/gu },
];
