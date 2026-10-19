import { describe, expect, it } from "vitest";
import { GeminiRequestError, getGeminiApiStatusCode, isGeminiServiceError } from "../src/agents/gemini-errors.js";
import { BrowserToolError } from "../src/browser/browser-errors.js";

describe("Gemini service errors", () => {
  it.each([503, 504, 429])("recognizes HTTP %i failures from the SDK error", (status) => {
    const error = Object.assign(new Error(`Gemini request failed: ${status}`), { status });
    expect(getGeminiApiStatusCode(error)).toBe(status);
    expect(isGeminiServiceError(error)).toBe(true);
  });

  it("recognizes structured API error payloads and request timeouts", () => {
    const apiError = new Error(JSON.stringify({ error: { code: 504, status: "DEADLINE_EXCEEDED" } }));
    const timeout = Object.assign(new Error("Request timed out"), { name: "RequestTimeoutError" });
    expect(getGeminiApiStatusCode(apiError)).toBe(504);
    expect(isGeminiServiceError(new GeminiRequestError(apiError))).toBe(true);
    expect(getGeminiApiStatusCode(timeout)).toBeNull();
    expect(isGeminiServiceError(timeout)).toBe(false);
    expect(isGeminiServiceError(new GeminiRequestError(timeout))).toBe(true);
  });

  it("does not classify ordinary model/client errors as service outages", () => {
    expect(isGeminiServiceError(new Error("Gemini returned invalid JSON"))).toBe(false);
  });

  it.each([
    "Playwright MCP tool browser_navigate timed out after 20000ms.",
    "Request timed out", "HTTP 504 DEADLINE_EXCEEDED", "Gemini HTTP 503 UNAVAILABLE",
  ])("does not infer Gemini source from an untyped error message: %s", (message) => {
    expect(isGeminiServiceError(new Error(message))).toBe(false);
    expect(isGeminiServiceError(message)).toBe(false);
  });

  it.each([429, 503, 504])("does not classify browser HTTP %i errors as Gemini failures", (status) => {
    const error = new BrowserToolError("browser_navigate", Object.assign(new Error(`Request timed out; HTTP ${status}`), { status }));
    expect(isGeminiServiceError(error)).toBe(false);
    expect(getGeminiApiStatusCode(error)).toBeNull();
  });
});
