import "server-only";

import { generate, parseJsonResponse, LlmUnavailable, auditLlm } from "@/lib/llm/gemini";
import type { LlmVerdict } from "./gate";

/**
 * THE LLM RISK CLASSIFIER — the second layer, never the first.
 *
 * This exists to add BREADTH the deterministic lexicon cannot have: phrasings
 * nobody thought to write down, symptom combinations that are only alarming
 * together, escalating tone across a conversation. What it must never do is
 * lower a verdict the deterministic layer already reached. That guarantee lives
 * in mergeVerdicts(), not here — this function simply reports what it sees.
 *
 * Design notes that matter:
 *
 *  - Runs on REDACTED text. It is a network call to a third party, so it sits
 *    behind the redaction pipeline like every other model call.
 *  - Constrained to a JSON schema so a prose answer cannot be misparsed into a
 *    risk level. A classifier that fails open because the model got chatty is
 *    not a classifier.
 *  - No thinkingConfig: RISK_MODEL is flash-lite, which rejects it with HTTP
 *    400. See lib/llm/gemini.ts.
 *  - Throws rather than guessing. Callers pass null to mergeVerdicts(), which
 *    fails closed.
 */

const RISK_SCHEMA = {
  type: "object",
  properties: {
    risk_level: { type: "string", enum: ["low", "medium", "high"] },
    risk_reason: { type: "string" },
    confidence: { type: "string", enum: ["low", "med", "high"] },
  },
  required: ["risk_level", "risk_reason", "confidence"],
} as const;

const SYSTEM_PROMPT = `You are a clinical risk triage classifier for a Malaysian private clinic's intake system. You do NOT talk to patients and you do NOT diagnose. Your only job is to rate how urgently a human clinician should see this message.

Rate risk_level using these definitions:

- high: The message describes a potential medical emergency, or symptoms that could indicate one. Includes chest pain, breathing difficulty, major bleeding, stroke signs, anaphylaxis, sepsis signs, obstetric emergencies, paediatric red flags, and any expression of self-harm or suicidal thinking. When a symptom COULD be an emergency, it is high.

- medium: The message describes a clinical concern that needs a human clinician but is not immediately life-threatening, OR is too vague to rule out something serious. Non-localising complaints ("something feels off", "I just don't feel right") are medium, never low.

- low: The message is administrative or informational with no clinical content — opening hours, prices, insurance, directions, appointment logistics, or a general question about a service.

Rules you must follow:

1. Err toward escalation. A false alarm costs a clinician two minutes. A missed emergency costs a life. When genuinely torn between two levels, choose the higher one and say so in risk_reason.
2. A message written on behalf of someone else ("my father has chest pain", "my baby won't wake up") carries the SAME risk as first-person. Never downgrade for third-party phrasing.
3. Negation of a symptom does not clear it. "I don't have chest pain but my arm feels strange" is not low.
4. The text may contain placeholders like [NAME_1] or [IC_1] where personal details were removed before you saw it. Ignore them; they are never clinically relevant.
5. Text may mix English, Bahasa Malaysia and colloquial Malaysian English. Common terms: sakit (pain), dada (chest), sesak nafas / susah bernafas (breathless), demam (fever), pening (dizzy), darah (blood), muntah (vomit), bengkak (swollen), kebas (numb), lemah (weak).
6. risk_reason must be one short sentence, clinical and neutral, naming the specific feature that drove the rating. It is shown to a nurse, not to the patient.
7. Set confidence low when the message is short, ambiguous, or you are unsure. Low confidence is useful information, not a failure.`;

export interface ClassifierResult extends LlmVerdict {
  audit: ReturnType<typeof auditLlm>;
}

/**
 * @param redactedText  Output of the redaction pipeline. Never raw patient text.
 * @param recentContext Optional prior turns (also redacted) so escalating tone
 *                      across a conversation is visible to the classifier.
 */
export async function classifyWithLlm(
  redactedText: string,
  recentContext?: string[],
): Promise<ClassifierResult> {
  const timeoutMs = Number(process.env.RISK_CLASSIFY_TIMEOUT_MS ?? 3000);

  // Same chain reasoning as the chat path. The classifier runs on EVERY
  // message, so it is the first thing to hit a per-minute limit — and the layer
  // we least want to lose, since losing it means falling back to medium on
  // anything carrying clinical signal.
  const chain = (process.env.RISK_MODEL_CHAIN ??
    [process.env.RISK_MODEL ?? "gemini-3.5-flash-lite",
     "gemini-3-flash-preview"].join(","))
    .split(",").map((m) => m.trim()).filter(Boolean);

  const prompt = [
    recentContext?.length
      ? `Earlier in this conversation:\n${recentContext.map((m) => `- ${m}`).join("\n")}\n`
      : "",
    `Message to rate:\n${redactedText}`,
  ]
    .filter(Boolean)
    .join("\n");

  let result;
  let lastError: unknown;
  for (const model of chain) {
    try {
      result = await generate({
        model,
        system: SYSTEM_PROMPT,
        prompt,
        timeoutMs,
        temperature: 0,
        maxOutputTokens: 256,
        responseSchema: RISK_SCHEMA,
        // thinkingConfig only where the model accepts it; flash-lite 400s on it.
        ...(model.includes("lite") ? {} : { thinkingBudget: 0 }),
      });
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof LlmUnavailable && err.reason === "quota") continue;
      throw err;
    }
  }
  if (!result) throw lastError;

  const parsed = parseJsonResponse<{
    risk_level: "low" | "medium" | "high";
    risk_reason: string;
    confidence: "low" | "med" | "high";
  }>(result.text);

  return {
    riskLevel: parsed.risk_level,
    riskReason: parsed.risk_reason,
    confidence: parsed.confidence,
    audit: auditLlm(result),
  };
}

/**
 * Classify, or return null if the model is unavailable.
 *
 * Callers pass the null straight to mergeVerdicts(), which fails closed to
 * medium for anything carrying clinical signal. The swallow is deliberate and
 * narrow: only LlmUnavailable is caught, so a genuine bug still surfaces.
 */
export async function tryClassify(
  redactedText: string,
  recentContext?: string[],
): Promise<{ verdict: ClassifierResult | null; failure?: string }> {
  try {
    return { verdict: await classifyWithLlm(redactedText, recentContext) };
  } catch (err) {
    if (err instanceof LlmUnavailable) {
      return { verdict: null, failure: `${err.reason}: ${err.message}` };
    }
    throw err;
  }
}
