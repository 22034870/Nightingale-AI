-- =============================================================================
-- 002 — An escalation must outlive the conversation that produced it
-- =============================================================================
-- WHAT 001 GOT WRONG
--
-- 001 added:
--     check (patient_id is not null or lead_session_id is not null)
-- alongside:
--     lead_session_id ... on delete set null
--
-- Those two cannot coexist. lead_sessions expire on the 7-day PDPA retention
-- schedule. When the retention job deletes one, SET NULL fires, and for a guest
-- escalation (patient_id already null) the CHECK then fails — so the delete is
-- refused. The constraint would have quietly made expired guest sessions
-- undeletable, turning a data-minimisation guarantee into a permanent record.
--
-- Retention failing CLOSED like that is the wrong direction: it keeps personal
-- data longer than consented, which is the exact harm the schedule exists to
-- prevent.
--
-- WHY SET NULL IS NEVERTHELESS CORRECT
--
-- An escalation is a clinical record. A clinician acted on it. It must survive
-- the destruction of the chat transcript, carrying its triage_summary and
-- profile_snapshot_json — which are already redacted — while the raw
-- conversation is destroyed on schedule. An escalation whose lead_session_id
-- has become null is therefore a LEGITIMATE state meaning "the conversation
-- behind this has since been erased", not an orphan.
--
-- So the invariant is real but belongs at INSERT, not as a lifetime constraint.
-- app/api/escalate/route.ts rejects an escalation identifying nobody.
-- =============================================================================

alter table escalations
  drop constraint if exists escalations_identifies_someone;

comment on column escalations.lead_session_id is
  'Null once the lead session has been erased by the retention job. The
   escalation itself is a clinical record and outlives the conversation.
   Identity is enforced at insert time, not by a CHECK — see migration 002.';
