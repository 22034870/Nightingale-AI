import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";

/**
 * Loads the safety configuration from `config/*.yaml`.
 *
 * These files are the source of truth for the risk gate and for everything the
 * assistant is permitted to say. They are deliberately data rather than prose
 * buried in a system prompt, for two reasons:
 *
 *   1. A prompt is a request; a post-generation check against this data is
 *      enforcement. The brief asks us to demonstrate the non-diagnostic
 *      constraint, not to assert it.
 *   2. The pytest suite reads the same YAML the app does, so a test cannot
 *      silently drift from the behaviour it claims to verify.
 *
 * Loaded once per process and cached. Config changes need a restart, which is
 * the correct trade for something that must not vary between two messages in
 * the same conversation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "IMMEDIATE" | "URGENT" | "AMBIGUOUS";
export type RiskLevel = "low" | "medium" | "high";

export interface RedFlag {
  id: string;
  system: string;
  canonical: string;
  severity: Severity;
  rationale: string;
  source: string;
  variants: string[];
  /** True for the four phrases the brief mandates must classify as High. */
  brief_mandated?: boolean;
  /** Routes to the crisis circuit-breaker, not the standard escalation copy. */
  crisis_pathway?: boolean;
  escalate_to_immediate_if?: string[];
}

export interface ContextGuard {
  patterns: string[];
  window_tokens?: number;
  effect: "downgrade_confidence" | "annotate_only";
  /** Hard floor. A guard lowers confidence; it can never suppress a match. */
  floor: RiskLevel;
  note?: string;
}

export interface SeverityLevel {
  risk_level: RiskLevel;
  action: string;
  show_emergency_banner: boolean;
  description: string;
}

export interface RedFlagsConfig {
  version: number;
  match_mode: string;
  severity_levels: Record<Severity, SeverityLevel>;
  context_guards: Record<string, ContextGuard>;
  red_flags: RedFlag[];
  ambiguous: { id: string; severity: Severity; rationale: string; variants: string[] }[];
  must_escalate_high: string[];
  must_not_be_low: string[];
  should_be_low: string[];
}

export interface BannedCategory {
  action: string;
  patterns: string[];
  reason: string;
  exemptions?: string[];
  enabled_when?: string;
  scope_note?: string;
}

export interface CrisisResource {
  name: string;
  contact: string;
  whatsapp?: string;
  hours: string;
  notes?: string;
}

export interface CopyRulesConfig {
  version: number;
  banned: Record<string, BannedCategory>;
  caution: { phrase: string; reason: string; allowed_when?: string; forbidden_when?: string }[];
  approved: Record<string, string[]>;
  normalisation: {
    mode: "live_stat" | "phrase";
    rationale: string;
    mechanisms: { id: string; what: string; why: string; floor?: number }[];
  };
  mechanics: Record<string, unknown>;
  crisis_protocol: {
    halt_intake: boolean;
    never_ask_about_method: boolean;
    message: string;
    resources: { MY: CrisisResource[]; SG: CrisisResource[] };
  };
  emergency_banner: { default: string; localised: Record<string, string> };
  identity_disclosure: { triggers: string[]; response: string };
  consent: Record<string, { text: string; version?: string; notice_version?: string }>;
  retention: Record<string, { days?: number; years?: number; justification: string }>;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(process.cwd(), "config");

function readYaml<T>(filename: string): T {
  const filePath = path.join(CONFIG_DIR, filename);
  let raw: string;

  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    // Fail loudly at boot. A missing red-flag lexicon must never degrade into
    // a system that quietly classifies chest pain as low risk.
    throw new Error(
      `Safety config missing: ${filePath}. The app must not start without it.`,
      { cause },
    );
  }

  const parsed = load(raw) as T;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Safety config ${filename} did not parse to an object.`);
  }
  return parsed;
}

let redFlagsCache: RedFlagsConfig | undefined;
let copyRulesCache: CopyRulesConfig | undefined;

export function loadRedFlags(): RedFlagsConfig {
  if (!redFlagsCache) {
    const cfg = readYaml<RedFlagsConfig>("red_flags.yaml");

    // Integrity check, not decoration. The brief names four phrases that must
    // classify as High. If an edit to the lexicon ever drops one, the build
    // should stop here rather than in front of a patient.
    const mandated = cfg.red_flags.filter((r) => r.brief_mandated);
    if (mandated.length < 4) {
      throw new Error(
        `red_flags.yaml has ${mandated.length} brief_mandated rules; the brief requires 4 ` +
          `(crushing chest pain, difficulty breathing, heavy bleeding, want to hurt myself).`,
      );
    }
    redFlagsCache = cfg;
  }
  return redFlagsCache;
}

export function loadCopyRules(): CopyRulesConfig {
  if (!copyRulesCache) {
    copyRulesCache = readYaml<CopyRulesConfig>("copy_rules.yaml");
  }
  return copyRulesCache;
}

/**
 * Every phrase that must trigger a deterministic HIGH, flattened and
 * normalised once at load. Matching is normalised substring: casefolded,
 * punctuation stripped, whitespace collapsed — so "Dada sakit!!" and
 * "dada  sakit" both hit.
 */
export function normalisePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface CompiledFlag {
  ruleId: string;
  phrase: string;
  severity: Severity;
  crisisPathway: boolean;
  system: string;
  rationale: string;
}

let compiledCache: CompiledFlag[] | undefined;

export function compileRedFlagIndex(): CompiledFlag[] {
  if (compiledCache) return compiledCache;

  const cfg = loadRedFlags();
  const out: CompiledFlag[] = [];

  for (const rule of cfg.red_flags) {
    for (const variant of rule.variants) {
      out.push({
        ruleId: rule.id,
        phrase: normalisePhrase(variant),
        severity: rule.severity,
        crisisPathway: rule.crisis_pathway ?? false,
        system: rule.system,
        rationale: rule.rationale,
      });
    }
  }

  for (const amb of cfg.ambiguous) {
    for (const variant of amb.variants) {
      out.push({
        ruleId: amb.id,
        phrase: normalisePhrase(variant),
        severity: amb.severity,
        crisisPathway: false,
        system: "ambiguous",
        rationale: amb.rationale,
      });
    }
  }

  // Longest phrase first, so "chest pain radiating to jaw" wins over "chest
  // pain" and the recorded matched_rule_id is the most specific one available.
  out.sort((a, b) => b.phrase.length - a.phrase.length);

  compiledCache = out;
  return out;
}
