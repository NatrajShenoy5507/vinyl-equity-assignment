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

### Configuration

Copy [`.env.example`](./.env.example) for local configuration. Keep `.env` local; provide `GEMINI_API_KEY` through a repository Actions secret for GitHub Actions. Optional settings use the defaults below, including `MAX_EXECUTOR_REQUESTS_PER_SCENARIO`, which can be added to `.env` even though it is not listed in the example file.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | unset | Required for live Gemini planning, execution, and API smoke checks. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model used for planning and execution; the successful local filtering run below used `gemini-3.5-flash-lite`. |
| `GEMINI_EXECUTOR_TIMEOUT_MS` | `30000` | Per-request executor/API smoke timeout, capped by the scenario's remaining deadline during execution. |
| `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS` | `60000` | Navigation-only timeout (integer from 1 through 600000 ms), capped by the remaining scenario deadline. |
| `TARGET_URL` | `https://demo.playwright.dev/todomvc/` | Default application URL. |
| `GITHUB_TOKEN` | unset | Optional issue-read credentials for GitHub mode. |
| `MAX_ACTIONS_PER_SCENARIO` | `15` | Maximum model-selected browser actions. |
| `MAX_EXECUTOR_REQUESTS_PER_SCENARIO` | `32` | Maximum executor requests, including early finish proposals and controlled corrections. |
| `MAX_SCENARIO_SECONDS` | `120` | Total execution deadline per scenario. |
| `MAX_RECOVERY_RETRIES` | `1` | Maximum permitted error-recovery retries; may be set to `0`. |
| `HEADLESS` | `false` | Set to `true` for browser execution without a desktop window. |

## Commands

```powershell
npm run check
npm run build
npm test
npm run qa:mock
npm run qa:mock -- --scenario=SC-03
npm run qa:explore
npm run qa:browser-smoke
npm run qa:gemini-smoke
npm run qa:github -- --repo=OWNER/REPOSITORY --issue=1
npm run start -- --help
```

`qa:browser-smoke` validates only Playwright MCP startup, navigation, snapshot, screenshot creation and shutdown. It does not call Gemini or test acceptance criteria; its separate result is `evidence/browser-smoke.json`, including any console-error count reported by the browser navigation tool.

`qa:gemini-smoke` makes one real Gemini API request for the tiny structured response `{"status":"ok"}` and validates it locally. It starts no browser and performs no scenario planning or acceptance-criteria verification. Run it separately when investigating Gemini access or latency, using the same model as the blocked run:

```powershell
$env:GEMINI_MODEL = "gemini-3.5-flash-lite"
npm run qa:gemini-smoke
```

It writes `evidence/gemini-smoke.json`, `evidence/runs/<runId>/gemini-smoke.json`, and request diagnostics in the corresponding action log. PASS establishes only that the simple API request worked; it does not establish that an executor request or UI scenario will succeed. A 504 on this small request shows that the failure can occur independently of the executor payload. Compare model, API project, timeout, and timing before drawing conclusions. This command calls the live API; `npm test` uses mocks and never invokes it.

`GEMINI_EXECUTOR_TIMEOUT_MS` controls the executor's per-request timeout in milliseconds (default `30000`, valid range `1` through `600000`). Each request is capped by the remaining `MAX_SCENARIO_SECONDS` budget, including during revalidation, and late decisions cannot trigger actions or finish verification. The Gemini smoke check uses this same request timeout. Increasing it alone does not establish a fix for a service-side HTTP 504; retries remain disabled so a failed request remains visible in diagnostics.

`PLAYWRIGHT_NAVIGATION_TIMEOUT_MS` applies to initial and model-selected navigation, exploration, browser smoke checks, integration checks, and revalidation. The MCP server receives `--timeout-navigation`; the SDK request timeout and maximum total timeout match the effective per-call budget, with progress-based extension disabled. Navigation is capped by the remaining scenario deadline. Other browser tools keep their existing 20-second wrapper limits. `MAX_SCENARIO_SECONDS=180` is supported without increasing action or model-request limits.

Infrastructure failures retain their source in `ScenarioResult.infrastructureError`. Browser timeouts are not inferred to be Gemini outages from their message text. A blocked browser scenario can be followed by the next scenario in its own isolated session; true Gemini API 429/503/504 failures still stop further model execution and report the remaining scenarios as unattempted.

Mock mode reads `issues/mock-issue.json` and requires `"status": "RFQA"`. GitHub mode requests the REST issue and requires a case-insensitive `RFQA` **issue label**. Public issue reads work without a token; `GITHUB_TOKEN` is optional and useful for private repositories/rate limits. For private repos use a fine-grained token with only repository Issues read access. Example issue format: [issues/example-github-issue.md](./issues/example-github-issue.md).

