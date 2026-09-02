-- =============================================================================
-- 001 — Let a guest reach a nurse
-- =============================================================================
-- THE BUG THIS FIXES
--
-- escalations.patient_id was NOT NULL. Every escalation from someone who had
-- not yet created an account therefore failed its insert, silently, and
-- "Send to a nurse" persisted nothing at all.
--
-- That contradicts the core premise of the product: a person in distress must
-- be able to reach a human BEFORE being asked to sign up. Requiring a patient
-- row first rebuilt the exact signup wall the funnel work exists to remove.
--
-- Two changes, and both are needed — the first alone would leave guest
-- escalations invisible to the people meant to act on them.
-- =============================================================================

-- 1. A guest escalation is a real escalation.
alter table escalations alter column patient_id drop not null;

-- 2. The link to the person, as a real relation rather than a JSON key.
--    Previously carried only inside acquisition_context_json, which cannot be
--    indexed sensibly and cannot be enforced. The clinician view loads the
--    conversation through this.
alter table escalations
  add column if not exists lead_session_id uuid
  references lead_sessions(id) on delete set null;

create index if not exists escalations_lead_session_idx
  on escalations(lead_session_id);

-- Backfill anything already written under the old shape.
update escalations
   set lead_session_id = (acquisition_context_json->>'lead_session_id')::uuid
 where lead_session_id is null
   and acquisition_context_json->>'lead_session_id' is not null;

-- An escalation must identify SOMEONE. Nullable patient_id must not become a
-- way to file an anonymous, unactionable ticket.
alter table escalations
  drop constraint if exists escalations_identifies_someone;
alter table escalations
  add constraint escalations_identifies_someone
  check (patient_id is not null or lead_session_id is not null);

-- 3. RLS: the old read policy resolved through patients, so a guest escalation
--    (patient_id null) matched no row and was invisible to the care team —
--    a queue that silently drops emergencies is worse than no queue.
drop policy if exists patient_reads_own_escalations on escalations;

create policy patient_reads_own_escalations on escalations
  for select using (
    exists (select 1 from patients p
            where p.id = escalations.patient_id
              and p.auth_uid = auth.uid())
  );

-- Care team sees the whole queue, guests included. Separate policy so the
-- patient's own-record access and staff access can be reasoned about, and
-- revoked, independently.
create policy care_team_reads_escalations on escalations
  for select using (is_care_team());
