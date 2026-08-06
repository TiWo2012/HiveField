/**
 * Fuzzy subsequence matching with fzf-like scoring.
 *
 * Used by the command palette to rank panes and commands as the user types.
 * Matching is case-insensitive; a higher `score` means a better match.
 * Bonuses reward:
 *   - matching the very start of the text
 *   - consecutive (adjacent) matched characters
 *   - matches right after a word boundary (`-`, `_`, `/`, `.`, space, …)
 *   - camelCase boundaries (`camel` + `Case`)
 * and a small penalty is applied for each gap skipped between matches.
 *
 * `null` means the query is not a subsequence of the text (no match).
 */

export interface FuzzyResult {
  /** Higher is better. */
  score: number;
  /** Indices in `text` (UTF-16 units) that matched the query — for highlighting. */
  indices: number[];
}

/** Characters that count as a word boundary for bonus scoring. */
const WORD_BOUNDARY_RE = /[\s\-_/.\\:([{'"`~!@#$%^&*+=,;?]/;

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase();
}

function isLower(ch: string): boolean {
  return ch !== ch.toUpperCase();
}

/**
 * Match `query` against `text` as a case-insensitive subsequence.
 * Returns the score plus the matched indices, or `null` when there is no match.
 * An empty query matches everything with a score of zero.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0, indices: [] };
  if (query.length > text.length) return null;

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let searchFrom = 0; // where to look for the next query char in `text`
  let prev = -2; // index of the previously matched char (-2: none yet)

  for (let i = 0; i < q.length; i++) {
    const idx = t.indexOf(q[i], searchFrom);
    if (idx === -1) return null; // not a subsequence
    indices.push(idx);
    score += 1;
    if (idx === 0) {
      score += 8; // starts with the query
    }
    if (idx === prev + 1) {
      score += 8; // consecutive run
    } else if (prev >= 0) {
      score -= 1; // gap penalty
    }
    if (idx > 0 && WORD_BOUNDARY_RE.test(text[idx - 1])) {
      score += 7; // after a word boundary
    }
    if (idx > 0 && isLower(text[idx - 1]) && isUpper(text[idx])) {
      score += 5; // camelCase boundary
    }
    searchFrom = idx + 1;
    prev = idx;
  }
  return { score, indices };
}
