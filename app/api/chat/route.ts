import { NextResponse } from "next/server";
import { respondToTurn, QuarantineRequired } from "@/lib/chat/respond";

/**
 * The guest chat turn.
 *
 * No auth: this is the LeadSession surface, and the whole premise is that a
 * stranger gets real help before being asked for anything. Persistence and rate
 * limiting land with the Supabase wiring; this exposes the safety path so it
 * can be exercised end to end.
 */
export async function POST(request: Request) {
  let body: { text?: unknown; history?: unknown };
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
    const turn = await respondToTurn(body.text, { history });

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
      audit: turn.audit,
    });
  } catch (err) {
    // Redaction failed. The message never reached a model and must not be
    // retried automatically — it goes to the quarantine queue for a privacy
    // officer. Fail closed, and say so honestly rather than silently dropping it.
    if (err instanceof QuarantineRequired) {
      return NextResponse.json(
        {
          error: "message_quarantined",
          reason: err.failureReason,
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
