import "server-only";

import {
  compileRedFlagIndex,
  containsTerm,
  loadRedFlags,
  normalisePhrase,
  type Severity,
  type RiskLevel,
} from "@/lib/config";

/**
 * THE DETERMINISTIC RISK GATE.
 *
 * This runs BEFORE the LLM on every inbound patient message, and its output can
 * only ever be raised by the model that follows it, never lowered.
 *
 * The reasoning, stated plainly because it is the core architectural claim of
 * the whole build: an LLM classifier catches red flags roughly 99% of the time.
 * For "crushing chest pain" the missing 1% is a person. So a layer with 100%
 * recall on the mandated phrases goes in front, and the model adds breadth on
 * top. Report C&D independently reached the same conclusion — it ranks
 * "ignoring red flags" as the 4th-worst trust breaker and prescribes
 * "deterministic red-flag lexicons that override NLP logic".
 *
 * Everything here is pure and synchronous. No network, no model, no I/O. It
 * cannot time out, cannot rate-limit, and cannot be unavailable — which is the
 * point of having it.
 */

export type DecidingLayer = "deterministic" | "llm" | "merged" | "fallback";
export type Confidence = "low" | "med" | "high";

export interface GuardHit {
  guard: string;
  matched: string;
  effect: "downgrade_confidence" | "annotate_only";
  floor: RiskLevel;
}

