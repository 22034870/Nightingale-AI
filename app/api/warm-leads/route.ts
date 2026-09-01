import { NextResponse } from "next/server";
import { warmLeadView, formulaDescription } from "@/lib/funnel/warm-leads";
import { hasDatabase } from "@/lib/db/client";

/**
 * The warm-lead view.
 *
 * Care-team only in production — RLS already restricts lead_sessions and
 * funnel_events to is_care_team(), and test_access_control.py asserts a patient
 * JWT gets zero rows from the database rather than from application code.
 *
 * Compassion priorities sort FIRST regardless of score. The failure this exists
 * to prevent is a real emergency sitting at position 31 behind thirty price
 * enquiries.
 */
export async function GET(request: Request) {
  const clinicId =
    new URL(request.url).searchParams.get("clinicId") ??
    "00000000-0000-0000-0000-000000000001";

  if (!hasDatabase()) {
    return NextResponse.json(
      { error: "database_not_configured", leads: [], formula: formulaDescription() },
      { status: 503 },
    );
  }

  const leads = await warmLeadView(clinicId);

  return NextResponse.json({
    formula: formulaDescription(),
    counts: {
      total: leads.length,
      compassion_priority: leads.filter((l) => l.compassionPriority).length,
      contactable: leads.filter((l) => l.contactPermitted).length,
    },
    leads,
  });
}
