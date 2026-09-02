import { NextResponse } from "next/server";
import { respondToTurn, escalationPayload, QuarantineRequired } from "@/lib/chat/respond";
import { persistTurn, persistMemory, persistChecklist, quarantine } from "@/lib/db/persist";
import { logEvent } from "@/lib/funnel/events";
import type { MemoryItem } from "@/lib/history/profile";

const CLINIC_ID = "00000000-0000-0000-0000-000000000001";

/**
 * The guest chat turn.
 *
 * No auth: this is the LeadSession surface, and the whole premise is that a
 * stranger gets real help before being asked for anything. Persistence and rate
 * limiting land with the Supabase wiring; this exposes the safety path so it
 * can be exercised end to end.
 */
export async function POST(request: Request) {
  let body: {
    text?: unknown;
    leadSessionId?: unknown;
    history?: unknown;
    memoryItems?: unknown;
    historyFilled?: unknown;
    complaintType?: unknown;
    askedCount?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "Expected { text: string }" }, { status: 400 });
  }
  if (body.text.length > 4000) {
    return NextResponse.json({ error: "Message too long" }, { status: 413 });
  }

  const history = Array.isArray(body.history)
    ? body.history.filter((h): h is string => typeof h === "string").slice(-6)
    : [];

  try {
    const turn = await respondToTurn(body.text, {
      history,
      // Session state round-trips through the client until Supabase persistence
      // lands. Keeps the turn pure and independently testable.
      memoryItems: Array.isArray(body.memoryItems) ? (body.memoryItems as MemoryItem[]) : [],
      historyFilled:
        body.historyFilled && typeof body.historyFilled === "object"
          ? (body.historyFilled as Record<string, string>)
          : {},
      complaintType: typeof body.complaintType === "string" ? body.complaintType : undefined,
      askedCount: typeof body.askedCount === "number" ? body.askedCount : 0,
    });

    // Persist AFTER the turn is computed and BEFORE responding, but never in a
    // way that can cost the patient their reply. Each call returns a result
    // rather than throwing; a database outage degrades to an unsaved
    // conversation, not a failed one.
    const leadSessionId =
      typeof body.leadSessionId === "string" ? body.leadSessionId : undefined;

    const saved = await persistTurn({
      clinicId: CLINIC_ID,
      leadSessionId,
      userText: body.text,
      turn,
    });

    if (saved.ok) {
      await Promise.all([
        persistMemory(turn.memoryItems, { leadSessionId }),
        persistChecklist(turn.history, { leadSessionId }),
      ]);
    }

    for (const ve of turn.valueEvents) {
      await logEvent({
        clinicId: CLINIC_ID,
        leadSessionId,
        eventType: "value_event",
        valueEventId: ve,
        sourceMessageId: turn.messageId,
        metadata: { risk_level: turn.riskLevel },
      });
    }

    return NextResponse.json({
      reply: turn.reply,
      risk: {
        level: turn.riskLevel,
        reason: turn.riskReason,
        confidence: turn.confidence,
        provenance: turn.riskProvenance,
        deciding_layer: turn.decidingLayer,
        matched_rule_id: turn.matchedRuleId,
      },
      escalation_required: turn.escalationRequired,
      crisis_pathway: turn.crisisPathway,
      emergency_banner: turn.showEmergencyBanner ? turn.emergencyBannerText : null,
      citations: turn.citations,
      // The live "Patient Profile" sidebar, updating every turn.
      profile: turn.profile,
      history: {
        complaint: turn.history.complaintLabel,
        complaint_type: turn.history.complaintType,
        completeness_pct: turn.history.completenessPct,
        progress: turn.history.progress,
        halted_reason: turn.history.haltedReason ?? null,
        next_field: turn.history.nextQuestion?.fieldId ?? null,
        filled: turn.history.filled,
      },
      value_events: turn.valueEvents,
      // Client carries this back on the next turn.
      state: {
        memoryItems: turn.memoryItems,
        historyFilled: turn.history.filled,
        complaintType: turn.history.complaintType,
        askedCount: (typeof body.askedCount === "number" ? body.askedCount : 0) + (turn.history.nextQuestion ? 1 : 0),
      },
      escalation_payload: turn.escalationRequired ? escalationPayload(turn) : null,
      // Honest about whether this conversation actually exists anywhere.
      persisted: saved.ok,
      persist_error: saved.ok ? null : saved.error,
      audit: turn.audit,
    });
  } catch (err) {
    // Redaction failed. The message never reached a model and must not be
    // retried automatically — it goes to the quarantine queue for a privacy
    // officer. Fail closed, and say so honestly rather than silently dropping it.
    if (err instanceof QuarantineRequired) {
      // The raw payload goes to the one table that holds unredacted text,
      // readable only by privacy_officer. Dropping it silently would destroy
      // the evidence that the redactor failed at all.
      const q = await quarantine(CLINIC_ID, body.text as string, err.failureReason);

      return NextResponse.json(
        {
          error: "message_quarantined",
          reason: err.failureReason,
          quarantine_id: q.id ?? null,
          reply:
            "I couldn't process that safely, so I haven't sent it anywhere. " +
            "Could you try sending it again?",
        },
        { status: 503 },
      );
    }
    throw err;
  }
}
