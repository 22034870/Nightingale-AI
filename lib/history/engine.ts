import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { normalisePhrase } from "@/lib/config";
import { generate, parseJsonResponse, LlmUnavailable, auditLlm } from "@/lib/llm/gemini";
import type { RiskLevel } from "@/lib/config";

/**
 * THE HISTORY ENGINE.
 *
 * Works down a bounded, per-complaint checklist of the things a clinician would
 * ask, one question at a time, each stating why it matters — and never draws a
 * conclusion from any of it.
 *
 * The distinction the whole design rests on: ASKING IS NOT DIAGNOSING. "Does it
 * spread to your arm?" gathers a fact. "That suggests cardiac ischaemia" draws a
 * conclusion. We do the first and hard-block the second, which leaves the
 * conclusion with the clinician, where the law puts it.
 *
 * It halts on high risk. Someone with crushing chest pain is not asked seven
 * questions; they get the emergency line and the handoff, and whatever partial
 * history exists travels with them.
 */

export interface ChecklistField {
  id: string;
  label: string;
  question: string;
  why: string;
}

interface ComplaintType {
  label: string;
  detect: string[];
  frame: string;
  fields: ChecklistField[];
}

interface ChecklistsConfig {
  version: number;
  settings: { value_event_threshold: number; max_questions: number; halt_on_risk: RiskLevel[] };
  complaint_types: Record<string, ComplaintType>;
  universal_fields: ChecklistField[];
}

const SHOULD_CACHE = process.env.NODE_ENV === "production";
let cache: ChecklistsConfig | undefined;

export function loadChecklists(): ChecklistsConfig {
  if (!SHOULD_CACHE || !cache) {
    const file = path.join(process.cwd(), "config", "history_checklists.yaml");
    cache = load(readFileSync(file, "utf8")) as ChecklistsConfig;
  }
  return cache;
}

/**
 * Pick a checklist. Deterministic and cheap — no model call to decide which
 * questions to ask, because that decision should be inspectable and should not
 * change between two runs of the same conversation.
 */
export function detectComplaintType(text: string): string {
  const cfg = loadChecklists();
  const normalised = normalisePhrase(text);

  for (const [key, type] of Object.entries(cfg.complaint_types)) {
    if (!type.detect.length) continue;
    // Substring, not token-boundary: "headache" contains "ache" but does not
    // START with it, so prefix matching sent a textbook pain presentation to
    // the generic checklist. Picking the wrong checklist costs question
    // quality, never safety, so the looser match is correct here.
    if (type.detect.some((d) => normalised.includes(normalisePhrase(d)))) return key;
  }
  return "general";
}

export function fieldsFor(complaintType: string): ChecklistField[] {
  const cfg = loadChecklists();
  const type = cfg.complaint_types[complaintType] ?? cfg.complaint_types.general;
  return [...type.fields, ...cfg.universal_fields];
}

// ---------------------------------------------------------------------------
// Extraction — also produces the living profile
// ---------------------------------------------------------------------------

export type FactKind = "chief_complaint" | "symptom" | "medication" | "allergy" | "context";
export type FactStatus = "active" | "stopped";

export interface ExtractedFact {
  kind: FactKind;
  value: string;
  status: FactStatus;
  /** Set when this fact corrects an earlier one. Drives the mutation chain. */
  supersedes?: string;
  timeline?: string;
}

export interface ExtractionResult {
  fields: Record<string, string>;
  facts: ExtractedFact[];
  audit: Record<string, unknown>;
}

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field_id: { type: "string" },
          value: { type: "string" },
        },
        required: ["field_id", "value"],
      },
    },
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["chief_complaint", "symptom", "medication", "allergy", "context"],
          },
          value: { type: "string" },
          status: { type: "string", enum: ["active", "stopped"] },
          supersedes: { type: "string" },
          timeline: { type: "string" },
        },
        required: ["kind", "value", "status"],
      },
    },
  },
  required: ["fields", "facts"],
} as const;

const EXTRACTION_SYSTEM = `You extract structured clinical facts from a patient's own words. You are a parser, not a clinician. You never infer, never diagnose, never add anything the person did not say.

Return two things.

FIELDS — answers to the specific checklist items listed. Only include a field if the person actually answered it. Use their own words, lightly tidied. Never guess a value from context.

FACTS — discrete clinical facts:
  - chief_complaint: the main problem, in their words
  - symptom: any symptom mentioned (add timeline if they gave one)
  - medication: any drug, supplement, or traditional remedy
  - allergy: any allergy
  - context: anything else clinically relevant (pregnancy, existing conditions, recent travel)

STATUS AND CORRECTIONS — this is the part that matters most.
Set status "active" for things that are currently true, "stopped" for things the person says they have stopped or that have resolved.
When a message CORRECTS something said earlier, emit the fact with its new status and set "supersedes" to the exact earlier value being corrected.

  "I take Advil"                  -> {kind: medication, value: "Advil", status: active}
  later: "actually I stopped last week"
                                  -> {kind: medication, value: "Advil", status: stopped,
                                      supersedes: "Advil", timeline: "stopped last week"}

Never delete. A correction is a new fact pointing at the old one, so the record shows both what was believed and when it changed.

Text may contain placeholders like [NAME_1] where personal details were removed. Never extract a placeholder as a fact.
Text may mix English and Bahasa Malaysia. Extract the value in the language it was given.
If nothing is extractable, return empty arrays.`;

