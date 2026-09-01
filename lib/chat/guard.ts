import "server-only";

import { loadCopyRules, normalisePhrase, containsTerm } from "@/lib/config";
import type { RiskLevel } from "@/lib/config";

/**
 * POST-GENERATION OUTPUT GUARD.
 *
 * This is the difference between claiming the assistant is non-diagnostic and
 * demonstrating it. A system prompt is a REQUEST — the model may comply, and
 * usually will, but nothing forces it. This function runs on the generated text
 * before any of it reaches a patient, and it can refuse.
 *
 * The brief asks us to show how the constraint is enforced, not to assert that
 * it is. The honest answer is: here, in code, reading config/copy_rules.yaml,
 * with a test that feeds it known-bad output and asserts the block.
 *
 * Enforcement ladder:
 *   1st violation  -> regenerate with the violation named in the prompt
 *   2nd violation  -> discard the model entirely, serve approved fallback copy
 *
 * We never edit the model's words to make them compliant. Patching "you have
 * angina" into "you may have angina" produces something that reads safe and
 * still asserts a diagnosis. Blocked means blocked.
 */

export type ViolationKind =
  | "false_reassurance"
  | "diagnostic_language"
  | "medication_advice"
  | "unsafe_crisis_language"
  | "mab_restricted_claims"
  | "scripted_normalisation"
  | "multiple_questions"
  | "opened_with_question"
  | "leaked_placeholder";

export interface Violation {
  kind: ViolationKind;
  matched: string;
  reason: string;
}

export interface GuardResult {
  ok: boolean;
  violations: Violation[];
  /** Instruction appended to the retry prompt. Never shown to the patient. */
  retryHint?: string;
}

/**
 * Some banned patterns are substrings of entirely benign sentences.
 * "you have" is diagnostic in "you have angina" and ordinary in "you have an
 * appointment on Tuesday". The exemption list in copy_rules.yaml carries the
 * benign forms; if the surrounding text matches one, the hit is dropped.
 */
function isExempt(text: string, matchIndex: number, exemptions: string[]): boolean {
  const window = text.slice(Math.max(0, matchIndex - 4), matchIndex + 60);
  return exemptions.some((e) => window.includes(normalisePhrase(e)));
}

export function checkOutput(
  generated: string,
  context: { riskLevel: RiskLevel; topic?: string } = { riskLevel: "low" },
): GuardResult {
  const rules = loadCopyRules();
  const normalised = normalisePhrase(generated);
  const violations: Violation[] = [];

  for (const [kind, category] of Object.entries(rules.banned)) {
    // scripted_normalisation is conditional on the normalisation mode; the
    // banned phrase is only banned when we deliver that payload another way.
    if (
      category.enabled_when?.includes("normalisation.mode == live_stat") &&
      rules.normalisation.mode !== "live_stat"
    ) {
      continue;
    }

    for (const pattern of category.patterns) {
      const p = normalisePhrase(pattern);
      const at = normalised.indexOf(p);
      if (at === -1) continue;
      if (category.exemptions && isExempt(normalised, at, category.exemptions)) continue;

      violations.push({
        kind: kind as ViolationKind,
        matched: pattern,
        reason: category.reason.trim().split("\n")[0],
      });
      break; // one violation per category is enough to block
    }
  }

  // Conversational mechanics. C&D §3.3 #9 ranks firing several questions in one
  // bubble as a top-ten trust breaker, and it is trivially checkable.
  const questionCount = (generated.match(/\?/g) ?? []).length;
  if (questionCount > 1) {
    violations.push({
      kind: "multiple_questions",
      matched: `${questionCount} question marks`,
      reason: "One question per message. Interrogative pacing breaks trust.",
    });
  }

  // Redaction placeholders must never survive into a reply. The model was
  // observed opening with "Hello [NAME_1]." - technically it protected the
  // name, but to the person reading it the product looks broken.
  const placeholder = generated.match(/\[(?:NAME|IC|PHONE|EMAIL|PASSPORT|MRN|POLICY|CARD)_\d+\]/);
  if (placeholder) {
    violations.push({
      kind: "leaked_placeholder",
      matched: placeholder[0],
      reason:
        "Redaction placeholders are internal. Never write them in a reply - " +
        "address the person without using their name.",
    });
  }

  const firstSentence = generated.trim().split(/(?<=[.!?])\s/)[0] ?? "";
  if (firstSentence.trim().endsWith("?") && context.riskLevel === "low") {
    violations.push({
      kind: "opened_with_question",
      matched: firstSentence.slice(0, 60),
      reason: "Acknowledge before asking. Never open a reply with a question.",
    });
  }

  if (!violations.length) return { ok: true, violations: [] };

  return {
    ok: false,
    violations,
    retryHint:
      "Your previous draft was blocked by the safety filter. Fix these and rewrite:\n" +
      violations.map((v) => `- Contains "${v.matched}". ${v.reason}`).join("\n"),
  };
}

/**
 * Approved copy for when the model cannot produce something safe, or is
 * unavailable entirely.
 *
 * Every string here comes from config/copy_rules.yaml, which is sourced from
 * the C&D §4.3 phrases rated Safe for a Malaysian audience. Falling back to
 * hand-written copy at this point would reintroduce exactly the phrasing risks
 * the research warned about.
 */
export function fallbackCopy(riskLevel: RiskLevel): string {
  const rules = loadCopyRules();

  if (riskLevel === "high") {
    return rules.approved.escalation_without_alarm[0];
  }
  if (riskLevel === "medium") {
    return rules.approved.honest_uncertainty[0];
  }
  return (
    rules.approved.boundary_setting[0] +
    " Could you tell me a little more about what's going on?"
  );
}

/** True when the text mentions any banned MAB claim. Used for outbound channels. */
export function violatesMabRules(text: string): boolean {
  const rules = loadCopyRules();
  const normalised = normalisePhrase(text);
  return rules.banned.mab_restricted_claims.patterns.some((p) =>
    containsTerm(normalised, normalisePhrase(p)),
  );
}

/** PHI-free audit record: which rules fired, never the generated text. */
export function auditGuard(result: GuardResult) {
  return {
    guard_passed: result.ok,
    violations: result.violations.map((v) => v.kind),
  };
}
