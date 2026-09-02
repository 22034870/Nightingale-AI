-- =============================================================================
-- NIGHTINGALE — SCHEMA + ROW LEVEL SECURITY
-- =============================================================================
-- Postgres / Supabase. Run top to bottom in the SQL editor.
--
-- Two design rules run through the whole file:
--
--   1. PROVENANCE IS UNBREAKABLE. Every fact on a clinician's screen resolves
--      back through the message that produced it, to the session that message
--      belonged to, to the ad or referral that started it. Nothing is copied
--      without a pointer home.
--
--   2. ACCESS CONTROL LIVES IN THE DATABASE. Not in the application. A patient
--      hitting the clinician queue gets refused by a policy, not by an if-
--      statement someone could forget to write. That is what makes
--      test_access_control.py meaningful.
-- =============================================================================

create extension if not exists "pgcrypto";

-- =============================================================================
-- ENUMS
-- =============================================================================

create type identity_level  as enum ('anonymous','handle_only','identified','verified');
create type risk_level      as enum ('low','medium','high');
create type confidence      as enum ('low','med','high');
create type deciding_layer  as enum ('deterministic','llm','merged','fallback');
create type message_role    as enum ('user','assistant','system');
create type memory_kind     as enum ('chief_complaint','symptom','medication','allergy','history_field','context');
create type memory_status   as enum ('active','stopped','corrected','superseded');
create type escalation_status as enum ('sent','acknowledged','in_review','responded','closed');
create type consent_type    as enum ('health_sharing','marketing','overseas_processing');
create type contact_type    as enum ('email','phone','instagram','tiktok','telegram');
create type transcript_source as enum ('text','asr');
create type app_role        as enum ('guest','patient','staff','nurse','clinician','privacy_officer');

-- =============================================================================
-- IDENTITY HELPERS
-- =============================================================================
-- Roles live on the JWT so RLS can read them without a table join on every row.

create or replace function auth_role() returns app_role
  language sql stable as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role')::app_role,
    'guest'::app_role
  );
$$;

-- Staff-side roles that may see consented patient data.
create or replace function is_care_team() returns boolean
  language sql stable as $$
  select auth_role() in ('staff','nurse','clinician');
$$;

-- =============================================================================
-- TENANT
-- =============================================================================

create table clinics (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  country           char(2) not null default 'MY',
  emergency_number  text not null default '999',
  hours_json        jsonb not null default '{}'::jsonb,  -- drives the DYNAMIC SLA (§11)
  dpo_email         text not null,
  created_at        timestamptz not null default now()
);

-- =============================================================================
-- GROUNDING CORPUS — "websites read by agents"
-- =============================================================================
-- Chunks keep character offsets into the parent document so a citation resolves
-- to a REAL SPAN. The bonus test passes by construction, not by luck.

create table clinic_documents (
  id           uuid primary key default gen_random_uuid(),
  clinic_id    uuid not null references clinics(id) on delete cascade,
  title        text not null,
  source_url   text,
  raw_text     text not null,
  ingested_at  timestamptz not null default now()
);

create table document_chunks (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references clinic_documents(id) on delete cascade,
  char_start   int  not null,
  char_end     int  not null,
  text         text not null,
  constraint chunk_span_valid check (char_end > char_start)
);
create index on document_chunks(document_id);

-- =============================================================================
-- ACQUISITION — LeadSession
-- =============================================================================
-- Attribution captured here must survive all the way to the escalation payload.

create table lead_sessions (
  id                  uuid primary key default gen_random_uuid(),
  clinic_id           uuid not null references clinics(id) on delete cascade,
  source_channel      text not null,          -- staff_referral | social_comment | website_widget | ...
  campaign_id         text,
  creative            text,
  identity_level      identity_level not null default 'anonymous',
  landing_timestamp   timestamptz not null default now(),
  page_topic          text,                   -- website_widget
  staff_referral_note text,                   -- "asked about egg freezing at today's visit"
  social_handle       text,                   -- social_comment: handle, never email/phone
  volunteered_email   text,                   -- lead_form: never re-ask for this
  recovery_token      text unique,            -- session recovery within retention window
  expires_at          timestamptz not null default (now() + interval '7 days'),
  created_at          timestamptz not null default now()
);
create index on lead_sessions(clinic_id, source_channel);
create index on lead_sessions(recovery_token);

