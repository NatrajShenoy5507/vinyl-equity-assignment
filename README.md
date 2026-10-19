# Autonomous UI Testing Agent

TypeScript CLI that accepts a GitHub issue (or local mock) marked Ready for QA, asks Gemini to generate acceptance-criteria-based UI scenarios, and executes them through a real Playwright MCP browser. It writes structured action logs, real screenshots and deterministic reports. No browser steps are pre-authored as runnable scripts.

## Requirements and setup

- Node.js 22+ and npm.
- A Gemini Developer API key from Google AI Studio. API billing/quota may apply; a Gemini chat subscription does not automatically grant API access.
- Internet access for Gemini, GitHub (GitHub mode), npm/Playwright MCP, and the demo site.
- Playwright MCP's Chromium browser installed/launchable. Use a headed desktop for the default setting or set `HEADLESS=true`.

In PowerShell from the project folder:

```powershell
node --version
npm install
Copy-Item .env.example .env
notepad .env
npm run build
npm run check
npm test
npm run qa:mock
npm run qa:browser-smoke
```

Set `GEMINI_API_KEY` in `.env` before running QA. Do not paste it into source, issue text, or logs. `GEMINI_MODEL` defaults to `gemini-2.5-flash`; change it to a model available to your API project if necessary. The agent makes actual Gemini requests and does not substitute a fixture plan when the API is unavailable.

## Commands

```powershell
npm run check
npm run build
npm test
npm run qa:mock
npm run qa:browser-smoke
npm run qa:gemini-smoke
npm run qa:github -- --repo=OWNER/REPOSITORY --issue=1
npm run start -- --help
```

`qa:browser-smoke` validates only Playwright MCP startup, navigation, snapshot, screenshot creation and shutdown. It does not call Gemini or test acceptance criteria; its separate result is `evidence/browser-smoke.json`, including any console-error count reported by the browser navigation tool.

`qa:gemini-smoke` makes one real Gemini API request for the tiny structured response `{"status":"ok"}` and validates it locally. It starts no browser and performs no scenario planning or acceptance-criteria verification. Run it separately when investigating Gemini access or latency, using the same model as the blocked run:

```powershell
$env:GEMINI_MODEL = "gemini-3.1-flash-lite"
npm run qa:gemini-smoke
```

It writes `evidence/gemini-smoke.json`, `evidence/runs/<runId>/gemini-smoke.json`, and request diagnostics in the corresponding action log. PASS establishes only that the simple API request worked; it does not establish that an executor request or UI scenario will succeed. A 504 on this small request shows that the failure can occur independently of the executor payload. Compare model, API project, timeout, and timing before drawing conclusions. This command calls the live API; `npm test` uses mocks and never invokes it.

`GEMINI_EXECUTOR_TIMEOUT_MS` controls the executor's per-request timeout in milliseconds (default `30000`, valid range `1` through `600000`). Each request is capped by the remaining `MAX_SCENARIO_SECONDS` budget, including during revalidation, and late decisions cannot trigger actions or finish verification. The Gemini smoke check uses this same request timeout. Increasing it alone does not establish a fix for a service-side HTTP 504; retries remain disabled so a failed request remains visible in diagnostics.

Mock mode reads `issues/mock-issue.json` and requires `"status": "RFQA"`. GitHub mode requests the REST issue and requires a case-insensitive `RFQA` **issue label**. Public issue reads work without a token; `GITHUB_TOKEN` is optional and useful for private repositories/rate limits. For private repos use a fine-grained token with only repository Issues read access. Example issue format: [issues/example-github-issue.md](./issues/example-github-issue.md).

A GitHub Projects board's custom **Status** field and an issue label are different. Moving a project card to an RFQA column does not add an RFQA issue label or invoke this label-based CLI automatically. Reading Projects v2 Status/webhook automation is not implemented.

## Evidence and outcomes

The CLI writes deterministic evidence produced by TypeScript (not by Gemini summarizing the run):

- `evidence/application-context.json` — validated Phase 2 Application Context for the latest exploration.
- `evidence/generated-scenarios.json` — actual validated Gemini plan for the latest successful planning request.
- `evidence/action-log.ndjson` — timestamped tool discovery, decisions, observations and assertion records.
- `evidence/screenshots/<runId>/` — screenshots returned by Playwright MCP and checked on disk.
- `evidence/report.json` and `evidence/report.md` — latest convenience copies of the deterministic QA report.
- `evidence/runs/<runId>/` — run-scoped copies of report, application context, generated scenarios, and action log so earlier runs are not overwritten by later ones.
- `evidence/browser-smoke.json` — separate MCP infrastructure check, explicitly not an AC-level QA result.

Gemini request events include timestamp, run/scenario IDs when applicable, request type (`planner`, `executor`, or `smoke`), model, effective timeout, duration, success/error status, HTTP status when available, and prompt/schema/request/response sizes. `requestByteCount` measures the serialized SDK input before wire-format transformation; it is not a network-byte measurement. Prompt/response content and credentials are excluded from these diagnostic events. Events are written both to the latest log and `evidence/runs/<runId>/action-log.ndjson`.

