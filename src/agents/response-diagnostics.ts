// Only structural information and finite contract/SDK enum values may enter the
// action log. Model-controlled keys, discriminator strings, and SDK messages can
// contain page content or secrets, even when they appear to be metadata.
export class InvalidGeminiJsonError extends Error {
  constructor(reason: "empty" | "invalid_json" = "invalid_json") {
    super(reason === "empty"
      ? "Gemini returned an empty JSON response; the response body was omitted from diagnostics."
      : "Gemini returned invalid JSON; the response body was omitted from diagnostics.");
    this.name = "InvalidGeminiJsonError";
  }
}

const responseContractKeys = new Set([
  "kind", "toolName", "arguments", "rationale", "assessments",
  "issueNumber", "scenarios", "status",
]);
const finishReasonValues = new Set([
  "FINISH_REASON_UNSPECIFIED", "STOP", "MAX_TOKENS", "SAFETY", "RECITATION",
  "LANGUAGE", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
  "MALFORMED_FUNCTION_CALL", "IMAGE_SAFETY", "UNEXPECTED_TOOL_CALL",
  "TOO_MANY_TOOL_CALLS", "IMAGE_PROHIBITED_CONTENT", "NO_IMAGE",
  "IMAGE_RECITATION", "IMAGE_OTHER", "CONTINUATION",
]);
const blockedReasonValues = new Set([
  "BLOCKED_REASON_UNSPECIFIED", "SAFETY", "OTHER", "BLOCKLIST",
  "PROHIBITED_CONTENT", "IMAGE_SAFETY", "MODEL_ARMOR", "JAILBREAK",
]);
const tokenCountKeys = [
  "cachedContentTokenCount", "candidatesTokenCount", "promptTokenCount",
  "thoughtsTokenCount", "toolUsePromptTokenCount", "totalTokenCount",
  "initialPromptTokenCount",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function jsonByteCount(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : Buffer.byteLength(json, "utf8");
  } catch {
    return null;
  }
}

export function summarizeJsonResponse(value: unknown, responseByteCount?: number | null) {
  const keys = isRecord(value) ? Object.keys(value) : [];
  const hasDiscriminator = isRecord(value) && Object.hasOwn(value, "kind");
  const discriminator = hasDiscriminator ? value.kind : undefined;
  return {
    responseType: safeType(value),
    responseTopLevelKeys: keys.filter((key) => responseContractKeys.has(key)),
    responseUnknownTopLevelKeyCount: keys.filter((key) => !responseContractKeys.has(key)).length,
    responseDiscriminator: !hasDiscriminator ? "missing"
      : discriminator === "action" || discriminator === "finish" ? discriminator
      : typeof discriminator === "string" ? "unknown_string" : safeType(discriminator),
    responseByteCount: responseByteCount === undefined ? jsonByteCount(value) : responseByteCount,
    responseByteCountSource: responseByteCount === undefined ? "serialized_json" : "response_text",
  };
}

function safeEnum(value: unknown, allowed: Set<string>): string | null {
  return value === undefined || value === null ? null
    : typeof value === "string" && allowed.has(value) ? value : "UNKNOWN";
}

export function summarizeGeminiFinishMetadata(response: unknown) {
  const record = isRecord(response) ? response : {};
  const candidates = Array.isArray(record.candidates) ? record.candidates : undefined;
  const promptFeedback = isRecord(record.promptFeedback) ? record.promptFeedback : {};
  const usage = isRecord(record.usageMetadata) ? record.usageMetadata : {};
  const usageTokenCounts = Object.fromEntries(tokenCountKeys.flatMap((key) => {
    const value = usage[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? [[key, value]] : [];
  }));
  return {
    candidateCount: candidates?.length ?? null,
    // Bound the log size independently of any unexpected SDK response shape.
    finishReasons: (candidates ?? []).slice(0, 8).map((candidate: unknown) =>
      safeEnum(isRecord(candidate) ? candidate.finishReason : undefined, finishReasonValues)),
    blockedReason: safeEnum(promptFeedback.blockReason, blockedReasonValues),
    usageTokenCounts,
  };
}
