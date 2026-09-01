import { NextResponse } from "next/server";
import { redact, auditSummary, RedactionFailure } from "@/lib/redaction/pipeline";

/**
 * Redaction inspection endpoint.
 *
 * Returns exactly what would be handed to the language model for a given input,
 * which is what `test_redaction.py` needs to assert on: the brief requires
 * proving that the LLM input contains placeholders and that logs never contain
 * the raw values.
 *
 * The response deliberately does NOT include the placeholder->original map.
 * The map is the thing that keeps redacted text legally "personal data", so it
 * stays server-side and reaches only an authenticated, consented clinician.
 * An endpoint that handed it back would defeat the entire pipeline.
 *
 * Disabled in production: this is a test surface, not a product surface.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_REDACT_ENDPOINT !== "true") {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  let body: { text?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.text !== "string") {
    return NextResponse.json({ error: "Expected { text: string }" }, { status: 400 });
  }

  try {
    const result = await redact(body.text);
    return NextResponse.json({
      llm_input: result.redacted,
      audit: auditSummary(result),
      spans: result.spans.map((s) => ({
        type: s.type,
        label: s.label,
        placeholder: s.placeholder,
        start: s.start,
        end: s.end,
        // `original` is deliberately omitted.
      })),
    });
  } catch (err) {
    // Fail closed. The caller must treat this as "the message never reaches
    // the model" and quarantine the raw payload.
    if (err instanceof RedactionFailure) {
      return NextResponse.json(
        { error: "redaction_failed", reason: err.reason, action: "quarantine" },
        { status: 503 },
      );
    }
    throw err;
  }
}
