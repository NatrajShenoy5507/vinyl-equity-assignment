import { GoogleGenAI } from "@google/genai";
import { appendActionLog } from "../evidence/logger.js";
import { GeminiRequestError, getGeminiApiStatusCode } from "./gemini-errors.js";
import { InvalidGeminiJsonError, summarizeGeminiFinishMetadata, summarizeJsonResponse } from "./response-diagnostics.js";

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
    let responseDiagnostics: Record<string, unknown> = {};
    try {
      const response = await this.client.models.generateContent(request).catch((error: unknown) => {
        throw new GeminiRequestError(error);
      });
      responseDiagnostics = summarizeGeminiFinishMetadata(response);
      const responseText = response.text;
      responseByteCount = Buffer.byteLength(responseText ?? "", "utf8");
      responseDiagnostics = {
        ...responseDiagnostics,
        responseType: responseText ? "invalid_json" : "empty",
        responseTopLevelKeys: [],
        responseUnknownTopLevelKeyCount: 0,
        responseDiscriminator: "unavailable",
      };
      if (!responseText) throw new InvalidGeminiJsonError("empty");
      const parsed: unknown = JSON.parse(responseText);
      responseDiagnostics = { ...responseDiagnostics, ...summarizeJsonResponse(parsed, responseByteCount) };
      await appendActionLog({
        ...baseDiagnostics,
        ...responseDiagnostics,
        status: "ok",
        durationMs: Math.round(performance.now() - startedAt),
        apiStatusCode: null,
        responseByteCount,
      });
      return parsed;
    } catch (error) {
      const failure = error instanceof SyntaxError
        // JSON.parse errors can echo arbitrary model output. Do not retain even
        // their cause: the caller may include the error in a report or log.
        ? new InvalidGeminiJsonError()
        : error;
      await appendActionLog({
        ...baseDiagnostics,
        ...responseDiagnostics,
        status: "error",
        durationMs: Math.round(performance.now() - startedAt),
        apiStatusCode: getGeminiApiStatusCode(failure),
        responseByteCount,
        errorName: failure instanceof GeminiRequestError && failure.cause instanceof Error ? failure.cause.name
          : failure instanceof Error ? failure.name : "UnknownError",
      });
      throw failure;
    }
  }
}
