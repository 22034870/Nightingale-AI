import { NextResponse } from "next/server";
import { createArrival } from "@/lib/channels/arrival";
import { getClinic } from "@/lib/grounding/corpus";

/**
 * Channel arrival — creates a LeadSession.
 *
 * The observable behaviour the brief asks to see: the same person arriving from
 * two channels gets two different openings, while the risk classification of
 * anything they then say is identical. Channel changes tone, never safety.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.channel !== "string") {
    return NextResponse.json({ error: "Expected { channel: string }" }, { status: 400 });
  }

  const clinic = getClinic();
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);

  try {
    const result = await createArrival(
      {
        clinicId: str("clinicId") ?? "00000000-0000-0000-0000-000000000001",
        channel: body.channel,
        campaignId: str("campaignId"),
        creative: str("creative"),
        pageTopic: str("pageTopic"),
        staffReferralNote: str("staffReferralNote"),
        staffName: str("staffName"),
        socialHandle: str("socialHandle"),
        volunteeredEmail: str("volunteeredEmail"),
        topic: str("topic"),
      },
      { clinicName: clinic.name, baseUrl: str("baseUrl") },
    );

    return NextResponse.json({
      lead_session_id: result.leadSession.id,
      opening: result.opening.opening,
      channel: result.opening.channel,
      channel_label: result.opening.channelLabel,
      identity_level: result.opening.identityLevel,
      time_of_day: result.opening.timeOfDay,
      response_expectation: result.opening.responseExpectation,
      // An identified lead is never asked for what they already gave.
      never_ask: result.opening.neverAsk,
      skip_questions: result.opening.skipQuestions,
      prefilled: result.opening.prefilled,
      sensitive_topic_rule_applied: result.opening.sensitiveTopicRuleApplied,
      ethics: result.opening.ethics,
      attribution: {
        clinic_id: result.leadSession.clinicId,
        source_channel: result.leadSession.sourceChannel,
        campaign_id: result.leadSession.campaignId ?? null,
        creative: result.leadSession.creative ?? null,
        identity_level: result.leadSession.identityLevel,
        landing_timestamp: result.leadSession.landingTimestamp,
      },
      recovery_url: result.recoveryUrl,
      persisted: result.persisted,
      persist_error: result.persistError ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown channel" },
      { status: 400 },
    );
  }
}