-- =============================================================================
-- PATIENTS — immutable id, changeable contact points
-- =============================================================================
-- The brief: "Primary key is an immutable internal ID — design the schema so
-- either contact point could change without breaking history." Contacts are
-- therefore ROWS, not columns, and superseding one preserves the old row.

create table patients (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references clinics(id) on delete cascade,
  auth_uid    uuid unique,                    -- Supabase auth.users.id
  created_at  timestamptz not null default now()
);

create table patient_contacts (
  id                  uuid primary key default gen_random_uuid(),
  patient_id          uuid not null references patients(id) on delete cascade,
  type                contact_type not null,
  value_encrypted     text not null,
  is_login_identifier boolean not null default false,
  verified_at         timestamptz,
  superseded_by       uuid references patient_contacts(id),
  created_at          timestamptz not null default now()
);
create index on patient_contacts(patient_id) where superseded_by is null;

-- Exactly one live login identifier per patient.
create unique index one_login_identifier_per_patient
  on patient_contacts(patient_id)
  where is_login_identifier and superseded_by is null;

create table patient_sessions (
  id                     uuid primary key default gen_random_uuid(),
  patient_id             uuid not null references patients(id) on delete cascade,
  origin_lead_session_id uuid references lead_sessions(id),   -- PROVENANCE HOME
  created_at             timestamptz not null default now()
);
create index on patient_sessions(patient_id);

-- =============================================================================
-- MESSAGES
-- =============================================================================
-- Guest and patient turns are separate tables because they have different
-- retention (7 days vs 7 years) and different visibility (staff cannot see
-- guest content until consent). Provenance pointers cross the boundary.

create table guest_messages (
  id               uuid primary key default gen_random_uuid(),
  lead_session_id  uuid not null references lead_sessions(id) on delete cascade,
  role             message_role not null,
  text_redacted    text not null,              -- REDACTED TEXT ONLY. Never raw.
  risk_level       risk_level,
  risk_reason      text,
  risk_confidence  confidence,
  risk_provenance  timestamptz,
  deciding_layer   deciding_layer,
  matched_rule_id  text,                       -- e.g. RF_CARD_01
  model_id         text,
  classifier_latency_ms int,
  guards_applied   text[] default '{}',
  created_at       timestamptz not null default now()
);
create index on guest_messages(lead_session_id, created_at);

create table messages (
  id                  uuid primary key default gen_random_uuid(),
  patient_session_id  uuid not null references patient_sessions(id) on delete cascade,
  role                message_role not null,
  text_redacted       text not null,
  risk_level          risk_level,
  risk_reason         text,
  risk_confidence     confidence,
  risk_provenance     timestamptz,
  deciding_layer      deciding_layer,
  matched_rule_id     text,
  model_id            text,
  classifier_latency_ms int,
  guards_applied      text[] default '{}',
  -- VOICE READINESS (brief requirement). Unused today; no migration needed later.
  audio_asset_id      text,
  transcript_source   transcript_source not null default 'text',
  asr_confidence      numeric(4,3),
  audio_duration_ms   int,
  language_detected   text,
  created_at          timestamptz not null default now()
);
create index on messages(patient_session_id, created_at);

-- =============================================================================
-- LIVING MEMORY
-- =============================================================================
-- provenance_pointer is a (table, id) pair because a fact learned before signup
-- points at a guest_message and must KEEP pointing there after conversion.
-- Mutation supersedes rather than overwrites: both states stay queryable, which
-- is what test_memory_mutation.py asserts.

create table memory_items (
  id                    uuid primary key default gen_random_uuid(),
  patient_id            uuid references patients(id) on delete cascade,
  lead_session_id       uuid references lead_sessions(id) on delete cascade,
  kind                  memory_kind not null,
  value                 text not null,
  status                memory_status not null default 'active',
  provenance_table      text not null check (provenance_table in ('guest_messages','messages')),
  provenance_message_id uuid not null,
  superseded_by         uuid references memory_items(id),
  status_changed_at     timestamptz,
  updated_at            timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  -- Belongs to a patient or a lead session, never both, never neither.
  constraint memory_owner check (
    (patient_id is not null and lead_session_id is null) or
    (patient_id is null and lead_session_id is not null)
  )
);
create index on memory_items(patient_id) where superseded_by is null;
create index on memory_items(lead_session_id) where superseded_by is null;

