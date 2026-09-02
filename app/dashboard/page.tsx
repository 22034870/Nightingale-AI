import DashboardClient from "./DashboardClient";

/**
 * The clinic-side analytics surface.
 *
 * Staff-only in production, same as /clinician. It reads only aggregates over
 * funnel_events, which is PHI-free by construction — that is the property that
 * lets funnel data be kept 30 days while guest chat content is destroyed at 7.
 * No message text reaches this page.
 */
export const metadata = {
  title: "Clinic dashboard — Nightingale",
  robots: { index: false, follow: false },
};

export default function DashboardPage() {
  return <DashboardClient />;
}
