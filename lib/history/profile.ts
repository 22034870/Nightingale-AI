import "server-only";

import { randomUUID } from "node:crypto";
import { normalisePhrase } from "@/lib/config";
import type { ExtractedFact, FactKind, FactStatus } from "./engine";

/**
 * THE LIVING PROFILE.
 *
 * Structured facts extracted from the conversation, each pointing back at the
 * message that produced it, mutating without ever losing what came before.
 *
 * THE RULE THAT SHAPES EVERYTHING: nothing is overwritten and nothing is
 * deleted. When someone corrects themselves, we write a NEW item and link the
 * old one to it. Both rows survive, each with its own provenance pointer, so
 * the record shows what was believed, what it changed to, and exactly which
 * message changed it.
 *
 * That is the difference between a dynamic medical history and a chat log with
 * a summary stapled on. A clinician reading "Advil (stopped last week)" can
 * click through to the sentence where the patient said it, and also to the
 * earlier sentence where they said they were taking it.
 *
 * Provenance is a (table, id) pair rather than a single foreign key, because a
 * fact learned before signup points at a guest_message and must KEEP pointing
 * there after the guest becomes a patient. Migration moves the session, never
 * the pointer.
 */

export type MemoryStatus = "active" | "stopped" | "superseded";

export interface Provenance {
  table: "guest_messages" | "messages";
  messageId: string;
}

export interface MemoryItem {
  id: string;
  kind: FactKind;
  value: string;
  status: MemoryStatus;
  timeline?: string;
  provenance: Provenance;
  /** Set on the OLD item when a correction replaces it. */
  supersededBy?: string;
  /** Set on the NEW item, pointing back at what it corrected. */
  supersedes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplyResult {
  items: MemoryItem[];
  added: MemoryItem[];
  mutated: { previous: MemoryItem; replacement: MemoryItem }[];
}

/**
 * Same underlying fact?
 *
 * Exact matching is not enough. Extractors happily emit "headache", "really bad
 * headache", and "really bad headache for the last three days" from one
 * sentence, which fills a clinician's screen with three rows describing one
 * symptom. Containment either way counts as the same fact.
 */
function isSameFact(item: MemoryItem, kind: FactKind, value: string): boolean {
  if (item.kind !== kind) return false;
  const a = normalisePhrase(item.value);
  const b = normalisePhrase(value);
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Apply newly extracted facts to the profile.
 *
 * Three cases:
 *   1. New fact          -> append
 *   2. Repeat of a fact  -> ignore (saying "still on Advil" is not a change)
 *   3. Correction        -> append the new state, mark the old superseded,
 *                           link both ways
 */
export function applyFacts(
  existing: MemoryItem[],
  facts: ExtractedFact[],
  provenance: Provenance,
  now: () => string = () => new Date().toISOString(),
): ApplyResult {
  const items = existing.map((i) => ({ ...i }));
  const added: MemoryItem[] = [];
  const mutated: { previous: MemoryItem; replacement: MemoryItem }[] = [];

  for (const fact of facts) {
    if (!fact.value?.trim()) continue;

    // A correction names the earlier value it replaces. Fall back to matching
    // on the value itself, since a model will not always populate `supersedes`
    // when the patient says "actually, I stopped that".
    const targetValue = fact.supersedes?.trim() || fact.value;
    const prior = items.find(
      (i) => i.status !== "superseded" && isSameFact(i, fact.kind, targetValue),
    );

    // Case 2: same fact, same status, nothing to record.
    if (prior && (prior.status as string) === (fact.status as string) && !fact.supersedes) {
      continue;
    }

    const item: MemoryItem = {
      id: randomUUID(),
      kind: fact.kind,
      value: fact.value.trim(),
      status: fact.status as FactStatus as MemoryStatus,
      timeline: fact.timeline,
      provenance,
      createdAt: now(),
      updatedAt: now(),
    };

    if (prior) {
      // Case 3: correction. Both rows survive; each keeps its own provenance.
      item.supersedes = prior.id;
      prior.supersededBy = item.id;
      prior.status = "superseded";
      prior.updatedAt = now();
      mutated.push({ previous: prior, replacement: item });
    } else {
      added.push(item);
    }

    items.push(item);
  }

  return { items, added, mutated };
}

/** Current state only — what the sidebar shows. */
export function currentProfile(items: MemoryItem[]) {
  const live = items.filter((i) => i.status !== "superseded");
  const byKind = (kind: FactKind) => live.filter((i) => i.kind === kind);

  return {
    chief_complaint: byKind("chief_complaint").at(-1)?.value ?? null,
    symptoms: byKind("symptom").map((i) => ({
      value: i.value,
      timeline: i.timeline ?? null,
      status: i.status,
      provenance_id: i.provenance.messageId,
      memory_id: i.id,
    })),
    medications: byKind("medication").map((i) => ({
      value: i.value,
      status: i.status,
      timeline: i.timeline ?? null,
      provenance_id: i.provenance.messageId,
      memory_id: i.id,
    })),
    allergies: byKind("allergy").map((i) => ({
      value: i.value,
      provenance_id: i.provenance.messageId,
      memory_id: i.id,
    })),
    context: byKind("context").map((i) => ({
      value: i.value,
      provenance_id: i.provenance.messageId,
      memory_id: i.id,
    })),
  };
}

/**
 * Walk a fact back through every correction to its origin.
 *
 * This is what makes provenance assertable rather than decorative:
 * test_memory_mutation.py takes the current "Advil (stopped)" item and walks it
 * back to the message where the patient first said they were taking it, and
 * both links must exist.
 */
export function provenanceChain(items: MemoryItem[], memoryId: string): MemoryItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const chain: MemoryItem[] = [];
  let current = byId.get(memoryId);

  while (current) {
    chain.unshift(current);
    current = current.supersedes ? byId.get(current.supersedes) : undefined;
    if (chain.length > 50) break; // cycle guard
  }
  return chain;
}

/** Full snapshot for the escalation payload, including superseded history. */
export function profileSnapshot(items: MemoryItem[]) {
  return {
    current: currentProfile(items),
    history: items.map((i) => ({
      memory_id: i.id,
      kind: i.kind,
      value: i.value,
      status: i.status,
      timeline: i.timeline ?? null,
      provenance_table: i.provenance.table,
      provenance_message_id: i.provenance.messageId,
      supersedes: i.supersedes ?? null,
      superseded_by: i.supersededBy ?? null,
      updated_at: i.updatedAt,
    })),
  };
}
