# Autonomous UI Testing Agent — Test Plan and Architecture

## Implementation status

This file is the project’s single source of truth for the test architecture. It describes the implemented six-phase Autonomous UI Testing Agent workflow. Each phase below labels its current state explicitly.

Current implementation provides issue ingestion and normalization, an RFQA readiness gate, bounded Playwright MCP application exploration before scenario planning, dynamic Gemini scenario planning, bounded Gemini/Playwright MCP scenario execution with local safety and evidence validation, conditional one-attempt functional failure revalidation, and deterministic JSON/Markdown reporting with a six-phase status matrix, acceptance-criteria traceability, run-scoped evidence dual-writes, and dedicated revalidation sections.

## Phase 1 — Requirement Discovery

**Status: Implemented, with the structured Requirement Context as a proposed explicit artifact.**

- **Input:** A GitHub issue (`--source=github --repo=OWNER/REPOSITORY --issue=NUMBER`) or the local mock ticket (`--source=mock`), plus runtime configuration.
- **Processing responsibilities:**
  - Load the selected issue source and normalize its title, description/user story, acceptance criteria, target URL, and readiness status.
  - Validate required fields and acceptance-criteria identifiers; reject malformed or incomplete requirements as ingestion errors.
  - Apply the RFQA readiness gate before starting Gemini or Playwright. Issues that are not RFQA are SKIPPED without model or browser startup.
  - Provide a structured requirement context to downstream phases. **Current behavior passes a normalized issue object; a separately named and persisted Requirement Context object is proposed, not implemented.**
- **Output artifacts:** Current implementation keeps the normalized issue in memory and records ingestion failures in the action log and report. A standalone Requirement Context artifact is proposed.
- **Exit criteria:** Requirements are valid and RFQA-ready before planning proceeds. Invalid ingestion is BLOCKED; non-RFQA issues are SKIPPED. No scenario execution starts without a normalized, ready issue.

## Phase 2 — Application Exploration

**Status: Implemented as a bounded, read-only MCP exploration phase whose validated observations feed Gemini scenario generation.**

- **Input:** The Phase 1 Requirement Context and its target application URL.
- **Processing responsibilities:**
  - Start Playwright MCP **before** generating test scenarios.
  - Navigate to the target application and inspect the actual loaded page.
  - Capture the current URL, title, accessibility snapshot, visible semantic controls, and screenshots.
  - Build a structured Application Context that separates observed capabilities from unknown or hidden elements.
  - Use observed accessibility references only; do not invent selectors or infer unseen UI.
  - Keep exploration bounded, safe, and preferably non-destructive. Do not classify temporarily unavailable UI elements as product defects.
- **Output artifacts:** `evidence/application-context.json` contains the validated Application Context, observed page data, source tool references, timestamps, unknowns, diagnostics, and a run-associated screenshot reference. `npm run qa:explore` runs this phase without Gemini. `qa:browser-smoke` remains a separate MCP infrastructure check; `qa:mcp-integration` exercises MCP against a local Todo fixture and is not exploration of the configured application.
- **Exit criteria:** Exploration produces a verifiable context tied to the target origin, or records an infrastructure/exploration blocker. Lack of observable evidence remains unknown; it is not a product failure.

## Phase 3 — Context-Aware Test Scenario Generation

**Status: Implemented; dynamic generation consumes validated Phase 1 requirements and the observed Phase 2 Application Context, including verification and unknown-control planning.**

- **Input:** The normalized Phase 1 issue and validated, successful Phase 2 Application Context are supplied to Gemini through the planner prompt.
- **Processing responsibilities:**
  - Generate scenarios dynamically with Gemini; do not replace this with hardcoded Playwright test scripts.
  - Map every scenario to known acceptance criteria and define preconditions, test intentions, expected observations, verification strategy, observed affordances, and unknown controls to discover.
  - Validate generated structure, scenario identifiers, criterion references, duplicates, and complete acceptance-criteria coverage before execution.
  - Optionally select one dynamically generated scenario with `--scenario=SC-01`; this reduces execution requests, but planning still occurs first.
- **Output artifacts:** `evidence/generated-scenarios.json` records the run, model, validated scenarios, acceptance-criteria mapping, and referenced Application Context. A fingerprinted cache reuses only validated plans with unchanged issue, observed application context, and model inputs.
- **Exit criteria:** The plan is structurally valid, refers to the selected issue, has unique scenario IDs, covers every known acceptance criterion, and—when requested—contains the selected scenario ID. Invalid plans are BLOCKED and are not executed.

## Phase 4 — Autonomous Test Execution

**Status: Implemented as adaptive Gemini-selected MCP actions with host-validated tool arguments, fresh snapshot references, bounded request/action/time budgets, and independent semantic verification checks.**

