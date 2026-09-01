import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase access.
 *
 * Two clients, and the distinction is the entire access-control story:
 *
 *   serviceClient() — bypasses RLS. Used ONLY by trusted server routes that
 *                     have already established who the caller is. Never
 *                     reachable from the browser.
 *
 *   userClient(jwt) — carries the caller's JWT, so every query is filtered by
 *                     the RLS policies in db/schema.sql. This is what proves
 *                     Patient A cannot read Patient B: the refusal comes from
 *                     Postgres, not from an if-statement someone could forget.
 *
 * test_access_control.py exercises the second one deliberately, because a test
 * against the service client would prove nothing at all.
 */

let cached: SupabaseClient | undefined;

export function hasDatabase(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

/**
 * Trusted client. Throws rather than silently degrading — a route that needs
 * to persist an escalation must not quietly succeed without writing it.
 */
export function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Persistence is unavailable; " +
        "add it to .env.local (Supabase > Settings > API).",
    );
  }

  if (!cached) {
    cached = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

/** Caller-scoped client. Every query passes through RLS. */
export function userClient(accessToken: string): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Supabase URL or anon key is not configured.");

  return createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Persist, but never at the cost of the conversation.
 *
 * A database write failing must not cost someone their reply mid-sentence. The
 * failure is returned so the caller can surface it honestly and the audit log
 * records it — what we never do is pretend the write happened.
 */
export async function tryPersist<T>(
  label: string,
  fn: (db: SupabaseClient) => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  if (!hasDatabase()) {
    return { ok: false, error: `${label}: database not configured` };
  }
  try {
    return { ok: true, data: await fn(serviceClient()) };
  } catch (err) {
    return { ok: false, error: `${label}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
