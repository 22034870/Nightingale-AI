import { NextResponse } from "next/server";
import { respondToTurn, escalationPayload } from "@/lib/chat/respond";
import { tryPersist } from "@/lib/db/client";
import { logEvent } from "@/lib/funnel/events";
import { loadChannelRules, timeOfDay } from "@/lib/channels/rules";
import type { MemoryItem } from "@/lib/history/profile";

/**
 * Send to Clinic.
 *
 * The brief: the payload must carry the triggering message, a triage summary, a
 * profile snapshot, provenance and the acquisition context — and "the record
 * must let a clinician begin a structured review without the patient repeating
 * their story."
 *
 * A chat transcript does not do that. The History Engine snapshot does, which
 * is the entire reason it exists.
 *
 * The response expectation is COMPUTED from clinic hours rather than the
 * brief's fixed "12 to 18 hours". Report C&D §3.3 #8 ranks a promise the clinic
 * cannot keep as a top-ten trust breaker, and a static promise made at 2am is
 * exactly that.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "Expected { text: string }" }, { status: 400 });
  }

  const clinicId =
    typeof body.clinicId === "string" ? body.clinicId : "00000000-0000-0000-0000-000000000001";
  const leadSessionId = typeof body.leadSessionId === "string" ? body.leadSessionId : undefined;

  const turn = await respondToTurn(body.text, {
    history: Array.isArray(body.history) ? (body.history as string[]) : [],
    memoryItems: Array.isArray(body.memoryItems) ? (body.memoryItems as MemoryItem[]) : [],
    historyFilled:
      body.historyFilled && typeof body.historyFilled === "object"
        ? (body.historyFilled as Record<string, string>)
        : {},
  });

  const payload = escalationPayload(turn);
  const summary = triageSummary(turn);

  const rules = loadChannelRules();
  const tod = timeOfDay();
  const expectation = rules.response_expectation[tod];
  const slaDueAt = new Date(Date.now() + expectation.hours * 3.6e6).toISOString();

  const persisted = await tryPersist("escalation", async (db) => {
    const { data, error } = await db
      .from("escalations")
      .insert({
        patient_id: typeof body.patientId === "string" ? body.patientId : null,
        trigger_message_id: turn.messageId,
        triage_summary: summary,
        profile_snapshot_json: payload.profile_snapshot,
        acquisition_context_json: body.attribution ?? {},
        history_snapshot_json: payload.history_snapshot,
        status: "sent",
        sla_due_at: slaDueAt,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  });

  const attribution = (body.attribution ?? {}) as Record<string, unknown>;

  await logEvent({
    clinicId,
    leadSessionId,
    eventType: "escalation_sent",
    metadata: {
      risk_level: turn.riskLevel,
      deciding_layer: turn.decidingLayer,
      matched_rule_id: turn.matchedRuleId,
      history_completeness: turn.history.completenessPct,
      source_channel: attribution.source_channel ?? "unknown",
      top_concern: turn.profile.chief_complaint,
    },
  });

  return NextResponse.json({
    escalation_id: persisted.ok ? persisted.data : null,
    persisted: persisted.ok,
    persist_error: persisted.ok ? undefined : persisted.error,
    status: "sent",
    // Honest, computed, and it says what to do if things get worse first.
    response_expectation: `${expectation.text} ${rules.response_expectation.always_append.trim()}`,
    sla_due_at: slaDueAt,
    payload: {
      ...payload,
      triage_summary: summary,
      acquisition_context: attribution,
    },
    // The brief: after sending, patient and AI can keep talking.
    conversation_continues: true,
  });
}

/**
 * 1-5 bullets, assembled from extracted facts rather than generated prose.
 *
 * Deliberately not an LLM call. A triage summary a clinician acts on should be
 * a deterministic projection of what the patient actually said, not a
 * paraphrase that could drift.
 */
function triageSummary(turn: Awaited<ReturnType<typeof respondToTurn>>): string {
  const p = turn.profile;
  const h = turn.history;
  const bullets: string[] = [];

  if (p.chief_complaint) bullets.push(`Chief complaint: ${p.chief_complaint}`);

  for (const [field, value] of Object.entries(h.filled).slice(0, 2)) {
    bullets.push(`${field}: ${value}`);
  }

  const meds = p.medications.filter((m) => m.status === "active").map((m) => m.value);
  if (meds.length) bullets.push(`Current medications: ${meds.join(", ")}`);
  if (p.allergies.length) bullets.push(`Allergies: ${p.allergies.map((a) => a.value).join(", ")}`);

  bullets.push(
    `Risk ${turn.riskLevel} (${turn.decidingLayer}` +
      `${turn.matchedRuleId ? `, ${turn.matchedRuleId}` : ""}), ` +
      `history ${h.completenessPct}% complete.`,
  );

  return bullets
    .slice(0, 5)
    .map((b) => `• ${b}`)
    .join("\n");
}
