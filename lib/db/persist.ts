import "server-only";

import { tryPersist } from "./client";
import type { TurnResult } from "@/lib/chat/respond";
import type { MemoryItem } from "@/lib/history/profile";

/**
 * CONVERSATION PERSISTENCE.
 *
 * Writes each turn to guest_messages (or messages, post-conversion) and syncs
 * the living profile, so a conversation survives a page refresh, a serverless
 * cold start, and the gap between a patient closing the tab and a nurse opening
 * the queue.
 *
 * WHAT IS AND IS NOT STORED
 * -------------------------
 * text_redacted ONLY. The raw message is never written anywhere — the redaction
 * pipeline runs first and its output is the only version that exists past the
 * request. The placeholder→original map is deliberately NOT persisted either,
 * which means a stored message cannot be un-redacted later, by anyone. That
 * costs a clinician some detail and is the correct trade.
 *
 * Guest rows carry the 7-day retention from PLANNING §12, enforced by
 * purge_expired_guest_data() in db/schema.sql. Nothing here extends that.
 *
 * FAILURE POSTURE
 * ---------------
 * Persistence NEVER blocks a reply. A database outage must not cost someone
 * their answer mid-sentence. Every function returns a result rather than
 * throwing, and callers surface the failure honestly instead of pretending the
 * write happened — the same rule the escalation confirmation now follows.
 */

export interface PersistTurnInput {
  clinicId: string;
  leadSessionId?: string;
  patientSessionId?: string;
  userText: string;
  turn: TurnResult;
}

export interface PersistResult {
  ok: boolean;
  userMessageId?: string;
  assistantMessageId?: string;
  error?: string;
}

/**
 * Persist one exchange: the patient's message and the assistant's reply.
 *
 * The user message uses turn.messageId — the same id extracted facts already
 * point at — so provenance written by the History Engine resolves to a real row
 * rather than a UUID that exists only in memory.
 */
/**
 * Get a lead session id, creating one if the caller did not supply it.
 *
 * WHY THIS EXISTS RATHER THAN A 400
 * ---------------------------------
 * An escalation must identify someone, or a clinician receives a concern with
 * no route back to the person who raised it. The obvious enforcement is to
 * reject the request — but the caller here is someone in distress pressing
 * "Send to a nurse", and answering them with a validation error because the
 * client omitted a field is the worst possible moment to be strict.
 *
 * So the invariant is satisfied by CONSTRUCTION instead. A session is minted,
 * the escalation has something to hang off, and the conversation has somewhere
 * to be written. Nothing is asked of the patient.
 *
 * Returns undefined if the database is unavailable; the caller then reports
 * persisted:false honestly rather than claiming a delivery that did not happen.
 */
