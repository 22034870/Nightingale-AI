import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";

/**
 * CHANNEL RULES RESOLVER.
 *
 * Reads config/channel_rules.yaml and nothing else. There are deliberately no
 * channel names in this file's logic — the brief asks for "one file or table,
 * not scattered if-statements", and the way to actually honour that is to make
 * the code incapable of knowing about a specific channel. Adding Instagram or
 * WhatsApp is a config edit.
 */

export type TimeOfDay = "business" | "evening" | "night";
export type IdentityLevel = "anonymous" | "handle_only" | "identified" | "verified";
export type EthicsScore = "green" | "yellow" | "red";

export interface ChannelEthics {
  technical: EthicsScore;
  legal: EthicsScore;
  platform: EthicsScore;
  trust: EthicsScore;
}

export interface ChannelRule {
  label: string;
  identity_level: IdentityLevel;
  implemented: boolean;
  simulated?: boolean;
  platforms?: string[];
  ethics: ChannelEthics;
  ethics_note: string;
  openings: Record<TimeOfDay, string>;
  prefill?: string[];
  never_ask?: string[];
  skip_questions?: string[];
  constraints?: {
    reply_window_days?: number;
    max_replies_per_comment?: number;
    requires_user_initiated?: boolean;
  };
}

interface ChannelRulesConfig {
  version: number;
  identity_levels: Record<IdentityLevel, { rank: number; has: string[] }>;
  never_reask: Record<string, string[]>;
  time_of_day: Record<TimeOfDay, { from: string; to: string }>;
  channels: Record<string, ChannelRule>;
  sensitive_topics: { topics: string[]; rule: string; opening: string };
  response_expectation: Record<TimeOfDay, { text: string; hours: number }> & {
    always_append: string;
  };
  refused: { id: string; ethics: ChannelEthics; why: string }[];
}

const SHOULD_CACHE = process.env.NODE_ENV === "production";
let cache: ChannelRulesConfig | undefined;

export function loadChannelRules(): ChannelRulesConfig {
  if (!SHOULD_CACHE || !cache) {
    const file = path.join(process.cwd(), "config", "channel_rules.yaml");
    cache = load(readFileSync(file, "utf8")) as ChannelRulesConfig;
  }
  return cache;
}

/** Clinic-local time bucket. Drives what we PROMISE, never what we ask. */
export function timeOfDay(at: Date = new Date(), timeZone = "Asia/Kuala_Lumpur"): TimeOfDay {
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);

  const cfg = loadChannelRules().time_of_day;
  const inRange = (from: string, to: string) =>
    from <= to ? hhmm >= from && hhmm < to : hhmm >= from || hhmm < to;

  if (inRange(cfg.business.from, cfg.business.to)) return "business";
  if (inRange(cfg.evening.from, cfg.evening.to)) return "evening";
  return "night";
}

export interface OpeningContext {
  clinic_name?: string;
  staff_name?: string;
  topic?: string;
  page_topic?: string;
  campaign?: string;
  /** Set when the arriving topic is stigmatised — suppresses clinical content. */
  sensitiveTopic?: boolean;
}

export interface ResolvedOpening {
  channel: string;
  channelLabel: string;
  identityLevel: IdentityLevel;
  timeOfDay: TimeOfDay;
  opening: string;
  responseExpectation: string;
  /** Fields we already hold and must never ask for again. */
  neverAsk: string[];
  /** Checklist fields already answered by the arrival context. */
  skipQuestions: string[];
  prefilled: Record<string, string>;
  sensitiveTopicRuleApplied: boolean;
  ethics: ChannelEthics;
}

function interpolate(template: string, ctx: Record<string, string | undefined>): string {
  return template
    .replace(/\{(\w+)\}/g, (_, key: string) => ctx[key] ?? `the clinic`)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve the opening for an arrival.
 *
 * The two observable behaviours the brief asks to see:
 *   1. the same message from two channels gets different openings
 *   2. an identified lead is never asked for what they already gave
 */
export function resolveOpening(
  channel: string,
  ctx: OpeningContext = {},
  at: Date = new Date(),
): ResolvedOpening {
  const cfg = loadChannelRules();
  const rule = cfg.channels[channel];
  if (!rule) throw new Error(`Unknown channel "${channel}". Add it to config/channel_rules.yaml.`);
  if (!rule.implemented) throw new Error(`Channel "${channel}" is configured but not implemented.`);

  const tod = timeOfDay(at);

  // The stigma rule outranks the channel's own opening. A DM naming a
  // stigmatised condition can out someone to whoever else sees their phone.
  const sensitive = Boolean(ctx.sensitiveTopic);
  const opening = sensitive
    ? interpolate(cfg.sensitive_topics.opening, ctx as Record<string, string | undefined>)
    : interpolate(rule.openings[tod], ctx as Record<string, string | undefined>);

  // Anything the identity level already implies, plus anything the channel
  // explicitly holds. Union, because both are reasons not to ask.
  const held = new Set<string>(rule.never_ask ?? []);
  for (const [field, levels] of Object.entries(cfg.never_reask)) {
    if (levels.includes(rule.identity_level) || levels.includes(channel)) held.add(field);
  }

  const prefilled: Record<string, string> = {};
  for (const key of rule.prefill ?? []) {
    const value = (ctx as Record<string, string | undefined>)[key];
    if (value) prefilled[key] = value;
  }

  const expectation = cfg.response_expectation[tod];

  return {
    channel,
    channelLabel: rule.label,
    identityLevel: rule.identity_level,
    timeOfDay: tod,
    opening,
    responseExpectation: `${expectation.text} ${cfg.response_expectation.always_append.trim()}`,
    neverAsk: [...held],
    skipQuestions: sensitive ? [] : (rule.skip_questions ?? []),
    prefilled,
    sensitiveTopicRuleApplied: sensitive,
    ethics: rule.ethics,
  };
}

export function isSensitiveTopic(topic?: string): boolean {
  if (!topic) return false;
  const cfg = loadChannelRules();
  const t = topic.toLowerCase().replace(/[^a-z]+/g, "_");
  return cfg.sensitive_topics.topics.some((s) => t.includes(s) || s.includes(t));
}

/** The green/yellow/red matrix, for the Technical Brief. Generated, not retyped. */
export function ethicsMatrix() {
  const cfg = loadChannelRules();
  return {
    implemented: Object.entries(cfg.channels).map(([id, r]) => ({
      id,
      label: r.label,
      implemented: r.implemented,
      simulated: r.simulated ?? false,
      ...r.ethics,
      note: r.ethics_note.trim(),
    })),
    refused: cfg.refused.map((r) => ({ ...r, ...r.ethics, why: r.why.trim() })),
  };
}
