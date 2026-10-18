import { GoogleGenAI } from "@google/genai";
import { appendActionLog } from "../evidence/logger.js";
import { getGeminiApiStatusCode } from "./gemini-errors.js";

export type GeminiRequestKind = "planner" | "executor";

export class GeminiAgent {
  private readonly client: GoogleGenAI;

  constructor(readonly apiKey: string | undefined, readonly model: string) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured. Copy .env.example to .env and add a Gemini Developer API key.");
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: { retryOptions: { attempts: 1 } },
    });
  }

  async generateJson(
    prompt: string,
    schema: Record<string, unknown>,
    timeoutMs = 30_000,
    requestKind: GeminiRequestKind = "executor",
  ): Promise<unknown> {
    const startedAt = performance.now();
    const baseDiagnostics = {
      event: "gemini_request",
      requestKind,
      model: this.model,
      promptCharacterCount: prompt.length,
      schemaByteCount: Buffer.byteLength(JSON.stringify(schema), "utf8"),
      retryCount: 0,
      retryPolicy: "disabled",
    };
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: schema,
          temperature: 0.1,
          httpOptions: { timeout: timeoutMs },
        },
      });
      if (!response.text) throw new Error("Gemini returned an empty response; verify model access and API quota.");
      const parsed: unknown = JSON.parse(response.text);
      await appendActionLog({
        ...baseDiagnostics,
        status: "ok",
        durationMs: Math.round(performance.now() - startedAt),
        apiStatusCode: null,
      });
      return parsed;
    } catch (error) {
      const failure = error instanceof SyntaxError
        ? new Error(`Gemini returned invalid JSON: ${error.message}`, { cause: error })
        : error;
      await appendActionLog({
        ...baseDiagnostics,
        status: "error",
        durationMs: Math.round(performance.now() - startedAt),
        apiStatusCode: getGeminiApiStatusCode(failure),
        errorName: failure instanceof Error ? failure.name : "UnknownError",
      });
      throw failure;
    }
  }
}