export async function ensureLeadSession(
  clinicId: string,
  existing?: string,
  attribution?: Record<string, unknown>,
): Promise<string | undefined> {
  if (existing) return existing;

  const result = await tryPersist("lead_session", async (db) => {
    const { data, error } = await db
      .from("lead_sessions")
      .insert({
        clinic_id: clinicId,
        source_channel: (attribution?.source_channel as string) ?? "unknown",
        campaign_id: (attribution?.campaign_id as string) ?? null,
        // Anonymous unless the caller says otherwise. Escalating does not
        // identify anyone, and must not be recorded as though it did.
        identity_level: "anonymous",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  });

  return result.ok ? result.data : undefined;
}

export async function persistTurn(input: PersistTurnInput): Promise<PersistResult> {
  const { clinicId, leadSessionId, patientSessionId, turn } = input;
  const guest = !patientSessionId;
  const table = guest ? "guest_messages" : "messages";

  if (guest && !leadSessionId) {
    return { ok: false, error: "no lead session to attach the message to" };
  }

  const owner = guest
    ? { lead_session_id: leadSessionId }
    : { patient_session_id: patientSessionId };

  const result = await tryPersist("turn", async (db) => {
    // The patient's message, keyed so memory_items.provenance_message_id lands.
    const { error: userErr } = await db.from(table).insert({
      id: turn.messageId,
      ...owner,
      role: "user",
      text_redacted: turn.redactedText,
      risk_level: turn.riskLevel,
      risk_reason: turn.riskReason,
      risk_confidence: turn.confidence,
      risk_provenance: turn.riskProvenance,
      deciding_layer: turn.decidingLayer,
      matched_rule_id: turn.matchedRuleId,
    });
    if (userErr) throw new Error(`${table} (user): ${userErr.message}`);

    // The assistant's reply. Stored so a clinician can read what the patient
    // was actually told — a triage record that omits our own words is half a
    // record, and if the assistant said something wrong we need it on file.
    const { data: assistant, error: aErr } = await db
      .from(table)
      .insert({
        ...owner,
        role: "assistant",
        text_redacted: turn.reply,
        risk_level: turn.riskLevel,
        deciding_layer: turn.decidingLayer,
      })
      .select("id")
      .single();
    if (aErr) throw new Error(`${table} (assistant): ${aErr.message}`);

    return { assistantId: assistant.id as string };
  });

  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    userMessageId: turn.messageId,
    assistantMessageId: result.data.assistantId,
  };
}

/**
 * Upsert the living profile.
 *
 * Upsert rather than insert because memory_items carry stable client-side ids
 * and a correction rewrites the superseded row's status and superseded_by. The
 * conflict target is the primary key, so re-sending an unchanged item is a
 * no-op rather than a duplicate.
 */
export async function persistMemory(
  items: MemoryItem[],
  owner: { leadSessionId?: string; patientId?: string },
): Promise<{ ok: boolean; count: number; error?: string }> {
  if (!items.length) return { ok: true, count: 0 };

  const result = await tryPersist("memory_items", async (db) => {
    const { error } = await db.from("memory_items").upsert(
      items.map((m) => ({
        id: m.id,
        patient_id: owner.patientId ?? null,
        lead_session_id: owner.patientId ? null : (owner.leadSessionId ?? null),
        kind: m.kind,
        value: m.value,
        status: m.status,
        provenance_table: m.provenance.table,
        provenance_message_id: m.provenance.messageId,
        superseded_by: m.supersededBy ?? null,
        updated_at: m.updatedAt,
      })),
      { onConflict: "id" },
    );
    if (error) throw new Error(error.message);
    return items.length;
  });

  return result.ok
    ? { ok: true, count: result.data }
    : { ok: false, count: 0, error: result.error };
}

/** Persist the History Engine checklist state for this session. */
export async function persistChecklist(
  state: TurnResult["history"],
  owner: { leadSessionId?: string; patientSessionId?: string },
): Promise<{ ok: boolean; error?: string }> {
  if (!Object.keys(state.filled).length) return { ok: true };

  const result = await tryPersist("history_checklists", async (db) => {
    const { error } = await db.from("history_checklists").upsert(
      {
        patient_session_id: owner.patientSessionId ?? null,
        lead_session_id: owner.patientSessionId ? null : (owner.leadSessionId ?? null),
        complaint_type: state.complaintType,
        fields_json: state.filled,
        completeness_pct: state.completenessPct,
        halted_reason: state.haltedReason ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: owner.patientSessionId ? "patient_session_id" : "lead_session_id" },
    );
    if (error) throw new Error(error.message);
    return true;
  });

  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Read a conversation back — the query the clinician queue and session recovery
 * both need.
 */
export async function loadConversation(leadSessionId: string) {
  const result = await tryPersist("load_conversation", async (db) => {
    const [messages, memory, checklist] = await Promise.all([
      db
        .from("guest_messages")
        .select("id, role, text_redacted, risk_level, matched_rule_id, created_at")
        .eq("lead_session_id", leadSessionId)
        .order("created_at", { ascending: true }),
      db.from("memory_items").select("*").eq("lead_session_id", leadSessionId),
      db
        .from("history_checklists")
        .select("*")
        .eq("lead_session_id", leadSessionId)
        .maybeSingle(),
    ]);

    return {
      messages: messages.data ?? [],
      memory: memory.data ?? [],
      checklist: checklist.data ?? null,
    };
  });

  return result.ok ? result.data : null;
}

/**
 * Quarantine a message the redactor could not process.
 *
 * The raw payload is written here and NOWHERE else, reachable only by the
 * privacy_officer role. This is the one place in the system that holds
 * unredacted text, and it exists so that a redaction failure has a defined,
 * auditable destination instead of being silently dropped.
 */
export async function quarantine(
  clinicId: string,
  rawPayload: string,
  failureReason: string,
): Promise<{ ok: boolean; id?: string }> {
  const result = await tryPersist("quarantine", async (db) => {
    const { data, error } = await db
      .from("redaction_quarantine")
      .insert({
        clinic_id: clinicId,
        raw_payload_encrypted: rawPayload,
        failure_reason: failureReason,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  });

  return result.ok ? { ok: true, id: result.data } : { ok: false };
}
