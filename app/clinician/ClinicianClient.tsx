"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The nurse's morning screen.
 *
 * PLANNING §2 describes the person this is for: a triage nurse opening a queue
 * at 8am with forty overnight leads and twenty minutes before clinic. They do
 * not read chat logs. They need to know who is actually unwell, what the
 * one-line story is, and what the patient already said so they don't ask again.
 *
 * So the list is sorted by RISK, never by lead score, and every row leads with
 * the complaint rather than the channel. The escalation payload was built for
 * this screen; until now it had nowhere to go.
 */

interface QueueRow {
  id: string;
  status: string;
  risk: string;
  created_at: string;
  waiting_hours: number;
  overdue: boolean;
  chief_complaint: string | null;
  triage_summary: string;
  source_channel: string;
  campaign_id: string | null;
  fact_count: number;
}

interface Detail {
  escalation: {
    id: string;
    status: string;
    triage_summary: string;
    sla_due_at: string;
    profile: { current?: Record<string, unknown>; history?: unknown[] };
    history: { complaint_label?: string; completeness_pct?: number; fields?: { label: string; value: string | null; answered: boolean }[] };
    acquisition: Record<string, unknown>;
  };
  conversation: {
    messages: { id: string; role: string; text_redacted: string; risk_level: string | null; created_at: string }[];
  } | null;
}

const RISK_STYLE: Record<string, string> = {
  high: "bg-red-50 text-red-800 border-red-200",
  medium: "bg-amber-50 text-amber-800 border-amber-200",
  low: "bg-slate-50 text-slate-700 border-slate-200",
};

export default function ClinicianClient() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Detail | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/clinician/queue");
      const data = await res.json();
      if (!res.ok) {
        setUnavailable(data.detail ?? data.error ?? "Queue unavailable");
        setRows([]);
        return;
      }
      setUnavailable(null);
      setRows(data.queue ?? []);
      setCounts(data.counts ?? {});
    } catch {
      setUnavailable("Could not reach the queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function open(id: string) {
    const res = await fetch(`/api/clinician/queue?escalationId=${id}`);
    if (res.ok) setSelected(await res.json());
  }

  async function setStatus(id: string, status: string) {
    await fetch("/api/clinician/queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ escalationId: id, status }),
    });
    await refresh();
    if (selected?.escalation.id === id) await open(id);
  }

  if (loading) return <p className="p-8 text-sm text-slate-600">Loading queue…</p>;

  if (unavailable) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-2xl font-semibold text-slate-900">Triage queue</h1>
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">The queue is empty because nothing is being stored.</p>
          <p className="mt-2">{unavailable}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto grid max-w-6xl grid-cols-1 gap-4 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_420px]">
      <section>
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold text-slate-900">Triage queue</h1>
          <div className="flex items-center gap-4 text-sm">
            <a href="/dashboard" className="text-teal-800 hover:underline">
              Dashboard
            </a>
            <button onClick={refresh} className="text-teal-800 hover:underline">
              Refresh
            </button>
          </div>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Sorted by clinical risk, then by how long someone has been waiting.
          Never by lead value.
        </p>

        <div className="mt-4 flex gap-3 text-sm">
          <Count label="waiting" value={counts.total ?? 0} />
          <Count label="high risk" value={counts.high ?? 0} tone="text-red-700" />
          <Count label="overdue" value={counts.overdue ?? 0} tone="text-amber-700" />
        </div>

        {rows.length === 0 ? (
          <p className="mt-8 rounded-lg border border-slate-200 p-6 text-sm text-slate-600">
            Nothing waiting. When a patient sends their concern to a nurse, it
            appears here.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => open(r.id)}
                  className={`w-full rounded-lg border p-3 text-left hover:border-teal-500 ${
                    selected?.escalation.id === r.id ? "border-teal-600" : "border-slate-200"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase ${
                        RISK_STYLE[r.risk] ?? RISK_STYLE.low
                      }`}
                    >
                      {r.risk}
                    </span>
                    {r.overdue && (
                      <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800">
                        overdue
                      </span>
                    )}
                    <span className="ml-auto text-xs text-slate-600">
                      {r.waiting_hours}h · {r.status}
                    </span>
                  </div>
                  <p className="mt-1.5 font-medium text-slate-900">
                    {r.chief_complaint ?? "Concern not yet stated"}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-600">
                    {r.source_channel}
                    {r.campaign_id ? ` · ${r.campaign_id}` : ""} · {r.fact_count} facts on file
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside className="lg:sticky lg:top-8 lg:self-start">
        {!selected ? (
          <p className="rounded-lg border border-slate-200 p-6 text-sm text-slate-600">
            Select someone to see what they already told us.
          </p>
        ) : (
          <div className="rounded-lg border border-slate-200 p-4">
            <h2 className="font-semibold text-slate-900">Triage summary</h2>
            <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-slate-900">
              {selected.escalation.triage_summary}
            </pre>

            {selected.escalation.history?.fields && (
              <>
                <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-slate-600">
                  History · {selected.escalation.history.complaint_label} ·{" "}
                  {selected.escalation.history.completeness_pct}% complete
                </h3>
                <ul className="mt-1 space-y-0.5 text-sm">
                  {selected.escalation.history.fields.map((f) => (
                    <li key={f.label} className={f.answered ? "" : "text-slate-500"}>
                      <span className="text-slate-600">{f.label}:</span>{" "}
                      {f.value ?? "not asked"}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {selected.conversation && (
              <>
                <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-slate-600">
                  What they said — so you don&apos;t ask again
                </h3>
                <div className="mt-1 max-h-64 space-y-2 overflow-y-auto text-sm">
                  {selected.conversation.messages.map((m) => (
                    <p
                      key={m.id}
                      className={
                        m.role === "user"
                          ? "rounded bg-slate-100 px-2 py-1 text-slate-900"
                          : "px-2 py-1 text-slate-600"
                      }
                    >
                      {m.text_redacted}
                    </p>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  Personal details were removed before storage and cannot be
                  restored.
                </p>
              </>
            )}

            <div className="mt-4 flex gap-2">
              {["acknowledged", "in_review", "closed"].map((s) => (
                <button
                  key={s}
                  onClick={() => setStatus(selected.escalation.id, s)}
                  disabled={selected.escalation.status === s}
                  className="rounded border border-slate-300 px-2.5 py-1 text-xs text-slate-900 hover:border-teal-600 disabled:opacity-40"
                >
                  {s.replace("_", " ")}
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>
    </main>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-1.5">
      <span className={`font-semibold ${tone ?? "text-slate-900"}`}>{value}</span>{" "}
      <span className="text-slate-600">{label}</span>
    </div>
  );
}
