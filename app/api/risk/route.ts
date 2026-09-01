import { NextResponse } from "next/server";
import { classifyDeterministic, mergeVerdicts, requiresEscalation, auditRisk } from "@/lib/risk/gate";

/**
 * Risk-gate inspection endpoint.
 *
 * Exposes the deterministic layer's verdict so `test_risk_escalation.py` can
 * assert on it over HTTP, and so the eval harness (PLANNING §16b) can score the
 * layer against a labelled dataset without booting the whole chat flow.
 *
 * `llm: null` here means the model was not consulted — which exercises the
 * fail-closed path deliberately. That is the behaviour under a classifier
 * outage, and it should be testable on demand rather than only during an
 * incident.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_RISK_ENDPOINT !== "true") {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  let body: { text?: unknown; include_llm?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.text !== "string") {
    return NextResponse.json({ error: "Expected { text: string }" }, { status: 400 });
  }

  const deterministic = classifyDeterministic(body.text);

  // The LLM layer lands in block D. Until then every call takes the
  // fail-closed path, which is the correct default for an absent classifier.
  const merged = mergeVerdicts(deterministic, null, body.text);

  return NextResponse.json({
    risk_level: merged.riskLevel,
    risk_reason: merged.riskReason,
    confidence: merged.confidence,
    risk_provenance: new Date().toISOString(),
    deciding_layer: merged.decidingLayer,
    matched_rule_id: merged.matchedRuleId,
    escalation_required: requiresEscalation(merged.riskLevel),
    crisis_pathway: merged.crisisPathway,
    show_emergency_banner: merged.showEmergencyBanner,
    third_party: merged.subjectIsThirdParty,
    guards_applied: merged.guardsApplied,
    // What would be written to audit_log — PHI-free by construction.
    audit: auditRisk(merged),
    deterministic_only: {
      risk_level: deterministic.riskLevel,
      matched_rule_id: deterministic.matchedRuleId,
      severity: deterministic.severity,
      duration_ms: deterministic.durationMs,
    },
  });
}