export async function extract(
  redactedText: string,
  complaintType: string,
  history: string[] = [],
): Promise<ExtractionResult> {
  const fields = fieldsFor(complaintType);
  const model = process.env.RISK_MODEL ?? "gemini-3.5-flash-lite";

  const prompt = [
    `CHECKLIST FIELDS for this complaint (${complaintType}):`,
    fields.map((f) => `- ${f.id}: ${f.label}`).join("\n"),
    history.length ? `\nEARLIER MESSAGES:\n${history.map((h) => `- ${h}`).join("\n")}` : "",
    `\nLATEST MESSAGE:\n${redactedText}`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await generate({
    model,
    system: EXTRACTION_SYSTEM,
    prompt,
    timeoutMs: Number(process.env.RISK_CLASSIFY_TIMEOUT_MS ?? 3000),
    temperature: 0,
    maxOutputTokens: 700,
    responseSchema: EXTRACTION_SCHEMA,
  });

  const parsed = parseJsonResponse<{
    fields: { field_id: string; value: string }[];
    facts: ExtractedFact[];
  }>(result.text);

  const valid = new Set(fields.map((f) => f.id));
  const out: Record<string, string> = {};
  for (const f of parsed.fields ?? []) {
    // Drop hallucinated field ids rather than storing them.
    if (valid.has(f.field_id) && f.value?.trim()) out[f.field_id] = f.value.trim();
  }

  return { fields: out, facts: parsed.facts ?? [], audit: auditLlm(result) };
}

export async function tryExtract(
  redactedText: string,
  complaintType: string,
  history: string[] = [],
): Promise<ExtractionResult | null> {
  try {
    return await extract(redactedText, complaintType, history);
  } catch (err) {
    // Extraction failing degrades the profile; it must never block a reply or
    // affect the risk verdict, which is computed independently upstream.
    if (err instanceof LlmUnavailable) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface HistoryState {
  complaintType: string;
  complaintLabel: string;
  filled: Record<string, string>;
  completenessPct: number;
  askedCount: number;
  haltedReason?: string;
  nextQuestion?: { fieldId: string; question: string; why: string };
  /** The meter shown to the patient: "4 of 7". */
  progress: { done: number; total: number };
  isValueEvent: boolean;
}

/**
 * Advance the checklist.
 *
 * The question is chosen deterministically — first unfilled field in clinical
 * order — so the conversation is reproducible and a reviewer can see exactly
 * why a given question came next.
 */
export function advance(
  complaintType: string,
  filled: Record<string, string>,
  riskLevel: RiskLevel,
  askedCount = 0,
): HistoryState {
  const cfg = loadChecklists();
  const type = cfg.complaint_types[complaintType] ?? cfg.complaint_types.general;
  const fields = fieldsFor(complaintType);

  const done = fields.filter((f) => filled[f.id]).length;
  const total = fields.length;
  const completenessPct = Math.round((done / total) * 100);

  const base: HistoryState = {
    complaintType,
    complaintLabel: type.label,
    filled,
    completenessPct,
    askedCount,
    progress: { done, total },
    isValueEvent: completenessPct >= cfg.settings.value_event_threshold,
  };

  // Escalation outranks completeness, always. A person with a red flag does not
  // get a questionnaire — they get the handoff, and the partial history goes
  // with them.
  if (cfg.settings.halt_on_risk.includes(riskLevel)) {
    return { ...base, haltedReason: "high_risk" };
  }
  if (askedCount >= cfg.settings.max_questions) {
    return { ...base, haltedReason: "max_questions" };
  }

  const next = fields.find((f) => !filled[f.id]);
  if (!next) return { ...base, haltedReason: "complete" };

  return {
    ...base,
    nextQuestion: { fieldId: next.id, question: next.question, why: next.why },
  };
}

/** Point-in-time snapshot for the escalation payload. */
export function snapshot(state: HistoryState) {
  const fields = fieldsFor(state.complaintType);
  return {
    complaint_type: state.complaintType,
    complaint_label: state.complaintLabel,
    frame: loadChecklists().complaint_types[state.complaintType]?.frame,
    completeness_pct: state.completenessPct,
    halted_reason: state.haltedReason ?? null,
    fields: fields.map((f) => ({
      id: f.id,
      label: f.label,
      value: state.filled[f.id] ?? null,
      answered: Boolean(state.filled[f.id]),
    })),
  };
}