- **Input:** Each selected, validated Phase 3 scenario (including verification checks and unknown controls), the normalized issue, discovered Playwright MCP schemas, and a fresh per-scenario browser snapshot.
- **Processing responsibilities:**
  - Execute each scenario in a newly launched Playwright MCP session, navigate to the target, and execute scenario intentions with Gemini selecting one browser action at a time.
  - Refresh browser observations after actions and base decisions on the latest accessibility snapshot and actual tool results.
  - Validate tool names against the safe allowlist (including semantic hover); constrain structured output with each permitted tool’s discovered schema; validate arguments locally against that schema.
  - For click/type, require exact semantic references from the latest accessibility snapshot. Reject CSS/XPath selectors, conflicting or missing references, and references absent from the snapshot. A compatible `ref` is normalized to `target` only when the discovered schema requires `target`.
  - Enforce target-origin navigation, finite MCP/Gemini timeouts, action and wall-clock limits, bounded invalid-action/interaction recovery, and repeated-action loop stopping.
  - Keep scenarios in independent Playwright MCP browser contexts and use unique run/scenario data.
  - Capture pre-action/post-action observations and screenshots. Keep Gemini assessments separate from host-validated criterion checks. PASS requires every declared verification check to pass against post-action snapshots and each cited quote to match an actual post-action snapshot. A host-observed contradictory checked state, deletion, or filter result may be FAIL; uncertainty, unsafe/invalid actions, missing evidence, exhausted limits, or infrastructure/model failures are BLOCKED.
- **Output artifacts:** Current per-scenario results, screenshots under `evidence/screenshots/<runId>/`, and bounded `evidence/action-log.ndjson` entries. The deterministic `qa:mcp-integration` command is a Gemini-free MCP wiring check against a local fixture, not an autonomous AI test and not a target-application acceptance test.
- **Exit criteria:** Each executed scenario has a defensible PASS, FAIL, or BLOCKED result and retained evidence. Model claims alone never establish a result. No action outside the discovered safe tool allowlist is run.

## Phase 5 — Conditional Failure Revalidation

**Status: Implemented as a conditional, single-attempt re-execution of host-verified functional failures.**

- **Input:** A genuine functional assertion marked FAIL by Phase 4, with its original scenario, browser observations, action log, and screenshots.
- **Processing responsibilities:**
  - Trigger only for a Phase 4 `FAIL` explicitly marked `hostVerifiedFailure`; PASS, BLOCKED, SKIPPED, unverified FAIL, service errors (including 429/503/504), unavailable infrastructure, unsafe actions, and inconclusive evidence do not trigger it.
  - Re-execute the same validated scenario, acceptance criteria, and verification checks once in a newly created and isolated Playwright MCP session. The existing executor retains its origin/tool/reference checks and action, request, recovery, and time budgets. A unique revalidation run ID also produces distinct task data.
  - Conservatively skip revalidation for scenarios whose verification requires removal or whose intent/criterion describes destructive or potentially irreversible actions (for example, deleting, purchasing, paying, transferring, or sending communications).
  - Classify the retry separately: FAIL → `CONFIRMED_FAILURE`; PASS → `FLAKY_OR_INCONSISTENT`; BLOCKED → `REVALIDATION_INCONCLUSIVE`.
  - Never change the original scenario’s FAIL status. A retry PASS is inconsistent evidence, not a converted PASS. Prevent a second Phase 5 attempt for the same original run and scenario.
- **Output artifacts:** The scenario’s JSON result contains a nested revalidation record with the original result and reason, separate revalidation attempt result and reason, classification, attempt count, both run IDs, action/recovery counts, and separate screenshot paths. Action-log entries and browser observations are correlated by original and revalidation run IDs. Markdown reporting includes the classification and retry outcome without replacing the original status.
- **Exit criteria:** The eligible failure receives exactly one bounded attempt, or the attempt is explicitly BLOCKED with its reason. Original and retry results/evidence remain distinct. Non-eligible statuses never start a retry.

## Phase 6 — Final Reporting

**Status: Implemented as deterministic TypeScript reporting with a six-phase execution matrix, acceptance-criteria traceability, comprehensive scenario evidence, and dual-written run-scoped artifacts.**