-- =============================================================================
-- THE HISTORY ENGINE (§6f) — Jason's §1(e), made structural
-- =============================================================================
-- Bounded checklist per presenting complaint. Asking is not diagnosing.
-- completeness_pct drives the visible meter AND the auth trigger in §4c.

create table history_checklists (
  id                  uuid primary key default gen_random_uuid(),
  patient_session_id  uuid references patient_sessions(id) on delete cascade,
  lead_session_id     uuid references lead_sessions(id) on delete cascade,
  complaint_type      text not null,             -- e.g. 'pain', 'bleeding', 'general'
  fields_json         jsonb not null default '{}'::jsonb,
  completeness_pct    int not null default 0 check (completeness_pct between 0 and 100),
  halted_reason       text,                      -- set to 'high_risk' when the gate stops it
  updated_at          timestamptz not null default now()
);

-- =============================================================================
-- CITATIONS — must resolve to real spans
-- =============================================================================

create table citations (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null,
  message_table text not null check (message_table in ('guest_messages','messages')),
  chunk_id    uuid not null references document_chunks(id),
  char_start  int not null,
  char_end    int not null,
  created_at  timestamptz not null default now()
);
create index on citations(message_id);

-- =============================================================================
-- ESCALATION — Send to Clinic
-- =============================================================================

create table escalations (
  id                       uuid primary key default gen_random_uuid(),
  -- NULLABLE on purpose. A guest must be able to reach a nurse before an
  -- account exists; requiring a patient row here rebuilt the signup wall.
  patient_id               uuid references patients(id) on delete cascade,
  lead_session_id          uuid references lead_sessions(id) on delete set null,
  trigger_message_id       uuid not null,
  triage_summary           text not null,            -- 1-5 bullets
  profile_snapshot_json    jsonb not null,           -- point-in-time copy
  acquisition_context_json jsonb not null,           -- attribution, survived from §1
  history_snapshot_json    jsonb,                    -- History Engine state at send
  status                   escalation_status not null default 'sent',
  sla_due_at               timestamptz not null,     -- COMPUTED from clinic hours, not promised
  created_at               timestamptz not null default now()
);
create index on escalations(patient_id, created_at desc);
create index on escalations(lead_session_id);
-- An escalation must identify someone; nullable patient_id must not become
-- a way to file an anonymous, unactionable ticket.
alter table escalations add constraint escalations_identifies_someone
  check (patient_id is not null or lead_session_id is not null);
create index on escalations(status) where status in ('sent','acknowledged');

-- Reserved for the clinician module that attaches later. No migration needed.
create table clinician_responses (
  id            uuid primary key default gen_random_uuid(),
  escalation_id uuid not null references escalations(id) on delete cascade,
  clinician_id  uuid not null,
  body          text not null,
  created_at    timestamptz not null default now()
);

-- =============================================================================
-- FUNNEL EVENTS — every displayed number resolves to a query over THIS table
-- =============================================================================

create table funnel_events (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references clinics(id) on delete cascade,
  lead_session_id  uuid references lead_sessions(id) on delete set null,
  patient_id       uuid references patients(id) on delete set null,
  event_type       text not null,   -- visitor|conversation_started|value_event|auth_started|
                                    -- consented|patient_created|escalation_sent|abandoned
  value_event_id   text,            -- VE_01..VE_05
  source_message_id uuid,           -- makes the count auditable
  metadata_json    jsonb not null default '{}'::jsonb,   -- PHI-FREE
  created_at       timestamptz not null default now()
);
create index on funnel_events(clinic_id, event_type, created_at desc);
create index on funnel_events(lead_session_id);

-- =============================================================================
-- CONSENT — unbundled and separately timestamped (PDPA s.40)
-- =============================================================================

create table consents (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid references patients(id) on delete cascade,
  lead_session_id uuid references lead_sessions(id) on delete cascade,
  type           consent_type not null,
  granted_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  notice_version text not null,
  scope_json     jsonb not null default '{}'::jsonb
);
create index on consents(patient_id, type) where revoked_at is null;

