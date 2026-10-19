// Measures how much of a draft is lifted from a source post, so "remixes" stay original.

const N = 5;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function shingles(text: string, n = N): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

/** Share (0-1) of the draft's word 5-grams that also appear in the source. */
export function overlapScore(draft: string, source: string): number {
  const d = shingles(draft);
  if (d.size === 0) return 0;
  const s = shingles(source);
  let shared = 0;
  for (const g of d) if (s.has(g)) shared++;
  return shared / d.size;
}

/** Above this, a remix is treated as too close to the original and regenerated or flagged. */
export const OVERLAP_LIMIT = 0.12;
