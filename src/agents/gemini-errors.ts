function collectErrorDetails(error: unknown): { messages: string[]; statusCodes: number[] } {
  const messages: string[] = [];
  const statusCodes: number[] = [];
  const pending: unknown[] = [error];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      messages.push(current);
      try {
        pending.push(JSON.parse(current) as unknown);
      } catch {
        // Error messages are commonly plain text; the original value is already retained.
      }
      continue;
    }
    if (typeof current !== "object" || current === null || visited.has(current)) continue;
    visited.add(current);
    const value = current as Record<string, unknown>;
    for (const key of ["name", "message", "status", "code"]) {
      if (typeof value[key] === "string") messages.push(value[key]);
      if (typeof value[key] === "number") {
        messages.push(String(value[key]));
        if (key === "status" || key === "code") statusCodes.push(value[key]);
      }
    }
    if ("cause" in value) pending.push(value.cause);
    if ("error" in value) pending.push(value.error);
  }

  return { messages, statusCodes };
}

/** Applied only at the Gemini SDK/request boundary, never by matching report text. */
export class GeminiRequestError extends Error {
  readonly source = "gemini" as const;
  readonly httpStatus: number | null;
  readonly isTimeout: boolean;
  constructor(cause: unknown) {
    const status = getGeminiApiStatusCode(cause);
    const timeout = collectErrorDetails(cause).messages.some((message) => /timed?\s*out|timeout|DEADLINE_EXCEEDED/i.test(message));
    const label = status === 429 ? "RESOURCE_EXHAUSTED" : status === 503 ? "UNAVAILABLE" : status === 504 ? "DEADLINE_EXCEEDED" : "request failed";
    super(status ? `Gemini HTTP ${status} ${label}.` : timeout ? "Gemini request timed out." : "Gemini request failed.", { cause });
    this.name = "GeminiRequestError";
    this.httpStatus = status;
    this.isTimeout = timeout;
  }
}

function hasOtherSource(error: unknown): boolean {
  return typeof error === "object" && error !== null && "source" in error && error.source !== "gemini";
}

export function getGeminiApiStatusCode(error: unknown): number | null {
  if (hasOtherSource(error)) return null;
  const details = collectErrorDetails(error);
  if (details.statusCodes.length > 0) return details.statusCodes[0]!;
  for (const message of details.messages) {
    const match = message.match(/(?:HTTP\s*|status(?:\s*code)?\s*[:=]?\s*)?(503|504|429)\b/i);
    if (match) return Number(match[1]);
    try {
      const parsed = JSON.parse(message) as { error?: { code?: unknown } };
      if (typeof parsed.error?.code === "number") return parsed.error.code;
    } catch {
      // The message may be an SDK-formatted error rather than JSON.
    }
  }
  return null;
}

export function isGeminiQuotaError(error: unknown): boolean {
  if (hasOtherSource(error)) return false;
  const { messages } = collectErrorDetails(error);
  return messages.some((message) => /\b429\b|RESOURCE_EXHAUSTED|quota exceeded|rate limit/i.test(message));
}

export function isGeminiServiceError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || hasOtherSource(error)) return false;
  const { statusCodes } = collectErrorDetails(error);
  return statusCodes.some((status) => status === 429 || status >= 500)
    || (error instanceof GeminiRequestError && (error.isTimeout || error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500));
}
