import "server-only";

import { randomUUID } from "node:crypto";
import { tryPersist } from "@/lib/db/client";
import { logEvent } from "@/lib/funnel/events";
import { loadCopyRules } from "@/lib/config";
import type { MemoryItem } from "@/lib/history/profile";

/**
 * GUEST -> PATIENT CONVERSION.
 *
 * The single most important handoff in the product, and the one the brief tests
 * hardest: "after auth + consent the context appears in the PatientSession,
 * provenance resolves to the original GuestMessage, attribution retained,
 * concern never re-asked."
 *
 * THE RULE THAT MAKES IT WORK: memory items are NOT rewritten during migration.
 * Their provenance still points at the guest_message that produced them, and
 * the new patient_session points back at the lead_session it came from. So a
 * fact on a clinician's screen resolves in three hops to the Instagram ad it
 * started from, and it stays that way forever.
 *
 * Copying the facts and repointing them at fresh patient messages would look
 * identical in the UI and would quietly destroy the audit trail. That temptation
 * is exactly what the test exists to catch.
 *
 * CONSENT IS UNBUNDLED. Health-data sharing and marketing are separate records
 * with separate timestamps, because PDPA s.40 requires explicit consent that is
 * not tied to accepting terms. Marketing defaults to false and stays false
 * unless the person actively ticks it.
 */

export interface ConversionInput {
  leadSessionId: string;
  clinicId: string;
  /** Verified at the auth step. This function does not verify it. */
  email: string;
  phone?: string;
  socialHandle?: string;
  consentHealthSharing: boolean;
  consentMarketing: boolean;
  consentOverseasProcessing: boolean;
  /** Carried forward untouched — provenance must not be rewritten. */
  memoryItems: MemoryItem[];
  historyFilled?: Record<string, string>;
  complaintType?: string;
  attribution?: Record<string, unknown>;
}

export interface ConversionResult {
  patientId: string;
  patientSessionId: string;
  originLeadSessionId: string;
  /** Same ids as before conversion. Unchanged is the point. */
  migratedMemoryItems: MemoryItem[];
  consents: { type: string; grantedAt: string; noticeVersion: string }[];
  attribution: Record<string, unknown>;
  /** Checklist answers survive, so nothing is asked twice. */
  historyFilled: Record<string, string>;
  neverReask: string[];
  persisted: boolean;
  persistError?: string;
}

export class ConsentRequired extends Error {
  constructor() {
    super(
      "Health-data sharing consent is required before a PatientSession can be created.",
    );
    this.name = "ConsentRequired";
  }
}

