import "server-only";

import {
  PATTERNS,
  NAME_PATTERNS,
  QUASI_IDENTIFIER_PATTERNS,
  type PiiType,
} from "./patterns";

/**
 * THE REDACTION PIPELINE.
 *
 * This is the only path from a patient's words to a language model. Everything
 * about it is shaped by one asymmetry: over-redaction costs a clinician some
 * context, under-redaction is a reportable breach of health data. So the whole
 * design is biased toward recall at the expense of precision, and it fails
 * closed rather than open.
 *
 * Under PDPA s.129 this is not merely good engineering. Malaysia's cross-border
 * whitelist was abolished by the 2024 amendment, so sending patient text to a
 * foreign LLM endpoint needs a lawful basis; this pipeline is the "reasonable
 * precautions and due diligence" evidence for that basis. It is necessary but
 * NOT sufficient — the consent gate and the regional endpoint carry the rest.
 * See research/report-E-platform-gaps.md §6.
 *
 * Layer order follows the production pattern (Philter, Presidio):
 *   1. deterministic patterns with structural validation
 *   2. context-anchored name detection
 *   3. quasi-identifier counting (measured, not removed)
 *   4. span merge, then replacement with stable typed placeholders
 */

export interface RedactionSpan {
  start: number;
  end: number;
  type: PiiType;
  label: string;
  original: string;
  placeholder: string;
  /**
   * Whether the identifier passed its checksum or structural check.
   * `false` still means redacted — this is metadata for triage of the
   * redaction layer's own quality, not a decision input.
   */
  checksumValid?: boolean;
}

export interface RedactionResult {
  /** Safe to send to a model. */
  redacted: string;
  /** placeholder -> original. NEVER logged, never sent anywhere. */
  map: Record<string, string>;
  spans: RedactionSpan[];
  /** Count per type, safe to log — this is what audit_log records. */
  stats: Record<string, number>;
  /**
   * Sweeney-style re-identification pressure: age + postcode + locality
   * surviving in the clear. High counts mean the text is identifying even
   * though every explicit identifier was stripped.
   */
  quasiIdentifierCount: number;
  durationMs: number;
}

export class RedactionFailure extends Error {
  constructor(
    message: string,
    readonly reason: "timeout" | "error",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RedactionFailure";
  }
}

const DEFAULT_TIMEOUT_MS = Number(process.env.REDACTION_TIMEOUT_MS ?? 2000);

function collectSpans(
  text: string,
  rules: typeof PATTERNS,
): Omit<RedactionSpan, "placeholder">[] {
  const found: Omit<RedactionSpan, "placeholder">[] = [];

  for (const rule of rules) {
    // Fresh regex per call: shared /g regexes carry lastIndex between calls,
    // which silently skips matches. A stateful regex in a safety filter is a
    // bug that only shows up under load.
    const re = new RegExp(rule.regex.source, rule.regex.flags);
    let m: RegExpExecArray | null;

    while ((m = re.exec(text)) !== null) {
      // Capture group 1 when present (name rules capture the name, not the
      // trigger phrase — we redact "Ahmad", not "my name is Ahmad").
      const captured = m[1] ?? m[0];
      const offset = m[1] ? m[0].indexOf(m[1]) : 0;
      const start = m.index + offset;
      const end = start + captured.length;

      // Disambiguation may hand the match to a different rule — which will
      // still redact it. It never means "leave this in the clear".
      if (rule.disambiguate && !rule.disambiguate(captured)) continue;

      found.push({
        start,
        end,
        type: rule.type,
        label: rule.label,
        original: captured,
        // Soft signal only. A failing checksum is recorded and redacted anyway.
        checksumValid: rule.confidence ? rule.confidence(captured) : undefined,
      });

      if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width matches
    }
  }

  return found;
}

/**
 * Overlapping matches are resolved by preferring the LONGER span, then the
 * earlier one. A Singapore NRIC that also matches the looser passport pattern
 * should be recorded as an NRIC.
 */
function mergeSpans(
  spans: Omit<RedactionSpan, "placeholder">[],
): Omit<RedactionSpan, "placeholder">[] {
  const sorted = [...spans].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
  );

  const merged: Omit<RedactionSpan, "placeholder">[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      // Overlap: keep whichever covers more text.
      if (span.end - span.start > last.end - last.start) merged[merged.length - 1] = span;
      continue;
    }
    merged.push(span);
  }
  return merged;
}

function redactSync(text: string): RedactionResult {
  const startedAt = Date.now();

  const raw = [
    ...collectSpans(text, PATTERNS),
    ...collectSpans(text, NAME_PATTERNS),
  ];
  const spans = mergeSpans(raw);

  // Stable numbering per type, so the model can tell two different people
  // apart ([NAME_1] vs [NAME_2]) and reason about "the first number you gave
  // me" without ever seeing either value.
  const counters: Record<string, number> = {};
  const seen = new Map<string, string>();
  const map: Record<string, string> = {};
  const stats: Record<string, number> = {};

  const placed: RedactionSpan[] = spans.map((span) => {
    const key = `${span.type}:${span.original.toLowerCase()}`;
    let placeholder = seen.get(key);

    if (!placeholder) {
      counters[span.type] = (counters[span.type] ?? 0) + 1;
      placeholder = `[${span.type}_${counters[span.type]}]`;
      seen.set(key, placeholder);
      map[placeholder] = span.original;
    }

    stats[span.type] = (stats[span.type] ?? 0) + 1;
    return { ...span, placeholder };
  });

  // Replace right-to-left so earlier offsets stay valid.
  let redacted = text;
  for (const span of [...placed].sort((a, b) => b.start - a.start)) {
    redacted = redacted.slice(0, span.start) + span.placeholder + redacted.slice(span.end);
  }

  const quasi = collectSpans(redacted, QUASI_IDENTIFIER_PATTERNS);

  return {
    redacted,
    map,
    spans: placed,
    stats,
    quasiIdentifierCount: quasi.length,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Redact with a hard deadline.
 *
 * On timeout or error this THROWS. Callers must treat that as "this message
 * never reaches the model" and route the raw payload to redaction_quarantine.
 * There is deliberately no option to proceed with partially-redacted text:
 * the failure mode we are defending against is exactly the one where a busy
 * system decides the message is probably fine.
 */
export async function redact(
  text: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RedactionResult> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      Promise.resolve().then(() => redactSync(text)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RedactionFailure(
                `Redaction exceeded ${timeoutMs}ms; failing closed.`,
                "timeout",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    if (err instanceof RedactionFailure) throw err;
    throw new RedactionFailure("Redaction threw; failing closed.", "error", err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Restores original values for display to an authenticated, consented clinician.
 *
 * Note what this function proves: because the mapping exists, the redacted text
 * is still *personal data* in the controller's hands under PDPA s.4 ("identifiable
 * from that and other information in the possession of a data controller"). It is
 * pseudonymised, not anonymised. That distinction is why redaction alone does not
 * satisfy s.129 and why the consent gate exists.
 */
export function unredact(text: string, map: Record<string, string>): string {
  return Object.entries(map).reduce(
    (out, [placeholder, original]) => out.split(placeholder).join(original),
    text,
  );
}

/** PHI-free summary for audit_log. Types and counts only, never values. */
export function auditSummary(result: RedactionResult) {
  return {
    redaction_stats: result.stats,
    quasi_identifier_count: result.quasiIdentifierCount,
    duration_ms: result.durationMs,
    span_count: result.spans.length,
  };
}