`--scenario=SC-03` executes only that scenario from the validated generated plan. Planning still checks coverage of the issue's acceptance criteria; unselected criteria remain UNVERIFIED in the execution report. Use the ID from the generated plan, since scenarios and their steps are produced dynamically. Omit `--scenario` to execute the complete plan. Mock mode uses a local issue, but still calls live Gemini and Playwright MCP.

A GitHub Projects board's custom **Status** field and an issue label are different. Moving a project card to an RFQA column does not add an RFQA issue label or invoke this label-based CLI automatically. Reading Projects v2 Status/webhook automation is not implemented.

The [GitHub Actions workflow](./.github/workflows/live-autonomous-qa.yml) supports manual dispatch with a required numeric `issue_number` and automatic execution when an issue is labeled `RFQA`. Other newly applied labels skip the QA job, even when the issue already has RFQA. The workflow uses the event issue number or manual input with `npm run qa:github -- --repo="$GITHUB_REPOSITORY" --issue="$ISSUE_NUMBER"`, executing the full generated plan for that real issue. The agent fetches the issue and rechecks its current RFQA readiness before exploration or Gemini execution; manual selection does not bypass that guard.

The workflow uses `gemini-3.5-flash-lite`, `HEADLESS=true`, `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS=60000`, and `MAX_SCENARIO_SECONDS=180`. Configure only the `GEMINI_API_KEY` repository secret; issue reads use the built-in `GITHUB_TOKEN` with `contents: read` and `issues: read`. Checkout, Node.js setup, `npm ci`, type checking, unit tests, build, browser smoke verification, and the `if: always()` evidence upload remain in place. Issue-label triggers require the workflow to exist on the default branch.

## Evidence and outcomes

The CLI writes deterministic evidence produced by TypeScript (not by Gemini summarizing the run):

- `evidence/application-context.json` — validated Phase 2 Application Context for the latest exploration.
- `evidence/generated-scenarios.json` — actual validated Gemini plan for the latest successful planning request.
- `evidence/action-log.ndjson` — timestamped tool discovery, decisions, observations and assertion records.
- `evidence/screenshots/<runId>/` — screenshots returned by Playwright MCP and checked on disk.
- `evidence/screenshots/<runId>/*-snapshot-*.txt` — host-captured accessibility snapshots, checked for the allowed origin and retained for report evidence links.
- `evidence/report.json` and `evidence/report.md` — latest convenience copies of the deterministic QA report.
- `evidence/runs/<runId>/` — run-scoped copies of report, application context, generated scenarios, and action log so earlier runs are not overwritten by later ones.
- `evidence/browser-smoke.json` — separate MCP infrastructure check, explicitly not an AC-level QA result.

Gemini request events include timestamp, run/scenario IDs when applicable, request type (`planner`, `executor`, or `smoke`), model, effective timeout, duration, success/error status, HTTP status when available, and prompt/schema/request/response sizes. `requestByteCount` measures the serialized SDK input before wire-format transformation; it is not a network-byte measurement. Prompt/response content and credentials are excluded from these diagnostic events. Events are written both to the latest log and `evidence/runs/<runId>/action-log.ndjson`.

Response diagnostics also identify the parsed JSON type, known top-level contract keys, discriminator classification, candidate count, safe SDK finish/block reason enums, and numeric token counts. Unknown keys and discriminator strings are redacted rather than copied into logs. `responseByteCountSource` distinguishes the SDK response text size from a serialized parsed-value size on executor rejection events; unparseable responses retain their text size in the SDK request event. Arbitrary output, JSON parse excerpts, SDK finish messages, and page content are omitted from these diagnostic events.

`report.md` is structured for QA review: executive summary, issue/target, environment/model, six-phase execution summary (`COMPLETED`/`FAILED`/`BLOCKED`/`NOT_RUN`), generated scenarios, acceptance-criteria traceability, per-scenario results (including host verification and browser actions), revalidation details when Phase 5 ran, artifact inventory, blockers, and final status. Phase operational status is separate from scenario PASS/FAIL/BLOCKED/SKIPPED; Phase 5 `NOT_RUN` when there was no host-verified FAIL is expected.

PASS requires host-verified checks against real post-action observations plus retained screenshot evidence. FAIL means an observed contradiction. BLOCKED means the feature could not be verified because of an API, browser, navigation, safety, ambiguity or run-limit issue (including Gemini 429/503/504). SKIPPED means the issue is not RFQA. Acceptance criteria are marked PASS only from host verification, never merely because a scenario listed the criterion ID. These statuses are not interchangeable. Infrastructure/setup errors return a non-zero exit code; observed FAIL/BLOCKED also returns non-zero.

