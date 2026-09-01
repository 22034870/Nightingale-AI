import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";
import { normalisePhrase } from "@/lib/config";

/**
 * THE GROUNDING CORPUS.
 *
 * The clinic's published website, chunked so that every factual answer the
 * assistant gives can point at the exact span it came from. Citations resolve
 * to real character offsets in real source text — the bonus test passes by
 * construction rather than by the model being asked nicely to cite things.
 *
 * WHY LEXICAL RETRIEVAL AND NOT EMBEDDINGS:
 * the corpus is ~10k characters across five documents. A vector store here
 * would add a dependency, an index-build step, and a network call to answer
 * questions about opening hours. Scoring is BM25-ish term overlap, which for a
 * corpus this size is not a compromise — it is the correct tool. Swapping in
 * embeddings later is a change to one function.
 *
 * The honest limit, stated in the brief: this retrieves by word overlap, so a
 * question phrased entirely in Bahasa may miss English-only source text. The
 * answer path handles that correctly — no chunk means the assistant says it
 * does not know rather than inventing a fact.
 */

export interface Chunk {
  id: string;
  documentTitle: string;
  sourceUrl: string;
  /** Character offsets into the parent document's raw_text. */
  charStart: number;
  charEnd: number;
  text: string;
}

export interface ClinicProfile {
  name: string;
  country: string;
  emergencyNumber: string;
  dpoEmail: string;
  hours: Record<string, string[] | null>;
}

interface CorpusFile {
  clinic: {
    name: string;
    country: string;
    emergency_number: string;
    dpo_email: string;
    hours_json: Record<string, string[] | null>;
  };
  documents: { title: string; source_url: string; raw_text: string }[];
}

const SHOULD_CACHE = process.env.NODE_ENV === "production";
let cache: { clinic: ClinicProfile; chunks: Chunk[] } | undefined;

/**
 * Split on blank lines. Paragraph boundaries in the source are already the
 * natural answer units — "OPENING HOURS", "FASTING", "INSURANCE" — so chunking
 * on them keeps each citation readable when a human clicks through to check it.
 * Offsets are tracked against the ORIGINAL string, never a trimmed copy,
 * because a citation that points at the wrong span is worse than no citation.
 */
function chunkDocument(title: string, sourceUrl: string, raw: string): Chunk[] {
  const chunks: Chunk[] = [];
  let cursor = 0;
  let n = 0;

  for (const block of raw.split(/\n\s*\n/)) {
    const start = raw.indexOf(block, cursor);
    if (start === -1) continue;
    cursor = start + block.length;

    const text = block.trim();
    if (text.length < 20) continue; // headings alone cite nothing useful

    const offset = block.indexOf(text);
    chunks.push({
      id: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${n++}`,
      documentTitle: title,
      sourceUrl,
      charStart: start + offset,
      charEnd: start + offset + text.length,
      text,
    });
  }
  return chunks;
}

function load() {
  if (SHOULD_CACHE && cache) return cache;

  const file = path.join(process.cwd(), "db", "seed", "clinic-corpus.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as CorpusFile;

  const chunks = parsed.documents.flatMap((d) =>
    chunkDocument(d.title, d.source_url, d.raw_text),
  );

  cache = {
    clinic: {
      name: parsed.clinic.name,
      country: parsed.clinic.country,
      emergencyNumber: parsed.clinic.emergency_number,
      dpoEmail: parsed.clinic.dpo_email,
      hours: parsed.clinic.hours_json,
    },
    chunks,
  };
  return cache;
}

export function getClinic(): ClinicProfile {
  return load().clinic;
}

export function getChunks(): Chunk[] {
  return load().chunks;
}

/** Words too common in this corpus to discriminate between chunks. */
const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","is","are","was","were","be","been","to",
  "of","in","on","at","for","with","by","from","as","that","this","these","those",
  "it","its","you","your","we","our","us","i","my","me","do","does","did","can",
  "will","would","should","could","have","has","had","not","no","yes","what","how",
  "when","where","who","why","which","there","here","about","any","all","some",
]);

function terms(text: string): string[] {
  return normalisePhrase(text)
    .split(" ")
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export interface RetrievedChunk extends Chunk {
  score: number;
  matchedTerms: string[];
}

/**
 * Retrieve chunks relevant to a query.
 *
 * Scores by inverse-document-frequency-weighted term overlap: a chunk sharing
 * the rare word "fasting" outranks one sharing the common word "clinic".
 * Returns an empty array when nothing clears the floor — that emptiness is
 * load-bearing. It is what makes the assistant say "I don't have that" instead
 * of free-associating a clinic fact.
 *
 * The limit is 5 rather than 3 because IDF has a failure mode on a corpus this
 * small: "How much does a consultation cost?" ranked the "WHAT MIGHT COST MORE"
 * paragraph above the actual price list, because "consultation" appears in
 * almost every service chunk and so carries almost no weight, while "cost" is
 * rare. The assistant then said it had no prices for content sitting two ranks
 * below the cut. Widening the window is the cheap correct fix at 10k characters;
 * reranking would be the answer at 10x this size.
 */
export function retrieve(query: string, limit = 5, minScore = 1.2): RetrievedChunk[] {
  const chunks = getChunks();
  const queryTerms = terms(query);
  if (!queryTerms.length) return [];

  // Document frequency across the corpus, for IDF weighting.
  const df = new Map<string, number>();
  const chunkTerms = chunks.map((c) => {
    // Index the document title alongside the body. A chunk listing consultation
    // prices does not contain the word "fees", but it lives under "Fees and
    // Payment" and that title is real metadata about what the chunk is for.
    const set = new Set([...terms(c.text), ...terms(c.documentTitle)]);
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
    return set;
  });

  const scored = chunks.map((chunk, i) => {
    const present = chunkTerms[i];
    const matched: string[] = [];
    let score = 0;

    for (const term of queryTerms) {
      if (!present.has(term)) continue;
      matched.push(term);
      // Rare terms carry more signal than ubiquitous ones.
      score += Math.log(1 + chunks.length / (df.get(term) ?? 1));
    }
    return { ...chunk, score, matchedTerms: matched };
  });

  return scored
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Verify a citation actually resolves.
 *
 * The bonus test asks that citations resolve to real spans. This is the check
 * that makes that assertable: it re-reads the source document at the recorded
 * offsets and confirms the text still matches. A citation that cannot be
 * verified is treated as absent rather than displayed.
 */
export function resolveCitation(chunkId: string): { text: string; sourceUrl: string } | null {
  const chunk = getChunks().find((c) => c.id === chunkId);
  if (!chunk) return null;

  const file = path.join(process.cwd(), "db", "seed", "clinic-corpus.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as CorpusFile;
  const doc = parsed.documents.find((d) => d.title === chunk.documentTitle);
  if (!doc) return null;

  const span = doc.raw_text.slice(chunk.charStart, chunk.charEnd);
  return span === chunk.text ? { text: span, sourceUrl: chunk.sourceUrl } : null;
}
