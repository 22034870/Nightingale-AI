import "server-only";

/**
 * Gemini client.
 *
 * Thin on purpose — a REST call with a deadline, not an SDK wrapper. Two
 * reasons: the failure semantics in PLANNING §11 have to be exact and visible,
 * and the whole point of the risk architecture is that this layer is
 * untrustworthy. Everything here is assumed to be slow, wrong, or absent, and
 * the callers are written accordingly.
 *
 * PDPA s.129 note: the AI Studio endpoint accepts no region parameter, so
 * LLM_REGION records intent rather than routing. Documented as a known
 * limitation rather than hidden. Redaction happens before anything reaches
 * here — see lib/redaction/pipeline.ts.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export class LlmUnavailable extends Error {
  constructor(
    message: string,
    readonly reason: "timeout" | "http" | "malformed" | "no_key",
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmUnavailable";
  }
}

interface GenerateOptions {
  model: string;
  prompt: string;
  system?: string;
  timeoutMs: number;
  maxOutputTokens?: number;
  temperature?: number;
  /** JSON Schema. When set, the model is constrained to emit matching JSON. */
  responseSchema?: Record<string, unknown>;
  /**
   * Thinking budget in tokens. Omit entirely for flash-lite.
   *
   * Two traps found by testing, both of which present as an outage rather than
   * an error: gemini-3.5-flash-lite REJECTS thinkingConfig with HTTP 400, and
   * gemini-3.5-flash with a small maxOutputTokens spends the entire budget on
   * reasoning and returns a candidate with NO parts at all — finishReason
   * MAX_TOKENS, zero visible text.
   */
  thinkingBudget?: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  latencyMs: number;
  promptTokens: number;
  totalTokens: number;
  thoughtsTokens: number;
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new LlmUnavailable("GEMINI_API_KEY is not set.", "no_key");
  }

  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0,
    maxOutputTokens: opts.maxOutputTokens ?? 1024,
  };

  if (opts.responseSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = opts.responseSchema;
  }
  // Only send thinkingConfig when explicitly asked; flash-lite 400s on it.
  if (opts.thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
  }

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    generationConfig,
  };
  if (opts.system) {
    body.systemInstruction = { parts: [{ text: opts.system }] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const startedAt = Date.now();

  try {
    const res = await fetch(`${ENDPOINT}/${opts.model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new LlmUnavailable(
        `Gemini returned ${res.status}: ${detail.slice(0, 200)}`,
        "http",
        res.status,
      );
    }

    const data = await res.json();
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts;
    const usage = data?.usageMetadata ?? {};

    // A candidate with no parts is the thinking-budget trap. Treat it as
    // unavailable rather than as an empty answer — an empty answer would be
    // rendered to a patient as silence.
    if (!parts?.length) {
      throw new LlmUnavailable(
        `Gemini returned no text (finishReason=${candidate?.finishReason}, ` +
          `thoughts=${usage.thoughtsTokenCount ?? 0}). Model likely spent the ` +
          `output budget on reasoning.`,
        "malformed",
      );
    }

    return {
      text: parts.map((p: { text?: string }) => p.text ?? "").join(""),
      model: opts.model,
      latencyMs: Date.now() - startedAt,
      promptTokens: usage.promptTokenCount ?? 0,
      totalTokens: usage.totalTokenCount ?? 0,
      thoughtsTokens: usage.thoughtsTokenCount ?? 0,
    };
  } catch (err) {
    if (err instanceof LlmUnavailable) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new LlmUnavailable(
        `Gemini exceeded ${opts.timeoutMs}ms.`,
        "timeout",
      );
    }
    throw new LlmUnavailable(
      `Gemini call failed: ${err instanceof Error ? err.message : String(err)}`,
      "http",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Parse JSON from a schema-constrained response, tolerating stray fencing. */
export function parseJsonResponse<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(trimmed) as T;
  } catch (cause) {
    throw new LlmUnavailable(
      `Model response was not valid JSON: ${trimmed.slice(0, 120)}`,
      "malformed",
    );
  }
}

/** PHI-free record for audit_log. Never includes prompt or completion text. */
export function auditLlm(result: GenerateResult) {
  return {
    model_id: result.model,
    latency_ms: result.latencyMs,
    prompt_tokens: result.promptTokens,
    total_tokens: result.totalTokens,
    thoughts_tokens: result.thoughtsTokens,
  };
}
