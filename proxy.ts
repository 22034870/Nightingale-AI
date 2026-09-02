import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ADMIN_COOKIE, verifyToken } from "@/lib/auth/adminSession";

/**
 * Gate the staff surfaces.
 *
 * In Next.js 16 this file is `proxy.ts`; `middleware.ts` is the deprecated
 * name for the same convention.
 *
 * THE API ROUTES ARE IN THE MATCHER, AND THAT IS THE POINT.
 *
 * Protecting /dashboard while leaving /api/analytics open would be theatre —
 * the data is the thing worth guarding, and it is one fetch away from anyone
 * who reads the page source. /api/clinician/queue is worse: it returns chief
 * complaints and the conversation behind them.
 *
 * NOT gated: /api/chat, /api/escalate and the patient-facing pages. Someone in
 * distress must never meet a login screen, which is the premise the whole
 * product rests on.
 */
export const config = {
  matcher: [
    "/dashboard/:path*",
    "/clinician/:path*",
    "/api/analytics/:path*",
    "/api/clinician/:path*",
  ],
};

export async function proxy(request: NextRequest) {
  const authorised = await verifyToken(request.cookies.get(ADMIN_COOKIE)?.value);
  if (authorised) return NextResponse.next();

  const { pathname, search } = request.nextUrl;

  // An API caller gets a status code it can act on, not an HTML redirect it
  // would try to parse as JSON.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        error: "unauthorised",
        detail: "Staff surface. Sign in at /admin/login.",
      },
      { status: 401 },
    );
  }

  const login = new URL("/admin/login", request.url);
  login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}
