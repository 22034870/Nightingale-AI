import LoginClient from "./LoginClient";

export const metadata = {
  title: "Staff sign-in — Nightingale",
  robots: { index: false, follow: false },
};

/**
 * `next` comes from the URL, so it is attacker-controllable and must be
 * treated as such: a value like `https://evil.example` or `//evil.example`
 * would turn this login into an open redirect, sending someone who just
 * authenticated straight to a page of someone else's choosing.
 *
 * Only a single-slash, same-origin path is allowed through.
 */
function safeNext(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return "/dashboard";
  if (!value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  return value;
}

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <LoginClient next={safeNext(params.next)} />;
}
