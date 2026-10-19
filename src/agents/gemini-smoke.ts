import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { appendActionLog, evidenceDirectory } from "../evidence/logger.js";
import { GeminiAgent } from "./gemini.js";
import { getGeminiApiStatusCode } from "./gemini-errors.js";

export const geminiSmokePrompt = 'Return JSON with status set to "ok".';
export const geminiSmokeJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: { status: { type: "string", enum: ["ok"] } },
  required: ["status"],
  additionalProperties: false,
};
const smokeResponseSchema = z.object({ status: z.literal("ok") }).strict();

export interface GeminiSmokeOptions {
  apiKey: string | undefined;
  model: string;
  timeoutMs?: number;
  runId?: string;
}

export interface GeminiSmokeResult {
  runId: string;
  status: "PASS" | "BLOCKED";
  scope: string;
  model: string;
  timeoutMs: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error?: { name: string; apiStatusCode: number | null };
}

/** One browser-free API request; it deliberately does not plan or execute a scenario. */
export async function runGeminiSmoke(options: GeminiSmokeOptions): Promise<GeminiSmokeResult> {
  const runId = options.runId ?? `gemini-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const runDirectory = resolve(evidenceDirectory, "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let failure: GeminiSmokeResult["error"];
  try {
    const agent = new GeminiAgent(options.apiKey, options.model, { runId });
    const response = await agent.generateJson(geminiSmokePrompt, geminiSmokeJsonSchema, timeoutMs, "smoke");
    smokeResponseSchema.parse(response);
  } catch (error) {
    // SDK errors can include request data; retain only safe classification fields.
    failure = {
      name: error instanceof Error ? error.name : "UnknownError",
      apiStatusCode: getGeminiApiStatusCode(error),
    };
  }
  const result: GeminiSmokeResult = {
    runId,
    status: failure ? "BLOCKED" : "PASS",
    scope: "One simple structured Gemini response; no browser, scenario planning, or acceptance criteria verification.",
    model: options.model,
    timeoutMs,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    ...(failure ? { error: failure } : {}),
  };
  await appendActionLog({ timestamp: result.completedAt, event: "gemini_smoke_result", ...result });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(resolve(runDirectory, "gemini-smoke.json"), json, "utf8");
  await writeFile(resolve(evidenceDirectory, "gemini-smoke.json"), json, "utf8");
  return result;
}
