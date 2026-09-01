import "server-only";

import { randomUUID } from "node:crypto";
import { redact, auditSummary, RedactionFailure } from "@/lib/redaction/pipeline";
import { classifyDeterministic, mergeVerdicts, requiresEscalation, auditRisk, hasClinicalSignal } from "@/lib/risk/gate";
import { tryClassify } from "@/lib/risk/classifier";
import { retrieve, getClinic, type RetrievedChunk } from "@/lib/grounding/corpus";
import { generate, LlmUnavailable, auditLlm } from "@/lib/llm/gemini";
import { checkOutput, fallbackCopy, auditGuard } from "./guard";
import { loadCopyRules, normalisePhrase } from "@/lib/config";
import type { RiskLevel } from "@/lib/config";
import {
  detectComplaintType,
  tryExtract,
  advance,
  snapshot as historySnapshot,
  type HistoryState,
} from "@/lib/history/engine";
import {
  applyFacts,
  currentProfile,
  profileSnapshot,
  type MemoryItem,
} from "@/lib/history/profile";

/**
 * THE TURN.
 *
 * One patient message in, one safe reply out. The ordering here IS the safety
 * architecture, so it is worth reading as a sequence rather than as code:
 *
 *   1. REDACT       - nothing reaches a third party unredacted. Throws => quarantine.
 *   2. RISK GATE    - deterministic first, model second, MAX() merge, never lowered.
 *   3. CRISIS       - self-harm takes a fixed path that never touches the model.
 *   4. MED/HIGH     - stop advising. Offer the handoff. No clinical content.
 *   5. LOW          - answer, grounded in the corpus, with citations.
 *   6. GUARD        - post-generation check. Retry once, then approved fallback.
 *
 * Steps 3 and 4 are the reason this is not a chatbot with a warning label. A
 * person describing crushing chest pain never reaches a generative model at
 * all - their reply is assembled from vetted copy. The model is only trusted
 * with the low-risk conversation, and even then its output is checked.
 */

export interface TurnResult {
  reply: string;
  riskLevel: RiskLevel;
  riskReason: string;
  confidence: "low" | "med" | "high";
  riskProvenance: string;
  decidingLayer: string;
  matchedRuleId: string | null;
  escalationRequired: boolean;
  crisisPathway: boolean;
  showEmergencyBanner: boolean;
  emergencyBannerText: string;
  citations: { chunkId: string; sourceUrl: string; charStart: number; charEnd: number; documentTitle: string }[];
  /** Redacted text - the only version safe to persist. */
  redactedText: string;
  /** Id for this message, so extracted facts can point back at it. */
  messageId: string;
  history: HistoryState;
  profile: ReturnType<typeof currentProfile>;
  memoryItems: MemoryItem[];
  valueEvents: string[];
  /** PHI-free. Everything here is safe for audit_log. */
  audit: Record<string, unknown>;
}

export class QuarantineRequired extends Error {
  constructor(readonly failureReason: string) {
    super("Redaction failed; message must be quarantined and not processed.");
    this.name = "QuarantineRequired";
  }
}

export interface TurnInput {
  history?: string[];
  memoryItems?: MemoryItem[];
  historyFilled?: Record<string, string>;
  complaintType?: string;
  askedCount?: number;
  /** guest_messages pre-auth, messages post-auth. Provenance survives conversion. */
  provenanceTable?: "guest_messages" | "messages";
}

function bannerFor(country: string): string {
  const rules = loadCopyRules();
  return rules.emergency_banner.localised[country] ?? rules.emergency_banner.default;
}

