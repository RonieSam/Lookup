import { readEnv } from "./env";
import { htmlToText } from "./mailParse";
import { HttpError } from "./students";

/**
 * A small Gmail reader: sign in with a saved refresh token, search, and fetch messages.
 *
 * It only ever reads (the gmail.readonly permission), and only through the search
 * the app builds. It uses plain `fetch`, so it runs on Cloudflare Workers too.
 */

export interface GmailMessage {
  id: string;
  subject: string;
  from: string;
  /** When Gmail received the message, as an ISO timestamp. */
  date: string;
  /** The message body as plain text. */
  text: string;
}

export interface GmailClient {
  /** Ids of messages matching a Gmail search, newest first, at most `max` of them. */
  listMessageIds(query: string, max: number): Promise<string[]>;
  getMessage(id: string): Promise<GmailMessage>;
}

export const GOOGLE_SETTINGS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"] as const;

export function gmailConfigured(): boolean {
  return GOOGLE_SETTINGS.every((name) => Boolean(readEnv(name)));
}

const REAUTH =
  "Google no longer accepts the saved Gmail login. Create a new refresh token and update GOOGLE_REFRESH_TOKEN (see the README).";

type FetchFn = typeof fetch;
// Wrapped so the global fetch is always called as a plain function, which Workers requires.
const defaultFetch: FetchFn = (input, init) => fetch(input, init);

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: Part[];
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder("utf-8").decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function collectText(part: Part, plain: string[], html: string[]) {
  const type = (part.mimeType ?? "").toLowerCase();
  if (part.body?.data && !part.filename) {
    if (type === "text/plain") plain.push(decodeBase64Url(part.body.data));
    else if (type === "text/html") html.push(decodeBase64Url(part.body.data));
  }
  for (const child of part.parts ?? []) collectText(child, plain, html);
}

function header(part: Part, name: string): string {
  const wanted = name.toLowerCase();
  return part.headers?.find((h) => h.name.toLowerCase() === wanted)?.value ?? "";
}

export function createGmailClient(fetchFn: FetchFn = defaultFetch): GmailClient {
  let tokenPromise: Promise<string> | undefined;

  async function accessToken(): Promise<string> {
    tokenPromise ??= (async () => {
      const res = await fetchFn("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: readEnv("GOOGLE_CLIENT_ID") ?? "",
          client_secret: readEnv("GOOGLE_CLIENT_SECRET") ?? "",
          refresh_token: readEnv("GOOGLE_REFRESH_TOKEN") ?? "",
          grant_type: "refresh_token",
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === "invalid_grant" || body.error === "unauthorized_client") throw new HttpError(502, REAUTH);
        if (body.error === "invalid_client") {
          throw new HttpError(502, "Google doesn't recognise GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Check both values.");
        }
        throw new HttpError(502, `Couldn't sign in to Google (error ${res.status}).`);
      }
      const { access_token } = (await res.json()) as { access_token?: string };
      if (!access_token) throw new HttpError(502, "Google didn't return an access token.");
      return access_token;
    })();
    try {
      return await tokenPromise;
    } catch (err) {
      tokenPromise = undefined; // let a later call try again
      throw err;
    }
  }

  async function gmail<T>(path: string): Promise<T> {
    const res = await fetchFn(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 401) throw new HttpError(502, REAUTH);
    if (res.status === 403) {
      throw new HttpError(
        502,
        "Gmail refused access. Check that the Gmail API is enabled for your Google project and the login was given read access to Gmail.",
      );
    }
    if (res.status === 429) throw new HttpError(502, "Gmail is limiting requests right now. Try again in a minute.");
    throw new HttpError(502, `Gmail returned an error (${res.status}).`);
  }

  return {
    async listMessageIds(query, max) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ q: query, maxResults: String(Math.min(100, max - ids.length)) });
        if (pageToken) params.set("pageToken", pageToken);
        const page = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(`messages?${params}`);
        for (const m of page.messages ?? []) ids.push(m.id);
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < max);
      return ids;
    },

    async getMessage(id) {
      const m = await gmail<{ id: string; internalDate?: string; payload?: Part }>(
        `messages/${encodeURIComponent(id)}?format=full`,
      );
      const payload = m.payload ?? {};
      const plain: string[] = [];
      const html: string[] = [];
      collectText(payload, plain, html);
      const text = plain.length > 0 ? plain.join("\n") : html.map(htmlToText).join("\n");
      const received = Number(m.internalDate);
      return {
        id: m.id,
        subject: header(payload, "Subject"),
        from: header(payload, "From"),
        date: new Date(Number.isFinite(received) ? received : Date.now()).toISOString(),
        text,
      };
    },
  };
}
