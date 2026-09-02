"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * THE CLINIC MANAGER'S SCREEN.
 *
 * Two things a clinic actually asks: who is waiting for us right now, and where
 * are we losing the people who never got that far. The queue answers the first
 * and lives at /clinician. This answers the second.
 *
 * DESIGN RULE, INHERITED FROM THE PATIENT SIDE: no number appears here that is
 * not an aggregate over rows. There is no sample data, no placeholder chart, no
 * "1,247 patients helped". When the database is unconfigured this page says so
 * in plain words instead of rendering something reassuring and false — which is
 * the same standard the product holds the chatbot to.
 */

interface Step {
  from: string;
  to: string;
  rate: number;
  lost: number;
}

interface Funnel {
  channel: string;
  stages: Record<string, number>;
  steps: Step[];
  biggest_drop_off: Step | null;
  entered: number;
  completed: number;
  completion_rate: number | null;
}

interface Analytics {
  window_days: number;
  provenance: { events_analysed: number; synthetic_events: number; note: string | null };
  totals: {
    sessions: number;
    escalations: number;
    overdue_escalations: number;
    median_minutes_to_value: number | null;
  };
  risk_mix: Record<string, number>;
  funnels: Funnel[];
  abandonment: { channel: string; last_event: string; count: number }[];
  escalation_status: Record<string, number>;
}

const STAGE_LABEL: Record<string, string> = {
  visitor: "Arrived",
  conversation_started: "Said something",
  value_event: "Got real help",
  auth_started: "Started signup",
  consented: "Consented",
  patient_created: "Account created",
  escalation_sent: "Reached a nurse",
};