At a finish decision, host checks determine the result before model evidence claims are interpreted. An exact Gemini quote is not required for PASS: a paraphrase is retained as an advisory assessment and flagged when it does not match a literal post-action excerpt. Unsupported claims, omitted assessments, and disagreements with host checks are visible in the JSON/Markdown audit. They cannot replace actual list-item state, successful tool execution, origin-validated observations, and retained artifacts. Missing observations/check coverage remain BLOCKED; independent observable contradictions remain FAIL. A recovery snapshot cannot substitute for a successful post-action observation, and a later recovery cannot leave an older successful state eligible for PASS.

List-item verification follows accessibility-tree indentation through nested generic wrappers. It checks every occurrence of the subject and requires semantic listitem ancestry; the same text in a heading, textbox, or unrelated branch cannot establish task presence. Checkbox state is associated with the matching item's subtree, so another task's checked checkbox cannot establish completion.

For generated filter checks, the host defers premature finish proposals and supplies specific missing-observation feedback. The executor must observe the current scenario's distinct included items unchecked and excluded items checked together in an unfiltered post-action snapshot immediately before the final Active filter result. Checkbox state belongs to the matching listitem subtree. Initial tasks, recovery observations, and tasks from older runs cannot supply setup proof; an item must have been absent in an earlier unfiltered observation. The model chooses any required recovery actions from current UI controls, within the existing action, request, and time budgets. Deferred proposals and their host checks are retained as `finish_deferred` action-log events. Planner contract version 3 invalidates earlier cached plans.

Every Playwright MCP instance uses `--isolated`, so each scenario and revalidation starts with an ephemeral browser profile instead of reusing local storage from earlier runs. Scenario isolation does not clear shared server-side application data.

Deletion checks require the same exact current-scenario marker before and after removal. The host records a newly visible semantic listitem, activation of an observed removal control belonging to that item, and a later unfiltered observation in the same view. A successful click alone cannot establish removal; a task that remains after its removal attempt produces FAIL. Missing setup, an unrelated deletion, filtered content, or navigation cannot establish PASS. `removal_attempt` and `verification_readiness` action-log events retain the progression and snapshot references; final origin and artifact validation still applies at finish.

Before each deletion-scenario decision, Gemini receives host feedback identifying missing evidence or readiness to finish with the independently observed PASS/FAIL. The host automatically captures a fresh snapshot after each browser action. Duplicate-action loop protection remains enforced: a repeated read-only `browser_snapshot` may receive one corrective model request without executing the redundant call, bounded by the shared recovery allowance, request count, and deadline. A further identical proposal remains BLOCKED; state-changing duplicate actions keep their immediate loop stop.

Without `GEMINI_API_KEY`, `npm run qa:mock` records a BLOCKED outcome, not a fake generated plan. Unit tests can run without credentials. If a run stops before generation, the report/log still preserve the blocker.

## Architecture

`src/issues/` validates mock or GitHub issue content; `src/browser/explorer.ts` builds the Phase 2 Application Context; `src/agents/planner.ts` generates and checks complete AC coverage; `src/browser/` starts the MCP server, discovers schemas and restricts available tools; `src/agents/executor.ts` runs a bounded observe/act/verify loop; `src/agents/revalidator.ts` optionally re-runs host-verified FAIL once; `src/evidence/` maintains the phase ledger, action log, and deterministic JSON/Markdown reports. Each scenario receives a fresh MCP/browser process for state isolation. The project uses the installed MCP TypeScript SDK v1 (`Client` + `StdioClientTransport`) consistently and the `@google/genai` SDK.

The six execution phases remain:

| Phase | Responsibility |
|---|---|
| 1. Requirement Discovery | Normalize the issue, confirm RFQA readiness, and extract acceptance criteria. |
| 2. Application Exploration | Capture authentic page context, semantic controls, and screenshot evidence through MCP. |
| 3. Scenario Generation | Generate independent acceptance-criterion scenarios and validate the plan/cache contract. |
| 4. Autonomous Execution | Let Gemini choose bounded actions while the host validates tools, observations, readiness, and final assertions. |
| 5. Conditional Failure Revalidation | Re-run a host-verified functional FAIL once in a fresh browser; otherwise record NOT_RUN. |
| 6. Final Reporting | Produce deterministic reports with traceability, host checks, model assessment audits, and artifact links. |

Planning requires one acceptance criterion per scenario, with all prerequisite state established in that scenario's own steps. Each scenario stops at its criterion's appropriate final state; later lifecycle actions must not invalidate that state. Steps and controls remain dynamically planned from the issue and observed application context. The plan cache includes a fingerprint of the planning contract version, actual planner prompt, API response schema, and host schema. Legacy caches or changes to those inputs force regeneration; changes to host planning rules also require incrementing the contract version.

