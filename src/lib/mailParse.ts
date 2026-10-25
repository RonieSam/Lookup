import { classifyTokens, tokenize } from "./neo";

/**
 * Reading a "selection list" email.
 *
 * The subject names the company and the kind of drive; the body lists the Neo IDs:
 *
 *   Congratulations !! Sobha Limited Dream Core Internship selection list - 2027 Batch !!
 *   Congratulations !! Myntra Super Dream Internship Selection list - 2027 Batch !!
 *   Congratulations!! Urban Company Dream Internship / Placement Offer Selection List - 2027 Batch - VLR
 *   Congratulations !! Valeo Regular Internship Selection List!! - Additional
 *   Congratulations ! E.I.D. – Parry (India) Murugappa Group Dream Core Internship Selection List!!
 *
 * So the company is the text between the "Congratulations" greeting and the
 * drive type ("Dream Core Internship", "Super Dream Internship", "Regular
 * Internship", ...). When a subject doesn't fit, the company comes back null
 * and the admin types it in; nothing is guessed.
 */

// A drive type is a tier word followed by what's being offered, e.g. "Super Dream Internship".
const TIER_AND_KIND =
  /\b(?:(?:super|open)\s+dream(?:\s+core)?|dream(?:\s+core)?|regular|core|marquee)\s+(?:internship|placement|offer|ppo|selection)\b/i;
// Fallback when there's no tier word: cut at the first "Internship", "Placement", ...
const KIND = /\b(?:internship|placement|offer|ppo|selection)\b/i;

const EDGE_PUNCTUATION = /^[\s!,:;|/–—-]+|[\s!,:;|/–—-]+$/g;
const MAX_COMPANY_LENGTH = 100;

export function extractCompany(subject: string): string | null {
  let s = subject.replace(/\s+/g, " ").trim();
  s = s.replace(/^(?:(?:re|fwd?)\s*:\s*)+/i, "");
  if (!/selection\s+list/i.test(s)) return null;

  s = s.replace(/^(?:congratulations|congrats)\b[\s!.,:–—-]*/i, "");

  let cut = s.search(TIER_AND_KIND);
  if (cut === -1) cut = s.search(KIND);
  if (cut === -1) return null;

  const company = s.slice(0, cut).replace(EDGE_PUNCTUATION, "");
  return company === "" || company.length > MAX_COMPANY_LENGTH ? null : company;
}

/**
 * Every Neo ID in the text, upper-case, in order of first appearance.
 *
 * A word only counts when the whole word is a Neo ID, so a web address or a
 * longer code that happens to contain eight matching characters is not picked up.
 */
export function extractNeoIds(text: string): string[] {
  const ids: string[] = [];
  for (const t of classifyTokens(tokenize(text))) if (t.status === "valid") ids.push(t.id);
  return ids;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain text from an HTML email body: line breaks at block ends, tags and entities removed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
      if (body[0] === "#") {
        const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[body.toLowerCase()] ?? whole;
    });
}
