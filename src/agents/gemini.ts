import { GoogleGenAI } from "@google/genai";
import { appendActionLog } from "../evidence/logger.js";
import { getGeminiApiStatusCode } from "./gemini-errors.js";

export type GeminiRequestKind = "planner" | "executor" | "smoke";

export interface GeminiRequestContext {
  runId?: string;
  scenarioId?: string;
}

export class GeminiAgent {
  private readonly client: GoogleGenAI;

  constructor(
    readonly apiKey: string | undefined,
    readonly model: string,
    private readonly context: GeminiRequestContext = {},
  ) {
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
    context: GeminiRequestContext = {},
  ): Promise<unknown> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Gemini request timeout must be a positive finite number of milliseconds.");
    const startedAt = performance.now();
    const request = {
      model: this.model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        temperature: 0.1,
        httpOptions: { timeout: timeoutMs },
      },
    };
    const baseDiagnostics = {
      ...this.context,
      ...context,
      timestamp: new Date().toISOString(),
      event: "gemini_request",
      requestKind,
      model: this.model,
      timeoutMs,
      promptCharacterCount: prompt.length,
      promptByteCount: Buffer.byteLength(prompt, "utf8"),
      schemaByteCount: Buffer.byteLength(JSON.stringify(schema), "utf8"),
      // Size of the JSON SDK input, before its wire-format transformation.
      requestByteCount: Buffer.byteLength(JSON.stringify(request), "utf8"),
      retryCount: 0,
      retryPolicy: "disabled",
    };
    let responseByteCount: number | null = null;
    try {
      const response = await this.client.models.generateContent(request);
      responseByteCount = Buffer.byteLength(response.text ?? "", "utf8");
      if (!response.text) throw new Error("Gemini returned an empty response; verify model access and API quota.");
      const parsed: unknown = JSON.parse(response.text);
      await appendActionLog({
        ...baseDiagnostics,
        status: "ok",
        durationMs: Math.round(performance.now() - startedAt),
        apiStatusCode: null,
        responseByteCount,
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
        responseByteCount,
        errorName: failure instanceof Error ? failure.name : "UnknownError",
      });
      throw failure;
    }
  }
}
