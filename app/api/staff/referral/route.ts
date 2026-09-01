import { NextResponse } from "next/server";
import { createStaffReferral } from "@/lib/channels/arrival";
import { getClinic } from "@/lib/grounding/corpus";

/**
 * Staff referral — the brief's mandatory contract.
 *
 * A clinician types what was discussed ("asked about egg freezing at today's
 * visit") and gets a link that opens already knowing it. This is how in-person
 * visits and phone calls feed the funnel, and it is the highest-trust arrival
 * in the product: consent happened face to face.
 *
 * In production this sits behind staff auth. RLS already restricts the tables
 * it touches to is_care_team(); test_access_control.py asserts the boundary.
 */
export async function POST(request: Request) {
  let body: { staffName?: unknown; note?: unknown; clinicId?: unknown; baseUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.note !== "string" || !body.note.trim()) {
    return NextResponse.json(
      { error: "Expected { note: string } — what the patient asked about" },
      { status: 400 },
    );
  }

  const clinic = getClinic();
  const result = await createStaffReferral(
    {
      clinicId:
        typeof body.clinicId === "string"
          ? body.clinicId
          : "00000000-0000-0000-0000-000000000001",
      staffName: typeof body.staffName === "string" ? body.staffName : "A member of the team",
      note: body.note,
    },
    {
      clinicName: clinic.name,
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
    },
  );

  return NextResponse.json({
    link: result.recoveryUrl,
    lead_session_id: result.leadSession.id,
    // The link opens already knowing the topic — nothing is re-asked.
    preloaded_context: {
      topic: result.leadSession.staffReferralNote,
      opening: result.opening.opening,
      skip_questions: result.opening.skipQuestions,
    },
    sensitive_topic_rule_applied: result.opening.sensitiveTopicRuleApplied,
    expires_at: result.leadSession.expiresAt,
    persisted: result.persisted,
  });
}
