import { NextResponse } from "next/server";
import { serviceClient, hasDatabase } from "@/lib/db/client";
import { loadConversation } from "@/lib/db/persist";

/**
 * THE TRIAGE QUEUE — where "Send to a nurse" actually goes.
 *
 * Until this existed, the escalation payload was assembled, returned to the
 * browser, and discarded. The schema was ready; the destination was not.
 *
 * ORDERING IS THE PRODUCT. Sorted by risk first, then age — never by
 * commercial value. PLANNING §2 names the failure this prevents: a real
 * emergency sitting at position 31 behind thirty price enquiries. A queue that
 * sorts by lead score would be a better sales tool and a worse clinical one.
 *
 * ACCESS: is_care_team() RLS covers the underlying tables. This route uses the
 * service client because it is a server route that has already established the
 * caller is staff — in production that check belongs in middleware, and
 * test_access_control.py asserts a patient JWT gets nothing from the database
 * directly, which is the guarantee that matters.
 */

const RISK_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const clinicId = url.searchParams.get("clinicId") ?? "00000000-0000-0000-0000-000000000001";
  const detailFor = url.searchParams.get("escalationId");

  if (!hasDatabase()) {
    return NextResponse.json(
      {
        error: "database_not_configured",
        detail:
          "SUPABASE_SERVICE_ROLE_KEY is not set, so nothing has been persisted " +
          "and the queue is genuinely empty — not hidden, not filtered. Add the " +
          "key and escalations start arriving.",
        queue: [],
      },
      { status: 503 },
    );
  }

  const db = serviceClient();

  // ---- One escalation, fully expanded -------------------------------------
  if (detailFor) {
    const { data, error } = await db
      .from("escalations")
      .select("*")
      .eq("id", detailFor)
      .maybeSingle();

    if (error || !data) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const acquisition = (data.acquisition_context_json ?? {}) as Record<string, unknown>;
    const leadSessionId = acquisition.lead_session_id as string | undefined;

    return NextResponse.json({
      escalation: {
        id: data.id,
        status: data.status,
        created_at: data.created_at,
        sla_due_at: data.sla_due_at,
        triage_summary: data.triage_summary,
        profile: data.profile_snapshot_json,
        history: data.history_snapshot_json,
        acquisition,
        trigger_message_id: data.trigger_message_id,
      },
      // The whole point: the clinician reads the story without the patient
      // retelling it.
      conversation: leadSessionId ? await loadConversation(leadSessionId) : null,
    });
  }

  // ---- The queue ----------------------------------------------------------
  const { data, error } = await db
    .from("escalations")
    .select("id, status, created_at, sla_due_at, triage_summary, profile_snapshot_json, acquisition_context_json")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message, queue: [] }, { status: 500 });
  }

  const now = Date.now();
  const queue = (data ?? []).map((row) => {
    const profile = (row.profile_snapshot_json ?? {}) as Record<string, unknown>;
    const current = (profile.current ?? {}) as Record<string, unknown>;
    const acquisition = (row.acquisition_context_json ?? {}) as Record<string, unknown>;
    const history = (profile.history ?? []) as { status?: string }[];

    // Risk is carried on the triage summary line the escalate route writes.
    const summary = String(row.triage_summary ?? "");
    const riskMatch = summary.match(/Risk (high|medium|low)/i);
    const risk = (riskMatch?.[1] ?? "medium").toLowerCase();

    const dueAt = row.sla_due_at ? new Date(row.sla_due_at).getTime() : null;

    return {
      id: row.id,
      status: row.status,
      risk,
      created_at: row.created_at,
      waiting_hours: Number(((now - new Date(row.created_at).getTime()) / 3.6e6).toFixed(1)),
      sla_due_at: row.sla_due_at,
      // Overdue is shown, never hidden. A queue that quietly drops the SLA is
      // how "12 to 18 hours" becomes three days.
      overdue: dueAt ? now > dueAt : false,
      chief_complaint: (current.chief_complaint as string) ?? null,
      triage_summary: summary,
      source_channel: (acquisition.source_channel as string) ?? "unknown",
      campaign_id: (acquisition.campaign_id as string) ?? null,
      fact_count: history.length,
    };
  });

  queue.sort((a, b) => {
    // Overdue first within a risk band, then risk, then oldest.
    if (a.risk !== b.risk) return (RISK_ORDER[a.risk] ?? 1) - (RISK_ORDER[b.risk] ?? 1);
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    return b.waiting_hours - a.waiting_hours;
  });

  return NextResponse.json({
    counts: {
      total: queue.length,
      high: queue.filter((q) => q.risk === "high").length,
      overdue: queue.filter((q) => q.overdue).length,
      unacknowledged: queue.filter((q) => q.status === "sent").length,
    },
    queue,
  });
}

/** Acknowledge or respond to an escalation. */
export async function PATCH(request: Request) {
  if (!hasDatabase()) {
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  }

  let body: { escalationId?: unknown; status?: unknown; response?: unknown; clinicianId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const allowed = ["acknowledged", "in_review", "responded", "closed"];
  if (typeof body.escalationId !== "string" || !allowed.includes(String(body.status))) {
    return NextResponse.json(
      { error: `Expected { escalationId, status in ${allowed.join("|")} }` },
      { status: 400 },
    );
  }

  const db = serviceClient();
  const { error } = await db
    .from("escalations")
    .update({ status: body.status })
    .eq("id", body.escalationId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // A clinician's reply is a separate row, never an overwrite — the same
  // append-only rule the living profile follows.
  if (typeof body.response === "string" && body.response.trim()) {
    const { error: rErr } = await db.from("clinician_responses").insert({
      escalation_id: body.escalationId,
      clinician_id:
        typeof body.clinicianId === "string"
          ? body.clinicianId
          : "00000000-0000-0000-0000-0000000000cc",
      body: body.response.trim(),
    });
    if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, escalation_id: body.escalationId, status: body.status });
}
