import "server-only";

import { hasDatabase, serviceClient } from "@/lib/db/client";

/**
 * WARM-LEAD SCORING.
 *
 * The brief asks for "a simple transparent score" and then states the rule that
 * actually matters: high-risk clinical content routes to escalation, never to a
 * sales touch — a high score on a clinical concern is a COMPASSION PRIORITY,
 * not a sales priority.
 *
 * So the risk override is applied AFTER scoring rather than folded in as a
 * term. That ordering is deliberate and it is the whole point: the UI can then
 * show both numbers side by side and say, in effect, "this lead scored 0.91,
 * and we are deliberately not selling to them." Burying risk inside the
 * weighted sum would produce the same routing and lose the ability to
 * demonstrate the principle.
 *
 * Every component is returned alongside the total, because a score a clinic
 * cannot interrogate is a score they will not trust. Weights are stated, not
 * tuned — there is no calibration data yet, and pretending otherwise would be
 * the same dishonesty as a fabricated statistic.
 */

export const WEIGHTS = {
  recency: 0.35,
  channel: 0.25,
  identity: 0.2,
  stage: 0.2,
} as const;

/** Half-life in hours. A lead 12h old scores half what a fresh one does. */
export const RECENCY_HALF_LIFE_HOURS = 12;

/**
 * Channel weights reflect how much the person has already invested, not how
 * much revenue the channel historically produces. Someone a clinician referred
 * in person has committed more than someone who tapped an ad.
 */
export const CHANNEL_WEIGHTS: Record<string, number> = {
  staff_referral: 1.0,
  lead_form: 0.8,
  telegram_bot: 0.7,
  website_widget: 0.6,
  social_comment: 0.5,
  instagram_ad_click: 0.4,
  unknown: 0.3,
};

export const IDENTITY_WEIGHTS: Record<string, number> = {
  anonymous: 0.2,
  handle_only: 0.5,
  identified: 0.8,
  verified: 1.0,
};

export const STAGE_WEIGHTS: Record<string, number> = {
  visitor: 0.1,
  conversation_started: 0.3,
  value_event: 0.5,
  auth_started: 0.7,
  consented: 0.9,
  patient_created: 0.95,
  escalation_sent: 1.0,
};

export interface ScoredLead {
  leadSessionId: string;
  channel: string;
  identityLevel: string;
  stage: string;
  hoursSinceLastEvent: number;
  topConcern: string | null;
  riskLevel: "low" | "medium" | "high" | null;
  score: number;
  /** Per-term contributions, so a clinic can see WHY this lead ranks here. */
  contributions: { term: string; weight: number; value: number; contribution: number }[];
  route: "sales_touch" | "clinical_escalation";
  /** True when risk overrode the commercial ranking. */
  compassionPriority: boolean;
  contactPermitted: boolean;
  suppressionReason: string | null;
}

export function recencyDecay(hours: number): number {
  return Math.pow(0.5, hours / RECENCY_HALF_LIFE_HOURS);
}

export function scoreLead(input: {
  leadSessionId: string;
  channel: string;
  identityLevel: string;
  stage: string;
  hoursSinceLastEvent: number;
  topConcern?: string | null;
  riskLevel?: "low" | "medium" | "high" | null;
  hasContact: boolean;
  hasMarketingConsent: boolean;
}): ScoredLead {
  const terms = [
    { term: "recency", weight: WEIGHTS.recency, value: recencyDecay(input.hoursSinceLastEvent) },
    { term: "channel", weight: WEIGHTS.channel, value: CHANNEL_WEIGHTS[input.channel] ?? CHANNEL_WEIGHTS.unknown },
    { term: "identity", weight: WEIGHTS.identity, value: IDENTITY_WEIGHTS[input.identityLevel] ?? 0.2 },
    { term: "funnel_stage", weight: WEIGHTS.stage, value: STAGE_WEIGHTS[input.stage] ?? 0.1 },
  ];

  const contributions = terms.map((t) => ({
    ...t,
    contribution: Number((t.weight * t.value).toFixed(4)),
  }));
  const score = Number(contributions.reduce((s, c) => s + c.contribution, 0).toFixed(3));

  // ---- THE OVERRIDE, applied after scoring -------------------------------
  const clinical = input.riskLevel === "medium" || input.riskLevel === "high";

  // Contact suggestions only where contact info AND consent exist. A clinical
  // escalation is not a marketing touch and needs no marketing consent — but it
  // is also not a sales suggestion, which is why it suppresses one.
  let contactPermitted = input.hasContact && input.hasMarketingConsent;
  let suppressionReason: string | null = null;

  if (!input.hasContact) suppressionReason = "no contact point on file";
  else if (!input.hasMarketingConsent) suppressionReason = "no recorded marketing consent";

  if (clinical) {
    contactPermitted = false;
    suppressionReason = "clinical concern — routed to escalation, not to a sales touch";
  }

  return {
    leadSessionId: input.leadSessionId,
    channel: input.channel,
    identityLevel: input.identityLevel,
    stage: input.stage,
    hoursSinceLastEvent: Number(input.hoursSinceLastEvent.toFixed(1)),
    topConcern: input.topConcern ?? null,
    riskLevel: input.riskLevel ?? null,
    score,
    contributions,
    route: clinical ? "clinical_escalation" : "sales_touch",
    compassionPriority: clinical,
    contactPermitted,
    suppressionReason,
  };
}

