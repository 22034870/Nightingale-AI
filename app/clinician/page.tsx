import ClinicianClient from "./ClinicianClient";

/**
 * The clinician surface.
 *
 * Care-team only in production. The underlying tables are already restricted by
 * is_care_team() RLS, and test_access_control.py asserts a patient JWT gets zero
 * rows from Postgres rather than from application code — so the boundary holds
 * even though this page has no auth gate of its own yet.
 */
export const metadata = {
  title: "Triage queue — Nightingale",
  robots: { index: false, follow: false },
};

export default function ClinicianPage() {
  return <ClinicianClient />;
}