export default function DashboardClient() {
  const [data, setData] = useState<Analytics | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (window: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/analytics?days=${window}`);
      const json = await res.json();
      if (!res.ok) {
        setUnavailable(json.detail ?? json.error ?? "Analytics unavailable");
        setData(null);
        return;
      }
      setUnavailable(null);
      setData(json as Analytics);
    } catch {
      setUnavailable("Could not reach the analytics endpoint.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [load, days]);

  if (loading && !data) {
    return <p className="p-8 text-sm text-slate-600">Loading…</p>;
  }

  if (unavailable) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-2xl font-semibold text-slate-900">Clinic dashboard</h1>
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">There is nothing to show, and that is accurate.</p>
          <p className="mt-2">{unavailable}</p>
          <p className="mt-3 text-amber-800">
            This page could show a demo chart instead. It deliberately
            doesn&apos;t — a product that refuses to invent numbers for patients
            shouldn&apos;t invent them for the clinic either.
          </p>
        </div>
      </main>
    );
  }

  if (!data) return null;

  const isEmpty = data.totals.sessions === 0;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Clinic dashboard</h1>
          <p className="mt-1 text-sm text-slate-600">
            Every figure is a live aggregate over{" "}
            <code className="text-xs">funnel_events</code>. Nothing here is
            hard-coded.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded border border-slate-300 px-2 py-1 text-slate-900"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <a href="/clinician" className="text-teal-800 hover:underline">
            Triage queue →
          </a>
        </div>
      </div>

      {/* Provenance, stated before any number is read — not in a footnote. */}
      {data.provenance.note && (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-medium">Synthetic data.</span>{" "}
          {data.provenance.note}
        </p>
      )}

      {isEmpty ? (
        <div className="mt-6 rounded-lg border border-slate-200 p-6 text-sm text-slate-700">
          <p className="font-medium text-slate-900">No sessions in this window.</p>
          <p className="mt-2">
            The tables exist and the queries ran; there is simply no traffic yet.
            To exercise the pipeline with clearly-labelled generated data:
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-slate-900 px-3 py-2 text-xs text-slate-100">
            python scripts/replay_traffic.py --sessions 200
          </pre>
        </div>
      ) : (
        <>
          <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="sessions" value={data.totals.sessions} />
            <Stat label="reached a nurse" value={data.totals.escalations} />
            <Stat
              label="past their SLA"
              value={data.totals.overdue_escalations}
              tone={data.totals.overdue_escalations > 0 ? "text-red-700" : undefined}
            />
            <Stat
              label="median mins to help"
              value={data.totals.median_minutes_to_value ?? "—"}
            />
          </section>

          <section className="mt-8">
            <h2 className="text-lg font-semibold text-slate-900">
              Where people leave
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Per channel. The step that loses the most people is called out,
              because the total at each stage hides which transition is actually
              failing.
            </p>

            <div className="mt-4 space-y-4">
              {data.funnels.map((f) => (
                <FunnelCard key={f.channel} funnel={f} />
              ))}
            </div>
          </section>

          <section className="mt-8 grid gap-6 md:grid-cols-2">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Risk mix</h2>
              <p className="mt-1 text-sm text-slate-600">
                Emergencies are rare. That rarity is exactly why the queue sorts
                by risk and not by volume.
              </p>
              <div className="mt-3 space-y-1.5">
                {(["high", "medium", "low"] as const).map((r) => (
                  <Bar
                    key={r}
                    label={r}
                    value={data.risk_mix[r] ?? 0}
                    max={Math.max(1, ...Object.values(data.risk_mix))}
                    tone={
                      r === "high"
                        ? "bg-red-500"
                        : r === "medium"
                          ? "bg-amber-400"
                          : "bg-slate-400"
                    }
                  />
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Last thing they did
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Instrumented, not guessed — the final event recorded before each
                abandoned session went quiet.
              </p>
              <ul className="mt-3 space-y-1 text-sm">
                {data.abandonment.slice(0, 8).map((a) => (
                  <li
                    key={`${a.channel}-${a.last_event}`}
                    className="flex justify-between gap-3 border-b border-slate-100 py-1"
                  >
                    <span className="text-slate-700">
                      {STAGE_LABEL[a.last_event] ?? a.last_event}
                      <span className="text-slate-500"> · {a.channel}</span>
                    </span>
                    <span className="font-medium text-slate-900">{a.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function FunnelCard({ funnel }: { funnel: Funnel }) {
  const max = Math.max(1, ...Object.values(funnel.stages));
  const shown = Object.entries(funnel.stages).filter(([, v]) => v > 0);

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium text-slate-900">{funnel.channel}</h3>
        <span className="text-sm text-slate-600">
          {funnel.entered} in → {funnel.completed} reached a nurse
          {funnel.completion_rate !== null && (
            <strong className="ml-1.5 text-slate-900">
              {(funnel.completion_rate * 100).toFixed(1)}%
            </strong>
          )}
        </span>
      </div>

      <div className="mt-3 space-y-1">
        {shown.map(([stage, count]) => (
          <Bar
            key={stage}
            label={STAGE_LABEL[stage] ?? stage}
            value={count}
            max={max}
            tone="bg-teal-600"
          />
        ))}
      </div>

      {funnel.biggest_drop_off && funnel.biggest_drop_off.lost > 0 && (
        <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
          <span className="font-medium">Biggest loss:</span>{" "}
          {funnel.biggest_drop_off.lost} of{" "}
          {funnel.stages[funnel.biggest_drop_off.from]} people stopped between{" "}
          &ldquo;{STAGE_LABEL[funnel.biggest_drop_off.from]}&rdquo; and &ldquo;
          {STAGE_LABEL[funnel.biggest_drop_off.to]}&rdquo; —{" "}
          {(funnel.biggest_drop_off.rate * 100).toFixed(0)}% carried through.
        </p>
      )}
    </div>
  );
}

function Bar({
  label,
  value,
  max,
  tone = "bg-teal-600",
}: {
  label: string;
  value: number;
  max: number;
  tone?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-36 shrink-0 truncate text-slate-700">{label}</span>
      <div className="h-4 flex-1 rounded bg-slate-100">
        <div
          className={`h-4 rounded ${tone}`}
          style={{ width: `${Math.max(1.5, (value / max) * 100)}%` }}
        />
      </div>
      <span className="w-10 shrink-0 text-right font-medium text-slate-900">
        {value}
      </span>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2">
      <div className={`text-2xl font-semibold ${tone ?? "text-slate-900"}`}>
        {value}
      </div>
      <div className="text-xs text-slate-600">{label}</div>
    </div>
  );
}
