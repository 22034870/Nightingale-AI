import { NextResponse } from "next/server";
import { loadRedFlags, loadCopyRules } from "@/lib/config";
import { getChunks } from "@/lib/grounding/corpus";
import { loadChecklists } from "@/lib/history/engine";

/**
 * Deployment health check.
 *
 * Built after losing an hour to "it says error" — the deployed environment is
 * opaque from outside, and diagnosing a bad API key by watching the chat fall
 * back to approved copy is guesswork. This answers directly: which
 * configuration is present, which credentials actually work, and what degrades
 * as a result.
 *
 * NEVER RETURNS A SECRET. Only presence, length, a four-character fingerprint,
 * and whether the credential authenticates. A fingerprint is enough to tell two
 * values apart when one of them is stale, which is the failure this exists to
 * catch — and useless to anyone who steals the response.
 */

function fingerprint(value: string | undefined) {
  if (!value) return { set: false as const };
  const trimmed = value.trim();
  return {
    set: true as const,
    length: trimmed.length,
    // Enough to compare against a local value, not enough to reconstruct one.
    starts: trimmed.slice(0, 4),
    ends: trimmed.slice(-4),
    // A pasted value with stray whitespace or quotes is a real and common bug.
    suspicious:
      trimmed !== value
        ? "surrounding whitespace"
        : /^["']|["']$/.test(trimmed)
          ? "value is quoted"
          : null,
  };
}

async function checkGemini(): Promise<Record<string, unknown>> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ...fingerprint(key), reachable: false, note: "not set" };

  try {
    // Listing models authenticates the key WITHOUT consuming generation quota,
    // which matters on a free tier of 20 requests/day/model.
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (res.ok) return { ...fingerprint(key), reachable: true };

    const body = await res.text().catch(() => "");
    let message = `HTTP ${res.status}`;
    try {
      message = JSON.parse(body)?.error?.message ?? message;
    } catch {}
    return { ...fingerprint(key), reachable: false, error: message.slice(0, 140) };
  } catch (err) {
    return {
      ...fingerprint(key),
      reachable: false,
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

async function checkSupabase(): Promise<Record<string, unknown>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const out: Record<string, unknown> = {
    url_set: Boolean(url),
    anon_key: fingerprint(anon),
    service_role_key: fingerprint(service),
  };

  if (!url || !anon) return { ...out, reachable: false, note: "url or anon key missing" };

  try {
    const res = await fetch(`${url}/rest/v1/clinics?select=id&limit=1`, {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
      signal: AbortSignal.timeout(8000),
    });
    const rows = res.ok ? ((await res.json()) as unknown[]) : [];
    return {
      ...out,
      reachable: res.ok,
      schema_applied: res.ok,
      // Seeding matters: unseeded, the access-control tests prove nothing.
      seeded: rows.length > 0,
    };
  } catch (err) {
    return { ...out, reachable: false, error: err instanceof Error ? err.message : "unknown" };
  }
}

export async function GET() {
  const [gemini, supabase] = await Promise.all([checkGemini(), checkSupabase()]);

  const config = (() => {
    try {
      const flags = loadRedFlags();
      const copy = loadCopyRules();
      const checklists = loadChecklists();
      return {
        ok: true,
        red_flag_rules: flags.red_flags.length,
        red_flag_variants: flags.red_flags.reduce((n, r) => n + r.variants.length, 0),
        brief_mandated: flags.red_flags.filter((r) => r.brief_mandated).length,
        banned_phrases: Object.values(copy.banned).reduce((n, b) => n + b.patterns.length, 0),
        complaint_types: Object.keys(checklists.complaint_types).length,
        grounding_chunks: getChunks().length,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "unknown" };
    }
  })();

  const telegram = {
    bot_token: fingerprint(process.env.TELEGRAM_BOT_TOKEN),
    webhook_secret: fingerprint(process.env.TELEGRAM_WEBHOOK_SECRET),
  };

  // What still works when something is missing. The safety layer is
  // deliberately independent of every credential here.
  const degradations: string[] = [];
  if (!gemini.reachable) {
    degradations.push(
      "No model: deterministic risk gate, crisis, identity and escalation paths " +
        "all still work. Grounded answers fall back to approved copy.",
    );
  }
  if (!supabase.service_role_key || !(supabase.service_role_key as { set: boolean }).set) {
    degradations.push("No service role key: nothing persists. Conversations still work.");
  }
  if (supabase.reachable && !supabase.seeded) {
    degradations.push(
      "Database not seeded: access-control assertions would pass vacuously. " +
        "Run db/seed/seed.py.",
    );
  }
  if (!telegram.bot_token.set) degradations.push("No Telegram token: bot cannot reply.");

  return NextResponse.json(
    {
      ok: config.ok,
      environment: process.env.NODE_ENV,
      config,
      gemini,
      supabase,
      telegram,
      degradations,
      note:
        "Fingerprints are four leading and four trailing characters — enough to " +
        "compare a deployed value against a local one, useless for reconstructing it.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