export interface DeterministicVerdict {
  riskLevel: RiskLevel;
  severity: Severity | null;
  matchedRuleId: string | null;
  matchedPhrase: string | null;
  system: string | null;
  riskReason: string;
  confidence: Confidence;
  /** Routes to the crisis circuit-breaker instead of standard escalation copy. */
  crisisPathway: boolean;
  showEmergencyBanner: boolean;
  guardsApplied: GuardHit[];
  /** The message is about someone other than the sender. Never downgrades. */
  subjectIsThirdParty: boolean;
  durationMs: number;
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** Risk may be raised, never lowered. This function is the only way to combine. */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

function severityToRisk(severity: Severity): RiskLevel {
  const cfg = loadRedFlags();
  return cfg.severity_levels[severity].risk_level;
}

/**
 * Finds guard patterns near the matched phrase.
 *
 * A guard NEVER suppresses a match. It lowers confidence, annotates the reason,
 * and is bounded by a hard floor. The failure mode we are defending against is
 * a system that decides, on the basis of the word "not", that it can ignore
 * someone mentioning chest pain.
 */
function applyGuards(
  normalisedText: string,
  matchIndex: number,
): { guards: GuardHit[]; thirdParty: boolean } {
  const cfg = loadRedFlags();
  const guards: GuardHit[] = [];
  let thirdParty = false;

  for (const [name, guard] of Object.entries(cfg.context_guards)) {
    const windowTokens = guard.window_tokens ?? 6;

    // Look backwards from the match by a token window. Negation and
    // attribution both appear before the symptom in natural phrasing:
    // "I don't have chest pain", "my father has chest pain".
    const before = normalisedText.slice(0, matchIndex);
    const window = before.split(" ").slice(-windowTokens).join(" ");

    for (const pattern of guard.patterns) {
      const p = normalisePhrase(pattern);
      if (!p) continue;
      if (containsTerm(window, p) || (name === "third_party" && containsTerm(before, p))) {
        guards.push({
          guard: name,
          matched: pattern.trim(),
          effect: guard.effect,
          floor: guard.floor,
        });
        if (name === "third_party") thirdParty = true;
        break;
      }
    }
  }

  return { guards, thirdParty };
}

/**
 * Classify a single message.
 *
 * @param text  The message. May be redacted or raw — this layer never leaves
 *              the process, so it can safely see raw text. Running it on raw
 *              text is in fact preferable: redaction placeholders could in
 *              principle mask a symptom phrase.
 */
export function classifyDeterministic(text: string): DeterministicVerdict {
  const startedAt = Date.now();
  const index = compileRedFlagIndex();
  const normalised = normalisePhrase(text);

  // Index is sorted longest-first, so the first hit is the most specific rule.
  let hit: (typeof index)[number] | undefined;
  let hitIndex = -1;

  for (const candidate of index) {
    const at = normalised.indexOf(candidate.phrase);
    if (at !== -1) {
      hit = candidate;
      hitIndex = at;
      break;
    }
  }

  if (!hit) {
    return {
      riskLevel: "low",
      severity: null,
      matchedRuleId: null,
      matchedPhrase: null,
      system: null,
      riskReason: "No deterministic red-flag or ambiguity pattern matched.",
      confidence: "med",
      crisisPathway: false,
      showEmergencyBanner: false,
      guardsApplied: [],
      subjectIsThirdParty: false,
      durationMs: Date.now() - startedAt,
    };
  }

  const cfg = loadRedFlags();
  const level = cfg.severity_levels[hit.severity];
  let riskLevel = severityToRisk(hit.severity);

  const { guards, thirdParty } = applyGuards(normalised, hitIndex);

  // Confidence, not risk, is what guards move.
  let confidence: Confidence = "high";
  const reasons: string[] = [
    `Matched ${hit.ruleId} (${hit.system}): "${hit.phrase}". ${hit.rationale}`,
  ];

  for (const guard of guards) {
    if (guard.effect === "downgrade_confidence") {
      confidence = confidence === "high" ? "med" : "low";
      reasons.push(
        `Guard "${guard.guard}" matched "${guard.matched}" — confidence lowered, risk floored at ${guard.floor}.`,
      );
      // The floor is a FLOOR, applied with max(). It can raise the result of a
      // downgrade but can never pull the risk below what the rule demanded.
      riskLevel = maxRisk(guard.floor, riskLevel === "high" ? "high" : guard.floor);
    } else {
      reasons.push(
        `Guard "${guard.guard}" matched "${guard.matched}" — annotated, risk unchanged.`,
      );
    }
  }

  if (thirdParty) {
    reasons.push(
      "Subject appears to be someone other than the sender. Risk deliberately NOT downgraded: " +
        "a person asking on behalf of an infant or an elderly parent is among the highest-value " +
        "escalations this product handles.",
    );
  }

  return {
    riskLevel,
    severity: hit.severity,
    matchedRuleId: hit.ruleId,
    matchedPhrase: hit.phrase,
    system: hit.system,
    riskReason: reasons.join(" "),
    confidence,
    crisisPathway: hit.crisisPathway,
    showEmergencyBanner: level.show_emergency_banner,
    guardsApplied: guards,
    subjectIsThirdParty: thirdParty,
    durationMs: Date.now() - startedAt,
  };
}

let clinicalTermsCache: string[] | undefined;

/**
 * Could this message plausibly be about a symptom?
 *
 * Deliberately generous and deliberately dumb. It is not a classifier and it
 * never raises risk on its own. Its only job is to scope the fail-closed rule
 * so that a classifier outage does not turn every question about opening hours
 * into a clinical escalation.
 */
export function hasClinicalSignal(text: string): boolean {
  // Same dev-staleness rule as lib/config.ts: never cache a safety list in
  // development, or an edited YAML silently keeps serving the old terms.
  if (!clinicalTermsCache || process.env.NODE_ENV !== "production") {
    clinicalTermsCache = loadRedFlags()
      .clinical_signal.terms.map(normalisePhrase)
      .filter(Boolean);
  }
  const normalised = normalisePhrase(text);
  return clinicalTermsCache.some((term) => containsTerm(normalised, term));
}

export interface LlmVerdict {
  riskLevel: RiskLevel;
  riskReason: string;
  confidence: Confidence;
}

export interface MergedVerdict extends DeterministicVerdict {
  decidingLayer: DecidingLayer;
  llmRiskLevel: RiskLevel | null;
  /** True when the two layers disagreed. Logged for review; never silences either. */
  layersDisagreed: boolean;
}

/**
 * Combine the deterministic verdict with the model's.
 *
 * final = MAX(deterministic, llm). The model can only ever escalate.
 *
 * When the model is unavailable, `llm` is null and we fail CLOSED: an
 * unclassified message becomes MEDIUM, not LOW. A system that treats silence
 * from its classifier as reassurance is a system that goes quiet exactly when
 * it is under load.
 */
export function mergeVerdicts(
  deterministic: DeterministicVerdict,
  llm: LlmVerdict | null,
  originalText?: string,
): MergedVerdict {
  if (!llm) {
    // Fail closed — but only for messages that could plausibly be clinical.
    // Flooring EVERY message at medium during an outage would bury a real
    // emergency behind thirty price enquiries in the nurse queue, which is the
    // exact failure this product exists to prevent.
    const clinical = originalText === undefined || hasClinicalSignal(originalText);
    const failClosed = clinical
      ? maxRisk(deterministic.riskLevel, "medium")
      : deterministic.riskLevel;

    return {
      ...deterministic,
      riskLevel: failClosed,
      confidence: clinical ? "low" : deterministic.confidence,
      riskReason: clinical
        ? deterministic.riskReason +
          " Risk classifier unavailable and the message carries clinical signal;" +
          " failed closed to medium and offered handoff."
        : deterministic.riskReason +
          " Risk classifier unavailable, but no clinical signal detected;" +
          " held at low rather than escalating an administrative question.",
      decidingLayer: "fallback",
      llmRiskLevel: null,
      layersDisagreed: false,
    };
  }

  const merged = maxRisk(deterministic.riskLevel, llm.riskLevel);
  const disagreed = deterministic.riskLevel !== llm.riskLevel;

  return {
    ...deterministic,
    riskLevel: merged,
    confidence:
      disagreed && deterministic.confidence === "high" ? "med" : deterministic.confidence,
    riskReason: disagreed
      ? `${deterministic.riskReason} Model assessed ${llm.riskLevel} (${llm.riskReason}); ` +
        `took the higher of the two.`
      : deterministic.riskReason,
    decidingLayer:
      deterministic.matchedRuleId && merged === deterministic.riskLevel
        ? merged === llm.riskLevel
          ? "merged"
          : "deterministic"
        : "llm",
    llmRiskLevel: llm.riskLevel,
    layersDisagreed: disagreed,
  };
}

/** Med/High stop advice and trigger Send to Clinic, per the brief. */
export function requiresEscalation(risk: RiskLevel): boolean {
  return risk === "medium" || risk === "high";
}

/** PHI-free audit record. Rule ids and metadata only, never message content. */
export function auditRisk(v: MergedVerdict) {
  return {
    risk_level: v.riskLevel,
    matched_rule_id: v.matchedRuleId,
    deciding_layer: v.decidingLayer,
    confidence: v.confidence,
    crisis_pathway: v.crisisPathway,
    guards_applied: v.guardsApplied.map((g) => g.guard),
    third_party: v.subjectIsThirdParty,
    layers_disagreed: v.layersDisagreed,
    duration_ms: v.durationMs,
  };
}
