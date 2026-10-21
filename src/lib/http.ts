import { NextResponse } from "next/server";
import { isAdmin } from "./auth";
import { HttpError } from "./students";

export function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/** Reads a JSON body. Requiring the JSON content type blocks cross-site form posts. */
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new HttpError(415, "Send the request as application/json.");
  }
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "The request body isn't valid JSON.");
  }
}

export async function requireAdmin(request: Request) {
  if (!(await isAdmin(request))) throw new HttpError(401, "Sign in as admin to do this.");
}

/** Wraps a handler so thrown HttpErrors become JSON responses and anything else becomes a 500. */
export function handle(fn: (request: Request) => Promise<Response>) {
  return async (request: Request) => {
    try {
      return await fn(request);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      // Missing configuration is the most common first-deploy problem; say so plainly.
      const message = err instanceof Error ? err.message : "";
      if (/is not set|must be at least/.test(message)) return json({ error: message }, 500);
      return json({ error: "Something went wrong on the server. Check the deployment logs." }, 500);
    }
  };
}
