/** A failure originating from Playwright/MCP, rather than the model service. */
export class BrowserToolError extends Error {
  readonly source = "browser" as const;
  constructor(readonly operation: string, cause: unknown, readonly timeoutMs?: number) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "BrowserToolError";
  }
}

export const DEFAULT_NAVIGATION_TIMEOUT_MS = 60_000;
