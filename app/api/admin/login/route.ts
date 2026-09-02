import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  adminPassword,
  issueToken,
  passwordMatches,
} from "@/lib/auth/adminSession";

/**
 * Sign in to the staff surfaces.
 *
 * Deliberately slow to brute-force through, and deliberately quiet about why a
 * given attempt failed — "wrong password" and "no such user" being
 * distinguishable is how an attacker enumerates. There is only one account
 * here, so the response says nothing beyond "that did not work".
 *
 * The one exception is a MISSING configuration, which is reported plainly.
 * That is an operator error on Jason's own deployment, not an authentication
 * signal, and leaving him to guess why a correct password is rejected would be
 * the same unhelpful silence this project avoids elsewhere.
 */

// Small in-memory throttle. Resets on cold start, which is acceptable: it slows
// a casual script rather than pretending to be rate limiting. Real protection
// belongs at the edge.
const attempts = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

export async function POST(request: Request) {
  if (!adminPassword()) {
    return NextResponse.json(
      {
        error: "not_configured",
        detail:
          "ADMIN_PASSWORD is not set, so the staff pages are closed to everyone. " +
          "Set it in .env.local (and in the Vercel project settings for the " +
          "deployed site), then restart.",
      },
      { status: 503 },
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "too_many_attempts", detail: "Too many attempts. Wait 15 minutes." },
      { status: 429 },
    );
  }

  let body: { password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!(await passwordMatches(body.password))) {
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }

  const token = await issueToken();
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  attempts.delete(ip);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, token, {
    // httpOnly: page scripts cannot read it, so an XSS bug cannot exfiltrate
    // the session. sameSite strict: it is not sent on cross-site navigation,
    // which is what stops another site driving the dashboard in Jason's
    // logged-in browser.
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}

/** Sign out. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
