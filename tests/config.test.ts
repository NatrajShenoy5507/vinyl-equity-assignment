import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv/config", () => ({}));
import { readConfig } from "../src/config.js";

afterEach(() => vi.unstubAllEnvs());

describe("Gemini executor timeout configuration", () => {
  it("keeps the existing 30-second default", () => {
    vi.stubEnv("GEMINI_EXECUTOR_TIMEOUT_MS", undefined);
    expect(readConfig().GEMINI_EXECUTOR_TIMEOUT_MS).toBe(30_000);
  });

  it("accepts an explicit per-request timeout", () => {
    vi.stubEnv("GEMINI_EXECUTOR_TIMEOUT_MS", "45000");
    expect(readConfig().GEMINI_EXECUTOR_TIMEOUT_MS).toBe(45_000);
  });

  it.each(["0", "-1", "1.5", "600001", "invalid"])("rejects invalid timeout %s", (value) => {
    vi.stubEnv("GEMINI_EXECUTOR_TIMEOUT_MS", value);
    expect(() => readConfig()).toThrow(/GEMINI_EXECUTOR_TIMEOUT_MS/);
  });
});