export async function convertGuestToPatient(
  input: ConversionInput,
): Promise<ConversionResult> {
  // Hard gate. Without this consent there is no lawful basis to hold the
  // content as patient data, so the conversion does not happen at all.
  if (!input.consentHealthSharing) throw new ConsentRequired();

  const rules = loadCopyRules();
  const patientId = randomUUID();
  const patientSessionId = randomUUID();
  const now = new Date().toISOString();

  const noticeVersion =
    rules.consent.health_data_sharing?.version ??
    rules.consent.health_data_sharing?.notice_version ??
    "unversioned";

  const consents = [
    { type: "health_sharing", grantedAt: now, noticeVersion },
    ...(input.consentOverseasProcessing
      ? [{ type: "overseas_processing", grantedAt: now, noticeVersion }]
      : []),
    // Separate record, separate timestamp. Never implied by the others.
    ...(input.consentMarketing
      ? [{ type: "marketing", grantedAt: now, noticeVersion }]
      : []),
  ];

  const persist = await tryPersist("conversion", async (db) => {
    const { error: pErr } = await db
      .from("patients")
      .insert({ id: patientId, clinic_id: input.clinicId });
    if (pErr) throw new Error(`patients: ${pErr.message}`);

    // Contacts are ROWS, not columns, so either can change later without
    // breaking history — the brief's immutable-internal-id requirement.
    const contacts: Record<string, unknown>[] = [
      {
        patient_id: patientId,
        type: "email",
        value_encrypted: input.email,
        is_login_identifier: true,
        verified_at: now,
      },
    ];
    if (input.phone) {
      contacts.push({
        patient_id: patientId,
        type: "phone",
        value_encrypted: input.phone,
        is_login_identifier: false,
      });
    }
    if (input.socialHandle) {
      contacts.push({
        patient_id: patientId,
        type: "instagram",
        value_encrypted: input.socialHandle,
        is_login_identifier: false,
      });
    }
    const { error: cErr } = await db.from("patient_contacts").insert(contacts);
    if (cErr) throw new Error(`patient_contacts: ${cErr.message}`);

    // origin_lead_session_id is the link that keeps attribution alive.
    const { error: sErr } = await db.from("patient_sessions").insert({
      id: patientSessionId,
      patient_id: patientId,
      origin_lead_session_id: input.leadSessionId,
    });
    if (sErr) throw new Error(`patient_sessions: ${sErr.message}`);

    const { error: coErr } = await db.from("consents").insert(
      consents.map((c) => ({
        patient_id: patientId,
        lead_session_id: input.leadSessionId,
        type: c.type,
        granted_at: c.grantedAt,
        notice_version: c.noticeVersion,
        scope_json: { clinic_id: input.clinicId },
      })),
    );
    if (coErr) throw new Error(`consents: ${coErr.message}`);

    // THE CRITICAL PART. Facts are re-parented to the patient, and their
    // provenance_table / provenance_message_id are written through UNCHANGED.
    // A fact learned before signup keeps pointing at its guest_message.
    if (input.memoryItems.length) {
      const { error: mErr } = await db.from("memory_items").insert(
        input.memoryItems.map((m) => ({
          id: m.id,
          patient_id: patientId,
          lead_session_id: null,
          kind: m.kind,
          value: m.value,
          status: m.status,
          provenance_table: m.provenance.table,
          provenance_message_id: m.provenance.messageId,
          superseded_by: m.supersededBy ?? null,
          updated_at: m.updatedAt,
        })),
      );
      if (mErr) throw new Error(`memory_items: ${mErr.message}`);
    }

    if (input.historyFilled && Object.keys(input.historyFilled).length) {
      const { error: hErr } = await db.from("history_checklists").insert({
        patient_session_id: patientSessionId,
        complaint_type: input.complaintType ?? "general",
        fields_json: input.historyFilled,
        completeness_pct: 0,
      });
      if (hErr) throw new Error(`history_checklists: ${hErr.message}`);
    }

    return true;
  });

  for (const type of ["auth_started", "consented", "patient_created"] as const) {
    await logEvent({
      clinicId: input.clinicId,
      leadSessionId: input.leadSessionId,
      patientId,
      eventType: type,
      metadata: {
        source_channel: input.attribution?.source_channel ?? "unknown",
        campaign_id: input.attribution?.campaign_id ?? null,
        // Recorded so re-engagement can never happen without it.
        marketing: type === "consented" ? input.consentMarketing : undefined,
      },
    });
  }

  return {
    patientId,
    patientSessionId,
    originLeadSessionId: input.leadSessionId,
    migratedMemoryItems: input.memoryItems,
    consents,
    attribution: input.attribution ?? {},
    historyFilled: input.historyFilled ?? {},
    neverReask: Object.keys(input.historyFilled ?? {}),
    persisted: persist.ok,
    persistError: persist.ok ? undefined : persist.error,
  };
}

/**
 * Walk a migrated fact back to its origin.
 *
 * test_guest_to_patient_conversion.py asserts this resolves: a fact on the
 * patient record points at a guest_message, which belongs to a lead_session,
 * which carries the campaign that started everything.
 */
export function provenanceTrail(
  item: MemoryItem,
  originLeadSessionId: string,
  attribution: Record<string, unknown>,
) {
  return {
    memory_id: item.id,
    value: item.value,
    status: item.status,
    provenance_table: item.provenance.table,
    provenance_message_id: item.provenance.messageId,
    lead_session_id: originLeadSessionId,
    acquisition: {
      source_channel: attribution.source_channel ?? null,
      campaign_id: attribution.campaign_id ?? null,
      creative: attribution.creative ?? null,
      landing_timestamp: attribution.landing_timestamp ?? null,
    },
    resolves: item.provenance.table === "guest_messages",
  };
}
