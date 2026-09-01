import "server-only";

import { randomUUID, randomBytes } from "node:crypto";
import { resolveOpening, isSensitiveTopic, type OpeningContext } from "./rules";
import { tryPersist } from "@/lib/db/client";
import { logEvent } from "@/lib/funnel/events";

/**
 * ARRIVAL — creating a LeadSession.
 *
 * Every entry point in the product lands here, and the attribution captured at
 * this moment has to survive all the way to the escalation payload a clinician
 * reads. The brief calls that out twice, and it is the property
 * test_guest_to_patient_conversion.py asserts: a fact on the clinician's screen
 * must resolve back through the message, to the session, to the ad.
 *
 * The recovery_token exists because the brief asks whether an abandoned guest
 * can return with context intact. It is a bearer token in a link, so it is
 * random, single-purpose, and expires with the session's 7-day retention.
 */

export interface ArrivalInput {
  clinicId: string;
  channel: string;
  campaignId?: string;
  creative?: string;
  pageTopic?: string;
  staffReferralNote?: string;
  staffName?: string;
  socialHandle?: string;
  volunteeredEmail?: string;
  topic?: string;
}

export interface LeadSession {
  id: string;
  clinicId: string;
  sourceChannel: string;
  campaignId?: string;
  creative?: string;
  identityLevel: string;
  landingTimestamp: string;
  pageTopic?: string;
  staffReferralNote?: string;
  socialHandle?: string;
  volunteeredEmail?: string;
  recoveryToken: string;
  expiresAt: string;
}

export interface ArrivalResult {
  leadSession: LeadSession;
  opening: ReturnType<typeof resolveOpening>;
  recoveryUrl: string;
  persisted: boolean;
  persistError?: string;
}

/** 7 days — matches the guest-data retention decision in PLANNING §12. */
const GUEST_RETENTION_DAYS = 7;

export async function createArrival(
  input: ArrivalInput,
  opts: { baseUrl?: string; clinicName?: string; at?: Date } = {},
): Promise<ArrivalResult> {
  const at = opts.at ?? new Date();
  const id = randomUUID();
  const recoveryToken = randomBytes(24).toString("base64url");

  // The topic can arrive from three different places depending on channel.
  const topic = input.topic ?? input.staffReferralNote ?? input.pageTopic ?? input.campaignId;

  const ctx: OpeningContext = {
    clinic_name: opts.clinicName,
    staff_name: input.staffName ?? "A member of the team",
    topic,
    page_topic: input.pageTopic,
    campaign: input.campaignId,
    // The stigma rule: a stigmatised topic strips clinical content from any
    // outbound reply, whatever the channel would otherwise have said.
    sensitiveTopic: isSensitiveTopic(topic),
  };

  const opening = resolveOpening(input.channel, ctx, at);

  const leadSession: LeadSession = {
    id,
    clinicId: input.clinicId,
    sourceChannel: input.channel,
    campaignId: input.campaignId,
    creative: input.creative,
    identityLevel: opening.identityLevel,
    landingTimestamp: at.toISOString(),
    pageTopic: input.pageTopic,
    staffReferralNote: input.staffReferralNote,
    socialHandle: input.socialHandle,
    volunteeredEmail: input.volunteeredEmail,
    recoveryToken,
    expiresAt: new Date(at.getTime() + GUEST_RETENTION_DAYS * 864e5).toISOString(),
  };

  const persist = await tryPersist("lead_session", async (db) => {
    const { error } = await db.from("lead_sessions").insert({
      id,
      clinic_id: input.clinicId,
      source_channel: input.channel,
      campaign_id: input.campaignId ?? null,
      creative: input.creative ?? null,
      identity_level: opening.identityLevel,
      landing_timestamp: leadSession.landingTimestamp,
      page_topic: input.pageTopic ?? null,
      staff_referral_note: input.staffReferralNote ?? null,
      social_handle: input.socialHandle ?? null,
      volunteered_email: input.volunteeredEmail ?? null,
      recovery_token: recoveryToken,
      expires_at: leadSession.expiresAt,
    });
    if (error) throw new Error(error.message);
    return true;
  });

  await logEvent({
    clinicId: input.clinicId,
    leadSessionId: id,
    eventType: "visitor",
    metadata: {
      // PHI-free by construction: channel and campaign are facts about OUR
      // creative, never about the person.
      source_channel: input.channel,
      campaign_id: input.campaignId ?? null,
      identity_level: opening.identityLevel,
      time_of_day: opening.timeOfDay,
      sensitive_topic_rule: opening.sensitiveTopicRuleApplied,
    },
  });

  const base = opts.baseUrl ?? process.env.NEXT_PUBLIC_BASE_URL ?? "";
  return {
    leadSession,
    opening,
    recoveryUrl: `${base}/s/${recoveryToken}`,
    persisted: persist.ok,
    persistError: persist.ok ? undefined : persist.error,
  };
}

/**
 * Staff referral link.
 *
 * The brief's mandatory contract: a clinician types what was discussed, and the
 * generated link opens already knowing it. This is how an in-person visit feeds
 * the funnel, and it is the highest-trust arrival we handle — consent happened
 * face to face.
 */
export async function createStaffReferral(
  input: { clinicId: string; staffName: string; note: string },
  opts: { baseUrl?: string; clinicName?: string } = {},
): Promise<ArrivalResult> {
  return createArrival(
    {
      clinicId: input.clinicId,
      channel: "staff_referral",
      staffReferralNote: input.note,
      staffName: input.staffName,
      topic: input.note,
    },
    opts,
  );
}

/** Session recovery — an abandoned guest returning within the retention window. */
export async function recoverSession(token: string) {
  const result = await tryPersist("session_recovery", async (db) => {
    const { data, error } = await db
      .from("lead_sessions")
      .select("*")
      .eq("recovery_token", token)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });

  if (!result.ok || !result.data) return null;
  const row = result.data as Record<string, unknown>;

  // Expiry is enforced here as well as by the purge job. A token that outlives
  // its data must not resurrect a session we promised to destroy.
  if (new Date(String(row.expires_at)) < new Date()) return null;
  return row;
}