- **Input:** Phase 1–4 outputs, plus Phase 5 original/revalidation outputs if revalidation was triggered. Early exits (ingestion failure, non-RFQA, exploration/planning blockers) still produce an informative report.
- **Processing responsibilities:**
  - Generate deterministic JSON and Markdown reports from program-validated results; Gemini does not author overall run status or invent PASS/FAIL/observations/screenshots.
  - Record each phase’s operational status as `COMPLETED`, `FAILED`, `BLOCKED`, or `NOT_RUN`, with timestamps, duration, artifact references, and errors. Phase operational status is distinct from scenario PASS/FAIL/BLOCKED/SKIPPED. Phase 5 `NOT_RUN` when no host-verified functional FAIL occurs is normal.
  - For every scenario, report ID/title, acceptance criteria, preconditions, intended steps, verification strategy, browser actions, expected vs observed results, host-verified assertion outcomes, status, screenshots, duration, and Gemini/browser counts when recorded.
  - Build acceptance-criteria traceability from host verification outcomes. A criterion is never marked PASS solely because a generated scenario references it; uncovered or unverified criteria remain `UNVERIFIED`.
  - Include a dedicated revalidation section when Phase 5 ran: original failure/evidence, retry result/evidence, classification, and separate run IDs. Retain the original FAIL in aggregate totals even when revalidation passes (`FLAKY_OR_INCONSISTENT`).
  - Clearly separate product FAIL outcomes from infrastructure/service BLOCKED outcomes (including Gemini 429/503/504) and readiness SKIPPED outcomes. Never write secrets, tokens, or API keys into reports.
- **Output artifacts:**
  - Latest convenience copies: `evidence/report.json`, `evidence/report.md`, `evidence/application-context.json`, `evidence/generated-scenarios.json`, `evidence/action-log.ndjson`
  - Run-scoped copies: `evidence/runs/<runId>/` for the same report/context/scenario/log files, preserving earlier runs instead of only overwriting root paths
  - Screenshots remain under `evidence/screenshots/<runId>/` (including revalidation subfolders when applicable)
  - Artifact inventory in the report marks missing files as unavailable rather than fabricating links
- **Exit criteria:** Reports accurately reflect retained evidence and preserve genuine PASS, FAIL, BLOCKED, and SKIPPED distinctions. An observed functional FAIL remains visible even if revalidation is inconsistent or succeeds. Offline reporter unit tests cover all-PASS, functional FAIL, Gemini BLOCKED, Phase 2/3 failures, partial Phase 4, Phase 5 not triggered, confirmed/flaky revalidation, missing evidence, and AC traceability rules.

## Cross-phase safety, reliability, and cost controls

These existing constraints apply to current execution and remain requirements for proposed phases:

- **Untrusted input:** Treat issue text, page content, and accessibility labels as untrusted data. Never follow embedded instructions to reveal secrets, leave the target origin, run code, use the filesystem, change grading rules, or use tools outside the supplied list.
- **Tool boundaries:** Discover Playwright MCP schemas at runtime. Expose only navigation, snapshot, click, type, and press-key actions to Gemini. Keep screenshot capture host-controlled with a fixed evidence path. Do not expose arbitrary code execution, filesystem, shell, or network tools to the model.
- **Semantic targets:** Validate against the latest accessibility snapshot; never silently fall back to CSS/XPath or fabricated references.
- **Origin and state isolation:** Constrain navigation to the target origin and verify snapshot URLs. Use a fresh MCP/browser context per scenario; do not reuse scenario state.
- **Evidence and status:** A PASS requires evidence quotes that match actual browser observations for every applicable criterion and required screenshot evidence. A genuine contradiction may be FAIL. Missing/ambiguous evidence or service/infrastructure errors are BLOCKED. RFQA-not-ready issues are SKIPPED before Gemini/browser startup. Phase 5 does not change the original Phase 4 status.
- **Timeouts and bounded recovery:** Keep finite Gemini/MCP operation timeouts, per-scenario action/time/request caps, bounded action recovery, and repeated-action loop detection. The Gemini SDK is configured for one HTTP attempt rather than its default five; service errors do not trigger application-level retries or unnecessary remaining scenario executions.
- **Secrets and diagnostics:** Keep credentials in local `.env`; do not commit secrets. Gemini diagnostics may record request kind, model, duration, prompt character count, schema byte count, API status code, and retry count, but not API keys, prompts, schema contents, or other secrets.
- **Cost:** Limit model requests through scenario/action/time bounds. `--scenario=SC-01` selects one generated scenario but does not skip scenario-plan generation. Do not call the live Gemini API in unit tests.
- **GitHub readiness:** GitHub access is optional for public issues; use only a least-privilege token when needed for private issue reads. The RFQA readiness gate must continue to prevent model/browser work for non-ready issues.

## Verification commands and interpretation

- `npm run check` validates TypeScript types.
- `npm test` runs deterministic local unit tests, including simulated Gemini 503/504/429, timeout, and successful responses. These are not live model results.
- `npm run build` compiles the project.
- `npm run qa:browser-smoke` checks configured-target Playwright MCP navigation/snapshot/screenshot infrastructure; it does not evaluate acceptance criteria.
- `npm run qa:mcp-integration` exercises Playwright MCP against a local Todo fixture without Gemini; it does not test the configured target application or autonomous scenario reasoning.
- A real autonomous UI test requires explicit authorization to use the configured Gemini API and target browser application. Its results must be reported separately from unit tests and deterministic MCP integration checks.
