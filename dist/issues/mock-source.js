import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeIssue } from "./issue-normalizer.js";
export async function loadMockIssue() {
    const issuePath = resolve(process.cwd(), "issues", "mock-issue.json");
    let content;
    try {
        content = await readFile(issuePath, "utf8");
    }
    catch (error) {
        throw new Error(`Cannot read mock issue at ${issuePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let data;
    try {
        data = JSON.parse(content);
    }
    catch (error) {
        throw new Error(`Mock issue JSON is malformed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return normalizeIssue(data);
}
