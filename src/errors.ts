// Safe error construction: upstream response bodies may hold secrets, so they never reach a thrown message.
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,60}$/;
const MAX_FIELDS = 10;

// Keeps only a stable error code (`_error_type`) and top-level field names from a JSON object body.
// Values are never copied; non-JSON, non-object or unparseable bodies yield nothing.
export function safeDiagnostics(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const obj = parsed as Record<string, unknown>;
  const parts: string[] = [];
  const code = obj._error_type;
  if (typeof code === "string" && SAFE_NAME.test(code)) parts.push(`code=${code}`);
  const fields = Object.keys(obj).filter((k) => !k.startsWith("_error_") && SAFE_NAME.test(k)).slice(0, MAX_FIELDS);
  if (fields.length > 0) parts.push(`fields=${fields.join(",")}`);
  return parts.join("; ");
}

export function safeApiError(context: string, body: string): Error {
  const diag = safeDiagnostics(body);
  return new Error(diag ? `${context} [${diag}]` : context);
}

// What the fatal startup path may print: the (already safe) message, never the raw error object or its stack.
export function fatalMessage(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}
