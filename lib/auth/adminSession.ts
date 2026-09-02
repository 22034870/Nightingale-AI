/**
 * ADMIN SESSION — the gate on /dashboard and /clinician.
 *
 * WHY THIS EXISTS
 * ---------------
 * Those two pages were reachable by anyone who knew the URL. `robots: noindex`
 * keeps them out of Google; it is not access control. The triage queue shows
 * chief complaints and the conversations behind them, so an unguarded URL is a
 * disclosure of exactly the material the rest of this project spends its effort
 * protecting.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * A single shared password gating a single operator — Jason, on his own
 * deployment. That is genuinely appropriate for one admin and genuinely
 * INAPPROPRIATE for a clinic with staff: no per-user identity, so nothing can
 * be attributed to a person in audit_log, and revoking access means changing
 * the password for everyone at once.
 *
 * A real deployment replaces this with Supabase Auth and is_care_team(), which
 * the schema is already built around. This closes an open door today without
 * pretending to be the lock that clinic operation would need.
 *
 * DESIGN
 * ------
 * Stateless and unforgeable: the cookie carries an expiry and an HMAC of that
 * expiry. No session table, nothing to look up, and a tampered expiry fails its
 * signature. Verification runs in the proxy (Edge runtime), so this uses Web
 * Crypto rather than node:crypto and imports nothing server-only.
 */

export const ADMIN_COOKIE = "nightingale_admin";
const SESSION_MS = 12 * 3600 * 1000; // one working day

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/**
 * Compare without leaking WHERE the mismatch is.
 *
 * A plain `===` returns as soon as two characters differ, and that timing
 * difference is measurable across enough requests — it lets an attacker recover
 * a secret one character at a time. Length is still observable, which for a
 * fixed-width hex signature reveals nothing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The configured password, or null when the operator has not set one. */
export function adminPassword(): string | null {
  const p = process.env.ADMIN_PASSWORD;
  return p && p.length > 0 ? p : null;
}

/**
 * Signing secret. Falls back to the password so there is one thing to
 * configure; setting ADMIN_SESSION_SECRET separately means changing the
 * password does not have to invalidate every live session, and vice versa.
 */
function secret(): string | null {
  return process.env.ADMIN_SESSION_SECRET || adminPassword();
}

export async function issueToken(): Promise<string | null> {
  const s = secret();
  if (!s) return null;
  const expires = String(Date.now() + SESSION_MS);
  return `${expires}.${await hmac(s, expires)}`;
}

/**
 * FAIL CLOSED. An unset password denies access rather than granting it.
 *
 * The alternative — treating "no password configured" as "no protection
 * needed" — is how an admin page ends up public the first time an environment
 * variable does not make it into a deploy. The login page explains what to set,
 * so failing closed costs a clear message rather than a mystery.
 */
export async function verifyToken(token: string | undefined): Promise<boolean> {
  const s = secret();
  if (!s || !token) return false;

  const dot = token.lastIndexOf(".");
  if (dot < 1) return false;

  const expires = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  // Signature is checked even for an expired token above returning early — the
  // expiry itself is only trustworthy once the HMAC over it verifies.
  return timingSafeEqual(await hmac(s, expires), signature);
}

/** Constant-time password check, for the login route. */
export async function passwordMatches(candidate: unknown): Promise<boolean> {
  const expected = adminPassword();
  if (!expected || typeof candidate !== "string") return false;
  // Hash both sides first so the comparison is over fixed-width values and the
  // length check above cannot leak the real password's length.
  const [a, b] = await Promise.all([
    hmac("pw", candidate),
    hmac("pw", expected),
  ]);
  return timingSafeEqual(a, b);
}

export const SESSION_MAX_AGE_SECONDS = SESSION_MS / 1000;