/**
 * The warm-lead view.
 *
 * Sorted with compassion priorities FIRST regardless of score, because the
 * failure mode this product exists to prevent is a real emergency sitting at
 * position 31 behind thirty price enquiries.
 */
export async function warmLeadView(clinicId: string): Promise<ScoredLead[]> {
  if (!hasDatabase()) return [];
  const db = serviceClient();

  const { data: sessions, error } = await db
    .from("lead_sessions")
    .select("id, source_channel, identity_level, volunteered_email, social_handle")
    .eq("clinic_id", clinicId);
  if (error || !sessions) return [];

  const { data: events } = await db
    .from("funnel_events")
    .select("lead_session_id, event_type, created_at, metadata_json")
    .eq("clinic_id", clinicId)
    .order("created_at", { ascending: true });

  const latest = new Map<string, { stage: string; at: string; risk: string | null; concern: string | null }>();
  const consented = new Set<string>();

  for (const e of events ?? []) {
    if (!e.lead_session_id) continue;
    const meta = (e.metadata_json ?? {}) as Record<string, unknown>;
    if (e.event_type === "consented" && meta.marketing === true) consented.add(e.lead_session_id);

    const prev = latest.get(e.lead_session_id);
    latest.set(e.lead_session_id, {
      stage: e.event_type,
      at: e.created_at,
      risk: (meta.risk_level as string) ?? prev?.risk ?? null,
      concern: (meta.top_concern as string) ?? prev?.concern ?? null,
    });
  }

  const now = Date.now();
  const scored = sessions.map((s) => {
    const l = latest.get(s.id);
    return scoreLead({
      leadSessionId: s.id,
      channel: s.source_channel,
      identityLevel: s.identity_level,
      stage: l?.stage ?? "visitor",
      hoursSinceLastEvent: l ? (now - new Date(l.at).getTime()) / 3.6e6 : 999,
      topConcern: l?.concern ?? null,
      riskLevel: (l?.risk as "low" | "medium" | "high" | null) ?? null,
      hasContact: Boolean(s.volunteered_email || s.social_handle),
      hasMarketingConsent: consented.has(s.id),
    });
  });

  return scored.sort((a, b) => {
    if (a.compassionPriority !== b.compassionPriority) return a.compassionPriority ? -1 : 1;
    return b.score - a.score;
  });
}

/** The formula, in the shape a Technical Brief can print verbatim. */
export function formulaDescription() {
  return {
    formula:
      "score = 0.35·recency_decay(h, half_life=12h) + 0.25·channel_weight " +
      "+ 0.20·identity_level_weight + 0.20·funnel_stage_weight",
    range: "0.0 – 1.0",
    override:
      "IF risk_level IN (medium, high) THEN route = CLINICAL_ESCALATION and all " +
      "sales-contact suggestions are suppressed. Applied AFTER scoring, never as a term.",
    weights: { ...WEIGHTS },
    calibration:
      "Weights are stated, not fitted. There is no outcome data yet, so any claim " +
      "of tuning would be as dishonest as a fabricated statistic. Calibrating would " +
      "need contact-to-booking outcomes per channel over roughly one quarter.",
  };
}
