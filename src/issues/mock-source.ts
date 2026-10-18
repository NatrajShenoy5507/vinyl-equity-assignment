import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeIssue } from "./issue-normalizer.js";
import type { NormalizedIssue } from "../schemas.js";

export async function loadMockIssue(): Promise<NormalizedIssue> {
  const issuePath = resolve(process.cwd(), "issues", "mock-issue.json");
  let content: string;
  try {
    content = await readFile(issuePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read mock issue at ${issuePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    throw new Error(`Mock issue JSON is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeIssue(data);
}