const SYSTEM_PROMPT = `You are Nightingale, an assistant for {CLINIC}, a private clinic in Malaysia.

WHAT YOU ARE
You are software, and you say so plainly whenever anyone asks. You are not a doctor, you cannot diagnose, and you never pretend otherwise. You are warm and plain-spoken, not chirpy and not clinical.

WHAT YOU DO
Answer questions about the clinic using ONLY the SOURCE MATERIAL provided below, and help people describe their concern clearly so a clinician can help them faster.

ABSOLUTE RULES
1. Never name a condition the person might have. Not "this sounds like X", not "it could be X". Gathering information is your job; drawing conclusions is a clinician's.
2. Never suggest starting, stopping or changing any medication.
3. Never reassure. Do not say anything means "nothing to worry about". You do not know that, and saying it is how people decide not to go.
4. Answer clinic facts ONLY from the SOURCE MATERIAL. If the answer is not there, say you don't have it and offer to ask the clinic. Never guess an opening hour, a price, or a policy.
5. Exactly ONE question per message, and never open with a question - acknowledge what they said first.
6. When you ask something, say briefly why it helps. "When did it start? That is usually the first thing the doctor will want to know."
7. Never assume gender, marital status, religion, ability to pay, or that they are asking about themselves.
8. Never imply they should have come sooner.

TONE
Short sentences. Malaysian English is fine. Match their register: if they write in Bahasa or mix languages, you may acknowledge in kind, but answer in English and say so if it matters.

You may be shown placeholders like [NAME_1] or [IC_1] where personal details were removed before you saw them. NEVER write a placeholder in your reply and never treat one as the person's actual name - do not write "Hello [NAME_1]". Address them without using a name at all. Never comment on the placeholders and never ask them to repeat what was removed.`;

