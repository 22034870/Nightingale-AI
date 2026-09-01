import { NextResponse } from "next/server";
import { channelFunnels, abandonmentPoints, askedThisWeek } from "@/lib/funnel/events";
import { hasDatabase } from "@/lib/db/client";

/**
 * Conversion metrics per channel.
 *
 * Every number here is a live aggregate over funnel_events. There is no code
 * path that renders a figure someone typed in — which is the point. A product
 * that argues for honest numbers has to have an honest dashboard.
 *
 * Reports drop-off as well as stage totals, because a bar chart of totals hides
 * the thing a clinic actually needs to know: where people leave.
 */
export async function GET(request: Request) {
  const clinicId =
    new URL(request.url).searchParams.get("clinicId") ??
    "00000000-0000-0000-0000-000000000001";

  if (!hasDatabase()) {
    return NextResponse.json(
      {
        error: "database_not_configured",
        detail:
          "SUPABASE_SERVICE_ROLE_KEY is not set. Metrics are deliberately empty " +
          "rather than seeded with sample data — a fabricated dashboard would " +
          "contradict the honest-numbers rule this product is built on.",
        funnels: [],
      },
      { status: 503 },
    );
  }

  const [funnels, abandonment, asked] = await Promise.all([
    channelFunnels(clinicId),
    abandonmentPoints(clinicId),
    askedThisWeek(clinicId),
  ]);

  return NextResponse.json({
    funnels,
    abandonment,
    asked_this_week: {
      value: asked.value,
      suppressed: asked.suppressed,
      floor: asked.floor,
      query: asked.query,
      note: asked.suppressed
        ? "Below the floor, so nothing is displayed. Never a rounded or invented number."
        : null,
    },
  });
}
