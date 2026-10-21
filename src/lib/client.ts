/** Small browser helpers shared by the Lookup and Admin pages. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: { error?: string; loginRequired?: boolean },
  ) {
    super(message);
  }
}

export async function api<T>(url: string, options: { method?: string; json?: unknown } = {}): Promise<T> {
  const hasBody = options.json !== undefined;
  const res = await fetch(url, {
    method: options.method ?? (hasBody ? "POST" : "GET"),
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(options.json) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  let body: { error?: string; loginRequired?: boolean } | null = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? `The server answered ${res.status}.`, body ?? undefined);
  }
  return body as T;
}

/** Quotes a cell for CSV, and defuses spreadsheet formulas ("=1+1", "@SUM") in text values. */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text))) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export function toTsv(rows: unknown[][]): string {
  return rows
    .map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c).replace(/[\t\r\n]+/g, " "))).join("\t"))
    .join("\n");
}

export function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8") {
  // The BOM makes Excel read UTF-8 names correctly.
  const blob = new Blob(["\uFEFF", text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
}
