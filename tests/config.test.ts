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

describe("Playwright navigation and scenario budget configuration", () => {
  it("defaults navigation to 60 seconds without changing existing safety limits", () => {
    for (const key of ["PLAYWRIGHT_NAVIGATION_TIMEOUT_MS", "MAX_ACTIONS_PER_SCENARIO", "MAX_EXECUTOR_REQUESTS_PER_SCENARIO"]) vi.stubEnv(key, undefined);
    expect(readConfig()).toMatchObject({ PLAYWRIGHT_NAVIGATION_TIMEOUT_MS: 60_000, MAX_ACTIONS_PER_SCENARIO: 15, MAX_EXECUTOR_REQUESTS_PER_SCENARIO: 32 });
  });
  it("accepts a configured navigation timeout and a 180-second scenario deadline", () => {
    vi.stubEnv("PLAYWRIGHT_NAVIGATION_TIMEOUT_MS", "90000"); vi.stubEnv("MAX_SCENARIO_SECONDS", "180");
    expect(readConfig()).toMatchObject({ PLAYWRIGHT_NAVIGATION_TIMEOUT_MS: 90_000, MAX_SCENARIO_SECONDS: 180 });
  });
  it.each(["0", "-1", "1.5", "600001", "Infinity", "invalid", ""])("rejects invalid navigation timeout %s", (value) => {
    vi.stubEnv("PLAYWRIGHT_NAVIGATION_TIMEOUT_MS", value);
    expect(() => readConfig()).toThrow(/PLAYWRIGHT_NAVIGATION_TIMEOUT_MS/);
  });
});
