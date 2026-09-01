import { NextResponse } from "next/server";
import { convertGuestToPatient, provenanceTrail, ConsentRequired } from "@/lib/conversion/convert";
import { loadCopyRules } from "@/lib/config";
import { getClinic } from "@/lib/grounding/corpus";
import type { MemoryItem } from "@/lib/history/profile";

/**
 * The trust transition: LeadSession -> PatientSession.
 *
 * GET returns the consent notice that must be shown BEFORE this is called, so
 * the text a person agreed to and the text stored against their consent record
 * come from the same place and cannot drift.
 *
 * POST performs the conversion. Email verification happens at the auth step
 * upstream; this endpoint is the migration, and it refuses without explicit
 * health-sharing consent.
 */

export async function GET() {
  const rules = loadCopyRules();
  const clinic = getClinic();

  const fill = (t: string) =>
    t.replace(/\{clinic_name\}/g, clinic.name).replace(/\{dpo_email\}/g, clinic.dpoEmail).trim();

  return NextResponse.json({
    // "Send this to a nurse - you won't have to explain it again." The generic
    // "continue securely to send this to the clinic" centres the clinic's
    // inbox; this names the thing the person actually dreads.
    trust_transition_copy: "Send this to a nurse — you won't have to explain it again.",
    health_sharing: {
      text: fill(rules.consent.health_data_sharing.text),
      required: true,
      version: rules.consent.health_data_sharing.version ?? "unversioned",
    },
    overseas_processing: {
      text:
        "Your message is processed by an AI service outside Malaysia. Personal " +
        "details are removed before it is sent. Required under PDPA s.129.",
      required: true,
    },
    // Unbundled and unticked. PDPA s.40 forbids folding this into the others.
    marketing: {
      text: fill(rules.consent.marketing.text),
      required: false,
      default: false,
    },
  });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.leadSessionId !== "string" || typeof body.email !== "string") {
    return NextResponse.json(
      { error: "Expected { leadSessionId: string, email: string }" },
      { status: 400 },
    );
  }

  const attribution = (body.attribution ?? {}) as Record<string, unknown>;
  const memoryItems = Array.isArray(body.memoryItems) ? (body.memoryItems as MemoryItem[]) : [];

  try {
    const result = await convertGuestToPatient({
      leadSessionId: body.leadSessionId,
      clinicId:
        typeof body.clinicId === "string"
          ? body.clinicId
          : "00000000-0000-0000-0000-000000000001",
      email: body.email,
      phone: typeof body.phone === "string" ? body.phone : undefined,
      socialHandle: typeof body.socialHandle === "string" ? body.socialHandle : undefined,
      consentHealthSharing: body.consentHealthSharing === true,
      consentMarketing: body.consentMarketing === true,
      consentOverseasProcessing: body.consentOverseasProcessing === true,
      memoryItems,
      historyFilled:
        body.historyFilled && typeof body.historyFilled === "object"
          ? (body.historyFilled as Record<string, string>)
          : {},
      complaintType: typeof body.complaintType === "string" ? body.complaintType : undefined,
      attribution,
    });

    return NextResponse.json({
      patient_id: result.patientId,
      patient_session_id: result.patientSessionId,
      origin_lead_session_id: result.originLeadSessionId,
      // Attribution survived the conversion, which is what the brief requires.
      attribution: result.attribution,
      consents: result.consents,
      // Ids unchanged, provenance still pointing at guest_messages.
      migrated_memory_items: result.migratedMemoryItems,
      provenance_trails: result.migratedMemoryItems.map((m) =>
        provenanceTrail(m, result.originLeadSessionId, result.attribution),
      ),
      // Everything already answered, so the patient is never asked twice.
      history_filled: result.historyFilled,
      never_reask: result.neverReask,
      persisted: result.persisted,
      persist_error: result.persistError ?? null,
    });
  } catch (err) {
    if (err instanceof ConsentRequired) {
      return NextResponse.json({ error: "consent_required", detail: err.message }, { status: 403 });
    }
    throw err;
  }
}
