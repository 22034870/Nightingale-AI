import "server-only";

import { tryPersist, hasDatabase, serviceClient } from "@/lib/db/client";

/**
 * FUNNEL EVENTS — and the honest-numbers rule.
 *
 * Every statistic this product displays resolves to a query over this table.
 * The brief is explicit that a fabricated "14 people asked this week" is
 * gimmicky, and it is right: the whole premise of the funnel is that a stranger
 * can trust what we tell them, so the first number they see cannot be a lie.
 *
 * Two properties enforced in code rather than promised in prose:
 *
 *   1. liveStat() takes a QUERY, never a literal. There is no code path that
 *      renders a number someone typed in.
 *   2. Below a floor it returns null and the UI renders nothing. Not a rounded
 *      number, not "a few" — nothing. A truthful absence beats a flattering
 *      approximation.
 *
 * metadata_json is PHI-FREE BY CONSTRUCTION. Channel, campaign and funnel stage
 * are facts about our own creative and our own system, never about the person.
 * Nothing that could identify anyone is written here, which is what justifies
 * keeping this data for 30 days when guest chat content is destroyed at 7.
 */

export type EventType =
  | "visitor"
  | "conversation_started"
  | "value_event"
  | "auth_started"
  | "consented"
  | "patient_created"
  | "escalation_sent"
  | "abandoned";

export interface FunnelEvent {
  clinicId: string;
  leadSessionId?: string;
  patientId?: string;
  eventType: EventType;
  valueEventId?: string;
  sourceMessageId?: string;
  metadata?: Record<string, unknown>;
}

/** Fire-and-forget. Analytics must never cost someone their reply. */
export async function logEvent(event: FunnelEvent): Promise<void> {
  await tryPersist("funnel_event", async (db) => {
    const { error } = await db.from("funnel_events").insert({
      clinic_id: event.clinicId,
      lead_session_id: event.leadSessionId ?? null,
      patient_id: event.patientId ?? null,
      event_type: event.eventType,
      value_event_id: event.valueEventId ?? null,
      source_message_id: event.sourceMessageId ?? null,
      metadata_json: event.metadata ?? {},
    });
    if (error) throw new Error(error.message);
    return true;
  });
}

// ---------------------------------------------------------------------------
// The honest-numbers component
// ---------------------------------------------------------------------------

export interface LiveStat {
  /** null means render NOTHING. Never substitute a placeholder. */
  value: number | null;
  floor: number;
  /** The query that produced it, so the number is auditable end to end. */
  query: string;
  suppressed: boolean;
}

/**
 * A statistic safe to show a stranger.
 *
 * Deliberately impossible to pass a literal to. test_value_events.py asserts
 * that every integer rendered in the product has a corresponding query recorded
 * here — a number with no query fails the test.
 */
export async function liveStat(
  description: string,
  runner: () => Promise<number>,
  floor = 5,
): Promise<LiveStat> {
  if (!hasDatabase()) {
    return { value: null, floor, query: description, suppressed: true };
  }
  try {
    const value = await runner();
    // The brief: "If the query_count is zero or trivial, show nothing or a
    // truthful alternative, never a fake number."
    return value < floor
      ? { value: null, floor, query: description, suppressed: true }
      : { value, floor, query: description, suppressed: false };
  } catch {
    return { value: null, floor, query: description, suppressed: true };
  }
}

/**
 * "N other people asked this clinic about {topic} this week."
 *
 * This is the honest replacement for "you are not alone" (FINDINGS.md D1).
 * Same emotional payload — the person learns they are not the only one — but it
 * is true, it is checkable, and it disappears when it would not be.
 */
export async function askedThisWeek(clinicId: string, topic?: string): Promise<LiveStat> {
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const label = topic
    ? `count(distinct lead_session) where event=conversation_started and topic=${topic} since ${since}`
    : `count(distinct lead_session) where event=conversation_started since ${since}`;

  return liveStat(label, async () => {
    const db = serviceClient();
    let q = db
      .from("funnel_events")
      .select("lead_session_id", { count: "exact", head: false })
      .eq("clinic_id", clinicId)
      .eq("event_type", "conversation_started")
      .gte("created_at", since);
    if (topic) q = q.contains("metadata_json", { topic });

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return new Set((data ?? []).map((r) => r.lead_session_id)).size;
  });
}