`report.md` is structured for QA review: executive summary, issue/target, environment/model, six-phase execution summary (`COMPLETED`/`FAILED`/`BLOCKED`/`NOT_RUN`), generated scenarios, acceptance-criteria traceability, per-scenario results (including host verification and browser actions), revalidation details when Phase 5 ran, artifact inventory, blockers, and final status. Phase operational status is separate from scenario PASS/FAIL/BLOCKED/SKIPPED; Phase 5 `NOT_RUN` when there was no host-verified FAIL is expected.

PASS requires host-verified checks against real post-action observations plus retained screenshot evidence. FAIL means an observed contradiction. BLOCKED means the feature could not be verified because of an API, browser, navigation, safety, ambiguity or run-limit issue (including Gemini 429/503/504). SKIPPED means the issue is not RFQA. Acceptance criteria are marked PASS only from host verification, never merely because a scenario listed the criterion ID. These statuses are not interchangeable. Infrastructure/setup errors return a non-zero exit code; observed FAIL/BLOCKED also returns non-zero.

Without `GEMINI_API_KEY`, `npm run qa:mock` records a BLOCKED outcome, not a fake generated plan. Unit tests can run without credentials. If a run stops before generation, the report/log still preserve the blocker.

## Architecture

`src/issues/` validates mock or GitHub issue content; `src/browser/explorer.ts` builds the Phase 2 Application Context; `src/agents/planner.ts` generates and checks complete AC coverage; `src/browser/` starts the MCP server, discovers schemas and restricts available tools; `src/agents/executor.ts` runs a bounded observe/act/verify loop; `src/agents/revalidator.ts` optionally re-runs host-verified FAIL once; `src/evidence/` maintains the phase ledger, action log, and deterministic JSON/Markdown reports. Each scenario receives a fresh MCP/browser process for state isolation. The project uses the installed MCP TypeScript SDK v1 (`Client` + `StdioClientTransport`) consistently and the `@google/genai` SDK.

Planning requires one acceptance criterion per scenario, with all prerequisite state established in that scenario's own steps. Each scenario stops at its criterion's appropriate final state; later lifecycle actions must not invalidate that state. Steps and controls remain dynamically planned from the issue and observed application context. The plan cache includes a fingerprint of the planning contract version, actual planner prompt, API response schema, and host schema. Legacy caches or changes to those inputs force regeneration; changes to host planning rules also require incrementing the contract version.

The executor shares a compact action envelope across tools and deduplicates argument shapes, while the host still binds arguments to the exact discovered tool schema and enforces the allowlist, origin checks, current accessibility references, and evidence validation. Phase 4 is `BLOCKED` when infrastructure or verification blockers prevent execution from completing; a fully executed functional FAIL can still have a `COMPLETED` phase status.

## Troubleshooting

- **Missing/invalid Gemini key or model:** check `.env`, Gemini API project access and quota; use a model name available to that API account. The report identifies the run as BLOCKED.
- **Playwright MCP/Chromium launch failure:** rerun `npm run qa:mock` with network access; allow `npx` to fetch `@playwright/mcp`; install the required Playwright browser for the package/runtime if its diagnostic requests it. Try `HEADLESS=true` on machines without a display.
- **Windows `npx` startup:** the program uses `npx.cmd` on Windows. If execution policy restrictions prevent PowerShell startup, use a normal PowerShell prompt with Node/npm on PATH.
- **GitHub 404/401/403:** confirm `OWNER/REPOSITORY`, issue number and access. Add `GITHUB_TOKEN` in `.env` for private repos or rate limits.
- **No acceptance criteria found:** include an `## Acceptance Criteria` heading and list lines such as `- AC-01: The item can be created.` Empty/malformed issue bodies are rejected.
- **BLOCKED browser scenario:** inspect the actual tool/snapshot entries in `evidence/action-log.ndjson`; no CSS/XPath fallback is used when a semantic reference is missing.

## Assignment checklist

| Requirement | Implementation |
|---|---|
| Issue ingestion and RFQA guard | `src/issues/`, `src/index.ts` |
| AI-generated plan with full AC coverage | `src/agents/planner.ts`, `evidence/generated-scenarios.json` |
| Live browser via discovered Playwright MCP tools | `src/browser/`, `src/agents/executor.ts` |
| Bounded actions/recovery and evidence gating | `src/agents/executor.ts`, `src/browser/tool-policy.ts` |
| Logs, screenshots, JSON and Markdown report | `src/evidence/`, `/evidence` |
| Setup, test plan and scenario mapping | `README.md`, `TEST_PLAN.md`, `SCENARIOS.md` |

## Official references used

- [Google Gen AI TypeScript SDK](https://googleapis.github.io/js-genai/release_docs/index.html)
- [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- [MCP TypeScript SDK v1 Client](https://ts.sdk.modelcontextprotocol.io/client) — used consistently because v1 was already installed.
- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) and [configuration options](https://playwright.dev/mcp/configuration/options)
- [GitHub REST issues API](https://docs.github.com/en/rest/issues/issues)

`npm test` is a mock/unit suite, not proof of a live integration. Only the report and screenshots created by an executed run are evidence of actual browser behavior.
