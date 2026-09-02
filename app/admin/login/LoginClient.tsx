"use client";

import { useState } from "react";

/**
 * The staff sign-in screen.
 *
 * Nothing here is patient-facing, so it can be plain. The one thing it must do
 * well is distinguish "wrong password" from "nobody configured a password" —
 * the second is an operator error, and silently treating it as a failed login
 * would send Jason hunting for a typo that does not exist.
 */
export default function LoginClient({ next }: { next: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotConfigured(null);

    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        // Full navigation, not a client route change: the proxy has to see the
        // new cookie, and it only runs on a real request.
        window.location.href = next;
        return;
      }
      if (res.status === 503) {
        setNotConfigured(data.detail ?? "Admin access is not configured.");
      } else if (res.status === 429) {
        setError(data.detail ?? "Too many attempts.");
      } else {
        setError("That password was not accepted.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-xl font-semibold text-slate-900">Staff sign-in</h1>
      <p className="mt-1 text-sm text-slate-600">
        The dashboard and triage queue show patient concerns. They are not
        public.
      </p>

      {notConfigured ? (
        <div className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">No password is configured.</p>
          <p className="mt-2">{notConfigured}</p>
          <pre className="mt-3 overflow-x-auto rounded bg-slate-900 px-3 py-2 text-xs text-slate-100">
            ADMIN_PASSWORD=choose-something-long
          </pre>
          <p className="mt-2 text-amber-800">
            Until it is set, these pages are closed to everyone — including you.
            That is deliberate: an unset password must never mean &ldquo;no lock
            needed&rdquo;.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-5">
          <label htmlFor="pw" className="block text-sm font-medium text-slate-900">
            Password
          </label>
          <input
            id="pw"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-slate-900 focus:border-teal-600 focus:outline-none"
          />
          {error && (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !password}
            className="mt-4 w-full rounded bg-teal-700 px-4 py-2 font-medium text-white hover:bg-teal-800 disabled:opacity-40"
          >
            {busy ? "Checking…" : "Sign in"}
          </button>
        </form>
      )}

      <p className="mt-6 text-xs text-slate-500">
        One shared password for one operator. A clinic with staff needs
        per-person accounts so actions can be attributed and access revoked
        individually — the schema already assumes that via is_care_team().
      </p>
    </main>
  );
}
