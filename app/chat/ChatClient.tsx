"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The patient-facing thread.
 *
 * Deliberately plain. Report F (Zhu & Broadbent 2025, N=160 randomised) found a
 * human-like agent produced LESS honest disclosure of sensitive symptoms than a
 * plain text interface — the mechanism people respond to is perceived anonymity,
 * and a convincing persona reintroduces the observer they were relieved to
 * escape. So: no avatar, no typing personality, no performed empathy. Warm,
 * plain, and obviously a machine that routes to humans.
 *
 * The profile panel is the brief's "Patient Profile (sidebar/state) that updates
 * live". On mobile it sits under the thread rather than beside it.
 */

interface Citation {
  chunkId: string;
  sourceUrl: string;
  charStart: number;
  charEnd: number;
  documentTitle: string;
}

interface Message {
  role: "user" | "assistant";
  text: string;
  risk?: string;
  citations?: Citation[];
  escalationRequired?: boolean;
  crisis?: boolean;
}

interface Profile {
  chief_complaint: string | null;
  symptoms: { value: string; timeline: string | null; status: string }[];
  medications: { value: string; status: string; timeline: string | null }[];
  allergies: { value: string }[];
}

interface HistoryState {
  complaint: string;
  completeness_pct: number;
  progress: { done: number; total: number };
  halted_reason: string | null;
  filled: Record<string, string>;
}

const EMPTY_PROFILE: Profile = {
  chief_complaint: null,
  symptoms: [],
  medications: [],
  allergies: [],
};

