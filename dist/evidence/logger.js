import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
export const evidenceDirectory = resolve(process.cwd(), "evidence");
export async function resetActionLog() {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(resolve(evidenceDirectory, "action-log.ndjson"), "", "utf8");
}
export async function appendActionLog(event) {
    const serialized = JSON.stringify(event)
        .replace(/(api[_-]?key|authorization|token|cookie)(["']?\s*[:=]\s*["']?)[^"',}\s]+/gi, "$1$2[REDACTED]");
    await appendFile(resolve(evidenceDirectory, "action-log.ndjson"), `${serialized}\n`, "utf8");
}
