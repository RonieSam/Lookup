/**
 * Neo ID rules.
 *
 * A Neo ID is exactly 8 ASCII characters in the pattern L-D-L-D-L-D-L-D,
 * where L is a letter and D is a digit (for example "A1B2C3D4").
 *
 * Letters are accepted in either case on input and stored upper-case, so
 * "a1b2c3d4" and "A1B2C3D4" are the same student.
 */

export const NEO_ID_LENGTH = 8;

/** Matches an already-trimmed Neo ID in either case. */
export const NEO_ID_PATTERN = /^(?:[A-Za-z][0-9]){4}$/;

export function normalizeNeoId(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidNeoId(value: string): boolean {
  return NEO_ID_PATTERN.test(value);
}

/**
 * Returns a short, human-readable reason why `token` is not a Neo ID,
 * or null when it is valid.
 */
export function explainNeoIdError(token: string): string | null {
  if (isValidNeoId(token)) return null;

  if (token.length !== NEO_ID_LENGTH) {
    return `Has ${token.length} character${token.length === 1 ? "" : "s"}, needs exactly ${NEO_ID_LENGTH}`;
  }

  for (let i = 0; i < NEO_ID_LENGTH; i++) {
    const ch = token[i];
    const wantLetter = i % 2 === 0;
    const ok = wantLetter ? /^[A-Za-z]$/.test(ch) : /^[0-9]$/.test(ch);
    if (!ok) {
      return `Character ${i + 1} must be a ${wantLetter ? "letter" : "digit"}, found “${ch}”`;
    }
  }
  return "Does not match the Neo ID pattern";
}

/**
 * Splits pasted text into candidate Neo IDs.
 *
 * Words are separated by whitespace, commas, semicolons or pipes, so a line
 * can hold several IDs. Quotes and brackets wrapped around a word (as left
 * behind by copying from JSON or CSV) and a trailing full stop or colon are
 * stripped; everything else is kept so that genuine typos are still flagged.
 */
export function tokenize(text: string): string[] {
  return text
    .split(/[\s,;|]+/)
    .map((word) => word.replace(/^["'`()[\]{}<>]+|["'`()[\]{}<>.:]+$/g, ""))
    .filter((word) => word.length > 0 && isValidNeoId(word));
}

export type TokenStatus = "valid" | "invalid" | "duplicate";

export interface ClassifiedToken {
  raw: string;
  /** Upper-case Neo ID for valid and duplicate tokens, otherwise the raw word. */
  id: string;
  status: TokenStatus;
  reason?: string;
}

/** Classifies each word as valid, invalid, or a repeat of an earlier valid ID. */
export function classifyTokens(tokens: string[]): ClassifiedToken[] {
  const seen = new Set<string>();
  return tokens.map((raw) => {
    const reason = explainNeoIdError(raw);
    if (reason) return { raw, id: raw, status: "invalid", reason };
    const id = normalizeNeoId(raw);
    if (seen.has(id)) return { raw, id, status: "duplicate" };
    seen.add(id);
    return { raw, id, status: "valid" };
  });
}