export default function ChatClient({ opening }: { opening: string }) {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: opening },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [history, setHistory] = useState<HistoryState | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [canEscalate, setCanEscalate] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [state, setState] = useState<Record<string, unknown>>({
    memoryItems: [],
    historyFilled: {},
    askedCount: 0,
  });

  // A ref, not the `busy` state, guards against double submission.
  //
  // React state updates are asynchronous, so two submits landing in the same
  // tick BOTH read busy===false and both fire. Observed in production: one
  // click on Send produced two POSTs to /api/chat 0.65s apart — double the
  // quota, double the extraction, and two assistant replies racing to set
  // state. A ref updates synchronously, so the second call sees it immediately.
  const inFlight = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  async function send() {
    const text = input.trim();
    if (!text || inFlight.current) return;
    inFlight.current = true;

    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    setBusy(true);

    try {
      const transcript = messages.slice(-6).map((m) => m.text);
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, history: transcript, ...state }),
      });
      const data = await res.json();

      if (!res.ok) {
        // Fail closed and say so. Never a silent drop.
        setMessages((m) => [
          ...m,
          { role: "assistant", text: data.reply ?? "Something went wrong. Please try again." },
        ]);
        return;
      }

      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: data.reply,
          risk: data.risk?.level,
          citations: data.citations,
          escalationRequired: data.escalation_required,
          crisis: data.crisis_pathway,
        },
      ]);
      setProfile(data.profile ?? EMPTY_PROFILE);
      setDegraded(Boolean(data.audit?.extraction?.unavailable) || Boolean(data.audit?.model_downgraded));
      setHistory(data.history ?? null);
      setBanner(data.emergency_banner ?? null);
      setCanEscalate(Boolean(data.escalation_required));
      setState(data.state ?? state);
    } catch (err) {
      // Never let a failed request take the page down. Say what happened.
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text:
            "I couldn't reach the clinic's system just then, and I haven't sent " +
            "anything anywhere. Please try again.",
        },
      ]);
      console.error("[nightingale] chat request failed", err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function escalate() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const last = [...messages].reverse().find((m) => m.role === "user");
      const res = await fetch("/api/escalate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: last?.text ?? "", ...state }),
      });
      const data = await res.json();
      // Honest confirmation: says what was sent and when to expect a reply,
      // computed from clinic hours rather than promised as a fixed number.
      setSent(data.response_expectation ?? "Sent to the clinical team.");
      setCanEscalate(false);
    } catch (err) {
      // An escalation that failed must never look like one that succeeded.
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text:
            "That didn't send. Nothing has reached the clinical team yet — " +
            "please try again, and if this is urgent call 999.",
        },
      ]);
      console.error("[nightingale] escalation failed", err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const filled = history ? Object.entries(history.filled) : [];

  return (
    <div className="mx-auto grid min-h-dvh max-w-5xl grid-cols-1 gap-4 p-3 md:grid-cols-[1fr_300px] md:p-6">
      {/* ---- Thread ---- */}
      <section className="flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white">
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h1 className="font-semibold text-slate-900">Nightingale</h1>
            <p className="text-xs text-slate-600">
              Automated assistant · not a doctor · Harmoni Medical Centre
            </p>
          </div>
          {history && (
            <div className="text-right">
              <p className="text-xs font-medium text-slate-700">
                {history.progress.done} of {history.progress.total}
              </p>
              <p className="text-[11px] text-slate-600">ready for the clinician</p>
            </div>
          )}
        </header>

        {history && history.progress.done > 0 && (
          <div className="h-1 w-full bg-slate-100">
            <div
              className="h-1 bg-teal-600 transition-all duration-500"
              style={{ width: `${history.completeness_pct}%` }}
            />
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-teal-600 text-white"
                    : m.crisis
                      ? "border border-amber-300 bg-amber-50 text-slate-900"
                      : "bg-slate-100 text-slate-900"
                }`}
              >
                <p className="whitespace-pre-wrap">{m.text}</p>

                {m.citations && m.citations.length > 0 && (
                  <p className="mt-2 border-t border-slate-200 pt-1.5 text-[11px] text-slate-600">
                    From{" "}
                    {[...new Set(m.citations.map((c) => c.documentTitle))].join(", ")}
                  </p>
                )}
              </div>
            </div>
          ))}
          {busy && <p className="text-xs text-slate-500">Working…</p>}
          <div ref={endRef} />
        </div>

        {sent && (
          <div className="mx-4 mb-3 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-900">
            <strong>Sent to the clinical team.</strong> {sent}
          </div>
        )}

        {canEscalate && !sent && (
          <div className="px-4 pb-3">
            <button
              onClick={escalate}
              disabled={busy}
              className="w-full rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
            >
              Send this to a nurse — you won&apos;t have to explain it again
            </button>
          </div>
        )}

        <div className="border-t border-slate-200 p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="flex gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your message…"
              disabled={busy}
              aria-label="Your message"
              autoComplete="off"
              className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-600"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              aria-busy={busy}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40"
            >
              Send
            </button>
          </form>

          {/* Persistent, never scrolled away. Required by the brief. */}
          <p className="mt-2 text-center text-[11px] text-slate-600">
            {banner ?? "If this is an emergency, exit Nightingale and dial 999 for Emergency Services."}
          </p>
        </div>
      </section>

      {/* ---- Live profile ---- */}
      <aside className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold text-slate-900">What the clinician will see</h2>
        <p className="mt-0.5 text-xs text-slate-600">
          Updates as we talk. Nothing is sent until you choose to send it.
        </p>

        {degraded && (
          <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
            Running in reduced mode — some details may not have been captured
            automatically. Safety checks are unaffected.
          </p>
        )}

        <Section title="Main concern">
          {profile.chief_complaint ? (
            <p>{profile.chief_complaint}</p>
          ) : (
            <p className="text-slate-500">Not yet</p>
          )}
        </Section>

        <Section title="Symptoms">
          {profile.symptoms.length ? (
            <ul className="space-y-1">
              {profile.symptoms.map((s, i) => (
                <li key={i}>
                  {s.value}
                  {s.timeline && <span className="text-slate-500"> · {s.timeline}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-slate-500">Not yet</p>
          )}
        </Section>

        <Section title="Medications">
          {profile.medications.length ? (
            <ul className="space-y-1">
              {profile.medications.map((m, i) => (
                <li key={i}>
                  {m.value}{" "}
                  <span
                    className={
                      m.status === "stopped" ? "text-amber-700" : "text-teal-700"
                    }
                  >
                    ({m.status}
                    {m.timeline ? `, ${m.timeline}` : ""})
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-slate-500">Not yet</p>
          )}
        </Section>

        <Section title="Allergies">
          {profile.allergies.length ? (
            <ul>{profile.allergies.map((a, i) => <li key={i}>{a.value}</li>)}</ul>
          ) : (
            <p className="text-slate-500">Not yet</p>
          )}
        </Section>

        {filled.length > 0 && (
          <Section title={`History · ${history?.complaint}`}>
            <ul className="space-y-1">
              {filled.map(([k, v]) => (
                <li key={k}>
                  <span className="text-slate-500">{k}:</span> {v}
                </li>
              ))}
            </ul>
            {history?.halted_reason === "high_risk" && (
              <p className="mt-2 text-xs text-amber-700">
                Paused — this needs a clinician now, not more questions.
              </p>
            )}
          </Section>
        )}
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-600">
        {title}
      </h3>
      <div className="text-slate-900">{children}</div>
    </div>
  );
}
