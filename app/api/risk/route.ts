import { NextResponse } from "next/server";
import { classifyDeterministic, mergeVerdicts, requiresEscalation, auditRisk } from "@/lib/risk/gate";
import { tryClassify } from "@/lib/risk/classifier";

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

  // Pass include_llm:false to exercise the fail-closed path on demand — the
  // behaviour under a classifier outage should be testable without waiting for
  // one. Default is to consult the model.
  const useLlm = body.include_llm !== false;
  const { verdict: llm, failure } = useLlm
    ? await tryClassify(body.text)
    : { verdict: null, failure: "skipped by request" };

  const merged = mergeVerdicts(deterministic, llm, body.text);

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
    llm_layer: llm
      ? { risk_level: llm.riskLevel, risk_reason: llm.riskReason, confidence: llm.confidence, audit: llm.audit }
      : { unavailable: failure },
    layers_disagreed: merged.layersDisagreed,
    deterministic_only: {
      risk_level: deterministic.riskLevel,
      matched_rule_id: deterministic.matchedRuleId,
      severity: deterministic.severity,
      duration_ms: deterministic.durationMs,
    },
  });
}
