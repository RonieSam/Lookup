/**
 * Free-text search, shared by the results table (in the browser) and the
 * admin search (in the database, which follows the same rules).
 *
 * - The text is split into words. A row matches when EVERY word is found in
 *   at least one of its columns, so "mehak vellore" narrows down, and each
 *   word may match a different column.
 * - Matching ignores capital letters and finds a word anywhere inside a cell
 *   ("8.6" finds "8.64").
 */

export const MAX_SEARCH_TERMS = 8;
export const MAX_SEARCH_LENGTH = 100;

const fold = (s: string) => s.normalize("NFKC").toLowerCase();

/** The distinct, folded words of a search, or [] when there's nothing to search for. */
export function searchTerms(query: string): string[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return [...new Set(words)].slice(0, MAX_SEARCH_TERMS);
}

/** True when `text` contains the folded `term`. */
export function cellHas(text: string, term: string): boolean {
  return fold(text).includes(term);
}

/** True when every term is found in at least one of the cells. No terms matches everything. */
export function rowMatches(cells: readonly string[], terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const folded = cells.map(fold);
  return terms.every((t) => folded.some((c) => c.includes(t)));
}
