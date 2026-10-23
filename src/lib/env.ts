/**
 * Reads a setting from the environment.
 *
 * On Node (local dev, Vercel) settings are on `process.env`. On Cloudflare
 * Workers they usually are too, but if the runtime doesn't copy them over
 * we fall back to the bindings Cloudflare attaches to each request.
 */
export function readEnv(name: string): string | undefined {
  const fromProcess = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (fromProcess) return fromProcess;
  try {
    const cf = (globalThis as Record<symbol, { env?: Record<string, unknown> } | undefined>)[
      Symbol.for("__cloudflare-context__")
    ];
    const value = cf?.env?.[name];
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}