-- =============================================================================
-- FAIL-CLOSED DESTINATION (§11)
-- =============================================================================
-- When redaction throws or times out the message NEVER reaches the LLM. It
-- lands here, encrypted, reachable only by privacy_officer.

create table redaction_quarantine (
  id                  uuid primary key default gen_random_uuid(),
  clinic_id           uuid references clinics(id) on delete cascade,
  raw_payload_encrypted text not null,
  failure_reason      text not null,
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  created_at          timestamptz not null default now()
);

-- =============================================================================
-- OUTBOUND CHANNEL SENDS
-- =============================================================================
-- The unique constraint on external_comment_id is load-bearing: Meta allows
-- EXACTLY ONE private reply per comment, ever. A double-fire burns it
-- permanently. TTL is 7 days from COMMENT CREATION, not webhook receipt.

create table channel_outbound (
  id                  uuid primary key default gen_random_uuid(),
  clinic_id           uuid not null references clinics(id) on delete cascade,
  lead_session_id     uuid references lead_sessions(id) on delete set null,
  channel             text not null,          -- instagram | facebook | telegram
  external_comment_id text,
  comment_created_time timestamptz,
  ttl_expires_at      timestamptz,
  sent_at             timestamptz,
  failure_reason      text,
  created_at          timestamptz not null default now(),
  constraint one_private_reply_per_comment unique (channel, external_comment_id)
);

-- =============================================================================
-- AUDIT LOG — PHI-FREE BY CONSTRUCTION
-- =============================================================================
-- Ids, hashes and metadata only. There is deliberately no column that could
-- hold message text; test_redaction.py asserts raw values never appear here.

