import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  TARGET_URL: z.string().url().default("https://demo.playwright.dev/todomvc/"),
  GITHUB_TOKEN: z.string().optional(),
  MAX_ACTIONS_PER_SCENARIO: z.coerce.number().int().min(1).max(50).default(15),
  MAX_SCENARIO_SECONDS: z.coerce.number().int().min(1).max(600).default(120),
  MAX_RECOVERY_RETRIES: z.coerce.number().int().min(0).max(1).default(1),
  HEADLESS: z.string().default("false"),
});

export interface CliOptions {
  source: "mock" | "github";
  repo?: string;
  issue?: number;
  scenario?: string;
  help: boolean;
}

export function readConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return {
    ...parsed.data,
    HEADLESS: parsed.data.HEADLESS.toLowerCase() === "true",
  };
}

export function parseCli(args: string[]): CliOptions {
  const options: CliOptions = { source: "mock", help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const [rawKey, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? args[index + 1];
    if (inlineValue === undefined && value !== undefined && !value.startsWith("--")) index += 1;
    if (rawKey === "--source") {
      if (value !== "mock" && value !== "github") throw new Error("--source must be mock or github.");
      options.source = value;
    } else if (rawKey === "--repo") {
      if (!value) throw new Error("--repo requires owner/repository.");
      options.repo = value;
    } else if (rawKey === "--issue") {
      const issueNumber = Number(value);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("--issue must be a positive integer.");
      options.issue = issueNumber;
    } else if (rawKey === "--scenario") {
      if (!value?.trim()) throw new Error("--scenario requires a scenario ID such as SC-01.");
      options.scenario = value.trim();
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (!options.help && options.source === "github" && (!options.repo || !options.issue)) {
    throw new Error("GitHub mode requires --repo=owner/repository and --issue=NUMBER.");
  }
  return options;
}

export const usage = `Autonomous UI QA Agent

Usage:
  npm run qa:mock
  npm run qa:github -- --repo=OWNER/REPOSITORY --issue=NUMBER
  npm run qa:mock -- --scenario=SC-01
  npm run qa:browser-smoke
  npm run start -- --help

Set GEMINI_API_KEY in a local .env file before a live QA run.`;
