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

export function getGeminiApiStatusCode(error: unknown): number | null {
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
  const { messages } = collectErrorDetails(error);
  return messages.some((message) => /\b429\b|RESOURCE_EXHAUSTED|quota exceeded|rate limit/i.test(message));
}

export function isGeminiServiceError(error: unknown): boolean {
  const { messages, statusCodes } = collectErrorDetails(error);
  return statusCodes.some((status) => status === 429 || status >= 500)
    || messages.some((message) => /\b(429|5\d{2})\b|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|quota exceeded|rate limit|timed?\s*out|timeout/i.test(message));
}