The executor sends one plain JSON object schema with explicit `kind` and `rationale` fields, a dynamically discovered tool enum, a shared arguments object, and finish assessments. The API-facing schema avoids root and nested schema unions. Zod still checks the action/finish conditional fields, and the host binds arguments to the exact discovered tool schema and enforces the allowlist, origin checks, current accessibility references, and evidence validation.

An invalid JSON response, invalid decision, rejected tool arguments, or absent current reference can use at most one controlled model-decision recovery per scenario, further limited by `MAX_RECOVERY_RETRIES`, model request limits, and the remaining deadline. The correction receives sanitized validation feedback; no rejected action is executed. An API service error is surfaced without this format-repair request. A corrected finish still requires real post-action evidence and independent host verification. Phase 4 is `BLOCKED` when infrastructure or verification blockers prevent execution from completing; a fully executed functional FAIL can still have a `COMPLETED` phase status.

## Recorded validation

The latest recorded offline code validation on 2026-10-19 passed `npm run check`, `npm test` (**338 tests across 23 files**), and `npm run build`. Regression coverage includes invalid model decisions, nested TodoMVC listitems, advisory/paraphrased evidence, premature finish recovery, missing completed-task evidence, stale tasks, checkbox ownership, setup mutations, browser isolation, exact-target deletion proof, bounded duplicate-snapshot correction, navigation/SDK timeouts, infrastructure-source classification, and request/action/deadline bounds.

The full live run `2026-10-19T16-48-44-857Z-53800997` used `gemini-3.5-flash-lite` with the local mock issue and real Gemini/Playwright execution. All four scenarios passed independent host checks: **PASS 4; FAIL 0; BLOCKED 0; SKIPPED 0**.

| Scenario | Criterion | Result | Executor requests | Model-selected browser actions | Recoveries |
|---|---|---|---:|---:|---:|
| SC-01: Create a new task | AC-01 | PASS | 2 | 1 | 0 |
| SC-02: Mark a task complete | AC-02 | PASS | 3 | 2 | 0 |
| SC-03: Filter active tasks | AC-03 | PASS | 5 | 4 | 0 |
| SC-04: Delete a task | AC-04 | PASS | 4 | 3 | 0 |

The run completed in approximately 140 seconds with 14 executor requests, 10 model-selected browser actions, and no recoveries. Phase 4 completed; Phase 5 was NOT_RUN because there was no functional FAIL. Model evidence claims were flagged UNSUPPORTED when they did not reproduce literal snapshot excerpts; authentic host observations independently established each PASS.

The locally generated report is `evidence/runs/2026-10-19T16-48-44-857Z-53800997/report.md`; its screenshots and accessibility snapshots are under `evidence/screenshots/2026-10-19T16-48-44-857Z-53800997/`. Generated run artifacts are separate from the source changes. This validates the mock issue's complete Todo lifecycle; GitHub issue ingestion and RFQA-triggered execution use the workflow described above.

To run the complete plan locally:

```powershell
$env:GEMINI_MODEL = "gemini-3.5-flash-lite"
$env:HEADLESS = "true"
npm run qa:mock
```

To repeat only the filtering scenario, use `npm run qa:mock -- --scenario=SC-03` with the same configuration and an API key in local `.env`.

## Troubleshooting

- **Missing/invalid Gemini key or model:** check `.env`, Gemini API project access and quota; use a model name available to that API account. The report identifies the run as BLOCKED.
- **Playwright MCP/Chromium launch failure:** rerun `npm run qa:mock` with network access; allow `npx` to fetch `@playwright/mcp`; install the required Playwright browser for the package/runtime if its diagnostic requests it. Try `HEADLESS=true` on machines without a display.
- **Windows `npx` startup:** the program uses `npx.cmd` on Windows. If execution policy restrictions prevent PowerShell startup, use a normal PowerShell prompt with Node/npm on PATH.
- **GitHub 404/401/403:** confirm `OWNER/REPOSITORY`, issue number and access. Add `GITHUB_TOKEN` in `.env` for private repos or rate limits.
- **No acceptance criteria found:** include an `## Acceptance Criteria` heading and list lines such as `- AC-01: The item can be created.` Empty/malformed issue bodies are rejected.
- **BLOCKED browser scenario:** inspect the actual tool/snapshot entries in `evidence/action-log.ndjson`; no CSS/XPath fallback is used when a semantic reference is missing.
- **Early finish on a multi-step filter scenario:** inspect `finish_deferred` events for the missing item/state observations. The model can continue setup or restore an unfiltered view, subject to the existing budgets; an exhausted budget remains BLOCKED.
- **UNSUPPORTED model evidence with host PASS:** inspect the linked host snapshots and checks. The warning audits the model's literal evidence claim; host verification independently determines the scenario result.

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