function buildPrompt(
  redactedText: string,
  chunks: RetrievedChunk[],
  history: string[],
  next?: { question: string; why: string },
): string {
  const source = chunks.length
    ? chunks
        .map(
          (c, i) =>
            `[${i + 1}] From "${c.documentTitle}" (${c.sourceUrl}):\n${c.text}`,
        )
        .join("\n\n")
    : "(No matching source material. You must say you do not have this information and offer to ask the clinic. Do not guess.)";

  return [
    `SOURCE MATERIAL:\n${source}`,
    history.length ? `\nEARLIER IN THIS CONVERSATION:\n${history.map((h) => `- ${h}`).join("\n")}` : "",
    `\nTHE PERSON JUST SAID:\n${redactedText}`,
    `\nReply in 2-4 short sentences.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function respondToTurn(
  rawText: string,
  opts: TurnInput = {},
): Promise<TurnResult> {
  const clinic = getClinic();
  const rules = loadCopyRules();
  const history = opts.history ?? [];
  const provenanceTable = opts.provenanceTable ?? "guest_messages";
  const messageId = randomUUID();

  // ---- 1. REDACT ----------------------------------------------------------
  let redaction;
  try {
    redaction = await redact(rawText);
  } catch (err) {
    if (err instanceof RedactionFailure) throw new QuarantineRequired(err.reason);
    throw err;
  }
  const redactedText = redaction.redacted;

  // ---- 2. RISK GATE -------------------------------------------------------
  const deterministic = classifyDeterministic(rawText);
  const { verdict: llm, failure } = await tryClassify(redactedText, history);
  const risk = mergeVerdicts(deterministic, llm, rawText);

  // ---- 3. EXTRACT ---------------------------------------------------------
  // Deliberately BEFORE the branch. Someone who escalates on their first
  // message should still arrive at the nurse with whatever they already told us.
  const complaintType = opts.complaintType ?? detectComplaintType(rawText);

  // Skip extraction when the message carries no clinical signal and the risk
  // gate found nothing. An opening-hours question has no facts to extract, and
  // on a rate-limited key every avoidable call is one that might otherwise have
  // been the patient's actual reply.
  const worthExtracting =
    risk.riskLevel !== "low" ||
    hasClinicalSignal(rawText) ||
    Object.keys(opts.historyFilled ?? {}).length > 0;
  const extraction = worthExtracting
    ? await tryExtract(redactedText, complaintType, history)
    : null;

  const applied = applyFacts(
    opts.memoryItems ?? [],
    extraction?.facts ?? [],
    { table: provenanceTable, messageId },
  );
  const filled = { ...(opts.historyFilled ?? {}), ...(extraction?.fields ?? {}) };
  const historyState = advance(complaintType, filled, risk.riskLevel, opts.askedCount ?? 0);

  const valueEvents: string[] = [];
  if (historyState.isValueEvent) valueEvents.push("VE_02");

  const base = {
    messageId,
    history: historyState,
    profile: currentProfile(applied.items),
    memoryItems: applied.items,
    valueEvents,
    riskLevel: risk.riskLevel,
    riskReason: risk.riskReason,
    confidence: risk.confidence,
    riskProvenance: new Date().toISOString(),
    decidingLayer: risk.decidingLayer,
    matchedRuleId: risk.matchedRuleId,
    escalationRequired: requiresEscalation(risk.riskLevel),
    crisisPathway: risk.crisisPathway,
    showEmergencyBanner: risk.showEmergencyBanner,
    emergencyBannerText: bannerFor(clinic.country),
    redactedText,
  };

  const audit = {
    ...auditSummary(redaction),
    ...auditRisk(risk),
    llm_classifier: llm ? llm.audit : { unavailable: failure },
    extraction: extraction ? extraction.audit : { skipped: !worthExtracting },
    facts_added: applied.added.length,
    facts_mutated: applied.mutated.length,
    history_completeness: historyState.completenessPct,
  };

  // ---- 3. CRISIS ----------------------------------------------------------
  // Fixed copy, WHO/Samaritans/#chatsafe compliant. The model is never asked to
  // improvise here, and never sees this branch.
  if (risk.crisisPathway) {
    const resources = rules.crisis_protocol.resources[clinic.country === "SG" ? "SG" : "MY"];
    const lines = resources
      .map((r) => `${r.name}: ${r.contact}${r.whatsapp ? ` (WhatsApp ${r.whatsapp})` : ""} — ${r.hours}`)
      .join("\n");
    return {
      ...base,
      reply: `${rules.crisis_protocol.message.trim()}\n\n${lines}`,
      citations: [],
      audit: { ...audit, path: "crisis_protocol", model_used: false },
    };
  }

  // ---- 3b. IDENTITY -------------------------------------------------------
  // "Are you a real doctor?" is a required test, and the brief is specific: the
  // answer must cover what the AI is, what the clinic is, and when a human gets
  // involved. Left to the model this was falling through to generic fallback
  // copy. It is too important to be probabilistic, so it takes a fixed path -
  // the same reasoning as the crisis branch. config/copy_rules.yaml carries the
  // text AND the three elements test_trust.py asserts on.
  const identityAsked = rules.identity_disclosure.triggers.some((t) =>
    normalisePhrase(rawText).includes(normalisePhrase(t)),
  );
  if (identityAsked) {
    return {
      ...base,
      reply: rules.identity_disclosure.response
        .replace(/\{clinic_name\}/g, clinic.name)
        .trim(),
      citations: [],
      audit: { ...audit, path: "identity_disclosure", model_used: false },
    };
  }

  // ---- 4. HIGH ONLY -------------------------------------------------------
  // The brief says "Med/High Risk: Stop advice. Trigger Send to Clinic." Stop
  // ADVICE - not stop the conversation; the brief also says patient and AI keep
  // talking after a handoff. Gathering history is not advice.
  //
  // An earlier version returned fixed copy for BOTH medium and high, so someone
  // with a three-day headache received the identical sentence five turns running
  // and was never asked a single question. That is worse for the patient AND
  // worse for the clinician, who then receives an escalation with no history
  // attached. Only HIGH halts now; the checklist halts with it.
  if (risk.riskLevel === "high") {
    return {
      ...base,
      reply: rules.approved.escalation_without_alarm[0],
      citations: [],
      audit: { ...audit, path: "escalation_no_advice", model_used: false },
    };
  }

  // ---- 5. LOW / MEDIUM ----------------------------------------------------
  // Medium keeps gathering history and offers the handoff alongside, rather
  // than instead of, the conversation. It is barred from clinical content by
  // the constraint below plus the post-generation guard.
  const chunks = retrieve(redactedText);
  const mediumConstraint =
    risk.riskLevel === "medium"
      ? `

THIS TURN IS FLAGGED MEDIUM RISK. Give NO clinical information of any kind, not even general education. Acknowledge briefly, ask the next question if one is supplied, and make clear a clinician should look at this. Do not speculate about what it might be, and do not reassure.`
      : "";
  const system = SYSTEM_PROMPT.replace("{CLINIC}", clinic.name) + mediumConstraint;
  const timeoutMs = Number(process.env.CHAT_TIMEOUT_MS ?? 10000);
  // Quota is metered PER MODEL, so an exhausted primary does not mean an
  // exhausted account. Falling back to a smaller model degrades answer quality
  // but keeps the conversation alive, which is strictly better than serving
  // generic fallback copy to someone mid-sentence. Discovered the hard way:
  // the free tier allows 20 requests/day/model, and one five-turn conversation
  // spends most of that.
  const primaryModel = process.env.CHAT_MODEL ?? "gemini-3.5-flash";
  const fallbackModel = process.env.CHAT_MODEL_FALLBACK ?? "gemini-3.5-flash-lite";
  let model = primaryModel;
  let modelDowngraded = false;

  let reply: string | null = null;
  let guardAudit: Record<string, unknown> = {};
  let modelAudit: Record<string, unknown> = {};

  for (let attempt = 0; attempt < 2 && reply === null; attempt++) {
    try {
      const result = await generate({
        model,
        system: attempt === 0 ? system : `${system}\n\n${guardAudit.retry_hint ?? ""}`,
        prompt: buildPrompt(redactedText, chunks, history, historyState.nextQuestion),
        timeoutMs,
        temperature: 0.4,
        maxOutputTokens: 400,
        // flash-lite rejects thinkingConfig with HTTP 400; only the full
        // flash model accepts it.
        ...(model.includes("lite") ? {} : { thinkingBudget: 0 }), // latency: the budget is p95 < 3s
      });
      modelAudit = auditLlm(result);

      // ---- 6. GUARD ------------------------------------------------------
      const guard = checkOutput(result.text, { riskLevel: risk.riskLevel });
      guardAudit = { ...auditGuard(guard), attempt: attempt + 1, retry_hint: guard.retryHint };

      if (guard.ok) reply = result.text.trim();
    } catch (err) {
      if (!(err instanceof LlmUnavailable)) throw err;

      // Quota exhaustion on the primary is recoverable: try the smaller model
      // once before giving up on generation entirely.
      if (err.reason === "quota" && model === primaryModel) {
        model = fallbackModel;
        modelDowngraded = true;
        attempt--; // this attempt did not produce a draft to judge
        continue;
      }
      modelAudit = { unavailable: `${err.reason}: ${err.message}` };
      break;
    }
  }

  // Two blocked drafts, or an unavailable model: serve vetted copy rather than
  // an edited one. We never patch generated text into compliance.
  const usedFallback = reply === null;
  if (usedFallback) reply = fallbackCopy(risk.riskLevel);
  if (!usedFallback && chunks.length) valueEvents.push("VE_01");

  return {
    ...base,
    reply: reply!,
    citations: usedFallback
      ? []
      : chunks.map((c) => ({
          chunkId: c.id,
          sourceUrl: c.sourceUrl,
          charStart: c.charStart,
          charEnd: c.charEnd,
          documentTitle: c.documentTitle,
        })),
    audit: {
      ...audit,
      path: usedFallback ? "approved_fallback" : "grounded_answer",
      model_used: !usedFallback,
      chunks_retrieved: chunks.length,
      chat_model: modelAudit,
      model_downgraded: modelDowngraded,
      guard: guardAudit,
    },
  };
}

/**
 * The escalation payload.
 *
 * The brief: "The record must let a clinician begin a structured review without
 * the patient repeating their story." A chat transcript does not do that. This
 * does — the structured history, the living profile including every superseded
 * state, and the provenance to walk any single fact back to the sentence that
 * produced it.
 */
export function escalationPayload(turn: TurnResult) {
  return {
    triggering_message: turn.redactedText,
    triggering_message_id: turn.messageId,
    risk: {
      level: turn.riskLevel,
      reason: turn.riskReason,
      confidence: turn.confidence,
      provenance: turn.riskProvenance,
      deciding_layer: turn.decidingLayer,
      matched_rule_id: turn.matchedRuleId,
    },
    history_snapshot: historySnapshot(turn.history),
    profile_snapshot: profileSnapshot(turn.memoryItems),
  };
}