create table audit_log (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid,
  actor_role    app_role not null,
  action        text not null,
  resource_type text not null,
  resource_id   uuid,
  content_hash  text,                  -- sha256 of content, never content
  metadata_json jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index on audit_log(resource_type, resource_id, created_at desc);

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
-- Enabled on EVERY table. Default deny; policies grant narrowly.
-- This section is the answer to "demonstrate how access control is enforced".

alter table clinics              enable row level security;
alter table clinic_documents     enable row level security;
alter table document_chunks      enable row level security;
alter table lead_sessions        enable row level security;
alter table guest_messages       enable row level security;
alter table patients             enable row level security;
alter table patient_contacts     enable row level security;
alter table patient_sessions     enable row level security;
alter table messages             enable row level security;
alter table memory_items         enable row level security;
alter table history_checklists   enable row level security;
alter table citations            enable row level security;
alter table escalations          enable row level security;
alter table clinician_responses  enable row level security;
alter table funnel_events        enable row level security;
alter table consents             enable row level security;
alter table redaction_quarantine enable row level security;
alter table channel_outbound     enable row level security;
alter table audit_log            enable row level security;

-- --- Patient self-access -----------------------------------------------------
-- The core assertion of test_access_control.py: Patient A cannot reach Patient B.
-- Every policy below routes through patients.auth_uid = auth.uid().

create policy patient_reads_own_record on patients
  for select using (auth_uid = auth.uid() or is_care_team());

create policy patient_reads_own_sessions on patient_sessions
  for select using (
    exists (select 1 from patients p
            where p.id = patient_sessions.patient_id
              and (p.auth_uid = auth.uid() or is_care_team()))
  );

create policy patient_reads_own_messages on messages
  for select using (
    exists (select 1 from patient_sessions ps
            join patients p on p.id = ps.patient_id
            where ps.id = messages.patient_session_id
              and (p.auth_uid = auth.uid() or is_care_team()))
  );

create policy patient_writes_own_messages on messages
  for insert with check (
    exists (select 1 from patient_sessions ps
            join patients p on p.id = ps.patient_id
            where ps.id = messages.patient_session_id
              and p.auth_uid = auth.uid())
  );

create policy patient_reads_own_memory on memory_items
  for select using (
    patient_id is not null and exists (
      select 1 from patients p
      where p.id = memory_items.patient_id
        and (p.auth_uid = auth.uid() or is_care_team()))
  );

create policy patient_reads_own_contacts on patient_contacts
  for select using (
    exists (select 1 from patients p
            where p.id = patient_contacts.patient_id
              and (p.auth_uid = auth.uid() or is_care_team()))
  );

create policy patient_reads_own_consents on consents
  for select using (
    patient_id is not null and exists (
      select 1 from patients p
      where p.id = consents.patient_id
        and (p.auth_uid = auth.uid() or is_care_team()))
  );

create policy patient_reads_own_history on history_checklists
  for select using (
    exists (select 1 from patient_sessions ps
            join patients p on p.id = ps.patient_id
            where ps.id = history_checklists.patient_session_id
              and (p.auth_uid = auth.uid() or is_care_team()))
  );

-- --- Escalations -------------------------------------------------------------
-- A patient may see THAT they escalated and its status. The triage queue as a
-- whole is care-team only: the second assertion of test_access_control.py.

create policy patient_reads_own_escalations on escalations
  for select using (
    exists (select 1 from patients p
            where p.id = escalations.patient_id
              and p.auth_uid = auth.uid())
  );

-- Separate from the patient's own-record access so staff access can be
-- reasoned about, and revoked, on its own. This is also what makes a GUEST
-- escalation (patient_id null) visible to the care team at all.
create policy care_team_reads_escalations on escalations
  for select using (is_care_team());

create policy care_team_updates_escalations on escalations
  for update using (is_care_team()) with check (is_care_team());

create policy care_team_reads_clinician_responses on clinician_responses
  for select using (is_care_team());

-- --- Care-team-only surfaces -------------------------------------------------
-- Warm-lead view, funnel metrics, outbound queue. A patient JWT gets zero rows
-- from the DATABASE, not from application code.

create policy care_team_reads_leads on lead_sessions
  for select using (is_care_team());

create policy care_team_reads_funnel on funnel_events
  for select using (is_care_team());

create policy care_team_reads_outbound on channel_outbound
  for select using (is_care_team());

-- Guest chat content stays hidden from staff until consent exists. This is the
-- brief's "if a guest volunteers sensitive information: hide it from staff
-- until consent", enforced in the database rather than remembered in the UI.
create policy care_team_reads_guest_messages_after_consent on guest_messages
  for select using (
    is_care_team() and exists (
      select 1 from consents c
      where c.lead_session_id = guest_messages.lead_session_id
        and c.type = 'health_sharing'
        and c.revoked_at is null)
  );

-- --- Privacy officer ---------------------------------------------------------
-- Quarantined raw payloads are reachable by exactly one role.

create policy privacy_officer_reads_quarantine on redaction_quarantine
  for select using (auth_role() = 'privacy_officer');

create policy privacy_officer_updates_quarantine on redaction_quarantine
  for update using (auth_role() = 'privacy_officer') with check (auth_role() = 'privacy_officer');

-- --- Public-ish reference data ----------------------------------------------
-- Clinic facts and the grounding corpus are readable by anyone: they are the
-- published website. Nothing here is patient data.

create policy anyone_reads_clinics on clinics for select using (true);
create policy anyone_reads_documents on clinic_documents for select using (true);
create policy anyone_reads_chunks on document_chunks for select using (true);
create policy anyone_reads_citations on citations for select using (true);

-- --- Audit log ---------------------------------------------------------------
-- Append-only from the application's perspective. No update or delete policy
-- exists, so neither is permitted for any role.

create policy privacy_officer_reads_audit on audit_log
  for select using (auth_role() in ('privacy_officer','clinician'));

-- =============================================================================
-- RETENTION (§12) — run on a schedule
-- =============================================================================
-- Guest data is destroyed at 7 days. Anonymous, PHI-free funnel metadata is
-- kept 30 days for abandonment analytics, which is exactly the trade the brief
-- asks us to justify: we keep what cannot identify anyone, and destroy what can.

create or replace function purge_expired_guest_data() returns void
  language plpgsql security definer as $$
begin
  delete from lead_sessions
   where expires_at < now()
     and not exists (
       select 1 from patient_sessions ps
       where ps.origin_lead_session_id = lead_sessions.id);

  delete from funnel_events
   where created_at < now() - interval '30 days'
     and patient_id is null;

  delete from redaction_quarantine
   where created_at < now() - interval '7 days'
     and reviewed_at is not null;
end;
$$;