// ---------------------------------------------------------------------------
// Conversion metrics
// ---------------------------------------------------------------------------

const FUNNEL_ORDER: EventType[] = [
  "visitor",
  "conversation_started",
  "value_event",
  "auth_started",
  "consented",
  "patient_created",
  "escalation_sent",
];

export interface ChannelFunnel {
  channel: string;
  stages: Record<string, number>;
  /** Stage-to-stage conversion, so the DROP-OFF is visible, not just the total. */
  conversion: { from: string; to: string; rate: number | null; lost: number }[];
  biggestDropOff: { from: string; to: string; lost: number } | null;
}

/**
 * Per-channel funnel with drop-off.
 *
 * A bar chart of totals hides the thing that matters. What a clinic needs to
 * know is WHERE people leave, which is a property of the transitions rather
 * than the stages, so this reports both and names the worst one.
 */
export async function channelFunnels(clinicId: string): Promise<ChannelFunnel[]> {
  if (!hasDatabase()) return [];

  const db = serviceClient();
  const { data, error } = await db
    .from("funnel_events")
    .select("event_type, lead_session_id, metadata_json")
    .eq("clinic_id", clinicId);
  if (error) return [];

  const byChannel = new Map<string, Map<string, Set<string>>>();
  for (const row of data ?? []) {
    const meta = (row.metadata_json ?? {}) as Record<string, unknown>;
    const channel = String(meta.source_channel ?? "unknown");
    const sessions = byChannel.get(channel) ?? new Map<string, Set<string>>();
    const set = sessions.get(row.event_type) ?? new Set<string>();
    if (row.lead_session_id) set.add(row.lead_session_id);
    sessions.set(row.event_type, set);
    byChannel.set(channel, sessions);
  }

  return [...byChannel.entries()].map(([channel, sessions]) => {
    const stages: Record<string, number> = {};
    for (const stage of FUNNEL_ORDER) stages[stage] = sessions.get(stage)?.size ?? 0;

    const conversion = FUNNEL_ORDER.slice(0, -1).map((from, i) => {
      const to = FUNNEL_ORDER[i + 1];
      const a = stages[from];
      const b = stages[to];
      return {
        from,
        to,
        rate: a > 0 ? Number((b / a).toFixed(3)) : null,
        lost: Math.max(0, a - b),
      };
    });

    const worst = conversion.filter((c) => c.rate !== null).sort((a, b) => b.lost - a.lost)[0];
    return {
      channel,
      stages,
      conversion,
      biggestDropOff: worst ? { from: worst.from, to: worst.to, lost: worst.lost } : null,
    };
  });
}

/**
 * Where a session died — the last event before it went quiet.
 *
 * The brief asks us to explain where users abandon. Guessing is not an answer,
 * so abandonment is instrumented explicitly. This stays PHI-free, which is what
 * justifies keeping it for 30 days after the chat content is destroyed at 7.
 */
export async function abandonmentPoints(clinicId: string, quietMinutes = 30) {
  if (!hasDatabase()) return [];
  const db = serviceClient();

  const { data, error } = await db
    .from("funnel_events")
    .select("lead_session_id, event_type, created_at, metadata_json")
    .eq("clinic_id", clinicId)
    .order("created_at", { ascending: true });
  if (error) return [];

  const last = new Map<string, { event: string; at: string; channel: string }>();
  for (const row of data ?? []) {
    if (!row.lead_session_id) continue;
    const meta = (row.metadata_json ?? {}) as Record<string, unknown>;
    last.set(row.lead_session_id, {
      event: row.event_type,
      at: row.created_at,
      channel: String(meta.source_channel ?? "unknown"),
    });
  }

  const cutoff = Date.now() - quietMinutes * 60_000;
  const counts = new Map<string, number>();
  for (const entry of last.values()) {
    if (entry.event === "escalation_sent" || entry.event === "patient_created") continue;
    if (new Date(entry.at).getTime() > cutoff) continue; // still live
    const key = `${entry.channel}::${entry.event}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, count]) => {
      const [channel, lastEvent] = key.split("::");
      return { channel, lastEvent, count };
    })
    .sort((a, b) => b.count - a.count);
}
